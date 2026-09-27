//! Auto-update (#74, ADR 0011): the installed Desktop App asks the latest
//! GitHub Release's `latest.json` whether there is a newer version, and
//! installs its package once the musician says so.
//!
//! Tauri's updater does the work, and installs nothing that isn't signed by
//! the updater's key for the version announced. Its public half is
//! `plugins.updater.pubkey` in `tauri.conf.json`, empty until the
//! maintainer makes the key; until then, and in any build the updater
//! couldn't replace, the app says why it doesn't update itself rather than
//! failing to.
//!
//! The UI calls these commands, not the plugin's own: the window's
//! capability doesn't grant those, so the page can't point the updater
//! anywhere else.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::Value;
use tauri::utils::config::BundleType;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::lock;

/// Why the app doesn't update itself, when it doesn't.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Off {
    /// The updater has no public key yet: the maintainer hasn't made its key.
    NoKey,
    /// A development build (`pnpm desktop:dev`), which an update would
    /// replace with a release.
    Development,
    /// Not installed from one of the packages a Release offers, such as a
    /// binary built from source, which the updater couldn't replace.
    NotInstalled,
}

/// Whether a build with `pubkey`, built in debug or not, and installed from
/// `bundle`, can update itself; if not, why.
pub fn availability(pubkey: &str, debug: bool, bundle: Option<BundleType>) -> Result<(), Off> {
    if pubkey.trim().is_empty() {
        return Err(Off::NoKey);
    }
    if debug {
        return Err(Off::Development);
    }
    match bundle {
        Some(BundleType::Nsis | BundleType::App | BundleType::AppImage | BundleType::Deb) => Ok(()),
        _ => Err(Off::NotInstalled),
    }
}

/// The public key in the updater's config, or "" when there is none.
pub fn pubkey(plugins: &tauri::utils::config::PluginConfig) -> &str {
    plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn this_build(app: &AppHandle) -> Result<(), Off> {
    availability(
        pubkey(&app.config().plugins),
        cfg!(debug_assertions),
        tauri::utils::platform::bundle_type(),
    )
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The version running.
    pub version: String,
    /// Why it doesn't update itself, or None when it does.
    pub off: Option<Off>,
}

/// A newer version, as a Release announces it.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub version: String,
    /// When it was released, as RFC 3339, if the Release says.
    pub date: Option<String>,
    /// What's new in it, if the Release says.
    pub notes: Option<String>,
}

impl Found {
    /// From what the updater read: the version, the notes, and the whole of
    /// `latest.json`, whose date is kept as it was written.
    pub fn new(version: &str, notes: Option<&str>, manifest: &Value) -> Self {
        let text = |value: Option<&str>| {
            value
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(String::from)
        };
        Found {
            version: version.to_owned(),
            date: text(manifest.get("pub_date").and_then(Value::as_str)),
            notes: text(notes),
        }
    }
}

/// How much of the package has downloaded, which the UI polls.
#[derive(Debug, Default)]
pub struct Progress {
    downloaded: AtomicU64,
    /// The package's size, 0 until known.
    total: AtomicU64,
}

impl Progress {
    pub fn reset(&self) {
        self.downloaded.store(0, Ordering::Relaxed);
        self.total.store(0, Ordering::Relaxed);
    }

    /// Another `len` bytes have arrived, of `total` if the server said.
    pub fn chunk(&self, len: usize, total: Option<u64>) {
        self.downloaded.fetch_add(len as u64, Ordering::Relaxed);
        if let Some(total) = total {
            self.total.store(total, Ordering::Relaxed);
        }
    }

    /// 0 to 1; 0 while the size isn't known.
    pub fn fraction(&self) -> f32 {
        let total = self.total.load(Ordering::Relaxed);
        if total == 0 {
            return 0.0;
        }
        (self.downloaded.load(Ordering::Relaxed) as f64 / total as f64).min(1.0) as f32
    }
}

/// What the update commands share.
#[derive(Default)]
pub struct Updates {
    /// What the last check found, until it is installed.
    found: Mutex<Option<Update>>,
    progress: Progress,
}

fn describe(off: Off) -> String {
    match off {
        Off::NoKey => "This build has no updater key, so it can't update itself.",
        Off::Development => "A development build doesn't update itself.",
        Off::NotInstalled => {
            "This copy wasn't installed from a Release, so it can't update itself."
        }
    }
    .into()
}

/// The version running, and whether it updates itself.
#[tauri::command]
pub fn update_status(app: AppHandle) -> Status {
    Status {
        version: app.package_info().version.to_string(),
        off: this_build(&app).err(),
    }
}

/// Asks the latest Release whether there is a newer version; None if not.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    updates: State<'_, Updates>,
) -> Result<Option<Found>, String> {
    this_build(&app).map_err(describe)?;
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| format!("Couldn't check for an update: {error}"))?;
    let found = update
        .as_ref()
        .map(|update| Found::new(&update.version, update.body.as_deref(), &update.raw_json));
    *lock(&updates.found) = update;
    Ok(found)
}

/// Downloads the update the last check found, checks its signature,
/// installs it and restarts into it. On Windows the installer closes the
/// app and starts it again itself.
#[tauri::command]
pub async fn update_install(app: AppHandle, updates: State<'_, Updates>) -> Result<(), String> {
    let Some(update) = lock(&updates.found).take() else {
        return Err("There is no update to install: check for one first.".into());
    };
    updates.progress.reset();
    let installed = update
        .download_and_install(|len, total| updates.progress.chunk(len, total), || {})
        .await;
    if let Err(error) = installed {
        *lock(&updates.found) = Some(update);
        return Err(format!("Couldn't install the update: {error}"));
    }
    app.restart()
}

/// How far the update's download has got, 0 to 1.
#[tauri::command]
pub fn update_progress(updates: State<'_, Updates>) -> f32 {
    updates.progress.fraction()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const PUBKEY: &str =
        "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEYxQTQ1Mjc0RkE4RkEwMjcK";

    #[test]
    fn an_installed_release_with_the_key_updates_itself() {
        for bundle in [
            BundleType::Nsis,
            BundleType::App,
            BundleType::AppImage,
            BundleType::Deb,
        ] {
            assert_eq!(
                availability(PUBKEY, false, Some(bundle.clone())),
                Ok(()),
                "{bundle:?}"
            );
        }
    }

    #[test]
    fn without_the_key_nothing_updates_itself() {
        assert_eq!(
            availability("", false, Some(BundleType::Nsis)),
            Err(Off::NoKey)
        );
        assert_eq!(
            availability(" \n", false, Some(BundleType::Nsis)),
            Err(Off::NoKey)
        );
    }

    #[test]
    fn a_development_build_doesnt_update_itself() {
        assert_eq!(
            availability(PUBKEY, true, Some(BundleType::Nsis)),
            Err(Off::Development)
        );
    }

    #[test]
    fn a_copy_not_installed_from_a_release_package_doesnt_either() {
        assert_eq!(availability(PUBKEY, false, None), Err(Off::NotInstalled));
        assert_eq!(
            availability(PUBKEY, false, Some(BundleType::Rpm)),
            Err(Off::NotInstalled)
        );
        assert_eq!(
            availability(PUBKEY, false, Some(BundleType::Msi)),
            Err(Off::NotInstalled)
        );
    }

    #[test]
    fn the_public_key_is_read_from_the_updaters_config() {
        let config = |value: Value| {
            tauri::utils::config::PluginConfig([("updater".to_owned(), value)].into())
        };
        assert_eq!(pubkey(&config(json!({ "pubkey": PUBKEY }))), PUBKEY);
        assert_eq!(pubkey(&config(json!({}))), "");
        assert_eq!(pubkey(&Default::default()), "");
    }

    #[test]
    fn the_committed_config_is_the_updaters() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert!(
            updater["pubkey"].is_string(),
            "the plugin won't start without a pubkey, even an empty one"
        );
        assert_eq!(
            updater["endpoints"],
            json!([
                "https://github.com/adrianeyre/soundcheck/releases/latest/download/latest.json"
            ])
        );
        assert_eq!(updater["requireSignedVersion"], json!(true));
    }

    #[test]
    fn what_a_release_announces_is_passed_on() {
        let manifest = json!({ "version": "1.2.3", "pub_date": "2026-09-26T12:00:00Z" });
        assert_eq!(
            Found::new("1.2.3", Some("What's new\n"), &manifest),
            Found {
                version: "1.2.3".into(),
                date: Some("2026-09-26T12:00:00Z".into()),
                notes: Some("What's new".into()),
            }
        );
        assert_eq!(
            Found::new("1.2.3", Some(""), &json!({})),
            Found {
                version: "1.2.3".into(),
                date: None,
                notes: None
            }
        );
    }

    #[test]
    fn progress_is_the_share_downloaded_once_the_size_is_known() {
        let progress = Progress::default();
        assert_eq!(progress.fraction(), 0.0);
        progress.chunk(100, None);
        assert_eq!(progress.fraction(), 0.0);
        progress.chunk(150, Some(1000));
        assert_eq!(progress.fraction(), 0.25);
        progress.chunk(2000, Some(1000));
        assert_eq!(progress.fraction(), 1.0);
        progress.reset();
        assert_eq!(progress.fraction(), 0.0);
    }

    #[test]
    fn why_it_doesnt_update_is_told_to_the_ui_by_name() {
        assert_eq!(
            serde_json::to_value(Off::NotInstalled).unwrap(),
            json!("not-installed")
        );
        let status = Status {
            version: "0.1.0".into(),
            off: Some(Off::NoKey),
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({ "version": "0.1.0", "off": "no-key" })
        );
    }
}

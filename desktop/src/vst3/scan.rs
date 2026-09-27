//! Finding the VST3 Plugins installed on the machine (ADR 0008).
//!
//! A scan never runs a Plugin's code in the app. A bundle with a moduleinfo
//! (SDK 3.7 and later) is read as a file; one without is loaded by a helper
//! process of its own, so a Plugin that crashes or hangs as it loads (copy
//! protection often runs then) only costs that process, and the scan carries
//! on with the next bundle. What a helper found is cached by the bundle's
//! path, size and time, so the next scan doesn't load it again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::moduleinfo::{self, AUDIO_MODULE_CLASS, Class};
use super::process::scan_in_helper;

/// Where a bundle's classes came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// Its moduleinfo, without running any of its code.
    ModuleInfo,
    /// Loading it in a helper process.
    Helper,
    /// The cache of an earlier helper's scan of the same bundle.
    Cache,
}

/// One bundle's result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scanned {
    pub bundle: PathBuf,
    /// Its Instruments and Effects.
    pub classes: Vec<Class>,
    /// Why it couldn't be scanned, if it couldn't.
    pub error: Option<String>,
    pub source: Source,
}

/// The folders VST3 Plugins are installed into, as Steinberg specifies them
/// for each platform.
pub fn default_folders() -> Vec<PathBuf> {
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let mut folders = Vec::new();
    if cfg!(target_os = "windows") {
        if let Some(common) = env("COMMONPROGRAMFILES") {
            folders.push(common.join("VST3"));
        }
        if let Some(local) = env("LOCALAPPDATA") {
            folders.push(local.join("Programs").join("Common").join("VST3"));
        }
    } else if cfg!(target_os = "macos") {
        if let Some(home) = env("HOME") {
            folders.push(home.join("Library/Audio/Plug-Ins/VST3"));
        }
        folders.push("/Library/Audio/Plug-Ins/VST3".into());
    } else {
        if let Some(home) = env("HOME") {
            folders.push(home.join(".vst3"));
        }
        folders.push("/usr/lib/vst3".into());
        folders.push("/usr/local/lib/vst3".into());
    }
    folders
}

/// Every `.vst3` bundle in `folders` and the folders under them, in a stable
/// order. A bundle's own contents aren't searched.
pub fn bundles_in(folders: &[PathBuf]) -> Vec<PathBuf> {
    fn walk(folder: &Path, found: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(folder) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_bundle = path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("vst3"));
            if is_bundle {
                found.push(path);
            } else if path.is_dir() {
                walk(&path, found);
            }
        }
    }
    let mut found = Vec::new();
    for folder in folders {
        walk(folder, &mut found);
    }
    found.sort();
    found.dedup();
    found
}

/// A bundle's size and newest modification, across every file in it: what
/// changes when it is updated or reinstalled.
fn fingerprint(bundle: &Path) -> Option<(u64, u64)> {
    fn walk(path: &Path, size: &mut u64, newest: &mut u64) -> Option<()> {
        let meta = std::fs::metadata(path).ok()?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        *newest = (*newest).max(modified);
        if meta.is_dir() {
            for entry in std::fs::read_dir(path).ok()?.flatten() {
                walk(&entry.path(), size, newest)?;
            }
        } else {
            *size += meta.len();
        }
        Some(())
    }
    let (mut size, mut newest) = (0, 0);
    walk(bundle, &mut size, &mut newest)?;
    Some((size, newest))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Cached {
    size: u64,
    modified: u64,
    classes: Vec<Class>,
    error: Option<String>,
}

/// What helpers found in bundles without a moduleinfo, by bundle path, kept
/// as JSON beside the app's other data.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Cache {
    bundles: HashMap<PathBuf, Cached>,
}

impl Cache {
    /// The cache in `file`, or an empty one if there is none or it can't be
    /// read.
    pub fn read(file: &Path) -> Self {
        std::fs::read_to_string(file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn write(&self, file: &Path) -> std::io::Result<()> {
        if let Some(folder) = file.parent() {
            std::fs::create_dir_all(folder)?;
        }
        let text = serde_json::to_string(self).map_err(std::io::Error::other)?;
        std::fs::write(file, text)
    }
}

/// Scans each of `bundles`, giving each helper `timeout` to answer, and
/// using what `cache` has for a bundle that hasn't changed since.
pub fn scan(
    bundles: &[PathBuf],
    helper: &Path,
    timeout: Duration,
    cache: &mut Cache,
) -> Vec<Scanned> {
    let scanned = bundles
        .iter()
        .map(|bundle| {
            let (classes, source) = match moduleinfo::read(bundle) {
                Some(classes) => (Ok(classes), Source::ModuleInfo),
                None => {
                    let print = fingerprint(bundle).unwrap_or_default();
                    match cache.bundles.get(bundle) {
                        Some(cached) if (cached.size, cached.modified) == print => (
                            cached.error.clone().map_or(Ok(cached.classes.clone()), Err),
                            Source::Cache,
                        ),
                        _ => {
                            let classes = scan_in_helper(helper, bundle, timeout);
                            cache.bundles.insert(
                                bundle.clone(),
                                Cached {
                                    size: print.0,
                                    modified: print.1,
                                    classes: classes.clone().unwrap_or_default(),
                                    error: classes.clone().err(),
                                },
                            );
                            (classes, Source::Helper)
                        }
                    }
                }
            };
            let (classes, error) = match classes {
                Ok(all) => (
                    all.into_iter()
                        .filter(|class| class.category == AUDIO_MODULE_CLASS)
                        .collect(),
                    None,
                ),
                Err(why) => (Vec::new(), Some(why)),
            };
            Scanned {
                bundle: bundle.clone(),
                classes,
                error,
                source,
            }
        })
        .collect();
    // Bundles no longer there are forgotten.
    cache.bundles.retain(|bundle, _| bundles.contains(bundle));
    scanned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_bundles_in_subfolders_but_not_inside_bundles() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        for dir in [
            "Vendor/Reverb.vst3/Contents/x86_64-linux",
            "Delay.VST3/Contents/Resources",
            "Delay.VST3/Contents/Nested.vst3",
            "Not a plugin",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let found = bundles_in(&[root.to_path_buf(), root.join("missing")]);
        assert_eq!(
            found,
            [root.join("Delay.VST3"), root.join("Vendor/Reverb.vst3")]
        );
    }

    #[test]
    fn the_default_folders_are_the_platforms() {
        let folders = default_folders();
        if cfg!(target_os = "linux") {
            assert!(folders.contains(&PathBuf::from("/usr/lib/vst3")));
            assert!(folders.iter().any(|f| f.ends_with(".vst3")));
        }
    }

    #[test]
    fn a_bundle_with_a_moduleinfo_is_read_without_a_helper() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("Tilt.vst3");
        std::fs::create_dir_all(bundle.join("Contents/Resources")).unwrap();
        std::fs::write(
            bundle.join("Contents/Resources/moduleinfo.json"),
            r#"{ "Classes": [
                { "CID": "0123456789abcdef0123456789abcdef", "Category": "Audio Module Class",
                  "Name": "Tilt", "Vendor": "Tilters", "Version": "1.0", "Sub Categories": ["Fx"], },
                { "CID": "FFFF", "Category": "Component Controller Class", "Name": "Tilt UI", },
            ] }"#,
        )
        .unwrap();
        let mut cache = Cache::default();
        let found = scan(
            std::slice::from_ref(&bundle),
            Path::new("/no/such/helper"),
            Duration::from_secs(1),
            &mut cache,
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source, Source::ModuleInfo);
        assert_eq!(found[0].error, None);
        assert_eq!(found[0].classes.len(), 1, "only the audio class");
        assert_eq!(found[0].classes[0].cid, "0123456789ABCDEF0123456789ABCDEF");
        assert_eq!(cache, Cache::default());
    }

    #[test]
    fn a_helpers_result_is_cached_until_the_bundle_changes() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("Old.vst3");
        std::fs::create_dir_all(bundle.join("Contents")).unwrap();
        std::fs::write(bundle.join("Contents/Old.so"), b"12345").unwrap();
        let print = fingerprint(&bundle).unwrap();
        assert_eq!(print.0, 5);
        let class = Class {
            cid: "AB".into(),
            category: AUDIO_MODULE_CLASS.into(),
            name: "Old".into(),
            vendor: "Then".into(),
            version: "1".into(),
            sub_categories: vec!["Instrument".into()],
        };
        let mut cache = Cache::default();
        cache.bundles.insert(
            bundle.clone(),
            Cached {
                size: print.0,
                modified: print.1,
                classes: vec![class.clone()],
                error: None,
            },
        );
        let file = root.path().join("cache/vst3.json");
        cache.write(&file).unwrap();
        let mut cache = Cache::read(&file);
        let helper = Path::new("/no/such/helper");
        let found = scan(
            std::slice::from_ref(&bundle),
            helper,
            Duration::from_secs(1),
            &mut cache,
        );
        assert_eq!(found[0].source, Source::Cache);
        assert_eq!(found[0].classes, [class]);

        // Reinstalled: a helper has to look again, and here there is none.
        std::fs::write(bundle.join("Contents/Old.so"), b"123456").unwrap();
        let found = scan(
            std::slice::from_ref(&bundle),
            helper,
            Duration::from_secs(1),
            &mut cache,
        );
        assert_eq!(found[0].source, Source::Helper);
        assert!(found[0].error.is_some());
        assert!(found[0].classes.is_empty());

        // Uninstalled: forgotten.
        scan(&[], helper, Duration::from_secs(1), &mut cache);
        assert_eq!(cache, Cache::default());
    }
}

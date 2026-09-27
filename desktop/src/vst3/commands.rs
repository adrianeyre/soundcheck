//! The UI's commands for VST3 Plugins. Anything that waits on a helper runs
//! on a blocking thread, never on the window's: a Plugin may take a minute to
//! load.

use std::path::PathBuf;

use tauri::Manager;

use super::process::State;
use super::scan::{self, Cache, Scanned};
use super::{LoadRequest, Polled, Setting, Summary, registry};

/// How long a helper may take to scan one bundle without a moduleinfo:
/// loading is where copy protection runs.
const SCAN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

async fn blocking<T: Send + 'static>(
    run: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|error| error.to_string())?
}

/// The folders VST3 Plugins are installed into on this platform.
#[tauri::command]
pub fn vst3_default_folders() -> Vec<String> {
    scan::default_folders()
        .into_iter()
        .map(|folder| folder.to_string_lossy().into_owned())
        .collect()
}

/// Every VST3 Plugin in the default folders and `folders`, the ones the
/// musician added. What a helper found is cached in the app-data folder.
#[tauri::command]
pub async fn vst3_scan(
    app: tauri::AppHandle,
    folders: Vec<String>,
) -> Result<Vec<Scanned>, String> {
    let cache_file = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("The app-data folder couldn't be found: {error}"))?
        .join("vst3-scan.json");
    blocking(move || {
        let mut all = scan::default_folders();
        all.extend(folders.into_iter().map(PathBuf::from));
        let bundles = scan::bundles_in(&all);
        // Without the helper, only bundles with a moduleinfo are found; each
        // other one says why.
        let helper = super::helper().unwrap_or_default();
        let mut cache = Cache::read(&cache_file);
        let scanned = scan::scan(&bundles, &helper, SCAN_TIMEOUT, &mut cache);
        let _ = cache.write(&cache_file);
        Ok(scanned)
    })
    .await
}

/// Loads a VST3 Plugin into a helper of its own, as `request.key`.
#[tauri::command]
pub async fn vst3_load(request: LoadRequest) -> Result<Summary, String> {
    blocking(move || registry().load(request)).await
}

#[tauri::command]
pub async fn vst3_unload(key: String) -> Result<(), String> {
    blocking(move || {
        registry().unload(&key);
        Ok(())
    })
    .await
}

/// The keys of every loaded instance.
#[tauri::command]
pub fn vst3_keys() -> Vec<String> {
    registry().keys()
}

/// What happened in the Plugins' windows since the last poll, and which
/// Plugins have crashed.
#[tauri::command]
pub fn vst3_poll() -> Polled {
    registry().poll()
}

/// A Plugin's state, for the Project.
#[tauri::command]
pub async fn vst3_state(key: String) -> Result<State, String> {
    blocking(move || registry().state(&key)).await
}

/// A Plugin's settings and where they are, after it changed them itself.
#[tauri::command]
pub async fn vst3_settings(key: String) -> Result<Vec<Setting>, String> {
    blocking(move || registry().settings(&key)).await
}

/// The Plugin's own words for setting `id` at `value`, such as "-6.0 dB".
#[tauri::command]
pub async fn vst3_text(key: String, id: u32, value: f64) -> Result<String, String> {
    blocking(move || registry().text(&key, id, value)).await
}

/// Opens the Plugin's own window over the app's, where it last was if `at`
/// says. Windows only so far (ADR 0008).
#[tauri::command]
pub async fn vst3_open_editor(
    window: tauri::WebviewWindow,
    key: String,
    title: String,
    at: Option<(i32, i32)>,
) -> Result<(), String> {
    let owner = owner(&window)?;
    blocking(move || registry().open_editor(&key, &title, owner, at)).await
}

/// Closes the Plugin's window, saying where it was.
#[tauri::command]
pub async fn vst3_close_editor(key: String) -> Result<(i32, i32), String> {
    blocking(move || registry().close_editor(&key)).await
}

#[cfg(windows)]
fn owner(window: &tauri::WebviewWindow) -> Result<u64, String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    Ok(hwnd.0 as usize as u64)
}

#[cfg(not(windows))]
fn owner(_window: &tauri::WebviewWindow) -> Result<u64, String> {
    Err("A VST3 Plugin's own window opens only on Windows so far".into())
}

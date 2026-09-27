//! Finding the VST3 Plugins installed on the machine.
//!
//! A scan never runs a Plugin's code in the app. A bundle with a moduleinfo
//! (SDK 3.7 and later) is read as a file; one without is loaded by a helper
//! process of its own, so a Plugin that crashes or hangs as it loads (copy
//! protection often runs then) only costs that process, and the scan carries
//! on with the next bundle.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::moduleinfo::{self, AUDIO_MODULE_CLASS, Class};
use crate::process::scan_in_helper;

/// Where a bundle's classes came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// Its moduleinfo, without running any of its code.
    ModuleInfo,
    /// Loading it in a helper process.
    Helper,
}

/// One bundle's result.
#[derive(Debug)]
pub struct Scanned {
    pub bundle: PathBuf,
    /// Its Instruments and Effects, or why it couldn't be scanned.
    pub classes: Result<Vec<Class>, String>,
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
            folders.push(local.join("Programs/Common/VST3"));
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

/// Scans each of `bundles`, giving each helper `timeout` to answer.
pub fn scan(bundles: &[PathBuf], helper: &Path, timeout: Duration) -> Vec<Scanned> {
    bundles
        .iter()
        .map(|bundle| {
            let (classes, source) = match moduleinfo::read(bundle) {
                Some(classes) => (Ok(classes), Source::ModuleInfo),
                None => (scan_in_helper(helper, bundle, timeout), Source::Helper),
            };
            let classes = classes.map(|all| {
                all.into_iter()
                    .filter(|class| class.category == AUDIO_MODULE_CLASS)
                    .collect()
            });
            Scanned {
                bundle: bundle.clone(),
                classes,
                source,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_bundles_in_subfolders_but_not_inside_bundles() {
        let root = std::env::temp_dir().join(format!("spike-vst3-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for dir in [
            "Vendor/Reverb.vst3/Contents/x86_64-linux",
            "Delay.VST3/Contents/Resources",
            "Delay.VST3/Contents/Nested.vst3",
            "Not a plugin",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let found = bundles_in(&[root.clone(), root.join("missing")]);
        assert_eq!(
            found,
            [root.join("Delay.VST3"), root.join("Vendor/Reverb.vst3")]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_default_folders_are_the_platforms() {
        let folders = default_folders();
        if cfg!(target_os = "linux") {
            assert!(folders.contains(&PathBuf::from("/usr/lib/vst3")));
            assert!(folders.iter().any(|f| f.ends_with(".vst3")));
        }
    }
}

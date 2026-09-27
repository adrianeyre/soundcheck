//! Where the CMake build put the helper and the Plugins, and small helpers
//! for rendering blocks through them.
#![allow(dead_code)]

use std::path::PathBuf;
use std::time::Duration;

use spike_vst3_host::moduleinfo::{self, Class};
use spike_vst3_host::process::{Deadlines, PluginProcess};

pub const RATE: f64 = 48_000.0;
pub const FRAMES: usize = 128;

/// `../build`, or `SPIKE_VST3_BUILD`: see the README for how to make it.
pub fn build() -> PathBuf {
    let dir = std::env::var_os("SPIKE_VST3_BUILD")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../build"));
    assert!(
        dir.join("bin/soundcheck-vst3-host").exists(),
        "build the helper and the Plugins first (see spikes/vst3/README.md); looked in {}",
        dir.display()
    );
    dir
}

pub fn helper() -> PathBuf {
    build().join("bin/soundcheck-vst3-host")
}

pub fn plugins() -> PathBuf {
    build().join("VST3/Release")
}

pub fn bundle(name: &str) -> PathBuf {
    plugins().join(format!("{name}.vst3"))
}

/// The audio class called `name` in `bundle`.
pub fn class(bundle: &str, name: &str) -> Class {
    moduleinfo::read(&self::bundle(bundle))
        .expect("the SDK writes a moduleinfo")
        .into_iter()
        .find(|c| c.name == name && c.category == moduleinfo::AUDIO_MODULE_CLASS)
        .unwrap_or_else(|| panic!("{bundle} has no {name}"))
}

/// A helper process with class `name` of `bundle` loaded, with a block
/// deadline patient enough that a test machine busy with other tests never
/// misses it. For the tests that aren't about timing.
pub fn load(bundle: &str, name: &str) -> PluginProcess {
    let patient = Deadlines {
        block: Duration::from_millis(200),
        ..Deadlines::for_block(FRAMES, RATE)
    };
    load_with(bundle, name, patient)
}

/// The same, with the deadlines the Desktop App would use.
pub fn load_on_time(bundle: &str, name: &str) -> PluginProcess {
    load_with(bundle, name, Deadlines::for_block(FRAMES, RATE))
}

pub fn load_with(bundle: &str, name: &str, deadlines: Deadlines) -> PluginProcess {
    let class = class(bundle, name);
    let mut process = PluginProcess::spawn(&helper(), deadlines).unwrap();
    process
        .load(&self::bundle(bundle), &class.cid, RATE, FRAMES)
        .unwrap();
    process
}

/// A test signal: a quiet sine, different on each side, starting at `frame`.
pub fn signal(frame: usize) -> ([f32; FRAMES], [f32; FRAMES]) {
    let mut left = [0.0; FRAMES];
    let mut right = [0.0; FRAMES];
    for i in 0..FRAMES {
        let t = (frame + i) as f32 / RATE as f32;
        left[i] = 0.5 * (t * 440.0 * std::f32::consts::TAU).sin();
        right[i] = 0.5 * (t * 660.0 * std::f32::consts::TAU).sin();
    }
    (left, right)
}

pub fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt()
}

/// The id of the setting titled `title`.
pub fn param(process: &mut PluginProcess, title: &str) -> u32 {
    process
        .params()
        .unwrap()
        .into_iter()
        .find(|p| p.title == title)
        .unwrap_or_else(|| panic!("no setting called {title}"))
        .id
}

/// Process `pid` has exited and been reaped: not even a zombie is left.
pub fn is_gone(pid: u32) -> bool {
    !std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// A copy of Spike Faulty's bundle with no moduleinfo, like a Plugin built
/// before SDK 3.7, so a scan has to load it.
pub fn faulty_without_moduleinfo(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("spike-vst3-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    // The same name: on Linux a bundle's library is named after it.
    let copy = root.join("spike-faulty.vst3");
    copy_dir(&bundle("spike-faulty"), &copy);
    std::fs::remove_file(copy.join("Contents/Resources/moduleinfo.json")).unwrap();
    copy
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

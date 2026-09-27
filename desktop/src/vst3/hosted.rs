//! The VST3 host against the real helper and real Plugins: the test Plugin
//! "Soundcheck Faulty", which crashes, hangs or runs slow when told to, and
//! the SDK's own examples, all built by `pnpm vst3:build`. Without that build
//! these skip, unless `SOUNDCHECK_VST3_REQUIRE` is set, as CI's `vst3` job
//! sets it. `SOUNDCHECK_VST3_BUILD` points at a build elsewhere.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use soundcheck_engine::{PluginBlock, PluginKind};

use super::moduleinfo;
use super::process::{Control, Deadlines, Kind, Mode, State};
use super::protocol::Failure;
use super::scan::{self, Cache, Source};
use super::shared::ParamChange;
use super::{HELPER, LoadRequest, Notice, registry, set_block_deadline, set_helper};

pub(crate) const FAULTY: &str = "5C3A11E06F1D4B2A9D2E7B410F4C6A02";
const AGAIN: &str = "C18D3C1E719E4E29924D3ECAA5E4DA18";
const GAIN: u32 = 0;
const CRASH: u32 = 1;
const HANG: u32 = 2;
const SLOW: u32 = 3;
const POKE: u32 = 4;
const RATE: f64 = 48_000.0;
const FRAMES: usize = 256;

/// The build, or `None` to skip.
pub(crate) fn build() -> Option<PathBuf> {
    let dir = std::env::var_os("SOUNDCHECK_VST3_BUILD").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("vst3-host/build"),
        PathBuf::from,
    );
    let helper = dir.join("bin").join(HELPER);
    if helper.is_file() {
        set_helper(helper);
        return Some(dir);
    }
    assert!(
        std::env::var_os("SOUNDCHECK_VST3_REQUIRE").is_none(),
        "no VST3 helper at {}: run pnpm vst3:build",
        helper.display()
    );
    eprintln!("skipped: no VST3 helper at {}", helper.display());
    None
}

fn bundle(build: &Path, name: &str) -> PathBuf {
    build.join("VST3/Release").join(format!("{name}.vst3"))
}

fn spawn(build: &Path, deadlines: Deadlines) -> (Control, Arc<Mutex<Vec<Vec<String>>>>) {
    let notices = Arc::new(Mutex::new(Vec::new()));
    let heard = Arc::clone(&notices);
    let control = Control::spawn(&build.join("bin").join(HELPER), deadlines, move |fields| {
        heard.lock().unwrap().push(fields);
    })
    .unwrap();
    (control, notices)
}

fn faulty(build: &Path, mode: Mode, deadlines: Deadlines) -> Control {
    let (mut control, _) = spawn(build, deadlines);
    let loaded = control
        .load(
            &bundle(build, "soundcheck-test-faulty"),
            FAULTY,
            RATE,
            FRAMES,
            mode,
        )
        .unwrap();
    assert_eq!(loaded.kind, Kind::Effect);
    control
}

fn change(id: u32, value: f64) -> ParamChange {
    ParamChange {
        id,
        offset: 0,
        value,
    }
}

fn ones() -> (Vec<f32>, Vec<f32>) {
    (vec![1.0; FRAMES], vec![1.0; FRAMES])
}

fn soon() -> Instant {
    Instant::now() + Duration::from_secs(2)
}

#[test]
fn a_plugin_processes_blocks_in_its_helper() {
    let Some(build) = build() else { return };
    let control = faulty(&build, Mode::Realtime, Deadlines::default());
    let audio = control.audio(Mode::Realtime);
    let (mut left, mut right) = ones();
    let block = audio.process(&mut left, &mut right, &[change(GAIN, 0.5)], &[], soon());
    assert_eq!(block, PluginBlock::Processed);
    assert!(left.iter().chain(&right).all(|&s| s == 0.5), "at half gain");
    control.quit();
}

#[test]
fn one_of_the_sdks_own_examples_loads_and_processes() {
    let Some(build) = build() else { return };
    let (mut control, _) = spawn(&build, Deadlines::default());
    let bundle = bundle(&build, "again-sample-accurate");
    let loaded = control
        .load(&bundle, AGAIN, RATE, FRAMES, Mode::Realtime)
        .unwrap();
    assert_eq!(loaded.kind, Kind::Effect);
    assert!(control.params().unwrap().iter().any(|p| p.can_automate()));
    let audio = control.audio(Mode::Realtime);
    let (mut left, mut right) = ones();
    assert_eq!(
        audio.process(&mut left, &mut right, &[], &[], soon()),
        PluginBlock::Processed
    );
}

#[test]
fn a_plugin_that_crashes_takes_only_its_helper_down() {
    let Some(build) = build() else { return };
    let mut control = faulty(&build, Mode::Realtime, Deadlines::default());
    let audio = control.audio(Mode::Realtime);
    let (mut left, mut right) = ones();
    let started = Instant::now();
    let block = audio.process(&mut left, &mut right, &[change(CRASH, 1.0)], &[], soon());
    assert_eq!(block, PluginBlock::Crashed);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "known within the block"
    );
    assert!(audio.has_gone());
    assert_eq!(
        audio.process(&mut left, &mut right, &[], &[], soon()),
        PluginBlock::Crashed
    );
    assert_eq!(control.params(), Err(Failure::Gone));
}

#[test]
fn a_plugin_late_for_a_block_is_bypassed_and_one_that_stays_late_is_killed() {
    let Some(build) = build() else { return };
    let deadlines = Deadlines {
        hang: Duration::from_millis(200),
        ..Deadlines::default()
    };
    let control = faulty(&build, Mode::Realtime, deadlines);
    let audio = control.audio(Mode::Realtime);
    let (mut left, mut right) = ones();
    let short = || Instant::now() + Duration::from_millis(5);
    let block = audio.process(&mut left, &mut right, &[change(HANG, 1.0)], &[], short());
    assert_eq!(block, PluginBlock::Bypassed);
    assert!(
        left.iter().all(|&s| s == 1.0),
        "a bypassed block is left as it came"
    );
    let started = Instant::now();
    let mut blocks = Vec::new();
    while started.elapsed() < Duration::from_secs(2) {
        let block = audio.process(&mut left, &mut right, &[], &[], short());
        blocks.push(block);
        if block == PluginBlock::Crashed {
            break;
        }
    }
    assert_eq!(blocks.last(), Some(&PluginBlock::Crashed));
    assert!(
        blocks[..blocks.len() - 1]
            .iter()
            .all(|b| *b == PluginBlock::Bypassed)
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(audio.has_gone());
}

#[test]
fn a_slow_block_is_bypassed_and_the_next_goes_through_once_it_catches_up() {
    let Some(build) = build() else { return };
    let control = faulty(&build, Mode::Realtime, Deadlines::default());
    let audio = control.audio(Mode::Realtime);
    let (mut left, mut right) = ones();
    // Slow 0.5: 50 ms a block.
    audio.process(&mut left, &mut right, &[change(SLOW, 0.5)], &[], soon());
    let (mut left, mut right) = ones();
    let block = audio.process(
        &mut left,
        &mut right,
        &[change(GAIN, 0.5)],
        &[],
        Instant::now() + Duration::from_millis(5),
    );
    assert_eq!(block, PluginBlock::Bypassed);
    std::thread::sleep(Duration::from_millis(100));
    let (mut left, mut right) = ones();
    assert_eq!(
        audio.process(&mut left, &mut right, &[change(SLOW, 0.0)], &[], soon()),
        PluginBlock::Processed
    );
    assert!(
        left.iter().all(|&s| s == 0.5),
        "the late block's changes arrived"
    );
}

#[test]
fn offline_no_block_is_late_but_a_hung_plugin_is_still_killed() {
    let Some(build) = build() else { return };
    let deadlines = Deadlines {
        command: Duration::from_millis(500),
        ..Deadlines::default()
    };
    let control = faulty(&build, Mode::Offline, deadlines);
    let audio = control.audio(Mode::Offline);
    let (mut left, mut right) = ones();
    let past = Instant::now();
    let block = audio.process(
        &mut left,
        &mut right,
        &[change(SLOW, 1.0), change(GAIN, 0.5)],
        &[],
        past,
    );
    assert_eq!(block, PluginBlock::Processed, "100 ms late, offline");
    assert_eq!(left[0], 0.5);
    let block = audio.process(&mut left, &mut right, &[change(HANG, 1.0)], &[], past);
    assert_eq!(block, PluginBlock::Crashed);
    assert!(audio.has_gone());
}

#[test]
fn its_state_goes_to_another_helper_and_back() {
    let Some(build) = build() else { return };
    let mut control = faulty(&build, Mode::Realtime, Deadlines::default());
    let audio = control.audio(Mode::Realtime);
    let (mut left, mut right) = ones();
    audio.process(&mut left, &mut right, &[change(GAIN, 0.25)], &[], soon());
    let state = control.get_state().unwrap();
    assert_eq!(state.component, 0.25f32.to_le_bytes());
    control.quit();

    let mut copy = faulty(&build, Mode::Realtime, Deadlines::default());
    copy.set_state(&state).unwrap();
    let gain = copy
        .params()
        .unwrap()
        .into_iter()
        .find(|p| p.id == GAIN)
        .unwrap();
    assert_eq!(gain.value, 0.25);
    let audio = copy.audio(Mode::Realtime);
    let (mut left, mut right) = ones();
    assert_eq!(
        audio.process(&mut left, &mut right, &[], &[], soon()),
        PluginBlock::Processed
    );
    assert_eq!(left[0], 0.25);
    assert!(
        copy.set_state(&State::default()).is_err(),
        "an empty state is refused"
    );
}

#[test]
fn the_plugin_says_its_own_values_and_what_happens_in_its_window() {
    let Some(build) = build() else { return };
    let (mut control, notices) = spawn(&build, Deadlines::default());
    control
        .load(
            &bundle(&build, "soundcheck-test-faulty"),
            FAULTY,
            RATE,
            FRAMES,
            Mode::Realtime,
        )
        .unwrap();
    assert_eq!(control.text(GAIN, 0.5).unwrap(), "-6.0 dB");
    let editor = control.editor().unwrap();
    assert_eq!((editor.width, editor.height), (420, 240));
    assert!(editor.platforms.iter().any(|p| p == "HWND"));

    // Poke turns Gain to a quarter as a knob in its window would.
    control.set_on_controller(POKE, 1.0).unwrap();
    // The notices come before `set`'s answer, on the same pipe.
    let heard: Vec<Notice> = notices
        .lock()
        .unwrap()
        .iter()
        .filter_map(|fields| super::parse_notice(fields))
        .collect();
    assert_eq!(
        heard,
        [
            Notice::Begin { id: GAIN },
            Notice::Edit {
                id: GAIN,
                value: 0.25
            },
            Notice::End { id: GAIN },
        ]
    );
}

#[test]
fn a_bundle_without_a_moduleinfo_is_scanned_in_a_helper_and_cached() {
    let Some(build) = build() else { return };
    let root = tempfile::tempdir().unwrap();
    // A bundle's library is named as the bundle is.
    let copy = root.path().join("soundcheck-test-faulty.vst3");
    copy_dir(&bundle(&build, "soundcheck-test-faulty"), &copy);
    std::fs::remove_file(copy.join("Contents/Resources/moduleinfo.json")).unwrap();
    let broken = root.path().join("Broken.vst3");
    std::fs::create_dir_all(broken.join("Contents")).unwrap();

    let helper = build.join("bin").join(HELPER);
    let mut cache = Cache::default();
    let bundles = scan::bundles_in(&[root.path().to_path_buf()]);
    let found = scan::scan(&bundles, &helper, Duration::from_secs(10), &mut cache);
    assert_eq!(found.len(), 2);
    let (broken, faulty) = (&found[0], &found[1]);
    assert_eq!(broken.source, Source::Helper);
    assert!(broken.error.is_some() && broken.classes.is_empty());
    assert_eq!(faulty.source, Source::Helper);
    assert_eq!(faulty.error, None);
    assert_eq!(faulty.classes.len(), 1);
    assert_eq!(faulty.classes[0].cid, FAULTY);
    assert_eq!(faulty.classes[0].name, "Soundcheck Faulty");

    let again = scan::scan(&bundles, &helper, Duration::from_secs(10), &mut cache);
    assert!(again.iter().all(|s| s.source == Source::Cache));
    assert_eq!(again[1].classes, faulty.classes);
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let path = entry.path();
        let target = to.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &target);
        } else {
            std::fs::copy(&path, &target).unwrap();
        }
    }
}

pub(crate) fn request(
    build: &Path,
    key: &str,
    name: &str,
    cid: &str,
    state: Option<State>,
) -> LoadRequest {
    LoadRequest {
        key: key.into(),
        bundle: bundle(build, name),
        cid: cid.into(),
        name: name.into(),
        version: "1.0".into(),
        sample_rate: RATE,
        state,
    }
}

#[test]
fn the_registry_hosts_an_effect_live_and_copies_it_for_an_export() {
    let Some(build) = build() else { return };
    let state = State {
        component: 0.5f32.to_le_bytes().to_vec(),
        controller: Vec::new(),
    };
    let summary = registry()
        .load(request(
            &build,
            "hosted-effect",
            "soundcheck-test-faulty",
            FAULTY,
            Some(state),
        ))
        .unwrap();
    assert_eq!(summary.kind, Kind::Effect);
    let names: Vec<&str> = summary.settings.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["p0"], "only Gain can be automated");
    assert_eq!(
        summary.settings[0].value, 0.5,
        "the saved state was restored"
    );
    assert_eq!(summary.settings[0].label, "Gain");
    let generation = summary.generation;

    // The wrong generation, or kind, or key: missing.
    let hosted = |g, kind, mode| registry().hosted("hosted-effect", g, kind, RATE as f32, mode);
    assert!(hosted(generation + 1, PluginKind::Effect, Mode::Realtime).is_none());
    assert!(hosted(generation, PluginKind::Instrument, Mode::Realtime).is_none());
    assert!(
        registry()
            .hosted(
                "nothing",
                generation,
                PluginKind::Effect,
                48_000.0,
                Mode::Realtime
            )
            .is_none()
    );

    let mut live = hosted(generation, PluginKind::Effect, Mode::Realtime).unwrap();
    assert_eq!(live.manifest.id, format!("vst3.{}", FAULTY.to_lowercase()));
    assert_eq!(live.values, [0.5]);
    set_block_deadline(Some(soon()));
    let (mut left, mut right) = ones();
    live.instance.set_param(0, 0.25);
    assert_eq!(
        live.instance.process_block(&mut left, &mut right),
        PluginBlock::Processed
    );
    assert_eq!(left[0], 0.25);
    set_block_deadline(None);

    // The copy starts from the live one's state now, in a helper of its own.
    let mut copy = hosted(generation, PluginKind::Effect, Mode::Offline).unwrap();
    assert_eq!(copy.values, [0.25]);
    let (mut left, mut right) = ones();
    assert_eq!(
        copy.instance.process_block(&mut left, &mut right),
        PluginBlock::Processed
    );
    assert_eq!(left[0], 0.25);
    assert_eq!(
        registry().state("hosted-effect").unwrap().component,
        0.25f32.to_le_bytes()
    );
    assert_eq!(
        registry().text("hosted-effect", GAIN, 1.0).unwrap(),
        "0.0 dB"
    );

    registry().unload("hosted-effect");
    assert!(!registry().keys().contains(&"hosted-effect".to_string()));
    let (mut left, mut right) = ones();
    assert_eq!(
        live.instance.process_block(&mut left, &mut right),
        PluginBlock::Crashed,
        "an unloaded instance's helper has gone"
    );
    let (mut left, mut right) = ones();
    assert_eq!(
        copy.instance.process_block(&mut left, &mut right),
        PluginBlock::Processed,
        "the copy's helper is its own"
    );
}

#[test]
fn the_registry_says_which_instances_have_crashed() {
    let Some(build) = build() else { return };
    let summary = registry()
        .load(request(
            &build,
            "hosted-crash",
            "soundcheck-test-faulty",
            FAULTY,
            None,
        ))
        .unwrap();
    let hosted = registry()
        .hosted(
            "hosted-crash",
            summary.generation,
            PluginKind::Effect,
            RATE as f32,
            Mode::Realtime,
        )
        .unwrap();
    let crashing = registry().get("hosted-crash").unwrap();
    let (mut left, mut right) = ones();
    crashing
        .audio
        .process(&mut left, &mut right, &[change(CRASH, 1.0)], &[], soon());
    let polled = registry().poll();
    assert!(polled.gone.contains(&"hosted-crash".to_string()));
    drop(hosted);
    registry().unload("hosted-crash");
}

#[test]
fn the_registry_loads_it_again_at_the_audio_devices_new_rate() {
    let Some(build) = build() else { return };
    let summary = registry()
        .load(request(
            &build,
            "hosted-rate",
            "soundcheck-test-faulty",
            FAULTY,
            None,
        ))
        .unwrap();
    let before = registry().get("hosted-rate").unwrap();
    let hosted = registry()
        .hosted(
            "hosted-rate",
            summary.generation,
            PluginKind::Effect,
            44_100.0,
            Mode::Realtime,
        )
        .unwrap();
    let after = registry().get("hosted-rate").unwrap();
    assert_eq!(after.sample_rate, 44_100.0);
    assert_eq!(
        after.generation, summary.generation,
        "the UI's slot still names it"
    );
    assert_ne!(lock(&before.control).pid(), lock(&after.control).pid());
    drop(hosted);
    registry().unload("hosted-rate");
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap()
}

#[test]
fn the_registry_hosts_an_instrument_that_plays_notes() {
    let Some(build) = build() else { return };
    let mda = bundle(&build, "mda-vst3");
    let classes = moduleinfo::read(&mda).unwrap();
    let piano = classes
        .iter()
        .find(|c| c.name == "mda Piano" && c.category == moduleinfo::AUDIO_MODULE_CLASS)
        .unwrap();
    assert!(piano.is_instrument());
    let summary = registry()
        .load(LoadRequest {
            name: piano.name.clone(),
            ..request(&build, "hosted-piano", "mda-vst3", &piano.cid, None)
        })
        .unwrap();
    assert_eq!(summary.kind, Kind::Instrument);
    let mut hosted = registry()
        .hosted(
            "hosted-piano",
            summary.generation,
            PluginKind::Instrument,
            RATE as f32,
            Mode::Realtime,
        )
        .unwrap();
    assert_eq!(hosted.manifest.kind, PluginKind::Instrument);
    hosted.instance.note_on(60, 0.8).unwrap();
    let mut loudest = 0.0f32;
    set_block_deadline(Some(soon()));
    for _ in 0..8 {
        let (mut left, mut right) = (vec![0.0; FRAMES], vec![0.0; FRAMES]);
        assert_eq!(
            hosted.instance.process_block(&mut left, &mut right),
            PluginBlock::Processed
        );
        loudest = left
            .iter()
            .chain(&right)
            .fold(loudest, |m, s| m.max(s.abs()));
    }
    set_block_deadline(None);
    assert!(loudest > 0.01, "a note sounds: {loudest}");
    drop(hosted);
    registry().unload("hosted-piano");
}

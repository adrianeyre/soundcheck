//! The spike's claims, against the real helper and Plugins the CMake build
//! made: the SDK's own examples, and Spike Faulty, which crashes or hangs on
//! demand. See the README for how to build them first.

mod common;

use std::time::{Duration, Instant};

use common::{FRAMES, RATE};
use spike_vst3_host::moduleinfo::AUDIO_MODULE_CLASS;
use spike_vst3_host::process::{Block, Deadlines, Kind, PluginProcess};
use spike_vst3_host::saved::SavedVst3;
use spike_vst3_host::scan::{self, Source};
use spike_vst3_host::shared::{EVENT_NOTE_OFF, EVENT_NOTE_ON, Event, ParamChange};

const FAULTY_GAIN: u32 = 0;
const FAULTY_CRASH: u32 = 1;
const FAULTY_HANG: u32 = 2;
const FAULTY_SLOW: u32 = 3;

fn change(id: u32, value: f64) -> ParamChange {
    ParamChange {
        id,
        offset: 0,
        value,
    }
}

#[test]
fn a_scan_finds_the_plugins_without_running_them() {
    let bundles = scan::bundles_in(&[common::plugins()]);
    let found = scan::scan(&bundles, &common::helper(), Duration::from_secs(10));
    let named = |name: &str| {
        found
            .iter()
            .flat_map(|s| s.classes.as_ref().unwrap().iter().map(move |c| (s, c)))
            .find(|(_, c)| c.name == name)
            .unwrap_or_else(|| panic!("the scan didn't find {name}"))
    };
    for name in [
        "ADelay",
        "AGain Sample Accurate",
        "mda JX10",
        "Spike Faulty",
    ] {
        let (scanned, class) = named(name);
        assert_eq!(scanned.source, Source::ModuleInfo, "{name}");
        assert_eq!(class.category, AUDIO_MODULE_CLASS);
    }
    assert!(named("mda JX10").1.is_instrument());
    assert!(!named("ADelay").1.is_instrument());
    assert_eq!(
        named("Spike Faulty").1.cid,
        "5C3A11E06F1D4B2A9D2E7B410F4C6A01"
    );
    assert!(found.iter().all(|s| s.classes.is_ok()));
}

#[test]
fn a_bundle_without_a_moduleinfo_is_scanned_in_a_helper() {
    let old = common::faulty_without_moduleinfo("scan");
    let found = scan::scan(
        std::slice::from_ref(&old),
        &common::helper(),
        Duration::from_secs(10),
    );
    assert_eq!(found[0].source, Source::Helper);
    let classes = found[0].classes.as_ref().unwrap();
    assert_eq!(
        classes.len(),
        1,
        "only the Effect, not anything else its factory makes"
    );
    assert_eq!(classes[0].name, "Spike Faulty");
    assert_eq!(classes[0].cid, "5C3A11E06F1D4B2A9D2E7B410F4C6A01");
    assert_eq!(classes[0].sub_categories, ["Fx"]);
    std::fs::remove_dir_all(old.parent().unwrap()).unwrap();
}

#[test]
fn a_bundle_that_is_not_there_says_so() {
    let found = scan::scan(
        &["/nope.vst3".into()],
        &common::helper(),
        Duration::from_secs(10),
    );
    let why = found[0].classes.as_ref().unwrap_err();
    assert!(why.contains("not a module directory"), "{why}");
}

#[test]
fn an_effect_processes_audio_in_its_own_process() {
    let mut faulty = common::load("spike-faulty", "Spike Faulty");
    assert_ne!(faulty.pid(), std::process::id());
    let (dry_left, dry_right) = common::signal(0);
    let (mut left, mut right) = (dry_left, dry_right);
    let block = faulty.process(&mut left, &mut right, &[change(FAULTY_GAIN, 0.25)], &[]);
    assert_eq!(block, Block::Processed);
    for i in 0..FRAMES {
        assert_eq!(left[i], dry_left[i] * 0.25);
        assert_eq!(right[i], dry_right[i] * 0.25);
    }
}

#[test]
fn load_says_what_kind_of_plugin_it_is() {
    let class = common::class("spike-faulty", "Spike Faulty");
    let mut faulty =
        PluginProcess::spawn(&common::helper(), Deadlines::for_block(FRAMES, RATE)).unwrap();
    let loaded = faulty
        .load(&common::bundle("spike-faulty"), &class.cid, RATE, FRAMES)
        .unwrap();
    assert_eq!(
        (loaded.kind, loaded.inputs, loaded.outputs),
        (Kind::Effect, 2, 2)
    );

    let class = common::class("mda-vst3", "mda JX10");
    let mut jx10 =
        PluginProcess::spawn(&common::helper(), Deadlines::for_block(FRAMES, RATE)).unwrap();
    let loaded = jx10
        .load(&common::bundle("mda-vst3"), &class.cid, RATE, FRAMES)
        .unwrap();
    assert_eq!(
        (loaded.kind, loaded.inputs, loaded.outputs),
        (Kind::Instrument, 0, 2)
    );
}

#[test]
fn loading_what_is_not_there_is_refused_and_the_process_lives_on() {
    let mut process =
        PluginProcess::spawn(&common::helper(), Deadlines::for_block(FRAMES, RATE)).unwrap();
    let result = process.load(
        &common::bundle("spike-faulty"),
        "00000000000000000000000000000000",
        RATE,
        FRAMES,
    );
    assert!(result.is_err());
    assert!(!process.has_crashed());
}

#[test]
fn an_instrument_plays_a_note() {
    let play = |note: bool| {
        let mut dx10 = common::load("mda-vst3", "mda DX10");
        let mut heard = Vec::new();
        for n in 0..20 {
            let events = match n {
                0 if note => vec![Event {
                    kind: EVENT_NOTE_ON,
                    offset: 0,
                    pitch: 60,
                    velocity: 0.8,
                }],
                10 if note => vec![Event {
                    kind: EVENT_NOTE_OFF,
                    offset: 0,
                    pitch: 60,
                    velocity: 0.0,
                }],
                _ => vec![],
            };
            let (mut left, mut right) = ([0.0; FRAMES], [0.0; FRAMES]);
            assert_eq!(
                dx10.process(&mut left, &mut right, &[], &events),
                Block::Processed
            );
            heard.extend_from_slice(&left);
        }
        common::rms(&heard)
    };
    assert_eq!(play(false), 0.0);
    assert!(play(true) > 0.05, "the note is heard");
}

#[test]
fn the_assistant_reaches_only_what_a_plugin_exposes() {
    let mut faulty = common::load("spike-faulty", "Spike Faulty");
    let params = faulty.params().unwrap();
    let titles: Vec<_> = params.iter().map(|p| p.title.as_str()).collect();
    assert_eq!(titles, ["Gain", "Crash", "Hang", "Slow"]);
    let automatable: Vec<_> = params
        .iter()
        .filter(|p| p.can_automate())
        .map(|p| p.title.as_str())
        .collect();
    assert_eq!(automatable, ["Gain"]);

    let mut delay = common::load("adelay", "ADelay");
    let params = delay.params().unwrap();
    let delay_time = params.iter().find(|p| p.title == "Delay").unwrap();
    assert_eq!(delay_time.units, "sec");
    assert!(delay_time.can_automate());
}

#[test]
fn state_survives_a_new_process() {
    let class = common::class("spike-faulty", "Spike Faulty");
    let mut faulty = common::load("spike-faulty", "Spike Faulty");
    let (mut left, mut right) = common::signal(0);
    faulty.process(&mut left, &mut right, &[change(FAULTY_GAIN, 0.3)], &[]);
    let saved = SavedVst3::new(&class, &faulty.get_state().unwrap());
    faulty.quit();

    // What the project would hold, and read back.
    let json = serde_json::to_string(&saved).unwrap();
    let read: SavedVst3 = serde_json::from_str(&json).unwrap();

    let mut again = common::load("spike-faulty", "Spike Faulty");
    again.set_state(&read.state().unwrap()).unwrap();
    let (dry_left, _) = common::signal(0);
    let (mut left, mut right) = common::signal(0);
    assert_eq!(
        again.process(&mut left, &mut right, &[], &[]),
        Block::Processed
    );
    assert_eq!(left[7], dry_left[7] * 0.3);
}

#[test]
fn a_delays_time_survives_a_new_process() {
    let impulse_at = |process: &mut PluginProcess, changes: &[ParamChange]| {
        let mut heard = Vec::new();
        for n in 0..8 {
            let (mut left, mut right) = ([0.0; FRAMES], [0.0; FRAMES]);
            if n == 0 {
                left[0] = 1.0;
            }
            let changes = if n == 0 { changes } else { &[] };
            assert_eq!(
                process.process(&mut left, &mut right, changes, &[]),
                Block::Processed
            );
            heard.extend_from_slice(&left);
        }
        heard.iter().position(|s| *s == 1.0)
    };
    let mut delay = common::load("adelay", "ADelay");
    let id = common::param(&mut delay, "Delay");
    // A 64th of its 1-second range, exact as a float: 750 samples at 48 kHz.
    assert_eq!(impulse_at(&mut delay, &[change(id, 1.0 / 64.0)]), Some(750));
    let state = delay.get_state().unwrap();
    drop(delay);

    let mut again = common::load("adelay", "ADelay");
    again.set_state(&state).unwrap();
    assert_eq!(impulse_at(&mut again, &[]), Some(750));
}

#[test]
fn a_crash_takes_down_only_its_own_plugin() {
    let mut delay = common::load("adelay", "ADelay");
    let mut reference = common::load("adelay", "ADelay");
    let mut faulty = common::load("spike-faulty", "Spike Faulty");
    let delay_id = common::param(&mut delay, "Delay");
    let setup = [change(delay_id, 0.004)];

    // Save the faulty Plugin's state, as the project would, before it fails.
    let (mut left, mut right) = common::signal(0);
    faulty.process(&mut left, &mut right, &[change(FAULTY_GAIN, 0.5)], &[]);
    let saved = faulty.get_state().unwrap();

    let crash_at = 10;
    let mut crashed_at = None;
    for n in 0..200 {
        let frame = n * FRAMES;
        let changes: &[ParamChange] = if n == 0 { &setup } else { &[] };

        // Track 1: the delay the crash must not touch.
        let (mut left, mut right) = common::signal(frame);
        assert_eq!(
            delay.process(&mut left, &mut right, changes, &[]),
            Block::Processed
        );
        let (mut want_left, mut want_right) = common::signal(frame);
        reference.process(&mut want_left, &mut want_right, changes, &[]);
        assert_eq!((left, right), (want_left, want_right), "block {n}");

        // Track 2: the faulty Plugin, told to crash in block `crash_at`.
        let (dry_left, _) = common::signal(frame);
        let (mut left, mut right) = common::signal(frame);
        let changes = if n == crash_at {
            vec![change(FAULTY_CRASH, 1.0)]
        } else {
            vec![]
        };
        let started = Instant::now();
        let block = faulty.process(&mut left, &mut right, &changes, &[]);
        assert!(
            started.elapsed() < Duration::from_millis(20),
            "block {n} waited"
        );
        match block {
            Block::Processed => assert!(n < crash_at, "block {n}"),
            Block::Bypassed => {
                assert!(n >= crash_at, "block {n}");
                assert_eq!(left, dry_left, "a bypassed Effect passes its input through");
            }
            Block::Crashed => {
                crashed_at.get_or_insert(n);
            }
        }
        // As the audio callback would come round again.
        std::thread::sleep(Duration::from_secs_f64(FRAMES as f64 / RATE));
    }
    // The helper's crash handler says so in the block it crashed in, however
    // long the system then takes to end the process (a core dump, say).
    assert_eq!(crashed_at, Some(crash_at));
    assert!(faulty.has_crashed());

    // Loaded again from its saved state, it carries on where it was.
    let mut faulty = common::load("spike-faulty", "Spike Faulty");
    faulty.set_state(&saved).unwrap();
    let (dry_left, _) = common::signal(0);
    let (mut left, mut right) = common::signal(0);
    assert_eq!(
        faulty.process(&mut left, &mut right, &[], &[]),
        Block::Processed
    );
    assert_eq!(left[3], dry_left[3] * 0.5);
}

#[test]
fn a_hang_is_bypassed_then_killed() {
    let mut faulty = common::load_on_time("spike-faulty", "Spike Faulty");
    let hang = Deadlines::for_block(FRAMES, RATE).hang;
    let (mut left, mut right) = common::signal(0);
    assert_eq!(
        faulty.process(&mut left, &mut right, &[change(FAULTY_HANG, 1.0)], &[]),
        Block::Bypassed
    );

    let started = Instant::now();
    let mut blocks = Vec::new();
    let mut slowest = Duration::ZERO;
    while started.elapsed() < hang * 3 {
        let (dry_left, _) = common::signal(0);
        let (mut left, mut right) = common::signal(0);
        let block_started = Instant::now();
        let block = faulty.process(&mut left, &mut right, &[], &[]);
        slowest = slowest.max(block_started.elapsed());
        if block == Block::Bypassed {
            assert_eq!(left, dry_left, "a bypassed Effect passes its input through");
        }
        blocks.push((block, started.elapsed()));
        // As an audio callback would come round again.
        std::thread::sleep(Duration::from_secs_f64(FRAMES as f64 / RATE));
    }
    assert!(
        slowest < Duration::from_millis(20),
        "no block waited past its deadline: {slowest:?}"
    );
    let first_crash = blocks
        .iter()
        .find(|(b, _)| *b == Block::Crashed)
        .expect("it was killed");
    assert!(
        first_crash.1 >= hang - Duration::from_millis(50),
        "killed at {:?}",
        first_crash.1
    );
    assert!(
        first_crash.1 < hang + Duration::from_millis(200),
        "killed at {:?}",
        first_crash.1
    );
    assert!(
        blocks
            .iter()
            .skip_while(|(b, _)| *b != Block::Crashed)
            .all(|(b, _)| *b == Block::Crashed)
    );
    let pid = faulty.pid();
    drop(faulty);
    assert!(common::is_gone(pid));
}

#[test]
fn a_slow_plugin_is_bypassed_but_misses_no_setting() {
    let mut faulty = common::load_on_time("spike-faulty", "Spike Faulty");
    // A tenth of 100 ms: 10 ms a block, far past the 2.7 ms it may take.
    let (mut left, mut right) = common::signal(0);
    assert_eq!(
        faulty.process(&mut left, &mut right, &[change(FAULTY_SLOW, 0.1)], &[]),
        Block::Bypassed
    );
    // Still busy with that block, so this one is bypassed, and its change
    // kept rather than lost.
    let (dry_left, _) = common::signal(0);
    let (mut left, mut right) = common::signal(0);
    let changes = [change(FAULTY_GAIN, 0.125), change(FAULTY_SLOW, 0.0)];
    assert_eq!(
        faulty.process(&mut left, &mut right, &changes, &[]),
        Block::Bypassed
    );
    assert_eq!(left, dry_left);
    std::thread::sleep(Duration::from_millis(30));
    // Caught up: the kept changes go with this block.
    let (mut left, mut right) = common::signal(0);
    assert_eq!(
        faulty.process(&mut left, &mut right, &[], &[]),
        Block::Processed
    );
    assert_eq!(left[5], dry_left[5] * 0.125);
    assert!(!faulty.has_crashed(), "slow isn't hung");
}

#[test]
fn a_callback_can_start_every_plugin_before_it_waits_for_any() {
    let mut plugins: Vec<_> = (0..4)
        .map(|_| common::load("spike-faulty", "Spike Faulty"))
        .collect();
    let (dry_left, dry_right) = common::signal(0);
    let mut buffers = vec![(dry_left, dry_right); plugins.len()];
    let begun: Vec<_> = plugins
        .iter_mut()
        .zip(&buffers)
        .enumerate()
        .map(|(n, (plugin, (left, right)))| {
            let gain = change(FAULTY_GAIN, 0.125 * (n + 1) as f64);
            plugin.begin(left, right, &[gain], &[])
        })
        .collect();
    assert!(begun.iter().all(Option::is_none), "every block was sent");
    let deadline = Instant::now() + Duration::from_millis(200);
    for (n, (plugin, (left, right))) in plugins.iter_mut().zip(&mut buffers).enumerate() {
        assert_eq!(plugin.finish(left, right, deadline), Block::Processed);
        assert_eq!(left[9], dry_left[9] * 0.125 * (n + 1) as f32);
    }
}

#[test]
fn a_plugin_says_what_its_window_needs() {
    let mut faulty = common::load("spike-faulty", "Spike Faulty");
    let editor = faulty.editor().unwrap();
    assert_eq!(
        (editor.width, editor.height, editor.resizable),
        (420, 240, false)
    );
    assert_eq!(editor.platforms, ["HWND", "NSView", "X11EmbedWindowID"]);

    // The SDK's examples were built without VSTGUI, so they have none.
    let mut delay = common::load("adelay", "ADelay");
    assert!(delay.editor().is_err());
}

#[test]
fn dropping_a_plugin_ends_its_process() {
    let faulty = common::load("spike-faulty", "Spike Faulty");
    let pid = faulty.pid();
    assert!(std::path::Path::new(&format!("/proc/{pid}")).exists());
    drop(faulty);
    assert!(common::is_gone(pid));
}

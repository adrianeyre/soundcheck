//! Automation of a Track's volume and pan and the Master's volume, rendered
//! into buffers: in real time a block at a time, and offline for export.

use super::*;
use crate::audio_file::tests::stereo_wav;
use crate::transport::TICKS_PER_BEAT;

const RATE: f32 = 48_000.0;
const BEAT: f64 = TICKS_PER_BEAT as f64;
/// At 120 bpm a beat is half a second.
const FRAMES_PER_BEAT: usize = 24_000;
const MASTER: i32 = -1;
/// The level of the file every test plays, before any gain.
const LEVEL: f32 = 0.5;

/// One Audio Track playing a steady level on both sides for eight beats, so
/// every sample it renders is that level times its gains.
fn engine() -> Engine {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_audio(0, true);
    let steady = vec![LEVEL; 8 * FRAMES_PER_BEAT];
    assert_eq!(
        engine.load_audio_file(1, &stereo_wav(&steady, &steady, RATE as u32)),
        None
    );
    engine.set_track_audio_clips(0, &[0.0, 4.0, 1.0, 0.0]);
    engine
}

/// Play from the top in blocks of `block`, for `frames`: both sides, each
/// sample divided by what the Track reaches the Master at unautomated, so
/// it is the gain Automation gave it.
fn play(engine: &mut Engine, block: usize, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let unity = LEVEL * TRACKS_GAIN;
    let (mut left, mut right) = (Vec::new(), Vec::new());
    engine.play();
    while left.len() < frames {
        engine.render(block);
        left.extend(engine.left()[..block].iter().map(|s| s / unity));
        right.extend(engine.right()[..block].iter().map(|s| s / unity));
    }
    left.truncate(frames);
    right.truncate(frames);
    (left, right)
}

fn assert_near(actual: f32, expected: f32, what: &str) {
    assert!(
        (actual - expected).abs() < 1e-3,
        "{what}: {actual} is not {expected}"
    );
}

#[test]
fn a_volume_ramp_follows_its_breakpoints_frame_by_frame() {
    let mut engine = engine();
    // From beat 1 to beat 3, silence up to unity.
    engine.set_automation(0, "volume", &[BEAT, 0.0, 0.0, 3.0 * BEAT, 1.0, 0.0]);
    // A block size that puts both breakpoints part way through a block.
    let (left, right) = play(&mut engine, 700, 4 * FRAMES_PER_BEAT);
    for frame in (0..left.len()).step_by(97) {
        let expected = match frame {
            f if f < FRAMES_PER_BEAT => 0.0,
            f if f < 3 * FRAMES_PER_BEAT => {
                (f - FRAMES_PER_BEAT) as f32 / (2 * FRAMES_PER_BEAT) as f32
            }
            _ => 1.0,
        };
        assert_near(left[frame], expected, &format!("left at {frame}"));
        assert_near(right[frame], expected, &format!("right at {frame}"));
    }
    // The ramp starts on the very frame of its first breakpoint, not at the
    // start of the block it falls in.
    assert_eq!(left[FRAMES_PER_BEAT - 1], 0.0);
    assert!(left[FRAMES_PER_BEAT + 1] > 0.0);
}

#[test]
fn a_hold_steps_on_the_frame_of_the_next_breakpoint() {
    let mut engine = engine();
    engine.set_automation(0, "volume", &[0.0, 1.0, 1.0, BEAT, 0.25, 1.0]);
    let (left, _) = play(&mut engine, 700, 2 * FRAMES_PER_BEAT);
    assert!(
        left[..FRAMES_PER_BEAT]
            .iter()
            .all(|&g| (g - 1.0).abs() < 1e-4)
    );
    assert!(
        left[FRAMES_PER_BEAT..]
            .iter()
            .all(|&g| (g - 0.25).abs() < 1e-4)
    );
}

#[test]
fn automated_pan_sweeps_from_one_side_to_the_other() {
    let mut engine = engine();
    engine.set_automation(0, "pan", &[0.0, -1.0, 0.0, 2.0 * BEAT, 1.0, 0.0]);
    let (left, right) = play(&mut engine, 512, 2 * FRAMES_PER_BEAT);
    // Hard left, centre, then half right.
    assert_near(left[0], 1.0, "left at the start");
    assert_near(right[0], 0.0, "right at the start");
    assert_near(left[FRAMES_PER_BEAT], 1.0, "left in the middle");
    assert_near(right[FRAMES_PER_BEAT], 1.0, "right in the middle");
    let three_quarters = 3 * FRAMES_PER_BEAT / 2;
    assert_near(left[three_quarters], 0.5, "left three quarters in");
    assert_near(right[three_quarters], 1.0, "right three quarters in");
}

#[test]
fn automation_overrides_the_fixed_setting_and_leaves_the_other_alone() {
    let mut engine = engine();
    engine.set_track_mixer(0, 2.0, 1.0, false, false);
    engine.set_automation(0, "volume", &[0.0, 0.5, 0.0]);
    let (left, right) = play(&mut engine, 256, 1_024);
    assert_near(left[100], 0.0, "panned hard right, the left is silent");
    assert_near(right[100], 0.5, "the Automation's volume, not the fader's");

    // Taking the Automation away gives the fader back.
    engine.set_automation(0, "volume", &[]);
    let (_, right) = play(&mut engine, 256, 1_024);
    assert_near(right[100], 2.0, "the fader again");
}

#[test]
fn the_master_volume_follows_its_automation() {
    let mut engine = engine();
    engine.set_master_volume(0.1);
    engine.set_automation(MASTER, "volume", &[0.0, 1.0, 0.0, 2.0 * BEAT, 0.0, 0.0]);
    let (left, _) = play(&mut engine, 333, 2 * FRAMES_PER_BEAT + 10);
    for frame in (0..2 * FRAMES_PER_BEAT).step_by(101) {
        let expected = 1.0 - frame as f32 / (2 * FRAMES_PER_BEAT) as f32;
        assert_near(left[frame], expected, &format!("at {frame}"));
    }
    assert_eq!(left[2 * FRAMES_PER_BEAT + 5], 0.0);

    // The Master has no pan to automate.
    engine.set_automation(MASTER, "pan", &[0.0, -1.0, 0.0]);
    engine.set_automation(MASTER, "volume", &[]);
    engine.seek(0.0);
    let (left, right) = play(&mut engine, 256, 512);
    assert_near(left[100], 0.1, "left at the fader");
    assert_near(right[100], 0.1, "right at the fader");
}

#[test]
fn automation_follows_the_tempo_map() {
    let mut engine = engine();
    // From beat 1 on, 60 bpm: a beat is a second.
    engine.set_tempo_changes(&[BEAT, 60.0, 4.0, 4.0]);
    engine.set_automation(0, "volume", &[BEAT, 0.0, 0.0, 2.0 * BEAT, 1.0, 0.0]);
    let (left, _) = play(&mut engine, 512, 3 * FRAMES_PER_BEAT);
    // Half way from beat 1 to beat 2 is half a second after beat 1.
    assert_near(left[FRAMES_PER_BEAT + 24_000], 0.5, "half way");
    assert_near(left[FRAMES_PER_BEAT + 47_999], 1.0, "at beat 2");
}

#[test]
fn stopped_an_automated_setting_holds_its_value_at_the_playhead() {
    // A note played live on a Synth Track, with the transport stopped.
    let live = |set_up: &dyn Fn(&mut Engine)| {
        let mut engine = Engine::new(RATE);
        engine.set_track_count(1);
        engine.set_live_track(Some(0));
        set_up(&mut engine);
        engine.note_on(60, 1.0);
        engine.render(2_048);
        engine.left()[..2_048].to_vec()
    };
    let automated = live(&|engine| {
        engine.set_track_mixer(0, 2.0, 0.0, false, false);
        engine.set_automation(0, "volume", &[0.0, 0.0, 0.0, 2.0 * BEAT, 1.0, 0.0]);
        engine.seek(BEAT);
    });
    let fixed = live(&|engine| engine.set_track_mixer(0, 0.5, 0.0, false, false));
    assert!(fixed.iter().any(|&s| s.abs() > 0.01));
    for (a, b) in automated.iter().zip(&fixed) {
        assert!((a - b).abs() < 1e-6, "{a} is not {b}");
    }
}

#[test]
fn export_matches_playback_sample_for_sample() {
    let points = [
        0.0,
        0.2,
        0.0, //
        BEAT,
        1.5,
        1.0, //
        2.5 * BEAT,
        0.7,
        0.0, //
        4.0 * BEAT,
        0.0,
        0.0,
    ];
    let pan = [0.0, 1.0, 0.0, 3.0 * BEAT, -0.5, 1.0];
    let master = [BEAT / 2.0, 1.0, 0.0, 3.5 * BEAT, 0.3, 0.0];
    let build = || {
        let mut engine = engine();
        engine.set_automation(0, "volume", &points);
        engine.set_automation(0, "pan", &pan);
        engine.set_automation(MASTER, "volume", &master);
        engine
    };
    let frames = 4 * FRAMES_PER_BEAT;
    let mut engine = build();
    engine.play();
    let mut played = Vec::new();
    while played.len() < frames * 2 {
        engine.render(441);
        for (l, r) in engine.left()[..441].iter().zip(&engine.right()[..441]) {
            played.extend([*l, *r]);
        }
    }
    played.truncate(frames * 2);
    let exported = build().render_range(0.0, 4.0 * BEAT);
    assert!(exported[..frames * 2] == played[..], "sample for sample");
}

#[test]
fn a_native_host_swaps_automation_in_and_gets_the_old_back() {
    let mut engine = engine();
    let first = PreparedAutomation::new("volume", &[0.0, 0.5, 0.0]).unwrap();
    engine.swap_automation(0, first);
    let second = PreparedAutomation::new("volume", &[0.0, 0.25, 0.0]).unwrap();
    let old = engine.swap_automation(0, second);
    assert_eq!(
        old.automation,
        Automation::from_flat(&[0.0, 0.5, 0.0], Automatable::Volume)
    );
    assert!(PreparedAutomation::new("mute", &[]).is_none());

    // No such Track: it comes straight back.
    let stray = PreparedAutomation::new("pan", &[0.0, 1.0, 0.0]).unwrap();
    let back = engine.swap_automation(7, stray);
    assert_eq!(
        back.automation,
        Automation::from_flat(&[0.0, 1.0, 0.0], Automatable::Pan)
    );
}

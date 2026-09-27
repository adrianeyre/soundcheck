//! Input Monitoring end to end, without a sound device: an input callback
//! feeding the recorder and the monitor ring buffer, and the output
//! callback playing the armed Track through its Effects. The musician hears
//! the Effects; the take is the dry input.

use soundcheck_desktop::command::EngineCommand;
use soundcheck_desktop::host;
use soundcheck_desktop::monitor::{MonitorFeed, monitor};
use soundcheck_desktop::recorder::{Tap, recorder};
use soundcheck_engine::{Engine, PlacedRecording};

const RATE: u32 = 48_000;
const BLOCK: usize = 128;
const CALLBACKS: usize = 200;
const START: f64 = 5.0;

/// Input block `block`, interleaved stereo: a different sound on each side.
fn input(block: usize) -> Vec<f32> {
    (0..BLOCK)
        .flat_map(|i| {
            let t = (block * BLOCK + i) as f32 / RATE as f32;
            let left = 0.5 * (t * 440.0 * std::f32::consts::TAU).sin();
            [left, 0.25 * (t * 660.0 * std::f32::consts::TAU).sin()]
        })
        .collect()
}

fn sides(interleaved: &[f32]) -> (Vec<f32>, Vec<f32>) {
    (
        interleaved.iter().step_by(2).copied().collect(),
        interleaved.iter().skip(1).step_by(2).copied().collect(),
    )
}

/// One Audio Track with a Reverb, its Input Monitoring `on`, recording and
/// monitoring from an input in step with the output, block for block.
/// Returns what was played, interleaved, and the take.
fn record(on: bool) -> (Vec<f32>, PlacedRecording) {
    let (mut controller, mut renderer, _midi) = host::host(RATE as f32, 0);
    let clock = std::sync::Arc::clone(renderer.playback_clock());
    let (recorder, mut writer) = recorder(RATE, &[Tap::FirstTwo]);
    let (to_output, from_input) = monitor(1);
    writer.set_monitor(to_output);
    for command in [
        EngineCommand::SetTrackCount { count: 1 },
        EngineCommand::SetTrackAudio {
            track: 0,
            audio: true,
        },
        EngineCommand::InsertEffect {
            chain: 0,
            index: 0,
            effect: "reverb".into(),
        },
        EngineCommand::SetTrackMonitoring { track: 0, on },
        EngineCommand::Play,
    ] {
        controller.send(command);
    }
    controller.set_monitor(Some(MonitorFeed::new(from_input, vec![0])));
    recorder.start(&clock);

    let mut played = Vec::new();
    let mut buffer = vec![0.0; BLOCK * 2];
    for block in 0..CALLBACKS {
        let at = START + (block * BLOCK) as f64 / f64::from(RATE);
        writer.write(&input(block), 2, at, |s| s);
        recorder.collect();
        renderer.set_played_at(at);
        renderer.process(&mut buffer, 2);
        played.extend_from_slice(&buffer);
    }
    let take = recorder.stop(&clock, 0.0).unwrap().remove(0);
    (played, take)
}

#[test]
fn a_monitored_track_is_heard_through_its_effects_one_callback_behind_the_input() {
    let (played, _) = record(true);
    // The same Track on an engine handed each input block directly, one
    // callback later: the ring buffer's delay, at its target of one input
    // and one output callback, is exactly that.
    let mut engine = Engine::new(RATE as f32);
    engine.set_track_count(1);
    engine.set_track_audio(0, true);
    assert!(engine.insert_effect(0, 0, "reverb"));
    engine.set_track_monitoring(0, true);
    engine.play();
    let mut expected = Vec::new();
    for callback in 0..CALLBACKS {
        if callback > 0 {
            let (left, right) = sides(&input(callback - 1));
            engine.set_track_input(0, &left, &right);
        }
        engine.render(BLOCK);
        for (l, r) in engine.left()[..BLOCK].iter().zip(&engine.right()[..BLOCK]) {
            expected.extend([*l, *r]);
        }
    }
    assert_eq!(played, expected);
    assert!(played.iter().any(|s| s.abs() > 0.01), "the input was heard");

    // And it is the Reverb's sound, not the dry input's.
    let dry: Vec<f32> = (0..CALLBACKS - 1).flat_map(input).collect();
    let wet = &played[BLOCK * 2..];
    // One Track alone reaches the Master at half its level.
    let difference = wet
        .iter()
        .zip(&dry)
        .map(|(w, d)| (w - d * 0.5).abs())
        .fold(0.0, f32::max);
    assert!(difference > 0.01, "the Reverb changed what was heard");
}

#[test]
fn with_monitoring_off_the_input_is_not_heard() {
    let (played, take) = record(false);
    assert!(played.iter().all(|&s| s == 0.0));
    assert!(!take.samples.is_empty(), "it still records");
}

#[test]
fn the_take_is_the_dry_input_whether_or_not_it_is_monitored() {
    let dry: Vec<f32> = (0..CALLBACKS).flat_map(input).collect();
    for on in [true, false] {
        let (_, take) = record(on);
        assert_eq!(take.start_tick, 0);
        assert!(take.samples.len() > dry.len() / 2);
        // A stretch of the input, sample for sample: no Effect in it.
        let start = dry
            .windows(take.samples.len())
            .position(|window| window == take.samples.as_slice());
        assert!(start.is_some(), "the take is exactly the dry input");
    }
}

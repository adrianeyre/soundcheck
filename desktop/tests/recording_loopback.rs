//! A loopback cable, simulated: the metronome plays out of the Renderer,
//! comes back in through the input `CaptureWriter` after the latencies a
//! driver would report (and some it wouldn't), and the recorded take is
//! placed on the timeline. Its clicks must land on the beats the engine
//! played them on. No audio device is involved; the timings are made up,
//! and deliberately untidy: the two streams start at different moments and
//! run different buffer sizes, and each callback is timed a little late.

use soundcheck_desktop::command::EngineCommand;
use soundcheck_desktop::host;
use soundcheck_desktop::recorder::{Tap, recorder};
use soundcheck_engine::{PlacedRecording, TICKS_PER_BEAT};

const RATE: u32 = 48_000;
const TEMPO: f64 = 120.0;
const TICKS_PER_SECOND: f64 = TEMPO / 60.0 * TICKS_PER_BEAT as f64;

/// WASAPI shared mode's period.
const OUTPUT_BLOCK: usize = 480;
const INPUT_BLOCK: usize = 256;
/// When the output's first frame is heard, in host seconds.
const OUTPUT_START: f64 = 5.0;
/// When the input's first frame is captured: before the song plays, since
/// Record opens the take and then starts the transport. Not on a frame of
/// the output.
const INPUT_START: f64 = 4.9 + 0.37 / RATE as f64;
const SECONDS: f64 = 3.0;

/// A small, repeatable wobble in when each callback is timed, up to 0.3 ms:
/// the moment a callback reads the clock is never exactly when it was due.
fn jitter(block: usize) -> f64 {
    ((block * 7_919) % 13) as f64 / 12.0 * 0.000_3
}

/// Where each click starts, in frames: the first sample above the noise
/// after a stretch of quiet.
fn onsets(samples: &[f32]) -> Vec<usize> {
    let mut found = Vec::new();
    let mut quiet = usize::MAX / 2;
    for (frame, sample) in samples.iter().enumerate() {
        if sample.abs() > 0.05 {
            if quiet > RATE as usize / 10 {
                found.push(frame);
            }
            quiet = 0;
        } else {
            quiet += 1;
        }
    }
    found
}

/// Record the metronome through a loopback whose driver reports
/// `output_latency` and `input_latency` but also delays the sound by
/// `unreported` more, then place the take with the musician's `offset`.
/// Returns the take and the metronome as the engine played it (left channel).
fn record_loopback(unreported: f64, offset: f64) -> (PlacedRecording, Vec<f32>) {
    let (mut controller, mut renderer, _midi) = host::host(RATE as f32, 0);
    let clock = std::sync::Arc::clone(renderer.playback_clock());
    let (recorder, mut writer) = recorder(RATE, &[Tap::FirstTwo]);
    controller.send(EngineCommand::SetTempo { bpm: TEMPO });
    controller.send(EngineCommand::SetMetronome { on: true });

    // Record: the take opens, then the transport plays.
    recorder.start(&clock);
    controller.send(EngineCommand::Play);

    // The output: each callback is told when its first frame will be heard,
    // from the output latency the driver reports (so it cancels out here),
    // a little off because the callback read the clock late.
    let frames = (SECONDS * f64::from(RATE)) as usize;
    let mut played = Vec::with_capacity(frames);
    let mut buffer = vec![0.0; OUTPUT_BLOCK * 2];
    let mut block = 0;
    while played.len() < frames {
        let heard = OUTPUT_START + (block * OUTPUT_BLOCK) as f64 / f64::from(RATE);
        renderer.set_played_at(heard + jitter(block));
        renderer.process(&mut buffer, 2);
        played.extend(buffer.iter().step_by(2));
        block += 1;
    }

    // The cable: what reaches the input at `t` is what was heard at
    // `t - unreported`, nearest frame.
    let at = |seconds: f64| -> f32 {
        let frame = ((seconds - unreported - OUTPUT_START) * f64::from(RATE)).round();
        if frame < 0.0 {
            return 0.0;
        }
        played.get(frame as usize).copied().unwrap_or(0.0)
    };

    // The input, in mono: each callback says when its first frame was
    // captured, from the input latency the driver reports.
    let input_frames = ((SECONDS - 0.2) * f64::from(RATE)) as usize;
    let mut data = vec![0.0_f32; INPUT_BLOCK];
    for block in 0..input_frames / INPUT_BLOCK {
        let captured = INPUT_START + (block * INPUT_BLOCK) as f64 / f64::from(RATE);
        for (i, sample) in data.iter_mut().enumerate() {
            *sample = at(captured + i as f64 / f64::from(RATE));
        }
        writer.write(&data, 1, captured + jitter(block), |s| s);
        recorder.collect();
    }

    let take = recorder.stop(&clock, offset).unwrap().remove(0);
    (take, played)
}

/// How far each recorded click is from where it was played, in ms.
fn errors_ms(take: &PlacedRecording, played: &[f32]) -> Vec<f64> {
    let left: Vec<f32> = take.samples.iter().step_by(2).copied().collect();
    let recorded = onsets(&left);
    let expected = onsets(played);
    assert!(
        recorded.len() >= 4,
        "only {} clicks recorded",
        recorded.len()
    );
    recorded
        .iter()
        .zip(&expected)
        .map(|(recorded, expected)| {
            // Output frame 0 is tick 0, where the transport started.
            let played_tick = *expected as f64 / f64::from(RATE) * TICKS_PER_SECOND;
            let recorded_tick =
                take.start_tick as f64 + *recorded as f64 / f64::from(RATE) * TICKS_PER_SECOND;
            (recorded_tick - played_tick) / TICKS_PER_SECOND * 1_000.0
        })
        .collect()
}

#[test]
fn a_take_recorded_through_a_loopback_lands_on_the_beats_that_were_played() {
    // The driver reports every latency there is.
    let (take, played) = record_loopback(0.0, 0.0);
    // Recorded before the song started: the take starts with it, at tick 0.
    assert_eq!(take.start_tick, 0);
    for error in errors_ms(&take, &played) {
        assert!(error.abs() < 0.5, "a click landed {error:.3} ms off");
    }
}

#[test]
fn the_offset_takes_out_latency_the_driver_does_not_report() {
    // 4 ms the driver doesn't know about: converters, say.
    let (late, played) = record_loopback(0.004, 0.0);
    for error in errors_ms(&late, &played) {
        assert!(
            (error - 4.0).abs() < 0.5,
            "a click landed {error:.3} ms off"
        );
    }

    // Measured once with a loopback and entered as the offset, it's gone.
    let (take, played) = record_loopback(0.004, 0.004);
    for error in errors_ms(&take, &played) {
        assert!(error.abs() < 0.5, "a click landed {error:.3} ms off");
    }
}

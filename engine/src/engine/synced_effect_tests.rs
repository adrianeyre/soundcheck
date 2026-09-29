//! Effects synced to the song in the engine's Insert Chains, lining up with
//! its beats wherever playback starts.

use super::tests::left_of;
use super::*;
use crate::dsp::measure::rms;
use crate::transport::TICKS_PER_BEAT;

const RATE: f32 = 48_000.0;
const BEAT: f64 = TICKS_PER_BEAT as f64;
const MASTER: i32 = -1;

/// Note value (1/4), depth, release, curve, phase, mix: a Pump that falls to
/// silence on every beat.
const FULL_PUMP: [f32; 6] = [2.0, 1.0, 0.6, 0.4, 0.0, 1.0];

#[test]
fn a_pump_dips_on_the_songs_beats_wherever_playback_starts() {
    // Half a beat in, a long note under a Pump on the master: the next beat
    // is 12,000 frames on at 120, and that is where it falls silent.
    let mut engine = Engine::new(RATE);
    engine.set_tempo(120.0);
    engine.set_track_count(1);
    engine.set_track_notes(0, &[BEAT / 2.0, 4.0 * BEAT, 60.0, 1.0]);
    assert!(engine.insert_effect(MASTER, 0, "pump"));
    engine.set_effect_settings(MASTER, 0, &FULL_PUMP);
    let left = left_of(&engine.render_range(BEAT / 2.0, 3.0 * BEAT));
    let level = |at: usize| rms(&left[at..at + 240]);
    let quietest = (6_000..18_000)
        .step_by(60)
        .min_by(|&a, &b| level(a).total_cmp(&level(b)))
        .unwrap();
    assert!((11_900..12_400).contains(&quietest), "{quietest}");
    assert!(level(quietest) < 0.05 * level(9_000), "{}", level(quietest));
    // And a beat later too.
    assert!(level(quietest + 24_000) < 0.05 * level(33_000));
}

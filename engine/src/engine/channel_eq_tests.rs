//! The channel EQ of a Track, a Bus and the Master, rendered into buffers.

use super::tests::left_of;
use super::*;
use crate::audio_file::tests::stereo_wav;
use crate::dsp::measure::{rms, sine};
use crate::transport::TICKS_PER_BEAT;

const RATE: f32 = 48_000.0;
const BEAT: f64 = TICKS_PER_BEAT as f64;
/// At 120 bpm a beat is half a second.
const FRAMES_PER_BEAT: usize = 24_000;
const MASTER: i32 = -1;

/// One Audio Track playing a sine at `frequency` for four beats.
fn playing(frequency: f32) -> Engine {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_audio(0, true);
    let tone = sine(frequency, 0.25, RATE, 4 * FRAMES_PER_BEAT);
    assert_eq!(
        engine.load_audio_file(1, &stereo_wav(&tone, &tone, RATE as u32)),
        None
    );
    engine.set_track_audio_clips(0, &[0.0, 2.0, 1.0, 0.0]);
    engine
}

fn render(engine: &mut Engine) -> Vec<f32> {
    left_of(&engine.render_range(0.0, 4.0 * BEAT))
}

/// How much louder the second half of `render` is than `dry`'s, in dB.
fn change_db(eqd: &[f32], dry: &[f32]) -> f32 {
    let half = eqd.len() / 2;
    let end = 3 * FRAMES_PER_BEAT;
    20.0 * (rms(&eqd[half..end]) / rms(&dry[half..end])).log10()
}

#[test]
fn a_flat_eq_on_every_channel_changes_not_one_sample() {
    let dry = {
        let mut engine = playing(440.0);
        engine.set_bus_count(1);
        engine.set_track_output(0, 0);
        render(&mut engine)
    };
    let mut engine = playing(440.0);
    engine.set_bus_count(1);
    engine.set_track_output(0, 0);
    for chain in [0, bus_chain(0), MASTER] {
        engine.set_channel_eq(chain, 3.0, 0.0, 0.0, 0.0);
        engine.set_channel_eq(chain, 0.0, 0.0, 0.0, 0.0);
    }
    assert_eq!(render(&mut engine), dry);
}

#[test]
fn the_eq_of_a_track_a_bus_and_the_master_each_cut_the_lows() {
    let dry = {
        let mut engine = playing(60.0);
        engine.set_bus_count(1);
        engine.set_track_output(0, 0);
        render(&mut engine)
    };
    for chain in [0, bus_chain(0), MASTER] {
        let mut engine = playing(60.0);
        engine.set_bus_count(1);
        engine.set_track_output(0, 0);
        engine.set_channel_eq(chain, -12.0, 0.0, 0.0, 0.0);
        assert_eq!(engine.channel_eq(chain), vec![-12.0, 0.0, 0.0, 0.0]);
        let db = change_db(&render(&mut engine), &dry);
        assert!((db + 12.0).abs() < 2.5, "chain {chain}: {db} dB");
    }
}

#[test]
fn the_high_band_boosts_the_highs_and_leaves_the_lows() {
    let highs = render(&mut playing(12_000.0));
    let mut engine = playing(12_000.0);
    engine.set_channel_eq(0, 0.0, 0.0, 0.0, 6.0);
    let db = change_db(&render(&mut engine), &highs);
    assert!((db - 6.0).abs() < 1.0, "{db} dB");

    let lows = render(&mut playing(60.0));
    let mut engine = playing(60.0);
    engine.set_channel_eq(0, 0.0, 0.0, 0.0, 6.0);
    let db = change_db(&render(&mut engine), &lows);
    assert!(db.abs() < 0.5, "{db} dB");
}

#[test]
fn eq_bands_follow_their_automation_on_a_track_and_on_the_master() {
    let dry = render(&mut playing(60.0));
    for chain in [0, MASTER] {
        let mut engine = playing(60.0);
        engine.set_automation(chain, "eq:low", &[0.0, -12.0, 0.0]);
        let db = change_db(&render(&mut engine), &dry);
        assert!((db + 12.0).abs() < 2.5, "chain {chain}: {db} dB");
        assert_eq!(
            engine.channel_eq(chain),
            vec![0.0; 4],
            "its fixed value stays"
        );
    }
}

#[test]
fn channels_that_do_not_exist_are_ignored() {
    let mut engine = playing(60.0);
    engine.set_channel_eq(5, 3.0, 3.0, 3.0, 3.0);
    engine.set_channel_eq(bus_chain(3), 3.0, 3.0, 3.0, 3.0);
    assert!(engine.channel_eq(5).is_empty());
    engine.set_channel_eq(MASTER, 40.0, f32::NAN, -40.0, 1.0);
    assert_eq!(engine.channel_eq(MASTER), vec![12.0, 0.0, -12.0, 1.0]);
}

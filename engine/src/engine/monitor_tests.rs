//! Input Monitoring: an Audio Track playing a live input block through its
//! Insert Chain and the rest of the mix, as the host hands it in.

use super::*;
use crate::plugin::tests::{FakeInstance, MANIFEST};

const RATE: f32 = 48_000.0;
const BLOCK: usize = 128;
/// What one Track alone reaches the Master at.
const ONE_TRACK: f32 = TRACKS_GAIN;

/// An engine with one Audio Track whose Insert Chain is a gain Plugin set
/// to `gain`.
fn with_gain(gain: f32) -> Engine {
    let mut engine = Engine::new(RATE);
    engine.prepare(BLOCK);
    engine.set_track_count(1);
    engine.set_track_audio(0, true);
    let manifest = Arc::new(PluginManifest::parse(MANIFEST).unwrap());
    let plugin = PreparedEffect::plugin(manifest, Box::<FakeInstance>::default());
    assert!(engine.insert_prepared_effect(0, 0, plugin).is_ok());
    engine.set_effect_settings(0, 0, &[gain, 2.0]);
    engine
}

/// A block of input that is different on every frame and on each side.
fn input(block: usize) -> (Vec<f32>, Vec<f32>) {
    let left: Vec<f32> = (0..BLOCK)
        .map(|i| 0.1 + (block * BLOCK + i) as f32 / 10_000.0)
        .collect();
    let right = left.iter().map(|s| -s / 2.0).collect();
    (left, right)
}

fn assert_close(actual: &[f32], expected: &[f32]) {
    assert_eq!(actual.len(), expected.len());
    for (frame, (a, e)) in actual.iter().zip(expected).enumerate() {
        assert!((a - e).abs() < 1e-6, "frame {frame}: {a} != {e}");
    }
}

#[test]
fn a_monitored_track_plays_its_live_input_through_its_effects() {
    let mut engine = with_gain(0.25);
    engine.set_track_monitoring(0, true);
    for block in 0..3 {
        let (left, right) = input(block);
        engine.set_track_input(0, &left, &right);
        engine.render(BLOCK);
        let gained = |side: &[f32]| {
            side.iter()
                .map(|s| s * 0.25 * ONE_TRACK)
                .collect::<Vec<_>>()
        };
        assert_close(&engine.left()[..BLOCK], &gained(&left));
        assert_close(&engine.right()[..BLOCK], &gained(&right));
    }
    // It is on the Track's meter, as anything it plays is.
    assert!((engine.track_peak(0) - 0.25 * ONE_TRACK * input(2).0[BLOCK - 1]).abs() < 1e-3);
}

#[test]
fn with_monitoring_off_the_input_is_not_heard() {
    let mut engine = with_gain(1.0);
    let (left, right) = input(0);
    engine.set_track_input(0, &left, &right);
    engine.render(BLOCK);
    assert!(engine.left()[..BLOCK].iter().all(|&s| s == 0.0));
    assert!(engine.right()[..BLOCK].iter().all(|&s| s == 0.0));
    assert_eq!(engine.track_peak(0), 0.0);

    // And turning it off again silences it.
    engine.set_track_monitoring(0, true);
    engine.set_track_input(0, &left, &right);
    engine.render(BLOCK);
    assert!(engine.left()[..BLOCK].iter().any(|&s| s != 0.0));
    engine.set_track_monitoring(0, false);
    engine.set_track_input(0, &left, &right);
    engine.render(BLOCK);
    assert!(engine.left()[..BLOCK].iter().all(|&s| s == 0.0));
}

#[test]
fn an_input_is_played_once_and_a_block_without_one_is_silent() {
    let mut engine = with_gain(1.0);
    engine.set_track_monitoring(0, true);
    // Shorter than the block: the rest of it is silent.
    let (left, right) = input(0);
    engine.set_track_input(0, &left[..BLOCK / 2], &right[..BLOCK / 2]);
    engine.render(BLOCK);
    assert!((engine.left()[BLOCK / 2 - 1] - left[BLOCK / 2 - 1] * ONE_TRACK).abs() < 1e-6);
    assert!(engine.left()[BLOCK / 2..BLOCK].iter().all(|&s| s == 0.0));
    // Nothing handed in for this block: silence, not the last one again.
    engine.render(BLOCK);
    assert!(engine.left()[..BLOCK].iter().all(|&s| s == 0.0));
}

#[test]
fn a_block_split_by_a_note_plays_the_input_straight_through() {
    // An Instrument Track's note splits the block into segments; the
    // monitored input carries on across the split without skipping.
    let mut engine = with_gain(1.0);
    engine.set_track_count(2);
    engine.set_track_notes(1, &[1.0, 1.0, 60.0, 1.0]);
    engine.set_track_mixer(1, 1.0, 0.0, true, false);
    engine.set_track_monitoring(0, true);
    engine.play();
    let gain = TRACKS_GAIN / 2f32.sqrt();
    for block in 0..4 {
        let (left, right) = input(block);
        engine.set_track_input(0, &left, &right);
        engine.render(BLOCK);
        let expected: Vec<f32> = left.iter().map(|s| s * gain).collect();
        assert_close(&engine.left()[..BLOCK], &expected);
    }
}

#[test]
fn a_monitored_input_plays_alongside_the_track_s_clips_and_through_its_sends() {
    let mut engine = with_gain(1.0);
    engine.set_bus_count(1);
    engine.set_track_monitoring(0, true);
    // Routed to the Bus rather than the Master: it arrives all the same.
    assert!(engine.set_track_output(0, 0));
    let (left, right) = input(0);
    engine.set_track_input(0, &left, &right);
    engine.render(BLOCK);
    assert!((engine.left()[10] - left[10] * ONE_TRACK).abs() < 1e-6);
    assert!(engine.bus_peak(0) > 0.0);
}

#[test]
fn an_offline_render_never_has_the_monitored_input_in_it() {
    let mut engine = with_gain(1.0);
    engine.set_track_monitoring(0, true);
    let (left, right) = input(0);
    engine.set_track_input(0, &left, &right);
    let rendered = engine.render_range(0.0, 480.0);
    assert!(!rendered.is_empty());
    assert!(rendered.iter().all(|&s| s == 0.0));
    // Handed in during the render, it is refused too.
    engine.start_render(0.0, 480.0, 0.0);
    engine.set_track_input(0, &left, &right);
    assert!(engine.render_next(BLOCK).iter().all(|&s| s == 0.0));
}

#[test]
fn an_instrument_track_does_not_monitor() {
    let mut engine = with_gain(1.0);
    engine.set_track_audio(0, false);
    engine.set_track_monitoring(0, true);
    let (left, right) = input(0);
    engine.set_track_input(0, &left, &right);
    engine.render(BLOCK);
    assert!(engine.left()[..BLOCK].iter().all(|&s| s == 0.0));
}

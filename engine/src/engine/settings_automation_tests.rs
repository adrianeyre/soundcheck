//! Automation of Send levels, Bus faders and every numeric Effect, Synth
//! and Drum Sampler pad setting, rendered into buffers: in real time a block at a time,
//! and offline for export.

use super::*;
use crate::audio_file::tests::stereo_wav;
use crate::dsp::measure::{peak, rms};
use crate::effect::EQ_PARAMS;
use crate::transport::TICKS_PER_BEAT;

const RATE: f32 = 48_000.0;
const BEAT: f64 = TICKS_PER_BEAT as f64;
/// At 120 bpm a beat is half a second.
const FRAMES_PER_BEAT: usize = 24_000;
const MASTER: i32 = -1;
/// The level of the file the Audio Track plays, before any gain.
const LEVEL: f32 = 0.5;

/// One Audio Track playing a steady level on both sides for eight beats, so
/// every sample it renders is that level times its gains.
pub(super) fn engine() -> Engine {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_audio(0, true);
    let steady = vec![LEVEL; 8 * FRAMES_PER_BEAT];
    assert_eq!(
        engine.load_audio_file(1, &stereo_wav(&steady, &steady, RATE as u32)),
        None
    );
    engine.set_track_audio_clips(0, &[0.0, 8.0, 1.0, 0.0]);
    engine
}

/// The Track reaching the Master only through a Send to Bus 1, at unity:
/// its own Output is Bus 0, with the fader down.
fn through_a_send() -> Engine {
    let mut engine = engine();
    engine.set_bus_count(2);
    engine.set_bus_mixer(0, 0.0, 0.0, false, false);
    assert!(engine.set_track_output(0, 0));
    assert!(engine.set_sends(0, &[1.0, 1.0]));
    engine
}

/// Play from the top in blocks of `block`, for `frames` of the left side,
/// each sample divided by what the Track reaches the Master at unity.
pub(super) fn play(engine: &mut Engine, block: usize, frames: usize) -> Vec<f32> {
    let unity = LEVEL * TRACKS_GAIN;
    let mut left = Vec::new();
    engine.play();
    while left.len() < frames {
        engine.render(block);
        left.extend(engine.left()[..block].iter().map(|s| s / unity));
    }
    left.truncate(frames);
    left
}

/// Play from the top in blocks of `block`, interleaved, as an export is.
fn play_interleaved(engine: &mut Engine, block: usize, frames: usize) -> Vec<f32> {
    let mut played = Vec::new();
    engine.play();
    while played.len() < frames * 2 {
        engine.render(block);
        for (l, r) in engine.left()[..block].iter().zip(&engine.right()[..block]) {
            played.extend([*l, *r]);
        }
    }
    played.truncate(frames * 2);
    played
}

fn assert_near(actual: f32, expected: f32, what: &str) {
    assert!(
        (actual - expected).abs() < 1e-3,
        "{what}: {actual} is not {expected}"
    );
}

/// A ramp from 0 at beat 1 to 1 at beat 3.
fn ramp_expected(frame: usize) -> f32 {
    match frame {
        f if f < FRAMES_PER_BEAT => 0.0,
        f if f < 3 * FRAMES_PER_BEAT => (f - FRAMES_PER_BEAT) as f32 / (2 * FRAMES_PER_BEAT) as f32,
        _ => 1.0,
    }
}

#[test]
fn a_send_level_follows_its_automation_frame_by_frame() {
    let mut engine = through_a_send();
    engine.set_automation(0, "send:1", &[BEAT, 0.0, 0.0, 3.0 * BEAT, 1.0, 0.0]);
    let left = play(&mut engine, 700, 4 * FRAMES_PER_BEAT);
    for frame in (0..left.len()).step_by(97) {
        assert_near(left[frame], ramp_expected(frame), &format!("at {frame}"));
    }
    assert_eq!(left[FRAMES_PER_BEAT - 1], 0.0);
    assert!(left[FRAMES_PER_BEAT + 1] > 0.0);

    // Taken away, the Send is back at its fixed level.
    engine.stop();
    engine.seek(0.0);
    engine.set_automation(0, "send:1", &[]);
    let left = play(&mut engine, 700, FRAMES_PER_BEAT);
    assert_near(left[100], 1.0, "unautomated");
}

#[test]
fn a_bus_sends_level_and_its_fader_follow_their_automation() {
    let mut engine = through_a_send();
    engine.set_automation(bus_chain(1), "volume", &[0.0, 0.5, 1.0]);
    let left = play(&mut engine, 512, FRAMES_PER_BEAT);
    assert_near(left[1_000], 0.5, "the Bus fader automated");

    let mut engine = through_a_send();
    engine.set_bus_count(3);
    assert!(engine.set_sends(bus_chain(1), &[2.0, 1.0]));
    // Bus 1 feeds the Master and Bus 2; Bus 2's Send is ramped in.
    engine.set_automation(
        bus_chain(1),
        "send:2",
        &[BEAT, 0.0, 0.0, 3.0 * BEAT, 1.0, 0.0],
    );
    let left = play(&mut engine, 700, 4 * FRAMES_PER_BEAT);
    for frame in (0..left.len()).step_by(211) {
        let expected = 1.0 + ramp_expected(frame);
        assert_near(left[frame], expected, &format!("at {frame}"));
    }
}

#[test]
fn an_eq_gain_follows_its_automation() {
    let mut engine = engine();
    assert!(engine.insert_effect(0, 0, "eq"));
    // A steady level is all low shelf: at 0 dB for two beats, then a step
    // down to -12 dB.
    engine.set_automation(
        0,
        "effect:0:lowShelfGainDb",
        &[0.0, 0.0, 1.0, 2.0 * BEAT, -12.0, 0.0],
    );
    let left = play(&mut engine, 700, 4 * FRAMES_PER_BEAT);
    assert_near(left[FRAMES_PER_BEAT + 100], 1.0, "before the step");
    let quarter = 10.0_f32.powf(-12.0 / 20.0);
    assert!(
        (left[4 * FRAMES_PER_BEAT - 1] - quarter).abs() < 0.01,
        "after the step: {}",
        left[4 * FRAMES_PER_BEAT - 1]
    );
    // The host still reads the fixed value.
    let gain = EQ_PARAMS
        .iter()
        .position(|p| p.name == "lowShelfGainDb")
        .unwrap();
    assert_eq!(engine.effect_settings(0, 0)[gain], 0.0);
}

#[test]
fn an_effect_takes_its_automation_when_it_moves_and_when_it_goes() {
    let mut engine = engine();
    assert!(engine.insert_effect(0, 0, "eq"));
    assert!(engine.insert_effect(0, 1, "eq"));
    engine.set_automation(0, "effect:0:lowShelfGainDb", &[0.0, -12.0, 0.0]);
    engine.move_effect(0, 0, 1);
    let quarter = 10.0_f32.powf(-12.0 / 20.0);
    let left = play(&mut engine, 512, FRAMES_PER_BEAT);
    assert!((left[FRAMES_PER_BEAT - 1] - quarter).abs() < 0.01, "moved");

    // Gone, and a new EQ in its place is not automated.
    engine.stop();
    engine.seek(0.0);
    engine.remove_effect(0, 1);
    assert!(engine.insert_effect(0, 1, "eq"));
    let left = play(&mut engine, 512, FRAMES_PER_BEAT);
    assert!((left[FRAMES_PER_BEAT - 1] - 1.0).abs() < 0.01, "removed");
    assert_eq!(
        engine.tracks[0].next_breakpoint(0),
        None,
        "no breakpoints left"
    );
}

#[test]
fn taking_an_effects_automation_away_puts_it_back_at_its_fixed_value() {
    let mut engine = engine();
    assert!(engine.insert_effect(MASTER, 0, "eq"));
    let mut flat = engine.effect_settings(MASTER, 0);
    let gain = EQ_PARAMS
        .iter()
        .position(|p| p.name == "lowShelfGainDb")
        .unwrap();
    flat[gain] = -6.0;
    engine.set_effect_settings(MASTER, 0, &flat);
    engine.set_automation(MASTER, "effect:0:lowShelfGainDb", &[0.0, -12.0, 0.0]);
    let left = play(&mut engine, 512, FRAMES_PER_BEAT);
    let quarter = 10.0_f32.powf(-12.0 / 20.0);
    assert!(
        (left[FRAMES_PER_BEAT - 1] - quarter).abs() < 0.01,
        "automated"
    );
    engine.set_automation(MASTER, "effect:0:lowShelfGainDb", &[]);
    let left = play(&mut engine, 512, FRAMES_PER_BEAT);
    let half = 10.0_f32.powf(-6.0 / 20.0);
    assert!(
        (left[FRAMES_PER_BEAT - 1] - half).abs() < 0.01,
        "fixed again"
    );
}

/// A Synth Track holding one note for eight beats, the default sound but
/// for its cutoff.
fn synth(cutoff: f32) -> Engine {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_notes(0, &[0.0, 8.0 * BEAT, 69.0, 1.0]);
    let settings = SynthSettings {
        cutoff_hz: cutoff,
        ..SynthSettings::default()
    };
    engine.set_track_synth(0, &settings.to_flat());
    engine
}

#[test]
fn a_synth_cutoff_follows_its_automation() {
    // Open for two beats, then a step down to 150 Hz.
    let mut engine = synth(20_000.0);
    engine.set_automation(
        0,
        "instrument:cutoffHz",
        &[0.0, 20_000.0, 1.0, 2.0 * BEAT, 150.0, 0.0],
    );
    let automated = play(&mut engine, 700, 4 * FRAMES_PER_BEAT);
    let open = play(&mut synth(20_000.0), 700, 4 * FRAMES_PER_BEAT);
    let closed = play(&mut synth(150.0), 700, 4 * FRAMES_PER_BEAT);
    let (before, after) = (
        FRAMES_PER_BEAT..2 * FRAMES_PER_BEAT,
        3 * FRAMES_PER_BEAT..4 * FRAMES_PER_BEAT,
    );
    let level = |samples: &[f32]| rms(samples);
    assert!(level(&closed[after.clone()]) < 0.5 * level(&open[after.clone()]));
    let close = |a: f32, b: f32| (a - b).abs() < 0.05 * b;
    assert!(close(
        level(&automated[before.clone()]),
        level(&open[before])
    ));
    assert!(close(
        level(&automated[after.clone()]),
        level(&closed[after])
    ));
    // The host still reads the fixed value.
    assert_eq!(engine.track_synth(0), synth(20_000.0).track_synth(0));
}

/// A Drum Sampler Track hitting the kick (pad 0, note 36) on each of eight
/// beats, its pads at `volume`, `pan` and `pitch`.
fn drums(volume: f32, pan: f32, pitch: f32) -> Engine {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    assert!(engine.set_track_instrument(0, "drumSampler", None));
    let notes: Vec<f64> = (0..8)
        .flat_map(|beat| [f64::from(beat) * BEAT, BEAT / 2.0, 36.0, 1.0])
        .collect();
    engine.set_track_notes(0, &notes);
    engine.set_track_pad(0, 0, 36, volume, pan, pitch, 0);
    engine
}

/// The left and right sides of `frames` played from the top in blocks of
/// `block`.
fn play_sides(engine: &mut Engine, block: usize, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let played = play_interleaved(engine, block, frames);
    (
        played.iter().step_by(2).copied().collect(),
        played.iter().skip(1).step_by(2).copied().collect(),
    )
}

#[test]
fn a_pads_volume_held_by_automation_sounds_as_if_it_were_set_there() {
    let frames = 4 * FRAMES_PER_BEAT;
    let fixed = play_interleaved(&mut drums(0.5, 0.0, 0.0), 512, frames);
    let mut engine = drums(1.0, 0.0, 0.0);
    engine.set_automation(0, "pad:0:volume", &[0.0, 0.5, 0.0]);
    let automated = play_interleaved(&mut engine, 512, frames);
    assert!(peak(&fixed) > 0.05, "the kick sounds");
    assert!(automated == fixed, "sample for sample");

    // Taken away, the pad is back at the volume it was set to.
    engine.stop();
    engine.seek(0.0);
    engine.set_automation(0, "pad:0:volume", &[]);
    let unautomated = play_interleaved(&mut engine, 512, frames);
    let full = play_interleaved(&mut drums(1.0, 0.0, 0.0), 512, frames);
    // Past the few milliseconds the stopped hits take to fade.
    let after = 2 * FRAMES_PER_BEAT;
    assert!(unautomated[after..] == full[after..], "fixed again");
}

#[test]
fn a_pads_volume_steps_on_the_frame_its_breakpoint_is_at_even_mid_hit() {
    // Full for the first beat's hit, then silent from an eighth of a beat
    // in, while that kick still rings.
    let step = FRAMES_PER_BEAT / 8;
    let mut engine = drums(1.0, 0.0, 0.0);
    engine.set_automation(0, "pad:0:volume", &[0.0, 1.0, 1.0, BEAT / 8.0, 0.0, 0.0]);
    let (left, _) = play_sides(&mut engine, 700, 2 * FRAMES_PER_BEAT);
    let (full, _) = play_sides(&mut drums(1.0, 0.0, 0.0), 700, 2 * FRAMES_PER_BEAT);
    assert!(
        peak(&full[step..FRAMES_PER_BEAT]) > 0.01,
        "the kick rings on"
    );
    assert_eq!(left[..step], full[..step], "before the step");
    assert_eq!(peak(&left[step..]), 0.0, "silent from the step on");
}

#[test]
fn a_pads_pan_and_pitch_follow_their_automation() {
    let frames = 4 * FRAMES_PER_BEAT;
    // Hard right from beat 2: the left side goes quiet there.
    let mut panned = drums(1.0, 0.0, 0.0);
    panned.set_automation(0, "pad:0:pan", &[0.0, 0.0, 1.0, 2.0 * BEAT, 1.0, 0.0]);
    let (left, right) = play_sides(&mut panned, 512, frames);
    let (before, after) = (0..2 * FRAMES_PER_BEAT, 2 * FRAMES_PER_BEAT..frames);
    assert!(peak(&left[before.clone()]) > 0.05);
    assert!(peak(&left[after.clone()]) < 1e-6, "hard right");
    assert!(
        peak(&right[after]) > peak(&right[before]),
        "louder on the right"
    );

    let transposed = play_interleaved(&mut drums(1.0, 0.0, 12.0), 512, frames);
    let mut automated = drums(1.0, 0.0, 0.0);
    automated.set_automation(0, "pad:0:pitch", &[0.0, 12.0, 0.0]);
    assert!(play_interleaved(&mut automated, 512, frames) == transposed);
    assert!(transposed != play_interleaved(&mut drums(1.0, 0.0, 0.0), 512, frames));
}

#[test]
fn a_pads_automation_stays_with_the_track_and_only_a_drum_sampler_follows_it() {
    let frames = 2 * FRAMES_PER_BEAT;
    let mut engine = drums(1.0, 0.0, 0.0);
    engine.set_automation(0, "pad:0:volume", &[0.0, 0.0, 0.0]);
    assert_eq!(peak(&play_interleaved(&mut engine, 512, frames)), 0.0);
    // The Synth plays on, unmoved, and a new kit follows it again.
    engine.stop();
    engine.seek(0.0);
    assert!(engine.set_track_instrument(0, "synth", None));
    engine.set_track_notes(0, &[0.0, 2.0 * BEAT, 60.0, 1.0]);
    assert!(peak(&play_interleaved(&mut engine, 512, frames)) > 0.05);
    engine.stop();
    engine.seek(0.0);
    assert!(engine.set_track_instrument(0, "drumSampler", None));
    engine.set_track_notes(0, &[0.0, BEAT, 36.0, 1.0]);
    assert_eq!(peak(&play_interleaved(&mut engine, 512, frames)), 0.0);
}

#[test]
fn only_numbers_can_be_automated() {
    let named = |name| PreparedAutomation::new(name, &[0.0, 1.0, 0.0]).is_some();
    assert!(named("send:3"));
    assert!(named("effect:2:lowShelfGainDb"));
    assert!(named("effect:0:timeMs"));
    assert!(named("instrument:cutoffHz"));
    assert!(!named("effect:0:no such"));
    assert!(!named("instrument:no such"));
    assert!(!named("send:left"));
    assert!(named("pad:31:pitch"));
    assert!(!named("pad:0:note"));
    assert!(!named("pad:0:chokeGroup"));
    assert!(!named("pad:32:volume"));

    // An Effect's settings are checked by the Effect in the slot, since a
    // Plugin declares its own.
    let mut engine = engine();
    assert!(engine.insert_effect(MASTER, 0, "eq"));
    assert!(engine.insert_effect(MASTER, 1, "delay"));
    for (setting, why) in [
        ("effect:0:lowCut", "a switch"),
        ("effect:1:note", "a choice"),
        ("effect:0:nothing", "not a setting"),
        ("effect:2:mix", "no Effect there"),
    ] {
        let prepared = PreparedAutomation::new(setting, &[0.0, 1.0, 0.0]).unwrap();
        let back = engine.swap_automation(MASTER, prepared);
        assert!(!back.automation.is_empty(), "{setting}: {why}");
    }
    assert!(engine.take_effect(MASTER, 1).is_some());
    assert!(engine.take_effect(MASTER, 0).is_some());

    // The Master has no Sends or Instrument, and a Bus no Instrument.
    engine.set_bus_count(1);
    for (target, setting) in [
        (MASTER, "send:0"),
        (MASTER, "instrument:cutoffHz"),
        (MASTER, "pan"),
        (bus_chain(0), "instrument:cutoffHz"),
        (MASTER, "pad:0:volume"),
        (bus_chain(0), "pad:0:volume"),
        (0, "effect:0:mix"),
        // The Instrument checks its own, since a Plugin declares its own.
        (0, "instrument:osc1Wave"),
        (0, "instrument:nothing"),
    ] {
        let prepared = PreparedAutomation::new(setting, &[0.0, 1.0, 0.0]).unwrap();
        let back = engine.swap_automation(target, prepared);
        assert!(!back.automation.is_empty(), "{setting} on {target} refused");
    }
}

#[test]
fn export_matches_playback_sample_for_sample() {
    let build = || {
        let mut engine = through_a_send();
        engine.set_track_notes(0, &[0.0, 8.0 * BEAT, 57.0, 1.0]);
        assert!(engine.insert_effect(bus_chain(1), 0, "eq"));
        assert!(engine.insert_effect(MASTER, 0, "delay"));
        engine.set_automation(0, "send:1", &[0.0, 0.2, 0.0, 2.5 * BEAT, 1.5, 0.0]);
        engine.set_automation(
            bus_chain(1),
            "effect:0:lowShelfGainDb",
            &[BEAT, 6.0, 0.0, 3.0 * BEAT, -9.0, 1.0, 3.5 * BEAT, 0.0, 0.0],
        );
        engine.set_automation(bus_chain(1), "pan", &[0.0, -1.0, 0.0, 4.0 * BEAT, 1.0, 0.0]);
        engine.set_automation(
            MASTER,
            "effect:0:mix",
            &[0.0, 0.0, 0.0, 4.0 * BEAT, 0.8, 0.0],
        );
        engine
    };
    let frames = 4 * FRAMES_PER_BEAT;
    let played = play_interleaved(&mut build(), 441, frames);
    let exported = build().render_range(0.0, 4.0 * BEAT);
    assert!(exported[..frames * 2] == played[..], "sample for sample");

    let build_synth = || {
        let mut engine = synth(2_000.0);
        engine.set_automation(
            0,
            "instrument:cutoffHz",
            &[0.0, 300.0, 0.0, 3.0 * BEAT, 8_000.0, 0.0],
        );
        engine.set_automation(
            0,
            "instrument:resonance",
            &[BEAT, 1.0, 0.0, 2.0 * BEAT, 8.0, 0.0],
        );
        engine
    };
    let played = play_interleaved(&mut build_synth(), 300, frames);
    let exported = build_synth().render_range(0.0, 4.0 * BEAT);
    assert!(
        exported[..frames * 2] == played[..],
        "the Synth, sample for sample"
    );

    let build_drums = || {
        let mut engine = drums(1.0, 0.0, 0.0);
        engine.set_automation(0, "pad:0:volume", &[0.0, 0.2, 0.0, 3.0 * BEAT, 1.5, 0.0]);
        engine.set_automation(0, "pad:0:pan", &[BEAT, -1.0, 0.0, 2.5 * BEAT, 1.0, 1.0]);
        engine.set_automation(0, "pad:0:pitch", &[0.0, -5.0, 0.0, 4.0 * BEAT, 7.0, 0.0]);
        engine
    };
    let played = play_interleaved(&mut build_drums(), 300, frames);
    let exported = build_drums().render_range(0.0, 4.0 * BEAT);
    assert!(peak(&played) > 0.05);
    assert!(
        exported[..frames * 2] == played[..],
        "the Drum Sampler, sample for sample"
    );
}

#[test]
fn a_native_host_swaps_an_effects_automation_in_and_gets_the_old_back() {
    let mut engine = engine();
    assert!(engine.insert_effect(0, 0, "reverb"));
    let first = PreparedAutomation::new("effect:0:mix", &[0.0, 0.5, 0.0]).unwrap();
    assert!(engine.swap_automation(0, first).automation.is_empty());
    let second = PreparedAutomation::new("effect:0:mix", &[0.0, 0.25, 0.0]).unwrap();
    let old = engine.swap_automation(0, second);
    assert_eq!(
        old.automation,
        Automation::from_flat(&[0.0, 0.5, 0.0], old.setting)
    );
}

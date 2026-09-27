//! A Plugin Effect in an Insert Chain, and an Instrument Plugin on a Track, through the engine's Plugin-runtime
//! interface with a runtime in plain Rust (`plugin::tests::FakeRuntime`):
//! its settings, their Automation, and the slot of a Plugin the host
//! doesn't have. The real runtimes are tested where they live, `desktop/`
//! and the UI, against the same test Plugin.

use super::settings_automation_tests::{engine, play};
use super::*;
use crate::plugin::tests::{FakeInstance, FakeInstrument, INSTRUMENT, MANIFEST};

const MASTER: i32 = -1;
const BEAT: f64 = crate::transport::TICKS_PER_BEAT as f64;
const FRAMES_PER_BEAT: usize = 24_000;

fn gain_plugin() -> PreparedEffect {
    let manifest = Arc::new(PluginManifest::parse(MANIFEST).unwrap());
    PreparedEffect::plugin(manifest, Box::<FakeInstance>::default())
}

fn with_plugin_on_the_master() -> Engine {
    let mut engine = engine();
    assert!(
        engine
            .insert_prepared_effect(MASTER, 0, gain_plugin())
            .is_ok()
    );
    engine
}

#[test]
fn a_plugin_effect_starts_at_its_defaults_and_takes_its_settings_as_a_built_in_does() {
    let mut engine = with_plugin_on_the_master();
    assert_eq!(
        engine.chain_effects(MASTER),
        "plugin:dev.soundcheck.test.gain"
    );
    assert_eq!(engine.effect_settings(MASTER, 0), [1.0, 2.0]);
    assert!((play(&mut engine, 128, 256)[200] - 1.0).abs() < 1e-6);

    // Clamped and rounded as its manifest declares.
    engine.set_effect_settings(MASTER, 0, &[0.25, 3.4]);
    assert_eq!(engine.effect_settings(MASTER, 0), [0.25, 3.0]);
    engine.stop();
    engine.seek(0.0);
    assert!((play(&mut engine, 128, 256)[200] - 0.25).abs() < 1e-6);
}

#[test]
fn a_plugin_setting_follows_its_automation_and_goes_back_when_it_is_taken_away() {
    let mut engine = with_plugin_on_the_master();
    engine.set_effect_settings(MASTER, 0, &[0.5, 2.0]);
    // From 0 at the top to 2 after two beats.
    engine.set_automation(
        MASTER,
        "effect:0:gain",
        &[0.0, 0.0, 0.0, 2.0 * BEAT, 2.0, 0.0],
    );
    let left = play(&mut engine, 512, 3 * FRAMES_PER_BEAT);
    assert!(left[0].abs() < 1e-3);
    assert!((left[FRAMES_PER_BEAT] - 1.0).abs() < 1e-3);
    assert!((left[2 * FRAMES_PER_BEAT + 100] - 2.0).abs() < 1e-3);
    // Its fixed value is what the host set, not where the Automation is.
    assert_eq!(engine.effect_settings(MASTER, 0), [0.5, 2.0]);

    engine.set_automation(MASTER, "effect:0:gain", &[]);
    engine.stop();
    engine.seek(0.0);
    assert!((play(&mut engine, 512, 1_024)[500] - 0.5).abs() < 1e-6);
}

#[test]
fn a_setting_the_plugin_does_not_declare_is_not_automated() {
    let mut engine = with_plugin_on_the_master();
    let points = [0.0, 0.0, 0.0];
    let refused = PreparedAutomation::new("effect:0:thresholdDb", &points).unwrap();
    let back = engine.swap_automation(MASTER, refused);
    assert!(!back.automation.is_empty(), "handed back as it came");
}

#[test]
fn a_missing_plugin_holds_its_place_and_passes_audio_through_untouched() {
    let mut dry = engine();
    let mut missing = engine();
    assert!(missing.insert_missing_plugin(MASTER, 0, "dev.soundcheck.test.gain"));
    assert!(missing.insert_effect(MASTER, 1, "eq"));
    assert!(dry.insert_effect(MASTER, 0, "eq"));
    assert_eq!(
        missing.chain_effects(MASTER),
        "missing:dev.soundcheck.test.gain,eq"
    );
    // It has no settings of its own to take or automate: the Project keeps
    // them.
    missing.set_effect_settings(MASTER, 0, &[0.25, 3.0]);
    assert_eq!(missing.effect_settings(MASTER, 0), Vec::<f32>::new());
    missing.set_automation(MASTER, "effect:0:gain", &[0.0, 0.0, 0.0]);
    assert_eq!(play(&mut missing, 128, 4_096), play(&mut dry, 128, 4_096));

    // Once installed, the host puts the real one in its place.
    missing.stop();
    missing.seek(0.0);
    assert!(missing.take_effect(MASTER, 0).is_some());
    assert!(
        missing
            .insert_prepared_effect(MASTER, 0, gain_plugin())
            .is_ok()
    );
    missing.set_effect_settings(MASTER, 0, &[0.25, 3.0]);
    assert!((play(&mut missing, 128, 256)[200] - 0.25).abs() < 1e-6);
}

#[test]
fn a_plugin_that_faults_is_bypassed_from_then_on_and_says_so() {
    let mut engine = with_plugin_on_the_master();
    engine.set_effect_settings(MASTER, 0, &[0.5, 2.0]);
    assert!((play(&mut engine, 128, 256)[200] - 0.5).abs() < 1e-6);
    assert!(!engine.effect_faulted(MASTER, 0));
    // The fake traps at this setting, as a runaway Plugin is stopped.
    engine.set_effect_settings(MASTER, 0, &[0.5, 4.0]);
    engine.stop();
    engine.seek(0.0);
    let left = play(&mut engine, 128, 256);
    assert!(
        left.iter().all(|s| (s - 1.0).abs() < 1e-6),
        "the dry signal, not what it left"
    );
    assert!(engine.effect_faulted(MASTER, 0));
    engine.set_effect_settings(MASTER, 0, &[0.5, 2.0]);
    assert!((play(&mut engine, 128, 256)[200] - 1.0).abs() < 1e-6);
}

fn tone_plugin() -> PreparedInstrument {
    let manifest = Arc::new(PluginManifest::parse(INSTRUMENT).unwrap());
    PreparedInstrument::plugin(manifest, Box::<FakeInstrument>::default())
}

/// One Instrument Track playing a note from the top for two beats, at
/// velocity 1: a Plugin plays it at its level, halved by the mix.
fn playing_a_note() -> Engine {
    let mut engine = Engine::new(48_000.0);
    engine.set_track_count(1);
    engine.set_track_notes(0, &[0.0, 2.0 * BEAT, 60.0, 1.0]);
    engine
}

fn level(engine: &mut Engine, block: usize, frames: usize) -> Vec<f32> {
    let mut left = Vec::new();
    engine.play();
    while left.len() < frames {
        engine.render(block);
        // The mix halves a Track on its own.
        left.extend(engine.left()[..block].iter().map(|s| s * 2.0));
    }
    left.truncate(frames);
    left
}

#[test]
fn an_instrument_plugin_plays_the_notes_and_takes_its_settings() {
    let mut engine = playing_a_note();
    engine.swap_track_instrument(0, tone_plugin());
    assert_eq!(
        engine.track_instrument(0),
        "plugin:dev.soundcheck.test.tone"
    );
    assert_eq!(engine.track_instrument_settings(0), [0.5, 0.0]);
    let left = level(&mut engine, 128, 3 * FRAMES_PER_BEAT);
    assert_eq!(left[100], 0.5);
    // Sample-accurate: the note ends exactly two beats in, mid-block.
    assert_eq!(left[2 * FRAMES_PER_BEAT - 1], 0.5);
    assert_eq!(left[2 * FRAMES_PER_BEAT], 0.0);

    engine.set_track_instrument_settings(0, &[2.0]);
    assert_eq!(engine.track_instrument_settings(0), [1.0, 0.0], "clamped");
    engine.stop();
    engine.seek(0.0);
    assert_eq!(level(&mut engine, 128, 256)[200], 1.0);

    // The Synth's settings aren't its to take.
    engine.set_track_synth(0, &[0.0; 4]);
    assert_eq!(engine.track_instrument_settings(0), [1.0, 0.0]);
    assert!(engine.set_track_instrument(0, "synth", None));
    assert_eq!(engine.track_instrument(0), "synth");
    assert_eq!(engine.track_instrument_settings(0), Vec::<f32>::new());
}

#[test]
fn an_instrument_plugin_setting_follows_its_automation() {
    let mut engine = playing_a_note();
    engine.swap_track_instrument(0, tone_plugin());
    engine.set_track_instrument_settings(0, &[0.25]);
    // From 0 at the top to 1 after one beat.
    engine.set_automation(0, "instrument:level", &[0.0, 0.0, 0.0, BEAT, 1.0, 0.0]);
    let left = level(&mut engine, 512, 2 * FRAMES_PER_BEAT);
    assert!(left[0].abs() < 1e-3);
    assert!((left[FRAMES_PER_BEAT / 2] - 0.5).abs() < 1e-3);
    assert!((left[FRAMES_PER_BEAT + 100] - 1.0).abs() < 1e-6);
    assert_eq!(engine.track_instrument_settings(0), [0.25, 0.0]);

    // A setting it doesn't declare is handed back.
    let refused = PreparedAutomation::new("instrument:cutoffHz", &[0.0, 0.0, 0.0]).unwrap();
    assert!(!engine.swap_automation(0, refused).automation.is_empty());

    engine.set_automation(0, "instrument:level", &[]);
    engine.stop();
    engine.seek(0.0);
    assert_eq!(level(&mut engine, 512, 1_024)[500], 0.25);
}

#[test]
fn a_missing_instrument_plugin_is_silent_until_it_is_installed() {
    let mut engine = playing_a_note();
    assert!(engine.set_track_missing_instrument(0, "dev.soundcheck.test.tone"));
    assert!(!engine.set_track_missing_instrument(1, "dev.soundcheck.test.tone"));
    assert_eq!(
        engine.track_instrument(0),
        "missing:dev.soundcheck.test.tone"
    );
    // It has no settings of its own to take or automate: the Project keeps
    // them.
    engine.set_track_instrument_settings(0, &[0.25]);
    assert_eq!(engine.track_instrument_settings(0), Vec::<f32>::new());
    let refused = PreparedAutomation::new("instrument:level", &[0.0, 0.0, 0.0]).unwrap();
    assert!(!engine.swap_automation(0, refused).automation.is_empty());
    assert!(level(&mut engine, 128, 4_096).iter().all(|s| *s == 0.0));

    // Once installed, the host puts the real one in its place.
    engine.stop();
    engine.seek(0.0);
    engine.swap_track_instrument(0, tone_plugin());
    engine.set_track_instrument_settings(0, &[0.25]);
    assert_eq!(level(&mut engine, 128, 256)[200], 0.25);
}

#[test]
fn an_instrument_plugin_that_faults_is_silent_from_then_on_and_says_so() {
    let mut engine = playing_a_note();
    engine.swap_track_instrument(0, tone_plugin());
    assert_eq!(level(&mut engine, 128, 256)[200], 0.5);
    assert!(!engine.track_instrument_faulted(0));
    engine.set_track_instrument_settings(0, &[0.5, 1.0]);
    let left = level(&mut engine, 128, 256);
    assert!(left.iter().all(|s| *s == 0.0), "silence, not what it left");
    assert!(engine.track_instrument_faulted(0));
}

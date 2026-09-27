//! The Plugin **Instrument** the hosts are tested with: the same module has
//! to play the same Pattern Clip to the same samples through wasmtime
//! **[desktop]** and through the browser's `WebAssembly`, and both are
//! checked against `expected-output.json`.
//!
//! Its DSP only adds, multiplies, divides and compares, which WebAssembly and
//! Rust both round exactly as IEEE 754 says, so this crate's own test can
//! render the expected output natively, through the engine. Each voice keeps
//! its phase and envelope from block to block, so a host that drops a note
//! event, or lands one on the wrong frame, sounds wrong.

use soundcheck_sdk::{Instrument, Manifest, Setting};

pub const ID: &str = "dev.soundcheck.test.instrument";

/// One voice for each MIDI note, summed in pitch order, so the order notes
/// start in on the same frame makes no difference.
const NOTES: usize = 128;

/// A semitone's frequency ratio, applied by multiplying rather than with
/// `powf`, which WebAssembly has no instruction for.
const SEMITONE: f32 = 1.059_463_1;

#[derive(Clone, Copy, Default)]
struct Voice {
    gate: bool,
    /// The envelope, from 0 to 1: it ramps up while the note is held and
    /// back down once it is released.
    level: f32,
    velocity: f32,
    phase: f32,
}

/// A triangle wave for each note, with a straight-line attack and release,
/// odd notes panned one way and even notes the other.
pub struct TestInstrument {
    /// How far each note's phase moves in a frame.
    steps: Vec<f32>,
    voices: Vec<Voice>,
    frames_per_ms: f32,
    level: f32,
    attack_ms: f32,
    release_ms: f32,
    width: f32,
    attack_step: f32,
    release_step: f32,
}

impl TestInstrument {
    fn retime(&mut self) {
        let step = |ms: f32| {
            let frames = ms * self.frames_per_ms;
            if frames > 1.0 { 1.0 / frames } else { 1.0 }
        };
        self.attack_step = step(self.attack_ms);
        self.release_step = step(self.release_ms);
    }
}

impl Instrument for TestInstrument {
    const MANIFEST: Manifest = Manifest {
        id: ID,
        version: "1.0.0",
        name: "Test Instrument",
        settings: &[
            Setting::number("level", "Level", "", 0.0, 1.0, 0.5),
            Setting::number("attack", "Attack", "ms", 0.0, 100.0, 5.0),
            Setting::number("release", "Release", "ms", 0.0, 500.0, 50.0),
            Setting::number("width", "Width", "", 0.0, 1.0, 0.0).stepped(0.25),
        ],
    };

    fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let mut frequencies = [0.0_f32; NOTES];
        frequencies[69] = 440.0;
        for note in 70..NOTES {
            frequencies[note] = frequencies[note - 1] * SEMITONE;
        }
        for note in (0..69).rev() {
            frequencies[note] = frequencies[note + 1] / SEMITONE;
        }
        let mut instrument = Self {
            steps: frequencies.iter().map(|f| f / sample_rate).collect(),
            voices: vec![Voice::default(); NOTES],
            frames_per_ms: sample_rate / 1_000.0,
            level: 0.5,
            attack_ms: 5.0,
            release_ms: 50.0,
            width: 0.0,
            attack_step: 0.0,
            release_step: 0.0,
        };
        instrument.retime();
        instrument
    }

    fn set(&mut self, index: usize, value: f32) {
        match index {
            0 => self.level = value,
            1 => self.attack_ms = value,
            2 => self.release_ms = value,
            3 => self.width = value,
            _ => {}
        }
        self.retime();
    }

    fn note_on(&mut self, note: u8, velocity: f32) {
        let voice = &mut self.voices[note as usize];
        if !voice.gate && voice.level == 0.0 {
            voice.phase = 0.0;
        }
        voice.gate = true;
        voice.velocity = velocity;
    }

    fn note_off(&mut self, note: u8) {
        self.voices[note as usize].gate = false;
    }

    fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let (mut sum_left, mut sum_right) = (0.0, 0.0);
            for (note, voice) in self.voices.iter_mut().enumerate() {
                if !voice.gate && voice.level == 0.0 {
                    continue;
                }
                if voice.gate {
                    voice.level += self.attack_step;
                    if voice.level > 1.0 {
                        voice.level = 1.0;
                    }
                } else {
                    voice.level -= self.release_step;
                    if voice.level < 0.0 {
                        voice.level = 0.0;
                    }
                }
                let triangle = 4.0 * (voice.phase - 0.5).abs() - 1.0;
                voice.phase += self.steps[note];
                if voice.phase >= 1.0 {
                    voice.phase -= 1.0;
                }
                let sample = triangle * voice.level * voice.velocity;
                let pan = if note % 2 == 1 { 0.5 } else { -0.5 } * self.width;
                sum_left += sample * (1.0 - pan);
                sum_right += sample * (1.0 + pan);
            }
            *l += sum_left * self.level;
            *r += sum_right * self.level;
        }
    }

    fn reset(&mut self) {
        self.voices.fill(Voice::default());
    }
}

soundcheck_sdk::export_instrument!(TestInstrument);

/// The render every host is checked against: `expected-output.json` holds
/// the recipe (a Pattern Clip on an Instrument Track, the Instrument's
/// settings, and how far to play) and the samples the engine's Master plays
/// for it, from the top.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use soundcheck_engine::{
        Engine, PluginFault, PluginInstance, PluginManifest, PreparedInstrument,
    };
    use std::sync::Arc;

    const EXPECTED: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/expected-output.json");

    fn recipe() -> Value {
        json!({
            "sampleRate": 48_000,
            "tempo": 120,
            "clip": {
                "start": 0,
                "length": 960,
                "notes": [
                    { "pitch": 60, "start": 0, "length": 30, "velocity": 1 },
                    { "pitch": 64, "start": 20, "length": 40, "velocity": 0.75 },
                    { "pitch": 67, "start": 50, "length": 30, "velocity": 0.5 },
                    { "pitch": 71, "start": 50, "length": 30, "velocity": 0.5 },
                    { "pitch": 60, "start": 90, "length": 20, "velocity": 0.75 },
                ],
            },
            "settings": { "level": 0.75, "attack": 2, "release": 20, "width": 0.5 },
            "ticks": 120,
        })
    }

    /// The Instrument as the SDK's exports run it, natively: its buffers
    /// start silent, and it renders into them.
    struct Native(TestInstrument);

    impl PluginInstance for Native {
        fn set_param(&mut self, index: usize, value: f32) {
            self.0.set(index, value);
        }

        fn process(&mut self, left: &mut [f32], right: &mut [f32]) -> Result<(), PluginFault> {
            left.fill(0.0);
            right.fill(0.0);
            self.0.render(left, right);
            Ok(())
        }

        fn reset(&mut self) {
            self.0.reset();
        }

        fn note_on(&mut self, note: u8, velocity: f32) -> Result<(), PluginFault> {
            self.0.note_on(note, velocity);
            Ok(())
        }

        fn note_off(&mut self, note: u8) -> Result<(), PluginFault> {
            self.0.note_off(note);
            Ok(())
        }
    }

    /// What the engine's Master plays: one Instrument Track, at unity and
    /// centred, playing the Clip from the top.
    fn render(recipe: &Value) -> [Vec<f32>; 2] {
        let sample_rate = recipe["sampleRate"].as_f64().unwrap() as f32;
        let manifest = PluginManifest::parse(&TestInstrument::MANIFEST.instrument_json()).unwrap();
        let mut engine = Engine::new(sample_rate);
        engine.set_tempo(recipe["tempo"].as_f64().unwrap());
        engine.set_track_count(1);
        let clip = &recipe["clip"];
        let (start, length) = (
            clip["start"].as_f64().unwrap(),
            clip["length"].as_f64().unwrap(),
        );
        let notes: Vec<f64> = clip["notes"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|note| {
                let at = note["start"].as_f64().unwrap();
                let long = note["length"].as_f64().unwrap().min(length - at);
                [
                    start + at,
                    long,
                    note["pitch"].as_f64().unwrap(),
                    note["velocity"].as_f64().unwrap(),
                ]
            })
            .collect();
        engine.set_track_notes(0, &notes);
        let settings: Vec<f32> = manifest
            .settings
            .iter()
            .map(|setting| recipe["settings"][&setting.name].as_f64().unwrap() as f32)
            .collect();
        let instance = Native(TestInstrument::new(sample_rate, 1_024));
        engine.swap_track_instrument(
            0,
            PreparedInstrument::plugin(Arc::new(manifest), Box::new(instance)),
        );
        engine.set_track_instrument_settings(0, &settings);
        let played = engine.render_range(0.0, recipe["ticks"].as_f64().unwrap());
        let left = played.iter().step_by(2).copied().collect();
        let right = played.iter().skip(1).step_by(2).copied().collect();
        [left, right]
    }

    #[test]
    fn the_expected_output_is_what_the_engine_plays() {
        let [left, right] = render(&recipe());
        if std::env::var_os("BLESS").is_some() {
            let mut expected = recipe();
            expected["left"] = json!(left);
            expected["right"] = json!(right);
            std::fs::write(EXPECTED, format!("{expected}\n")).unwrap();
        }
        let expected: Value =
            serde_json::from_str(&std::fs::read_to_string(EXPECTED).unwrap()).unwrap();
        let mut recipe_only = expected.clone();
        let object = recipe_only.as_object_mut().unwrap();
        object.remove("left");
        object.remove("right");
        assert_eq!(recipe_only, recipe(), "the recipe the hosts follow");
        let side = |name: &str| -> Vec<f32> {
            let samples = expected[name].as_array().unwrap();
            samples.iter().map(|s| s.as_f64().unwrap() as f32).collect()
        };
        // 120 ticks at 120 BPM and 48 kHz.
        assert_eq!(side("left").len(), 3_000);
        let bits = |side: &[f32]| side.iter().map(|s| s.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&side("left")), bits(&left), "sample for sample");
        assert_eq!(bits(&side("right")), bits(&right), "sample for sample");
        assert_ne!(left, right, "the width setting reached it");
        assert!(left.iter().any(|s| s.abs() > 0.1), "it plays");
    }

    #[test]
    fn a_note_rings_on_through_its_release_and_reset_silences_it() {
        let mut instrument = TestInstrument::new(1_000.0, 16);
        instrument.set(1, 2.0);
        instrument.set(2, 4.0);
        instrument.note_on(69, 1.0);
        let (mut left, mut right) = ([0.0; 4], [0.0; 4]);
        instrument.render(&mut left, &mut right);
        assert_eq!(instrument.voices[69].level, 1.0, "two frames of attack");
        instrument.note_off(69);
        let (mut left, mut right) = ([0.0; 3], [0.0; 3]);
        instrument.render(&mut left, &mut right);
        assert_eq!(instrument.voices[69].level, 0.25, "releasing");
        instrument.reset();
        let (mut left, mut right) = ([0.0; 3], [0.0; 3]);
        instrument.render(&mut left, &mut right);
        assert_eq!(left, [0.0; 3]);
    }
}

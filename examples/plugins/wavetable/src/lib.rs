//! A wavetable synth: an example Plugin **Instrument**, written only against
//! the Soundcheck SDK and its docs.
//!
//! Each of its eight voices reads one cycle of a wave from a table, faster
//! for higher notes. `shape` fades that wave from a sine to a sawtooth, and
//! each note fades in over `attack` and out over `release`.

use soundcheck_sdk::{Instrument, Manifest, Setting};

pub const ID: &str = "dev.soundcheck.example.wavetable";

/// Where each setting is in [`Wavetable::MANIFEST`], the numbers `set` gets.
const SHAPE: usize = 0;
const ATTACK: usize = 1;
const RELEASE: usize = 2;
const LEVEL: usize = 3;

/// Samples in one cycle of a table.
const TABLE: usize = 2048;
/// Harmonics in the sawtooth: few enough that the highest notes don't alias
/// much, enough that it sounds like one.
const HARMONICS: usize = 24;
/// Notes that can sound at once. A ninth takes over the oldest voice.
const VOICES: usize = 8;

pub struct Wavetable {
    sample_rate: f32,
    /// One cycle of each wave, with the first sample again at the end so a
    /// read between the last two needs no wrapping.
    sine: Vec<f32>,
    saw: Vec<f32>,
    shape: f32,
    /// How far the envelope moves each frame, up then down.
    attack_step: f32,
    release_step: f32,
    level: f32,
    voices: [Voice; VOICES],
    /// Counts notes, so the oldest voice is the one to take.
    notes_started: u64,
}

#[derive(Clone, Copy, Default)]
struct Voice {
    note: u8,
    velocity: f32,
    /// Where in the table it is, from 0 to 1, and how far it moves a frame.
    phase: f32,
    step: f32,
    envelope: f32,
    stage: Stage,
    started: u64,
}

#[derive(Clone, Copy, Default, PartialEq)]
enum Stage {
    #[default]
    Idle,
    Held,
    Released,
}

impl Instrument for Wavetable {
    const MANIFEST: Manifest = Manifest {
        id: ID,
        version: "1.0.0",
        name: "Wavetable",
        settings: &[
            Setting::number("shape", "Shape", "", 0.0, 1.0, 0.5),
            Setting::number("attack", "Attack", "ms", 0.0, 2000.0, 5.0),
            Setting::number("release", "Release", "ms", 0.0, 5000.0, 200.0),
            Setting::number("level", "Level", "", 0.0, 1.0, 0.5),
        ],
    };

    /// Build the tables: the only allocation it makes. Every setting is sent
    /// to `set` with its default before the first block.
    fn new(sample_rate: f32, _max_frames: usize) -> Self {
        let cycle = |at: usize| at as f32 / TABLE as f32 * std::f32::consts::TAU;
        let sine = (0..=TABLE).map(|at| cycle(at).sin()).collect();
        // A band-limited sawtooth: the sum of sin(n x) / n, scaled to peak
        // near 1.
        let saw = (0..=TABLE)
            .map(|at| {
                let sum: f32 = (1..=HARMONICS)
                    .map(|n| (cycle(at) * n as f32).sin() / n as f32)
                    .sum();
                sum * 0.55
            })
            .collect();
        Wavetable {
            sample_rate,
            sine,
            saw,
            shape: 0.0,
            attack_step: 1.0,
            release_step: 1.0,
            level: 0.0,
            voices: [Voice::default(); VOICES],
            notes_started: 0,
        }
    }

    fn set(&mut self, index: usize, value: f32) {
        match index {
            SHAPE => self.shape = value,
            ATTACK => self.attack_step = self.per_frame(value),
            RELEASE => self.release_step = self.per_frame(value),
            LEVEL => self.level = value,
            _ => {}
        }
    }

    fn note_on(&mut self, note: u8, velocity: f32) {
        // The same note again restarts its voice; otherwise a free one, or
        // the one that started longest ago.
        let index = self
            .voices
            .iter()
            .position(|voice| voice.stage != Stage::Idle && voice.note == note)
            .or_else(|| {
                self.voices
                    .iter()
                    .position(|voice| voice.stage == Stage::Idle)
            })
            .unwrap_or_else(|| {
                let oldest = self
                    .voices
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, v)| v.started);
                oldest.map_or(0, |(index, _)| index)
            });
        self.notes_started += 1;
        let voice = &mut self.voices[index];
        let restarting = voice.stage != Stage::Idle;
        *voice = Voice {
            note,
            velocity,
            phase: if restarting { voice.phase } else { 0.0 },
            step: frequency(note) / self.sample_rate,
            // Carry on from where a restarted voice was, so it doesn't click.
            envelope: if restarting { voice.envelope } else { 0.0 },
            stage: Stage::Held,
            started: self.notes_started,
        };
    }

    fn note_off(&mut self, note: u8) {
        for voice in &mut self.voices {
            if voice.stage == Stage::Held && voice.note == note {
                voice.stage = Stage::Released;
            }
        }
    }

    fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        let Wavetable {
            sine,
            saw,
            shape,
            attack_step,
            release_step,
            level,
            voices,
            ..
        } = self;
        for voice in voices.iter_mut().filter(|voice| voice.stage != Stage::Idle) {
            for (l, r) in left.iter_mut().zip(right.iter_mut()) {
                voice.envelope = match voice.stage {
                    Stage::Held => (voice.envelope + *attack_step).min(1.0),
                    _ => voice.envelope - *release_step,
                };
                if voice.envelope <= 0.0 && voice.stage == Stage::Released {
                    voice.stage = Stage::Idle;
                    break;
                }
                let wave =
                    read(sine, voice.phase) * (1.0 - *shape) + read(saw, voice.phase) * *shape;
                let sample = wave * voice.envelope * voice.velocity * *level;
                *l += sample;
                *r += sample;
                voice.phase = (voice.phase + voice.step).fract();
            }
        }
    }

    fn reset(&mut self) {
        self.voices = [Voice::default(); VOICES];
    }
}

impl Wavetable {
    /// How far an envelope moves each frame to cross from 0 to 1 in `ms`.
    fn per_frame(&self, ms: f32) -> f32 {
        let frames = ms / 1000.0 * self.sample_rate;
        if frames < 1.0 { 1.0 } else { 1.0 / frames }
    }
}

/// A MIDI note's frequency in equal temperament, with A4 (69) at 440 Hz: the
/// tuning the SDK says the built-in Instruments play in.
pub fn frequency(note: u8) -> f32 {
    440.0 * 2.0_f32.powf((f32::from(note) - 69.0) / 12.0)
}

/// A table at `phase` (0 to 1), between its two nearest samples.
fn read(table: &[f32], phase: f32) -> f32 {
    let at = phase * TABLE as f32;
    let index = (at as usize).min(TABLE - 1);
    let fraction = at - index as f32;
    table[index] + (table[index + 1] - table[index]) * fraction
}

soundcheck_sdk::export_instrument!(Wavetable);

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    /// A wavetable with its settings at their defaults, as the host makes it.
    fn wavetable() -> Wavetable {
        let mut instrument = Wavetable::new(RATE, 128);
        for (index, setting) in Wavetable::MANIFEST.settings.iter().enumerate() {
            instrument.set(index, setting.default);
        }
        instrument
    }

    /// `frames` of what it plays, a block of 128 at a time, as the host
    /// has it: each block starts silent.
    fn play(instrument: &mut Wavetable, frames: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(frames);
        while out.len() < frames {
            let (mut left, mut right) = ([0.0; 128], [0.0; 128]);
            instrument.render(&mut left, &mut right);
            assert_eq!(left, right, "it plays the same on both sides");
            out.extend_from_slice(&left);
        }
        out.truncate(frames);
        out
    }

    /// The pitch of a sine, from how often it rises through zero.
    fn pitch(samples: &[f32]) -> f32 {
        let rises = samples
            .windows(2)
            .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0);
        rises.count() as f32 * RATE / samples.len() as f32
    }

    #[test]
    fn a_note_plays_at_its_pitch() {
        for (note, hz) in [(69, 440.0), (57, 220.0), (60, 261.63)] {
            let mut instrument = wavetable();
            instrument.set(SHAPE, 0.0);
            instrument.note_on(note, 1.0);
            let played = play(&mut instrument, RATE as usize);
            assert!(
                (pitch(&played) - hz).abs() < 1.5,
                "note {note}: {}",
                pitch(&played)
            );
        }
    }

    #[test]
    fn it_is_silent_until_a_note_and_after_its_release() {
        let mut instrument = wavetable();
        assert!(
            play(&mut instrument, 256)
                .iter()
                .all(|sample| *sample == 0.0)
        );
        instrument.note_on(60, 0.8);
        let held = play(&mut instrument, 4_800);
        let loudest = held
            .iter()
            .fold(0.0_f32, |most, sample| most.max(sample.abs()));
        assert!(loudest > 0.2 && loudest <= 0.5, "{loudest}");
        instrument.note_off(60);
        // The default release is 200 ms.
        play(&mut instrument, 9_600);
        assert!(
            play(&mut instrument, 256)
                .iter()
                .all(|sample| *sample == 0.0)
        );
    }

    #[test]
    fn a_ninth_note_takes_over_the_oldest_voice() {
        let mut instrument = wavetable();
        for note in 60..69 {
            instrument.note_on(note, 1.0);
        }
        let notes: Vec<u8> = instrument.voices.iter().map(|voice| voice.note).collect();
        assert_eq!(notes, [68, 61, 62, 63, 64, 65, 66, 67]);
    }

    #[test]
    fn reset_silences_every_voice() {
        let mut instrument = wavetable();
        instrument.note_on(60, 1.0);
        play(&mut instrument, 256);
        instrument.reset();
        assert!(
            play(&mut instrument, 256)
                .iter()
                .all(|sample| *sample == 0.0)
        );
    }
}

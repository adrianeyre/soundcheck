//! The Resonator Effect: tunes a part to a note, so a drum loop, noise or a
//! voice rings out at that pitch like a plucked string or a struck bar.
//!
//! Each side feeds up to three comb filters, delay lines whose output goes
//! back in, so they ring at the frequency whose cycle is the line's length
//! and at every harmonic of it. Tune by picks whether that is a Note in an
//! Octave (C4 is middle C) or a Frequency in hertz. Chord adds combs above
//! it: a fifth, an octave, or a major or minor triad. Decay is how long the
//! ringing takes to fall by 60 dB, and Brightness how much of the upper
//! harmonics it keeps as it does: low is a dull, woody tone, high a bright,
//! metallic one. Mix blends it with the dry signal.
//!
//! The lines are allocated for the lowest note up front. A new pitch glides
//! the lines to their new length, and a comb a new chord adds or drops fades
//! in or out, so changing any setting never clicks.

use super::params::{Param, Settings, choice, number, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::{flush_denormal, note_to_frequency};

/// The notes the `note` setting picks, in order.
pub const RESONATOR_NOTES: &[&str] = &[
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];
/// How the `tuneBy` setting picks the pitch, in order.
pub const RESONATOR_TUNINGS: &[&str] = &["note", "frequency"];
/// The chords the `chord` setting picks, in order.
pub const RESONATOR_CHORDS: &[&str] = &["unison", "fifth", "octave", "major", "minor"];
/// Each chord's notes, in semitones above the root: at most `COMBS`.
const CHORD_INTERVALS: [&[f32]; 5] = [
    &[0.0],
    &[0.0, 7.0],
    &[0.0, 12.0],
    &[0.0, 4.0, 7.0],
    &[0.0, 3.0, 7.0],
];
const COMBS: usize = 3;
const LOWEST_HZ: f32 = 20.0;
/// The DC blocker's pole: its corner is a few hertz, below the lowest note.
const DC_POLE: f32 = 0.999;
/// How long a new pitch or chord takes to glide in.
const GLIDE_MS: f32 = 30.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResonatorSettings {
    /// An index into `RESONATOR_TUNINGS`.
    pub tune_by: usize,
    /// An index into `RESONATOR_NOTES`.
    pub note: usize,
    /// The octave `note` is in, where C4 is middle C.
    pub octave: f32,
    /// The pitch when tuned by frequency.
    pub frequency_hz: f32,
    /// An index into `RESONATOR_CHORDS`.
    pub chord: usize,
    /// Seconds for the ringing to fall by 60 dB.
    pub decay: f32,
    /// 0..=1: how much of the upper harmonics the ringing keeps.
    pub brightness: f32,
    pub mix: f32,
}

impl Default for ResonatorSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

impl ResonatorSettings {
    /// The chord's root, in hertz.
    pub fn root_hz(&self) -> f32 {
        if self.tune_by == 1 {
            self.frequency_hz
        } else {
            // MIDI note 60 is C4.
            note_to_frequency(12.0 * (self.octave + 1.0) + self.note as f32)
        }
    }
}

/// Every setting of the Resonator, in the order a host sends them.
#[rustfmt::skip]
pub const RESONATOR_PARAMS: &[Param<ResonatorSettings>] = &[
    choice("tuneBy", "Tune by", RESONATOR_TUNINGS, 0,
        |s| s.tune_by as f32, |s, v| s.tune_by = v as usize),
    choice("note", "Note", RESONATOR_NOTES, 0,
        |s| s.note as f32, |s, v| s.note = v as usize),
    number::<ResonatorSettings>("octave", "Octave", "", (1.0, 7.0, 3.0),
        |s| s.octave, |s, v| s.octave = v).stepped(1.0),
    number("frequencyHz", "Frequency", "Hz", (LOWEST_HZ, 2_000.0, 220.0),
        |s| s.frequency_hz, |s, v| s.frequency_hz = v),
    choice("chord", "Chord", RESONATOR_CHORDS, 0,
        |s| s.chord as f32, |s, v| s.chord = v as usize),
    number("decay", "Decay", "s", (0.05, 10.0, 1.0),
        |s| s.decay, |s, v| s.decay = v),
    number("brightness", "Brightness", "", (0.0, 1.0, 0.5),
        |s| s.brightness, |s, v| s.brightness = v),
    number("mix", "Mix", "", (0.0, 1.0, 0.5),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for ResonatorSettings {
    const PARAMS: &'static [Param<Self>] = RESONATOR_PARAMS;

    fn zeroed() -> Self {
        Self {
            tune_by: 0,
            note: 0,
            octave: 0.0,
            frequency_hz: 0.0,
            chord: 0,
            decay: 0.0,
            brightness: 0.0,
            mix: 0.0,
        }
    }
}

/// Each comb's cycle in samples and whether it sounds, for `settings`.
fn targets(settings: &ResonatorSettings, sample_rate: f32) -> [(f32, f32); COMBS] {
    let intervals = CHORD_INTERVALS[settings.chord.min(CHORD_INTERVALS.len() - 1)];
    let root = settings.root_hz().max(LOWEST_HZ);
    let mut targets = [(sample_rate / root, 0.0); COMBS];
    for (target, interval) in targets.iter_mut().zip(intervals) {
        *target = (sample_rate / (root * (interval / 12.0).exp2()), 1.0);
    }
    targets
}

/// How much the damping filter's memory, at `brightness`, holds each sample.
fn damping(brightness: f32) -> f32 {
    0.8 * (1.0 - brightness)
}

/// How long a comb's line must be for a cycle of `cycle` samples: the
/// damping filter delays the ringing too, and would otherwise flatten it.
fn line_length(cycle: f32, damping: f32) -> f32 {
    let w = std::f32::consts::TAU / cycle;
    let lag = (damping * w.sin()).atan2(1.0 - damping * w.cos()) / w;
    cycle - lag
}

/// One comb on one side: its line and the damping filter in its loop.
#[derive(Clone, Debug)]
struct Comb {
    line: Vec<f32>,
    damped: f32,
}

#[derive(Clone, Debug)]
pub struct Resonator {
    sample_rate: f32,
    settings: ResonatorSettings,
    glide: f32,
    combs: [[Comb; COMBS]; 2],
    write: usize,
    /// Each side's DC blocker on the ringing: its last input and output.
    /// A comb rings at 0 Hz too, which would turn any offset into a large one.
    dc: [[f32; 2]; 2],
    /// Each comb's line length in samples and its level, gliding towards
    /// their settings.
    lengths: [f32; COMBS],
    levels: [f32; COMBS],
}

impl Resonator {
    pub fn new(sample_rate: f32, settings: ResonatorSettings) -> Self {
        // Room for the lowest pitch's cycle and the sample after it to
        // interpolate towards.
        let capacity = (sample_rate / LOWEST_HZ).ceil() as usize + 4;
        let comb = Comb {
            line: vec![0.0; capacity],
            damped: 0.0,
        };
        let combs = std::array::from_fn(|_| std::array::from_fn(|_| comb.clone()));
        let targets = targets(&settings, sample_rate);
        Self {
            sample_rate,
            settings,
            glide: time_coefficient(GLIDE_MS, sample_rate),
            combs,
            write: 0,
            dc: [[0.0; 2]; 2],
            lengths: targets.map(|(cycle, _)| line_length(cycle, damping(settings.brightness))),
            levels: targets.map(|(_, level)| level),
        }
    }

    /// `line` read `delay` samples behind the write, between samples.
    fn read(line: &[f32], write: usize, delay: f32) -> f32 {
        let length = line.len();
        let whole = delay.floor();
        let fraction = delay - whole;
        let at = (write + length - whole as usize) % length;
        let before = (at + length - 1) % length;
        line[at] * (1.0 - fraction) + line[before] * fraction
    }
}

impl StereoEffect for Resonator {
    type Settings = ResonatorSettings;

    fn settings(&self) -> ResonatorSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: ResonatorSettings) {
        self.settings = settings;
    }

    fn settle(&mut self) {
        let damping = damping(self.settings.brightness);
        for (index, (cycle, level)) in targets(&self.settings, self.sample_rate)
            .into_iter()
            .enumerate()
        {
            self.lengths[index] = line_length(cycle, damping);
            self.levels[index] = level;
        }
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let ResonatorSettings {
            decay,
            brightness,
            mix,
            ..
        } = self.settings;
        let targets = targets(&self.settings, self.sample_rate);
        // The feedback each comb needs to fall by 60 dB in `decay`, from the
        // cycle it is gliding to.
        let feedback = targets.map(|(cycle, _)| {
            0.001_f32
                .powf(cycle / (decay * self.sample_rate))
                .min(0.9999)
        });
        // Scaled so a comb turns white noise into ringing at about the same
        // level, and shared between the chord's combs.
        let sounding = targets.iter().filter(|(_, level)| *level > 0.0).count() as f32;
        let input_gains = feedback.map(|g| (1.0 - g * g).sqrt() / sounding.sqrt());
        let damping = damping(brightness);
        let lines = targets.map(|(cycle, level)| (line_length(cycle, damping), level));
        let length = self.combs[0][0].line.len();
        let longest = (length - 2) as f32;
        let glide = self.glide;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            for (index, (target_length, target_level)) in lines.iter().enumerate() {
                self.lengths[index] = target_length + (self.lengths[index] - target_length) * glide;
                self.levels[index] = target_level + (self.levels[index] - target_level) * glide;
            }
            for ((sample, combs), [last_in, last_out]) in [l, r]
                .into_iter()
                .zip(self.combs.iter_mut())
                .zip(self.dc.iter_mut())
            {
                let mut wet = 0.0;
                for (index, comb) in combs.iter_mut().enumerate() {
                    let delay = self.lengths[index].clamp(1.0, longest);
                    // The line is read before this sample is written, so a
                    // delay of `delay` is one sample shorter than it reads.
                    let back = Self::read(&comb.line, self.write, delay - 1.0);
                    comb.damped = flush_denormal(back + (comb.damped - back) * damping);
                    let out = *sample * input_gains[index] + feedback[index] * comb.damped;
                    comb.line[self.write] = flush_denormal(out);
                    wet += out * self.levels[index];
                }
                let blocked = flush_denormal(wet - *last_in + DC_POLE * *last_out);
                (*last_in, *last_out) = (wet, blocked);
                *sample = *sample * (1.0 - mix) + blocked * mix;
            }
            self.write = (self.write + 1) % length;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rising_zero_crossings, rms, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> ResonatorSettings {
        let mut settings = ResonatorSettings::default();
        for (name, value) in changes {
            let param = RESONATOR_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(settings: ResonatorSettings, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut resonator = Resonator::new(RATE, settings);
        let (mut left, mut right) = (input.to_vec(), input.to_vec());
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            resonator.process_stereo(l, r);
        }
        assert_eq!(left, right);
        left
    }

    fn impulse(frames: usize) -> Vec<f32> {
        let mut impulse = vec![0.0; frames];
        impulse[0] = 1.0;
        impulse
    }

    #[test]
    fn the_note_and_octave_tune_it() {
        let a3 = settings(&[("note", 9.0), ("octave", 3.0)]);
        assert!((a3.root_hz() - 220.0).abs() < 1e-3);
        assert!((settings(&[("octave", 4.0)]).root_hz() - 261.63).abs() < 0.01);
        let by_hz = settings(&[("tuneBy", 1.0), ("frequencyHz", 500.0)]);
        assert_eq!(by_hz.root_hz(), 500.0);
    }

    #[test]
    fn an_impulse_rings_at_the_note() {
        // Dull enough that the fundamental is all that is left to count.
        let tuned = settings(&[
            ("note", 9.0),
            ("octave", 3.0),
            ("decay", 4.0),
            ("brightness", 0.0),
            ("mix", 1.0),
        ]);
        let out = run(tuned, &impulse(48_000), 128);
        let crossings = rising_zero_crossings(&out[24_000..]) as f32 * 2.0;
        assert!((crossings - 220.0).abs() <= 2.0, "{crossings}");
        // It is still ringing, but quieter, after a second.
        let early = rms(&out[1_000..5_800]);
        let late = rms(&out[43_200..]);
        assert!(late > 0.0 && late < early, "{early} {late}");
    }

    #[test]
    fn a_longer_decay_rings_for_longer() {
        let short = run(
            settings(&[("decay", 0.2), ("mix", 1.0)]),
            &impulse(48_000),
            128,
        );
        let long = run(
            settings(&[("decay", 5.0), ("mix", 1.0)]),
            &impulse(48_000),
            128,
        );
        assert!(rms(&long[24_000..]) > 100.0 * rms(&short[24_000..]));
    }

    #[test]
    fn no_mix_is_dry() {
        let input = sine(300.0, 0.5, RATE, 4_800);
        assert_eq!(
            run(settings(&[("mix", 0.0), ("chord", 3.0)]), &input, 64),
            input
        );
    }

    #[test]
    fn every_chord_at_the_extremes_stays_finite() {
        let noise: Vec<f32> = (0..48_000_u32)
            .map(|n| (n.wrapping_mul(2_654_435_761) >> 16) as f32 / 32_768.0 - 1.0)
            .collect();
        for chord in 0..RESONATOR_CHORDS.len() {
            for (octave, brightness) in [(1.0, 1.0), (7.0, 0.0), (7.0, 1.0)] {
                let out = run(
                    settings(&[
                        ("chord", chord as f32),
                        ("octave", octave),
                        ("decay", 10.0),
                        ("brightness", brightness),
                        ("mix", 1.0),
                    ]),
                    &noise,
                    512,
                );
                assert!(out.iter().all(|s| s.is_finite() && s.abs() < 100.0));
            }
        }
    }

    #[test]
    fn odd_chunks_render_the_same_as_one_block() {
        let input = sine(330.0, 0.5, RATE, 9_000);
        let tuned = settings(&[("chord", 4.0), ("mix", 0.7)]);
        let whole = run(tuned, &input, input.len());
        assert_eq!(whole, run(tuned, &input, 1));
        assert_eq!(whole, run(tuned, &input, 37));
    }
}

//! The Vowel Filter Effect: makes a part sound as if it is speaking a vowel,
//! the talking, "yah-yah" sound of a synth lead or a wobbling bass.
//!
//! A voice tells its vowels apart by formants, the few bands its mouth makes
//! ring. Three band-passes per side sit at the formants of Vowel (A, E, I, O
//! or U), each at the level a voice gives it. Morph slides them towards the
//! next vowel along, U back round to A, and the LFO swings them either way by
//! up to LFO depth vowels at LFO rate, so the part says "ah-ee-ah". Resonance
//! is the bands' Q: higher is a narrower, more vocal and whistling sound.
//! The bands are redesigned every few dozen samples, carrying their memory
//! over, and a new vowel glides in, so neither moving nor changing it clicks.
//! Mix blends it with the dry signal.

use std::f32::consts::TAU;

use super::params::{Param, Settings, choice, number, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::{Biquad, db_to_gain};

/// The vowels the `vowel` setting picks, in the order Morph moves through.
pub const VOWELS: &[&str] = &["A", "E", "I", "O", "U"];
/// Each vowel's three formants: hertz and level in decibels.
const FORMANTS: [[(f32, f32); 3]; 5] = [
    [(650.0, 0.0), (1_080.0, -6.0), (2_650.0, -7.0)],
    [(400.0, 0.0), (1_700.0, -14.0), (2_600.0, -12.0)],
    [(290.0, 0.0), (1_870.0, -15.0), (2_800.0, -18.0)],
    [(400.0, 0.0), (800.0, -10.0), (2_600.0, -12.0)],
    [(350.0, 0.0), (600.0, -20.0), (2_700.0, -17.0)],
];
const BANDS: usize = 3;
/// The bands move this often, in samples.
const CONTROL_FRAMES: usize = 32;
/// How long a new vowel or morph takes to glide in.
const GLIDE_MS: f32 = 40.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VowelSettings {
    /// An index into `VOWELS`.
    pub vowel: usize,
    /// 0..=1: how far towards the next vowel.
    pub morph: f32,
    /// The bands' Q.
    pub resonance: f32,
    pub lfo_rate_hz: f32,
    /// How far the LFO moves the vowel either way, in vowels.
    pub lfo_depth: f32,
    pub mix: f32,
}

impl Default for VowelSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Vowel Filter, in the order a host sends them.
#[rustfmt::skip]
pub const VOWEL_PARAMS: &[Param<VowelSettings>] = &[
    choice("vowel", "Vowel", VOWELS, 0,
        |s| s.vowel as f32, |s, v| s.vowel = v as usize),
    number("morph", "Morph", "", (0.0, 1.0, 0.0),
        |s| s.morph, |s, v| s.morph = v),
    number("resonance", "Resonance", "Q", (1.0, 20.0, 6.0),
        |s| s.resonance, |s, v| s.resonance = v),
    number("lfoRateHz", "LFO rate", "Hz", (0.05, 10.0, 1.0),
        |s| s.lfo_rate_hz, |s, v| s.lfo_rate_hz = v),
    number("lfoDepth", "LFO depth", "", (0.0, 2.0, 0.0),
        |s| s.lfo_depth, |s, v| s.lfo_depth = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for VowelSettings {
    const PARAMS: &'static [Param<Self>] = VOWEL_PARAMS;

    fn zeroed() -> Self {
        Self {
            vowel: 0,
            morph: 0.0,
            resonance: 0.0,
            lfo_rate_hz: 0.0,
            lfo_depth: 0.0,
            mix: 0.0,
        }
    }
}

/// The formants at `position` vowels along, between vowels and round from U
/// back to A: each band's hertz and gain.
fn formants_at(position: f32) -> [(f32, f32); BANDS] {
    let count = FORMANTS.len();
    let position = position.rem_euclid(count as f32);
    let index = (position.floor() as usize).min(count - 1);
    let fraction = position - index as f32;
    let (from, to) = (FORMANTS[index], FORMANTS[(index + 1) % count]);
    std::array::from_fn(|band| {
        let (from_hz, from_db) = from[band];
        let (to_hz, to_db) = to[band];
        (
            from_hz * (to_hz / from_hz).powf(fraction),
            db_to_gain(from_db + (to_db - from_db) * fraction),
        )
    })
}

#[derive(Clone, Debug)]
pub struct Vowel {
    sample_rate: f32,
    settings: VowelSettings,
    glide: f32,
    /// Each side's bands.
    bands: [[Biquad; BANDS]; 2],
    /// Each band's gain, as last designed.
    gains: [f32; BANDS],
    /// Vowel and Morph together, gliding towards their setting.
    position: f32,
    /// Where the LFO is in its cycle, 0..1.
    phase: f32,
    /// Samples until the bands are next redesigned.
    countdown: usize,
}

impl Vowel {
    pub fn new(sample_rate: f32, settings: VowelSettings) -> Self {
        let band = Biquad::band_pass(sample_rate, 1_000.0, settings.resonance);
        Self {
            sample_rate,
            settings,
            glide: time_coefficient(GLIDE_MS, sample_rate / CONTROL_FRAMES as f32),
            bands: [[band; BANDS]; 2],
            gains: [0.0; BANDS],
            position: settings.vowel as f32 + settings.morph,
            phase: 0.0,
            countdown: 0,
        }
    }

    /// Move the vowel on and redesign the bands for where it is now.
    fn redesign(&mut self) {
        let VowelSettings {
            vowel,
            morph,
            resonance,
            lfo_rate_hz,
            lfo_depth,
            ..
        } = self.settings;
        let target = vowel as f32 + morph;
        self.position = target + (self.position - target) * self.glide;
        let swing = lfo_depth * (TAU * self.phase).sin();
        self.phase = (self.phase + lfo_rate_hz / self.sample_rate * CONTROL_FRAMES as f32).fract();
        let formants = formants_at(self.position + swing);
        // Narrower bands let less of a bright, harmonic-rich part through, by
        // about the root of the Q; this brings the wet signal back to its level.
        let makeup = 1.5 * resonance.sqrt();
        for (index, (hz, gain)) in formants.into_iter().enumerate() {
            self.gains[index] = gain * makeup;
            for side in &mut self.bands {
                let mut next = Biquad::band_pass(self.sample_rate, hz, resonance);
                next.restore_state(&side[index]);
                side[index] = next;
            }
        }
    }
}

impl StereoEffect for Vowel {
    type Settings = VowelSettings;

    fn settings(&self) -> VowelSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: VowelSettings) {
        self.settings = settings;
    }

    fn settle(&mut self) {
        self.position = self.settings.vowel as f32 + self.settings.morph;
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let mix = self.settings.mix;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            if self.countdown == 0 {
                self.redesign();
                self.countdown = CONTROL_FRAMES;
            }
            self.countdown -= 1;
            for (sample, bands) in [l, r].into_iter().zip(self.bands.iter_mut()) {
                let wet: f32 = bands
                    .iter_mut()
                    .zip(self.gains)
                    .map(|(band, gain)| band.process(*sample) * gain)
                    .sum();
                *sample = *sample * (1.0 - mix) + wet * mix;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rms, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> VowelSettings {
        let mut settings = VowelSettings::default();
        for (name, value) in changes {
            let param = VOWEL_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(settings: VowelSettings, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut vowel = Vowel::new(RATE, settings);
        let (mut left, mut right) = (input.to_vec(), input.to_vec());
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            vowel.process_stereo(l, r);
        }
        assert_eq!(left, right);
        left
    }

    /// A 110 Hz sawtooth: every harmonic, for the formants to pick from.
    fn saw(frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|n| 2.0 * (n as f32 * 110.0 / RATE).fract() - 1.0)
            .collect()
    }

    /// How loud the output is at `hz`, measured by one more band-pass.
    fn level_at(buffer: &[f32], hz: f32) -> f32 {
        let mut probe = Biquad::band_pass(RATE, hz, 8.0);
        let mut probed = buffer.to_vec();
        probe.process_buffer(&mut probed);
        rms(&probed[probed.len() / 2..])
    }

    #[test]
    fn each_vowel_brings_out_its_own_formants() {
        let input = saw(48_000);
        let a = run(settings(&[("vowel", 0.0)]), &input, 128);
        let i = run(settings(&[("vowel", 2.0)]), &input, 128);
        // A's first formant is high, and I's low.
        assert!(level_at(&a, 660.0) > 3.0 * level_at(&i, 660.0));
        assert!(level_at(&i, 330.0) > 3.0 * level_at(&a, 330.0));
        // And the wet signal is at about the level of what went in.
        let ratio = rms(&a[24_000..]) / rms(&input[24_000..]);
        assert!((0.5..1.5).contains(&ratio), "{ratio}");
    }

    #[test]
    fn a_full_morph_is_the_next_vowel() {
        let input = saw(24_000);
        let morphed = run(settings(&[("vowel", 1.0), ("morph", 1.0)]), &input, 128);
        let next = run(settings(&[("vowel", 2.0)]), &input, 128);
        for (a, b) in morphed.iter().zip(&next) {
            assert!((a - b).abs() < 1e-4);
        }
        // Round from U back to A.
        assert_eq!(formants_at(5.0), formants_at(0.0));
    }

    #[test]
    fn no_mix_is_dry() {
        let input = sine(300.0, 0.5, RATE, 4_800);
        let out = run(settings(&[("mix", 0.0), ("lfoDepth", 2.0)]), &input, 64);
        assert_eq!(out, input);
    }

    #[test]
    fn extreme_settings_stay_finite() {
        let input: Vec<f32> = (0..48_000)
            .map(|n| if n % 300 < 150 { 1.0 } else { -1.0 })
            .collect();
        let out = run(
            settings(&[
                ("resonance", 20.0),
                ("lfoRateHz", 10.0),
                ("lfoDepth", 2.0),
                ("morph", 1.0),
                ("vowel", 4.0),
            ]),
            &input,
            512,
        );
        assert!(out.iter().all(|s| s.is_finite() && s.abs() < 20.0));
    }

    #[test]
    fn odd_chunks_render_the_same_as_one_block() {
        let input = saw(9_000);
        let swinging = settings(&[("lfoDepth", 1.5), ("lfoRateHz", 5.0), ("mix", 0.8)]);
        let whole = run(swinging, &input, input.len());
        assert_eq!(whole, run(swinging, &input, 1));
        assert_eq!(whole, run(swinging, &input, 37));
    }
}

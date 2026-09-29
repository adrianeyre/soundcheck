//! The Ring Modulator Effect: metallic, bell-like and robotic tones.
//!
//! The signal is multiplied by a sine, the carrier, at Frequency. Every tone
//! in it is replaced by two, the carrier's frequency above and below it, which
//! are rarely in tune with the original: a low carrier makes a fast wobble, a
//! high one a clangorous, inharmonic ring. Drift sweeps the carrier up and
//! down by up to Drift depth semitones at Drift rate, so the ring bends and
//! sighs. Mix blends it with the dry signal.

use std::f32::consts::TAU;

use super::params::{Param, Settings, number, time_coefficient};
use super::stereo::StereoEffect;

/// How quickly the carrier and the mix follow a change, so turning them
/// doesn't click or zip.
const SMOOTHING_MS: f32 = 20.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RingModSettings {
    /// The carrier's frequency.
    pub frequency_hz: f32,
    /// How fast the carrier drifts up and down.
    pub drift_rate_hz: f32,
    /// How far the carrier drifts either way, in semitones.
    pub drift_depth: f32,
    /// 0..=1: 0 is only the dry signal, 1 only the ring.
    pub mix: f32,
}

impl Default for RingModSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Ring Modulator, in the order a host sends them.
#[rustfmt::skip]
pub const RING_MOD_PARAMS: &[Param<RingModSettings>] = &[
    number("frequencyHz", "Frequency", "Hz", (20.0, 5_000.0, 440.0),
        |s| s.frequency_hz, |s, v| s.frequency_hz = v),
    number("driftRateHz", "Drift rate", "Hz", (0.05, 10.0, 0.5),
        |s| s.drift_rate_hz, |s, v| s.drift_rate_hz = v),
    number("driftDepth", "Drift depth", "st", (0.0, 12.0, 0.0),
        |s| s.drift_depth, |s, v| s.drift_depth = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for RingModSettings {
    const PARAMS: &'static [Param<Self>] = RING_MOD_PARAMS;

    fn zeroed() -> Self {
        Self {
            frequency_hz: 0.0,
            drift_rate_hz: 0.0,
            drift_depth: 0.0,
            mix: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RingMod {
    sample_rate: f32,
    settings: RingModSettings,
    /// Where in its cycle the carrier is, and the drift, each 0..1.
    carrier: f32,
    drift: f32,
    /// The carrier's frequency and the mix, following the settings.
    frequency_hz: f32,
    mix: f32,
    smoothing: f32,
}

impl RingMod {
    pub fn new(sample_rate: f32, settings: RingModSettings) -> Self {
        Self {
            sample_rate,
            settings,
            carrier: 0.0,
            drift: 0.0,
            frequency_hz: settings.frequency_hz,
            mix: settings.mix,
            smoothing: time_coefficient(SMOOTHING_MS, sample_rate),
        }
    }
}

impl StereoEffect for RingMod {
    type Settings = RingModSettings;

    fn settings(&self) -> RingModSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: RingModSettings) {
        self.settings = settings;
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let RingModSettings {
            frequency_hz,
            drift_rate_hz,
            drift_depth,
            mix,
        } = self.settings;
        let per_sample = 1.0 / self.sample_rate;
        let drift_increment = drift_rate_hz * per_sample;
        let nyquist = 0.5 * self.sample_rate;
        let smoothing = self.smoothing;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            self.frequency_hz = frequency_hz + smoothing * (self.frequency_hz - frequency_hz);
            self.mix = mix + smoothing * (self.mix - mix);
            let semitones = drift_depth * (TAU * self.drift).sin();
            let hz = (self.frequency_hz * (semitones / 12.0).exp2()).min(nyquist);
            let carrier = (TAU * self.carrier).sin();
            self.carrier = (self.carrier + hz * per_sample).fract();
            self.drift = (self.drift + drift_increment).fract();

            let dry = 1.0 - self.mix;
            *l = *l * dry + *l * carrier * self.mix;
            *r = *r * dry + *r * carrier * self.mix;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rms, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> RingModSettings {
        let mut settings = RingModSettings::default();
        for (name, value) in changes {
            let param = RING_MOD_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(ring: &mut RingMod, input: &[f32], chunk: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut left, mut right) = (input.to_vec(), input.to_vec());
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            ring.process_stereo(l, r);
        }
        (left, right)
    }

    /// The amplitude of the sine at `frequency` in `buffer`, which holds a
    /// whole number of its cycles.
    fn level_at(buffer: &[f32], frequency: f32) -> f32 {
        let (mut sin, mut cos) = (0.0_f64, 0.0_f64);
        for (n, sample) in buffer.iter().enumerate() {
            let angle = f64::from(TAU * frequency / RATE) * n as f64;
            sin += f64::from(*sample) * angle.sin();
            cos += f64::from(*sample) * angle.cos();
        }
        (2.0 * sin.hypot(cos) / buffer.len() as f64) as f32
    }

    #[test]
    fn a_tone_becomes_the_sum_and_the_difference() {
        let input = sine(300.0, 1.0, RATE, 48_000);
        let mut ring = RingMod::new(RATE, settings(&[("frequencyHz", 1_000.0)]));
        let (left, right) = run(&mut ring, &input, 128);
        assert!((level_at(&left, 700.0) - 0.5).abs() < 1e-2);
        assert!((level_at(&left, 1_300.0) - 0.5).abs() < 1e-2);
        assert!(level_at(&left, 300.0) < 1e-2, "the tone itself is gone");
        assert_eq!(left, right);
    }

    #[test]
    fn no_mix_is_dry() {
        let input = sine(300.0, 0.5, RATE, 4_800);
        let changes = [("mix", 0.0), ("driftDepth", 12.0)];
        let (left, right) = run(&mut RingMod::new(RATE, settings(&changes)), &input, 128);
        assert_eq!(left, input);
        assert_eq!(right, input);
    }

    #[test]
    fn half_mix_keeps_half_the_tone() {
        let input = sine(300.0, 1.0, RATE, 48_000);
        let changes = [("frequencyHz", 1_000.0), ("mix", 0.5)];
        let (left, _) = run(&mut RingMod::new(RATE, settings(&changes)), &input, 128);
        assert!((level_at(&left, 300.0) - 0.5).abs() < 1e-2);
        assert!((level_at(&left, 1_300.0) - 0.25).abs() < 1e-2);
    }

    #[test]
    fn drift_spreads_the_ring_off_its_frequency() {
        let input = sine(300.0, 1.0, RATE, 48_000);
        let steady = settings(&[("frequencyHz", 1_000.0)]);
        let drifting = settings(&[
            ("frequencyHz", 1_000.0),
            ("driftDepth", 3.0),
            ("driftRateHz", 2.0),
        ]);
        let (steady, _) = run(&mut RingMod::new(RATE, steady), &input, 128);
        let (drifting, _) = run(&mut RingMod::new(RATE, drifting), &input, 128);
        assert!(level_at(&drifting, 1_300.0) < level_at(&steady, 1_300.0) / 2.0);
        // Drift moves the tones, it doesn't make them louder or quieter.
        assert!((rms(&drifting) - rms(&steady)).abs() < 0.02);
    }

    #[test]
    fn it_is_finite_at_the_extremes_and_blocks_do_not_matter() {
        let input = sine(4_000.0, 1.0, RATE, 10_000);
        let changes = [
            ("frequencyHz", 5_000.0),
            ("driftDepth", 12.0),
            ("driftRateHz", 10.0),
        ];
        let (whole, _) = run(&mut RingMod::new(RATE, settings(&changes)), &input, 10_000);
        assert!(whole.iter().all(|s| s.is_finite() && s.abs() <= 1.0));
        for chunk in [1, 7, 128] {
            let (chunked, _) = run(&mut RingMod::new(RATE, settings(&changes)), &input, chunk);
            assert_eq!(chunked, whole, "in blocks of {chunk}");
        }
    }
}

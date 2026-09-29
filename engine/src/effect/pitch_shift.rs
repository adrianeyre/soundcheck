//! The Pitch Shifter Effect: the signal up or down by an interval, keeping
//! its length, as on an octave-up lead or a harmony a fifth below.
//!
//! It works like a tape loop with two rotating heads. Each side's signal
//! goes into a short delay line, and two grains read it back at a rate that
//! raises or lowers the pitch by Semitones and Fine cents, their read points
//! sweeping through the Grain size. When one grain reaches the end of the
//! line it jumps back, faded out while the other, half a grain apart, is
//! faded in, so their sum never breaks off. Longer grains smear transients
//! but warble less on low notes; shorter ones are tighter but buzzier. Mix
//! blends it with the dry signal.
//!
//! The line is allocated for the longest grain up front, so changing any
//! setting never allocates.

use std::f32::consts::PI;

use super::params::{Param, Settings, number, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::flush_denormal;

const MAX_GRAIN_MS: f32 = 200.0;
const MIN_GRAIN_MS: f32 = 10.0;
/// How long the grain size takes to follow a change, so the read points
/// glide rather than jump.
const GRAIN_SMOOTHING_MS: f32 = 50.0;
/// The shortest delay a grain reads at, for the interpolation's look-ahead.
const GUARD: f32 = 2.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PitchShifterSettings {
    /// -12..=12, whole semitones.
    pub semitones: f32,
    /// -100..=100 cents on top.
    pub cents: f32,
    pub grain_ms: f32,
    /// 0..=1: 0 is only the dry signal, 1 only the shifted one.
    pub mix: f32,
}

impl Default for PitchShifterSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

impl PitchShifterSettings {
    /// How much faster than the input the grains read it.
    pub fn ratio(&self) -> f32 {
        2.0_f32.powf((self.semitones + self.cents / 100.0) / 12.0)
    }
}

/// Every setting of the Pitch Shifter, in the order a host sends them.
#[rustfmt::skip]
pub const PITCH_SHIFT_PARAMS: &[Param<PitchShifterSettings>] = &[
    number::<PitchShifterSettings>("semitones", "Semitones", "st", (-12.0, 12.0, 12.0),
        |s| s.semitones, |s, v| s.semitones = v).stepped(1.0),
    number("cents", "Fine", "cent", (-100.0, 100.0, 0.0),
        |s| s.cents, |s, v| s.cents = v),
    number("grainMs", "Grain size", "ms", (MIN_GRAIN_MS, MAX_GRAIN_MS, 50.0),
        |s| s.grain_ms, |s, v| s.grain_ms = v),
    number("mix", "Mix", "", (0.0, 1.0, 0.5),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for PitchShifterSettings {
    const PARAMS: &'static [Param<Self>] = PITCH_SHIFT_PARAMS;

    fn zeroed() -> Self {
        Self {
            semitones: 0.0,
            cents: 0.0,
            grain_ms: 0.0,
            mix: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PitchShifter {
    sample_rate: f32,
    settings: PitchShifterSettings,
    left: Vec<f32>,
    right: Vec<f32>,
    write: usize,
    /// Where the first grain is in its sweep, 0..1; the second is half a
    /// sweep on.
    phase: f32,
    /// The grain size in samples, gliding towards the setting's.
    grain: f32,
    grain_smoothing: f32,
}

impl PitchShifter {
    pub fn new(sample_rate: f32, settings: PitchShifterSettings) -> Self {
        let capacity = (MAX_GRAIN_MS / 1_000.0 * sample_rate).ceil() as usize + 8;
        Self {
            sample_rate,
            settings,
            left: vec![0.0; capacity],
            right: vec![0.0; capacity],
            write: 0,
            phase: 0.0,
            grain: settings.grain_ms / 1_000.0 * sample_rate,
            grain_smoothing: time_coefficient(GRAIN_SMOOTHING_MS, sample_rate),
        }
    }

    /// The line read `delay` samples behind the newest sample, between
    /// samples, on a four-point Hermite curve. `delay` is at least 1.
    fn read(line: &[f32], newest: usize, delay: f32) -> f32 {
        let length = line.len();
        let whole = delay.floor() as usize;
        let t = delay.fract();
        let back = |by: usize| line[(newest + 2 * length - by) % length];
        let (y0, y1, y2, y3) = (
            back(whole - 1),
            back(whole),
            back(whole + 1),
            back(whole + 2),
        );
        let c1 = 0.5 * (y2 - y0);
        let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
        let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        ((c3 * t + c2) * t + c1) * t + y1
    }
}

impl StereoEffect for PitchShifter {
    type Settings = PitchShifterSettings;

    fn settings(&self) -> PitchShifterSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: PitchShifterSettings) {
        self.settings = settings;
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let ratio = self.settings.ratio();
        let mix = self.settings.mix;
        let length = self.left.len();
        let target = self.settings.grain_ms / 1_000.0 * self.sample_rate;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            self.left[self.write] = flush_denormal(*l);
            self.right[self.write] = flush_denormal(*r);
            self.grain = target + self.grain_smoothing * (self.grain - target);

            // Reading faster than writing closes the gap to the newest sample
            // by `ratio - 1` a sample; slower, it falls behind.
            self.phase = (self.phase + (1.0 - ratio) / self.grain).rem_euclid(1.0);
            let second = (self.phase + 0.5).fract();
            let (delay_a, delay_b) = (GUARD + self.phase * self.grain, GUARD + second * self.grain);
            // sin² and cos²: the two always sum to one.
            let weight_a = (PI * self.phase).sin().powi(2);
            let weight_b = 1.0 - weight_a;

            let wet_left = weight_a * Self::read(&self.left, self.write, delay_a)
                + weight_b * Self::read(&self.left, self.write, delay_b);
            let wet_right = weight_a * Self::read(&self.right, self.write, delay_a)
                + weight_b * Self::read(&self.right, self.write, delay_b);
            self.write = (self.write + 1) % length;

            *l = *l * (1.0 - mix) + wet_left * mix;
            *r = *r * (1.0 - mix) + wet_right * mix;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rising_zero_crossings, rms, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> PitchShifterSettings {
        let mut settings = PitchShifterSettings {
            mix: 1.0,
            ..PitchShifterSettings::default()
        };
        for (name, value) in changes {
            let param = PITCH_SHIFT_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(shifter: &mut PitchShifter, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut left = input.to_vec();
        let mut right = input.to_vec();
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            shifter.process_stereo(l, r);
        }
        assert_eq!(left, right);
        left
    }

    /// The frequency of a shifted 440 Hz sine, from its zero crossings over
    /// a second, once the line has filled.
    fn shifted(changes: &[(&str, f32)]) -> f32 {
        let input = sine(440.0, 0.5, RATE, 72_000);
        let out = run(&mut PitchShifter::new(RATE, settings(changes)), &input, 256);
        rising_zero_crossings(&out[24_000..]) as f32
    }

    #[test]
    fn it_shifts_the_pitch_by_the_interval() {
        for (semitones, cents) in [(12.0, 0.0), (-12.0, 0.0), (7.0, 0.0), (-5.0, 50.0)] {
            let expected = 440.0 * 2.0_f32.powf((semitones + cents / 100.0) / 12.0);
            let heard = shifted(&[
                ("semitones", semitones),
                ("cents", cents),
                ("grainMs", 60.0),
            ]);
            assert!(
                (heard / expected - 1.0).abs() < 0.03,
                "{semitones} st {cents} cents: {heard} Hz, not {expected}"
            );
        }
    }

    #[test]
    fn the_grains_keep_the_level_steady() {
        let input = sine(440.0, 0.5, RATE, 48_000);
        let out = run(
            &mut PitchShifter::new(RATE, settings(&[("semitones", 7.0)])),
            &input,
            64,
        );
        // Every 50 ms after the line fills is close to the input's level.
        for window in out[9_600..].chunks(2_400) {
            let level = rms(window);
            assert!((0.2..0.45).contains(&level), "{level}");
        }
    }

    #[test]
    fn no_shift_is_the_signal_delayed() {
        let input = sine(200.0, 0.5, RATE, 20_000);
        let out = run(
            &mut PitchShifter::new(RATE, settings(&[("semitones", 0.0), ("grainMs", 20.0)])),
            &input,
            128,
        );
        // Both grains sit still, and the one heard is half a grain behind.
        let delay = (GUARD + 0.5 * 960.0) as usize;
        for i in 5_000..20_000 {
            assert!((out[i] - input[i - delay]).abs() < 1e-3, "at {i}");
        }
    }

    #[test]
    fn no_mix_is_dry_and_any_chunking_is_the_same() {
        let input = sine(330.0, 0.5, RATE, 10_000);
        let dry = run(
            &mut PitchShifter::new(RATE, settings(&[("mix", 0.0)])),
            &input,
            77,
        );
        assert_eq!(dry, input);

        let whole = run(&mut PitchShifter::new(RATE, settings(&[])), &input, 10_000);
        let single = run(&mut PitchShifter::new(RATE, settings(&[])), &input, 1);
        assert_eq!(whole, single);
    }

    #[test]
    fn extreme_settings_stay_finite_and_bounded() {
        let input = sine(5_000.0, 1.0, RATE, 20_000);
        let mut shifter = PitchShifter::new(
            RATE,
            settings(&[("semitones", 12.0), ("cents", 100.0), ("grainMs", 10.0)]),
        );
        let out = run(&mut shifter, &input, 31);
        shifter.set_settings(settings(&[
            ("semitones", -12.0),
            ("cents", -100.0),
            ("grainMs", 200.0),
        ]));
        let after = run(&mut shifter, &input, 31);
        for sample in out.iter().chain(&after) {
            assert!(sample.is_finite() && sample.abs() < 1.5, "{sample}");
        }
    }
}

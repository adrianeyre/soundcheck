//! The Exciter Effect: brightness and air made from the sound itself.
//!
//! It splits off everything above Frequency, drives that band into a
//! saturator, and adds what comes out back to the signal. Unlike an EQ boost,
//! which can only raise what is already there, saturation makes new
//! harmonics above the band, so a dull sound gains top end it never had.
//! Drive sets how hard the band is pushed, and so how many harmonics it
//! makes; the saturator is a little lopsided, so it makes even harmonics as
//! well as odd. Amount sets how much is added back, and Mix blends the result
//! with the dry signal. A moved Frequency glides there rather than jumps.

use super::params::{Param, Settings, number, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::{Biquad, db_to_gain};

/// How lopsided the saturator is: the offset that makes even harmonics.
const BIAS: f32 = 0.3;
/// A Butterworth filter's Q.
const FLAT_Q: f32 = std::f32::consts::FRAC_1_SQRT_2;
/// How long a changed setting takes to settle, so it doesn't click.
const SMOOTHING_MS: f32 = 10.0;
/// How long a moved Frequency takes to glide to where it was set: a filter
/// that jumps rings.
const GLIDE_MS: f32 = 30.0;
/// How many samples apart the gliding filters are redesigned.
const GLIDE_STEP: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ExciterSettings {
    /// Where the band that is excited starts.
    pub frequency_hz: f32,
    pub drive_db: f32,
    /// 0..1: how much of the excited band is added back.
    pub amount: f32,
    pub mix: f32,
}

impl Default for ExciterSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Exciter, in the order a host sends them.
#[rustfmt::skip]
pub const EXCITER_PARAMS: &[Param<ExciterSettings>] = &[
    number("frequencyHz", "Frequency", "Hz", (1_000.0, 16_000.0, 3_000.0),
        |s| s.frequency_hz, |s, v| s.frequency_hz = v),
    number("driveDb", "Drive", "dB", (0.0, 24.0, 12.0),
        |s| s.drive_db, |s, v| s.drive_db = v),
    number("amount", "Amount", "", (0.0, 1.0, 0.3),
        |s| s.amount, |s, v| s.amount = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for ExciterSettings {
    const PARAMS: &'static [Param<Self>] = EXCITER_PARAMS;

    fn zeroed() -> Self {
        Self {
            frequency_hz: 0.0,
            drive_db: 0.0,
            amount: 0.0,
            mix: 0.0,
        }
    }
}

/// One side's filters: two high-passes in a row that split the band off,
/// and one after the saturator that takes away the offset and anything it
/// folded down below the band.
#[derive(Clone, Copy, Debug)]
struct Side {
    split: [Biquad; 2],
    after: Biquad,
}

impl Side {
    fn new(sample_rate: f32, frequency: f32) -> Self {
        let high_pass = Biquad::high_pass(sample_rate, frequency, FLAT_Q);
        Self {
            split: [high_pass; 2],
            after: high_pass,
        }
    }

    /// The same filters at a new frequency, carrying on where these were.
    fn retuned(&self, sample_rate: f32, frequency: f32) -> Self {
        let mut side = Self::new(sample_rate, frequency);
        for (new, old) in side.split.iter_mut().zip(&self.split) {
            new.restore_state(old);
        }
        side.after.restore_state(&self.after);
        side
    }

    /// The harmonics `x` makes, driven by `drive`.
    fn excite(&mut self, x: f32, drive: f32) -> f32 {
        let first = self.split[0].process(x);
        let band = self.split[1].process(first);
        let saturated = ((drive * band + BIAS).tanh() - BIAS.tanh()) / drive;
        self.after.process(saturated)
    }
}

#[derive(Clone, Debug)]
pub struct Exciter {
    sample_rate: f32,
    settings: ExciterSettings,
    sides: [Side; 2],
    /// Where the band starts now, gliding towards its setting.
    frequency_hz: f32,
    glide: f32,
    /// How many samples until the gliding filters are next redesigned.
    until_glide: usize,
    smoothing: f32,
    /// The drive as a gain, the amount and the mix, each easing towards its
    /// setting.
    current: [f32; 3],
}

impl Exciter {
    pub fn new(sample_rate: f32, settings: ExciterSettings) -> Self {
        Self {
            sample_rate,
            settings,
            sides: [Side::new(sample_rate, settings.frequency_hz); 2],
            frequency_hz: settings.frequency_hz,
            glide: time_coefficient(GLIDE_MS, sample_rate / GLIDE_STEP as f32),
            until_glide: 0,
            smoothing: time_coefficient(SMOOTHING_MS, sample_rate),
            current: Self::targets(settings),
        }
    }

    /// Move the band a step closer to its Frequency, every `GLIDE_STEP`
    /// samples, whatever size the blocks are.
    fn glide_frequency(&mut self) {
        if self.until_glide > 0 {
            self.until_glide -= 1;
            return;
        }
        self.until_glide = GLIDE_STEP - 1;
        let target = self.settings.frequency_hz;
        if self.frequency_hz == target {
            return;
        }
        // In octaves, so it glides as evenly down as up.
        let glided = target * (self.glide * (self.frequency_hz / target).log2()).exp2();
        self.frequency_hz = if (glided / target - 1.0).abs() < 1e-3 {
            target
        } else {
            glided
        };
        for side in &mut self.sides {
            *side = side.retuned(self.sample_rate, self.frequency_hz);
        }
    }

    fn targets(settings: ExciterSettings) -> [f32; 3] {
        [db_to_gain(settings.drive_db), settings.amount, settings.mix]
    }
}

impl StereoEffect for Exciter {
    type Settings = ExciterSettings;

    fn settings(&self) -> ExciterSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: ExciterSettings) {
        self.settings = settings;
    }

    fn settle(&mut self) {
        self.current = Self::targets(self.settings);
        if self.frequency_hz != self.settings.frequency_hz {
            self.frequency_hz = self.settings.frequency_hz;
            for side in &mut self.sides {
                *side = side.retuned(self.sample_rate, self.frequency_hz);
            }
        }
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let targets = Self::targets(self.settings);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            for (current, target) in self.current.iter_mut().zip(targets) {
                *current = target + self.smoothing * (*current - target);
            }
            self.glide_frequency();
            let [drive, amount, mix] = self.current;
            for (sample, side) in [&mut *l, &mut *r].into_iter().zip(&mut self.sides) {
                let wet = *sample + amount * side.excite(*sample, drive);
                *sample = *sample * (1.0 - mix) + wet * mix;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, rms, sine};

    const RATE: f32 = 48_000.0;

    fn run(settings: ExciterSettings, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut exciter = Exciter::new(RATE, settings);
        let mut left = input.to_vec();
        let mut right = input.to_vec();
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            exciter.process_stereo(l, r);
        }
        left
    }

    /// How strong `frequency` is in `buffer`, as a sine's amplitude.
    fn strength(buffer: &[f32], frequency: f32) -> f32 {
        let (mut re, mut im) = (0.0_f64, 0.0_f64);
        for (n, sample) in buffer.iter().enumerate() {
            let phase = std::f64::consts::TAU * f64::from(frequency) * n as f64 / f64::from(RATE);
            re += f64::from(*sample) * phase.cos();
            im += f64::from(*sample) * phase.sin();
        }
        (2.0 * re.hypot(im) / buffer.len() as f64) as f32
    }

    #[test]
    fn nothing_added_or_no_mix_is_dry() {
        let input = sine(5_000.0, 0.5, RATE, 4_800);
        for settings in [
            ExciterSettings {
                amount: 0.0,
                ..ExciterSettings::default()
            },
            ExciterSettings {
                amount: 1.0,
                mix: 0.0,
                ..ExciterSettings::default()
            },
        ] {
            assert_eq!(run(settings, &input, 64), input);
        }
    }

    #[test]
    fn it_makes_harmonics_above_the_band() {
        // 48 000 samples: a whole number of cycles of each, so they don't
        // bleed into one another.
        let input = sine(4_000.0, 0.5, RATE, 48_000);
        let settings = ExciterSettings {
            frequency_hz: 2_000.0,
            drive_db: 18.0,
            amount: 1.0,
            mix: 1.0,
        };
        let output = run(settings, &input, 64);
        let settled = &output[4_800..];
        for harmonic in [8_000.0, 12_000.0] {
            assert!(strength(&input[4_800..], harmonic) < 1e-3);
            let made = strength(settled, harmonic);
            assert!(made > 0.005, "{made} at {harmonic} Hz");
        }
    }

    #[test]
    fn it_leaves_what_is_below_the_band_alone() {
        let input = sine(100.0, 0.8, RATE, 48_000);
        let output = run(ExciterSettings::default(), &input, 64);
        let ratio = rms(&output[4_800..]) / rms(&input[4_800..]);
        assert!((ratio - 1.0).abs() < 0.01, "{ratio}");
    }

    #[test]
    fn it_is_finite_at_the_extremes_and_the_same_in_any_size_of_block() {
        let mut input = sine(9_000.0, 1.0, RATE, 4_800);
        input[100] = 1.0e6;
        let extreme = ExciterSettings {
            frequency_hz: 16_000.0,
            drive_db: 24.0,
            amount: 1.0,
            mix: 1.0,
        };
        let whole = run(extreme, &input, input.len());
        assert!(whole.iter().all(|s| s.is_finite()));
        assert_eq!(run(extreme, &input, 1), whole);
        assert_eq!(run(extreme, &input, 29), whole);
    }

    #[test]
    fn retuning_carries_on_without_a_jump() {
        let input = sine(6_000.0, 0.5, RATE, 4_800);
        let settings = ExciterSettings {
            amount: 1.0,
            ..ExciterSettings::default()
        };
        let mut exciter = Exciter::new(RATE, settings);
        let (mut left, mut right) = (input.clone(), input.clone());
        exciter.process_stereo(&mut left[..2_400], &mut right[..2_400]);
        exciter.set_settings(ExciterSettings {
            frequency_hz: 16_000.0,
            ..settings
        });
        exciter.process_stereo(&mut left[2_400..], &mut right[2_400..]);
        // Nothing on the way from one to the other is louder than either.
        let either = peak(&left[1_200..2_400]).max(peak(&left[3_600..]));
        let between = peak(&left[2_400..3_600]);
        assert!(
            between < either * 1.05,
            "a spike to {between} past {either}"
        );
    }
}

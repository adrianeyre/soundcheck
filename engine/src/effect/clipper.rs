//! The Clipper Effect: loudness by cutting the tops off the peaks.
//!
//! Input gain pushes the signal into a ceiling that nothing passes. With
//! Softness at 0 every sample over the Ceiling is cut flat to it, the way a
//! hard trance kick is pushed loud; raising Softness starts rounding the
//! peaks off further below the Ceiling, trading edge for warmth, until at 1
//! the whole wave bends smoothly into it. Unlike a Limiter it doesn't turn
//! anything down, so there's no pumping, only the grit of the flattened
//! peaks. Output sets the level after, and Mix blends it with the dry
//! signal.

use super::params::{Param, Settings, number, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::db_to_gain;

/// How long a changed setting takes to settle, so it doesn't click.
const SMOOTHING_MS: f32 = 10.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClipperSettings {
    pub input_db: f32,
    /// The level nothing leaving the clip goes past.
    pub ceiling_db: f32,
    /// 0 is a hard clip; towards 1 the knee below the Ceiling widens.
    pub softness: f32,
    pub output_db: f32,
    pub mix: f32,
}

impl Default for ClipperSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Clipper, in the order a host sends them.
#[rustfmt::skip]
pub const CLIPPER_PARAMS: &[Param<ClipperSettings>] = &[
    number("inputDb", "Input gain", "dB", (-12.0, 24.0, 0.0),
        |s| s.input_db, |s, v| s.input_db = v),
    number("ceilingDb", "Ceiling", "dB", (-24.0, 0.0, -0.3),
        |s| s.ceiling_db, |s, v| s.ceiling_db = v),
    number("softness", "Softness", "", (0.0, 1.0, 0.0),
        |s| s.softness, |s, v| s.softness = v),
    number("outputDb", "Output", "dB", (-24.0, 12.0, 0.0),
        |s| s.output_db, |s, v| s.output_db = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for ClipperSettings {
    const PARAMS: &'static [Param<Self>] = CLIPPER_PARAMS;

    fn zeroed() -> Self {
        Self {
            input_db: 0.0,
            ceiling_db: 0.0,
            softness: 0.0,
            output_db: 0.0,
            mix: 0.0,
        }
    }
}

/// `x` clipped at `ceiling`, rounding off from `knee` (at or below it)
/// upwards: straight below the knee, then a curve that meets the ceiling
/// only as `x` grows without end.
fn clip(x: f32, knee: f32, ceiling: f32) -> f32 {
    let size = x.abs();
    if size <= knee {
        return x;
    }
    let room = ceiling - knee;
    let clipped = if room <= 0.0 {
        ceiling
    } else {
        knee + room * ((size - knee) / room).tanh()
    };
    clipped.copysign(x)
}

#[derive(Clone, Debug)]
pub struct Clipper {
    settings: ClipperSettings,
    smoothing: f32,
    /// The input gain, ceiling, softness, output gain and mix, each easing
    /// towards its setting.
    current: [f32; 5],
}

impl Clipper {
    pub fn new(sample_rate: f32, settings: ClipperSettings) -> Self {
        Self {
            settings,
            smoothing: time_coefficient(SMOOTHING_MS, sample_rate),
            current: Self::targets(settings),
        }
    }

    fn targets(settings: ClipperSettings) -> [f32; 5] {
        [
            db_to_gain(settings.input_db),
            db_to_gain(settings.ceiling_db),
            settings.softness,
            db_to_gain(settings.output_db),
            settings.mix,
        ]
    }
}

impl StereoEffect for Clipper {
    type Settings = ClipperSettings;

    fn settings(&self) -> ClipperSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: ClipperSettings) {
        self.settings = settings;
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let targets = Self::targets(self.settings);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            for (current, target) in self.current.iter_mut().zip(targets) {
                *current = target + self.smoothing * (*current - target);
            }
            let [input, ceiling, softness, output, mix] = self.current;
            let knee = ceiling * (1.0 - softness);
            for sample in [&mut *l, &mut *r] {
                // A sample too big to be a number is clipped as the loudest.
                let driven = (*sample * input).clamp(-f32::MAX, f32::MAX);
                let wet = clip(driven, knee, ceiling) * output;
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

    fn run(settings: ClipperSettings, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut clipper = Clipper::new(RATE, settings);
        let mut left = input.to_vec();
        let mut right = input.to_vec();
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            clipper.process_stereo(l, r);
        }
        left
    }

    fn hard(ceiling_db: f32) -> ClipperSettings {
        ClipperSettings {
            input_db: 12.0,
            ceiling_db,
            softness: 0.0,
            output_db: 0.0,
            mix: 1.0,
        }
    }

    #[test]
    fn nothing_passes_the_ceiling_and_what_is_under_it_is_untouched() {
        let input = sine(100.0, 0.5, RATE, 4_800);
        let output = run(hard(-6.0), &input, 64);
        let ceiling = db_to_gain(-6.0);
        assert!(peak(&output) <= ceiling + 1e-6, "{}", peak(&output));
        let input_gain = db_to_gain(12.0);
        for (out, dry) in output.iter().zip(&input) {
            if (dry * input_gain).abs() < ceiling {
                assert!((out - dry * input_gain).abs() < 1e-5, "{out} against {dry}");
            } else {
                assert!((out.abs() - ceiling).abs() < 1e-6, "{out}");
            }
        }
    }

    #[test]
    fn softness_rounds_the_peaks_off_below_the_ceiling() {
        let input = sine(100.0, 0.5, RATE, 4_800);
        let hard_clip = run(hard(-6.0), &input, 64);
        let soft = run(
            ClipperSettings {
                softness: 1.0,
                ..hard(-6.0)
            },
            &input,
            64,
        );
        assert!(peak(&soft) <= db_to_gain(-6.0));
        assert!(rms(&soft) < rms(&hard_clip) * 0.98);
        // A quiet sample is bent a little too, where a hard clip leaves it.
        let quiet = run(
            ClipperSettings {
                input_db: 0.0,
                softness: 1.0,
                ..hard(0.0)
            },
            &[0.3; 16],
            16,
        );
        assert!(quiet[15] < 0.3 && quiet[15] > 0.28, "{}", quiet[15]);
    }

    #[test]
    fn no_mix_is_dry_and_the_defaults_leave_a_quiet_signal_alone() {
        let input = sine(300.0, 0.9, RATE, 4_800);
        let no_mix = ClipperSettings {
            mix: 0.0,
            ..hard(-12.0)
        };
        assert_eq!(run(no_mix, &input, 64), input);
        assert_eq!(run(ClipperSettings::default(), &input, 64), input);
    }

    #[test]
    fn it_is_finite_at_the_extremes_and_the_same_in_any_size_of_block() {
        let mut input = sine(60.0, 1.0, RATE, 4_800);
        input[100] = 1.0e30;
        input[200] = -f32::MAX;
        let extreme = ClipperSettings {
            input_db: 24.0,
            ceiling_db: -24.0,
            softness: 0.5,
            output_db: 12.0,
            mix: 1.0,
        };
        let whole = run(extreme, &input, input.len());
        assert!(whole.iter().all(|s| s.is_finite()));
        assert!(peak(&whole) <= db_to_gain(-12.0) + 1e-5);
        assert_eq!(run(extreme, &input, 1), whole);
        assert_eq!(run(extreme, &input, 13), whole);
    }
}

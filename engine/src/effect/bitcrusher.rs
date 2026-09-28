//! The Bitcrusher Effect: the sound of old samplers and game consoles.
//!
//! Bits sets how many levels each sample is rounded to, which adds a gritty
//! noise that grows as the bits fall; Downsample holds each sample for that
//! many, which folds high, clangy tones down into the audible range. Mix
//! blends it with the dry signal.

use super::params::{Param, Settings, number};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BitcrusherSettings {
    pub bits: f32,
    pub downsample: f32,
    pub mix: f32,
}

impl Default for BitcrusherSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Bitcrusher, in the order a host sends them.
#[rustfmt::skip]
pub const BITCRUSHER_PARAMS: &[Param<BitcrusherSettings>] = &[
    number::<BitcrusherSettings>("bits", "Bits", "bit", (1.0, 24.0, 8.0),
        |s| s.bits, |s, v| s.bits = v).stepped(1.0),
    number::<BitcrusherSettings>("downsample", "Downsample", "x", (1.0, 64.0, 1.0),
        |s| s.downsample, |s, v| s.downsample = v).stepped(1.0),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for BitcrusherSettings {
    const PARAMS: &'static [Param<Self>] = BITCRUSHER_PARAMS;

    fn zeroed() -> Self {
        Self {
            bits: 0.0,
            downsample: 0.0,
            mix: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Bitcrusher {
    settings: BitcrusherSettings,
    /// The sample each side is holding, and how many more frames to hold it.
    held: [f32; 2],
    remaining: usize,
}

impl Bitcrusher {
    pub fn new(settings: BitcrusherSettings) -> Self {
        Self {
            settings,
            held: [0.0; 2],
            remaining: 0,
        }
    }

    pub fn settings(&self) -> BitcrusherSettings {
        self.settings
    }

    pub fn set_settings(&mut self, settings: BitcrusherSettings) {
        self.settings = settings;
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let BitcrusherSettings {
            bits,
            downsample,
            mix,
        } = self.settings;
        let levels = 2.0_f32.powf(bits - 1.0);
        let hold = downsample.max(1.0) as usize;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            if self.remaining == 0 {
                self.held = [
                    (*l * levels).round() / levels,
                    (*r * levels).round() / levels,
                ];
                self.remaining = hold;
            }
            self.remaining -= 1;
            *l = *l * (1.0 - mix) + self.held[0] * mix;
            *r = *r * (1.0 - mix) + self.held[1] * mix;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::sine;

    fn run(settings: BitcrusherSettings, input: &[f32]) -> Vec<f32> {
        let mut crusher = Bitcrusher::new(settings);
        let mut left = input.to_vec();
        let mut right = input.to_vec();
        for (l, r) in left.chunks_mut(7).zip(right.chunks_mut(7)) {
            crusher.process_stereo(l, r);
        }
        left
    }

    #[test]
    fn fewer_bits_mean_fewer_levels() {
        let input = sine(100.0, 0.9, 48_000.0, 4_800);
        let two_bits = run(
            BitcrusherSettings {
                bits: 2.0,
                ..BitcrusherSettings::default()
            },
            &input,
        );
        for sample in &two_bits {
            assert!([-1.0, -0.5, 0.0, 0.5, 1.0].contains(sample), "{sample}");
        }
        let many = run(
            BitcrusherSettings {
                bits: 24.0,
                ..BitcrusherSettings::default()
            },
            &input,
        );
        for (out, input) in many.iter().zip(&input) {
            assert!((out - input).abs() < 1e-6);
        }
    }

    #[test]
    fn downsampling_holds_each_sample_across_blocks() {
        let input: Vec<f32> = (0..64).map(|i| i as f32 / 64.0).collect();
        let settings = BitcrusherSettings {
            bits: 24.0,
            downsample: 4.0,
            mix: 1.0,
        };
        let out = run(settings, &input);
        for (index, sample) in out.iter().enumerate() {
            assert!((sample - input[index / 4 * 4]).abs() < 1e-6, "at {index}");
        }
    }

    #[test]
    fn no_mix_is_dry() {
        let input = sine(300.0, 0.5, 48_000.0, 480);
        let settings = BitcrusherSettings {
            bits: 1.0,
            downsample: 8.0,
            mix: 0.0,
        };
        assert_eq!(run(settings, &input), input);
    }
}

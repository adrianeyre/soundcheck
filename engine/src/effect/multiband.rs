//! The Multiband Compressor Effect: a Compressor for each of three bands.
//!
//! Two crossovers split the signal into lows, mids and highs, and each band
//! has its own Threshold and Ratio, so a booming bass note can be held down
//! without ducking the hats above it, or harsh mids tamed while the lows keep
//! their weight. The crossovers glide when moved, rather than jump. They are Linkwitz-Riley filters, which add back up
//! to the signal's own level at every frequency, so with every Ratio at 1:1
//! the Multiband only shifts the phase and the tone is unchanged. Attack and
//! Release are shared by all three bands; Output sets the level after.

use super::params::{Param, Settings, number, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::{Biquad, db_to_gain, flush_denormal, gain_to_db};

/// A Butterworth filter's Q: two in a row make a Linkwitz-Riley.
const FLAT_Q: f32 = std::f32::consts::FRAC_1_SQRT_2;
/// Each band's soft knee, in dB, centred on its threshold.
const KNEE_DB: f32 = 6.0;
/// How long a changed output gain takes to settle, so it doesn't click.
const SMOOTHING_MS: f32 = 10.0;
/// How long moved crossovers take to glide to where they were set: a
/// crossover that jumps rings.
const GLIDE_MS: f32 = 30.0;
/// How many samples apart the gliding crossovers are redesigned.
const GLIDE_STEP: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MultibandSettings {
    /// Where the lows end and the mids start.
    pub low_crossover_hz: f32,
    /// Where the mids end and the highs start.
    pub high_crossover_hz: f32,
    pub low_threshold_db: f32,
    pub low_ratio: f32,
    pub mid_threshold_db: f32,
    pub mid_ratio: f32,
    pub high_threshold_db: f32,
    pub high_ratio: f32,
    /// Milliseconds.
    pub attack: f32,
    /// Milliseconds.
    pub release: f32,
    pub output_db: f32,
}

impl Default for MultibandSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Multiband Compressor, in the order a host sends them.
#[rustfmt::skip]
pub const MULTIBAND_PARAMS: &[Param<MultibandSettings>] = &[
    number("lowCrossoverHz", "Low crossover", "Hz", (40.0, 1_000.0, 200.0),
        |s| s.low_crossover_hz, |s, v| s.low_crossover_hz = v),
    number("highCrossoverHz", "High crossover", "Hz", (1_000.0, 12_000.0, 3_000.0),
        |s| s.high_crossover_hz, |s, v| s.high_crossover_hz = v),
    number("lowThresholdDb", "Low threshold", "dB", (-60.0, 0.0, -20.0),
        |s| s.low_threshold_db, |s, v| s.low_threshold_db = v),
    number("lowRatio", "Low ratio", ":1", (1.0, 20.0, 2.0),
        |s| s.low_ratio, |s, v| s.low_ratio = v),
    number("midThresholdDb", "Mid threshold", "dB", (-60.0, 0.0, -20.0),
        |s| s.mid_threshold_db, |s, v| s.mid_threshold_db = v),
    number("midRatio", "Mid ratio", ":1", (1.0, 20.0, 2.0),
        |s| s.mid_ratio, |s, v| s.mid_ratio = v),
    number("highThresholdDb", "High threshold", "dB", (-60.0, 0.0, -20.0),
        |s| s.high_threshold_db, |s, v| s.high_threshold_db = v),
    number("highRatio", "High ratio", ":1", (1.0, 20.0, 2.0),
        |s| s.high_ratio, |s, v| s.high_ratio = v),
    number("attack", "Attack", "ms", (0.1, 200.0, 10.0),
        |s| s.attack, |s, v| s.attack = v),
    number("release", "Release", "ms", (10.0, 2_000.0, 150.0),
        |s| s.release, |s, v| s.release = v),
    number("outputDb", "Output", "dB", (-24.0, 24.0, 0.0),
        |s| s.output_db, |s, v| s.output_db = v),
];

impl Settings for MultibandSettings {
    const PARAMS: &'static [Param<Self>] = MULTIBAND_PARAMS;

    fn zeroed() -> Self {
        Self {
            low_crossover_hz: 0.0,
            high_crossover_hz: 0.0,
            low_threshold_db: 0.0,
            low_ratio: 0.0,
            mid_threshold_db: 0.0,
            mid_ratio: 0.0,
            high_threshold_db: 0.0,
            high_ratio: 0.0,
            attack: 0.0,
            release: 0.0,
            output_db: 0.0,
        }
    }
}

/// How much gain reduction, in dB, a level `over_db` above the threshold
/// wants, as the Compressor works it out.
fn wanted_reduction_db(over_db: f32, slope: f32) -> f32 {
    if 2.0 * over_db <= -KNEE_DB {
        0.0
    } else if 2.0 * over_db < KNEE_DB {
        let into = over_db + KNEE_DB / 2.0;
        slope * into * into / (2.0 * KNEE_DB)
    } else {
        slope * over_db
    }
}

/// A fourth-order Linkwitz-Riley filter: two Butterworths in a row.
#[derive(Clone, Copy, Debug)]
struct LinkwitzRiley([Biquad; 2]);

impl LinkwitzRiley {
    fn low(sample_rate: f32, frequency: f32) -> Self {
        Self([Biquad::low_pass(sample_rate, frequency, FLAT_Q); 2])
    }

    fn high(sample_rate: f32, frequency: f32) -> Self {
        Self([Biquad::high_pass(sample_rate, frequency, FLAT_Q); 2])
    }

    /// Take on `other`'s memory, so a retuned filter doesn't jump.
    fn carrying_on(mut self, other: &Self) -> Self {
        for (new, old) in self.0.iter_mut().zip(&other.0) {
            new.restore_state(old);
        }
        self
    }

    fn process(&mut self, x: f32) -> f32 {
        let first = self.0[0].process(x);
        self.0[1].process(first)
    }
}

/// One side's crossovers. The lows also pass through the high crossover's
/// two halves added together, which changes only their phase, so they line
/// up with the mids and highs that were split there.
#[derive(Clone, Copy, Debug)]
struct Crossovers {
    low: LinkwitzRiley,
    rest: LinkwitzRiley,
    mid: LinkwitzRiley,
    high: LinkwitzRiley,
    aligned_low: LinkwitzRiley,
    aligned_high: LinkwitzRiley,
}

impl Crossovers {
    fn new(sample_rate: f32, low_hz: f32, high_hz: f32) -> Self {
        Self {
            low: LinkwitzRiley::low(sample_rate, low_hz),
            rest: LinkwitzRiley::high(sample_rate, low_hz),
            mid: LinkwitzRiley::low(sample_rate, high_hz),
            high: LinkwitzRiley::high(sample_rate, high_hz),
            aligned_low: LinkwitzRiley::low(sample_rate, high_hz),
            aligned_high: LinkwitzRiley::high(sample_rate, high_hz),
        }
    }

    fn retuned(&self, sample_rate: f32, low_hz: f32, high_hz: f32) -> Self {
        let new = Self::new(sample_rate, low_hz, high_hz);
        Self {
            low: new.low.carrying_on(&self.low),
            rest: new.rest.carrying_on(&self.rest),
            mid: new.mid.carrying_on(&self.mid),
            high: new.high.carrying_on(&self.high),
            aligned_low: new.aligned_low.carrying_on(&self.aligned_low),
            aligned_high: new.aligned_high.carrying_on(&self.aligned_high),
        }
    }

    /// `x` split into its lows, mids and highs.
    fn split(&mut self, x: f32) -> [f32; 3] {
        let low = self.low.process(x);
        let rest = self.rest.process(x);
        [
            self.aligned_low.process(low) + self.aligned_high.process(low),
            self.mid.process(rest),
            self.high.process(rest),
        ]
    }
}

#[derive(Clone, Debug)]
pub struct Multiband {
    sample_rate: f32,
    settings: MultibandSettings,
    sides: [Crossovers; 2],
    /// Where the crossovers are now, gliding towards their settings.
    crossovers_hz: [f32; 2],
    glide: f32,
    /// How many samples until the gliding crossovers are next redesigned.
    until_glide: usize,
    attack: f32,
    release: f32,
    smoothing: f32,
    /// Each band's gain reduction now, in dB (0 or more).
    reduction_db: [f32; 3],
    /// The output gain, easing towards its setting.
    output: f32,
}

impl Multiband {
    pub fn new(sample_rate: f32, settings: MultibandSettings) -> Self {
        let crossovers = Crossovers::new(
            sample_rate,
            settings.low_crossover_hz,
            settings.high_crossover_hz,
        );
        let mut multiband = Self {
            sample_rate,
            settings,
            sides: [crossovers; 2],
            crossovers_hz: [settings.low_crossover_hz, settings.high_crossover_hz],
            glide: time_coefficient(GLIDE_MS, sample_rate / GLIDE_STEP as f32),
            until_glide: 0,
            attack: 0.0,
            release: 0.0,
            smoothing: time_coefficient(SMOOTHING_MS, sample_rate),
            reduction_db: [0.0; 3],
            output: db_to_gain(settings.output_db),
        };
        multiband.set_settings(settings);
        multiband
    }

    /// Move the crossovers a step closer to their settings, every
    /// `GLIDE_STEP` samples, whatever size the blocks are.
    fn glide_crossovers(&mut self) {
        if self.until_glide > 0 {
            self.until_glide -= 1;
            return;
        }
        self.until_glide = GLIDE_STEP - 1;
        let targets = [
            self.settings.low_crossover_hz,
            self.settings.high_crossover_hz,
        ];
        if self.crossovers_hz == targets {
            return;
        }
        for (now, target) in self.crossovers_hz.iter_mut().zip(targets) {
            // In octaves, so it glides as evenly down as up.
            let glided = target * (self.glide * (*now / target).log2()).exp2();
            *now = if (glided / target - 1.0).abs() < 1e-3 {
                target
            } else {
                glided
            };
        }
        let [low_hz, high_hz] = self.crossovers_hz;
        for side in &mut self.sides {
            *side = side.retuned(self.sample_rate, low_hz, high_hz);
        }
    }

    /// Each band's threshold and the slope its ratio gives.
    fn bands(&self) -> [(f32, f32); 3] {
        let s = self.settings;
        let slope = |ratio: f32| 1.0 - 1.0 / ratio.max(1.0);
        [
            (s.low_threshold_db, slope(s.low_ratio)),
            (s.mid_threshold_db, slope(s.mid_ratio)),
            (s.high_threshold_db, slope(s.high_ratio)),
        ]
    }
}

impl StereoEffect for Multiband {
    type Settings = MultibandSettings;

    fn settings(&self) -> MultibandSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: MultibandSettings) {
        self.settings = settings;
        self.attack = time_coefficient(settings.attack, self.sample_rate);
        self.release = time_coefficient(settings.release, self.sample_rate);
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let bands = self.bands();
        let output = db_to_gain(self.settings.output_db);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            self.output = output + self.smoothing * (self.output - output);
            self.glide_crossovers();
            let split = [self.sides[0].split(*l), self.sides[1].split(*r)];
            let mut out = [0.0; 2];
            for (band, (threshold_db, slope)) in bands.into_iter().enumerate() {
                // The louder side, so a panned sound stays where it is.
                let level = split[0][band].abs().max(split[1][band].abs());
                let target = wanted_reduction_db(gain_to_db(level) - threshold_db, slope);
                let reduction = &mut self.reduction_db[band];
                let coefficient = if target > *reduction {
                    self.attack
                } else {
                    self.release
                };
                *reduction = flush_denormal(target + coefficient * (*reduction - target));
                let gain = db_to_gain(-*reduction);
                out[0] += split[0][band] * gain;
                out[1] += split[1][band] * gain;
            }
            *l = out[0] * self.output;
            *r = out[1] * self.output;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rms, sine};

    const RATE: f32 = 48_000.0;

    fn run(settings: MultibandSettings, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut multiband = Multiband::new(RATE, settings);
        let mut left = input.to_vec();
        let mut right = input.to_vec();
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            multiband.process_stereo(l, r);
        }
        left
    }

    /// How much louder the settled output of a sine at `frequency` is than
    /// the sine, in dB.
    fn gain_db(settings: MultibandSettings, frequency: f32) -> f32 {
        let input = sine(frequency, 0.5, RATE, 48_000);
        let output = run(settings, &input, 64);
        gain_to_db(rms(&output[24_000..]) / rms(&input[24_000..]))
    }

    fn uncompressed() -> MultibandSettings {
        MultibandSettings {
            low_ratio: 1.0,
            mid_ratio: 1.0,
            high_ratio: 1.0,
            ..MultibandSettings::default()
        }
    }

    #[test]
    fn with_no_compression_the_bands_add_back_up_flat() {
        for frequency in [40.0, 200.0, 700.0, 3_000.0, 10_000.0] {
            let gain = gain_db(uncompressed(), frequency);
            assert!(gain.abs() < 0.05, "{gain} dB at {frequency} Hz");
        }
        let louder = MultibandSettings {
            output_db: 6.0,
            ..uncompressed()
        };
        let gain = gain_db(louder, 1_000.0);
        assert!((gain - 6.0).abs() < 0.05, "{gain} dB");
    }

    #[test]
    fn each_band_is_compressed_on_its_own() {
        let low_only = MultibandSettings {
            low_threshold_db: -30.0,
            low_ratio: 10.0,
            ..uncompressed()
        };
        let low = gain_db(low_only, 60.0);
        assert!(low < -15.0, "the lows came out {low} dB");
        let high = gain_db(low_only, 10_000.0);
        assert!(high.abs() < 0.1, "the highs came out {high} dB");

        let high_only = MultibandSettings {
            high_threshold_db: -30.0,
            high_ratio: 10.0,
            ..uncompressed()
        };
        assert!(gain_db(high_only, 10_000.0) < -15.0);
        assert!(gain_db(high_only, 60.0).abs() < 0.1);
    }

    #[test]
    fn retuning_the_crossovers_while_running_is_smooth() {
        let input = sine(500.0, 0.5, RATE, 9_600);
        let mut multiband = Multiband::new(RATE, uncompressed());
        let (mut left, mut right) = (input.clone(), input.clone());
        multiband.process_stereo(&mut left[..4_800], &mut right[..4_800]);
        multiband.set_settings(MultibandSettings {
            low_crossover_hz: 800.0,
            high_crossover_hz: 1_000.0,
            ..uncompressed()
        });
        multiband.process_stereo(&mut left[4_800..], &mut right[4_800..]);
        let most = crate::dsp::measure::peak(&left);
        assert!(most < 0.75, "a spike to {most} on the change");
    }

    #[test]
    fn it_is_finite_at_the_extremes_and_the_same_in_any_size_of_block() {
        let mut input = sine(90.0, 1.0, RATE, 4_800);
        input[100] = 1.0e6;
        let extreme = MultibandSettings {
            low_crossover_hz: 1_000.0,
            high_crossover_hz: 1_000.0,
            low_threshold_db: -60.0,
            low_ratio: 20.0,
            mid_threshold_db: -60.0,
            mid_ratio: 20.0,
            high_threshold_db: 0.0,
            high_ratio: 1.0,
            attack: 0.1,
            release: 10.0,
            output_db: 24.0,
        };
        let whole = run(extreme, &input, input.len());
        assert!(whole.iter().all(|s| s.is_finite()));
        assert_eq!(run(extreme, &input, 1), whole);
        assert_eq!(run(extreme, &input, 23), whole);
    }
}

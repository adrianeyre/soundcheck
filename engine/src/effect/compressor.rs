//! The Compressor Effect: a feed-forward design with a soft knee.
//!
//! It measures each sample's level (the louder side, so a panned sound stays
//! where it is), works out from the threshold, ratio and knee how much gain
//! reduction that level wants, and smooths the reduction with separate attack
//! and release times. Makeup gain is added after.
//!
//! The attack and release settings are time constants: after a step in
//! level, the gain reduction covers 63% (1 - 1/e) of the way to its new value
//! in that time. The gain reduction is never negative, so with no makeup gain
//! the Compressor never makes anything louder.

use super::params::{Param, Settings, number};
use crate::dsp::{db_to_gain, flush_denormal, gain_to_db};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CompressorSettings {
    pub threshold_db: f32,
    pub ratio: f32,
    /// Milliseconds.
    pub attack: f32,
    /// Milliseconds.
    pub release: f32,
    pub makeup_db: f32,
    /// How wide the soft knee is, in dB, centred on the threshold: 0 is a
    /// hard knee.
    pub knee_db: f32,
}

impl Default for CompressorSettings {
    fn default() -> Self {
        Self {
            threshold_db: -18.0,
            ratio: 4.0,
            attack: 5.0,
            release: 120.0,
            makeup_db: 3.0,
            knee_db: 6.0,
        }
    }
}

/// Every setting of the Compressor, in the order a host sends them. The knee
/// came last, so a host that sends the first five still gets the rest right.
#[rustfmt::skip]
pub const COMPRESSOR_PARAMS: &[Param<CompressorSettings>] = &[
    number("thresholdDb", "Threshold", "dB", (-60.0, 0.0, -18.0),
        |s| s.threshold_db, |s, v| s.threshold_db = v),
    number("ratio", "Ratio", ":1", (1.0, 20.0, 4.0),
        |s| s.ratio, |s, v| s.ratio = v),
    number("attack", "Attack", "ms", (0.1, 200.0, 5.0),
        |s| s.attack, |s, v| s.attack = v),
    number("release", "Release", "ms", (10.0, 2_000.0, 120.0),
        |s| s.release, |s, v| s.release = v),
    number("makeupDb", "Makeup gain", "dB", (0.0, 24.0, 3.0),
        |s| s.makeup_db, |s, v| s.makeup_db = v),
    number("kneeDb", "Knee", "dB", (0.0, 24.0, 6.0),
        |s| s.knee_db, |s, v| s.knee_db = v),
];

impl Settings for CompressorSettings {
    const PARAMS: &'static [Param<Self>] = COMPRESSOR_PARAMS;

    fn zeroed() -> Self {
        Self {
            threshold_db: 0.0,
            ratio: 0.0,
            attack: 0.0,
            release: 0.0,
            makeup_db: 0.0,
            knee_db: 0.0,
        }
    }
}

/// How much gain reduction, in dB, a level `over_db` above the threshold
/// wants: none below the knee, `slope` dB per dB above it, and a curve
/// joining the two across the knee.
fn wanted_reduction_db(over_db: f32, slope: f32, knee_db: f32) -> f32 {
    if 2.0 * over_db <= -knee_db {
        0.0
    } else if 2.0 * over_db < knee_db {
        let into = over_db + knee_db / 2.0;
        slope * into * into / (2.0 * knee_db)
    } else {
        slope * over_db
    }
}

#[derive(Clone, Debug)]
pub struct Compressor {
    sample_rate: f32,
    settings: CompressorSettings,
    threshold_db: f32,
    slope: f32,
    knee_db: f32,
    attack_coefficient: f32,
    release_coefficient: f32,
    makeup_db: f32,
    reduction_db: f32,
    /// The most gain reduction in the latest block, for the meter.
    meter_db: f32,
}

impl Compressor {
    pub fn new(sample_rate: f32, settings: CompressorSettings) -> Self {
        let coefficient = |ms: f32| (-1.0 / (ms / 1_000.0 * sample_rate).max(1.0)).exp();
        Self {
            sample_rate,
            settings,
            threshold_db: settings.threshold_db,
            slope: 1.0 - 1.0 / settings.ratio.max(1.0),
            knee_db: settings.knee_db.max(0.0),
            attack_coefficient: coefficient(settings.attack),
            release_coefficient: coefficient(settings.release),
            makeup_db: settings.makeup_db,
            reduction_db: 0.0,
            meter_db: 0.0,
        }
    }

    pub fn settings(&self) -> CompressorSettings {
        self.settings
    }

    /// Change the settings while running, keeping the gain reduction where
    /// it is, so the level doesn't jump.
    pub fn set_settings(&mut self, settings: CompressorSettings) {
        let (reduction_db, meter_db) = (self.reduction_db, self.meter_db);
        *self = Self::new(self.sample_rate, settings);
        self.reduction_db = reduction_db;
        self.meter_db = meter_db;
    }

    /// The current gain reduction, in dB (0 or more).
    #[cfg(test)]
    pub fn reduction_db(&self) -> f32 {
        self.reduction_db
    }

    /// The gain-reduction meter: the most gain reduction, in dB (0 or
    /// more), in the latest block processed.
    pub fn meter_db(&self) -> f32 {
        self.meter_db
    }

    /// Both sides at once, measuring the louder of the two, so compression
    /// never pulls a panned sound across the stereo image.
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let mut meter_db: f32 = 0.0;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let gain = self.next_gain(l.abs().max(r.abs()));
            meter_db = meter_db.max(self.reduction_db);
            *l *= gain;
            *r *= gain;
        }
        self.meter_db = meter_db;
    }

    /// The gain for a sample at `level`, moving the gain reduction towards
    /// where this level wants it.
    fn next_gain(&mut self, level: f32) -> f32 {
        let over = gain_to_db(level) - self.threshold_db;
        let target = wanted_reduction_db(over, self.slope, self.knee_db);
        let coefficient = if target > self.reduction_db {
            self.attack_coefficient
        } else {
            self.release_coefficient
        };
        self.reduction_db = flush_denormal(target + coefficient * (self.reduction_db - target));
        db_to_gain(self.makeup_db - self.reduction_db)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, sine};

    const RATE: f32 = 48_000.0;

    /// Compress a mono signal, as a pair of identical sides.
    fn process(compressor: &mut Compressor, buffer: &mut [f32]) {
        let mut other = buffer.to_vec();
        compressor.process_stereo(buffer, &mut other);
    }

    fn settings() -> CompressorSettings {
        CompressorSettings {
            threshold_db: -20.0,
            ratio: 4.0,
            attack: 1.0,
            release: 50.0,
            makeup_db: 0.0,
            knee_db: 0.0,
        }
    }

    /// The gain reduction, in dB, each sample of `input` was given.
    fn reductions(settings: CompressorSettings, input: &[f32]) -> Vec<f32> {
        let mut compressor = Compressor::new(RATE, settings);
        let mut output = input.to_vec();
        process(&mut compressor, &mut output);
        output
            .iter()
            .zip(input)
            .map(|(out, i)| -gain_to_db(out / i))
            .collect()
    }

    /// How long, in ms, after `from` the gain reduction first gets past
    /// `level`, moving in the direction it moves.
    fn time_to_ms(reduction: &[f32], from: usize, level: f32) -> f32 {
        let rising = reduction[from] < level;
        let at = reduction[from..]
            .iter()
            .position(|&db| if rising { db >= level } else { db <= level })
            .expect("the reduction gets there");
        at as f32 / RATE * 1_000.0
    }

    #[test]
    fn gain_reduction_on_a_steady_tone_matches_the_ratio() {
        // (input peak dBFS, threshold, ratio): the peaks come out at the
        // threshold plus the overshoot divided by the ratio.
        for (input_db, threshold_db, ratio) in [
            (0.0, -20.0, 4.0),
            (-6.0, -30.0, 2.0),
            (-3.0, -33.0, 10.0),
            (0.0, -12.0, 20.0),
        ] {
            let mut compressor = Compressor::new(
                RATE,
                CompressorSettings {
                    threshold_db,
                    ratio,
                    release: 500.0,
                    ..settings()
                },
            );
            let mut buffer = sine(1_000.0, db_to_gain(input_db), RATE, 48_000);
            process(&mut compressor, &mut buffer);

            let over = input_db - threshold_db;
            let expected = threshold_db + over / ratio;
            let settled = gain_to_db(peak(&buffer[24_000..]));
            assert!(
                (settled - expected).abs() < 0.5,
                "{input_db} dBFS at {threshold_db} dB {ratio}:1 came out at {settled} dB, not {expected}"
            );
            let meter = compressor.meter_db();
            assert!(
                (meter - (over - over / ratio)).abs() < 0.5,
                "the meter shows {meter} dB"
            );
        }
    }

    #[test]
    fn the_soft_knee_eases_in_around_the_threshold() {
        let knee = CompressorSettings {
            knee_db: 12.0,
            release: 500.0,
            ..settings()
        };
        let settled = |settings: CompressorSettings, level_db: f32| {
            let input = vec![db_to_gain(level_db); 24_000];
            reductions(settings, &input)[23_999]
        };
        // Below the knee, nothing; at the threshold, a quarter of the knee's
        // reduction; well above it, the ratio exactly.
        assert!(settled(knee, -27.0).abs() < 1e-3);
        assert!((settled(knee, -20.0) - 0.75 * 12.0 / 8.0).abs() < 0.01);
        assert!(settled(settings(), -20.0).abs() < 1e-3, "a hard knee");
        assert!((settled(knee, -4.0) - 0.75 * 16.0).abs() < 0.01);
        // The curve never bends back: more level, more reduction.
        let mut last = 0.0;
        for step in 0..60 {
            let db = settled(knee, -40.0 + step as f32 * 0.5);
            assert!(db >= last - 1e-4, "{db} dB after {last} dB");
            last = db;
        }
    }

    #[test]
    fn attack_and_release_times_match_their_settings() {
        for (attack, release) in [(1.0, 20.0), (10.0, 100.0), (50.0, 500.0), (200.0, 2_000.0)] {
            let settings = CompressorSettings {
                threshold_db: -26.0,
                ratio: 5.0,
                attack,
                release,
                ..settings()
            };
            // A step up to -6 dBFS, 16 dB of reduction once settled, then a
            // step down to below the threshold, where it lets go.
            let hold = (RATE * 10.0 * attack.max(release) / 1_000.0) as usize;
            let mut input = vec![0.5; hold];
            input.extend(vec![0.001; hold]);
            let reduction = reductions(settings, &input);
            let full = 0.8 * (gain_to_db(0.5) + 26.0);
            assert!((reduction[hold - 1] - full).abs() < 0.01);

            let attacked = time_to_ms(&reduction, 0, full * (1.0 - (-1.0f32).exp()));
            assert!(
                (attacked - attack).abs() <= attack * 0.05 + 0.05,
                "attack {attacked} ms, set to {attack} ms"
            );
            let released = time_to_ms(&reduction, hold, full * (-1.0f32).exp());
            assert!(
                (released - release).abs() <= release * 0.05,
                "release {released} ms, set to {release} ms"
            );
        }
    }

    #[test]
    fn nothing_goes_over_0_dbfs_without_makeup_gain() {
        // A noisy, bursty signal peaking just under full scale, through
        // settings across the table's ranges, makeup at 0.
        let mut seed = 0x1234_5678_u32;
        let mut noise = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / (1 << 23) as f32 - 1.0
        };
        let input: Vec<f32> = (0..48_000)
            .map(|n| {
                let burst = if (n / 2_400) % 2 == 0 { 0.999 } else { 0.05 };
                burst * noise()
            })
            .chain(sine(60.0, 0.999, RATE, 24_000))
            .collect();
        for threshold_db in [-60.0, -18.0, 0.0] {
            for ratio in [1.0, 4.0, 20.0] {
                for (attack, release) in [(0.1, 10.0), (200.0, 2_000.0)] {
                    for knee_db in [0.0, 24.0] {
                        let mut compressor = Compressor::new(
                            RATE,
                            CompressorSettings {
                                threshold_db,
                                ratio,
                                attack,
                                release,
                                makeup_db: 0.0,
                                knee_db,
                            },
                        );
                        let mut output = input.clone();
                        for block in output.chunks_mut(128) {
                            process(&mut compressor, block);
                        }
                        for (out, i) in output.iter().zip(&input) {
                            assert!(out.abs() <= i.abs() && out.abs() < 1.0, "{i} became {out}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn leaves_a_quiet_signal_alone() {
        let mut compressor = Compressor::new(RATE, settings());
        let quiet = sine(1_000.0, 0.05, RATE, 4_800);
        let mut buffer = quiet.clone();
        process(&mut compressor, &mut buffer);
        assert_eq!(buffer, quiet);
        assert_eq!(compressor.meter_db(), 0.0);
    }

    #[test]
    fn recovers_after_the_loud_part_stops() {
        let mut compressor = Compressor::new(RATE, settings());
        process(&mut compressor, &mut sine(1_000.0, 1.0, RATE, 4_800));
        let reduced = compressor.reduction_db();
        assert!(compressor.meter_db() >= reduced);
        for _ in 0..375 {
            process(&mut compressor, &mut [0.0; 128]);
        }
        assert!(compressor.reduction_db() < reduced / 100.0);
        assert!(
            compressor.meter_db() < reduced / 100.0,
            "the meter falls too"
        );
    }

    #[test]
    fn makeup_gain_raises_the_level() {
        let mut compressor = Compressor::new(
            RATE,
            CompressorSettings {
                makeup_db: 6.0,
                ..settings()
            },
        );
        let mut buffer = sine(1_000.0, 0.05, RATE, 4_800);
        process(&mut compressor, &mut buffer);
        assert!((peak(&buffer) - 0.05 * db_to_gain(6.0)).abs() < 1e-3);
    }

    #[test]
    fn a_host_sending_the_first_five_settings_gets_the_default_knee() {
        let settings = CompressorSettings::from_flat(&[-30.0, 2.0, 10.0, 100.0, 0.0]);
        assert_eq!(settings.threshold_db, -30.0);
        assert_eq!(settings.knee_db, 6.0);
    }
}

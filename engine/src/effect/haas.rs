//! The Haas Widener Effect: makes a part sound wider by playing one side a
//! little late.
//!
//! The ear hears a copy that arrives up to about 40 ms after the first as
//! part of the same sound, placed towards the side that came first, so
//! delaying one side by Delay spreads a mono part across the stereo image
//! without an echo. Delayed side picks which side waits; the other passes
//! untouched. Delayed level turns the late side down, which keeps the image
//! from leaning and softens the comb filtering heard when the two sides are
//! summed to mono. Mix blends the delayed side with its dry signal.
//!
//! The delay is allocated for the longest time up front, and the delay,
//! level and side glide to a new setting rather than jumping to it, so
//! moving them never clicks.

use super::params::{Param, Settings, choice, number, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::{db_to_gain, flush_denormal};

const MAX_DELAY_MS: f32 = 40.0;
/// The sides the `side` setting picks, in order.
pub const HAAS_SIDES: &[&str] = &["left", "right"];
/// How long the delay, level and side take to glide to a new setting.
const GLIDE_MS: f32 = 30.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HaasSettings {
    /// An index into `HAAS_SIDES`: the side that is delayed.
    pub side: usize,
    pub delay_ms: f32,
    /// The delayed side's level, in decibels.
    pub level_db: f32,
    pub mix: f32,
}

impl Default for HaasSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Haas Widener, in the order a host sends them.
#[rustfmt::skip]
pub const HAAS_PARAMS: &[Param<HaasSettings>] = &[
    choice("side", "Delayed side", HAAS_SIDES, 1,
        |s| s.side as f32, |s, v| s.side = v as usize),
    number("delayMs", "Delay", "ms", (0.0, MAX_DELAY_MS, 15.0),
        |s| s.delay_ms, |s, v| s.delay_ms = v),
    number("levelDb", "Delayed level", "dB", (-24.0, 0.0, -2.0),
        |s| s.level_db, |s, v| s.level_db = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for HaasSettings {
    const PARAMS: &'static [Param<Self>] = HAAS_PARAMS;

    fn zeroed() -> Self {
        Self {
            side: 0,
            delay_ms: 0.0,
            level_db: 0.0,
            mix: 0.0,
        }
    }
}

/// How much of each side is the delayed one, 0 or 1, for `side`.
fn side_amounts(side: usize) -> [f32; 2] {
    if side == 0 { [1.0, 0.0] } else { [0.0, 1.0] }
}

#[derive(Clone, Debug)]
pub struct Haas {
    sample_rate: f32,
    settings: HaasSettings,
    glide: f32,
    /// One line per side, both always written, so the side can change
    /// without a gap in the delayed signal.
    lines: [Vec<f32>; 2],
    write: usize,
    /// The delay in samples, the delayed level and how delayed each side is,
    /// each on its way to its setting.
    delay: f32,
    level: f32,
    amounts: [f32; 2],
}

impl Haas {
    pub fn new(sample_rate: f32, settings: HaasSettings) -> Self {
        // Room for the longest delay and the sample after it to interpolate
        // towards.
        let capacity = (MAX_DELAY_MS / 1_000.0 * sample_rate).ceil() as usize + 4;
        Self {
            sample_rate,
            settings,
            glide: time_coefficient(GLIDE_MS, sample_rate),
            lines: [vec![0.0; capacity], vec![0.0; capacity]],
            write: 0,
            delay: settings.delay_ms / 1_000.0 * sample_rate,
            level: db_to_gain(settings.level_db),
            amounts: side_amounts(settings.side),
        }
    }

    /// `line` read `delay` samples behind the sample just written, between
    /// samples.
    fn read(line: &[f32], write: usize, delay: f32) -> f32 {
        let length = line.len();
        let whole = delay.floor();
        let fraction = delay - whole;
        let at = (write + length - whole as usize) % length;
        let before = (at + length - 1) % length;
        line[at] * (1.0 - fraction) + line[before] * fraction
    }
}

impl StereoEffect for Haas {
    type Settings = HaasSettings;

    fn settings(&self) -> HaasSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: HaasSettings) {
        self.settings = settings;
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let HaasSettings {
            side,
            delay_ms,
            level_db,
            mix,
        } = self.settings;
        let length = self.lines[0].len();
        let target_delay = (delay_ms / 1_000.0 * self.sample_rate).clamp(0.0, (length - 2) as f32);
        let target_level = db_to_gain(level_db);
        let target_amounts = side_amounts(side);
        let glide = self.glide;
        let towards = |value: &mut f32, target: f32| *value = target + (*value - target) * glide;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            towards(&mut self.delay, target_delay);
            towards(&mut self.level, target_level);
            for (amount, target) in self.amounts.iter_mut().zip(target_amounts) {
                towards(amount, target);
            }
            for ((sample, line), amount) in [l, r]
                .into_iter()
                .zip(self.lines.iter_mut())
                .zip(self.amounts)
            {
                line[self.write] = flush_denormal(*sample);
                let delayed = Self::read(line, self.write, self.delay);
                let wet = *sample * (1.0 - mix) + self.level * delayed * mix;
                *sample += (wet - *sample) * amount;
            }
            self.write = (self.write + 1) % length;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{max_jump, sine};

    const RATE: f32 = 48_000.0;

    fn settings(side: usize, delay_ms: f32, level_db: f32, mix: f32) -> HaasSettings {
        HaasSettings {
            side,
            delay_ms,
            level_db,
            mix,
        }
    }

    fn run(settings: HaasSettings, input: &[f32], chunk: usize) -> (Vec<f32>, Vec<f32>) {
        let mut haas = Haas::new(RATE, settings);
        let (mut left, mut right) = (input.to_vec(), input.to_vec());
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            haas.process_stereo(l, r);
        }
        (left, right)
    }

    #[test]
    fn the_chosen_side_is_late_and_quieter_and_the_other_untouched() {
        let mut impulse = vec![0.0; 4_000];
        impulse[10] = 1.0;
        let (left, right) = run(settings(1, 20.0, -6.0, 1.0), &impulse, 128);
        assert_eq!(left, impulse);
        // 20 ms at 48 kHz.
        assert!((right[10 + 960] - db_to_gain(-6.0)).abs() < 1e-4);
        assert!(
            right
                .iter()
                .enumerate()
                .all(|(i, s)| i == 970 || s.abs() < 1e-6)
        );

        let (left, right) = run(settings(0, 20.0, 0.0, 1.0), &impulse, 128);
        assert_eq!(right, impulse);
        assert!((left[970] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn no_mix_is_dry() {
        let input = sine(300.0, 0.5, RATE, 4_800);
        let (left, right) = run(settings(1, 40.0, -24.0, 0.0), &input, 64);
        assert_eq!(left, input);
        assert_eq!(right, input);
    }

    #[test]
    fn changing_the_delay_and_side_glides_without_a_click() {
        let input = sine(200.0, 0.5, RATE, 48_000);
        let mut haas = Haas::new(RATE, settings(1, 0.0, 0.0, 1.0));
        let (mut left, mut right) = (input.clone(), input.clone());
        for (index, (l, r)) in left.chunks_mut(256).zip(right.chunks_mut(256)).enumerate() {
            if index == 60 {
                haas.set_settings(settings(0, MAX_DELAY_MS, -12.0, 1.0));
            }
            haas.process_stereo(l, r);
        }
        let steepest = max_jump(&input);
        assert!(max_jump(&left) < steepest * 1.5, "{}", max_jump(&left));
        assert!(max_jump(&right) < steepest * 1.5, "{}", max_jump(&right));
    }

    #[test]
    fn odd_chunks_render_the_same_as_one_block() {
        let input = sine(330.0, 0.5, RATE, 9_000);
        let whole = run(settings(0, 12.3, -3.0, 0.8), &input, input.len());
        assert_eq!(whole, run(settings(0, 12.3, -3.0, 0.8), &input, 1));
        assert_eq!(whole, run(settings(0, 12.3, -3.0, 0.8), &input, 37));
    }
}

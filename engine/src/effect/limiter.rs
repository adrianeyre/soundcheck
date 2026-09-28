//! The Limiter Effect: as loud as it can go, and never past the ceiling.
//!
//! Input gain turns the signal up; the Limiter then holds it back by
//! Lookahead, so it can see each peak coming and bring the gain down before
//! it arrives rather than clipping it. The gain falls towards the least that
//! any peak in the lookahead window allows and recovers with Release. As a
//! last guarantee, each sample leaving is never louder than the ceiling.
//!
//! The lookahead line and the window of peaks are sized for the longest
//! lookahead up front, so nothing allocates while it runs.

use super::params::{Param, Settings, number, time_coefficient};
use crate::dsp::{db_to_gain, flush_denormal, gain_to_db};

const MAX_LOOKAHEAD_MS: f32 = 10.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LimiterSettings {
    pub input_gain_db: f32,
    pub ceiling_db: f32,
    pub release: f32,
    pub lookahead: f32,
}

impl Default for LimiterSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Limiter, in the order a host sends them.
#[rustfmt::skip]
pub const LIMITER_PARAMS: &[Param<LimiterSettings>] = &[
    number("inputGainDb", "Input gain", "dB", (0.0, 24.0, 0.0),
        |s| s.input_gain_db, |s, v| s.input_gain_db = v),
    number("ceilingDb", "Ceiling", "dB", (-12.0, 0.0, -0.3),
        |s| s.ceiling_db, |s, v| s.ceiling_db = v),
    number("release", "Release", "ms", (1.0, 1_000.0, 50.0),
        |s| s.release, |s, v| s.release = v),
    number("lookahead", "Lookahead", "ms", (0.0, MAX_LOOKAHEAD_MS, 3.0),
        |s| s.lookahead, |s, v| s.lookahead = v),
];

impl Settings for LimiterSettings {
    const PARAMS: &'static [Param<Self>] = LIMITER_PARAMS;

    fn zeroed() -> Self {
        Self {
            input_gain_db: 0.0,
            ceiling_db: 0.0,
            release: 0.0,
            lookahead: 0.0,
        }
    }
}

/// The least of the last `window` values pushed, kept as a queue in which
/// each value is less than the ones after it, so both ends move in constant
/// time. The storage is fixed at the longest window.
#[derive(Clone, Debug)]
struct WindowMinimum {
    /// Each value with the count at which it was pushed.
    queue: Vec<(u64, f32)>,
    head: usize,
    len: usize,
    count: u64,
}

impl WindowMinimum {
    fn new(capacity: usize) -> Self {
        Self {
            queue: vec![(0, 0.0); capacity],
            head: 0,
            len: 0,
            count: 0,
        }
    }

    fn at(&self, offset: usize) -> usize {
        (self.head + offset) % self.queue.len()
    }

    /// Push `value` and answer the least of the last `window` pushed.
    fn push(&mut self, value: f32, window: usize) -> f32 {
        while self.len > 0 && self.queue[self.at(self.len - 1)].1 >= value {
            self.len -= 1;
        }
        let back = self.at(self.len);
        self.queue[back] = (self.count, value);
        self.len += 1;
        self.count += 1;
        while self.count - self.queue[self.head].0 > window as u64 {
            self.head = self.at(1);
            self.len -= 1;
        }
        self.queue[self.head].1
    }
}

#[derive(Clone, Debug)]
pub struct Limiter {
    sample_rate: f32,
    settings: LimiterSettings,
    input_gain: f32,
    ceiling: f32,
    release: f32,
    lookahead: usize,
    left: Vec<f32>,
    right: Vec<f32>,
    write: usize,
    window: WindowMinimum,
    gain: f32,
    meter_db: f32,
}

impl Limiter {
    pub fn new(sample_rate: f32, settings: LimiterSettings) -> Self {
        let longest = (MAX_LOOKAHEAD_MS / 1_000.0 * sample_rate).ceil() as usize;
        let mut limiter = Self {
            sample_rate,
            settings,
            input_gain: 1.0,
            ceiling: 1.0,
            release: 0.0,
            lookahead: 0,
            left: vec![0.0; longest + 1],
            right: vec![0.0; longest + 1],
            write: 0,
            window: WindowMinimum::new(longest + 2),
            gain: 1.0,
            meter_db: 0.0,
        };
        limiter.set_settings(settings);
        limiter
    }

    pub fn settings(&self) -> LimiterSettings {
        self.settings
    }

    pub fn set_settings(&mut self, settings: LimiterSettings) {
        self.settings = settings;
        self.input_gain = db_to_gain(settings.input_gain_db);
        self.ceiling = db_to_gain(settings.ceiling_db);
        self.release = time_coefficient(settings.release, self.sample_rate);
        let samples = (settings.lookahead / 1_000.0 * self.sample_rate).round() as usize;
        self.lookahead = samples.min(self.left.len() - 1);
    }

    /// How far the Limiter pulled the level down in the latest block, in dB
    /// (0 or more).
    pub fn meter_db(&self) -> f32 {
        self.meter_db
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let length = self.left.len();
        // The gain falls far enough to meet a peak within the lookahead.
        let attack = 1.0 - (-4.0 / (self.lookahead.max(1) as f32)).exp();
        let mut least: f32 = 1.0;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let (in_left, in_right) = (*l * self.input_gain, *r * self.input_gain);
            let wanted = |peak: f32| {
                if peak > self.ceiling {
                    self.ceiling / peak
                } else {
                    1.0
                }
            };
            let target = self.window.push(
                wanted(in_left.abs().max(in_right.abs())),
                self.lookahead + 1,
            );
            self.gain = if target < self.gain {
                self.gain + attack * (target - self.gain)
            } else {
                target + self.release * (self.gain - target)
            };
            self.gain = flush_denormal(self.gain);

            self.left[self.write] = in_left;
            self.right[self.write] = in_right;
            let read = (self.write + length - self.lookahead) % length;
            let (out_left, out_right) = (self.left[read], self.right[read]);
            self.write = (self.write + 1) % length;

            let gain = self.gain.min(wanted(out_left.abs().max(out_right.abs())));
            least = least.min(gain);
            *l = out_left * gain;
            *r = out_right * gain;
        }
        self.meter_db = -gain_to_db(least).min(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, sine};

    const RATE: f32 = 48_000.0;

    fn run(limiter: &mut Limiter, input: &[f32]) -> Vec<f32> {
        let mut left = input.to_vec();
        let mut right = input.to_vec();
        for (l, r) in left.chunks_mut(100).zip(right.chunks_mut(100)) {
            limiter.process_stereo(l, r);
        }
        left
    }

    #[test]
    fn a_loud_signal_never_passes_the_ceiling() {
        for lookahead in [0.0, 3.0, 10.0] {
            let settings = LimiterSettings {
                input_gain_db: 12.0,
                lookahead,
                ..LimiterSettings::default()
            };
            let mut limiter = Limiter::new(RATE, settings);
            let out = run(&mut limiter, &sine(100.0, 0.9, RATE, 48_000));
            assert!(peak(&out) <= db_to_gain(-0.3) + 1e-5, "{}", peak(&out));
            assert!(peak(&out[24_000..]) > 0.9, "and still loud");
            assert!(limiter.meter_db() > 3.0);
        }
    }

    #[test]
    fn a_quiet_signal_is_only_held_back_by_the_lookahead() {
        let mut limiter = Limiter::new(RATE, LimiterSettings::default());
        let input = sine(440.0, 0.5, RATE, 4_800);
        let out = run(&mut limiter, &input);
        // 3 ms at 48 kHz.
        assert!(out[..144].iter().all(|&s| s == 0.0));
        for (out, input) in out[144..].iter().zip(&input) {
            assert!((out - input).abs() < 1e-6);
        }
        assert_eq!(limiter.meter_db(), 0.0);
    }

    #[test]
    fn the_window_minimum_forgets_what_leaves_it() {
        let mut window = WindowMinimum::new(5);
        assert_eq!(window.push(0.5, 3), 0.5);
        assert_eq!(window.push(0.9, 3), 0.5);
        assert_eq!(window.push(0.7, 3), 0.5);
        assert_eq!(window.push(0.8, 3), 0.7, "0.5 left the window");
        assert_eq!(window.push(1.0, 3), 0.7);
        assert_eq!(window.push(1.0, 3), 0.8);
        assert_eq!(window.push(0.1, 3), 0.1);
    }
}

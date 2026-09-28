//! The Chorus Effect: copies of the signal, each a little late and a little
//! out of tune, which make one voice sound like several.
//!
//! One short delay line per side is read at a time that swings around Delay
//! by up to Depth, at Rate, so the copy drifts ahead and behind and bends in
//! pitch as it does. The right side's swing runs behind the left's by up to
//! half a cycle (Width), which spreads the sound across the stereo image.
//! Feedback puts some of each copy back in, towards a flanger's ring.
//!
//! The lines are allocated for the longest time up front, so changing any
//! setting never allocates.

use std::f32::consts::TAU;

use super::params::{Param, Settings, number};
use crate::dsp::flush_denormal;

const MAX_DELAY_MS: f32 = 30.0;
const MAX_DEPTH_MS: f32 = 10.0;
const MAX_FEEDBACK: f32 = 0.9;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChorusSettings {
    pub rate_hz: f32,
    pub depth_ms: f32,
    pub delay_ms: f32,
    pub feedback: f32,
    /// 0..=1: how far apart the sides swing, up to half a cycle.
    pub width: f32,
    pub mix: f32,
}

impl Default for ChorusSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Chorus, in the order a host sends them.
#[rustfmt::skip]
pub const CHORUS_PARAMS: &[Param<ChorusSettings>] = &[
    number("rateHz", "Rate", "Hz", (0.05, 8.0, 0.8),
        |s| s.rate_hz, |s, v| s.rate_hz = v),
    number("depthMs", "Depth", "ms", (0.0, MAX_DEPTH_MS, 3.0),
        |s| s.depth_ms, |s, v| s.depth_ms = v),
    number("delayMs", "Delay", "ms", (1.0, MAX_DELAY_MS, 12.0),
        |s| s.delay_ms, |s, v| s.delay_ms = v),
    number("feedback", "Feedback", "", (0.0, MAX_FEEDBACK, 0.0),
        |s| s.feedback, |s, v| s.feedback = v),
    number("width", "Width", "", (0.0, 1.0, 1.0),
        |s| s.width, |s, v| s.width = v),
    number("mix", "Mix", "", (0.0, 1.0, 0.5),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for ChorusSettings {
    const PARAMS: &'static [Param<Self>] = CHORUS_PARAMS;

    fn zeroed() -> Self {
        Self {
            rate_hz: 0.0,
            depth_ms: 0.0,
            delay_ms: 0.0,
            feedback: 0.0,
            width: 0.0,
            mix: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Chorus {
    sample_rate: f32,
    settings: ChorusSettings,
    left: Vec<f32>,
    right: Vec<f32>,
    write: usize,
    /// Where in its cycle the left side's swing is, 0..1.
    phase: f32,
}

impl Chorus {
    pub fn new(sample_rate: f32, settings: ChorusSettings) -> Self {
        // Room for the longest delay plus the widest swing, and the sample
        // after it to interpolate towards.
        let capacity = ((MAX_DELAY_MS + MAX_DEPTH_MS) / 1_000.0 * sample_rate).ceil() as usize + 4;
        Self {
            sample_rate,
            settings,
            left: vec![0.0; capacity],
            right: vec![0.0; capacity],
            write: 0,
            phase: 0.0,
        }
    }

    pub fn settings(&self) -> ChorusSettings {
        self.settings
    }

    pub fn set_settings(&mut self, settings: ChorusSettings) {
        self.settings = settings;
    }

    /// The line read `delay` samples behind the write, between samples.
    fn read(line: &[f32], write: usize, delay: f32) -> f32 {
        let length = line.len();
        let whole = delay.floor();
        let fraction = delay - whole;
        let at = (write + length * 2 - whole as usize) % length;
        let before = (at + length - 1) % length;
        line[at] * (1.0 - fraction) + line[before] * fraction
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let ChorusSettings {
            rate_hz,
            depth_ms,
            delay_ms,
            feedback,
            width,
            mix,
        } = self.settings;
        let per_ms = self.sample_rate / 1_000.0;
        let (centre, swing) = (delay_ms * per_ms, 0.5 * depth_ms * per_ms);
        let increment = rate_hz / self.sample_rate;
        let offset = 0.5 * width;
        let length = self.left.len();
        let longest = (length - 2) as f32;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let delay_left =
                (centre + swing * (1.0 + (TAU * self.phase).sin())).clamp(1.0, longest);
            let delay_right =
                (centre + swing * (1.0 + (TAU * (self.phase + offset)).sin())).clamp(1.0, longest);
            let wet_left = Self::read(&self.left, self.write, delay_left);
            let wet_right = Self::read(&self.right, self.write, delay_right);
            self.left[self.write] = flush_denormal(*l + feedback * wet_left);
            self.right[self.write] = flush_denormal(*r + feedback * wet_right);
            self.write = (self.write + 1) % length;
            self.phase = (self.phase + increment).fract();

            *l = *l * (1.0 - mix) + wet_left * mix;
            *r = *r * (1.0 - mix) + wet_right * mix;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> ChorusSettings {
        let mut settings = ChorusSettings::default();
        for (name, value) in changes {
            let param = CHORUS_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(settings: ChorusSettings, left: &[f32], right: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let mut chorus = Chorus::new(RATE, settings);
        let (mut left, mut right) = (left.to_vec(), right.to_vec());
        for (l, r) in left.chunks_mut(128).zip(right.chunks_mut(128)) {
            chorus.process_stereo(l, r);
        }
        (left, right)
    }

    #[test]
    fn with_no_swing_it_is_one_copy_at_the_delay() {
        let mut impulse = vec![0.0; 2_000];
        impulse[0] = 1.0;
        let (left, right) = run(
            settings(&[("depthMs", 0.0), ("delayMs", 12.0), ("mix", 1.0)]),
            &impulse,
            &impulse,
        );
        // 12 ms at 48 kHz.
        assert!((left[576] - 1.0).abs() < 1e-6);
        assert!(
            left.iter()
                .enumerate()
                .all(|(i, s)| i == 576 || s.abs() < 1e-6)
        );
        assert_eq!(left, right);
    }

    #[test]
    fn the_width_swings_the_sides_apart() {
        let input = sine(440.0, 0.5, RATE, 48_000);
        let (left, right) = run(settings(&[("mix", 1.0), ("depthMs", 8.0)]), &input, &input);
        let difference: f32 = left.iter().zip(&right).map(|(l, r)| (l - r).abs()).sum();
        assert!(difference > 100.0, "{difference}");

        let (left, right) = run(
            settings(&[("mix", 1.0), ("depthMs", 8.0), ("width", 0.0)]),
            &input,
            &input,
        );
        assert_eq!(left, right, "no width, no spread");
    }

    #[test]
    fn feedback_stays_bounded_and_no_mix_is_dry() {
        let input = sine(300.0, 0.5, RATE, 96_000);
        let (left, _) = run(settings(&[("feedback", 0.9), ("mix", 1.0)]), &input, &input);
        assert!(peak(&left) < 5.0 && left.iter().all(|s| s.is_finite()));

        let (left, _) = run(settings(&[("mix", 0.0)]), &input, &input);
        assert_eq!(left, input);
    }
}

//! The Phaser Effect: notches that sweep up and down the spectrum.
//!
//! A chain of first-order all-pass filters shifts the signal's phase without
//! changing its level; mixed back with the dry signal, the frequencies the
//! chain turns upside down cancel, and each pair of stages makes one notch.
//! The stages' corner swings around Centre, up to two octaves either way at
//! full Depth, at Rate. Feedback takes the chain's output back into its
//! input, deepening the notches and ringing between them.

use std::f32::consts::{PI, TAU};

use super::params::{Param, Settings, choice, number};
use crate::dsp::flush_denormal;

/// The numbers of stages a Phaser offers, in the order its `stages` setting
/// picks them.
pub const PHASER_STAGES: &[&str] = &["2", "4", "6", "8", "12"];
const STAGE_COUNTS: [usize; 5] = [2, 4, 6, 8, 12];
const MAX_STAGES: usize = 12;
/// How far full Depth swings the corner either way, in octaves.
const SWING_OCTAVES: f32 = 2.0;
/// The corner moves this often, in samples: far faster than it sweeps.
const CONTROL_FRAMES: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PhaserSettings {
    pub rate_hz: f32,
    pub depth: f32,
    pub centre_hz: f32,
    pub feedback: f32,
    /// An index into `PHASER_STAGES`.
    pub stages: usize,
    pub mix: f32,
}

impl Default for PhaserSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Phaser, in the order a host sends them.
#[rustfmt::skip]
pub const PHASER_PARAMS: &[Param<PhaserSettings>] = &[
    number("rateHz", "Rate", "Hz", (0.05, 8.0, 0.5),
        |s| s.rate_hz, |s, v| s.rate_hz = v),
    number("depth", "Depth", "", (0.0, 1.0, 0.7),
        |s| s.depth, |s, v| s.depth = v),
    number("centreHz", "Centre", "Hz", (100.0, 8_000.0, 800.0),
        |s| s.centre_hz, |s, v| s.centre_hz = v),
    number("feedback", "Feedback", "", (0.0, 0.9, 0.5),
        |s| s.feedback, |s, v| s.feedback = v),
    choice("stages", "Stages", PHASER_STAGES, 1,
        |s| s.stages as f32, |s, v| s.stages = v as usize),
    number("mix", "Mix", "", (0.0, 1.0, 0.5),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for PhaserSettings {
    const PARAMS: &'static [Param<Self>] = PHASER_PARAMS;

    fn zeroed() -> Self {
        Self {
            rate_hz: 0.0,
            depth: 0.0,
            centre_hz: 0.0,
            feedback: 0.0,
            stages: 0,
            mix: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Side {
    stages: [f32; MAX_STAGES],
    last: f32,
}

#[derive(Clone, Debug)]
pub struct Phaser {
    sample_rate: f32,
    settings: PhaserSettings,
    sides: [Side; 2],
    phase: f32,
}

impl Phaser {
    pub fn new(sample_rate: f32, settings: PhaserSettings) -> Self {
        Self {
            sample_rate,
            settings,
            sides: [Side::default(); 2],
            phase: 0.0,
        }
    }

    pub fn settings(&self) -> PhaserSettings {
        self.settings
    }

    pub fn set_settings(&mut self, settings: PhaserSettings) {
        self.settings = settings;
    }

    /// The all-pass coefficient that puts the stages' corner at `hz`.
    fn coefficient(&self, hz: f32) -> f32 {
        let t = (PI * hz.clamp(10.0, 0.45 * self.sample_rate) / self.sample_rate).tan();
        (t - 1.0) / (t + 1.0)
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let PhaserSettings {
            rate_hz,
            depth,
            centre_hz,
            feedback,
            stages,
            mix,
        } = self.settings;
        let count = STAGE_COUNTS[stages.min(STAGE_COUNTS.len() - 1)];
        let increment = rate_hz / self.sample_rate;
        for (l, r) in left
            .chunks_mut(CONTROL_FRAMES)
            .zip(right.chunks_mut(CONTROL_FRAMES))
        {
            let swing = depth * SWING_OCTAVES * (TAU * self.phase).sin();
            let a = self.coefficient(centre_hz * swing.exp2());
            self.phase = (self.phase + increment * l.len() as f32).fract();
            for (buffer, side) in [l, r].into_iter().zip(self.sides.iter_mut()) {
                for sample in buffer.iter_mut() {
                    let mut x = *sample + feedback * side.last;
                    for state in &mut side.stages[..count] {
                        let y = a * x + *state;
                        *state = flush_denormal(x - a * y);
                        x = y;
                    }
                    side.last = flush_denormal(x);
                    *sample = *sample * (1.0 - mix) + x * mix;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rms, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> PhaserSettings {
        let mut settings = PhaserSettings::default();
        for (name, value) in changes {
            let param = PHASER_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn level(settings: PhaserSettings, frequency: f32) -> f32 {
        let mut phaser = Phaser::new(RATE, settings);
        let mut left = sine(frequency, 0.5, RATE, 48_000);
        let mut right = left.clone();
        phaser.process_stereo(&mut left, &mut right);
        rms(&left[24_000..]) / rms(&sine(frequency, 0.5, RATE, 24_000))
    }

    #[test]
    fn two_still_stages_notch_the_centre_and_pass_the_rest() {
        let still = settings(&[
            ("depth", 0.0),
            ("feedback", 0.0),
            ("stages", 0.0),
            ("centreHz", 1_000.0),
        ]);
        assert!(level(still, 1_000.0) < 0.05, "{}", level(still, 1_000.0));
        assert!(level(still, 30.0) > 0.95);
        assert!(level(still, 15_000.0) > 0.9);
    }

    #[test]
    fn the_sweep_moves_the_notch_over_time() {
        let mut phaser = Phaser::new(RATE, settings(&[("rateHz", 2.0), ("feedback", 0.0)]));
        let mut left = sine(800.0, 0.5, RATE, 48_000);
        let mut right = left.clone();
        phaser.process_stereo(&mut left, &mut right);
        let windows: Vec<f32> = left.chunks(1_200).map(rms).collect();
        let (low, high) = windows
            .iter()
            .fold((f32::MAX, 0.0_f32), |(lo, hi), &w| (lo.min(w), hi.max(w)));
        assert!(high > 2.0 * low, "{low} to {high}");
    }

    #[test]
    fn no_mix_is_dry_and_feedback_stays_bounded() {
        let input = sine(500.0, 0.5, RATE, 4_800);
        let mut phaser = Phaser::new(RATE, settings(&[("mix", 0.0)]));
        let (mut left, mut right) = (input.clone(), input.clone());
        phaser.process_stereo(&mut left, &mut right);
        assert_eq!(left, input);

        let loud = level(settings(&[("feedback", 0.9), ("stages", 4.0)]), 700.0);
        assert!(loud.is_finite() && loud < 10.0, "{loud}");
    }
}

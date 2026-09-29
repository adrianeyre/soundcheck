//! The Auto Pan Effect: the sound moving from side to side on its own.
//!
//! An LFO sweeps the pan from the left to the right and back at Rate, or once
//! per note value when Sync is on, so the sweep follows the tempo. Shape picks
//! how it moves: a sine glides, a triangle travels at an even speed, a square
//! jumps from side to side. Depth sets how far out it goes, from the centre
//! alone to hard left and right. The pan is equal power, so the sound is as
//! loud at the sides as in the middle.
//!
//! A synced Auto Pan follows the tempo but not the song position: its sweep
//! starts in the centre, heading right, when it is made.

use std::f32::consts::{FRAC_PI_4, SQRT_2};

use super::delay::NOTE_VALUES;
use super::params::{Param, Settings, choice, number, on, switch, time_coefficient};
use super::stereo::StereoEffect;
use super::tremolo::{DEFAULT_TEMPO, LFO_SHAPES, lfo_value, note_hz};

const QUARTER: usize = 7;

/// How quickly each side's level follows the pan: fast enough to keep a
/// square's jump, slow enough that it doesn't click.
const GAIN_SMOOTHING_MS: f32 = 2.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutoPanSettings {
    /// Whether the rate is a note value, which follows the tempo, rather than
    /// cycles per second.
    pub sync: bool,
    /// An index into `NOTE_VALUES`.
    pub note: usize,
    /// The rate when it isn't synced.
    pub rate_hz: f32,
    /// An index into `LFO_SHAPES`.
    pub shape: usize,
    /// 0..=1: how far from the centre the sweep goes, 1 to hard left and right.
    pub depth: f32,
}

impl Default for AutoPanSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Auto Pan, in the order a host sends them.
#[rustfmt::skip]
pub const AUTO_PAN_PARAMS: &[Param<AutoPanSettings>] = &[
    switch("sync", "Sync to tempo", false,
        |s| on(s.sync), |s, v| s.sync = v >= 0.5),
    choice("note", "Note value", NOTE_VALUES, QUARTER,
        |s| s.note as f32, |s, v| s.note = v as usize),
    number("rateHz", "Rate", "Hz", (0.05, 20.0, 0.5),
        |s| s.rate_hz, |s, v| s.rate_hz = v),
    choice("shape", "Shape", LFO_SHAPES, 0,
        |s| s.shape as f32, |s, v| s.shape = v as usize),
    number("depth", "Depth", "", (0.0, 1.0, 1.0),
        |s| s.depth, |s, v| s.depth = v),
];

impl Settings for AutoPanSettings {
    const PARAMS: &'static [Param<Self>] = AUTO_PAN_PARAMS;

    fn zeroed() -> Self {
        Self {
            sync: false,
            note: 0,
            rate_hz: 0.0,
            shape: 0,
            depth: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct AutoPan {
    sample_rate: f32,
    settings: AutoPanSettings,
    tempo: f64,
    /// Where in its cycle the sweep is, 0..1.
    phase: f32,
    /// The level each side is at, following the pan.
    gain: [f32; 2],
    smoothing: f32,
}

impl AutoPan {
    pub fn new(sample_rate: f32, settings: AutoPanSettings) -> Self {
        Self {
            sample_rate,
            settings,
            tempo: DEFAULT_TEMPO,
            phase: 0.0,
            gain: [1.0; 2],
            smoothing: time_coefficient(GAIN_SMOOTHING_MS, sample_rate),
        }
    }

    fn rate_hz(&self) -> f32 {
        if self.settings.sync {
            note_hz(self.settings.note, self.tempo)
        } else {
            self.settings.rate_hz
        }
    }
}

impl StereoEffect for AutoPan {
    type Settings = AutoPanSettings;

    fn settings(&self) -> AutoPanSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: AutoPanSettings) {
        self.settings = settings;
    }

    fn set_tempo(&mut self, tempo: f64) {
        if tempo.is_finite() && tempo > 0.0 {
            self.tempo = tempo;
        }
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let AutoPanSettings { shape, depth, .. } = self.settings;
        let increment = (self.rate_hz() / self.sample_rate).clamp(0.0, 0.5);
        let smoothing = self.smoothing;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            // A quarter of a cycle back, so the sweep starts in the centre.
            let pan = depth * lfo_value(shape, self.phase - 0.25);
            // -1 (left) to 1 (right) as a quarter turn, which keeps the power
            // of the two sides together the same; the centre is unity.
            let angle = (pan + 1.0) * FRAC_PI_4;
            let (target_left, target_right) = (SQRT_2 * angle.cos(), SQRT_2 * angle.sin());
            self.gain[0] = target_left + smoothing * (self.gain[0] - target_left);
            self.gain[1] = target_right + smoothing * (self.gain[1] - target_right);
            self.phase = (self.phase + increment).fract();
            *l *= self.gain[0];
            *r *= self.gain[1];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{max_jump, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> AutoPanSettings {
        let mut settings = AutoPanSettings::default();
        for (name, value) in changes {
            let param = AUTO_PAN_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(pan: &mut AutoPan, input: &[f32], chunk: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut left, mut right) = (input.to_vec(), input.to_vec());
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            pan.process_stereo(l, r);
        }
        (left, right)
    }

    /// How many times the left side falls silent: once per sweep to the right.
    fn visits_right(left: &[f32]) -> usize {
        left.windows(2)
            .filter(|pair| pair[0] >= 0.05 && pair[1] < 0.05)
            .count()
    }

    #[test]
    fn it_sweeps_hard_left_and_right_at_equal_power() {
        let dc = vec![1.0; 48_000];
        let mut pan = AutoPan::new(RATE, settings(&[("rateHz", 2.0)]));
        let (left, right) = run(&mut pan, &dc, 128);
        assert_eq!(visits_right(&left), 2, "two sweeps a second");
        assert_eq!(visits_right(&right), 2, "and back to the left");
        assert!(left.iter().any(|&s| s < 1e-3) && right.iter().any(|&s| s < 1e-3));
        for (l, r) in left.iter().zip(&right) {
            assert!((l * l + r * r - 2.0).abs() < 1e-2, "{l}, {r}");
        }
    }

    #[test]
    fn no_depth_leaves_the_sound_in_the_centre() {
        let input = sine(300.0, 0.5, RATE, 4_800);
        let mut pan = AutoPan::new(RATE, settings(&[("depth", 0.0), ("shape", 2.0)]));
        let (left, right) = run(&mut pan, &input, 128);
        for ((l, r), dry) in left.iter().zip(&right).zip(&input) {
            assert!((l - dry).abs() < 1e-6 && (r - dry).abs() < 1e-6);
        }
    }

    #[test]
    fn half_depth_goes_half_way_out() {
        let dc = vec![1.0; 48_000];
        let mut pan = AutoPan::new(RATE, settings(&[("rateHz", 1.0), ("depth", 0.5)]));
        let (left, _) = run(&mut pan, &dc, 128);
        let quietest = left.iter().copied().fold(f32::MAX, f32::min);
        // Half-way right: an eighth of a turn past the centre.
        let expected = SQRT_2 * (0.75 * std::f32::consts::FRAC_PI_2).cos();
        assert!((quietest - expected).abs() < 1e-3, "{quietest}");
    }

    #[test]
    fn a_synced_rate_follows_the_tempo() {
        let dc = vec![1.0; 96_000];
        let half = NOTE_VALUES.iter().position(|&n| n == "1/2").unwrap();
        let synced = settings(&[("sync", 1.0), ("note", half as f32)]);
        let mut pan = AutoPan::new(RATE, synced);
        let (left, _) = run(&mut pan, &dc, 128);
        // Half notes at 120 are one a second.
        assert_eq!(visits_right(&left), 2);

        let mut pan = AutoPan::new(RATE, synced);
        pan.set_tempo(240.0);
        let (left, _) = run(&mut pan, &dc, 128);
        assert_eq!(visits_right(&left), 4);
    }

    #[test]
    fn a_square_jumps_without_clicking_and_blocks_do_not_matter() {
        let input = sine(220.0, 0.8, RATE, 20_000);
        let changes = [("shape", 2.0), ("rateHz", 8.0)];
        let (whole_left, whole_right) =
            run(&mut AutoPan::new(RATE, settings(&changes)), &input, 20_000);
        assert!(max_jump(&whole_left) < 0.06, "{}", max_jump(&whole_left));
        for chunk in [1, 7, 128] {
            let (left, right) = run(&mut AutoPan::new(RATE, settings(&changes)), &input, chunk);
            assert_eq!(
                (left, right),
                (whole_left.clone(), whole_right.clone()),
                "{chunk}"
            );
        }
    }
}

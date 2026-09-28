//! The Utility Effect: the everyday fixes to a channel's signal.
//!
//! Gain turns it up or down. Width scales the difference between the sides
//! against what they share: 0 is mono, 1 leaves it as it is and 2 is twice as
//! wide. Mono sums both sides to the middle whatever the width. Pan is a
//! balance: turning it right turns the left side down, and the other way.
//! Each side's polarity can be flipped, to fix a microphone wired backwards
//! or two that cancel.

use super::params::{Param, Settings, number, on, switch};
use crate::dsp::db_to_gain;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UtilitySettings {
    pub gain_db: f32,
    pub width: f32,
    pub pan: f32,
    pub invert_left: bool,
    pub invert_right: bool,
    pub mono: bool,
}

impl Default for UtilitySettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Utility, in the order a host sends them.
#[rustfmt::skip]
pub const UTILITY_PARAMS: &[Param<UtilitySettings>] = &[
    number("gainDb", "Gain", "dB", (-36.0, 36.0, 0.0),
        |s| s.gain_db, |s, v| s.gain_db = v),
    number("width", "Width", "", (0.0, 2.0, 1.0),
        |s| s.width, |s, v| s.width = v),
    number("pan", "Pan", "", (-1.0, 1.0, 0.0),
        |s| s.pan, |s, v| s.pan = v),
    switch("invertLeft", "Invert left", false,
        |s| on(s.invert_left), |s, v| s.invert_left = v >= 0.5),
    switch("invertRight", "Invert right", false,
        |s| on(s.invert_right), |s, v| s.invert_right = v >= 0.5),
    switch("mono", "Mono", false,
        |s| on(s.mono), |s, v| s.mono = v >= 0.5),
];

impl Settings for UtilitySettings {
    const PARAMS: &'static [Param<Self>] = UTILITY_PARAMS;

    fn zeroed() -> Self {
        Self {
            gain_db: 0.0,
            width: 0.0,
            pan: 0.0,
            invert_left: false,
            invert_right: false,
            mono: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Utility {
    settings: UtilitySettings,
}

impl Utility {
    pub fn new(settings: UtilitySettings) -> Self {
        Self { settings }
    }

    pub fn settings(&self) -> UtilitySettings {
        self.settings
    }

    pub fn set_settings(&mut self, settings: UtilitySettings) {
        self.settings = settings;
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let s = self.settings;
        let gain = db_to_gain(s.gain_db);
        let width = if s.mono { 0.0 } else { s.width };
        let flip = |inverted: bool| if inverted { -1.0 } else { 1.0 };
        let left_gain = gain * (1.0 - s.pan).min(1.0) * flip(s.invert_left);
        let right_gain = gain * (1.0 + s.pan).min(1.0) * flip(s.invert_right);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let mid = 0.5 * (*l + *r);
            let side = 0.5 * (*l - *r) * width;
            *l = (mid + side) * left_gain;
            *r = (mid - side) * right_gain;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(settings: UtilitySettings, left: f32, right: f32) -> (f32, f32) {
        let (mut l, mut r) = ([left], [right]);
        Utility::new(settings).process_stereo(&mut l, &mut r);
        (l[0], r[0])
    }

    fn close(actual: (f32, f32), expected: (f32, f32)) {
        assert!(
            (actual.0 - expected.0).abs() < 1e-5 && (actual.1 - expected.1).abs() < 1e-5,
            "{actual:?}, not {expected:?}"
        );
    }

    fn with(change: impl Fn(&mut UtilitySettings)) -> UtilitySettings {
        let mut settings = UtilitySettings::default();
        change(&mut settings);
        settings
    }

    #[test]
    fn the_defaults_change_nothing() {
        close(run(UtilitySettings::default(), 0.3, -0.7), (0.3, -0.7));
    }

    #[test]
    fn width_and_mono_scale_the_difference_between_the_sides() {
        let mono = run(with(|s| s.mono = true), 1.0, 0.0);
        close(mono, (0.5, 0.5));
        close(run(with(|s| s.width = 0.0), 1.0, 0.0), mono);
        close(run(with(|s| s.width = 2.0), 1.0, 0.0), (1.5, -0.5));
    }

    #[test]
    fn gain_pan_and_polarity() {
        let (l, r) = run(with(|s| s.gain_db = 6.0206), 0.25, 0.25);
        assert!((l - 0.5).abs() < 1e-4 && (r - 0.5).abs() < 1e-4);
        close(run(with(|s| s.pan = 1.0), 0.5, 0.5), (0.0, 0.5));
        close(run(with(|s| s.pan = -0.5), 0.5, 0.5), (0.5, 0.25));
        close(run(with(|s| s.invert_left = true), 0.5, 0.5), (-0.5, 0.5));
        close(run(with(|s| s.invert_right = true), 0.5, 0.5), (0.5, -0.5));
    }
}

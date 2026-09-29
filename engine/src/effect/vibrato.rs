//! The Vibrato Effect: the pitch wavering up and down, as a singer's or a
//! violinist's does.
//!
//! The signal is only heard through a short delay line whose time swings at
//! Rate; as the time shrinks the sound comes out faster and higher, and as
//! it grows slower and lower. Depth is how far the pitch goes either way, in
//! cents, whatever the rate: the swing in time is worked out from both. Stereo
//! phase runs the right side's wobble behind the left's, up to half a cycle,
//! which widens the sound and makes it swim.
//!
//! The copy is heard with no dry signal under it, so a Depth of 0 is the
//! signal untouched. The line is allocated for the widest swing up front, and
//! the swing glides to a new setting, so turning it doesn't jump the pitch.

use std::f32::consts::TAU;

use super::params::{Param, Settings, number, time_coefficient};
use super::stereo::StereoEffect;

const MIN_RATE_HZ: f32 = 0.1;
const MAX_DEPTH_CENTS: f32 = 100.0;
/// The widest swing in time the line has room for: enough for the deepest
/// wobble at the slowest rate.
const MAX_SWING_MS: f32 = 100.0;
/// How quickly the swing follows a change in the rate or the depth.
const SWING_SMOOTHING_MS: f32 = 50.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VibratoSettings {
    pub rate_hz: f32,
    /// How far the pitch goes either way, in cents.
    pub depth_cents: f32,
    /// 0..=180 degrees: how far the right side's wobble runs behind the left's.
    pub stereo_phase: f32,
}

impl Default for VibratoSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Vibrato, in the order a host sends them.
#[rustfmt::skip]
pub const VIBRATO_PARAMS: &[Param<VibratoSettings>] = &[
    number("rateHz", "Rate", "Hz", (MIN_RATE_HZ, 14.0, 5.0),
        |s| s.rate_hz, |s, v| s.rate_hz = v),
    number("depthCents", "Depth", "cents", (0.0, MAX_DEPTH_CENTS, 20.0),
        |s| s.depth_cents, |s, v| s.depth_cents = v),
    number("stereoPhase", "Stereo phase", "°", (0.0, 180.0, 0.0),
        |s| s.stereo_phase, |s, v| s.stereo_phase = v),
];

impl Settings for VibratoSettings {
    const PARAMS: &'static [Param<Self>] = VIBRATO_PARAMS;

    fn zeroed() -> Self {
        Self {
            rate_hz: 0.0,
            depth_cents: 0.0,
            stereo_phase: 0.0,
        }
    }
}

/// How far the time swings either side of its middle, in samples, for the
/// pitch to go `cents` either way at `rate_hz`. A time swinging by `A`
/// samples at `w` radians a sample bends the pitch by up to `A * w`.
fn swing_samples(rate_hz: f32, cents: f32, sample_rate: f32) -> f32 {
    let bend = (cents / 1_200.0).exp2() - 1.0;
    let radians = TAU * rate_hz.max(MIN_RATE_HZ) / sample_rate;
    (bend / radians).min(MAX_SWING_MS / 1_000.0 * sample_rate)
}

#[derive(Clone, Debug)]
pub struct Vibrato {
    sample_rate: f32,
    settings: VibratoSettings,
    left: Vec<f32>,
    right: Vec<f32>,
    write: usize,
    /// Where in its cycle the left side's wobble is, 0..1.
    phase: f32,
    /// The swing in samples, gliding to the settings'.
    swing: f32,
    smoothing: f32,
}

impl Vibrato {
    pub fn new(sample_rate: f32, settings: VibratoSettings) -> Self {
        // Room for the swing both ways, and the sample after it to
        // interpolate towards.
        let capacity = (2.0 * MAX_SWING_MS / 1_000.0 * sample_rate).ceil() as usize + 4;
        Self {
            sample_rate,
            settings,
            left: vec![0.0; capacity],
            right: vec![0.0; capacity],
            write: 0,
            phase: 0.0,
            swing: swing_samples(settings.rate_hz, settings.depth_cents, sample_rate),
            smoothing: time_coefficient(SWING_SMOOTHING_MS, sample_rate),
        }
    }

    /// The line read `delay` samples behind the sample just written, between
    /// samples.
    fn read(line: &[f32], newest: usize, delay: f32) -> f32 {
        let length = line.len();
        let whole = delay.floor();
        let fraction = delay - whole;
        let at = (newest + length - whole as usize) % length;
        let before = (at + length - 1) % length;
        line[at] * (1.0 - fraction) + line[before] * fraction
    }
}

impl StereoEffect for Vibrato {
    type Settings = VibratoSettings;

    fn settings(&self) -> VibratoSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: VibratoSettings) {
        self.settings = settings;
    }

    fn settle(&mut self) {
        let VibratoSettings {
            rate_hz,
            depth_cents,
            ..
        } = self.settings;
        self.swing = swing_samples(rate_hz, depth_cents, self.sample_rate);
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let VibratoSettings {
            rate_hz,
            depth_cents,
            stereo_phase,
        } = self.settings;
        let swing = swing_samples(rate_hz, depth_cents, self.sample_rate);
        let increment = rate_hz / self.sample_rate;
        let offset = stereo_phase / 360.0;
        let smoothing = self.smoothing;
        let length = self.left.len();
        let longest = (length - 2) as f32;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            self.swing = swing + smoothing * (self.swing - swing);
            self.left[self.write] = *l;
            self.right[self.write] = *r;
            // Swinging from no delay to twice the swing and back, so a still
            // line is the signal as it is.
            let delay = |phase: f32| self.swing * (1.0 - (TAU * phase).cos());
            let delay_left = delay(self.phase).clamp(0.0, longest);
            let delay_right = delay(self.phase - offset).clamp(0.0, longest);
            *l = Self::read(&self.left, self.write, delay_left);
            *r = Self::read(&self.right, self.write, delay_right);
            self.write = (self.write + 1) % length;
            self.phase = (self.phase + increment).fract();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{max_jump, rising_zero_crossings, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> VibratoSettings {
        let mut settings = VibratoSettings::default();
        for (name, value) in changes {
            let param = VIBRATO_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(vibrato: &mut Vibrato, input: &[f32], chunk: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut left, mut right) = (input.to_vec(), input.to_vec());
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            vibrato.process_stereo(l, r);
        }
        (left, right)
    }

    #[test]
    fn the_pitch_wobbles_by_the_depth_and_comes_back() {
        // A 1 kHz tone bent 100 cents either way at 5 Hz: about 944 to
        // 1,059 Hz, and 1 kHz on average.
        let input = sine(1_000.0, 0.5, RATE, 96_000);
        let changes = [("rateHz", 5.0), ("depthCents", 100.0)];
        let (left, _) = run(&mut Vibrato::new(RATE, settings(&changes)), &input, 128);
        let total = rising_zero_crossings(&left);
        assert!(total.abs_diff(2_000) <= 3, "{total}");
        // Tenths of a second: each half of a wobble, flat then sharp.
        let counts: Vec<usize> = left.chunks(4_800).map(rising_zero_crossings).collect();
        let (lowest, highest) = (counts.iter().min().unwrap(), counts.iter().max().unwrap());
        assert!(*lowest <= 97 && *highest >= 103, "{lowest}..{highest}");
    }

    #[test]
    fn no_depth_is_the_signal_untouched() {
        let input = sine(300.0, 0.5, RATE, 4_800);
        let changes = [("depthCents", 0.0), ("stereoPhase", 180.0)];
        let (left, right) = run(&mut Vibrato::new(RATE, settings(&changes)), &input, 128);
        assert_eq!(left, input);
        assert_eq!(right, input);
    }

    #[test]
    fn the_stereo_phase_bends_the_sides_opposite_ways() {
        let input = sine(1_000.0, 0.5, RATE, 48_000);
        let changes = [
            ("rateHz", 5.0),
            ("depthCents", 100.0),
            ("stereoPhase", 180.0),
        ];
        let (left, right) = run(&mut Vibrato::new(RATE, settings(&changes)), &input, 128);
        // The second tenth of a second: the left goes sharp while the right
        // goes flat.
        let sharp = rising_zero_crossings(&left[4_800..9_600]);
        let flat = rising_zero_crossings(&right[4_800..9_600]);
        assert!(flat + 5 < sharp, "{flat} against {sharp}");
    }

    #[test]
    fn the_slowest_deepest_wobble_fits_and_changes_glide() {
        assert!(swing_samples(MIN_RATE_HZ, MAX_DEPTH_CENTS, RATE) < MAX_SWING_MS / 1_000.0 * RATE);
        let input = sine(200.0, 0.5, RATE, 96_000);
        let slow = settings(&[("rateHz", MIN_RATE_HZ), ("depthCents", MAX_DEPTH_CENTS)]);
        let mut vibrato = Vibrato::new(RATE, slow);
        let (mut left, mut right) = (input.clone(), input.clone());
        vibrato.process_stereo(&mut left[..48_000], &mut right[..48_000]);
        // From the widest swing to none at once.
        vibrato.set_settings(settings(&[("rateHz", MIN_RATE_HZ), ("depthCents", 0.0)]));
        vibrato.process_stereo(&mut left[48_000..], &mut right[48_000..]);
        assert!(left.iter().all(|s| s.is_finite() && s.abs() <= 0.5 + 1e-6));
        assert!(max_jump(&left) < 0.05, "{}", max_jump(&left));
    }

    #[test]
    fn any_block_size_sounds_the_same() {
        let input = sine(220.0, 0.8, RATE, 10_000);
        let changes = [("depthCents", 60.0), ("stereoPhase", 90.0)];
        let (whole, _) = run(&mut Vibrato::new(RATE, settings(&changes)), &input, 10_000);
        for chunk in [1, 7, 128] {
            let (chunked, _) = run(&mut Vibrato::new(RATE, settings(&changes)), &input, chunk);
            assert_eq!(chunked, whole, "in blocks of {chunk}");
        }
    }
}

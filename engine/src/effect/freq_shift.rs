//! The Frequency Shifter Effect: moves every frequency in the signal up or
//! down by the same number of hertz, which, unlike a pitch shift, breaks the
//! harmonics apart into clangy, bell-like and metallic tones.
//!
//! Each side is split into two copies a quarter of a cycle apart by a pair of
//! all-pass chains (a Hilbert transform), and the pair is turned by a sine at
//! Shift, which leaves only one sideband: +100 Hz takes a 1 kHz tone to
//! 1.1 kHz, -100 Hz to 900 Hz. A few hertz either way is a slow, phaser-like
//! swirl. Feedback sends the shifted signal round again, so each pass is
//! shifted further, towards an endlessly rising or falling spiral. Mix blends
//! it with the dry signal.

use std::f32::consts::TAU;

use super::params::{Param, Settings, number};
use super::stereo::StereoEffect;
use crate::dsp::flush_denormal;

const MAX_SHIFT_HZ: f32 = 2_000.0;
const MAX_FEEDBACK: f32 = 0.9;

/// The two chains' all-pass coefficients (Olli Niemitalo's design), which
/// keep them a quarter of a cycle apart from about 20 Hz to 20 kHz.
const PATH_A: [f32; 4] = [0.692_387_8, 0.936_065_4, 0.988_229_5, 0.998_748_8];
const PATH_B: [f32; 4] = [0.402_192_1, 0.856_171_1, 0.972_290_95, 0.995_288_5];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrequencyShifterSettings {
    /// How far every frequency moves, in hertz: up when positive.
    pub shift_hz: f32,
    /// 0..<1: how much of the shifted signal goes round again.
    pub feedback: f32,
    pub mix: f32,
}

impl Default for FrequencyShifterSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Frequency Shifter, in the order a host sends them.
#[rustfmt::skip]
pub const FREQ_SHIFT_PARAMS: &[Param<FrequencyShifterSettings>] = &[
    number("shiftHz", "Shift", "Hz", (-MAX_SHIFT_HZ, MAX_SHIFT_HZ, 100.0),
        |s| s.shift_hz, |s, v| s.shift_hz = v),
    number("feedback", "Feedback", "", (0.0, MAX_FEEDBACK, 0.0),
        |s| s.feedback, |s, v| s.feedback = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for FrequencyShifterSettings {
    const PARAMS: &'static [Param<Self>] = FREQ_SHIFT_PARAMS;

    fn zeroed() -> Self {
        Self {
            shift_hz: 0.0,
            feedback: 0.0,
            mix: 0.0,
        }
    }
}

/// One all-pass chain of second-order sections in z^-2: each section's
/// last two inputs and outputs.
#[derive(Clone, Copy, Debug, Default)]
struct AllPassChain {
    state: [[f32; 4]; 4],
}

impl AllPassChain {
    fn process(&mut self, coefficients: &[f32; 4], mut x: f32) -> f32 {
        for (a, [x1, x2, y1, y2]) in coefficients.iter().zip(self.state.iter_mut()) {
            let y = flush_denormal(a * a * (x + *y2) - *x2);
            (*x2, *x1) = (*x1, x);
            (*y2, *y1) = (*y1, y);
            x = y;
        }
        x
    }
}

/// One side's Hilbert transform: two chains, the second a sample later.
#[derive(Clone, Copy, Debug, Default)]
struct Hilbert {
    a: AllPassChain,
    b: AllPassChain,
    b_delayed: f32,
    /// The last shifted sample, for the feedback.
    last: f32,
}

impl Hilbert {
    /// The in-phase and quadrature copies of `x`.
    fn split(&mut self, x: f32) -> (f32, f32) {
        let in_phase = self.a.process(&PATH_A, x);
        let quadrature = self.b_delayed;
        self.b_delayed = self.b.process(&PATH_B, x);
        (in_phase, quadrature)
    }
}

#[derive(Clone, Debug)]
pub struct FrequencyShifter {
    sample_rate: f32,
    settings: FrequencyShifterSettings,
    sides: [Hilbert; 2],
    /// Where the shifting sine is in its cycle, 0..1.
    phase: f32,
}

impl FrequencyShifter {
    pub fn new(sample_rate: f32, settings: FrequencyShifterSettings) -> Self {
        Self {
            sample_rate,
            settings,
            sides: [Hilbert::default(); 2],
            phase: 0.0,
        }
    }
}

impl StereoEffect for FrequencyShifter {
    type Settings = FrequencyShifterSettings;

    fn settings(&self) -> FrequencyShifterSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: FrequencyShifterSettings) {
        self.settings = settings;
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let FrequencyShifterSettings {
            shift_hz,
            feedback,
            mix,
        } = self.settings;
        // A new shift only changes how fast the sine turns, so it never clicks.
        let increment = shift_hz / self.sample_rate;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let (sin, cos) = (TAU * self.phase).sin_cos();
            self.phase = (self.phase + increment).rem_euclid(1.0);
            for (sample, side) in [l, r].into_iter().zip(self.sides.iter_mut()) {
                let (in_phase, quadrature) = side.split(*sample + feedback * side.last);
                let shifted = flush_denormal(in_phase * cos + quadrature * sin);
                side.last = shifted;
                *sample = *sample * (1.0 - mix) + shifted * mix;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rising_zero_crossings, rms, sine};

    const RATE: f32 = 48_000.0;

    fn settings(shift_hz: f32, feedback: f32, mix: f32) -> FrequencyShifterSettings {
        FrequencyShifterSettings {
            shift_hz,
            feedback,
            mix,
        }
    }

    fn run(settings: FrequencyShifterSettings, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut shifter = FrequencyShifter::new(RATE, settings);
        let (mut left, mut right) = (input.to_vec(), input.to_vec());
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            shifter.process_stereo(l, r);
        }
        assert_eq!(left, right);
        left
    }

    /// The frequency of the rendered tone over its last half second.
    fn frequency(buffer: &[f32]) -> f32 {
        let tail = &buffer[buffer.len() - 24_000..];
        rising_zero_crossings(tail) as f32 * 2.0
    }

    #[test]
    fn a_tone_moves_by_the_shift_either_way() {
        let input = sine(1_000.0, 0.5, RATE, 48_000);
        let up = run(settings(200.0, 0.0, 1.0), &input, 128);
        assert!(
            (frequency(&up) - 1_200.0).abs() <= 4.0,
            "{}",
            frequency(&up)
        );
        let down = run(settings(-300.0, 0.0, 1.0), &input, 128);
        assert!(
            (frequency(&down) - 700.0).abs() <= 4.0,
            "{}",
            frequency(&down)
        );
        // Only one sideband: the level is the tone's, not half of it twice.
        assert!((rms(&up[24_000..]) - rms(&input[24_000..])).abs() < 0.02);
    }

    #[test]
    fn no_mix_is_dry() {
        let input = sine(440.0, 0.5, RATE, 4_800);
        assert_eq!(run(settings(-1_500.0, 0.9, 0.0), &input, 64), input);
    }

    #[test]
    fn full_feedback_at_the_extremes_stays_finite_and_bounded() {
        let input: Vec<f32> = (0..96_000)
            .map(|n| if n % 97 < 48 { 1.0 } else { -1.0 })
            .collect();
        for shift in [-MAX_SHIFT_HZ, 0.0, MAX_SHIFT_HZ] {
            let out = run(settings(shift, MAX_FEEDBACK, 1.0), &input, 512);
            assert!(out.iter().all(|s| s.is_finite() && s.abs() < 20.0));
        }
    }

    #[test]
    fn odd_chunks_render_the_same_as_one_block() {
        let input = sine(330.0, 0.5, RATE, 9_000);
        let whole = run(settings(-75.0, 0.5, 0.7), &input, input.len());
        let chunked = run(settings(-75.0, 0.5, 0.7), &input, 1);
        assert_eq!(whole, run(settings(-75.0, 0.5, 0.7), &input, 37));
        assert_eq!(whole, chunked);
    }
}

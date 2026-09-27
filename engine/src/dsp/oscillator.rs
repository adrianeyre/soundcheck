//! Band-limited oscillators.

use std::f32::consts::TAU;

/// The shapes an oscillator can make. The order is the order the Synth's
/// `osc1Wave` and `osc2Wave` settings choose from, so it must not change.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Waveform {
    #[default]
    Saw,
    Square,
    Triangle,
    Sine,
}

impl Waveform {
    /// The names the settings declare, in order.
    pub const NAMES: [&'static str; 4] = ["saw", "square", "triangle", "sine"];

    /// The waveform at `index`, or the saw for anything out of range.
    pub fn from_index(index: usize) -> Self {
        match index {
            1 => Self::Square,
            2 => Self::Triangle,
            3 => Self::Sine,
            _ => Self::Saw,
        }
    }

    pub fn index(self) -> usize {
        match self {
            Self::Saw => 0,
            Self::Square => 1,
            Self::Triangle => 2,
            Self::Sine => 3,
        }
    }
}

/// One oscillator: a phase accumulator read as any of the waveforms.
///
/// The saw and the square are anti-aliased with PolyBLEP, which smooths the
/// step in the waveform. The triangle and the sine have no step — the
/// triangle's harmonics fall away as 1/n², so what it aliases is inaudible —
/// and are read straight from the phase.
#[derive(Clone, Copy, Debug, Default)]
pub struct Oscillator {
    waveform: Waveform,
    phase: f32,
    increment: f32,
}

impl Oscillator {
    pub fn new(waveform: Waveform) -> Self {
        Self {
            waveform,
            phase: 0.0,
            increment: 0.0,
        }
    }

    pub fn set_waveform(&mut self, waveform: Waveform) {
        self.waveform = waveform;
    }

    /// Set the pitch.
    pub fn set_frequency(&mut self, frequency: f32, sample_rate: f32) {
        self.increment = (frequency / sample_rate).clamp(0.0, 0.5);
    }

    /// Restart the waveform from the beginning of a cycle.
    pub fn reset(&mut self) {
        self.phase = 0.0;
    }

    /// The next sample, in -1..=1.
    pub fn next_sample(&mut self) -> f32 {
        let t = self.phase;
        let dt = self.increment;
        let sample = match self.waveform {
            Waveform::Saw => 2.0 * t - 1.0 - poly_blep(t, dt),
            Waveform::Square => {
                let raw = if t < 0.5 { 1.0 } else { -1.0 };
                raw + poly_blep(t, dt) - poly_blep(wrap(t + 0.5), dt)
            }
            Waveform::Triangle => 4.0 * (t - 0.5).abs() - 1.0,
            Waveform::Sine => (TAU * t).sin(),
        };
        self.phase = wrap(t + dt);
        sample
    }
}

fn wrap(phase: f32) -> f32 {
    if phase >= 1.0 { phase - 1.0 } else { phase }
}

/// The polynomial correction that smooths a waveform's jump at `t = 0`.
fn poly_blep(t: f32, dt: f32) -> f32 {
    if dt <= 0.0 {
        0.0
    } else if t < dt {
        let t = t / dt;
        t + t - t * t - 1.0
    } else if t > 1.0 - dt {
        let t = (t - 1.0) / dt;
        t * t + t + t + 1.0
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, rising_zero_crossings};

    const RATE: f32 = 48_000.0;

    fn run(waveform: Waveform, frequency: f32, frames: usize) -> Vec<f32> {
        let mut oscillator = Oscillator::new(waveform);
        oscillator.set_frequency(frequency, RATE);
        (0..frames).map(|_| oscillator.next_sample()).collect()
    }

    #[test]
    fn every_waveform_has_the_requested_pitch_and_stays_in_range() {
        for waveform in [
            Waveform::Saw,
            Waveform::Square,
            Waveform::Triangle,
            Waveform::Sine,
        ] {
            let buffer = run(waveform, 440.0, 48_000);
            let rising = rising_zero_crossings(&buffer);
            assert!((439..=441).contains(&rising), "{waveform:?}: {rising}");
            let peak = peak(&buffer);
            assert!((0.95..=1.05).contains(&peak), "{waveform:?}: peak {peak}");
        }
    }

    #[test]
    fn waveforms_are_told_apart_by_shape() {
        // A square spends every sample at full level; a triangle ramps.
        let square = run(Waveform::Square, 100.0, 4_800);
        let triangle = run(Waveform::Triangle, 100.0, 4_800);
        let loud = |b: &[f32]| b.iter().filter(|s| s.abs() > 0.9).count();
        assert!(loud(&square) > 4_000, "square: {}", loud(&square));
        assert!(loud(&triangle) < 1_200, "triangle: {}", loud(&triangle));
    }

    #[test]
    fn waveform_indexes_round_trip() {
        for index in 0..Waveform::NAMES.len() {
            assert_eq!(Waveform::from_index(index).index(), index);
        }
        assert_eq!(Waveform::from_index(99), Waveform::Saw);
    }
}

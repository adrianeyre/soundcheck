//! A low-frequency sine, for modulating pitch, a filter or a level.

use std::f32::consts::TAU;

/// A sine from -1 to 1. It is read at the control rate, a few dozen samples
/// at a time, which is far above anything an LFO does.
#[derive(Clone, Copy, Debug, Default)]
pub struct Lfo {
    phase: f32,
    increment: f32,
}

impl Lfo {
    pub fn set_rate(&mut self, hz: f32, sample_rate: f32) {
        self.increment = (hz / sample_rate).clamp(0.0, 0.5);
    }

    /// Start again at the bottom of the rise, so a note's modulation always
    /// begins the same way.
    pub fn reset(&mut self) {
        self.phase = 0.0;
    }

    /// The value now, in -1..=1.
    pub fn value(&self) -> f32 {
        (TAU * self.phase).sin()
    }

    /// Move on by `frames` samples.
    pub fn advance(&mut self, frames: usize) {
        self.phase = (self.phase + self.increment * frames as f32).fract();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    #[test]
    fn a_cycle_rises_falls_and_comes_back() {
        let mut lfo = Lfo::default();
        lfo.set_rate(1.0, RATE);
        assert!(lfo.value().abs() < 1e-6);

        lfo.advance(12_000);
        assert!((lfo.value() - 1.0).abs() < 1e-3, "quarter: {}", lfo.value());
        lfo.advance(24_000);
        assert!((lfo.value() + 1.0).abs() < 1e-3, "three quarters");
        lfo.advance(12_000);
        assert!(lfo.value().abs() < 1e-3, "back to the start");
    }

    #[test]
    fn reset_returns_to_the_start_of_the_rise() {
        let mut lfo = Lfo::default();
        lfo.set_rate(5.0, RATE);
        lfo.advance(1_234);
        lfo.reset();
        assert_eq!(lfo.value(), 0.0);
    }
}

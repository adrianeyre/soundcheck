//! A second-order IIR filter with the RBJ Audio EQ Cookbook designs.

use std::f32::consts::TAU;

use super::{db_to_gain, flush_denormal};

/// The filter shapes a Synth voice can use. The order is the order its
/// `filterType` setting chooses from, so it must not change.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FilterKind {
    #[default]
    Low,
    High,
    Band,
}

impl FilterKind {
    /// The names the settings declare, in order.
    pub const NAMES: [&'static str; 3] = ["lowPass", "highPass", "bandPass"];

    /// The kind at `index`, or the low-pass for anything out of range.
    pub fn from_index(index: usize) -> Self {
        match index {
            1 => Self::High,
            2 => Self::Band,
            _ => Self::Low,
        }
    }

    pub fn index(self) -> usize {
        match self {
            Self::Low => 0,
            Self::High => 1,
            Self::Band => 2,
        }
    }
}

/// A biquad filter in transposed direct form II.
#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    /// A resonant low-pass filter. `q` of 0.707 is maximally flat.
    pub fn low_pass(sample_rate: f32, frequency: f32, q: f32) -> Self {
        let (cos, alpha) = Self::angles(sample_rate, frequency, q);
        let b1 = 1.0 - cos;
        Self::normalised(b1 / 2.0, b1, b1 / 2.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha)
    }

    /// A resonant high-pass filter.
    pub fn high_pass(sample_rate: f32, frequency: f32, q: f32) -> Self {
        let (cos, alpha) = Self::angles(sample_rate, frequency, q);
        let b0 = (1.0 + cos) / 2.0;
        Self::normalised(b0, -(1.0 + cos), b0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha)
    }

    /// A band-pass with unity gain at `frequency`.
    pub fn band_pass(sample_rate: f32, frequency: f32, q: f32) -> Self {
        let (cos, alpha) = Self::angles(sample_rate, frequency, q);
        Self::normalised(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cos, 1.0 - alpha)
    }

    /// Whichever of the three a Synth voice asks for.
    pub fn of_kind(kind: FilterKind, sample_rate: f32, frequency: f32, q: f32) -> Self {
        match kind {
            FilterKind::Low => Self::low_pass(sample_rate, frequency, q),
            FilterKind::High => Self::high_pass(sample_rate, frequency, q),
            FilterKind::Band => Self::band_pass(sample_rate, frequency, q),
        }
    }

    /// A bell that boosts or cuts `gain_db` around `frequency`.
    pub fn peaking(sample_rate: f32, frequency: f32, q: f32, gain_db: f32) -> Self {
        let (cos, alpha) = Self::angles(sample_rate, frequency, q);
        let a = db_to_gain(gain_db / 2.0);
        Self::normalised(
            1.0 + alpha * a,
            -2.0 * cos,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * cos,
            1.0 - alpha / a,
        )
    }

    /// A shelf that boosts or cuts `gain_db` below `frequency`.
    pub fn low_shelf(sample_rate: f32, frequency: f32, gain_db: f32) -> Self {
        let (cos, alpha) = Self::angles(sample_rate, frequency, std::f32::consts::FRAC_1_SQRT_2);
        let a = db_to_gain(gain_db / 2.0);
        let k = 2.0 * a.sqrt() * alpha;
        Self::normalised(
            a * ((a + 1.0) - (a - 1.0) * cos + k),
            2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
            a * ((a + 1.0) - (a - 1.0) * cos - k),
            (a + 1.0) + (a - 1.0) * cos + k,
            -2.0 * ((a - 1.0) + (a + 1.0) * cos),
            (a + 1.0) + (a - 1.0) * cos - k,
        )
    }

    /// A shelf that boosts or cuts `gain_db` above `frequency`.
    pub fn high_shelf(sample_rate: f32, frequency: f32, gain_db: f32) -> Self {
        let (cos, alpha) = Self::angles(sample_rate, frequency, std::f32::consts::FRAC_1_SQRT_2);
        let a = db_to_gain(gain_db / 2.0);
        let k = 2.0 * a.sqrt() * alpha;
        Self::normalised(
            a * ((a + 1.0) + (a - 1.0) * cos + k),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
            a * ((a + 1.0) + (a - 1.0) * cos - k),
            (a + 1.0) - (a - 1.0) * cos + k,
            2.0 * ((a - 1.0) - (a + 1.0) * cos),
            (a + 1.0) - (a - 1.0) * cos - k,
        )
    }

    /// Filter one sample.
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = flush_denormal(self.b1 * x - self.a1 * y + self.z2);
        self.z2 = flush_denormal(self.b2 * x - self.a2 * y);
        y
    }

    /// Filter a buffer in place.
    pub fn process_buffer(&mut self, buffer: &mut [f32]) {
        for sample in buffer {
            *sample = self.process(*sample);
        }
    }

    /// How much this filter scales a sine at `frequency`: the magnitude of
    /// its transfer function there, worked out from the coefficients rather
    /// than by filtering anything.
    pub fn magnitude(&self, sample_rate: f32, frequency: f32) -> f32 {
        let w = std::f64::consts::TAU * f64::from(frequency) / f64::from(sample_rate);
        let (cos1, sin1, cos2, sin2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
        let (b0, b1, b2) = (f64::from(self.b0), f64::from(self.b1), f64::from(self.b2));
        let (a1, a2) = (f64::from(self.a1), f64::from(self.a2));
        // H(z) at z = e^jw, with z^-1 = cos w - j sin w.
        let numerator = (b0 + b1 * cos1 + b2 * cos2).hypot(b1 * sin1 + b2 * sin2);
        let denominator = (1.0 + a1 * cos1 + a2 * cos2).hypot(a1 * sin1 + a2 * sin2);
        (numerator / denominator) as f32
    }

    /// Take on `other`'s memory. A filter redesigned while it is running
    /// carries on from where the old one left off, instead of jumping.
    pub fn restore_state(&mut self, other: &Self) {
        self.z1 = other.z1;
        self.z2 = other.z2;
    }

    /// Clear the filter's memory.
    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    fn angles(sample_rate: f32, frequency: f32, q: f32) -> (f32, f32) {
        let frequency = frequency.clamp(10.0, sample_rate * 0.49);
        let w0 = TAU * frequency / sample_rate;
        (w0.cos(), w0.sin() / (2.0 * q))
    }

    fn normalised(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rms, sine};

    const RATE: f32 = 48_000.0;

    /// The filter's gain at `frequency`, measured on a steady sine.
    fn gain_at(mut filter: Biquad, frequency: f32) -> f32 {
        let mut buffer = sine(frequency, 1.0, RATE, 48_000);
        filter.process_buffer(&mut buffer);
        // Skip the start so the filter has settled.
        rms(&buffer[24_000..]) / std::f32::consts::FRAC_1_SQRT_2
    }

    #[test]
    fn low_pass_keeps_lows_and_cuts_highs() {
        let filter = Biquad::low_pass(RATE, 1_000.0, 0.707);
        assert!((gain_at(filter, 100.0) - 1.0).abs() < 0.02);
        assert!(gain_at(filter, 10_000.0) < 0.02);
    }

    #[test]
    fn high_pass_and_band_pass_keep_their_own_side() {
        let high = Biquad::high_pass(RATE, 1_000.0, 0.707);
        assert!((gain_at(high, 10_000.0) - 1.0).abs() < 0.02);
        assert!(gain_at(high, 100.0) < 0.02);

        let band = Biquad::band_pass(RATE, 1_000.0, 2.0);
        assert!((gain_at(band, 1_000.0) - 1.0).abs() < 0.02);
        assert!(gain_at(band, 100.0) < 0.2);
        assert!(gain_at(band, 10_000.0) < 0.2);
    }

    #[test]
    fn filter_kind_indexes_round_trip() {
        for index in 0..FilterKind::NAMES.len() {
            assert_eq!(FilterKind::from_index(index).index(), index);
        }
        assert_eq!(FilterKind::from_index(9), FilterKind::Low);
    }

    #[test]
    fn peaking_boosts_its_centre_and_leaves_distant_frequencies() {
        let filter = Biquad::peaking(RATE, 1_000.0, 1.0, 6.0);
        assert!((gain_at(filter, 1_000.0) - db_to_gain(6.0)).abs() < 0.02);
        assert!((gain_at(filter, 50.0) - 1.0).abs() < 0.03);
    }

    #[test]
    fn shelves_change_only_their_side() {
        let low = Biquad::low_shelf(RATE, 200.0, -12.0);
        assert!((gain_at(low, 30.0) - db_to_gain(-12.0)).abs() < 0.02);
        assert!((gain_at(low, 8_000.0) - 1.0).abs() < 0.02);

        let high = Biquad::high_shelf(RATE, 4_000.0, 6.0);
        assert!((gain_at(high, 16_000.0) - db_to_gain(6.0)).abs() < 0.05);
        assert!((gain_at(high, 100.0) - 1.0).abs() < 0.02);
    }
}

//! A signal split into four bands, low, low-mid, high-mid and high, with
//! Linkwitz-Riley crossovers (two Butterworth sections each side of every
//! split), which add back up flat.
//!
//! The middle split comes first, and each half then goes through an
//! all-pass at the other half's split before it is split again, so every
//! band has had the same phase turn: however the bands are scaled, they
//! never cancel where they overlap, and at unity they sum to an all-pass,
//! flat at every frequency.

use super::Biquad;

const BUTTERWORTH_Q: f32 = std::f32::consts::FRAC_1_SQRT_2;

/// A Linkwitz-Riley split into what is below and above a frequency.
#[derive(Clone, Copy, Debug)]
struct Split {
    low: [Biquad; 2],
    high: [Biquad; 2],
}

impl Split {
    fn new(sample_rate: f32, frequency: f32) -> Self {
        let low = Biquad::low_pass(sample_rate, frequency, BUTTERWORTH_Q);
        let high = Biquad::high_pass(sample_rate, frequency, BUTTERWORTH_Q);
        Self {
            low: [low, low],
            high: [high, high],
        }
    }

    fn process(&mut self, x: f32) -> (f32, f32) {
        let low = self.low[0].process(x);
        let low = self.low[1].process(low);
        let high = self.high[0].process(x);
        let high = self.high[1].process(high);
        (low, high)
    }

    fn reset(&mut self) {
        for filter in self.low.iter_mut().chain(self.high.iter_mut()) {
            filter.reset();
        }
    }
}

/// One side's four bands. Allocates nothing.
#[derive(Clone, Copy, Debug)]
pub struct FourBand {
    /// Low from low-mid, low-mid from high-mid, high-mid from high.
    splits: [Split; 3],
    /// What the low half and the high half each go through, so they turn
    /// as the other does at its split.
    low_all_pass: Biquad,
    high_all_pass: Biquad,
}

impl FourBand {
    /// Bands that meet at `splits_hz`, lowest first.
    pub fn new(sample_rate: f32, splits_hz: [f32; 3]) -> Self {
        Self {
            splits: splits_hz.map(|hz| Split::new(sample_rate, hz)),
            low_all_pass: Biquad::all_pass(sample_rate, splits_hz[2], BUTTERWORTH_Q),
            high_all_pass: Biquad::all_pass(sample_rate, splits_hz[0], BUTTERWORTH_Q),
        }
    }

    /// `x` split into its bands, low to high.
    pub fn split(&mut self, x: f32) -> [f32; 4] {
        let (low_half, high_half) = self.splits[1].process(x);
        let (low, low_mid) = self.splits[0].process(self.low_all_pass.process(low_half));
        let (high_mid, high) = self.splits[2].process(self.high_all_pass.process(high_half));
        [low, low_mid, high_mid, high]
    }

    /// `x` with each band, low to high, scaled by `gains`.
    pub fn process(&mut self, x: f32, gains: [f32; 4]) -> f32 {
        let bands = self.split(x);
        bands[0] * gains[0] + bands[1] * gains[1] + bands[2] * gains[2] + bands[3] * gains[3]
    }

    /// Forget what it has heard.
    pub fn reset(&mut self) {
        for split in &mut self.splits {
            split.reset();
        }
        self.low_all_pass.reset();
        self.high_all_pass.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rms, sine};

    const RATE: f32 = 48_000.0;
    const SPLITS: [f32; 3] = [200.0, 1_000.0, 5_000.0];

    fn level(frequency: f32, gains: [f32; 4]) -> f32 {
        let mut bands = FourBand::new(RATE, SPLITS);
        let tone = sine(frequency, 0.5, RATE, 48_000);
        let out: Vec<f32> = tone.iter().map(|&x| bands.process(x, gains)).collect();
        rms(&out[24_000..]) / rms(&tone[24_000..])
    }

    #[test]
    fn at_unity_the_bands_sum_flat_everywhere() {
        for hz in [30.0, 200.0, 450.0, 1_000.0, 2_200.0, 5_000.0, 12_000.0] {
            let gain = level(hz, [1.0; 4]);
            assert!((gain - 1.0).abs() < 1e-3, "{hz} Hz: {gain}");
        }
    }

    #[test]
    fn each_band_holds_its_own_region() {
        let only = |band: usize| {
            let mut gains = [0.0; 4];
            gains[band] = 1.0;
            gains
        };
        assert!(level(50.0, only(0)) > 0.95);
        assert!(level(450.0, only(1)) > 0.8);
        assert!(level(2_200.0, only(2)) > 0.8);
        assert!(level(15_000.0, only(3)) > 0.95);
        assert!(level(15_000.0, only(0)) < 0.01);
        assert!(level(50.0, only(3)) < 0.01);
    }

    #[test]
    fn the_all_pass_is_flat() {
        let filter = Biquad::all_pass(RATE, 1_000.0, BUTTERWORTH_Q);
        for hz in [20.0, 1_000.0, 20_000.0] {
            assert!((filter.magnitude(RATE, hz) - 1.0).abs() < 1e-4);
        }
    }
}

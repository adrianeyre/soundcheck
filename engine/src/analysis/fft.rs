//! A radix-2 FFT and the short-time spectra Audio Analysis is built on.
//!
//! Written here rather than taken from a crate: analysis needs one kind of
//! transform, and the engine keeps its dependencies few.

use std::f64::consts::TAU;

/// An in-place complex FFT of one power-of-two size, with its twiddles.
#[derive(Clone, Debug)]
pub struct Fft {
    size: usize,
    cos: Vec<f64>,
    sin: Vec<f64>,
}

impl Fft {
    /// `size` must be a power of two.
    pub fn new(size: usize) -> Self {
        assert!(
            size.is_power_of_two(),
            "FFT size {size} is not a power of two"
        );
        let angles = (0..size / 2).map(|k| TAU * k as f64 / size as f64);
        Self {
            size,
            cos: angles.clone().map(f64::cos).collect(),
            sin: angles.map(|a| -a.sin()).collect(),
        }
    }

    /// Transform `re` and `im` (each `size` long) in place.
    pub fn transform(&self, re: &mut [f64], im: &mut [f64]) {
        let n = self.size;
        let bits = n.trailing_zeros();
        if bits > 0 {
            for i in 0..n {
                let j = i.reverse_bits() >> (usize::BITS - bits);
                if j > i {
                    re.swap(i, j);
                    im.swap(i, j);
                }
            }
        }
        let mut half = 1;
        while half < n {
            let stride = n / (half * 2);
            for start in (0..n).step_by(half * 2) {
                for k in 0..half {
                    let (wr, wi) = (self.cos[k * stride], self.sin[k * stride]);
                    let (a, b) = (start + k, start + k + half);
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            half *= 2;
        }
    }
}

/// Short-time power spectra of a mono signal: Hann-windowed frames of `size`
/// samples every `hop` samples, each with `size / 2 + 1` bins.
#[derive(Clone, Debug)]
pub struct Spectrogram {
    pub size: usize,
    pub hop: usize,
    pub sample_rate: f32,
    /// One power spectrum per frame, `|X[k]|²`.
    pub frames: Vec<Vec<f64>>,
    /// The window's sum of squares, to turn powers back into mean squares.
    window_energy: f64,
}

impl Spectrogram {
    /// Frames start at 0 and continue while a whole frame fits; a signal
    /// shorter than one frame is zero-padded into a single frame.
    pub fn new(signal: &[f32], sample_rate: f32, size: usize, hop: usize) -> Self {
        let fft = Fft::new(size);
        let window: Vec<f64> = (0..size)
            .map(|n| 0.5 - 0.5 * (TAU * n as f64 / size as f64).cos())
            .collect();
        let count = if signal.len() <= size {
            1
        } else {
            (signal.len() - size) / hop + 1
        };
        let mut re = vec![0.0; size];
        let mut im = vec![0.0; size];
        let frames = (0..count)
            .map(|frame| {
                let start = frame * hop;
                for (n, (r, i)) in re.iter_mut().zip(im.iter_mut()).enumerate() {
                    let x = signal.get(start + n).copied().unwrap_or(0.0);
                    *r = f64::from(x) * window[n];
                    *i = 0.0;
                }
                fft.transform(&mut re, &mut im);
                (0..=size / 2)
                    .map(|k| re[k] * re[k] + im[k] * im[k])
                    .collect()
            })
            .collect();
        Self {
            size,
            hop,
            sample_rate,
            frames,
            window_energy: window.iter().map(|w| w * w).sum(),
        }
    }

    /// The centre frequency of bin `k`, in hertz.
    pub fn frequency(&self, k: usize) -> f64 {
        k as f64 * f64::from(self.sample_rate) / self.size as f64
    }

    /// Seconds from the start of the signal to the middle of frame `frame`.
    pub fn frame_time(&self, frame: usize) -> f64 {
        (frame * self.hop + self.size / 2) as f64 / f64::from(self.sample_rate)
    }

    /// The mean power spectrum over every frame, scaled so that summing a
    /// range of bins gives the mean square of the signal in that range.
    pub fn mean_square_spectrum(&self) -> Vec<f64> {
        let bins = self.size / 2 + 1;
        let mut mean = vec![0.0; bins];
        for frame in &self.frames {
            for (m, p) in mean.iter_mut().zip(frame) {
                *m += p;
            }
        }
        let scale = 1.0 / (self.frames.len().max(1) as f64 * self.size as f64 * self.window_energy);
        for (k, m) in mean.iter_mut().enumerate() {
            // Every bin but DC and Nyquist stands for its negative twin too.
            let twin = if k == 0 || k == bins - 1 { 1.0 } else { 2.0 };
            *m *= scale * twin;
        }
        mean
    }
}

/// The smallest power of two at least `seconds` long at `sample_rate`.
pub fn frame_size(sample_rate: f32, seconds: f32) -> usize {
    ((sample_rate * seconds).max(2.0) as usize).next_power_of_two()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::sine;

    #[test]
    fn a_cosine_lands_in_its_own_bins() {
        let size = 1_024;
        let fft = Fft::new(size);
        let mut re: Vec<f64> = (0..size)
            .map(|n| (TAU * 8.0 * n as f64 / size as f64).cos())
            .collect();
        let mut im = vec![0.0; size];
        fft.transform(&mut re, &mut im);
        let magnitude: Vec<f64> = (0..size).map(|k| re[k].hypot(im[k])).collect();
        assert!((magnitude[8] - size as f64 / 2.0).abs() < 1e-6);
        assert!((magnitude[size - 8] - size as f64 / 2.0).abs() < 1e-6);
        let others = (0..size).filter(|&k| k != 8 && k != size - 8);
        assert!(others.map(|k| magnitude[k]).all(|m| m < 1e-6));
    }

    #[test]
    fn the_mean_square_spectrum_sums_to_the_signals_mean_square() {
        let rate = 48_000.0;
        let signal = sine(1_000.0, 0.5, rate, 48_000);
        let spectrum = Spectrogram::new(&signal, rate, 4_096, 1_024).mean_square_spectrum();
        let total: f64 = spectrum.iter().sum();
        assert!((total - 0.125).abs() < 0.002, "{total}");
    }

    #[test]
    fn frame_sizes_are_powers_of_two() {
        assert_eq!(frame_size(48_000.0, 0.02), 1_024);
        assert_eq!(frame_size(44_100.0, 0.17), 8_192);
    }
}

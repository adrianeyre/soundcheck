//! Sample-rate conversion, for audio recorded at a rate other than the
//! engine's.
//!
//! A windowed-sinc interpolator: each output frame is the input around it,
//! weighted by a sinc low-passed below the lower of the two Nyquist
//! frequencies and tapered by a Blackman window. The kernel is tabulated
//! once, so converting a whole song takes a table lookup per tap, not a
//! `sin`. It runs once, when a file is imported, never on the audio thread.

use std::f64::consts::PI;
use std::ops::Range;

/// Zero crossings of the sinc on each side of the centre: the kernel's reach.
const ZERO_CROSSINGS: usize = 16;
/// Table entries between two zero crossings.
const RESOLUTION: usize = 512;
/// How far below Nyquist the filter cuts, to leave room for its roll-off.
const CUTOFF: f64 = 0.95;

/// `input`, recorded at `from` Hz, as it would have been recorded at `to` Hz.
/// The same rate hands the samples back as they are.
pub fn resample(input: &[f32], from: f64, to: f64) -> Vec<f32> {
    resample_range(input, from, to, 0..resampled_frames(input.len(), from, to))
}

/// How many frames `frames` recorded at `from` Hz make at `to` Hz.
pub fn resampled_frames(frames: usize, from: f64, to: f64) -> usize {
    if from == to || frames == 0 || from <= 0.0 || to <= 0.0 {
        return frames;
    }
    (frames as f64 / (from / to)).round() as usize
}

/// The frames `range` of what `resample` makes of `input`, sample for
/// sample, without converting the rest: each output frame depends only on
/// the input around it, so a long file converts a step at a time. A range
/// past the end is cut there.
pub fn resample_range(input: &[f32], from: f64, to: f64, range: Range<usize>) -> Vec<f32> {
    let length = resampled_frames(input.len(), from, to);
    let range = range.start.min(length)..range.end.min(length);
    if from == to || input.is_empty() || from <= 0.0 || to <= 0.0 {
        return input[range].to_vec();
    }
    let step = from / to;
    // Relative to the input's Nyquist: below 1 when converting down.
    let cutoff = CUTOFF * (to / from).min(1.0);
    let table = kernel_table();
    let reach = ZERO_CROSSINGS as f64 / cutoff;

    range
        .map(|n| {
            let centre = n as f64 * step;
            let first = (centre - reach).ceil().max(0.0) as usize;
            let last = ((centre + reach).floor() as usize).min(input.len() - 1);
            let mut sum = 0.0;
            for (k, &sample) in input.iter().enumerate().take(last + 1).skip(first) {
                sum += f64::from(sample) * lookup(&table, (centre - k as f64).abs() * cutoff);
            }
            (sum * cutoff) as f32
        })
        .collect()
}

/// The windowed sinc from 0 to `ZERO_CROSSINGS`, `RESOLUTION` entries to a
/// zero crossing, with one more past the end so lookups can interpolate.
fn kernel_table() -> Vec<f64> {
    let size = ZERO_CROSSINGS * RESOLUTION;
    (0..=size + 1)
        .map(|i| {
            let x = i as f64 / RESOLUTION as f64;
            if x >= ZERO_CROSSINGS as f64 {
                return 0.0;
            }
            let sinc = if i == 0 {
                1.0
            } else {
                (PI * x).sin() / (PI * x)
            };
            // Blackman, centred on 0 and reaching zero at the kernel's edge.
            let phase = PI * (x / ZERO_CROSSINGS as f64 + 1.0);
            let window = 0.42 - 0.5 * phase.cos() + 0.08 * (2.0 * phase).cos();
            sinc * window
        })
        .collect()
}

/// The kernel at `x` zero crossings from its centre.
fn lookup(table: &[f64], x: f64) -> f64 {
    let position = x * RESOLUTION as f64;
    let index = position as usize;
    if index + 1 >= table.len() {
        return 0.0;
    }
    let fraction = position - index as f64;
    table[index] + (table[index + 1] - table[index]) * fraction
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::sine;

    /// The largest difference, ignoring `edge` frames at each end, where
    /// the kernel runs off the input.
    fn worst_error(a: &[f32], b: &[f32], edge: usize) -> f32 {
        let end = a.len().min(b.len()) - edge;
        (edge..end).fold(0.0, |max, i| max.max((a[i] - b[i]).abs()))
    }

    #[test]
    fn the_same_rate_changes_nothing() {
        let input = sine(440.0, 0.5, 48_000.0, 1_000);
        assert_eq!(resample(&input, 48_000.0, 48_000.0), input);
    }

    #[test]
    fn a_range_is_that_stretch_of_the_whole_conversion() {
        let input = sine(440.0, 0.5, 44_100.0, 4_410);
        for (from, to) in [
            (44_100.0, 48_000.0),
            (48_000.0, 44_100.0),
            (44_100.0, 44_100.0),
        ] {
            let whole = resample(&input, from, to);
            assert_eq!(resampled_frames(input.len(), from, to), whole.len());
            assert_eq!(
                resample_range(&input, from, to, 1_000..3_000),
                whole[1_000..3_000]
            );
            // Past the end is cut there.
            let end = whole.len();
            assert_eq!(
                resample_range(&input, from, to, end - 10..end + 10),
                whole[end - 10..]
            );
            assert!(resample_range(&input, from, to, end + 5..end + 10).is_empty());
        }
    }

    #[test]
    fn a_tone_converted_up_is_the_same_tone_at_the_new_rate() {
        let input = sine(1_000.0, 0.5, 44_100.0, 44_100);
        let output = resample(&input, 44_100.0, 48_000.0);
        assert_eq!(output.len(), 48_000);
        let expected = sine(1_000.0, 0.5, 48_000.0, 48_000);
        assert!(worst_error(&output, &expected, 64) < 1e-3);
    }

    #[test]
    fn a_tone_converted_down_is_the_same_tone_at_the_new_rate() {
        let input = sine(1_000.0, 0.5, 96_000.0, 96_000);
        let output = resample(&input, 96_000.0, 48_000.0);
        assert_eq!(output.len(), 48_000);
        let expected = sine(1_000.0, 0.5, 48_000.0, 48_000);
        assert!(worst_error(&output, &expected, 64) < 1e-3);
    }

    #[test]
    fn converting_down_filters_out_what_the_new_rate_cannot_hold() {
        // 30 kHz fits under 96 kHz's Nyquist, not under 48 kHz's: left in,
        // it would fold back down to 18 kHz.
        let input = sine(30_000.0, 0.5, 96_000.0, 9_600);
        let output = resample(&input, 96_000.0, 48_000.0);
        let middle = &output[200..output.len() - 200];
        assert!(crate::dsp::measure::peak(middle) < 0.01);
    }
}

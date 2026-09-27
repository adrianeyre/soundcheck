//! Loudness in LUFS, per ITU-R BS.1770-4 and EBU R 128.
//!
//! Each channel is K-weighted (a high shelf for the head, then the RLB
//! high-pass), squared and summed over 100 ms steps. Momentary blocks are
//! four steps (400 ms, overlapping by 75%); short-term windows are thirty
//! (3 s). Integrated loudness gates the blocks at -70 LUFS, then at 10 LU
//! below the mean of what passed.

use std::f64::consts::PI;

const STEP_SECONDS: f64 = 0.1;
const BLOCK_STEPS: usize = 4;
const SHORT_TERM_STEPS: usize = 30;
const ABSOLUTE_GATE: f64 = -70.0;
const RELATIVE_GATE: f64 = -10.0;
/// The most points in the short-term series.
const MAX_SERIES: usize = 32;

/// How loud a stretch of stereo audio is. Silence reads `-inf`.
#[derive(Clone, Debug, PartialEq)]
pub struct Loudness {
    pub integrated: f64,
    pub max_short_term: f64,
    /// Short-term loudness of 3 s windows, as (window start in seconds,
    /// LUFS), at most `MAX_SERIES` of them and at least a second apart.
    pub short_term: Vec<(f64, f64)>,
}

/// Measure `left` and `right` (the same length) at `sample_rate`.
pub fn measure(left: &[f32], right: &[f32], sample_rate: f32) -> Loudness {
    let steps = step_powers(left, right, f64::from(sample_rate));
    let blocks: Vec<f64> = window_means(&steps, BLOCK_STEPS);
    let short_term = window_means(&steps, SHORT_TERM_STEPS);

    let every = (short_term.len().div_ceil(MAX_SERIES)).max(10);
    let series = short_term
        .iter()
        .enumerate()
        .step_by(every)
        .map(|(i, &p)| (i as f64 * STEP_SECONDS, lufs(p)))
        .collect();

    Loudness {
        integrated: gated(&blocks),
        max_short_term: short_term
            .iter()
            .copied()
            .map(lufs)
            .fold(f64::NEG_INFINITY, f64::max),
        short_term: series,
    }
}

/// The K-weighted power of each whole 100 ms step, summed over channels.
fn step_powers(left: &[f32], right: &[f32], sample_rate: f64) -> Vec<f64> {
    let step = (sample_rate * STEP_SECONDS).round() as usize;
    let mut powers = vec![0.0; left.len() / step.max(1)];
    for channel in [left, right] {
        let mut filter = KWeighting::new(sample_rate);
        for (power, chunk) in powers.iter_mut().zip(channel.chunks_exact(step)) {
            let sum: f64 = chunk
                .iter()
                .map(|&x| filter.process(f64::from(x)).powi(2))
                .sum();
            *power += sum / step as f64;
        }
    }
    powers
}

/// The mean power of every run of `length` steps, one run per step. A signal
/// shorter than one run is measured as a single, shorter run.
fn window_means(steps: &[f64], length: usize) -> Vec<f64> {
    if steps.is_empty() {
        return Vec::new();
    }
    if steps.len() < length {
        return vec![steps.iter().sum::<f64>() / steps.len() as f64];
    }
    steps
        .windows(length)
        .map(|w| w.iter().sum::<f64>() / length as f64)
        .collect()
}

/// Integrated loudness of momentary block powers, gated.
fn gated(blocks: &[f64]) -> f64 {
    let mean_above = |threshold: f64| {
        let passed: Vec<f64> = blocks
            .iter()
            .copied()
            .filter(|&p| lufs(p) > threshold)
            .collect();
        (!passed.is_empty()).then(|| passed.iter().sum::<f64>() / passed.len() as f64)
    };
    let Some(ungated) = mean_above(ABSOLUTE_GATE) else {
        return f64::NEG_INFINITY;
    };
    let threshold = lufs(ungated) + RELATIVE_GATE;
    mean_above(threshold.max(ABSOLUTE_GATE)).map_or(f64::NEG_INFINITY, lufs)
}

/// LUFS of a K-weighted, channel-summed mean square.
fn lufs(power: f64) -> f64 {
    if power > 0.0 {
        -0.691 + 10.0 * power.log10()
    } else {
        f64::NEG_INFINITY
    }
}

/// The two-stage K-weighting filter, designed for any sample rate. At 48 kHz
/// its coefficients are BS.1770's own.
#[derive(Clone, Debug)]
struct KWeighting {
    stages: [Section; 2],
}

impl KWeighting {
    fn new(sample_rate: f64) -> Self {
        // The head's high shelf.
        let k = (PI * 1_681.974_450_955_533 / sample_rate).tan();
        let q = 0.707_175_236_955_419_6;
        let vh = 10.0_f64.powf(3.999_843_853_973_347 / 20.0);
        let vb = vh.powf(0.499_666_774_154_541_6);
        let a0 = 1.0 + k / q + k * k;
        let shelf = Section::new(
            [
                (vh + vb * k / q + k * k) / a0,
                2.0 * (k * k - vh) / a0,
                (vh - vb * k / q + k * k) / a0,
            ],
            [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
        );

        // The RLB high-pass.
        let k = (PI * 38.135_470_876_024_44 / sample_rate).tan();
        let q = 0.500_327_037_323_877_3;
        let a0 = 1.0 + k / q + k * k;
        let high_pass = Section::new(
            [1.0, -2.0, 1.0],
            [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
        );
        Self {
            stages: [shelf, high_pass],
        }
    }

    fn process(&mut self, x: f64) -> f64 {
        self.stages.iter_mut().fold(x, |x, s| s.process(x))
    }
}

/// One biquad section in f64, transposed direct form II.
#[derive(Clone, Copy, Debug)]
struct Section {
    b: [f64; 3],
    a: [f64; 2],
    z: [f64; 2],
}

impl Section {
    fn new(b: [f64; 3], a: [f64; 2]) -> Self {
        Self { b, a, z: [0.0; 2] }
    }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::db_to_gain;
    use crate::dsp::measure::sine;

    const RATE: f32 = 48_000.0;

    /// A 1 kHz sine at `dbfs` peak on both channels, `seconds` long.
    fn tone(dbfs: f32, seconds: f32) -> Vec<f32> {
        sine(1_000.0, db_to_gain(dbfs), RATE, (seconds * RATE) as usize)
    }

    fn stereo(signal: &[f32]) -> Loudness {
        measure(signal, signal, RATE)
    }

    #[test]
    fn at_48_khz_the_filter_has_bs_1770s_coefficients() {
        let filter = KWeighting::new(48_000.0);
        let [shelf, high_pass] = filter.stages;
        let close = |a: f64, b: f64| (a - b).abs() < 1e-8;
        assert!(close(shelf.b[0], 1.535_124_859_586_97));
        assert!(close(shelf.b[1], -2.691_696_189_406_38));
        assert!(close(shelf.b[2], 1.198_392_810_852_85));
        assert!(close(shelf.a[0], -1.690_659_293_182_41));
        assert!(close(shelf.a[1], 0.732_480_774_215_85));
        assert!(close(high_pass.a[0], -1.990_047_454_833_98));
        assert!(close(high_pass.a[1], 0.990_072_250_366_21));
    }

    #[test]
    fn ebu_3341_case_1_a_minus_23_dbfs_stereo_sine_reads_minus_23_lufs() {
        let loudness = stereo(&tone(-23.0, 20.0));
        assert!((loudness.integrated + 23.0).abs() < 0.1, "{loudness:?}");
        assert!((loudness.max_short_term + 23.0).abs() < 0.1);
    }

    #[test]
    fn ebu_3341_case_2_a_minus_33_dbfs_stereo_sine_reads_minus_33_lufs() {
        let loudness = stereo(&tone(-33.0, 20.0));
        assert!((loudness.integrated + 33.0).abs() < 0.1, "{loudness:?}");
    }

    #[test]
    fn ebu_3341_case_3_quiet_passages_are_gated_out() {
        let signal = [tone(-36.0, 10.0), tone(-23.0, 60.0), tone(-36.0, 10.0)].concat();
        let loudness = stereo(&signal);
        assert!(
            (loudness.integrated + 23.0).abs() < 0.1,
            "{}",
            loudness.integrated
        );
    }

    #[test]
    fn ebu_3341_case_4_near_silence_is_gated_out_too() {
        let signal = [
            tone(-72.0, 10.0),
            tone(-36.0, 10.0),
            tone(-23.0, 60.0),
            tone(-36.0, 10.0),
            tone(-72.0, 10.0),
        ]
        .concat();
        let loudness = stereo(&signal);
        assert!(
            (loudness.integrated + 23.0).abs() < 0.1,
            "{}",
            loudness.integrated
        );
    }

    #[test]
    fn a_full_scale_sine_on_one_channel_reads_minus_3_lufs() {
        let signal = tone(0.0, 10.0);
        let loudness = measure(&signal, &vec![0.0; signal.len()], RATE);
        assert!(
            (loudness.integrated + 3.01).abs() < 0.1,
            "{}",
            loudness.integrated
        );
    }

    #[test]
    fn silence_has_no_loudness() {
        let silence = vec![0.0; 96_000];
        let loudness = stereo(&silence);
        assert_eq!(loudness.integrated, f64::NEG_INFINITY);
        assert_eq!(loudness.max_short_term, f64::NEG_INFINITY);
    }

    #[test]
    fn the_short_term_series_follows_a_level_change() {
        let signal = [tone(-40.0, 10.0), tone(-20.0, 10.0)].concat();
        let loudness = stereo(&signal);
        let (_, first) = loudness.short_term[0];
        let (start, last) = *loudness.short_term.last().unwrap();
        assert!(start >= 10.0);
        assert!((first + 40.0).abs() < 0.2, "{first}");
        assert!((last + 20.0).abs() < 0.2, "{last}");
        assert!((loudness.max_short_term + 20.0).abs() < 0.1);
    }
}

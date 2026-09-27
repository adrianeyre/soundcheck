//! Levels and peaks: RMS, sample peak, true peak and where the audio clips.
//!
//! True peak follows BS.1770-4 annex 2: oversample 4x with a polyphase
//! windowed-sinc interpolator and take the largest absolute value, which
//! finds peaks that fall between samples.

use std::f64::consts::PI;

/// A sample at or beyond this magnitude is clipped. The engine clamps its
/// output here, so clipped audio sits exactly on it.
pub const FULL_SCALE: f32 = 1.0;

const OVERSAMPLE: usize = 4;
const TAPS_PER_PHASE: usize = 16;
/// Clipped frames closer than this belong to one region.
const MERGE_SECONDS: f32 = 0.05;
/// The most regions listed; the rest are only counted.
pub const MAX_REGIONS: usize = 16;

/// Levels of a stretch of stereo audio, in dB relative to full scale.
/// Silence reads `-inf`.
#[derive(Clone, Debug, PartialEq)]
pub struct Levels {
    /// Over both channels together.
    pub rms_db: f32,
    pub sample_peak_db: f32,
    pub true_peak_db: f32,
    pub clipping: Clipping,
}

/// Where the audio reaches full scale.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Clipping {
    /// Frames where either channel is at or beyond full scale.
    pub clipped_frames: usize,
    /// The first `MAX_REGIONS` stretches that clip.
    pub regions: Vec<ClipRegion>,
    /// How many regions there are, listed or not.
    pub region_count: usize,
}

/// A stretch of clipping, in frames from the start: `start` is the first
/// clipped frame and `end` is one past the last.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClipRegion {
    pub start: usize,
    pub end: usize,
    /// Clipped frames within it.
    pub frames: usize,
}

/// Measure `left` and `right` (the same length) at `sample_rate`.
pub fn measure(left: &[f32], right: &[f32], sample_rate: f32) -> Levels {
    let squares: f64 = left
        .iter()
        .chain(right)
        .map(|&x| f64::from(x) * f64::from(x))
        .sum();
    let mean_square = squares / (left.len() + right.len()).max(1) as f64;
    let sample_peak = left
        .iter()
        .chain(right)
        .fold(0.0_f32, |m, x| m.max(x.abs()));
    let interpolator = Interpolator::new();
    let true_peak = interpolator
        .peak(left)
        .max(interpolator.peak(right))
        .max(sample_peak);
    Levels {
        rms_db: (10.0 * mean_square.log10()) as f32,
        sample_peak_db: 20.0 * sample_peak.log10(),
        true_peak_db: 20.0 * true_peak.log10(),
        clipping: clipping(left, right, sample_rate),
    }
}

/// Find every frame at full scale and group them into regions.
pub fn clipping(left: &[f32], right: &[f32], sample_rate: f32) -> Clipping {
    let merge = (MERGE_SECONDS * sample_rate) as usize;
    let mut result = Clipping::default();
    let mut current: Option<ClipRegion> = None;
    let clipped = left
        .iter()
        .zip(right)
        .enumerate()
        .filter(|(_, (l, r))| l.abs() >= FULL_SCALE || r.abs() >= FULL_SCALE)
        .map(|(frame, _)| frame);
    for frame in clipped {
        result.clipped_frames += 1;
        match current.as_mut() {
            Some(region) if frame - region.end <= merge => {
                region.end = frame + 1;
                region.frames += 1;
            }
            _ => {
                if let Some(done) = current.take() {
                    result.push(done);
                }
                current = Some(ClipRegion {
                    start: frame,
                    end: frame + 1,
                    frames: 1,
                });
            }
        }
    }
    if let Some(done) = current {
        result.push(done);
    }
    result
}

impl Clipping {
    fn push(&mut self, region: ClipRegion) {
        self.region_count += 1;
        if self.regions.len() < MAX_REGIONS {
            self.regions.push(region);
        }
    }
}

/// A 4x polyphase interpolator: a Hann-windowed sinc split into one short
/// filter per output phase.
#[derive(Clone, Debug)]
struct Interpolator {
    phases: [[f32; TAPS_PER_PHASE]; OVERSAMPLE],
}

impl Interpolator {
    fn new() -> Self {
        let length = OVERSAMPLE * TAPS_PER_PHASE;
        let centre = (length - 1) as f64 / 2.0;
        let mut phases = [[0.0; TAPS_PER_PHASE]; OVERSAMPLE];
        for n in 0..length {
            let t = (n as f64 - centre) / OVERSAMPLE as f64;
            let sinc = if t == 0.0 {
                1.0
            } else {
                (PI * t).sin() / (PI * t)
            };
            let window = 0.5 - 0.5 * (2.0 * PI * (n as f64 + 0.5) / length as f64).cos();
            phases[n % OVERSAMPLE][n / OVERSAMPLE] = (sinc * window) as f32;
        }
        // Each phase passes DC at unity gain.
        for phase in &mut phases {
            let sum: f32 = phase.iter().sum();
            phase.iter_mut().for_each(|c| *c /= sum);
        }
        Self { phases }
    }

    /// The largest absolute value of `signal` oversampled 4x.
    fn peak(&self, signal: &[f32]) -> f32 {
        let mut history = [0.0_f32; TAPS_PER_PHASE];
        let mut peak = 0.0_f32;
        // Run the filter's length past the end so the last samples count.
        let tail = std::iter::repeat_n(&0.0, TAPS_PER_PHASE);
        for &x in signal.iter().chain(tail) {
            history.rotate_right(1);
            history[0] = x;
            for phase in &self.phases {
                let y: f32 = phase.iter().zip(&history).map(|(c, h)| c * h).sum();
                peak = peak.max(y.abs());
            }
        }
        peak
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::sine;
    use std::f32::consts::{FRAC_PI_4, TAU};

    const RATE: f32 = 48_000.0;

    #[test]
    fn a_full_scale_sine_has_an_rms_of_minus_3_db_and_a_peak_of_0() {
        let signal = sine(1_000.0, 1.0, RATE, 48_000);
        let levels = measure(&signal, &signal, RATE);
        assert!((levels.rms_db + 3.01).abs() < 0.01, "{}", levels.rms_db);
        assert!(levels.sample_peak_db.abs() < 0.01);
        assert!(levels.true_peak_db.abs() < 0.1, "{}", levels.true_peak_db);
    }

    #[test]
    fn true_peak_finds_the_peak_between_samples() {
        // A quarter-sample-rate sine sampled 45° off its peaks: every sample
        // is at 0.707, but the wave itself reaches 0.5 dB under full scale.
        let amplitude = 0.944;
        let signal: Vec<f32> = (0..4_800)
            .map(|n| amplitude * (TAU * n as f32 / 4.0 + FRAC_PI_4).sin())
            .collect();
        let levels = measure(&signal, &signal, RATE);
        assert!(
            (levels.sample_peak_db + 3.51).abs() < 0.05,
            "{}",
            levels.sample_peak_db
        );
        assert!(
            (levels.true_peak_db + 0.5).abs() < 0.3,
            "{}",
            levels.true_peak_db
        );
    }

    #[test]
    fn silence_reads_minus_infinity() {
        let silence = vec![0.0; 4_800];
        let levels = measure(&silence, &silence, RATE);
        assert_eq!(levels.rms_db, f32::NEG_INFINITY);
        assert_eq!(levels.true_peak_db, f32::NEG_INFINITY);
        assert_eq!(levels.clipping, Clipping::default());
    }

    #[test]
    fn clipped_frames_are_grouped_into_regions_with_their_positions() {
        let mut left = vec![0.0; 48_000];
        let right = vec![0.0; 48_000];
        // Two bursts close together, then one a quarter of a second later.
        for frame in [1_000, 1_001, 1_002, 1_500, 13_000] {
            left[frame] = if frame == 1_001 { -1.0 } else { 1.0 };
        }
        let clipping = clipping(&left, &right, RATE);
        assert_eq!(clipping.clipped_frames, 5);
        assert_eq!(clipping.region_count, 2);
        assert_eq!(
            clipping.regions,
            vec![
                ClipRegion {
                    start: 1_000,
                    end: 1_501,
                    frames: 4
                },
                ClipRegion {
                    start: 13_000,
                    end: 13_001,
                    frames: 1
                },
            ]
        );
    }

    #[test]
    fn only_the_first_regions_are_listed() {
        let mut left = vec![0.0; 96_000];
        for frame in (0..96_000).step_by(4_000) {
            left[frame] = 1.0;
        }
        let clipping = clipping(&left, &left.clone(), RATE);
        assert_eq!(clipping.region_count, 24);
        assert_eq!(clipping.regions.len(), MAX_REGIONS);
    }
}

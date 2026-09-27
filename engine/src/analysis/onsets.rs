//! Onsets: where sounds start.
//!
//! The onset strength of each short frame is its spectral flux: how much
//! louder each bin got than it was in any of the few frames before,
//! log-compressed so quiet sounds count, summed over bins. Looking back a few
//! frames rather than one ignores the ripple a low note makes in frames
//! shorter than a few of its cycles. Onsets are the peaks of that curve that
//! stand clear of its local average.

use super::fft::Spectrogram;

/// How many frames back each frame is compared with.
const LOOKBACK: usize = 3;
/// Scales magnitudes before log compression; higher counts quieter changes.
const COMPRESSION: f64 = 1_000.0;
/// A peak is the largest value within this much either side.
const PEAK_SECONDS: f64 = 0.03;
/// The local average a peak must stand above spans this much before it and
/// half as much after.
const AVERAGE_SECONDS: f64 = 0.1;
/// How far above the local average, as a fraction of the loudest peak.
const THRESHOLD: f64 = 0.1;
/// Onsets closer together than this count as one.
const MIN_GAP_SECONDS: f64 = 0.05;

/// The onset strength of every frame of `spectrogram`. The first frame is
/// compared with silence, so a sound already playing at the start counts.
pub fn strength(spectrogram: &Spectrogram) -> Vec<f64> {
    let scale = 2.0 / spectrogram.size as f64;
    let bins = spectrogram.size / 2 + 1;
    let compressed: Vec<Vec<f64>> = spectrogram
        .frames
        .iter()
        .map(|frame| {
            frame
                .iter()
                .map(|p| (COMPRESSION * p.sqrt() * scale).ln_1p())
                .collect()
        })
        .collect();
    let mut reference = vec![0.0; bins];
    (0..compressed.len())
        .map(|t| {
            reference.fill(0.0);
            for before in &compressed[t.saturating_sub(LOOKBACK)..t] {
                for (r, b) in reference.iter_mut().zip(before) {
                    *r = f64::max(*r, *b);
                }
            }
            compressed[t]
                .iter()
                .zip(&reference)
                .map(|(now, before)| (now - before).max(0.0))
                .sum()
        })
        .collect()
}

/// The frames where sounds start, given their onset `strength` at
/// `frames_per_second`.
pub fn detect(strength: &[f64], frames_per_second: f64) -> Vec<usize> {
    detect_above(strength, frames_per_second, THRESHOLD)
}

/// As `detect`, with a peak standing `threshold` (a fraction of the loudest
/// peak) above its local average: lower finds quieter onsets.
pub fn detect_above(strength: &[f64], frames_per_second: f64, threshold: f64) -> Vec<usize> {
    let loudest = strength.iter().copied().fold(0.0, f64::max);
    if loudest <= 0.0 {
        return Vec::new();
    }
    let frames = |seconds: f64| (seconds * frames_per_second).round().max(1.0) as usize;
    let (peak, average, gap) = (
        frames(PEAK_SECONDS),
        frames(AVERAGE_SECONDS),
        frames(MIN_GAP_SECONDS),
    );

    let mut onsets: Vec<usize> = Vec::new();
    for (i, &value) in strength.iter().enumerate() {
        let around = &strength[i.saturating_sub(peak)..(i + peak + 1).min(strength.len())];
        if value <= 0.0 || around.iter().any(|&v| v > value) {
            continue;
        }
        let local = &strength[i.saturating_sub(average)..(i + average / 2 + 1).min(strength.len())];
        let mean = local.iter().sum::<f64>() / local.len() as f64;
        if value < mean + threshold * loudest {
            continue;
        }
        if onsets.last().is_none_or(|&last| i - last >= gap) {
            onsets.push(i);
        }
    }
    onsets
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::fft::Spectrogram;
    use crate::dsp::measure::sine;

    const RATE: f32 = 48_000.0;
    const HOP: usize = 240;

    /// Onset times, in seconds, of `signal` as `analyse` would find them.
    fn onset_times(signal: &[f32]) -> Vec<f64> {
        let spectrogram = Spectrogram::new(signal, RATE, 1_024, HOP);
        let strength = strength(&spectrogram);
        detect(&strength, f64::from(RATE) / HOP as f64)
            .into_iter()
            .map(|frame| spectrogram.frame_time(frame))
            .collect()
    }

    /// Plucked 440 Hz notes starting at `starts` seconds, within `seconds`.
    fn notes_at(starts: &[f32], seconds: f32) -> Vec<f32> {
        let mut signal = vec![0.0; (seconds * RATE) as usize];
        let mut note = sine(440.0, 0.5, RATE, (0.3 * RATE) as usize);
        for (n, sample) in note.iter_mut().enumerate() {
            *sample *= (-(n as f32) / (0.04 * RATE)).exp();
        }
        for &start in starts {
            let at = (start * RATE) as usize;
            for (s, n) in signal[at..].iter_mut().zip(&note) {
                *s += n;
            }
        }
        signal
    }

    #[test]
    fn each_note_start_is_an_onset_at_its_time() {
        let starts = [0.25, 0.6, 1.0, 1.1, 1.75];
        let found = onset_times(&notes_at(&starts, 2.0));
        assert_eq!(found.len(), starts.len(), "{found:?}");
        for (found, expected) in found.iter().zip(starts) {
            assert!(
                (found - f64::from(expected)).abs() < 0.02,
                "{found} vs {expected}"
            );
        }
    }

    #[test]
    fn a_steady_tone_starts_once_and_silence_never() {
        let tone = [vec![0.0; 12_000], sine(440.0, 0.5, RATE, 96_000)].concat();
        assert_eq!(onset_times(&tone).len(), 1);
        assert!(onset_times(&vec![0.0; 48_000]).is_empty());
    }
}

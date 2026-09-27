//! Tempo: the beat period that best explains when sounds start.
//!
//! The onset strength curve is autocorrelated; a steady beat makes it repeat
//! every beat. Each candidate period is weighted by a broad preference for
//! tempos near 120 BPM, which is how listeners resolve a beat that could be
//! counted at half or double speed. Beats much above 160 BPM may therefore
//! read at half-time, as drum and bass is often felt.

const MIN_BPM: f64 = 50.0;
const MAX_BPM: f64 = 220.0;
/// Where tempo preference peaks, and how many octaves wide it is.
const PREFERRED_BPM: f64 = 120.0;
const PREFERENCE_OCTAVES: f64 = 1.0;
/// The window of the local average that onset strength must rise above.
const AVERAGE_SECONDS: f64 = 0.2;

/// A detected tempo and how sure of it the analysis is, 0..=1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tempo {
    pub bpm: f64,
    pub confidence: f64,
}

/// The tempo of an onset `strength` curve at `frames_per_second`, or `None`
/// when nothing repeats.
pub fn detect(strength: &[f64], frames_per_second: f64) -> Option<Tempo> {
    let mut peaks = sharpen(strength, frames_per_second);
    // The first frame is compared with silence: it measures whatever is
    // already sounding, which says nothing about the beat.
    if let Some(first) = peaks.first_mut() {
        *first = 0.0;
    }
    let mean = peaks.iter().sum::<f64>() / peaks.len().max(1) as f64;
    let centred: Vec<f64> = peaks.iter().map(|s| s - mean).collect();
    let min_lag = (60.0 * frames_per_second / MAX_BPM).floor() as usize;
    let max_lag = (60.0 * frames_per_second / MIN_BPM).ceil() as usize;
    if centred.len() < max_lag + 2 {
        return None;
    }
    let correlation = |lag: usize| -> f64 {
        let n = centred.len() - lag;
        let sum: f64 = centred[..n]
            .iter()
            .zip(&centred[lag..])
            .map(|(a, b)| a * b)
            .sum();
        // Unbiased: each lag is an average over the pairs it has.
        sum / n as f64
    };
    let energy = correlation(0);
    if energy <= 0.0 {
        return None;
    }
    let correlations: Vec<f64> = (0..=max_lag + 1).map(correlation).collect();

    let bpm_of = |lag: f64| 60.0 * frames_per_second / lag;
    let preference = |lag: usize| {
        let octaves = (bpm_of(lag as f64) / PREFERRED_BPM).log2() / PREFERENCE_OCTAVES;
        (-0.5 * octaves * octaves).exp()
    };
    let best = (min_lag.max(1)..=max_lag)
        .max_by(|&a, &b| {
            let score = |lag: usize| correlations[lag] * preference(lag);
            score(a).total_cmp(&score(b))
        })
        .filter(|&lag| correlations[lag] > 0.0)?;

    // Refine between lags with a parabola through the peak and its neighbours.
    let (before, peak, after) = (
        correlations[best - 1],
        correlations[best],
        correlations[best + 1],
    );
    let curvature = before - 2.0 * peak + after;
    let offset = if curvature < 0.0 {
        (0.5 * (before - after) / curvature).clamp(-0.5, 0.5)
    } else {
        0.0
    };
    Some(Tempo {
        bpm: bpm_of(best as f64 + offset),
        confidence: (peak / energy).clamp(0.0, 1.0),
    })
}

/// Keep only what rises above the curve's local average, so the steady
/// flicker of sustained sound doesn't blur the beat.
fn sharpen(strength: &[f64], frames_per_second: f64) -> Vec<f64> {
    let half = ((AVERAGE_SECONDS * frames_per_second) / 2.0)
        .round()
        .max(1.0) as usize;
    (0..strength.len())
        .map(|i| {
            let around = &strength[i.saturating_sub(half)..(i + half + 1).min(strength.len())];
            let mean = around.iter().sum::<f64>() / around.len() as f64;
            (strength[i] - mean).max(0.0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FPS: f64 = 200.0;

    /// An onset strength curve with a spike every `period` seconds.
    fn pulses(period: f64, seconds: f64) -> Vec<f64> {
        let frames = (seconds * FPS) as usize;
        let mut curve = vec![0.0; frames];
        let mut t = 0.0;
        while ((t * FPS) as usize) < frames {
            curve[(t * FPS).round() as usize % frames] = 1.0;
            t += period;
        }
        curve
    }

    #[test]
    fn a_pulse_every_half_second_is_120_bpm() {
        let tempo = detect(&pulses(0.5, 10.0), FPS).unwrap();
        assert!((tempo.bpm - 120.0).abs() < 0.5, "{tempo:?}");
        assert!(tempo.confidence > 0.8, "{tempo:?}");
    }

    #[test]
    fn slower_and_faster_beats_are_found_too() {
        for bpm in [72.0, 95.0, 140.0, 160.0] {
            let tempo = detect(&pulses(60.0 / bpm, 12.0), FPS).unwrap();
            assert!((tempo.bpm - bpm).abs() < 1.0, "{bpm}: {tempo:?}");
        }
    }

    #[test]
    fn nothing_repeating_has_no_tempo() {
        assert_eq!(detect(&vec![0.0; 2_000], FPS), None);
        assert_eq!(detect(&[1.0; 10], FPS), None);
    }
}

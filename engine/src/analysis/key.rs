//! Key: which major or minor key the notes sound in.
//!
//! The spectrum is folded into a chroma: how much energy each of the twelve
//! pitch classes has, across octaves. That is correlated with the
//! Krumhansl–Kessler key profiles (the Krumhansl–Schmuckler algorithm) for
//! all 24 keys, and the best match wins.

use super::fft::Spectrogram;

/// Pitches outside this range say more about timbre than key.
const LOWEST_HZ: f64 = 60.0;
const HIGHEST_HZ: f64 = 2_000.0;
/// A winning margin this large, in correlation, is full confidence.
const CLEAR_MARGIN: f64 = 0.1;

const NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];
const MAJOR: [f64; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR: [f64; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

/// A detected key and how sure of it the analysis is, 0..=1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Key {
    /// Pitch class of the tonic, 0 for C to 11 for B.
    pub tonic: usize,
    pub minor: bool,
    pub confidence: f64,
}

impl Key {
    /// Such as "C major" or "F# minor".
    pub fn name(&self) -> String {
        let mode = if self.minor { "minor" } else { "major" };
        format!("{} {mode}", NAMES[self.tonic])
    }
}

/// The key of `spectrogram`, or `None` when there is nothing pitched.
pub fn detect(spectrogram: &Spectrogram) -> Option<Key> {
    let chroma = chroma(spectrogram);
    if chroma.iter().all(|&c| c <= 0.0) {
        return None;
    }
    let mut scores: Vec<(f64, Key)> = (0..12)
        .flat_map(|tonic| [false, true].map(|minor| (tonic, minor)))
        .map(|(tonic, minor)| {
            let profile = if minor { &MINOR } else { &MAJOR };
            let rotated: [f64; 12] = std::array::from_fn(|pc| profile[(pc + 12 - tonic) % 12]);
            let key = Key {
                tonic,
                minor,
                confidence: 0.0,
            };
            (correlation(&chroma, &rotated), key)
        })
        .collect();
    scores.sort_by(|a, b| b.0.total_cmp(&a.0));
    let (best, mut key) = scores[0];
    let margin = best - scores[1].0;
    key.confidence = (best.clamp(0.0, 1.0) * (margin / CLEAR_MARGIN).min(1.0)).clamp(0.0, 1.0);
    Some(key)
}

/// Energy per pitch class, from the mean spectrum's magnitudes.
fn chroma(spectrogram: &Spectrogram) -> [f64; 12] {
    let spectrum = spectrogram.mean_square_spectrum();
    let mut chroma = [0.0; 12];
    for (k, power) in spectrum.iter().enumerate() {
        let frequency = spectrogram.frequency(k);
        if !(LOWEST_HZ..HIGHEST_HZ).contains(&frequency) {
            continue;
        }
        let pitch = 69.0 + 12.0 * (frequency / 440.0).log2();
        let class = (pitch.round() as i64).rem_euclid(12) as usize;
        chroma[class] += power.sqrt();
    }
    chroma
}

/// Pearson correlation of two 12-element profiles.
fn correlation(a: &[f64; 12], b: &[f64; 12]) -> f64 {
    let mean = |x: &[f64; 12]| x.iter().sum::<f64>() / 12.0;
    let (ma, mb) = (mean(a), mean(b));
    let (mut ab, mut aa, mut bb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        ab += (x - ma) * (y - mb);
        aa += (x - ma) * (x - ma);
        bb += (y - mb) * (y - mb);
    }
    if aa == 0.0 || bb == 0.0 {
        0.0
    } else {
        ab / (aa * bb).sqrt()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::sine;
    use crate::dsp::note_to_frequency;

    const RATE: f32 = 48_000.0;

    /// Chords of sines, each a second long, one after another.
    fn chords(chords: &[&[u8]]) -> Vec<f32> {
        chords
            .iter()
            .flat_map(|notes| {
                let mut chord = vec![0.0; RATE as usize];
                for &note in *notes {
                    let tone = sine(note_to_frequency(f32::from(note)), 0.2, RATE, chord.len());
                    chord.iter_mut().zip(tone).for_each(|(c, t)| *c += t);
                }
                chord
            })
            .collect()
    }

    fn key_of(signal: &[f32]) -> Option<Key> {
        detect(&Spectrogram::new(signal, RATE, 8_192, 4_096))
    }

    #[test]
    fn one_four_five_one_in_c_is_c_major() {
        let c = [48, 60, 64, 67].as_slice();
        let f = [53, 60, 65, 69].as_slice();
        let g = [55, 59, 62, 67].as_slice();
        let key = key_of(&chords(&[c, f, g, c])).unwrap();
        assert_eq!(key.name(), "C major");
        assert!(key.confidence > 0.5, "{key:?}");
    }

    #[test]
    fn one_four_five_one_in_a_minor_is_a_minor() {
        let a = [45, 57, 60, 64].as_slice();
        let d = [50, 57, 62, 65].as_slice();
        let e = [52, 56, 59, 64].as_slice();
        let key = key_of(&chords(&[a, d, e, a])).unwrap();
        assert_eq!(key.name(), "A minor");
    }

    #[test]
    fn silence_has_no_key() {
        assert_eq!(key_of(&vec![0.0; 48_000]), None);
    }
}

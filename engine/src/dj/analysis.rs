//! What a Deck shows of a file before it plays: its BPM, **Beat Grid**,
//! key and a three-band waveform. Worked out once, off the audio thread,
//! when the file is loaded.
//!
//! The tempo and key come from the same analysis the Assistant listens
//! through (`analysis/tempo.rs`, `key.rs`), over the middle of the file,
//! where a track is most itself. The first beat is where the onsets line
//! up best with a grid at that tempo. The waveform is each hundredth of a
//! second's loudest sample in the lows, mids and highs, split by the same
//! crossovers as the mixer's EQ.

use std::fmt::Write;

use crate::analysis::fft::{Spectrogram, frame_size};
use crate::analysis::{Key, key, onsets, tempo};
use crate::dsp::Biquad;

/// Points of waveform per second of the file.
pub const WAVEFORM_RATE: f64 = 100.0;
/// How much of the middle of the file tempo and key are measured over.
const MEASURE_SECONDS: f64 = 90.0;
const ONSET_FRAMES_PER_SECOND: f32 = 100.0;

#[derive(Clone, Debug, PartialEq)]
pub struct TrackAnalysis {
    pub seconds: f64,
    /// 0 when no steady beat was found.
    pub bpm: f64,
    pub first_beat: f64,
    pub key: Option<Key>,
    /// Low, mid and high peaks, and the whole signal's, for each point.
    pub waveform: Vec<[f32; 4]>,
}

impl TrackAnalysis {
    /// As JSON, for the Deck's display: the waveform flat, four numbers a
    /// point, to three places.
    pub fn to_json(&self) -> String {
        let mut out = String::with_capacity(64 + self.waveform.len() * 24);
        let key = match self.key {
            Some(key) => format!(r#"{{"tonic":{},"minor":{}}}"#, key.tonic, key.minor),
            None => "null".into(),
        };
        let _ = write!(
            out,
            r#"{{"seconds":{},"bpm":{},"firstBeat":{},"key":{key},"waveformRate":{WAVEFORM_RATE},"waveform":["#,
            round(self.seconds),
            round(self.bpm),
            round(self.first_beat),
        );
        for (index, point) in self.waveform.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            let _ = write!(
                out,
                "{},{},{},{}",
                round3(point[0]),
                round3(point[1]),
                round3(point[2]),
                round3(point[3])
            );
        }
        out.push_str("]}");
        out
    }
}

fn round(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

fn round3(value: f32) -> f32 {
    (value * 1_000.0).round() / 1_000.0
}

/// Analyse a file already decoded to `sample_rate`.
pub fn analyse(left: &[f32], right: &[f32], sample_rate: f32) -> TrackAnalysis {
    let rate = f64::from(sample_rate);
    let frames = left.len().min(right.len());
    let seconds = frames as f64 / rate;
    let mono: Vec<f32> = left.iter().zip(right).map(|(l, r)| 0.5 * (l + r)).collect();

    // The middle of the file, where the beat and the key are steadiest.
    let span = ((MEASURE_SECONDS * rate) as usize).min(frames);
    let from = (frames - span) / 2;
    let middle = &mono[from..from + span];

    let hop = (sample_rate / ONSET_FRAMES_PER_SECOND).round().max(1.0) as usize;
    let (bpm, first_beat) = if middle.len() > hop * 8 {
        let short = Spectrogram::new(middle, sample_rate, frame_size(sample_rate, 0.023), hop);
        let strength = onsets::strength(&short);
        let fps = rate / hop as f64;
        match tempo::detect(&strength, fps) {
            Some(found) => {
                let bpm = tidy_bpm(found.bpm);
                let phase = beat_phase(&strength, fps, bpm);
                // Back to the file's start, on the same grid.
                let beat = 60.0 / bpm;
                let first = (from as f64 / rate + phase).rem_euclid(beat);
                (bpm, first)
            }
            None => (0.0, 0.0),
        }
    } else {
        (0.0, 0.0)
    };
    let key = if middle.len() > 4_096 {
        let long = frame_size(sample_rate, 0.186);
        key::detect(&Spectrogram::new(middle, sample_rate, long, long / 2))
    } else {
        None
    };

    TrackAnalysis {
        seconds,
        bpm,
        first_beat,
        key,
        waveform: waveform(&mono, sample_rate),
    }
}

/// Dance music sits between 70 and 180 BPM; a reading outside that is
/// almost always half or double the beat. Rounded to a hundredth, as a
/// CDJ shows it.
fn tidy_bpm(bpm: f64) -> f64 {
    let mut bpm = bpm;
    while bpm < 70.0 {
        bpm *= 2.0;
    }
    while bpm > 180.0 {
        bpm /= 2.0;
    }
    (bpm * 100.0).round() / 100.0
}

/// Seconds from the start of `strength` to the first beat: the offset at
/// which a comb of beats `60 / bpm` apart gathers the most onset strength.
fn beat_phase(strength: &[f64], frames_per_second: f64, bpm: f64) -> f64 {
    let period = 60.0 / bpm * frames_per_second;
    let steps = 64;
    let mut best = (0.0, f64::NEG_INFINITY);
    for step in 0..steps {
        let offset = period * step as f64 / steps as f64;
        let mut sum = 0.0;
        let mut at = offset;
        while (at as usize) < strength.len() {
            sum += strength[at as usize];
            at += period;
        }
        if sum > best.1 {
            best = (offset, sum);
        }
    }
    best.0 / frames_per_second
}

/// Each point's loudest sample in the lows, mids and highs, and overall.
fn waveform(mono: &[f32], sample_rate: f32) -> Vec<[f32; 4]> {
    let per_point = (f64::from(sample_rate) / WAVEFORM_RATE).max(1.0) as usize;
    let q = std::f32::consts::FRAC_1_SQRT_2;
    let mut low = [Biquad::low_pass(sample_rate, 200.0, q); 2];
    let mut high = [Biquad::high_pass(sample_rate, 2_500.0, q); 2];
    let mut out = Vec::with_capacity(mono.len() / per_point + 1);
    for chunk in mono.chunks(per_point) {
        let mut point = [0.0f32; 4];
        for &x in chunk {
            let l = low[0].process(x);
            let l = low[1].process(l);
            let h = high[0].process(x);
            let h = high[1].process(h);
            let m = x - l - h;
            point[0] = point[0].max(l.abs());
            point[1] = point[1].max(m.abs());
            point[2] = point[2].max(h.abs());
            point[3] = point[3].max(x.abs());
        }
        out.push(point);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    /// Clicks at `bpm`, the first `offset` seconds in, for `seconds`.
    fn clicks(bpm: f64, offset: f64, seconds: f64) -> Vec<f32> {
        let frames = (seconds * f64::from(RATE)) as usize;
        let beat = 60.0 / bpm * f64::from(RATE);
        let mut out = vec![0.0; frames];
        let mut at = offset * f64::from(RATE);
        while (at as usize) < frames {
            let start = at as usize;
            for (i, sample) in out[start..(start + 400).min(frames)].iter_mut().enumerate() {
                let decay = (-(i as f32) / 80.0).exp();
                *sample = decay * if i % 2 == 0 { 0.8 } else { -0.8 };
            }
            at += beat;
        }
        out
    }

    #[test]
    fn finds_the_tempo_and_the_first_beat() {
        let audio = clicks(124.0, 0.21, 30.0);
        let found = analyse(&audio, &audio, RATE);
        assert!((found.bpm - 124.0).abs() < 1.0, "{}", found.bpm);
        let beat = 60.0 / found.bpm;
        let error = (found.first_beat - 0.21).rem_euclid(beat);
        let error = error.min(beat - error);
        assert!(
            error < 0.03,
            "first beat {} (off by {error})",
            found.first_beat
        );
        assert!((found.seconds - 30.0).abs() < 1e-9);
    }

    #[test]
    fn a_half_time_reading_is_doubled() {
        assert_eq!(tidy_bpm(64.0), 128.0);
        assert_eq!(tidy_bpm(250.0), 125.0);
        assert_eq!(tidy_bpm(123.456), 123.46);
    }

    #[test]
    fn the_waveform_splits_lows_from_highs() {
        let low = crate::dsp::measure::sine(60.0, 0.5, RATE, 48_000);
        let found = analyse(&low, &low, RATE);
        assert_eq!(found.waveform.len(), 100);
        let point = found.waveform[50];
        assert!(point[0] > 0.4 && point[2] < 0.05, "{point:?}");
        let json = found.to_json();
        assert!(json.starts_with(r#"{"seconds":1,"#), "{}", &json[..60]);
    }
}

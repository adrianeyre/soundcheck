//! One **Audio Clip**'s audio as the Audio Editor draws and cuts it: the
//! stretch of its file the Clip plays, at the file's own rate, measured at
//! any zoom, down to single samples.
//!
//! It is decoded once. Drawing asks for the quietest and loudest sample of
//! each channel in each of so many equal stretches of a range, which at a
//! wide zoom comes from a summary of every `BLOCK` frames, so drawing a
//! whole song's worth is as quick as drawing a bar of it. It also finds the
//! nearest zero crossing to a cut, so a cut doesn't click, and where sounds
//! start, to slice at.

use wasm_bindgen::prelude::*;

use crate::analysis::transients;
use crate::audio_file::decode;

/// Frames summarised together for the wide zooms.
const BLOCK: usize = 256;

/// One channel's samples and their summary: each `BLOCK`'s lowest and highest.
#[derive(Debug)]
struct Channel {
    samples: Vec<f32>,
    blocks: Vec<(f32, f32)>,
}

impl Channel {
    fn new(samples: Vec<f32>) -> Self {
        let blocks = samples
            .chunks(BLOCK)
            .map(|block| {
                block
                    .iter()
                    .fold((f32::MAX, f32::MIN), |(lo, hi), &s| (lo.min(s), hi.max(s)))
            })
            .collect();
        Self { samples, blocks }
    }

    /// The lowest and highest sample in frames `from..to`, which isn't empty.
    fn range(&self, from: usize, to: usize) -> (f32, f32) {
        let fold = |(lo, hi): (f32, f32), (a, b): (f32, f32)| (lo.min(a), hi.max(b));
        let mut out = (f32::MAX, f32::MIN);
        let mut at = from;
        while at < to {
            if at.is_multiple_of(BLOCK) && at + BLOCK <= to {
                out = fold(out, self.blocks[at / BLOCK]);
                at += BLOCK;
            } else {
                let s = self.samples[at];
                out = fold(out, (s, s));
                at += 1;
            }
        }
        out
    }
}

#[wasm_bindgen]
#[derive(Debug)]
pub struct ClipWaveform {
    left: Channel,
    right: Channel,
    rate: f64,
    stereo: bool,
}

impl ClipWaveform {
    /// The Clip that plays `seconds` of `left` and `right`, at `rate`, from
    /// `offset` seconds in, with silence where it runs past their end.
    pub fn new(left: &[f32], right: &[f32], rate: f64, offset: f64, seconds: f64) -> Self {
        // As `ClipRender` places the Clip in its file.
        let first = (offset.max(0.0) * rate).round() as usize;
        let frames = (seconds.max(0.0) * rate - 1e-6).ceil().max(0.0) as usize;
        let cut = |channel: &[f32]| {
            let mut out = vec![0.0; frames];
            let from = first.min(channel.len());
            let to = (first + frames).min(channel.len());
            out[..to - from].copy_from_slice(&channel[from..to]);
            out
        };
        let (left, right) = (cut(left), cut(right));
        let stereo = left != right;
        Self {
            left: Channel::new(left),
            right: Channel::new(right),
            rate,
            stereo,
        }
    }

    fn frame(&self, seconds: f64) -> usize {
        ((seconds.max(0.0) * self.rate).round() as usize).min(self.frames())
    }

    fn mono(&self, frame: usize) -> f32 {
        0.5 * (self.left.samples[frame] + self.right.samples[frame])
    }
}

#[wasm_bindgen]
impl ClipWaveform {
    /// Decode an audio file's bytes (WAV, FLAC or MP3) for the Clip that
    /// plays `seconds` of it from `offset` seconds in. Throws what is wrong
    /// with a file that can't be read.
    #[wasm_bindgen(constructor)]
    pub fn decode(bytes: &[u8], offset: f64, seconds: f64) -> Result<ClipWaveform, String> {
        let decoded = decode(bytes).map_err(|error| error.message().to_string())?;
        Ok(Self::new(
            &decoded.left,
            &decoded.right,
            decoded.rate,
            offset,
            seconds,
        ))
    }

    /// How many frames the Clip plays for.
    pub fn frames(&self) -> usize {
        self.left.samples.len()
    }

    /// The file's own sample rate, which the frames are at.
    pub fn sample_rate(&self) -> f64 {
        self.rate
    }

    /// Whether its two sides differ: a mono file is drawn once.
    pub fn stereo(&self) -> bool {
        self.stereo
    }

    /// The lowest and highest sample of each side in each of `points` equal
    /// stretches of `from` to `to` seconds into the Clip: `[left low, left
    /// high, right low, right high]` for each, 0 where the stretch holds no
    /// frame (past the end, or narrower than one frame, between two).
    pub fn peaks(&self, from: f64, to: f64, points: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(points * 4);
        let span = (to - from).max(0.0);
        for point in 0..points {
            let start = from + span * point as f64 / points as f64;
            let end = from + span * (point + 1) as f64 / points as f64;
            let first = ((start * self.rate).floor().max(0.0) as usize).min(self.frames());
            let last = ((end * self.rate).floor().max(0.0) as usize)
                .max(first + 1)
                .min(self.frames());
            if first >= last {
                out.extend([0.0; 4]);
                continue;
            }
            let (l_lo, l_hi) = self.left.range(first, last);
            let (r_lo, r_hi) = self.right.range(first, last);
            out.extend([l_lo, l_hi, r_lo, r_hi]);
        }
        out
    }

    /// The zero crossing of both sides mixed that is nearest to `seconds`,
    /// within `within` seconds either side: where a cut makes no click. The
    /// time itself where there is none that near.
    pub fn zero_crossing(&self, seconds: f64, within: f64) -> f64 {
        let at = self.frame(seconds);
        let reach = (within.max(0.0) * self.rate).round() as usize;
        let crosses = |frame: usize| {
            frame > 0
                && frame < self.frames()
                && (self.mono(frame - 1) <= 0.0) != (self.mono(frame) <= 0.0)
        };
        for distance in 0..=reach {
            // Nearest first, and earlier on a tie.
            for frame in [at.checked_sub(distance), Some(at + distance)]
                .into_iter()
                .flatten()
            {
                if crosses(frame) {
                    return frame as f64 / self.rate;
                }
            }
        }
        seconds
    }

    /// Where sounds start in the Clip, in seconds from its start, at a
    /// `sensitivity` from 0 (only the sharpest attacks) to 1 (nearly every
    /// change): where to slice a drum loop or a phrase.
    pub fn transients(&self, sensitivity: f64) -> Vec<f64> {
        let mono: Vec<f32> = (0..self.frames()).map(|frame| self.mono(frame)).collect();
        transients(&mono, self.rate as f32, sensitivity)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_file::tests::{TONE_RATE, TONE_WAV};

    const RATE: f64 = 48_000.0;

    fn mono(samples: &[f32], offset: f64, seconds: f64) -> ClipWaveform {
        ClipWaveform::new(samples, samples, RATE, offset, seconds)
    }

    #[test]
    fn it_is_the_stretch_the_clip_plays_with_silence_past_the_files_end() {
        let ramp: Vec<f32> = (0..1_000).map(|i| i as f32 / 1_000.0).collect();
        // 0.01 s in is frame 480; 0.03 s is 1,440 frames, 520 of them past the end.
        let waveform = mono(&ramp, 0.01, 0.03);
        assert_eq!(waveform.frames(), 1_440);
        assert_eq!(waveform.left.samples[0], 0.48);
        assert_eq!(waveform.left.samples[519], 0.999);
        assert!(waveform.left.samples[520..].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn peaks_are_each_stretchs_lowest_and_highest_on_each_side() {
        let left = [0.1, -0.5, 0.2, 0.9];
        let right = [0.0, 0.3, -0.2, 0.0];
        let waveform = ClipWaveform::new(&left, &right, 4.0, 0.0, 1.0);
        assert!(waveform.stereo());
        assert_eq!(
            waveform.peaks(0.0, 1.0, 2),
            vec![-0.5, 0.1, 0.0, 0.3, 0.2, 0.9, -0.2, 0.0]
        );
    }

    #[test]
    fn a_wide_zoom_reads_the_summary_and_agrees_with_the_samples() {
        let samples: Vec<f32> = (0..10_000)
            .map(|i| ((i * 7_919) % 1_000) as f32 / 500.0 - 1.0)
            .collect();
        let waveform = mono(&samples, 0.0, 10_000.0 / RATE);
        let peaks = waveform.peaks(0.0, 10_000.0 / RATE, 3);
        for (point, pair) in peaks.chunks(4).enumerate() {
            let first = point * 10_000 / 3;
            let last = ((point + 1) * 10_000 / 3).min(10_000);
            let stretch = &samples[first..last];
            let lo = stretch.iter().copied().fold(f32::MAX, f32::min);
            let hi = stretch.iter().copied().fold(f32::MIN, f32::max);
            assert_eq!((pair[0], pair[1]), (lo, hi), "point {point}");
        }
    }

    #[test]
    fn a_mono_file_says_so_and_past_the_end_is_silent() {
        let waveform = mono(&[0.5; 4], 0.0, 4.0 / RATE);
        assert!(!waveform.stereo());
        assert_eq!(waveform.peaks(0.0, 8.0 / RATE, 2)[4..], [0.0; 4]);
    }

    #[test]
    fn a_cut_moves_to_the_nearest_zero_crossing() {
        // Crosses zero between frames 99 and 100, and 199 and 200.
        let samples: Vec<f32> = (0..300)
            .map(|i| if (i / 100) % 2 == 0 { 0.5 } else { -0.5 })
            .collect();
        let waveform = mono(&samples, 0.0, 300.0 / RATE);
        assert_eq!(waveform.zero_crossing(110.0 / RATE, 0.001), 100.0 / RATE);
        assert_eq!(waveform.zero_crossing(160.0 / RATE, 0.001), 200.0 / RATE);
        // Nothing within reach: the cut stays.
        assert_eq!(
            waveform.zero_crossing(150.0 / RATE, 10.0 / RATE),
            150.0 / RATE
        );
    }

    #[test]
    fn transients_are_where_the_hits_start() {
        let mut samples = vec![0.0_f32; RATE as usize];
        for start in [0.1, 0.4, 0.7] {
            let first = (start * RATE) as usize;
            for i in 0..4_800 {
                let decay = (-(i as f32) / 600.0).exp();
                samples[first + i] = decay * (i as f32 * 0.3).sin();
            }
        }
        let found = mono(&samples, 0.0, 1.0).transients(0.5);
        assert_eq!(found.len(), 3, "{found:?}");
        for (at, expected) in found.iter().zip([0.1, 0.4, 0.7]) {
            assert!((at - expected).abs() < 0.02, "{at} for {expected}");
        }
        // Less sensitive finds no more than more sensitive.
        let waveform = mono(&samples, 0.0, 1.0);
        assert!(waveform.transients(0.0).len() <= waveform.transients(1.0).len());
    }

    #[test]
    fn it_decodes_a_file() {
        let waveform = ClipWaveform::decode(TONE_WAV, 0.05, 0.1).unwrap();
        assert_eq!(waveform.sample_rate(), TONE_RATE);
        assert_eq!(waveform.frames(), 4_410);
        assert_eq!(
            ClipWaveform::decode(b"not audio", 0.0, 1.0).unwrap_err(),
            "This isn't a WAV, FLAC or MP3 file"
        );
    }
}

//! One **Audio Clip**'s own audio, for Export Clip…: the stretch of its file
//! it plays, raw, past the mixer, so no fader, pan, Effect, Send or
//! Automation touches it.
//!
//! It is the audio the Clip plays, sample for sample: the file brought to
//! the rate asked for as the engine brings it when it loads it, from the
//! frame the engine starts the Clip on, for as many frames as the engine
//! plays it for, with silence where the Clip runs past its file's end. It is
//! converted a step at a time, so a host can show progress and cancel.

use wasm_bindgen::prelude::*;

use crate::audio_file::{Decoded, decode};
use crate::dsp::resample_range;

/// Tolerance when turning a length in seconds into frames, as the transport
/// has it, so a length that is a whole number of frames isn't one over.
const EPSILON: f64 = 1e-6;

#[wasm_bindgen]
#[derive(Debug)]
pub struct ClipRender {
    decoded: Decoded,
    rate: f64,
    /// The file's first frame the Clip plays, at `rate`.
    first: usize,
    /// How many frames the Clip plays for.
    frames: usize,
    /// How many of those have been rendered.
    done: usize,
}

impl ClipRender {
    /// The Clip that plays `seconds` of `decoded` from `offset` seconds in,
    /// at `sample_rate`.
    pub fn new(decoded: Decoded, offset: f64, seconds: f64, sample_rate: u32) -> Self {
        let rate = f64::from(sample_rate);
        // As `PreparedAudioClips` places the Clip in its file, and the
        // transport works out the frame it ends on.
        let first = (offset.max(0.0) * rate).round() as usize;
        let frames = (seconds.max(0.0) * rate - EPSILON).ceil().max(0.0) as usize;
        Self {
            decoded,
            rate,
            first,
            frames,
            done: 0,
        }
    }
}

#[wasm_bindgen]
impl ClipRender {
    /// Decode an audio file's bytes (WAV, FLAC or MP3) for the Clip that
    /// plays `seconds` of it from `offset` seconds in, at `sample_rate`.
    /// Throws what is wrong with a file that can't be read.
    #[wasm_bindgen(constructor)]
    pub fn decode(
        bytes: &[u8],
        offset: f64,
        seconds: f64,
        sample_rate: u32,
    ) -> Result<ClipRender, String> {
        let decoded = decode(bytes).map_err(|error| error.message().to_string())?;
        Ok(Self::new(decoded, offset, seconds, sample_rate))
    }

    /// How many frames the Clip plays for: the whole render.
    pub fn frames(&self) -> usize {
        self.frames
    }

    /// The next `max_frames` frames or fewer, interleaved stereo; empty once
    /// the whole Clip has been rendered.
    pub fn render_next(&mut self, max_frames: usize) -> Vec<f32> {
        let count = max_frames.min(self.frames - self.done);
        let from = self.first + self.done;
        let range = from..from + count;
        let Decoded { left, right, rate } = &self.decoded;
        let left = resample_range(left, *rate, self.rate, range.clone());
        let right = resample_range(right, *rate, self.rate, range);
        self.done += count;
        // Past the file's end, the Clip plays silence.
        let mut out = vec![0.0; count * 2];
        for (frame, (l, r)) in left.iter().zip(&right).enumerate() {
            out[frame * 2] = *l;
            out[frame * 2 + 1] = *r;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_file::AudioFile;
    use crate::audio_file::tests::{TONE_FRAMES, TONE_RATE, TONE_WAV};
    use crate::engine::{Engine, TRACKS_GAIN};

    fn render_all(mut render: ClipRender, step: usize) -> Vec<f32> {
        let mut out = Vec::new();
        loop {
            let next = render.render_next(step);
            if next.is_empty() {
                return out;
            }
            out.extend(next);
        }
    }

    fn interleaved(file: &AudioFile, frames: std::ops::Range<usize>) -> Vec<f32> {
        frames
            .flat_map(|i| [file.left()[i], file.right()[i]])
            .collect()
    }

    #[test]
    fn a_trimmed_clip_at_its_files_rate_is_its_stretch_sample_for_sample() {
        let render = ClipRender::decode(TONE_WAV, 0.05, 0.1, 44_100).unwrap();
        assert_eq!(render.frames(), 4_410);
        let file = AudioFile::decode(TONE_WAV, TONE_RATE as f32).unwrap();
        // 0.05 s in is frame 2,205.
        assert_eq!(render_all(render, 1_000), interleaved(&file, 2_205..6_615));
    }

    #[test]
    fn at_another_rate_it_is_the_stretch_of_the_file_as_the_engine_loads_it() {
        let render = ClipRender::decode(TONE_WAV, 0.05, 0.1, 48_000).unwrap();
        assert_eq!(render.frames(), 4_800);
        let file = AudioFile::decode(TONE_WAV, 48_000.0).unwrap();
        assert_eq!(render_all(render, 777), interleaved(&file, 2_400..7_200));
    }

    #[test]
    fn it_is_what_the_engine_plays_for_the_clip_on_its_own() {
        for rate in [44_100, 48_000] {
            let mut engine = Engine::new(rate as f32);
            engine.set_track_count(1);
            engine.set_track_audio(0, true);
            assert_eq!(engine.load_audio_file(1, TONE_WAV), None);
            // At tick 0, 0.1 s from 0.05 s in.
            engine.set_track_audio_clips(0, &[0.0, 0.1, 1.0, 0.05]);
            let played = engine.render_range(0.0, 960.0);
            let render = ClipRender::decode(TONE_WAV, 0.05, 0.1, rate).unwrap();
            let frames = render.frames();
            let exported = render_all(render, 4_800);
            // A lone Track at unity, centred, is the Clip at the mix's level.
            let worst = exported
                .iter()
                .zip(&played)
                .fold(0.0_f32, |max, (a, b)| max.max((a * TRACKS_GAIN - b).abs()));
            assert!(worst < 1e-6, "{rate} Hz: off by {worst}");
            // And it stops where the Clip does.
            assert!(played[frames * 2..].iter().all(|&s| s == 0.0));
        }
    }

    #[test]
    fn past_the_files_end_the_clip_is_silent() {
        let render = ClipRender::decode(TONE_WAV, 0.2, 0.1, 44_100).unwrap();
        let out = render_all(render, 100_000);
        assert_eq!(out.len(), 4_410 * 2);
        let file = AudioFile::decode(TONE_WAV, TONE_RATE as f32).unwrap();
        let end = TONE_FRAMES - 8_820;
        assert_eq!(out[..end * 2], interleaved(&file, 8_820..TONE_FRAMES)[..]);
        assert!(out[end * 2..].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn a_file_that_isnt_audio_says_so() {
        let error = ClipRender::decode(b"not audio", 0.0, 1.0, 44_100).unwrap_err();
        assert_eq!(error, "This isn't a WAV, FLAC or MP3 file");
    }
}

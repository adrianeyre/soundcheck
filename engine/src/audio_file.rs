//! An audio file the host hands over as bytes, for an **Audio Clip** to play.
//!
//! The engine never opens a file (ADR 0001): a host reads the bytes and they
//! are decoded here, WAV, FLAC or MP3, by `symphonia`. The audio is then
//! converted to the engine's own sample rate, once, so playing it back is a
//! plain copy: sample-accurate, and cheap on the audio thread.

use std::io::Cursor;

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::dsp::resample;

/// Why an audio file couldn't be read, in words a musician can act on.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioFileError {
    NotAudio,
    Unsupported,
    Empty,
}

impl AudioFileError {
    pub fn message(self) -> &'static str {
        match self {
            Self::NotAudio => "This isn't a WAV, FLAC or MP3 file",
            Self::Unsupported => "This file is in a format the Audio Engine can't read yet",
            Self::Empty => "This file has no audio in it",
        }
    }
}

/// A file's audio as it was recorded: one list of samples per side (a mono
/// file has the same list twice), at the file's own rate.
#[derive(Clone, Debug, PartialEq)]
pub struct Decoded {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub rate: f64,
}

impl Decoded {
    pub fn frames(&self) -> usize {
        self.left.len()
    }

    pub fn seconds(&self) -> f64 {
        self.frames() as f64 / self.rate
    }

    /// The loudest sample of either side in each of `points` equal stretches
    /// of the file: enough to draw its waveform.
    pub fn peaks(&self, points: usize) -> Vec<f32> {
        let frames = self.frames();
        (0..points)
            .map(|point| {
                let start = point * frames / points;
                let end = ((point + 1) * frames / points).max(start + 1).min(frames);
                (start..end).fold(0.0_f32, |max, i| {
                    max.max(self.left[i].abs()).max(self.right[i].abs())
                })
            })
            .collect()
    }
}

/// Decode a WAV, FLAC or MP3 file's bytes. Channels past the second are
/// dropped, since a Track's mixer channel is stereo.
pub fn decode(bytes: &[u8]) -> Result<Decoded, AudioFileError> {
    let source = MediaSourceStream::new(Box::new(Cursor::new(bytes.to_vec())), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(
            &Hint::new(),
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|_| AudioFileError::NotAudio)?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or(AudioFileError::NotAudio)?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|params| params.audio())
        .ok_or(AudioFileError::Unsupported)?;
    let mut rate = params.sample_rate.map(f64::from);
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|_| AudioFileError::Unsupported)?;

    let (mut left, mut right) = (Vec::new(), Vec::new());
    let mut planes: Vec<Vec<f32>> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            // A file cut short still plays as far as it goes.
            Err(_) => break,
        };
        if packet.track_id != track_id {
            continue;
        }
        let buffer = match decoder.decode(&packet) {
            Ok(buffer) => buffer,
            // One damaged frame is skipped, as players do.
            Err(Error::DecodeError(_)) => continue,
            Err(_) => break,
        };
        rate = rate.or(Some(f64::from(buffer.spec().rate())));
        buffer.copy_to_vecs_planar::<f32>(&mut planes);
        let Some(first) = planes.first() else {
            continue;
        };
        left.extend_from_slice(first);
        right.extend_from_slice(planes.get(1).unwrap_or(first));
    }

    let rate = rate
        .filter(|&rate| rate > 0.0)
        .ok_or(AudioFileError::Unsupported)?;
    if left.is_empty() {
        return Err(AudioFileError::Empty);
    }
    Ok(Decoded { left, right, rate })
}

/// An audio file decoded and brought to the engine's sample rate, ready to
/// play.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioFile {
    left: Vec<f32>,
    right: Vec<f32>,
}

impl AudioFile {
    /// Decode a file's bytes and convert them to `sample_rate`.
    pub fn decode(bytes: &[u8], sample_rate: f32) -> Result<Self, AudioFileError> {
        decode(bytes).map(|decoded| Self::from_decoded(&decoded, sample_rate))
    }

    pub fn from_decoded(decoded: &Decoded, sample_rate: f32) -> Self {
        let to = f64::from(sample_rate);
        Self {
            left: resample(&decoded.left, decoded.rate, to),
            right: resample(&decoded.right, decoded.rate, to),
        }
    }

    /// Samples already at the engine's rate, both sides the same length.
    pub fn from_samples(left: Vec<f32>, right: Vec<f32>) -> Self {
        debug_assert_eq!(left.len(), right.len());
        Self { left, right }
    }

    /// Frames at the engine's rate.
    pub fn frames(&self) -> usize {
        self.left.len()
    }

    pub fn left(&self) -> &[f32] {
        &self.left
    }

    pub fn right(&self) -> &[f32] {
        &self.right
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub const TONE_WAV: &[u8] = include_bytes!("../tests/fixtures/tone.wav");
    pub const TONE_FLAC: &[u8] = include_bytes!("../tests/fixtures/tone.flac");
    pub const TONE_MP3: &[u8] = include_bytes!("../tests/fixtures/tone.mp3");
    /// What each fixture holds: 0.25 s at 44.1 kHz of a 400 Hz sine at half
    /// scale on the left and an 800 Hz one at quarter scale on the right.
    pub const TONE_RATE: f64 = 44_100.0;
    pub const TONE_FRAMES: usize = 11_025;

    /// The fixtures' tone at frame `frame` of `rate`, on `side` (0 left).
    pub fn tone(frame: usize, rate: f64, side: usize) -> f32 {
        let t = frame as f64 / rate;
        let (frequency, level) = if side == 0 {
            (400.0, 0.5)
        } else {
            (800.0, 0.25)
        };
        (level * (std::f64::consts::TAU * frequency * t).sin()) as f32
    }

    /// A 16-bit WAV of `left` and `right`, at `rate`.
    pub fn stereo_wav(left: &[f32], right: &[f32], rate: u32) -> Vec<u8> {
        let data: Vec<u8> = left
            .iter()
            .zip(right)
            .flat_map(|(&l, &r)| [l, r])
            .flat_map(|s| ((s * 32_767.0).round() as i16).to_le_bytes())
            .collect();
        let mut out = Vec::new();
        out.extend(b"RIFF");
        out.extend((36 + data.len() as u32).to_le_bytes());
        out.extend(b"WAVEfmt ");
        out.extend(16u32.to_le_bytes());
        out.extend(1u16.to_le_bytes());
        out.extend(2u16.to_le_bytes());
        out.extend(rate.to_le_bytes());
        out.extend((rate * 4).to_le_bytes());
        out.extend(4u16.to_le_bytes());
        out.extend(16u16.to_le_bytes());
        out.extend(b"data");
        out.extend((data.len() as u32).to_le_bytes());
        out.extend(data);
        out
    }

    fn worst_error(decoded: &Decoded) -> f32 {
        (0..decoded.frames()).fold(0.0, |max, i| {
            max.max((decoded.left[i] - tone(i, decoded.rate, 0)).abs())
                .max((decoded.right[i] - tone(i, decoded.rate, 1)).abs())
        })
    }

    #[test]
    fn a_wav_decodes_to_the_samples_it_holds() {
        let decoded = decode(TONE_WAV).unwrap();
        assert_eq!(decoded.rate, TONE_RATE);
        assert_eq!(decoded.frames(), TONE_FRAMES);
        assert!(worst_error(&decoded) < 1e-4);
    }

    #[test]
    fn a_flac_decodes_to_the_samples_it_holds() {
        let decoded = decode(TONE_FLAC).unwrap();
        assert_eq!(decoded.rate, TONE_RATE);
        assert_eq!(decoded.frames(), TONE_FRAMES);
        assert!(worst_error(&decoded) < 1e-4);
    }

    #[test]
    fn an_mp3_decodes_to_the_tone_it_was_made_from() {
        let decoded = decode(TONE_MP3).unwrap();
        assert_eq!(decoded.rate, TONE_RATE);
        assert!(decoded.frames() >= TONE_FRAMES);
        let error = best_aligned_error(&decoded.left, |i| tone(i, TONE_RATE, 0));
        assert!(error < 0.05, "{error}");
    }

    /// An MP3 encoder puts a delay of its own in front of the audio, which
    /// only some files say the length of: the RMS difference from `expected`
    /// at the best delay up to 3000 frames, over the middle of the tone.
    pub fn best_aligned_error(actual: &[f32], expected: impl Fn(usize) -> f32) -> f32 {
        let (from, to) = (1_000, 9_000);
        (0..3_000)
            .filter(|delay| delay + to <= actual.len())
            .map(|delay| {
                let sum: f32 = (from..to)
                    .map(|i| (actual[i + delay] - expected(i)).powi(2))
                    .sum();
                (sum / (to - from) as f32).sqrt()
            })
            .fold(f32::MAX, f32::min)
    }

    #[test]
    fn a_mono_file_plays_down_the_middle() {
        let mut wav = stereo_wav(&[0.5, -0.5], &[0.5, -0.5], 48_000);
        // Rewrite it as mono: one channel, two bytes a frame.
        wav[22] = 1;
        wav[28..32].copy_from_slice(&96_000u32.to_le_bytes());
        wav[32] = 2;
        let decoded = decode(&wav).unwrap();
        assert_eq!(decoded.frames(), 4);
        assert_eq!(decoded.left, decoded.right);
    }

    #[test]
    fn a_file_is_brought_to_the_engines_rate() {
        let file = AudioFile::decode(TONE_WAV, 48_000.0).unwrap();
        assert_eq!(file.frames(), 12_000);
        for i in 64..file.frames() - 64 {
            assert!((file.left()[i] - tone(i, 48_000.0, 0)).abs() < 2e-3);
            assert!((file.right()[i] - tone(i, 48_000.0, 1)).abs() < 2e-3);
        }
    }

    #[test]
    fn the_waveform_is_the_loudest_sample_of_each_stretch() {
        let decoded = decode(&stereo_wav(
            &[0.0, 0.5, 0.0, 0.0],
            &[0.0, 0.0, 0.0, -0.25],
            48_000,
        ))
        .unwrap();
        let peaks = decoded.peaks(2);
        assert_eq!(peaks.len(), 2);
        assert!((peaks[0] - 0.5).abs() < 1e-3 && (peaks[1] - 0.25).abs() < 1e-3);
    }

    #[test]
    fn says_what_is_wrong_with_a_file_it_cant_read() {
        assert_eq!(decode(b"hello, not audio"), Err(AudioFileError::NotAudio));
        assert_eq!(
            decode(&stereo_wav(&[], &[], 48_000)),
            Err(AudioFileError::Empty)
        );
    }
}

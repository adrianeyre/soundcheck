//! Writing the mix as a WAV file's bytes, for export.
//!
//! The engine never opens a file (ADR 0001): a host renders the mix, has it
//! encoded here, and writes the bytes where the musician chose. Stereo, as
//! 16 or 24-bit integer PCM or 32-bit float. A mono file is for the
//! Assistant to hear (`mono_wav_bytes`).
//!
//! Integer samples are rounded to the nearest step, without dither, so a file
//! holds exactly the offline render quantised, and a 32-bit float file holds
//! the render itself.

use wasm_bindgen::prelude::*;

/// How a sample is stored in the file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SampleFormat {
    Int16,
    Int24,
    Float32,
}

const PCM: u16 = 1;
const FLOAT: u16 = 3;

impl SampleFormat {
    /// 16 and 24 are integer PCM, 32 is float; nothing else is offered.
    pub fn from_bits(bits: u32) -> Option<Self> {
        match bits {
            16 => Some(Self::Int16),
            24 => Some(Self::Int24),
            32 => Some(Self::Float32),
            _ => None,
        }
    }

    fn bytes(self) -> usize {
        match self {
            Self::Int16 => 2,
            Self::Int24 => 3,
            Self::Float32 => 4,
        }
    }

    fn write(self, sample: f32, out: &mut Vec<u8>) {
        match self {
            Self::Int16 => {
                let value = (sample * 32_768.0).round().clamp(-32_768.0, 32_767.0) as i16;
                out.extend(value.to_le_bytes());
            }
            Self::Int24 => {
                let value = (sample * 8_388_608.0)
                    .round()
                    .clamp(-8_388_608.0, 8_388_607.0) as i32;
                out.extend(&value.to_le_bytes()[..3]);
            }
            Self::Float32 => out.extend(sample.to_le_bytes()),
        }
    }
}

/// A stereo WAV file of `interleaved` samples at `sample_rate`, in `bits`
/// (16, 24 or 32 for float). None for any other bit depth.
#[wasm_bindgen]
pub fn encode_wav(interleaved: &[f32], sample_rate: u32, bits: u32) -> Option<Vec<u8>> {
    SampleFormat::from_bits(bits).map(|format| wav_bytes(interleaved, sample_rate, format))
}

/// `encode_wav` for native callers.
pub fn wav_bytes(interleaved: &[f32], sample_rate: u32, format: SampleFormat) -> Vec<u8> {
    wav_file(interleaved, 2, sample_rate, format)
}

/// A mono WAV file of `samples` at `sample_rate`.
pub fn mono_wav_bytes(samples: &[f32], sample_rate: u32, format: SampleFormat) -> Vec<u8> {
    wav_file(samples, 1, sample_rate, format)
}

/// A WAV file of `channels` interleaved; a frame left incomplete is dropped.
fn wav_file(interleaved: &[f32], channels: u16, sample_rate: u32, format: SampleFormat) -> Vec<u8> {
    let width = format.bytes();
    let per_frame = usize::from(channels);
    let frames = interleaved.len() / per_frame;
    let data_size = frames * per_frame * width;
    let float = format == SampleFormat::Float32;
    // A float file's format chunk carries an (empty) extension size, and a
    // fact chunk gives its length in frames, as the WAV spec asks.
    let fmt_size: u32 = if float { 18 } else { 16 };
    let fact_size = if float { 12 } else { 0 };
    let riff_size = 4 + (8 + fmt_size as usize) + fact_size + 8 + data_size;

    let mut out = Vec::with_capacity(8 + riff_size);
    out.extend(b"RIFF");
    out.extend(size32(riff_size).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(fmt_size.to_le_bytes());
    out.extend(if float { FLOAT } else { PCM }.to_le_bytes());
    out.extend(channels.to_le_bytes());
    out.extend(sample_rate.to_le_bytes());
    let block_align = per_frame * width;
    out.extend(size32(sample_rate as usize * block_align).to_le_bytes());
    out.extend((block_align as u16).to_le_bytes());
    out.extend((width as u16 * 8).to_le_bytes());
    if float {
        out.extend(0u16.to_le_bytes());
        out.extend(b"fact");
        out.extend(4u32.to_le_bytes());
        out.extend(size32(frames).to_le_bytes());
    }
    out.extend(b"data");
    out.extend(size32(data_size).to_le_bytes());
    for &sample in &interleaved[..frames * per_frame] {
        format.write(sample, &mut out);
    }
    out
}

/// A WAV can't say it is longer than 4 GB: over two hours of stereo float.
fn size32(size: usize) -> u32 {
    u32::try_from(size).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instrument::decode;

    fn ramp() -> Vec<f32> {
        (0..2_000)
            .map(|i| (i as f32 / 1_000.0 - 1.0) * 0.999)
            .collect()
    }

    #[test]
    fn a_float_file_holds_the_samples_exactly() {
        let samples = ramp();
        let file = encode_wav(&samples, 48_000, 32).unwrap();
        let read = decode(&file).unwrap();
        assert_eq!(read.rate(), 48_000.0);
        assert_eq!(read.frames(), 1_000);
        for frame in 0..1_000 {
            assert_eq!(read.at(frame, 0), samples[frame * 2]);
            assert_eq!(read.at(frame, 1), samples[frame * 2 + 1]);
        }
    }

    #[test]
    fn integer_files_hold_the_samples_to_half_a_step() {
        for (bits, step) in [(16, 1.0 / 32_768.0), (24, 1.0 / 8_388_608.0)] {
            let samples = ramp();
            let file = encode_wav(&samples, 44_100, bits).unwrap();
            let read = decode(&file).unwrap();
            assert_eq!(read.rate(), 44_100.0);
            assert_eq!(read.frames(), 1_000);
            for frame in 0..1_000 {
                for channel in 0..2 {
                    let error = (read.at(frame, channel) - samples[frame * 2 + channel]).abs();
                    assert!(error <= step / 2.0 + f32::EPSILON, "{bits}-bit: {error}");
                }
            }
        }
    }

    #[test]
    fn full_scale_stays_in_range() {
        let file = wav_bytes(&[1.0, -1.0], 48_000, SampleFormat::Int16);
        let read = decode(&file).unwrap();
        assert_eq!(read.at(0, 0), 32_767.0 / 32_768.0);
        assert_eq!(read.at(0, 1), -1.0);
    }

    #[test]
    fn the_header_gives_the_true_sizes() {
        let file = wav_bytes(&[0.0; 20], 48_000, SampleFormat::Int24);
        assert_eq!(file.len(), 44 + 10 * 6);
        let riff = u32::from_le_bytes(file[4..8].try_into().unwrap()) as usize;
        assert_eq!(riff, file.len() - 8);
        let float = wav_bytes(&[0.0; 20], 48_000, SampleFormat::Float32);
        let riff = u32::from_le_bytes(float[4..8].try_into().unwrap()) as usize;
        assert_eq!(riff, float.len() - 8);
    }

    #[test]
    fn a_mono_file_has_one_channel() {
        let samples: Vec<f32> = (0..1_000).map(|i| i as f32 / 2_000.0).collect();
        let file = mono_wav_bytes(&samples, 16_000, SampleFormat::Int16);
        assert_eq!(file.len(), 44 + 1_000 * 2);
        assert_eq!(u16::from_le_bytes([file[22], file[23]]), 1);
        let read = decode(&file).unwrap();
        assert_eq!((read.rate(), read.frames()), (16_000.0, 1_000));
        for (frame, &sample) in samples.iter().enumerate() {
            assert!((read.at(frame, 0) - sample).abs() <= 1.0 / 65_536.0 + f32::EPSILON);
        }
    }

    #[test]
    fn only_the_offered_depths_encode() {
        assert!(encode_wav(&[0.0, 0.0], 48_000, 8).is_none());
    }
}

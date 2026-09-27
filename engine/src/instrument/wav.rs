//! Reading a WAV file the host hands over, as bytes.
//!
//! The engine never opens a file (ADR 0001): a host reads the bytes and the
//! Drum Sampler decodes them here. The bundled kit goes through exactly the
//! same path, embedded at compile time.
//!
//! Uncompressed PCM only — 8, 16, 24 or 32-bit integer, or 32-bit float —
//! which is what a WAV from a DAW or a sample pack is.

/// Audio decoded from a WAV: samples interleaved by channel, -1 to 1.
#[derive(Clone, Debug, PartialEq)]
pub struct Sample {
    data: Vec<f32>,
    channels: usize,
    /// The rate the file was recorded at, which need not be the engine's.
    rate: f32,
}

/// Why a WAV couldn't be read, in words a musician can act on.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WavError {
    NotAWav,
    Unsupported,
    Empty,
}

impl WavError {
    pub fn message(self) -> &'static str {
        match self {
            Self::NotAWav => "This isn't a WAV file",
            Self::Unsupported => "This WAV is in a format the Drum Sampler can't read yet",
            Self::Empty => "This WAV has no audio in it",
        }
    }
}

impl Sample {
    /// Build a Sample from samples already interleaved by channel.
    pub fn new(data: Vec<f32>, channels: usize, rate: f32) -> Self {
        Self {
            data,
            channels: channels.max(1),
            rate,
        }
    }

    pub fn frames(&self) -> usize {
        self.data.len() / self.channels
    }

    pub fn rate(&self) -> f32 {
        self.rate
    }

    /// Frame `frame` of `channel`, or 0 past the end. A mono file answers
    /// for both channels, so it plays down the middle.
    pub fn at(&self, frame: usize, channel: usize) -> f32 {
        let channel = if self.channels == 1 { 0 } else { channel };
        self.data
            .get(frame * self.channels + channel)
            .copied()
            .unwrap_or(0.0)
    }

    /// Frame `position` of `channel`, reading between frames, so a sample can
    /// play at any speed.
    pub fn between(&self, position: f64, channel: usize) -> f32 {
        let frame = position as usize;
        let fraction = (position - frame as f64) as f32;
        let a = self.at(frame, channel);
        let b = self.at(frame + 1, channel);
        a + (b - a) * fraction
    }
}

/// Read a WAV file's bytes. Channels past the second are dropped, since the
/// Drum Sampler is mono or stereo.
pub fn decode(bytes: &[u8]) -> Result<Sample, WavError> {
    let header = bytes.get(..12).ok_or(WavError::NotAWav)?;
    if &header[..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err(WavError::NotAWav);
    }

    let mut format: Option<Format> = None;
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let body = bytes
            .get(offset + 8..offset + 8 + size)
            .unwrap_or(&bytes[(offset + 8).min(bytes.len())..]);
        match id {
            b"fmt " => format = Some(read_format(body)?),
            b"data" => {
                let format = format.ok_or(WavError::NotAWav)?;
                return read_data(body, format);
            }
            _ => {}
        }
        // Chunks are padded to an even length.
        offset += 8 + size + size % 2;
    }
    Err(WavError::NotAWav)
}

#[derive(Clone, Copy, Debug)]
struct Format {
    channels: usize,
    rate: f32,
    bits: u16,
    float: bool,
}

const PCM: u16 = 1;
const FLOAT: u16 = 3;
const EXTENSIBLE: u16 = 0xFFFE;

fn read_format(body: &[u8]) -> Result<Format, WavError> {
    if body.len() < 16 {
        return Err(WavError::NotAWav);
    }
    let word = |at: usize| u16::from_le_bytes(body[at..at + 2].try_into().unwrap());
    let long = |at: usize| u32::from_le_bytes(body[at..at + 4].try_into().unwrap());
    let mut tag = word(0);
    // WAVE_FORMAT_EXTENSIBLE keeps the real format in its extension.
    if tag == EXTENSIBLE {
        tag = if body.len() >= 26 { word(24) } else { PCM };
    }
    let channels = word(2) as usize;
    let rate = long(4) as f32;
    let bits = word(14);
    if channels == 0 || rate <= 0.0 {
        return Err(WavError::NotAWav);
    }
    let float = match tag {
        PCM => false,
        FLOAT => true,
        _ => return Err(WavError::Unsupported),
    };
    if !matches!((bits, float), (8 | 16 | 24 | 32, false) | (32, true)) {
        return Err(WavError::Unsupported);
    }
    Ok(Format {
        channels,
        rate,
        bits,
        float,
    })
}

fn read_data(body: &[u8], format: Format) -> Result<Sample, WavError> {
    let width = format.bits as usize / 8;
    let channels = format.channels.min(2);
    let data: Vec<f32> = body
        .chunks_exact(width * format.channels)
        .flat_map(|frame| {
            frame
                .chunks_exact(width)
                .take(channels)
                .map(move |sample| read_sample(sample, format))
        })
        .collect();
    if data.is_empty() {
        return Err(WavError::Empty);
    }
    Ok(Sample::new(data, channels, format.rate))
}

fn read_sample(bytes: &[u8], format: Format) -> f32 {
    match (format.bits, format.float) {
        // 8-bit WAV is unsigned, with 128 as silence.
        (8, _) => (f32::from(bytes[0]) - 128.0) / 128.0,
        (16, _) => f32::from(i16::from_le_bytes([bytes[0], bytes[1]])) / 32_768.0,
        (24, _) => {
            // Sign-extended into the top three bytes of an i32.
            let value = i32::from_le_bytes([0, bytes[0], bytes[1], bytes[2]]);
            value as f32 / 2_147_483_648.0
        }
        (32, false) => i32::from_le_bytes(bytes.try_into().unwrap()) as f32 / 2_147_483_648.0,
        _ => f32::from_le_bytes(bytes.try_into().unwrap()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A WAV of `frames` frames, as `bits`-bit samples of the given tag.
    fn wav(tag: u16, bits: u16, channels: u16, rate: u32, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend(b"RIFF");
        out.extend((36 + data.len() as u32).to_le_bytes());
        out.extend(b"WAVEfmt ");
        out.extend(16u32.to_le_bytes());
        out.extend(tag.to_le_bytes());
        out.extend(channels.to_le_bytes());
        out.extend(rate.to_le_bytes());
        out.extend((rate * u32::from(channels) * u32::from(bits) / 8).to_le_bytes());
        out.extend((channels * bits / 8).to_le_bytes());
        out.extend(bits.to_le_bytes());
        out.extend(b"data");
        out.extend((data.len() as u32).to_le_bytes());
        out.extend(data);
        out
    }

    fn sixteen_bit(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn reads_a_16_bit_mono_file() {
        let bytes = wav(PCM, 16, 1, 44_100, &sixteen_bit(&[0, 16_384, -16_384]));
        let sample = decode(&bytes).unwrap();
        assert_eq!(sample.frames(), 3);
        assert_eq!(sample.rate(), 44_100.0);
        assert_eq!(sample.at(1, 0), 0.5);
        assert_eq!(sample.at(1, 1), 0.5, "mono plays on both sides");
        assert_eq!(sample.at(2, 0), -0.5);
        assert_eq!(sample.at(99, 0), 0.0, "silence past the end");
    }

    #[test]
    fn reads_a_stereo_file_and_keeps_the_sides_apart() {
        let bytes = wav(PCM, 16, 2, 48_000, &sixteen_bit(&[16_384, -16_384, 0, 0]));
        let sample = decode(&bytes).unwrap();
        assert_eq!(sample.frames(), 2);
        assert_eq!(sample.at(0, 0), 0.5);
        assert_eq!(sample.at(0, 1), -0.5);
    }

    #[test]
    fn reads_every_width_the_sampler_supports() {
        let half = |sample: &Sample| sample.at(1, 0);
        let eight = wav(PCM, 8, 1, 48_000, &[128, 192]);
        assert_eq!(half(&decode(&eight).unwrap()), 0.5);

        let twenty_four = wav(PCM, 24, 1, 48_000, &[0, 0, 0, 0, 0, 0x40]);
        assert!((half(&decode(&twenty_four).unwrap()) - 0.5).abs() < 1e-6);

        let thirty_two = wav(PCM, 32, 1, 48_000, &[0, 0, 0, 0, 0, 0, 0, 0x40]);
        assert!((half(&decode(&thirty_two).unwrap()) - 0.5).abs() < 1e-6);

        let mut floats = Vec::new();
        floats.extend(0.0f32.to_le_bytes());
        floats.extend(0.5f32.to_le_bytes());
        assert_eq!(
            half(&decode(&wav(FLOAT, 32, 1, 48_000, &floats)).unwrap()),
            0.5
        );
    }

    #[test]
    fn reads_between_frames_so_a_sample_can_change_speed() {
        let bytes = wav(PCM, 16, 1, 48_000, &sixteen_bit(&[0, 16_384]));
        let sample = decode(&bytes).unwrap();
        assert_eq!(sample.between(0.5, 0), 0.25);
        assert_eq!(sample.between(0.0, 0), 0.0);
    }

    #[test]
    fn skips_chunks_it_doesnt_know_and_finds_the_audio() {
        let mut bytes = wav(PCM, 16, 1, 48_000, &sixteen_bit(&[16_384]));
        let mut extra = Vec::new();
        extra.extend(b"LIST");
        extra.extend(5u32.to_le_bytes());
        extra.extend(b"hello\0"); // odd size, padded
        bytes.splice(12..12, extra);
        assert_eq!(decode(&bytes).unwrap().at(0, 0), 0.5);
    }

    #[test]
    fn says_what_is_wrong_with_a_file_it_cant_read() {
        assert_eq!(decode(b"nonsense at all"), Err(WavError::NotAWav));
        assert_eq!(decode(&[]), Err(WavError::NotAWav));
        // MP3 inside a RIFF container: a real format, not one we read.
        assert_eq!(
            decode(&wav(0x0055, 16, 1, 48_000, &sixteen_bit(&[0]))),
            Err(WavError::Unsupported)
        );
        assert_eq!(decode(&wav(PCM, 16, 1, 48_000, &[])), Err(WavError::Empty));
    }
}

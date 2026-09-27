//! Writing the mix as an MP3 file's bytes, for export.
//!
//! Like the WAV writer, this never opens a file (ADR 0001): a host renders
//! the mix, has it encoded here and writes the bytes where the musician
//! chose. Stereo, constant bitrate, by `rusty_mp3`, which is pure Rust and so
//! builds for the browser's WASM as it does for the desktop.

use rusty_mp3::{Mp3Encoder, Mp3EncoderConfig};
use wasm_bindgen::prelude::*;

/// The bitrates a mix exports at, in kbps.
pub const MP3_BITRATES: [u32; 4] = [128, 192, 256, 320];

/// A stereo MP3 file of `interleaved` samples at `sample_rate`, at `kbps`.
/// Throws what is wrong for a bitrate that isn't offered.
#[wasm_bindgen]
pub fn encode_mp3(interleaved: &[f32], sample_rate: u32, kbps: u32) -> Result<Vec<u8>, String> {
    mp3_bytes(interleaved, sample_rate, kbps)
}

/// `encode_mp3` for native callers.
pub fn mp3_bytes(interleaved: &[f32], sample_rate: u32, kbps: u32) -> Result<Vec<u8>, String> {
    if !MP3_BITRATES.contains(&kbps) {
        return Err(format!("{kbps} kbps MP3 isn't offered"));
    }
    let mut encoder = Mp3Encoder::new(Mp3EncoderConfig {
        bitrate_kbps: kbps,
        vbr_quality: None,
    });
    let frames = interleaved.len() / 2;
    encoder
        .push_pcm_f32(&interleaved[..frames * 2], 2, sample_rate)
        .map_err(|error| format!("Couldn't encode the MP3: {error:?}"))?;
    encoder.finish();
    let mut out = Vec::new();
    while let Ok(packet) = encoder.next_packet() {
        out.extend(packet);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_file::decode;

    const RATE: u32 = 48_000;

    /// A second of a 440 Hz tone on the left, silence on the right.
    fn tone_on_the_left() -> Vec<f32> {
        (0..RATE as usize)
            .flat_map(|i| {
                let phase = std::f32::consts::TAU * 440.0 * i as f32 / RATE as f32;
                [0.5 * phase.sin(), 0.0]
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn every_offered_bitrate_decodes_back_to_the_mix() {
        let mix = tone_on_the_left();
        for kbps in MP3_BITRATES {
            let file = encode_mp3(&mix, RATE, kbps).unwrap();
            let read = decode(&file).unwrap();
            assert_eq!(read.rate, f64::from(RATE), "{kbps} kbps");
            // The encoder pads to whole frames and adds its own delay, no more
            // than a few frames of 1,152 samples.
            let extra = read.frames() as i64 - i64::from(RATE);
            assert!(
                (0..=4 * 1_152).contains(&extra),
                "{kbps} kbps: {extra} frames over"
            );
            // Away from the ends, the tone is as loud and the right is still silent.
            let middle = 8_000..40_000;
            let left = rms(&read.left[middle.clone()]);
            assert!(
                (left - 0.5 / 2f32.sqrt()).abs() < 0.03,
                "{kbps} kbps: left {left}"
            );
            let right = rms(&read.right[middle]);
            assert!(right < 0.01, "{kbps} kbps: right {right}");
        }
    }

    #[test]
    fn the_bitrate_sets_the_size() {
        let mix = tone_on_the_left();
        let small = encode_mp3(&mix, RATE, 128).unwrap().len();
        let large = encode_mp3(&mix, RATE, 320).unwrap().len();
        // A second at 128 kbps is 16 kB.
        assert!((14_000..20_000).contains(&small), "{small} bytes");
        assert!(large > 2 * small, "{large} bytes");
    }

    #[test]
    fn only_the_offered_bitrates_encode() {
        assert!(encode_mp3(&[0.0, 0.0], RATE, 96).is_err());
    }
}

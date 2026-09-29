//! Building blocks shared by Instruments and Effects.

mod biquad;
mod envelope;
mod four_band;
mod lfo;
mod oscillator;
mod resample;

pub use biquad::{Biquad, FilterKind};
pub use envelope::Envelope;
pub use four_band::FourBand;
pub use lfo::Lfo;
pub use oscillator::{Oscillator, Waveform};
pub use resample::{resample, resample_range};

/// Below this, filter and delay state is flushed to zero.
///
/// WASM has no flush-to-zero mode, and a decaying tail that reaches denormal
/// numbers is many times slower to process on x86.
const DENORMAL_FLOOR: f32 = 1e-15;

/// Flush a denormal-range value to zero.
pub fn flush_denormal(x: f32) -> f32 {
    if x.abs() < DENORMAL_FLOOR { 0.0 } else { x }
}

/// Convert decibels to a linear gain.
pub fn db_to_gain(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

/// Convert a linear gain to decibels.
pub fn gain_to_db(gain: f32) -> f32 {
    20.0 * gain.max(1e-9).log10()
}

/// The frequency of a MIDI note number, with A4 (69) at 440 Hz. Fractional
/// notes are allowed, so glide and an LFO can bend between them.
pub fn note_to_frequency(note: f32) -> f32 {
    440.0 * 2.0_f32.powf((note - 69.0) / 12.0)
}

/// Test helpers: measuring rendered buffers.
#[cfg(test)]
pub mod measure {
    use std::f32::consts::TAU;

    /// A sine wave of the given frequency and amplitude.
    pub fn sine(frequency: f32, amplitude: f32, sample_rate: f32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|n| amplitude * (TAU * frequency * n as f32 / sample_rate).sin())
            .collect()
    }

    /// The largest absolute sample.
    pub fn peak(buffer: &[f32]) -> f32 {
        buffer.iter().fold(0.0, |max, s| max.max(s.abs()))
    }

    /// Root-mean-square level.
    pub fn rms(buffer: &[f32]) -> f32 {
        (buffer.iter().map(|s| s * s).sum::<f32>() / buffer.len() as f32).sqrt()
    }

    /// The largest jump from one sample to the next: what a click sounds
    /// like, measured.
    pub fn max_jump(buffer: &[f32]) -> f32 {
        buffer
            .windows(2)
            .fold(0.0_f32, |max, pair| max.max((pair[1] - pair[0]).abs()))
    }

    /// How many times the signal crosses zero going upwards.
    pub fn rising_zero_crossings(buffer: &[f32]) -> usize {
        buffer
            .windows(2)
            .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a4_is_440_hz_and_octaves_double() {
        assert!((note_to_frequency(69.0) - 440.0).abs() < 1e-3);
        assert!((note_to_frequency(81.0) - 880.0).abs() < 1e-2);
        assert!((note_to_frequency(57.0) - 220.0).abs() < 1e-3);
        assert!(
            (note_to_frequency(69.5) - 452.89).abs() < 1e-2,
            "half a semitone up"
        );
    }

    #[test]
    fn decibels_round_trip() {
        assert!((db_to_gain(-6.0) - 0.501).abs() < 1e-3);
        assert!((gain_to_db(db_to_gain(-12.5)) + 12.5).abs() < 1e-4);
    }

    #[test]
    fn denormals_flush_to_zero_and_normal_values_pass() {
        assert_eq!(flush_denormal(1e-30), 0.0);
        assert_eq!(flush_denormal(0.25), 0.25);
    }
}

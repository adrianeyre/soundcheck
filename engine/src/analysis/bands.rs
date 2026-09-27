//! Energy per frequency band: how much of the sound is sub, bass, mids and
//! highs.
//!
//! Each band's level is the mean square of the signal's content in it, in dB,
//! so a full-scale sine reads -3 dB in its band and the bands' powers add up
//! to the whole signal's.

use super::fft::Spectrogram;

/// A named frequency range, `low` inclusive and `high` exclusive, in hertz.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Band {
    pub name: &'static str,
    pub low: f64,
    pub high: f64,
}

pub const BANDS: [Band; 6] = [
    Band {
        name: "sub",
        low: 0.0,
        high: 60.0,
    },
    Band {
        name: "bass",
        low: 60.0,
        high: 250.0,
    },
    Band {
        name: "low_mid",
        low: 250.0,
        high: 500.0,
    },
    Band {
        name: "mid",
        low: 500.0,
        high: 2_000.0,
    },
    Band {
        name: "high_mid",
        low: 2_000.0,
        high: 6_000.0,
    },
    Band {
        name: "high",
        low: 6_000.0,
        high: f64::INFINITY,
    },
];

/// The level of each of `BANDS`, in order, in dB. An empty band reads `-inf`.
pub fn measure(spectrogram: &Spectrogram) -> [f32; BANDS.len()] {
    let spectrum = spectrogram.mean_square_spectrum();
    let mut power = [0.0_f64; BANDS.len()];
    // Skip DC: it is offset, not sound.
    for (k, p) in spectrum.iter().enumerate().skip(1) {
        let frequency = spectrogram.frequency(k);
        if let Some(band) = BANDS
            .iter()
            .position(|b| frequency >= b.low && frequency < b.high)
        {
            power[band] += p;
        }
    }
    power.map(|p| (10.0 * p.log10()) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::sine;
    use crate::effect::{Eq, EqSettings};

    const RATE: f32 = 48_000.0;

    fn bands_of(signal: &[f32]) -> [f32; BANDS.len()] {
        measure(&Spectrogram::new(signal, RATE, 8_192, 4_096))
    }

    fn index(name: &str) -> usize {
        BANDS.iter().position(|b| b.name == name).unwrap()
    }

    /// White-ish noise from a fixed seed, so every run is the same.
    fn noise(frames: usize) -> Vec<f32> {
        let mut state = 0x1234_5678_u32;
        (0..frames)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as f32 / u32::MAX as f32 - 0.5
            })
            .collect()
    }

    #[test]
    fn a_sine_puts_its_energy_in_its_own_band() {
        let bands = bands_of(&sine(1_000.0, 1.0, RATE, 96_000));
        assert!((bands[index("mid")] + 3.01).abs() < 0.1, "{bands:?}");
        for (i, level) in bands.iter().enumerate() {
            if i != index("mid") {
                assert!(*level < -60.0, "{}: {level}", BANDS[i].name);
            }
        }
    }

    #[test]
    fn a_low_shelf_boost_raises_the_low_bands_and_leaves_the_highs() {
        let dry = noise(96_000);
        let mut boosted = dry.clone();
        let settings = EqSettings {
            low_shelf_frequency: 150.0,
            low_shelf_gain_db: 9.0,
            ..EqSettings::default()
        };
        let mut other = boosted.clone();
        Eq::new(RATE, settings).process_stereo(&mut boosted, &mut other);

        let before = bands_of(&dry);
        let after = bands_of(&boosted);
        let change = |name| after[index(name)] - before[index(name)];
        assert!(change("sub") > 8.0, "sub {}", change("sub"));
        assert!(change("bass") > 4.0, "bass {}", change("bass"));
        assert!(change("low_mid") < change("bass"));
        assert!(
            change("high_mid").abs() < 0.3,
            "high_mid {}",
            change("high_mid")
        );
        assert!(change("high").abs() < 0.3, "high {}", change("high"));
    }

    #[test]
    fn silence_has_no_energy_anywhere() {
        let bands = bands_of(&vec![0.0; 16_384]);
        assert!(bands.iter().all(|&b| b == f32::NEG_INFINITY));
    }
}

//! The De-esser Effect: takes the hiss out of "s" and "t" sounds.
//!
//! A band around Frequency is split off, where a voice's sibilance sits. When
//! that band's level goes over Threshold, only the band is turned down, to
//! bring it back to the threshold but by no more than Range, so the rest of
//! the voice keeps its level and its tone. It turns down fast, so the start
//! of each "s" is caught, and lets go more slowly, so it doesn't flutter.
//! Listen plays only the band it hears, to find the Frequency where the
//! sibilance is. A moved Frequency glides there rather than jumps.

use super::params::{Param, Settings, number, switch, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::{Biquad, db_to_gain, flush_denormal, gain_to_db};

/// How wide the band is: about an octave and a half.
const BAND_Q: f32 = 1.0;
/// How fast the band is turned down when it goes over the threshold.
const ATTACK_MS: f32 = 1.0;
/// How fast it is let back up.
const RELEASE_MS: f32 = 60.0;
/// How long switching Listen takes, so it doesn't click.
const SMOOTHING_MS: f32 = 10.0;
/// How long a moved Frequency takes to glide to where it was set: a filter
/// that jumps rings.
const GLIDE_MS: f32 = 30.0;
/// How many samples apart the gliding band is redesigned.
const GLIDE_STEP: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DeEsserSettings {
    /// The centre of the band that is listened to and turned down.
    pub frequency_hz: f32,
    pub threshold_db: f32,
    /// The most the band is turned down, in dB (0 or more).
    pub range_db: f32,
    /// 1 plays only the band it hears.
    pub listen: f32,
}

impl Default for DeEsserSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the De-esser, in the order a host sends them.
#[rustfmt::skip]
pub const DE_ESSER_PARAMS: &[Param<DeEsserSettings>] = &[
    number("frequencyHz", "Frequency", "Hz", (2_000.0, 12_000.0, 6_000.0),
        |s| s.frequency_hz, |s, v| s.frequency_hz = v),
    number("thresholdDb", "Threshold", "dB", (-60.0, 0.0, -24.0),
        |s| s.threshold_db, |s, v| s.threshold_db = v),
    number("rangeDb", "Range", "dB", (0.0, 24.0, 12.0),
        |s| s.range_db, |s, v| s.range_db = v),
    switch("listen", "Listen", false,
        |s| s.listen, |s, v| s.listen = v),
];

impl Settings for DeEsserSettings {
    const PARAMS: &'static [Param<Self>] = DE_ESSER_PARAMS;

    fn zeroed() -> Self {
        Self {
            frequency_hz: 0.0,
            threshold_db: 0.0,
            range_db: 0.0,
            listen: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct DeEsser {
    sample_rate: f32,
    settings: DeEsserSettings,
    /// Each side's band.
    bands: [Biquad; 2],
    /// Where the band is now, gliding towards its setting.
    frequency_hz: f32,
    glide: f32,
    /// How many samples until the gliding band is next redesigned.
    until_glide: usize,
    attack: f32,
    release: f32,
    smoothing: f32,
    /// How far the band is turned down now, in dB (0 or more).
    reduction_db: f32,
    /// How far Listen is switched in, easing between 0 and 1.
    listening: f32,
}

impl DeEsser {
    pub fn new(sample_rate: f32, settings: DeEsserSettings) -> Self {
        Self {
            sample_rate,
            settings,
            bands: [Biquad::band_pass(sample_rate, settings.frequency_hz, BAND_Q); 2],
            frequency_hz: settings.frequency_hz,
            glide: time_coefficient(GLIDE_MS, sample_rate / GLIDE_STEP as f32),
            until_glide: 0,
            attack: time_coefficient(ATTACK_MS, sample_rate),
            release: time_coefficient(RELEASE_MS, sample_rate),
            smoothing: time_coefficient(SMOOTHING_MS, sample_rate),
            reduction_db: 0.0,
            listening: settings.listen,
        }
    }

    /// Move the band a step closer to its Frequency, every `GLIDE_STEP`
    /// samples, whatever size the blocks are.
    fn glide_frequency(&mut self) {
        if self.until_glide > 0 {
            self.until_glide -= 1;
            return;
        }
        self.until_glide = GLIDE_STEP - 1;
        let target = self.settings.frequency_hz;
        if self.frequency_hz == target {
            return;
        }
        // In octaves, so it glides as evenly down as up.
        let glided = target * (self.glide * (self.frequency_hz / target).log2()).exp2();
        self.frequency_hz = if (glided / target - 1.0).abs() < 1e-3 {
            target
        } else {
            glided
        };
        for band in &mut self.bands {
            let old = *band;
            *band = Biquad::band_pass(self.sample_rate, self.frequency_hz, BAND_Q);
            band.restore_state(&old);
        }
    }
}

impl StereoEffect for DeEsser {
    type Settings = DeEsserSettings;

    fn settings(&self) -> DeEsserSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: DeEsserSettings) {
        self.settings = settings;
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let DeEsserSettings {
            threshold_db,
            range_db,
            listen,
            ..
        } = self.settings;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            self.listening = listen + self.smoothing * (self.listening - listen);
            self.glide_frequency();
            let band = [self.bands[0].process(*l), self.bands[1].process(*r)];
            let level = band[0].abs().max(band[1].abs());
            let target = (gain_to_db(level) - threshold_db).clamp(0.0, range_db);
            let coefficient = if target > self.reduction_db {
                self.attack
            } else {
                self.release
            };
            self.reduction_db = flush_denormal(target + coefficient * (self.reduction_db - target));
            let cut = 1.0 - db_to_gain(-self.reduction_db);
            for (sample, band) in [&mut *l, &mut *r].into_iter().zip(band) {
                let de_essed = *sample - band * cut;
                *sample = de_essed * (1.0 - self.listening) + band * self.listening;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, rms, sine};

    const RATE: f32 = 48_000.0;

    fn run(settings: DeEsserSettings, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut de_esser = DeEsser::new(RATE, settings);
        let mut left = input.to_vec();
        let mut right = input.to_vec();
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            de_esser.process_stereo(l, r);
        }
        left
    }

    /// How much quieter the settled output is than the input, in dB.
    fn cut_db(input: &[f32], output: &[f32]) -> f32 {
        gain_to_db(rms(&input[24_000..]) / rms(&output[24_000..]))
    }

    #[test]
    fn a_loud_sibilant_band_is_turned_down_by_no_more_than_the_range() {
        let hiss = sine(6_000.0, 0.5, RATE, 48_000);
        let output = run(DeEsserSettings::default(), &hiss, 64);
        let cut = cut_db(&hiss, &output);
        assert!((cut - 12.0).abs() < 1.0, "cut by {cut} dB");

        // Just over the threshold, it is brought back down to it.
        let settings = DeEsserSettings {
            threshold_db: -9.0,
            ..DeEsserSettings::default()
        };
        let cut = cut_db(&hiss, &run(settings, &hiss, 64));
        assert!((cut - 3.0).abs() < 1.0, "cut by {cut} dB");
    }

    #[test]
    fn what_is_below_the_band_passes_untouched() {
        let voice = sine(200.0, 0.5, RATE, 48_000);
        assert_eq!(run(DeEsserSettings::default(), &voice, 64), voice);
        // A quiet hiss, under the threshold, passes too.
        let quiet = sine(6_000.0, 0.02, RATE, 48_000);
        assert_eq!(run(DeEsserSettings::default(), &quiet, 64), quiet);
    }

    #[test]
    fn listen_plays_only_the_band() {
        let listen = DeEsserSettings {
            listen: 1.0,
            ..DeEsserSettings::default()
        };
        let voice = sine(200.0, 0.5, RATE, 48_000);
        assert!(cut_db(&voice, &run(listen, &voice, 64)) > 20.0);
        let hiss = sine(6_000.0, 0.5, RATE, 48_000);
        assert!(cut_db(&hiss, &run(listen, &hiss, 64)).abs() < 0.5);
    }

    #[test]
    fn a_moved_frequency_glides_there_without_a_spike() {
        let input = sine(3_000.0, 0.5, RATE, 9_600);
        let listen = DeEsserSettings {
            frequency_hz: 3_000.0,
            listen: 1.0,
            ..DeEsserSettings::default()
        };
        let mut de_esser = DeEsser::new(RATE, listen);
        let (mut left, mut right) = (input.clone(), input.clone());
        de_esser.process_stereo(&mut left[..4_800], &mut right[..4_800]);
        de_esser.set_settings(DeEsserSettings {
            frequency_hz: 12_000.0,
            ..listen
        });
        for (l, r) in left[4_800..]
            .chunks_mut(5)
            .zip(right[4_800..].chunks_mut(5))
        {
            de_esser.process_stereo(l, r);
        }
        assert!(peak(&left[4_800..]) < 0.52, "{}", peak(&left[4_800..]));
        // By the end, the band is well away from the tone.
        assert!(peak(&left[8_400..]) < 0.25, "{}", peak(&left[8_400..]));
    }

    #[test]
    fn it_is_finite_at_the_extremes_and_the_same_in_any_size_of_block() {
        let mut input = sine(9_000.0, 1.0, RATE, 4_800);
        input[100] = 1.0e6;
        let extreme = DeEsserSettings {
            frequency_hz: 12_000.0,
            threshold_db: -60.0,
            range_db: 24.0,
            listen: 0.0,
        };
        let whole = run(extreme, &input, input.len());
        assert!(whole.iter().all(|s| s.is_finite()));
        assert_eq!(run(extreme, &input, 1), whole);
        assert_eq!(run(extreme, &input, 31), whole);
    }
}

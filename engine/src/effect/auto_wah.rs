//! The Auto Wah Effect: a resonant filter that opens as the part gets louder,
//! so each note says "wow": the funk guitar and squelchy bass sound.
//!
//! An envelope follower listens to both sides together, rising at Attack and
//! falling at Release, and Sensitivity sets how loud the part must be to
//! sweep the filter all the way: a level of 0 dBFS, turned up by Sensitivity,
//! reaches the top. The filter, a band-pass for the classic vocal wah or a
//! low-pass for a fuller, synth-like one, moves between Low and High (on a
//! musical, octave scale) with Resonance as its Q. The filter is redesigned
//! every few dozen samples, carrying its memory over so the sweep never
//! clicks. Mix blends it with the dry signal.

use super::params::{Param, Settings, choice, number, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::{Biquad, db_to_gain, flush_denormal};

/// The filter's modes, in the order its `mode` setting picks them.
pub const AUTO_WAH_MODES: &[&str] = &["band-pass", "low-pass"];
/// The filter moves this often, in samples.
const CONTROL_FRAMES: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutoWahSettings {
    /// An index into `AUTO_WAH_MODES`.
    pub mode: usize,
    /// Where the filter sits when the part is silent.
    pub low_hz: f32,
    /// Where it reaches when the part is loud enough.
    pub high_hz: f32,
    /// How much the follower's level is turned up, in decibels.
    pub sensitivity_db: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    /// The filter's Q.
    pub resonance: f32,
    pub mix: f32,
}

impl Default for AutoWahSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Auto Wah, in the order a host sends them.
#[rustfmt::skip]
pub const AUTO_WAH_PARAMS: &[Param<AutoWahSettings>] = &[
    choice("mode", "Mode", AUTO_WAH_MODES, 0,
        |s| s.mode as f32, |s, v| s.mode = v as usize),
    number("lowHz", "Low", "Hz", (50.0, 2_000.0, 300.0),
        |s| s.low_hz, |s, v| s.low_hz = v),
    number("highHz", "High", "Hz", (200.0, 10_000.0, 2_500.0),
        |s| s.high_hz, |s, v| s.high_hz = v),
    number("sensitivityDb", "Sensitivity", "dB", (0.0, 36.0, 12.0),
        |s| s.sensitivity_db, |s, v| s.sensitivity_db = v),
    number("attackMs", "Attack", "ms", (0.1, 100.0, 5.0),
        |s| s.attack_ms, |s, v| s.attack_ms = v),
    number("releaseMs", "Release", "ms", (5.0, 1_000.0, 150.0),
        |s| s.release_ms, |s, v| s.release_ms = v),
    number("resonance", "Resonance", "Q", (0.5, 18.0, 4.0),
        |s| s.resonance, |s, v| s.resonance = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for AutoWahSettings {
    const PARAMS: &'static [Param<Self>] = AUTO_WAH_PARAMS;

    fn zeroed() -> Self {
        Self {
            mode: 0,
            low_hz: 0.0,
            high_hz: 0.0,
            sensitivity_db: 0.0,
            attack_ms: 0.0,
            release_ms: 0.0,
            resonance: 0.0,
            mix: 0.0,
        }
    }
}

/// The filter `mode` names, at `hz`.
fn design(mode: usize, sample_rate: f32, hz: f32, q: f32) -> Biquad {
    if mode == 1 {
        Biquad::low_pass(sample_rate, hz, q)
    } else {
        Biquad::band_pass(sample_rate, hz, q)
    }
}

#[derive(Clone, Debug)]
pub struct AutoWah {
    sample_rate: f32,
    settings: AutoWahSettings,
    filters: [Biquad; 2],
    /// The follower's level, 0 and up.
    envelope: f32,
    /// Samples until the filter is next redesigned.
    countdown: usize,
}

impl AutoWah {
    pub fn new(sample_rate: f32, settings: AutoWahSettings) -> Self {
        let filter = design(
            settings.mode,
            sample_rate,
            settings.low_hz,
            settings.resonance,
        );
        Self {
            sample_rate,
            settings,
            filters: [filter; 2],
            envelope: 0.0,
            countdown: 0,
        }
    }

    /// Where the filter sits for the follower's level now.
    fn frequency(&self) -> f32 {
        let AutoWahSettings {
            low_hz,
            high_hz,
            sensitivity_db,
            ..
        } = self.settings;
        let position = (self.envelope * db_to_gain(sensitivity_db)).clamp(0.0, 1.0);
        low_hz * (high_hz / low_hz).powf(position)
    }
}

impl StereoEffect for AutoWah {
    type Settings = AutoWahSettings;

    fn settings(&self) -> AutoWahSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: AutoWahSettings) {
        self.settings = settings;
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let AutoWahSettings {
            mode,
            attack_ms,
            release_ms,
            resonance,
            mix,
            ..
        } = self.settings;
        let attack = time_coefficient(attack_ms, self.sample_rate);
        let release = time_coefficient(release_ms, self.sample_rate);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let level = 0.5 * (l.abs() + r.abs());
            let coefficient = if level > self.envelope {
                attack
            } else {
                release
            };
            self.envelope = flush_denormal(level + (self.envelope - level) * coefficient);

            if self.countdown == 0 {
                let hz = self.frequency();
                for filter in &mut self.filters {
                    let mut next = design(mode, self.sample_rate, hz, resonance);
                    next.restore_state(filter);
                    *filter = next;
                }
                self.countdown = CONTROL_FRAMES;
            }
            self.countdown -= 1;

            for (sample, filter) in [l, r].into_iter().zip(self.filters.iter_mut()) {
                let wet = filter.process(*sample);
                *sample = *sample * (1.0 - mix) + wet * mix;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rms, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> AutoWahSettings {
        let mut settings = AutoWahSettings::default();
        for (name, value) in changes {
            let param = AUTO_WAH_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(wah: &mut AutoWah, input: &[f32], chunk: usize) -> Vec<f32> {
        let (mut left, mut right) = (input.to_vec(), input.to_vec());
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            wah.process_stereo(l, r);
        }
        assert_eq!(left, right);
        left
    }

    #[test]
    fn a_loud_part_opens_the_filter_and_a_quiet_one_leaves_it_low() {
        let mut quiet = AutoWah::new(RATE, AutoWahSettings::default());
        run(&mut quiet, &sine(2_500.0, 0.001, RATE, 4_800), 128);
        assert!(
            (quiet.frequency() - 300.0).abs() < 5.0,
            "{}",
            quiet.frequency()
        );

        let mut loud = AutoWah::new(RATE, AutoWahSettings::default());
        run(&mut loud, &sine(2_500.0, 0.5, RATE, 4_800), 128);
        assert!(
            (loud.frequency() - 2_500.0).abs() < 1.0,
            "{}",
            loud.frequency()
        );

        // So a loud tone at the top passes the band-pass, and a quiet one at
        // the same pitch, which leaves it low, is mostly filtered away.
        let input = sine(2_500.0, 0.5, RATE, 24_000);
        let loud_out = run(
            &mut AutoWah::new(RATE, AutoWahSettings::default()),
            &input,
            128,
        );
        assert!(rms(&loud_out[12_000..]) > 0.8 * rms(&input[12_000..]));
        let quiet_input: Vec<f32> = input.iter().map(|s| s * 0.002).collect();
        let quiet_out = run(
            &mut AutoWah::new(RATE, AutoWahSettings::default()),
            &quiet_input,
            128,
        );
        assert!(rms(&quiet_out[12_000..]) < 0.2 * rms(&quiet_input[12_000..]));
    }

    #[test]
    fn no_mix_is_dry() {
        let input = sine(300.0, 0.5, RATE, 4_800);
        let out = run(
            &mut AutoWah::new(RATE, settings(&[("mix", 0.0), ("resonance", 18.0)])),
            &input,
            64,
        );
        assert_eq!(out, input);
    }

    #[test]
    fn extreme_settings_stay_finite() {
        let input: Vec<f32> = (0..48_000)
            .map(|n| if n % 4_800 < 2_400 { 1.0 } else { 0.0 })
            .collect();
        for mode in [0.0, 1.0] {
            let wah = &mut AutoWah::new(
                RATE,
                settings(&[
                    ("mode", mode),
                    ("lowHz", 50.0),
                    ("highHz", 10_000.0),
                    ("sensitivityDb", 36.0),
                    ("attackMs", 0.1),
                    ("releaseMs", 5.0),
                    ("resonance", 18.0),
                ]),
            );
            let out = run(wah, &input, 256);
            assert!(out.iter().all(|s| s.is_finite() && s.abs() < 50.0));
        }
    }

    #[test]
    fn odd_chunks_render_the_same_as_one_block() {
        let input: Vec<f32> = sine(220.0, 0.6, RATE, 9_000)
            .iter()
            .enumerate()
            .map(|(n, s)| s * (n % 3_000) as f32 / 3_000.0)
            .collect();
        let render = |chunk| {
            run(
                &mut AutoWah::new(RATE, settings(&[("mode", 1.0), ("mix", 0.8)])),
                &input,
                chunk,
            )
        };
        let whole = render(input.len());
        assert_eq!(whole, render(1));
        assert_eq!(whole, render(37));
    }
}

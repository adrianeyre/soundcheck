//! The Auto Filter Effect: a resonant filter whose cutoff an LFO can sweep.
//!
//! One biquad per side, low-pass, high-pass, band-pass or notch, at Cutoff
//! with Resonance as its Q. The LFO moves the cutoff up and down by up to
//! LFO depth octaves at LFO rate; the filter is redesigned every few dozen
//! samples, carrying its memory over so the sweep never clicks. Drive pushes
//! the signal into a soft clipper before the filter, for a grittier sound.

use std::f32::consts::TAU;

use super::params::{Param, Settings, choice, number};
use crate::dsp::{Biquad, db_to_gain};

/// The filter's modes, in the order its `mode` setting picks them.
pub const FILTER_MODES: &[&str] = &["low-pass", "high-pass", "band-pass", "notch"];
/// The cutoff moves this often, in samples.
const CONTROL_FRAMES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FilterSettings {
    /// An index into `FILTER_MODES`.
    pub mode: usize,
    pub cutoff_hz: f32,
    pub resonance: f32,
    pub lfo_rate_hz: f32,
    /// How far the LFO moves the cutoff either way, in octaves.
    pub lfo_depth: f32,
    pub drive_db: f32,
    pub mix: f32,
}

impl Default for FilterSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Auto Filter, in the order a host sends them.
#[rustfmt::skip]
pub const FILTER_PARAMS: &[Param<FilterSettings>] = &[
    choice("mode", "Mode", FILTER_MODES, 0,
        |s| s.mode as f32, |s, v| s.mode = v as usize),
    number("cutoffHz", "Cutoff", "Hz", (20.0, 20_000.0, 2_000.0),
        |s| s.cutoff_hz, |s, v| s.cutoff_hz = v),
    number("resonance", "Resonance", "Q", (0.5, 18.0, 0.7),
        |s| s.resonance, |s, v| s.resonance = v),
    number("lfoRateHz", "LFO rate", "Hz", (0.05, 20.0, 1.0),
        |s| s.lfo_rate_hz, |s, v| s.lfo_rate_hz = v),
    number("lfoDepth", "LFO depth", "oct", (0.0, 4.0, 0.0),
        |s| s.lfo_depth, |s, v| s.lfo_depth = v),
    number("driveDb", "Drive", "dB", (0.0, 24.0, 0.0),
        |s| s.drive_db, |s, v| s.drive_db = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for FilterSettings {
    const PARAMS: &'static [Param<Self>] = FILTER_PARAMS;

    fn zeroed() -> Self {
        Self {
            mode: 0,
            cutoff_hz: 0.0,
            resonance: 0.0,
            lfo_rate_hz: 0.0,
            lfo_depth: 0.0,
            drive_db: 0.0,
            mix: 0.0,
        }
    }
}

/// The filter `mode` names, at `hz`.
pub fn filter_design(mode: usize, sample_rate: f32, hz: f32, q: f32) -> Biquad {
    match mode {
        1 => Biquad::high_pass(sample_rate, hz, q),
        2 => Biquad::band_pass(sample_rate, hz, q),
        3 => Biquad::notch(sample_rate, hz, q),
        _ => Biquad::low_pass(sample_rate, hz, q),
    }
}

#[derive(Clone, Debug)]
pub struct Filter {
    sample_rate: f32,
    settings: FilterSettings,
    filters: [Biquad; 2],
    phase: f32,
}

impl Filter {
    pub fn new(sample_rate: f32, settings: FilterSettings) -> Self {
        let design = filter_design(
            settings.mode,
            sample_rate,
            settings.cutoff_hz,
            settings.resonance,
        );
        Self {
            sample_rate,
            settings,
            filters: [design; 2],
            phase: 0.0,
        }
    }

    pub fn settings(&self) -> FilterSettings {
        self.settings
    }

    pub fn set_settings(&mut self, settings: FilterSettings) {
        self.settings = settings;
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let FilterSettings {
            mode,
            cutoff_hz,
            resonance,
            lfo_rate_hz,
            lfo_depth,
            drive_db,
            mix,
        } = self.settings;
        let drive = (drive_db > 0.0).then(|| db_to_gain(drive_db));
        let increment = lfo_rate_hz / self.sample_rate;
        for (l, r) in left
            .chunks_mut(CONTROL_FRAMES)
            .zip(right.chunks_mut(CONTROL_FRAMES))
        {
            let octaves = lfo_depth * (TAU * self.phase).sin();
            let hz = (cutoff_hz * octaves.exp2()).clamp(20.0, 20_000.0);
            self.phase = (self.phase + increment * l.len() as f32).fract();
            for (buffer, filter) in [l, r].into_iter().zip(self.filters.iter_mut()) {
                let mut next = filter_design(mode, self.sample_rate, hz, resonance);
                next.restore_state(filter);
                *filter = next;
                for sample in buffer.iter_mut() {
                    // Driven, the clipper's output is brought back to about
                    // the level that went in.
                    let input = match drive {
                        Some(gain) => (*sample * gain).tanh() / gain.sqrt(),
                        None => *sample,
                    };
                    *sample = *sample * (1.0 - mix) + filter.process(input) * mix;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rms, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> FilterSettings {
        let mut settings = FilterSettings::default();
        for (name, value) in changes {
            let param = FILTER_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(settings: FilterSettings, frequency: f32) -> Vec<f32> {
        let mut filter = Filter::new(RATE, settings);
        let mut left = sine(frequency, 0.5, RATE, 48_000);
        let mut right = left.clone();
        filter.process_stereo(&mut left, &mut right);
        assert_eq!(left, right);
        left
    }

    fn gain(settings: FilterSettings, frequency: f32) -> f32 {
        rms(&run(settings, frequency)[24_000..]) / rms(&sine(frequency, 0.5, RATE, 24_000))
    }

    #[test]
    fn each_mode_keeps_its_own_part_of_the_spectrum() {
        let low = settings(&[("cutoffHz", 500.0)]);
        assert!(gain(low, 100.0) > 0.95 && gain(low, 8_000.0) < 0.02);
        let high = settings(&[("mode", 1.0), ("cutoffHz", 2_000.0)]);
        assert!(gain(high, 100.0) < 0.02 && gain(high, 10_000.0) > 0.95);
        let band = settings(&[("mode", 2.0), ("cutoffHz", 1_000.0), ("resonance", 4.0)]);
        assert!(gain(band, 1_000.0) > 0.95 && gain(band, 100.0) < 0.1);
        let notch = settings(&[("mode", 3.0), ("cutoffHz", 1_000.0), ("resonance", 2.0)]);
        assert!(gain(notch, 1_000.0) < 0.05 && gain(notch, 100.0) > 0.95);
    }

    #[test]
    fn the_lfo_sweeps_the_cutoff() {
        let swept = settings(&[("cutoffHz", 1_000.0), ("lfoDepth", 2.0), ("lfoRateHz", 2.0)]);
        let out = run(swept, 2_000.0);
        let windows: Vec<f32> = out.chunks(1_200).skip(2).map(rms).collect();
        let (low, high) = windows
            .iter()
            .fold((f32::MAX, 0.0_f32), |(lo, hi), &w| (lo.min(w), hi.max(w)));
        assert!(high > 3.0 * low, "{low} to {high}");
    }

    #[test]
    fn drive_stays_bounded_and_no_mix_is_dry() {
        let driven = run(
            settings(&[("driveDb", 24.0), ("cutoffHz", 20_000.0)]),
            200.0,
        );
        assert!(driven.iter().all(|s| s.abs() < 1.0));
        let dry = run(settings(&[("mix", 0.0), ("cutoffHz", 100.0)]), 3_000.0);
        assert_eq!(dry, sine(3_000.0, 0.5, RATE, 48_000));
    }
}

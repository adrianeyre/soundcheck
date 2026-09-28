//! The Gate Effect: silence between the notes.
//!
//! A detector follows the louder side's peaks. While it is above Threshold
//! the gate is open and the signal passes; once it falls below, the gate
//! stays open for Hold, then closes, turning the signal down by Range. The
//! gain opens with Attack and closes with Release, so it never clicks.

use super::params::{Param, Settings, number, time_coefficient};
use crate::dsp::{db_to_gain, flush_denormal, gain_to_db};

/// How fast the detector lets go of a peak: slow enough to ride over a low
/// note's zero crossings, fast enough to hear a note end.
const DETECTOR_RELEASE_MS: f32 = 5.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GateSettings {
    pub threshold_db: f32,
    /// How far a closed gate turns the signal down: -80 dB is silence.
    pub range_db: f32,
    pub attack: f32,
    pub hold: f32,
    pub release: f32,
}

impl Default for GateSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Gate, in the order a host sends them.
#[rustfmt::skip]
pub const GATE_PARAMS: &[Param<GateSettings>] = &[
    number("thresholdDb", "Threshold", "dB", (-80.0, 0.0, -40.0),
        |s| s.threshold_db, |s, v| s.threshold_db = v),
    number("rangeDb", "Range", "dB", (-80.0, 0.0, -80.0),
        |s| s.range_db, |s, v| s.range_db = v),
    number("attack", "Attack", "ms", (0.1, 50.0, 1.0),
        |s| s.attack, |s, v| s.attack = v),
    number("hold", "Hold", "ms", (0.0, 500.0, 20.0),
        |s| s.hold, |s, v| s.hold = v),
    number("release", "Release", "ms", (5.0, 2_000.0, 100.0),
        |s| s.release, |s, v| s.release = v),
];

impl Settings for GateSettings {
    const PARAMS: &'static [Param<Self>] = GATE_PARAMS;

    fn zeroed() -> Self {
        Self {
            threshold_db: 0.0,
            range_db: 0.0,
            attack: 0.0,
            hold: 0.0,
            release: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Gate {
    sample_rate: f32,
    settings: GateSettings,
    threshold: f32,
    closed_gain: f32,
    attack: f32,
    release: f32,
    detector_release: f32,
    hold_samples: usize,
    detector: f32,
    held: usize,
    gain: f32,
    meter_db: f32,
}

impl Gate {
    pub fn new(sample_rate: f32, settings: GateSettings) -> Self {
        let mut gate = Self {
            sample_rate,
            settings,
            threshold: 0.0,
            closed_gain: 0.0,
            attack: 0.0,
            release: 0.0,
            detector_release: time_coefficient(DETECTOR_RELEASE_MS, sample_rate),
            hold_samples: 0,
            detector: 0.0,
            held: 0,
            gain: 0.0,
            meter_db: 0.0,
        };
        gate.set_settings(settings);
        // It starts closed, so silence before the first note stays silent.
        gate.gain = gate.closed_gain;
        gate
    }

    pub fn settings(&self) -> GateSettings {
        self.settings
    }

    pub fn set_settings(&mut self, settings: GateSettings) {
        self.settings = settings;
        self.threshold = db_to_gain(settings.threshold_db);
        self.closed_gain = if settings.range_db <= -80.0 {
            0.0
        } else {
            db_to_gain(settings.range_db)
        };
        self.attack = time_coefficient(settings.attack, self.sample_rate);
        self.release = time_coefficient(settings.release, self.sample_rate);
        self.hold_samples = (settings.hold / 1_000.0 * self.sample_rate) as usize;
    }

    /// How far the gate turned the signal down in the latest block, in dB (0
    /// or more), capped at 80 for a gate closed to silence.
    pub fn meter_db(&self) -> f32 {
        self.meter_db
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let mut least: f32 = 1.0;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let level = l.abs().max(r.abs());
            self.detector = if level > self.detector {
                level
            } else {
                flush_denormal(self.detector_release * self.detector)
            };
            let open = if self.detector >= self.threshold {
                self.held = self.hold_samples;
                true
            } else if self.held > 0 {
                self.held -= 1;
                true
            } else {
                false
            };
            let (target, coefficient) = if open {
                (1.0, self.attack)
            } else {
                (self.closed_gain, self.release)
            };
            self.gain = flush_denormal(target + coefficient * (self.gain - target));
            least = least.min(self.gain);
            *l *= self.gain;
            *r *= self.gain;
        }
        self.meter_db = (-gain_to_db(least)).clamp(0.0, 80.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, rms, sine};

    const RATE: f32 = 48_000.0;

    fn run(gate: &mut Gate, input: &[f32]) -> Vec<f32> {
        let mut left = input.to_vec();
        let mut right = input.to_vec();
        gate.process_stereo(&mut left, &mut right);
        left
    }

    #[test]
    fn a_loud_signal_passes_and_a_quiet_one_is_shut_out() {
        let mut gate = Gate::new(RATE, GateSettings::default());
        let loud = run(&mut gate, &sine(200.0, 0.5, RATE, 24_000));
        assert!((rms(&loud[4_800..]) - rms(&sine(200.0, 0.5, RATE, 4_800))).abs() < 0.005);
        assert_eq!(gate.meter_db(), 80.0, "it opened from closed");

        let mut gate = Gate::new(RATE, GateSettings::default());
        // -52 dB, below the -40 dB threshold.
        let quiet = run(&mut gate, &sine(200.0, 0.0025, RATE, 24_000));
        assert!(peak(&quiet[..]) < 1e-5, "{}", peak(&quiet));
        assert_eq!(gate.meter_db(), 80.0);
    }

    #[test]
    fn it_holds_then_releases_after_the_signal_stops() {
        let settings = GateSettings {
            hold: 50.0,
            release: 10.0,
            ..GateSettings::default()
        };
        let mut gate = Gate::new(RATE, settings);
        run(&mut gate, &sine(200.0, 0.5, RATE, 9_600));
        // A quiet tail after the note: heard during the hold, gone after.
        let tail = run(&mut gate, &sine(200.0, 0.005, RATE, 9_600));
        assert!(peak(&tail[..1_200]) > 0.004, "held open");
        assert!(peak(&tail[6_000..]) < 1e-4, "then closed");
    }

    #[test]
    fn the_range_only_turns_it_down_so_far() {
        let settings = GateSettings {
            range_db: -12.0,
            ..GateSettings::default()
        };
        let mut gate = Gate::new(RATE, settings);
        let quiet = run(&mut gate, &sine(200.0, 0.0025, RATE, 48_000));
        let ratio = rms(&quiet[24_000..]) / rms(&sine(200.0, 0.0025, RATE, 24_000));
        assert!((ratio - db_to_gain(-12.0)).abs() < 0.01, "{ratio}");
        assert!((gate.meter_db() - 12.0).abs() < 0.1);
    }
}

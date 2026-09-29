//! The Pump Effect: the level ducks once every note value and swells back,
//! the breathing of a bass or pad sidechained to the kick.
//!
//! It follows the tempo but not the song's position, so its first dip falls
//! when it starts; Phase moves every dip later by a share of the note, to
//! line them up with the kick. At each dip the level falls by Depth in a few
//! milliseconds, then comes back over Release, a share of the note. Curve
//! shapes the way back: in the middle it rises evenly, towards 0 it stays
//! down and snaps back late, the hard pump of trance, and towards 1 it
//! springs back early, like a gentle compressor. Mix blends it with the dry
//! signal.

use super::delay::DEFAULT_TEMPO;
use super::params::{Param, Settings, choice, number, time_coefficient};
use super::stereo::StereoEffect;

/// The note values the level dips once in, shortest first.
pub const PUMP_NOTES: &[&str] = &["1/16", "1/8", "1/4", "1/2", "1/1"];
/// How many quarter notes each of `PUMP_NOTES` lasts.
const PUMP_QUARTERS: [f64; 5] = [0.25, 0.5, 1.0, 2.0, 4.0];
const QUARTER: usize = 2;

/// How long the level takes to fall at each dip.
const ATTACK_MS: f32 = 3.0;
/// How long the gain takes to follow a setting that jumps.
const SMOOTHING_MS: f32 = 1.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PumpSettings {
    /// An index into `PUMP_NOTES`.
    pub note: usize,
    /// 0..=1: how far the level falls at each dip; 1 is silence.
    pub depth: f32,
    /// How much of the note the level takes to come back.
    pub release: f32,
    /// 0..=1: the shape of the way back; 0.5 is even.
    pub curve: f32,
    /// 0..<1: how far into the note each dip falls.
    pub phase: f32,
    /// 0..=1: 0 is only the dry signal, 1 only the pumped one.
    pub mix: f32,
}

impl Default for PumpSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Pump, in the order a host sends them.
#[rustfmt::skip]
pub const PUMP_PARAMS: &[Param<PumpSettings>] = &[
    choice("note", "Note value", PUMP_NOTES, QUARTER,
        |s| s.note as f32, |s, v| s.note = v as usize),
    number("depth", "Depth", "", (0.0, 1.0, 0.7),
        |s| s.depth, |s, v| s.depth = v),
    number("release", "Release", "", (0.05, 1.0, 0.6),
        |s| s.release, |s, v| s.release = v),
    number("curve", "Curve", "", (0.0, 1.0, 0.4),
        |s| s.curve, |s, v| s.curve = v),
    number("phase", "Phase", "", (0.0, 1.0, 0.0),
        |s| s.phase, |s, v| s.phase = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for PumpSettings {
    const PARAMS: &'static [Param<Self>] = PUMP_PARAMS;

    fn zeroed() -> Self {
        Self {
            note: 0,
            depth: 0.0,
            release: 0.0,
            curve: 0.0,
            phase: 0.0,
            mix: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Pump {
    sample_rate: f32,
    settings: PumpSettings,
    tempo: f64,
    /// Where in the note the Pump is, 0..1, counted from when it started.
    position: f64,
    /// The gain last applied, which follows the shape through a smoother.
    gain: f32,
    smoothing: f32,
}

impl Pump {
    pub fn new(sample_rate: f32, settings: PumpSettings) -> Self {
        Self {
            sample_rate,
            settings,
            tempo: DEFAULT_TEMPO,
            position: 0.0,
            gain: 1.0,
            smoothing: time_coefficient(SMOOTHING_MS, sample_rate),
        }
    }

    /// How many samples one note value lasts at the tempo.
    fn note_samples(&self) -> f64 {
        let quarters = PUMP_QUARTERS[self.settings.note.min(PUMP_QUARTERS.len() - 1)];
        quarters * 60.0 / self.tempo * f64::from(self.sample_rate)
    }

    /// The gain `at` samples into the note, which lasts `length`.
    fn shape(&self, at: f32, length: f32) -> f32 {
        let PumpSettings {
            depth,
            release,
            curve,
            ..
        } = self.settings;
        let attack = (ATTACK_MS / 1_000.0 * self.sample_rate).min(0.25 * length);
        if at < attack {
            return 1.0 - depth * at / attack;
        }
        let back = ((at - attack) / (release * length).max(1.0)).min(1.0);
        // Below 1 the level stays down and snaps back late; above, it springs
        // back early.
        let power = 4.0_f32.powf(2.0 * curve - 1.0);
        1.0 - depth * (1.0 - back).powf(power)
    }
}

impl StereoEffect for Pump {
    type Settings = PumpSettings;

    fn settings(&self) -> PumpSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: PumpSettings) {
        self.settings = settings;
    }

    fn set_tempo(&mut self, tempo: f64) {
        if tempo.is_finite() && tempo > 0.0 {
            self.tempo = tempo;
        }
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let length = self.note_samples();
        let increment = 1.0 / length;
        let phase = f64::from(self.settings.phase);
        let mix = self.settings.mix;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let at = (self.position - phase).rem_euclid(1.0) * length;
            let target = self.shape(at as f32, length as f32);
            self.gain = target + self.smoothing * (self.gain - target);
            self.position = (self.position + increment).fract();

            let scale = 1.0 - mix * (1.0 - self.gain);
            *l *= scale;
            *r *= scale;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::rms;

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> PumpSettings {
        let mut settings = PumpSettings::default();
        for (name, value) in changes {
            let param = PUMP_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    /// The gain the Pump puts on a steady signal, frame by frame.
    fn gains(pump: &mut Pump, frames: usize, chunk: usize) -> Vec<f32> {
        let mut left = vec![1.0; frames];
        let mut right = vec![1.0; frames];
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            pump.process_stereo(l, r);
        }
        assert_eq!(left, right);
        left
    }

    fn quietest(gains: &[f32], from: usize, to: usize) -> usize {
        (from..to)
            .min_by(|&a, &b| gains[a].total_cmp(&gains[b]))
            .unwrap()
    }

    #[test]
    fn it_dips_once_every_quarter_note_and_comes_back() {
        let mut pump = Pump::new(RATE, settings(&[("depth", 1.0)]));
        // A quarter note at 120 is 24,000 frames.
        let gains = gains(&mut pump, 96_000, 512);
        for beat in 0..4 {
            let start = beat * 24_000;
            let dip = quietest(&gains, start, start + 24_000);
            // The bottom is just after the few milliseconds it takes to fall.
            assert!(dip - start < 400, "beat {beat} bottoms at {dip}");
            assert!(gains[dip] < 0.05, "{}", gains[dip]);
            // Back to full level before the next beat.
            assert!(gains[start + 23_000] > 0.99);
        }
    }

    #[test]
    fn the_tempo_and_the_note_value_set_how_often_it_dips() {
        let mut pump = Pump::new(RATE, settings(&[("depth", 1.0)]));
        pump.set_tempo(150.0);
        let dips = |gains: &[f32]| {
            gains
                .windows(2)
                .filter(|w| w[0] > 0.5 && w[1] <= 0.5)
                .count()
        };
        // Four quarter notes at 150 last 1.6 s.
        assert_eq!(dips(&gains(&mut pump, 76_800, 128)), 4);

        let eighth = PUMP_NOTES.iter().position(|&n| n == "1/8").unwrap();
        let mut pump = Pump::new(RATE, settings(&[("depth", 1.0), ("note", eighth as f32)]));
        pump.set_tempo(150.0);
        assert_eq!(dips(&gains(&mut pump, 76_800, 128)), 8);
    }

    #[test]
    fn the_phase_moves_the_dip_later() {
        let mut pump = Pump::new(RATE, settings(&[("depth", 1.0), ("phase", 0.5)]));
        let gains = gains(&mut pump, 24_000, 64);
        let dip = quietest(&gains, 0, 24_000);
        assert!((12_000..12_400).contains(&dip), "{dip}");
    }

    #[test]
    fn the_curve_decides_how_soon_it_comes_back() {
        let early = gains(
            &mut Pump::new(RATE, settings(&[("curve", 1.0)])),
            24_000,
            256,
        );
        let late = gains(
            &mut Pump::new(RATE, settings(&[("curve", 0.0)])),
            24_000,
            256,
        );
        assert!(rms(&early[..12_000]) > rms(&late[..12_000]) + 0.1);
    }

    #[test]
    fn no_mix_is_dry_and_any_chunking_is_the_same() {
        let dry = gains(&mut Pump::new(RATE, settings(&[("mix", 0.0)])), 30_000, 100);
        assert!(dry.iter().all(|&g| g == 1.0));

        let whole = gains(&mut Pump::new(RATE, settings(&[])), 30_000, 30_000);
        let single = gains(&mut Pump::new(RATE, settings(&[])), 30_000, 1);
        assert_eq!(whole, single);
    }

    #[test]
    fn extreme_settings_and_tempos_stay_finite() {
        let mut pump = Pump::new(
            RATE,
            settings(&[
                ("depth", 1.0),
                ("release", 0.05),
                ("curve", 0.0),
                ("note", 0.0),
            ]),
        );
        pump.set_tempo(999.0);
        assert!(
            gains(&mut pump, 10_000, 33)
                .iter()
                .all(|g| g.is_finite() && (0.0..=1.0).contains(g))
        );
        pump.set_tempo(0.0);
        pump.set_tempo(f64::NAN);
        pump.set_tempo(1.0);
        assert!(gains(&mut pump, 10_000, 33).iter().all(|g| g.is_finite()));
    }
}

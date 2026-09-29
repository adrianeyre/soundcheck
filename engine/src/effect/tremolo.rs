//! The Tremolo Effect: the level rising and falling in a steady pulse, as
//! from a vintage amp.
//!
//! An LFO turns the level down and back up again at Rate, or once per note
//! value when Sync is on, so the pulse follows the tempo. Shape picks how it
//! moves: a sine swells smoothly, a triangle leans in and out, a square
//! chops. Depth sets how far down the level goes, from nothing to silence.
//! Stereo phase runs the right side's pulse behind the left's, up to half a
//! cycle, so the sound throbs from side to side.
//!
//! A synced Tremolo follows the tempo but not the song position: its pulse
//! starts from the top of the level when it is made.

use std::f32::consts::TAU;

use super::delay::NOTE_VALUES;
use super::params::{Param, Settings, choice, number, on, switch, time_coefficient};
use super::stereo::StereoEffect;

/// The shapes an LFO of the Tremolo or the Auto Pan can take.
pub const LFO_SHAPES: &[&str] = &["sine", "triangle", "square"];

/// How many quarter notes each of `NOTE_VALUES` lasts.
const NOTE_QUARTERS: [f32; 15] = [
    1.0 / 6.0,
    0.25,
    1.0 / 3.0,
    0.375,
    0.5,
    2.0 / 3.0,
    0.75,
    1.0,
    4.0 / 3.0,
    1.5,
    2.0,
    8.0 / 3.0,
    3.0,
    4.0,
    6.0,
];

const EIGHTH: usize = 4;

/// The tempo a synced LFO assumes until its Insert Chain tells it the song's.
pub(super) const DEFAULT_TEMPO: f64 = 120.0;

/// How quickly the level follows the LFO: fast enough to keep a square's
/// edge, slow enough that it doesn't click.
const GAIN_SMOOTHING_MS: f32 = 2.0;

/// The rate, in cycles per second, of one cycle per `NOTE_VALUES[note]` at
/// `tempo` quarter notes per minute.
pub(super) fn note_hz(note: usize, tempo: f64) -> f32 {
    let quarters = NOTE_QUARTERS[note.min(NOTE_QUARTERS.len() - 1)];
    tempo as f32 / 60.0 / quarters
}

/// An LFO's value, -1..=1, at `phase` (0..1) of its cycle, for the shape at
/// `shape` in `LFO_SHAPES`. Each starts at the top.
pub(super) fn lfo_value(shape: usize, phase: f32) -> f32 {
    let phase = phase.rem_euclid(1.0);
    match shape {
        1 => 4.0 * (phase - 0.5).abs() - 1.0,
        2 => {
            if phase < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
        _ => (TAU * phase).cos(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TremoloSettings {
    /// Whether the rate is a note value, which follows the tempo, rather than
    /// cycles per second.
    pub sync: bool,
    /// An index into `NOTE_VALUES`.
    pub note: usize,
    /// The rate when it isn't synced.
    pub rate_hz: f32,
    /// An index into `LFO_SHAPES`.
    pub shape: usize,
    /// 0..=1: how far down the level goes, 1 to silence.
    pub depth: f32,
    /// 0..=180 degrees: how far the right side's pulse runs behind the left's.
    pub stereo_phase: f32,
}

impl Default for TremoloSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Tremolo, in the order a host sends them.
#[rustfmt::skip]
pub const TREMOLO_PARAMS: &[Param<TremoloSettings>] = &[
    switch("sync", "Sync to tempo", false,
        |s| on(s.sync), |s, v| s.sync = v >= 0.5),
    choice("note", "Note value", NOTE_VALUES, EIGHTH,
        |s| s.note as f32, |s, v| s.note = v as usize),
    number("rateHz", "Rate", "Hz", (0.1, 20.0, 5.0),
        |s| s.rate_hz, |s, v| s.rate_hz = v),
    choice("shape", "Shape", LFO_SHAPES, 0,
        |s| s.shape as f32, |s, v| s.shape = v as usize),
    number("depth", "Depth", "", (0.0, 1.0, 0.5),
        |s| s.depth, |s, v| s.depth = v),
    number("stereoPhase", "Stereo phase", "°", (0.0, 180.0, 0.0),
        |s| s.stereo_phase, |s, v| s.stereo_phase = v),
];

impl Settings for TremoloSettings {
    const PARAMS: &'static [Param<Self>] = TREMOLO_PARAMS;

    fn zeroed() -> Self {
        Self {
            sync: false,
            note: 0,
            rate_hz: 0.0,
            shape: 0,
            depth: 0.0,
            stereo_phase: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Tremolo {
    sample_rate: f32,
    settings: TremoloSettings,
    tempo: f64,
    /// Where in its cycle the left side's LFO is, 0..1.
    phase: f32,
    /// The level each side is at, following the LFO.
    gain: [f32; 2],
    smoothing: f32,
}

impl Tremolo {
    pub fn new(sample_rate: f32, settings: TremoloSettings) -> Self {
        Self {
            sample_rate,
            settings,
            tempo: DEFAULT_TEMPO,
            phase: 0.0,
            gain: [1.0; 2],
            smoothing: time_coefficient(GAIN_SMOOTHING_MS, sample_rate),
        }
    }

    fn rate_hz(&self) -> f32 {
        if self.settings.sync {
            note_hz(self.settings.note, self.tempo)
        } else {
            self.settings.rate_hz
        }
    }
}

impl StereoEffect for Tremolo {
    type Settings = TremoloSettings;

    fn settings(&self) -> TremoloSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: TremoloSettings) {
        self.settings = settings;
    }

    fn set_tempo(&mut self, tempo: f64) {
        if tempo.is_finite() && tempo > 0.0 {
            self.tempo = tempo;
        }
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let TremoloSettings {
            shape,
            depth,
            stereo_phase,
            ..
        } = self.settings;
        let increment = (self.rate_hz() / self.sample_rate).clamp(0.0, 0.5);
        let offset = stereo_phase / 360.0;
        let smoothing = self.smoothing;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            // The LFO's top is full level, its bottom `1 - depth`.
            let target_left = 1.0 - depth * 0.5 * (1.0 - lfo_value(shape, self.phase));
            let target_right = 1.0 - depth * 0.5 * (1.0 - lfo_value(shape, self.phase - offset));
            self.gain[0] = target_left + smoothing * (self.gain[0] - target_left);
            self.gain[1] = target_right + smoothing * (self.gain[1] - target_right);
            self.phase = (self.phase + increment).fract();
            *l *= self.gain[0];
            *r *= self.gain[1];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{max_jump, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> TremoloSettings {
        let mut settings = TremoloSettings::default();
        for (name, value) in changes {
            let param = TREMOLO_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(tremolo: &mut Tremolo, input: &[f32], chunk: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut left, mut right) = (input.to_vec(), input.to_vec());
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            tremolo.process_stereo(l, r);
        }
        (left, right)
    }

    /// How many times a level that pulses crosses its middle going down.
    fn pulses(levels: &[f32], middle: f32) -> usize {
        levels
            .windows(2)
            .filter(|pair| pair[0] >= middle && pair[1] < middle)
            .count()
    }

    #[test]
    fn the_level_swings_between_full_and_the_depth() {
        let dc = vec![1.0; 48_000];
        let mut tremolo = Tremolo::new(RATE, settings(&[("rateHz", 4.0), ("depth", 0.6)]));
        let (left, _) = run(&mut tremolo, &dc, 128);
        let lowest = left.iter().copied().fold(f32::MAX, f32::min);
        let highest = left.iter().copied().fold(f32::MIN, f32::max);
        assert!((lowest - 0.4).abs() < 1e-3, "{lowest}");
        assert!((highest - 1.0).abs() < 1e-3, "{highest}");
        assert_eq!(pulses(&left, 0.7), 4, "four pulses a second");
    }

    #[test]
    fn no_depth_is_the_dry_signal() {
        let input = sine(300.0, 0.5, RATE, 4_800);
        let mut tremolo = Tremolo::new(RATE, settings(&[("depth", 0.0), ("shape", 2.0)]));
        let (left, right) = run(&mut tremolo, &input, 128);
        assert_eq!(left, input);
        assert_eq!(right, input);
    }

    #[test]
    fn a_synced_rate_follows_the_tempo() {
        let dc = vec![1.0; 96_000];
        let quarter = NOTE_VALUES.iter().position(|&n| n == "1/4").unwrap();
        let synced = settings(&[("sync", 1.0), ("note", quarter as f32), ("depth", 1.0)]);
        let mut tremolo = Tremolo::new(RATE, synced);
        let (left, _) = run(&mut tremolo, &dc, 128);
        // Quarter notes at 120 are two a second.
        assert_eq!(pulses(&left, 0.5), 4);

        let mut tremolo = Tremolo::new(RATE, synced);
        tremolo.set_tempo(90.0);
        let (left, _) = run(&mut tremolo, &dc, 128);
        assert_eq!(pulses(&left, 0.5), 3);
    }

    #[test]
    fn the_stereo_phase_puts_the_sides_opposite() {
        let dc = vec![1.0; 48_000];
        let changes = [("depth", 1.0), ("rateHz", 2.0), ("stereoPhase", 180.0)];
        let mut tremolo = Tremolo::new(RATE, settings(&changes));
        let (left, right) = run(&mut tremolo, &dc, 64);
        // Opposite sine pulses always add up to one full level between them.
        for (l, r) in left.iter().zip(&right).skip(1_000) {
            assert!((l + r - 1.0).abs() < 1e-2, "{l} + {r}");
        }
    }

    #[test]
    fn a_square_chops_without_clicking() {
        let dc = vec![1.0; 48_000];
        let changes = [("depth", 1.0), ("rateHz", 20.0), ("shape", 2.0)];
        let mut tremolo = Tremolo::new(RATE, settings(&changes));
        let (left, _) = run(&mut tremolo, &dc, 128);
        assert!(left.iter().any(|&s| s < 1e-3) && left.iter().any(|&s| s > 0.999));
        assert!(max_jump(&left) < 0.02, "{}", max_jump(&left));
    }

    #[test]
    fn any_block_size_sounds_the_same() {
        let input = sine(220.0, 0.8, RATE, 10_000);
        let changes = [("depth", 0.8), ("shape", 1.0), ("stereoPhase", 90.0)];
        let (whole, _) = run(&mut Tremolo::new(RATE, settings(&changes)), &input, 10_000);
        for chunk in [1, 7, 128] {
            let (chunked, _) = run(&mut Tremolo::new(RATE, settings(&changes)), &input, chunk);
            assert_eq!(chunked, whole, "in blocks of {chunk}");
        }
    }

    #[test]
    fn every_shape_starts_at_the_top_and_stays_in_range() {
        for shape in 0..LFO_SHAPES.len() {
            assert!((lfo_value(shape, 0.0) - 1.0).abs() < 1e-6);
            for step in 0..1_000 {
                let value = lfo_value(shape, step as f32 / 1_000.0);
                assert!((-1.0..=1.0).contains(&value), "{shape}: {value}");
            }
        }
        assert!(
            (lfo_value(1, 0.5) + 1.0).abs() < 1e-6,
            "a triangle's bottom"
        );
        assert!((lfo_value(1, 0.25)).abs() < 1e-6);
    }
}

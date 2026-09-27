//! The Delay Effect: repeats of the signal, each quieter than the last.
//!
//! One delay line per side holds the signal back by the time, either a note
//! value that follows the tempo or a fixed number of milliseconds. What comes
//! out is fed back in, scaled by Feedback, through a one-pole high-cut, so
//! each repeat is quieter and darker than the one before. With Ping-pong on,
//! the middle of the input goes into the left line and each line feeds the
//! other, so the repeats alternate left, right, left.
//!
//! The lines are allocated for the longest time up front; changing the time
//! or the tempo only moves where they are read, so it never allocates.

use super::params::{Param, Settings, choice, number, switch};
use crate::dsp::flush_denormal;

/// The longest a Delay holds the signal back. A slower note value is played
/// at this length instead.
pub const MAX_DELAY_SECONDS: f64 = 6.0;
const MAX_TIME_MS: f32 = 2_000.0;
/// Feedback stops short of 1, so the repeats always die away.
const MAX_FEEDBACK: f32 = 0.95;
const HIGHEST_CUT_HZ: f32 = 20_000.0;

/// The note values a synced Delay offers, shortest first.
pub const NOTE_VALUES: &[&str] = &[
    "1/16 triplet",
    "1/16",
    "1/8 triplet",
    "1/16 dotted",
    "1/8",
    "1/4 triplet",
    "1/8 dotted",
    "1/4",
    "1/2 triplet",
    "1/4 dotted",
    "1/2",
    "1/1 triplet",
    "1/2 dotted",
    "1/1",
    "1/1 dotted",
];

/// How many quarter notes each of `NOTE_VALUES` lasts.
const NOTE_QUARTERS: [f64; 15] = [
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

const QUARTER: usize = 7;

/// The tempo a Delay assumes until its Insert Chain tells it the song's.
pub const DEFAULT_TEMPO: f64 = 120.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DelaySettings {
    /// Whether the time is a note value, which follows the tempo, rather than
    /// milliseconds.
    pub sync: bool,
    /// An index into `NOTE_VALUES`.
    pub note: usize,
    /// The time when it isn't synced.
    pub time_ms: f32,
    /// 0..<1: how loud each repeat is against the one before.
    pub feedback: f32,
    /// The corner of the high-cut each repeat passes through.
    pub high_cut_hz: f32,
    pub ping_pong: bool,
    /// 0..=1: 0 is only the dry signal, 1 only the repeats.
    pub mix: f32,
}

impl Default for DelaySettings {
    fn default() -> Self {
        Self::defaults()
    }
}

impl DelaySettings {
    /// How long each repeat waits, in seconds, at `tempo` quarter notes per
    /// minute, before it is held to `MAX_DELAY_SECONDS`.
    pub fn seconds(&self, tempo: f64) -> f64 {
        if self.sync {
            NOTE_QUARTERS[self.note.min(NOTE_QUARTERS.len() - 1)] * 60.0 / tempo
        } else {
            f64::from(self.time_ms) / 1_000.0
        }
    }
}

fn on(value: bool) -> f32 {
    f32::from(u8::from(value))
}

/// Every setting of the Delay, in the order a host sends them.
#[rustfmt::skip]
pub const DELAY_PARAMS: &[Param<DelaySettings>] = &[
    switch("sync", "Sync to tempo", true,
        |s| on(s.sync), |s, v| s.sync = v >= 0.5),
    choice("note", "Note value", NOTE_VALUES, QUARTER,
        |s| s.note as f32, |s, v| s.note = v as usize),
    number("timeMs", "Time", "ms", (1.0, MAX_TIME_MS, 250.0),
        |s| s.time_ms, |s, v| s.time_ms = v),
    number("feedback", "Feedback", "", (0.0, MAX_FEEDBACK, 0.35),
        |s| s.feedback, |s, v| s.feedback = v),
    number("highCutHz", "High cut", "Hz", (200.0, HIGHEST_CUT_HZ, 8_000.0),
        |s| s.high_cut_hz, |s, v| s.high_cut_hz = v),
    switch("pingPong", "Ping-pong", false,
        |s| on(s.ping_pong), |s, v| s.ping_pong = v >= 0.5),
    number("mix", "Mix", "", (0.0, 1.0, 0.3),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for DelaySettings {
    const PARAMS: &'static [Param<Self>] = DELAY_PARAMS;

    fn zeroed() -> Self {
        Self {
            sync: false,
            note: 0,
            time_ms: 0.0,
            feedback: 0.0,
            high_cut_hz: 0.0,
            ping_pong: false,
            mix: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Delay {
    sample_rate: f32,
    settings: DelaySettings,
    tempo: f64,
    left: Vec<f32>,
    right: Vec<f32>,
    /// Where the next sample goes in both lines.
    write: usize,
    /// How far behind `write` the lines are read.
    delay_samples: usize,
    /// The high-cut's coefficient, and its state on each side.
    cut: f32,
    cut_left: f32,
    cut_right: f32,
}

impl Delay {
    pub fn new(sample_rate: f32, settings: DelaySettings) -> Self {
        // One more than the longest delay, so the read never meets the write.
        let capacity = (MAX_DELAY_SECONDS * f64::from(sample_rate)).ceil() as usize + 1;
        let mut delay = Self {
            sample_rate,
            settings,
            tempo: DEFAULT_TEMPO,
            left: vec![0.0; capacity],
            right: vec![0.0; capacity],
            write: 0,
            delay_samples: 1,
            cut: 1.0,
            cut_left: 0.0,
            cut_right: 0.0,
        };
        delay.set_settings(settings);
        delay
    }

    pub fn settings(&self) -> DelaySettings {
        self.settings
    }

    pub fn set_settings(&mut self, settings: DelaySettings) {
        self.settings = settings;
        let corner = settings.high_cut_hz.min(0.49 * self.sample_rate);
        self.cut = 1.0 - (-std::f32::consts::TAU * corner / self.sample_rate).exp();
        self.retime();
    }

    /// The song's tempo where it is playing, in quarter notes per minute,
    /// which a synced time follows.
    pub fn set_tempo(&mut self, tempo: f64) {
        if tempo.is_finite() && tempo > 0.0 && tempo != self.tempo {
            self.tempo = tempo;
            self.retime();
        }
    }

    /// How far behind the input the first repeat is, in samples.
    #[cfg(test)]
    fn delay_samples(&self) -> usize {
        self.delay_samples
    }

    fn retime(&mut self) {
        let seconds = self.settings.seconds(self.tempo).min(MAX_DELAY_SECONDS);
        let samples = (seconds * f64::from(self.sample_rate)).round() as usize;
        self.delay_samples = samples.clamp(1, self.left.len() - 1);
    }

    /// Process both sides in place.
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let length = self.left.len();
        let DelaySettings {
            feedback,
            ping_pong,
            mix,
            ..
        } = self.settings;
        let dry = 1.0 - mix;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let read = (self.write + length - self.delay_samples) % length;
            let (echo_left, echo_right) = (self.left[read], self.right[read]);
            let (feed_left, feed_right) = if ping_pong {
                (
                    0.5 * (*l + *r) + feedback * echo_right,
                    feedback * echo_left,
                )
            } else {
                (*l + feedback * echo_left, *r + feedback * echo_right)
            };
            self.cut_left = flush_denormal(self.cut_left + self.cut * (feed_left - self.cut_left));
            self.cut_right =
                flush_denormal(self.cut_right + self.cut * (feed_right - self.cut_right));
            self.left[self.write] = self.cut_left;
            self.right[self.write] = self.cut_right;
            self.write = (self.write + 1) % length;

            *l = *l * dry + echo_left * mix;
            *r = *r * dry + echo_right * mix;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> DelaySettings {
        let mut settings = DelaySettings {
            sync: false,
            feedback: 0.5,
            high_cut_hz: HIGHEST_CUT_HZ,
            mix: 1.0,
            ..DelaySettings::default()
        };
        for (name, value) in changes {
            let param = DELAY_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    /// Both sides' response to an impulse on both sides at frame 0.
    fn impulse_response(delay: &mut Delay, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut left = vec![0.0; frames];
        let mut right = vec![0.0; frames];
        left[0] = 1.0;
        right[0] = 1.0;
        delay.process_stereo(&mut left, &mut right);
        (left, right)
    }

    /// The level of the repeat starting at `at`: the sum of its samples, which
    /// the high-cut spreads out but doesn't change.
    fn repeat_level(side: &[f32], at: usize, spacing: usize) -> f32 {
        side[at..at + spacing / 2].iter().sum()
    }

    fn loudest(side: &[f32], from: usize, to: usize) -> usize {
        (from..to)
            .max_by(|&a, &b| side[a].abs().total_cmp(&side[b].abs()))
            .unwrap()
    }

    #[test]
    fn an_impulse_repeats_at_the_time_and_decays_by_the_feedback() {
        let spacing = 4_800; // 100 ms at 48 kHz.
        let mut delay = Delay::new(RATE, settings(&[("timeMs", 100.0)]));
        let (left, right) = impulse_response(&mut delay, spacing * 5 + 10);

        assert!(left[..spacing].iter().all(|&s| s == 0.0), "only repeats");
        for side in [&left, &right] {
            for repeat in 1..=4 {
                let at = repeat * spacing;
                assert_eq!(loudest(side, at - spacing / 2, at + spacing / 2), at);
                let expected = 0.5f32.powi(repeat as i32 - 1);
                let level = repeat_level(side, at, spacing);
                assert!(
                    (level - expected).abs() < 1e-3,
                    "repeat {repeat}: {level}, not {expected}"
                );
            }
        }
    }

    #[test]
    fn no_feedback_repeats_once() {
        let mut delay = Delay::new(RATE, settings(&[("timeMs", 10.0), ("feedback", 0.0)]));
        let (left, _) = impulse_response(&mut delay, 2_000);
        assert!((repeat_level(&left, 480, 480) - 1.0).abs() < 1e-3);
        assert!(left[960..].iter().all(|s| s.abs() < 1e-6));
    }

    #[test]
    fn ping_pong_alternates_the_sides() {
        let spacing = 4_800;
        let mut delay = Delay::new(RATE, settings(&[("timeMs", 100.0), ("pingPong", 1.0)]));
        let (left, right) = impulse_response(&mut delay, spacing * 5 + 10);

        for repeat in 1..=4 {
            let at = repeat * spacing;
            let (heard, silent) = if repeat % 2 == 1 {
                (&left, &right)
            } else {
                (&right, &left)
            };
            let expected = 0.5f32.powi(repeat as i32 - 1);
            assert!((repeat_level(heard, at, spacing) - expected).abs() < 1e-3);
            assert!(silent[at..at + spacing / 2].iter().all(|s| s.abs() < 1e-6));
        }
    }

    #[test]
    fn a_synced_time_follows_the_tempo() {
        let mut delay = Delay::new(RATE, settings(&[("sync", 1.0)]));
        // A quarter note at 120 is half a second.
        assert_eq!(delay.delay_samples(), 24_000);
        delay.set_tempo(60.0);
        assert_eq!(delay.delay_samples(), 48_000);

        let dotted_eighth = NOTE_VALUES.iter().position(|&n| n == "1/8 dotted").unwrap();
        let triplet = NOTE_VALUES
            .iter()
            .position(|&n| n == "1/4 triplet")
            .unwrap();
        delay.set_tempo(100.0);
        delay.set_settings(settings(&[("sync", 1.0), ("note", dotted_eighth as f32)]));
        assert_eq!(delay.delay_samples(), 21_600);
        delay.set_settings(settings(&[("sync", 1.0), ("note", triplet as f32)]));
        assert_eq!(delay.delay_samples(), 19_200);

        let (left, _) = impulse_response(&mut delay, 20_000);
        assert_eq!(loudest(&left, 1, 20_000), 19_200);
    }

    #[test]
    fn milliseconds_ignore_the_tempo() {
        let mut delay = Delay::new(RATE, settings(&[("timeMs", 250.0)]));
        delay.set_tempo(77.0);
        assert_eq!(delay.delay_samples(), 12_000);
    }

    #[test]
    fn the_longest_note_at_the_slowest_tempo_is_held_to_the_limit() {
        let mut delay = Delay::new(RATE, settings(&[("sync", 1.0), ("note", 99.0)]));
        assert_eq!(delay.settings().note, NOTE_VALUES.len() - 1);
        delay.set_tempo(20.0);
        assert_eq!(
            delay.delay_samples(),
            (MAX_DELAY_SECONDS * 48_000.0) as usize
        );
    }

    #[test]
    fn the_high_cut_darkens_each_repeat() {
        let spacing = 4_800;
        let open = settings(&[("timeMs", 100.0)]);
        let dark = settings(&[("timeMs", 100.0), ("highCutHz", 500.0)]);
        let (open, _) = impulse_response(&mut Delay::new(RATE, open), spacing * 3);
        let (dark, _) = impulse_response(&mut Delay::new(RATE, dark), spacing * 3);
        // The same level, spread out: a sharp click becomes a soft thump.
        assert!((repeat_level(&dark, spacing, spacing) - 1.0).abs() < 1e-2);
        assert!(dark[spacing] < open[spacing] / 4.0);
        assert!(
            dark[2 * spacing] < dark[spacing],
            "darker again the next time"
        );
    }

    #[test]
    fn the_mix_crossfades_dry_and_repeats() {
        let dry_only = settings(&[("mix", 0.0)]);
        let mut delay = Delay::new(RATE, dry_only);
        let input: Vec<f32> = (0..24_000).map(|i| (i as f32 * 0.01).sin()).collect();
        let (mut left, mut right) = (input.clone(), input.clone());
        delay.process_stereo(&mut left, &mut right);
        assert_eq!(left, input);

        let mut delay = Delay::new(RATE, settings(&[("timeMs", 10.0), ("mix", 0.25)]));
        let (left, _) = impulse_response(&mut delay, 1_000);
        assert!((left[0] - 0.75).abs() < 1e-6);
        assert!((repeat_level(&left, 480, 480) - 0.25).abs() < 1e-3);
    }

    #[test]
    fn the_defaults_are_a_synced_quarter_note() {
        let defaults = DelaySettings::defaults();
        assert!(defaults.sync && !defaults.ping_pong);
        assert_eq!(NOTE_VALUES[defaults.note], "1/4");
        assert_eq!(NOTE_VALUES.len(), NOTE_QUARTERS.len());
        assert!(NOTE_QUARTERS.windows(2).all(|pair| pair[0] < pair[1]));
    }
}

//! The Beat Repeat Effect: grabs a slice of the signal and stutters it, the
//! machine-gun rolls of a build-up.
//!
//! While Repeat is on, the Effect records a Slice-long stretch from the
//! moment it was turned on, playing it through as it does, then plays that
//! stretch over and over, in time with the tempo, until Repeat goes off.
//! Each time round is quieter than the last by Decay, so a roll can fade
//! away. Repeat is a number rather than a switch, 0 or 1, so Automation can
//! drop a roll exactly where it should be. Every repeat is faded in and out
//! over a couple of milliseconds, and turning Repeat on or off crossfades,
//! so none of it clicks. Mix blends the repeats with the dry signal.
//!
//! The recording is allocated for the longest slice, a quarter note at
//! `SLOWEST_TEMPO`, up front; at a slower tempo a slice is held to that.

use super::delay::DEFAULT_TEMPO;
use super::params::{Param, Settings, choice, number, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::flush_denormal;

/// The slice lengths, shortest first.
pub const SLICES: &[&str] = &["1/32", "1/16", "1/8", "1/4"];
/// How many quarter notes each of `SLICES` lasts.
const SLICE_QUARTERS: [f64; 4] = [0.125, 0.25, 0.5, 1.0];
const SIXTEENTH: usize = 1;

/// The slowest tempo a quarter-note slice is recorded whole at.
pub const SLOWEST_TEMPO: f64 = 40.0;
/// How long each repeat fades in and out over.
const FADE_MS: f32 = 1.5;
/// How long turning Repeat on or off takes to crossfade.
const SWITCH_MS: f32 = 2.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeatRepeatSettings {
    /// An index into `SLICES`.
    pub slice: usize,
    /// 0 or 1: whether it is repeating.
    pub repeat: f32,
    /// 0..=1: how much quieter each repeat is than the one before.
    pub decay: f32,
    /// 0..=1: 0 is only the dry signal, 1 only the repeats, while repeating.
    pub mix: f32,
}

impl Default for BeatRepeatSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Beat Repeat, in the order a host sends them.
#[rustfmt::skip]
pub const BEAT_REPEAT_PARAMS: &[Param<BeatRepeatSettings>] = &[
    choice("slice", "Slice", SLICES, SIXTEENTH,
        |s| s.slice as f32, |s, v| s.slice = v as usize),
    number::<BeatRepeatSettings>("repeat", "Repeat", "", (0.0, 1.0, 0.0),
        |s| s.repeat, |s, v| s.repeat = v).stepped(1.0),
    number("decay", "Decay", "", (0.0, 1.0, 0.0),
        |s| s.decay, |s, v| s.decay = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for BeatRepeatSettings {
    const PARAMS: &'static [Param<Self>] = BEAT_REPEAT_PARAMS;

    fn zeroed() -> Self {
        Self {
            slice: 0,
            repeat: 0.0,
            decay: 0.0,
            mix: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BeatRepeat {
    sample_rate: f32,
    settings: BeatRepeatSettings,
    tempo: f64,
    left: Vec<f32>,
    right: Vec<f32>,
    /// Whether it was repeating at the last frame.
    engaged: bool,
    /// How many frames of the slice have been recorded.
    recorded: usize,
    /// Which time round the slice is on, 0 while it is being recorded, and
    /// how far into it.
    pass: u32,
    at: usize,
    /// How loud this time round is.
    level: f32,
    /// How far the output has crossfaded from dry to the repeats, 0..=1.
    wet: f32,
    switch: f32,
    fade: usize,
}

impl BeatRepeat {
    pub fn new(sample_rate: f32, settings: BeatRepeatSettings) -> Self {
        let capacity = (60.0 / SLOWEST_TEMPO * f64::from(sample_rate)).ceil() as usize;
        Self {
            sample_rate,
            settings,
            tempo: DEFAULT_TEMPO,
            left: vec![0.0; capacity],
            right: vec![0.0; capacity],
            engaged: false,
            recorded: 0,
            pass: 0,
            at: 0,
            level: 1.0,
            wet: 0.0,
            switch: time_coefficient(SWITCH_MS, sample_rate),
            fade: ((FADE_MS / 1_000.0 * sample_rate) as usize).max(1),
        }
    }

    /// How many frames a slice lasts at the tempo, held to the recording.
    fn slice_frames(&self) -> usize {
        let quarters = SLICE_QUARTERS[self.settings.slice.min(SLICE_QUARTERS.len() - 1)];
        let frames = (quarters * 60.0 / self.tempo * f64::from(self.sample_rate)).round() as usize;
        frames.clamp(1, self.left.len())
    }

    /// Start recording a new slice from this frame.
    fn engage(&mut self) {
        self.engaged = true;
        self.recorded = 0;
        self.pass = 0;
        self.at = 0;
        self.level = 1.0;
    }

    /// How long this time round is, when a slice is `slice` frames: the
    /// first time round is as long as the slice is now; after that, a
    /// shorter slice rolls the start of what was recorded.
    fn length(&self, slice: usize) -> usize {
        if self.pass == 0 {
            slice
        } else {
            slice.min(self.recorded)
        }
    }

    /// How loud a repeat is `at` frames into a slice of `length`: it fades
    /// in at the start, except the first time round, which carries on from
    /// the dry signal, and out at the end.
    fn window(&self, at: usize, length: usize) -> f32 {
        let fade = self.fade.min(length / 2).max(1);
        let fade_out = ((length - at) as f32 / fade as f32).min(1.0);
        if self.pass == 0 {
            fade_out
        } else {
            fade_out.min((at + 1) as f32 / fade as f32)
        }
    }
}

impl StereoEffect for BeatRepeat {
    type Settings = BeatRepeatSettings;

    fn settings(&self) -> BeatRepeatSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: BeatRepeatSettings) {
        self.settings = settings;
    }

    fn set_tempo(&mut self, tempo: f64) {
        if tempo.is_finite() && tempo > 0.0 {
            self.tempo = tempo;
        }
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let BeatRepeatSettings {
            repeat, decay, mix, ..
        } = self.settings;
        let on = repeat >= 0.5;
        let slice = self.slice_frames();
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            if on && !self.engaged {
                self.engage();
            }
            let target = if on { 1.0 } else { 0.0 };
            self.wet = target + self.switch * (self.wet - target);
            if !on && self.wet < 1e-4 {
                self.wet = 0.0;
                self.engaged = false;
            }
            if !self.engaged {
                continue;
            }

            if self.at >= self.length(slice) {
                self.at = 0;
                self.pass = self.pass.saturating_add(1);
                self.level = flush_denormal(self.level * (1.0 - decay));
            }
            let length = self.length(slice);
            let (source_left, source_right) = if self.pass == 0 {
                self.left[self.at] = *l;
                self.right[self.at] = *r;
                self.recorded = self.at + 1;
                (*l, *r)
            } else {
                (self.left[self.at], self.right[self.at])
            };
            let gain = self.level * self.window(self.at, length);
            self.at += 1;

            let amount = self.wet * mix;
            *l = *l * (1.0 - amount) + source_left * gain * amount;
            *r = *r * (1.0 - amount) + source_right * gain * amount;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{max_jump, rms, sine};

    const RATE: f32 = 48_000.0;
    /// A sixteenth at 120 is 6,000 frames.
    const SLICE: usize = 6_000;

    fn settings(changes: &[(&str, f32)]) -> BeatRepeatSettings {
        let mut settings = BeatRepeatSettings::default();
        for (name, value) in changes {
            let param = BEAT_REPEAT_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(repeat: &mut BeatRepeat, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut left = input.to_vec();
        let mut right = input.to_vec();
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            repeat.process_stereo(l, r);
        }
        assert_eq!(left, right);
        left
    }

    /// A ramp, so where in it a sample came from is plain to see.
    fn ramp(frames: usize) -> Vec<f32> {
        (0..frames).map(|i| i as f32 / frames as f32).collect()
    }

    #[test]
    fn off_it_is_the_dry_signal() {
        let input = sine(220.0, 0.5, RATE, 20_000);
        assert_eq!(
            run(&mut BeatRepeat::new(RATE, settings(&[])), &input, 64),
            input
        );
    }

    #[test]
    fn on_it_plays_the_slice_through_then_repeats_it() {
        let input = ramp(SLICE * 4);
        let out = run(
            &mut BeatRepeat::new(RATE, settings(&[("repeat", 1.0)])),
            &input,
            256,
        );
        // Away from the fades, the first slice is the input and every one
        // after it is the first again.
        for pass in 0..4 {
            for at in (200..SLICE - 200).step_by(500) {
                let heard = out[pass * SLICE + at];
                assert!(
                    (heard - input[at]).abs() < 1e-3,
                    "pass {pass} at {at}: {heard}"
                );
            }
        }
    }

    #[test]
    fn the_slice_follows_the_tempo_and_decay_quietens_each_repeat() {
        let eighth = SLICES.iter().position(|&s| s == "1/8").unwrap() as f32;
        let mut repeat = BeatRepeat::new(
            RATE,
            settings(&[("repeat", 1.0), ("slice", eighth), ("decay", 0.5)]),
        );
        repeat.set_tempo(60.0);
        // An eighth at 60 is 24,000 frames.
        let input = sine(500.0, 0.5, RATE, 24_000 * 3);
        let out = run(&mut repeat, &input, 1_000);
        let level = |pass: usize| rms(&out[pass * 24_000 + 1_000..pass * 24_000 + 23_000]);
        assert!(
            (level(0) - level(1) * 2.0).abs() < 0.01,
            "{} {}",
            level(0),
            level(1)
        );
        assert!((level(1) - level(2) * 2.0).abs() < 0.01);
        for at in (1_000..23_000).step_by(997) {
            assert!((out[24_000 + at] - 0.5 * input[at]).abs() < 1e-3);
        }
    }

    #[test]
    fn switching_and_repeating_do_not_click() {
        let input = sine(150.0, 0.8, RATE, SLICE * 6);
        let mut repeat = BeatRepeat::new(RATE, settings(&[("repeat", 1.0)]));
        let mut out = run(&mut repeat, &input[..SLICE * 3 + 1_234], 128);
        repeat.set_settings(settings(&[("repeat", 0.0)]));
        out.extend(run(&mut repeat, &input[SLICE * 3 + 1_234..], 128));
        assert!(max_jump(&out) < 0.1, "{}", max_jump(&out));
        // Once off, it goes back to the dry signal.
        assert_eq!(out[SLICE * 5..], input[SLICE * 5..]);
    }

    #[test]
    fn no_mix_is_dry_and_any_chunking_is_the_same() {
        let input = sine(330.0, 0.5, RATE, SLICE * 3);
        let dry = run(
            &mut BeatRepeat::new(RATE, settings(&[("repeat", 1.0), ("mix", 0.0)])),
            &input,
            99,
        );
        assert_eq!(dry, input);

        let on = settings(&[("repeat", 1.0), ("decay", 0.3)]);
        let whole = run(&mut BeatRepeat::new(RATE, on), &input, SLICE * 3);
        let single = run(&mut BeatRepeat::new(RATE, on), &input, 1);
        assert_eq!(whole, single);
    }

    #[test]
    fn a_slow_tempo_holds_the_slice_to_the_recording_and_stays_finite() {
        let quarter = SLICES.len() as f32 - 1.0;
        let mut repeat = BeatRepeat::new(
            RATE,
            settings(&[("repeat", 1.0), ("slice", quarter), ("decay", 1.0)]),
        );
        repeat.set_tempo(10.0);
        assert_eq!(repeat.slice_frames(), 72_000);
        let input = sine(1_000.0, 1.0, RATE, 200_000);
        let out = run(&mut repeat, &input, 4_096);
        assert!(out.iter().all(|s| s.is_finite() && s.abs() <= 1.0));
        repeat.set_tempo(999.0);
        repeat.set_settings(settings(&[("repeat", 1.0), ("slice", 0.0)]));
        assert!(run(&mut repeat, &input, 3).iter().all(|s| s.is_finite()));
    }
}

//! The Trance Gate Effect: chops the signal into a rhythm, the stuttering
//! pads and supersaws of trance.
//!
//! A pattern of 16 steps, each a Step length long, runs in time with the
//! tempo. While the song plays it follows the song's position, so with
//! sixteenth steps the first step lands on each bar (of four beats); with
//! eighths, on every other bar. Stopped, or without a position, it runs free
//! from wherever it got to, from the first step when it is made. Pattern
//! picks which steps are open. Each open step fades in over Attack and out over
//! Release, so the chops don't click and two open steps in a row are still
//! heard as two; closed steps fall by Depth, all the way to silence at 1.
//! Mix blends it with the dry signal.

use super::delay::DEFAULT_TEMPO;
use super::params::{Param, Settings, choice, number, time_coefficient};
use super::stereo::{SongPosition, StereoEffect};

/// How long each step lasts, shortest first.
pub const GATE_STEPS: &[&str] = &["1/32", "1/16", "1/8"];
/// How many quarter notes each of `GATE_STEPS` lasts.
const STEP_QUARTERS: [f64; 3] = [0.125, 0.25, 0.5];
const SIXTEENTH: usize = 1;

const STEPS: usize = 16;

/// The patterns a Trance Gate offers, in the order of `PATTERN_STEPS`.
pub const GATE_PATTERNS: &[&str] = &[
    "sixteenths",
    "eighths",
    "offbeats",
    "gallop",
    "reverse gallop",
    "tresillo",
    "syncopated",
    "build",
];

/// Which of the 16 steps each of `GATE_PATTERNS` opens: `x` open, `.` closed.
const PATTERN_STEPS: [[bool; STEPS]; 8] = [
    // The UI draws these too (`TRANCE_GATE_STEP_PATTERNS` in effect-visuals.tsx): change both together.
    steps(b"xxxxxxxxxxxxxxxx"),
    steps(b"x.x.x.x.x.x.x.x."),
    steps(b"..x...x...x...x."),
    steps(b"x.xxx.xxx.xxx.xx"),
    steps(b"xx.xxx.xxx.xxx.x"),
    steps(b"x..x..x.x..x..x."),
    steps(b"x.xx.xx.x.xx.xx."),
    steps(b"x...x...x.x.xxxx"),
];

const fn steps(pattern: &[u8; STEPS]) -> [bool; STEPS] {
    let mut open = [false; STEPS];
    let mut step = 0;
    while step < STEPS {
        open[step] = pattern[step] == b'x';
        step += 1;
    }
    open
}

const MIN_FADE_MS: f32 = 0.5;
/// How long the gain takes to follow a pattern or depth that jumps.
const SMOOTHING_MS: f32 = 0.3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TranceGateSettings {
    /// An index into `GATE_STEPS`.
    pub step: usize,
    /// An index into `GATE_PATTERNS`.
    pub pattern: usize,
    pub attack_ms: f32,
    pub release_ms: f32,
    /// 0..=1: how far closed steps fall; 1 is silence.
    pub depth: f32,
    /// 0..=1: 0 is only the dry signal, 1 only the gated one.
    pub mix: f32,
}

impl Default for TranceGateSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Trance Gate, in the order a host sends them.
#[rustfmt::skip]
pub const TRANCE_GATE_PARAMS: &[Param<TranceGateSettings>] = &[
    choice("step", "Step length", GATE_STEPS, SIXTEENTH,
        |s| s.step as f32, |s, v| s.step = v as usize),
    choice("pattern", "Pattern", GATE_PATTERNS, 1,
        |s| s.pattern as f32, |s, v| s.pattern = v as usize),
    number("attackMs", "Attack", "ms", (MIN_FADE_MS, 50.0, 2.0),
        |s| s.attack_ms, |s, v| s.attack_ms = v),
    number("releaseMs", "Release", "ms", (MIN_FADE_MS, 200.0, 20.0),
        |s| s.release_ms, |s, v| s.release_ms = v),
    number("depth", "Depth", "", (0.0, 1.0, 1.0),
        |s| s.depth, |s, v| s.depth = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for TranceGateSettings {
    const PARAMS: &'static [Param<Self>] = TRANCE_GATE_PARAMS;

    fn zeroed() -> Self {
        Self {
            step: 0,
            pattern: 0,
            attack_ms: 0.0,
            release_ms: 0.0,
            depth: 0.0,
            mix: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TranceGate {
    sample_rate: f32,
    settings: TranceGateSettings,
    tempo: f64,
    /// Where in the pattern the Gate is, in steps, 0..16: from the song's
    /// position while it moves, counted on from there when it doesn't.
    position: f64,
    song: SongPosition,
    /// Whether the next frame jumps the gain to where it should be, not
    /// smoothing it there: the first frame after `settle`, once the song's
    /// position has placed it.
    snap: bool,
    gain: f32,
    smoothing: f32,
}

impl TranceGate {
    pub fn new(sample_rate: f32, settings: TranceGateSettings) -> Self {
        Self {
            sample_rate,
            settings,
            tempo: DEFAULT_TEMPO,
            position: 0.0,
            song: SongPosition::default(),
            snap: false,
            gain: 1.0,
            smoothing: time_coefficient(SMOOTHING_MS, sample_rate),
        }
    }

    /// How many quarter notes one step lasts.
    fn step_quarters(&self) -> f64 {
        STEP_QUARTERS[self.settings.step.min(STEP_QUARTERS.len() - 1)]
    }

    fn step_samples(&self) -> f64 {
        self.step_quarters() * 60.0 / self.tempo * f64::from(self.sample_rate)
    }

    /// The gain the pattern puts on the Gate where it is, with its steps
    /// `length` samples long.
    fn target(&self, length: f64) -> f32 {
        let TranceGateSettings {
            pattern,
            attack_ms,
            release_ms,
            depth,
            ..
        } = self.settings;
        let open = &PATTERN_STEPS[pattern.min(PATTERN_STEPS.len() - 1)];
        let per_ms = self.sample_rate / 1_000.0;
        let (mut attack, mut release) = (
            (attack_ms * per_ms).max(1.0),
            (release_ms * per_ms).max(1.0),
        );
        // Short steps squeeze both fades to fit, keeping their balance.
        let fit = length as f32 / (attack + release);
        if fit < 1.0 {
            attack *= fit;
            release *= fit;
        }
        let floor = 1.0 - depth;
        let step = (self.position as usize).min(STEPS - 1);
        if open[step] {
            let at = (self.position - step as f64) * length;
            floor + depth * Self::envelope(at as f32, length as f32, attack, release)
        } else {
            floor
        }
    }

    /// How open a step is `at` samples in, 0..=1, when it fades in over
    /// `attack` samples and out over `release`.
    fn envelope(at: f32, length: f32, attack: f32, release: f32) -> f32 {
        (at / attack).min((length - at) / release).clamp(0.0, 1.0)
    }
}

impl StereoEffect for TranceGate {
    type Settings = TranceGateSettings;

    fn settings(&self) -> TranceGateSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: TranceGateSettings) {
        self.settings = settings;
    }

    fn set_tempo(&mut self, tempo: f64) {
        if tempo.is_finite() && tempo > 0.0 {
            self.tempo = tempo;
        }
    }

    fn settle(&mut self) {
        self.gain = self.target(self.step_samples());
        self.snap = true;
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.process_stereo_at(left, right, &[]);
    }

    fn process_stereo_at(&mut self, left: &mut [f32], right: &mut [f32], ticks: &[f64]) {
        let mix = self.settings.mix;
        let length = self.step_samples();
        let pattern_quarters = self.step_quarters() * STEPS as f64;
        let increment = 1.0 / length;
        for (frame, (l, r)) in left.iter_mut().zip(right.iter_mut()).enumerate() {
            if let Some(moved) = self.song.step(ticks, frame) {
                // A playhead that jumps moves the pattern at once; the
                // smoother takes the gain there without a click.
                self.position = moved.phase(pattern_quarters) * STEPS as f64;
            }
            let target = self.target(length);
            if std::mem::take(&mut self.snap) {
                self.gain = target;
            }
            self.gain = target + self.smoothing * (self.gain - target);
            self.position += increment;
            if self.position >= STEPS as f64 {
                self.position -= STEPS as f64;
            }

            let scale = 1.0 - mix * (1.0 - self.gain);
            *l *= scale;
            *r *= scale;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{max_jump, rms, sine};
    use crate::effect::stereo::song_ticks;

    const RATE: f32 = 48_000.0;
    /// A sixteenth at 120 is 6,000 frames.
    const STEP: usize = 6_000;

    fn settings(changes: &[(&str, f32)]) -> TranceGateSettings {
        let mut settings = TranceGateSettings::default();
        for (name, value) in changes {
            let param = TRANCE_GATE_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn pattern(name: &str) -> f32 {
        GATE_PATTERNS.iter().position(|&p| p == name).unwrap() as f32
    }

    fn run(gate: &mut TranceGate, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut left = input.to_vec();
        let mut right = input.to_vec();
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            gate.process_stereo(l, r);
        }
        assert_eq!(left, right);
        left
    }

    /// `run`, with the song playing at 120 from `start` ticks.
    fn run_at(gate: &mut TranceGate, input: &[f32], start: f64, chunk: usize) -> Vec<f32> {
        let ticks = song_ticks(start, 120.0, RATE, input.len());
        let (mut left, mut right) = (input.to_vec(), input.to_vec());
        for ((l, r), t) in left
            .chunks_mut(chunk)
            .zip(right.chunks_mut(chunk))
            .zip(ticks.chunks(chunk))
        {
            gate.process_stereo_at(l, r, t);
        }
        left
    }

    #[test]
    fn the_pattern_opens_and_closes_the_steps() {
        let mut gate = TranceGate::new(RATE, settings(&[("pattern", pattern("offbeats"))]));
        let out = run(&mut gate, &vec![1.0; STEP * 16], 256);
        for step in 0..16 {
            let middle = out[step * STEP + STEP / 2];
            if step % 4 == 2 {
                assert!((middle - 1.0).abs() < 1e-4, "step {step} open: {middle}");
            } else {
                assert!(middle.abs() < 1e-4, "step {step} closed: {middle}");
            }
        }
    }

    #[test]
    fn open_steps_in_a_row_are_chopped_apart_without_clicking() {
        let mut gate = TranceGate::new(RATE, settings(&[("pattern", pattern("sixteenths"))]));
        let input = sine(220.0, 0.8, RATE, STEP * 8);
        let out = run(&mut gate, &input, 128);
        // Each step fades out to nothing before the next.
        for step in 1..8 {
            assert!(out[step * STEP - 1].abs() < 0.03);
        }
        assert!(
            max_jump(&out) < max_jump(&input) * 3.0,
            "{}",
            max_jump(&out)
        );
    }

    #[test]
    fn depth_sets_how_far_closed_steps_fall() {
        let half = settings(&[("pattern", pattern("eighths")), ("depth", 0.5)]);
        let out = run(&mut TranceGate::new(RATE, half), &vec![1.0; STEP * 2], 64);
        assert!((out[STEP + STEP / 2] - 0.5).abs() < 1e-4);
        assert!((out[STEP / 2] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn the_steps_follow_the_tempo_and_step_length() {
        let eighth = GATE_STEPS.iter().position(|&s| s == "1/8").unwrap() as f32;
        let mut gate = TranceGate::new(
            RATE,
            settings(&[("pattern", pattern("eighths")), ("step", eighth)]),
        );
        gate.set_tempo(60.0);
        // An eighth at 60 is 24,000 frames: the first step open, the second shut.
        let out = run(&mut gate, &vec![1.0; 48_000], 500);
        assert!((out[12_000] - 1.0).abs() < 1e-4);
        assert!(out[36_000].abs() < 1e-4);
    }

    #[test]
    fn no_mix_is_dry_and_any_chunking_is_the_same() {
        let input = sine(330.0, 0.5, RATE, 20_000);
        let dry = run(
            &mut TranceGate::new(RATE, settings(&[("mix", 0.0)])),
            &input,
            99,
        );
        assert_eq!(dry, input);

        let whole = run(&mut TranceGate::new(RATE, settings(&[])), &input, 20_000);
        let single = run(&mut TranceGate::new(RATE, settings(&[])), &input, 1);
        assert_eq!(whole, single);
        assert!(rms(&whole) < rms(&input) * 0.8);
    }

    #[test]
    fn extreme_settings_stay_finite() {
        let shortest = settings(&[("step", 0.0), ("attackMs", 50.0), ("releaseMs", 200.0)]);
        let mut gate = TranceGate::new(RATE, shortest);
        gate.set_tempo(999.0);
        let out = run(&mut gate, &vec![1.0; 10_000], 7);
        assert!(out.iter().all(|s| s.is_finite() && (0.0..=1.0).contains(s)));
        for pattern in 0..GATE_PATTERNS.len() {
            gate.set_settings(settings(&[("pattern", pattern as f32)]));
            assert!(
                run(&mut gate, &vec![1.0; 1_000], 13)
                    .iter()
                    .all(|s| s.is_finite())
            );
        }
        assert_eq!(GATE_PATTERNS.len(), PATTERN_STEPS.len());
    }

    #[test]
    fn playing_the_pattern_starts_on_each_bar() {
        let build = pattern("build");
        let open = PATTERN_STEPS[build as usize];
        // A beat and a half into a bar is its seventh sixteenth, step 6.
        for chunk in [1, 256] {
            let mut gate = TranceGate::new(RATE, settings(&[("pattern", build)]));
            let out = run_at(&mut gate, &vec![1.0; STEP * 24], 1_440.0, chunk);
            for frame_step in 0..24 {
                let middle = out[frame_step * STEP + STEP / 2];
                let expected = if open[(frame_step + 6) % 16] {
                    1.0
                } else {
                    0.0
                };
                assert!(
                    (middle - expected).abs() < 1e-4,
                    "{chunk}: step {}: {middle}",
                    frame_step + 6
                );
            }
        }
        // With no position, the pattern starts where the Gate does.
        let mut gate = TranceGate::new(RATE, settings(&[("pattern", build)]));
        let out = run(&mut gate, &vec![1.0; STEP * 16], 256);
        for step in 0..16 {
            let expected = if open[step] { 1.0 } else { 0.0 };
            assert!((out[step * STEP + STEP / 2] - expected).abs() < 1e-4);
        }
    }

    #[test]
    fn a_playhead_that_jumps_does_not_click() {
        // From the middle of an open step to the middle of a closed one.
        let input = sine(150.0, 0.8, RATE, STEP * 4);
        let mut ticks = song_ticks(0.0, 120.0, RATE, input.len());
        for tick in &mut ticks[STEP / 2..] {
            *tick += 240.0;
        }
        let mut gate = TranceGate::new(RATE, settings(&[]));
        let (mut left, mut right) = (input.clone(), input.clone());
        gate.process_stereo_at(&mut left, &mut right, &ticks);
        assert!(left[STEP / 2 + 200].abs() < 1e-3, "it did jump");
        assert!(max_jump(&left) < 0.1, "{}", max_jump(&left));
    }
}

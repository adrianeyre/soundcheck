//! The Flanger Effect: the sweeping, jet-plane whoosh of two tape machines
//! running a hair apart.
//!
//! One very short delay line per side is read at a time that swings from
//! Delay up to Delay plus Depth and back, at Rate. Mixed with the dry signal,
//! the copy cancels a comb of frequencies whose spacing moves as the time
//! does, which is the sweep. Feedback puts the copy back into the line, which
//! turns the notches into ringing peaks; a negative Feedback flips it, for a
//! hollower, more metallic ring. Stereo phase runs the right side's sweep
//! behind the left's, up to half a cycle, so the whoosh moves across the
//! stereo image. Mix blends the copy with the dry signal: half and half cuts
//! the deepest notches.
//!
//! The lines are allocated for the longest time up front, so changing any
//! setting never allocates, and the times glide to a new setting rather than
//! jumping, so turning them doesn't click.

use std::f32::consts::TAU;

use super::params::{Param, Settings, number, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::flush_denormal;

const MAX_DELAY_MS: f32 = 10.0;
const MAX_DEPTH_MS: f32 = 10.0;
/// Feedback stops short of 1 either way, so the ring always dies away.
const MAX_FEEDBACK: f32 = 0.95;
/// How quickly the times follow a change.
const TIME_SMOOTHING_MS: f32 = 50.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlangerSettings {
    pub rate_hz: f32,
    /// The shortest the copy is late by, in milliseconds.
    pub delay_ms: f32,
    /// How much later the copy swings to, in milliseconds.
    pub depth_ms: f32,
    /// -0.95..=0.95: how much of the copy goes back in, and which way up.
    pub feedback: f32,
    /// 0..=180 degrees: how far the right side's sweep runs behind the left's.
    pub stereo_phase: f32,
    /// 0..=1: 0 is only the dry signal, 1 only the copy.
    pub mix: f32,
}

impl Default for FlangerSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Flanger, in the order a host sends them.
#[rustfmt::skip]
pub const FLANGER_PARAMS: &[Param<FlangerSettings>] = &[
    number("rateHz", "Rate", "Hz", (0.05, 10.0, 0.3),
        |s| s.rate_hz, |s, v| s.rate_hz = v),
    number("delayMs", "Delay", "ms", (0.1, MAX_DELAY_MS, 1.0),
        |s| s.delay_ms, |s, v| s.delay_ms = v),
    number("depthMs", "Depth", "ms", (0.0, MAX_DEPTH_MS, 3.0),
        |s| s.depth_ms, |s, v| s.depth_ms = v),
    number("feedback", "Feedback", "", (-MAX_FEEDBACK, MAX_FEEDBACK, 0.5),
        |s| s.feedback, |s, v| s.feedback = v),
    number("stereoPhase", "Stereo phase", "°", (0.0, 180.0, 90.0),
        |s| s.stereo_phase, |s, v| s.stereo_phase = v),
    number("mix", "Mix", "", (0.0, 1.0, 0.5),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for FlangerSettings {
    const PARAMS: &'static [Param<Self>] = FLANGER_PARAMS;

    fn zeroed() -> Self {
        Self {
            rate_hz: 0.0,
            delay_ms: 0.0,
            depth_ms: 0.0,
            feedback: 0.0,
            stereo_phase: 0.0,
            mix: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Flanger {
    sample_rate: f32,
    settings: FlangerSettings,
    left: Vec<f32>,
    right: Vec<f32>,
    write: usize,
    /// Where in its cycle the left side's sweep is, 0..1.
    phase: f32,
    /// The delay and the depth in samples, gliding to the settings'.
    delay: f32,
    depth: f32,
    smoothing: f32,
}

impl Flanger {
    pub fn new(sample_rate: f32, settings: FlangerSettings) -> Self {
        // Room for the longest delay plus the widest swing, and the sample
        // after it to interpolate towards.
        let capacity = ((MAX_DELAY_MS + MAX_DEPTH_MS) / 1_000.0 * sample_rate).ceil() as usize + 4;
        let per_ms = sample_rate / 1_000.0;
        Self {
            sample_rate,
            settings,
            left: vec![0.0; capacity],
            right: vec![0.0; capacity],
            write: 0,
            phase: 0.0,
            delay: settings.delay_ms * per_ms,
            depth: settings.depth_ms * per_ms,
            smoothing: time_coefficient(TIME_SMOOTHING_MS, sample_rate),
        }
    }

    /// The line read `delay` samples behind the write, between samples.
    fn read(line: &[f32], write: usize, delay: f32) -> f32 {
        let length = line.len();
        let whole = delay.floor();
        let fraction = delay - whole;
        let at = (write + length * 2 - whole as usize) % length;
        let before = (at + length - 1) % length;
        line[at] * (1.0 - fraction) + line[before] * fraction
    }
}

impl StereoEffect for Flanger {
    type Settings = FlangerSettings;

    fn settings(&self) -> FlangerSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: FlangerSettings) {
        self.settings = settings;
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let FlangerSettings {
            rate_hz,
            delay_ms,
            depth_ms,
            feedback,
            stereo_phase,
            mix,
        } = self.settings;
        let per_ms = self.sample_rate / 1_000.0;
        let (delay, depth) = (delay_ms * per_ms, depth_ms * per_ms);
        let increment = rate_hz / self.sample_rate;
        let offset = stereo_phase / 360.0;
        let smoothing = self.smoothing;
        let length = self.left.len();
        let longest = (length - 2) as f32;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            self.delay = delay + smoothing * (self.delay - delay);
            self.depth = depth + smoothing * (self.depth - depth);
            // From the shortest time at the start of a cycle to the longest
            // half way through.
            let swing = |phase: f32| 0.5 * (1.0 - (TAU * phase).cos());
            let delay_left = (self.delay + self.depth * swing(self.phase)).clamp(1.0, longest);
            let delay_right =
                (self.delay + self.depth * swing(self.phase - offset)).clamp(1.0, longest);
            let wet_left = Self::read(&self.left, self.write, delay_left);
            let wet_right = Self::read(&self.right, self.write, delay_right);
            self.left[self.write] = flush_denormal(*l + feedback * wet_left);
            self.right[self.write] = flush_denormal(*r + feedback * wet_right);
            self.write = (self.write + 1) % length;
            self.phase = (self.phase + increment).fract();

            *l = *l * (1.0 - mix) + wet_left * mix;
            *r = *r * (1.0 - mix) + wet_right * mix;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, rms, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> FlangerSettings {
        let mut settings = FlangerSettings::default();
        for (name, value) in changes {
            let param = FLANGER_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(flanger: &mut Flanger, input: &[f32], chunk: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut left, mut right) = (input.to_vec(), input.to_vec());
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            flanger.process_stereo(l, r);
        }
        (left, right)
    }

    #[test]
    fn half_and_half_cancels_a_tone_a_half_cycle_late() {
        // 1 ms late is half a cycle of 500 Hz, and a whole one of 1 kHz.
        let still = [
            ("depthMs", 0.0),
            ("delayMs", 1.0),
            ("feedback", 0.0),
            ("mix", 0.5),
        ];
        let cancelled = sine(500.0, 1.0, RATE, 9_600);
        let (left, right) = run(&mut Flanger::new(RATE, settings(&still)), &cancelled, 128);
        assert!(peak(&left[100..]) < 1e-3, "{}", peak(&left[100..]));
        assert_eq!(left, right);

        let doubled = sine(1_000.0, 1.0, RATE, 9_600);
        let (left, _) = run(&mut Flanger::new(RATE, settings(&still)), &doubled, 128);
        assert!((rms(&left[100..]) - rms(&doubled[100..])).abs() < 1e-3);
    }

    #[test]
    fn the_sweep_moves_the_notch() {
        // A tone the still notch cancels comes and goes as the time swings.
        let input = sine(500.0, 1.0, RATE, 96_000);
        let sweeping = [
            ("depthMs", 2.0),
            ("delayMs", 1.0),
            ("feedback", 0.0),
            ("rateHz", 1.0),
        ];
        let (left, _) = run(&mut Flanger::new(RATE, settings(&sweeping)), &input, 128);
        let levels: Vec<f32> = left.chunks(2_400).map(rms).collect();
        let quietest = levels.iter().copied().fold(f32::MAX, f32::min);
        let loudest = levels.iter().copied().fold(f32::MIN, f32::max);
        assert!(quietest < 0.1 && loudest > 0.6, "{quietest}..{loudest}");
    }

    #[test]
    fn feedback_either_way_rings_but_stays_bounded() {
        let mut impulse = vec![0.0; 48_000];
        impulse[0] = 1.0;
        for feedback in [-0.95, 0.95] {
            let still = [
                ("depthMs", 0.0),
                ("delayMs", 1.0),
                ("feedback", feedback),
                ("mix", 1.0),
            ];
            let (left, _) = run(&mut Flanger::new(RATE, settings(&still)), &impulse, 128);
            // Each trip round the line is 48 samples, and flips with a
            // negative feedback.
            assert!((left[48] - 1.0).abs() < 1e-6);
            assert!(
                (left[96] - feedback).abs() < 1e-6,
                "{feedback}: {}",
                left[96]
            );
            assert!(left.iter().all(|s| s.is_finite() && s.abs() <= 1.0));
        }
        let loud = sine(300.0, 1.0, RATE, 96_000);
        let wild = [
            ("feedback", 0.95),
            ("rateHz", 10.0),
            ("depthMs", 10.0),
            ("delayMs", 10.0),
        ];
        let (left, right) = run(&mut Flanger::new(RATE, settings(&wild)), &loud, 128);
        assert!(peak(&left) < 25.0 && left.iter().chain(&right).all(|s| s.is_finite()));
    }

    #[test]
    fn no_mix_is_dry_and_the_stereo_phase_spreads_the_sides() {
        let input = sine(440.0, 0.5, RATE, 24_000);
        let (left, right) = run(
            &mut Flanger::new(RATE, settings(&[("mix", 0.0)])),
            &input,
            128,
        );
        assert_eq!((left, right), (input.clone(), input.clone()));

        let (left, right) = run(
            &mut Flanger::new(RATE, settings(&[("rateHz", 2.0)])),
            &input,
            128,
        );
        let difference: f32 = left.iter().zip(&right).map(|(l, r)| (l - r).abs()).sum();
        assert!(difference > 100.0, "{difference}");
        let mono = [("rateHz", 2.0), ("stereoPhase", 0.0)];
        let (left, right) = run(&mut Flanger::new(RATE, settings(&mono)), &input, 128);
        assert_eq!(left, right, "no phase, no spread");
    }

    #[test]
    fn any_block_size_sounds_the_same() {
        let input = sine(220.0, 0.8, RATE, 10_000);
        let (whole, _) = run(&mut Flanger::new(RATE, settings(&[])), &input, 10_000);
        for chunk in [1, 7, 128] {
            let mut flanger = Flanger::new(RATE, settings(&[]));
            let (chunked, _) = run(&mut flanger, &input, chunk);
            assert_eq!(chunked, whole, "in blocks of {chunk}");
        }
    }
}

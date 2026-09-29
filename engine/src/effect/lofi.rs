//! The Lo-fi Effect: the sound of a worn cassette, warm, wobbly and hissy.
//!
//! The signal passes through a short delay line whose time drifts, so its
//! pitch bends: Wow is the slow, seasick sway of a stretched tape, Flutter
//! the fast waver of an uneven capstan. Drive rounds it off through a soft
//! saturation, like tape pushed hard. Hiss adds a bed of noise under it,
//! and Tone is a gentle low-pass on the lot, which takes the top off, as old
//! tape does. Mix blends it with the dry signal.
//!
//! The line is allocated for the widest wobble up front, and the noise
//! comes from a fixed seed, so the Effect sounds the same every render.

use std::f32::consts::TAU;

use super::params::{Param, Settings, number, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::flush_denormal;

/// How far the delay swings at full Wow and Flutter, in milliseconds.
const WOW_MS: f32 = 2.0;
const FLUTTER_MS: f32 = 0.15;
/// How fast they sway.
const WOW_HZ: f32 = 0.55;
const FLUTTER_HZ: f32 = 7.3;
/// The delay both swing around: enough for both at once, and the
/// interpolation's look-ahead.
const CENTRE_MS: f32 = WOW_MS + FLUTTER_MS + 0.5;
/// The noise level at full Hiss: -30 dBFS.
const HISS_LEVEL: f32 = 0.032;
/// How long Wow, Flutter and Drive take to follow a change, so the delay
/// glides rather than jumps.
const SMOOTHING_MS: f32 = 20.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoFiSettings {
    /// 0..=1: the slow pitch sway.
    pub wow: f32,
    /// 0..=1: the fast pitch waver.
    pub flutter: f32,
    /// The low-pass corner.
    pub tone_hz: f32,
    /// 0..=1: how hard the saturation rounds the signal off.
    pub drive: f32,
    /// 0..=1: how loud the noise is.
    pub hiss: f32,
    /// 0..=1: 0 is only the dry signal, 1 only the worn one.
    pub mix: f32,
}

impl Default for LoFiSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Lo-fi, in the order a host sends them.
#[rustfmt::skip]
pub const LOFI_PARAMS: &[Param<LoFiSettings>] = &[
    number("wow", "Wow", "", (0.0, 1.0, 0.3),
        |s| s.wow, |s, v| s.wow = v),
    number("flutter", "Flutter", "", (0.0, 1.0, 0.2),
        |s| s.flutter, |s, v| s.flutter = v),
    number("toneHz", "Tone", "Hz", (500.0, 20_000.0, 6_000.0),
        |s| s.tone_hz, |s, v| s.tone_hz = v),
    number("drive", "Drive", "", (0.0, 1.0, 0.3),
        |s| s.drive, |s, v| s.drive = v),
    number("hiss", "Hiss", "", (0.0, 1.0, 0.2),
        |s| s.hiss, |s, v| s.hiss = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for LoFiSettings {
    const PARAMS: &'static [Param<Self>] = LOFI_PARAMS;

    fn zeroed() -> Self {
        Self {
            wow: 0.0,
            flutter: 0.0,
            tone_hz: 0.0,
            drive: 0.0,
            hiss: 0.0,
            mix: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct LoFi {
    sample_rate: f32,
    settings: LoFiSettings,
    left: Vec<f32>,
    right: Vec<f32>,
    write: usize,
    /// Where Wow and Flutter are in their cycles, 0..1.
    wow_phase: f32,
    flutter_phase: f32,
    /// Wow, Flutter and Drive, gliding towards the settings'.
    wow: f32,
    flutter: f32,
    drive: f32,
    smoothing: f32,
    /// The low-pass: two one-pole stages per side, and the coefficient
    /// they share, gliding towards Tone's.
    tone: [[f32; 2]; 2],
    cut: f32,
    /// The noise generator's state.
    noise: u32,
}

impl LoFi {
    pub fn new(sample_rate: f32, settings: LoFiSettings) -> Self {
        let capacity =
            ((CENTRE_MS + WOW_MS + FLUTTER_MS) / 1_000.0 * sample_rate).ceil() as usize + 4;
        Self {
            sample_rate,
            settings,
            left: vec![0.0; capacity],
            right: vec![0.0; capacity],
            write: 0,
            wow_phase: 0.0,
            flutter_phase: 0.0,
            wow: settings.wow,
            flutter: settings.flutter,
            drive: settings.drive,
            smoothing: time_coefficient(SMOOTHING_MS, sample_rate),
            tone: [[0.0; 2]; 2],
            cut: Self::cut(settings.tone_hz, sample_rate),
            noise: 0x9E37_79B9,
        }
    }

    /// The one-pole coefficient for a corner at `hz`.
    fn cut(hz: f32, sample_rate: f32) -> f32 {
        1.0 - (-TAU * hz.min(0.45 * sample_rate) / sample_rate).exp()
    }

    /// One side through both low-pass stages.
    fn low_pass(stages: &mut [f32; 2], cut: f32, x: f32) -> f32 {
        stages[0] = flush_denormal(stages[0] + cut * (x - stages[0]));
        stages[1] = flush_denormal(stages[1] + cut * (stages[0] - stages[1]));
        stages[1]
    }

    /// White noise in -1..1, from an xorshift generator.
    fn noise(&mut self) -> f32 {
        let mut x = self.noise;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.noise = x;
        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    /// The line read `delay` samples behind the newest sample, between samples.
    fn read(line: &[f32], newest: usize, delay: f32) -> f32 {
        let length = line.len();
        let whole = delay.floor() as usize;
        let fraction = delay.fract();
        let at = (newest + length - whole) % length;
        let older = (at + length - 1) % length;
        line[at] * (1.0 - fraction) + line[older] * fraction
    }

    /// Soft saturation: the harder the drive, the sooner it rounds off.
    /// Quiet signals come up as loud ones come down, so turning it up
    /// changes the colour more than the level.
    fn saturate(x: f32, drive: f32) -> f32 {
        let hardness = 0.3 + 3.7 * drive;
        (hardness * x).tanh() / (hardness * hardness.tanh()).sqrt()
    }
}

impl StereoEffect for LoFi {
    type Settings = LoFiSettings;

    fn settings(&self) -> LoFiSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: LoFiSettings) {
        self.settings = settings;
    }

    fn settle(&mut self) {
        let LoFiSettings {
            wow,
            flutter,
            drive,
            tone_hz,
            ..
        } = self.settings;
        (self.wow, self.flutter, self.drive) = (wow, flutter, drive);
        self.cut = Self::cut(tone_hz, self.sample_rate);
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let LoFiSettings {
            wow,
            flutter,
            drive,
            hiss,
            mix,
            ..
        } = self.settings;
        let per_ms = self.sample_rate / 1_000.0;
        let length = self.left.len();
        let (wow_step, flutter_step) = (WOW_HZ / self.sample_rate, FLUTTER_HZ / self.sample_rate);
        let hiss = HISS_LEVEL * hiss * hiss;
        let cut = Self::cut(self.settings.tone_hz, self.sample_rate);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            self.wow = wow + self.smoothing * (self.wow - wow);
            self.flutter = flutter + self.smoothing * (self.flutter - flutter);
            self.drive = drive + self.smoothing * (self.drive - drive);
            self.cut = cut + self.smoothing * (self.cut - cut);

            self.left[self.write] = flush_denormal(*l);
            self.right[self.write] = flush_denormal(*r);
            // Flutter has a second, faster part, so it wavers rather than sings.
            let flutter_shape = 0.7 * (TAU * self.flutter_phase).sin()
                + 0.3 * (TAU * 2.7 * self.flutter_phase).sin();
            let swing = self.wow * WOW_MS * (TAU * self.wow_phase).sin()
                + self.flutter * FLUTTER_MS * flutter_shape;
            let delay = (CENTRE_MS + swing) * per_ms;
            let worn_left = Self::read(&self.left, self.write, delay);
            let worn_right = Self::read(&self.right, self.write, delay);
            self.write = (self.write + 1) % length;
            self.wow_phase = (self.wow_phase + wow_step).fract();
            self.flutter_phase = (self.flutter_phase + flutter_step).fract();

            let noise_left = self.noise();
            let noise_right = self.noise();
            let worn_left = Self::low_pass(
                &mut self.tone[0],
                self.cut,
                Self::saturate(worn_left, self.drive) + hiss * noise_left,
            );
            let worn_right = Self::low_pass(
                &mut self.tone[1],
                self.cut,
                Self::saturate(worn_right, self.drive) + hiss * noise_right,
            );

            *l = *l * (1.0 - mix) + worn_left * mix;
            *r = *r * (1.0 - mix) + worn_right * mix;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, rising_zero_crossings, rms, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> LoFiSettings {
        let mut settings = LoFiSettings::default();
        for (name, value) in changes {
            let param = LOFI_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    /// Everything off: no wobble, no noise, the tone wide open, barely driven.
    fn clean(changes: &[(&str, f32)]) -> LoFiSettings {
        let mut all = vec![
            ("wow", 0.0),
            ("flutter", 0.0),
            ("toneHz", 20_000.0),
            ("drive", 0.0),
            ("hiss", 0.0),
        ];
        all.extend_from_slice(changes);
        settings(&all)
    }

    fn run(lofi: &mut LoFi, left: &[f32], right: &[f32], chunk: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut left, mut right) = (left.to_vec(), right.to_vec());
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            lofi.process_stereo(l, r);
        }
        (left, right)
    }

    #[test]
    fn wow_bends_the_pitch_back_and_forth() {
        let input = sine(1_000.0, 0.3, RATE, 96_000);
        let (steady, _) = run(&mut LoFi::new(RATE, clean(&[])), &input, &input, 256);
        let (wobbly, _) = run(
            &mut LoFi::new(RATE, clean(&[("wow", 1.0)])),
            &input,
            &input,
            256,
        );
        // Cycles in each 100 ms: always 100 when clean, drifting with wow.
        let counts = |out: &[f32]| {
            out[4_800..]
                .chunks(4_800)
                .map(rising_zero_crossings)
                .collect::<Vec<_>>()
        };
        assert!(counts(&steady).iter().all(|&c| (99..=101).contains(&c)));
        let wobbly = counts(&wobbly);
        let (low, high) = (wobbly.iter().min().unwrap(), wobbly.iter().max().unwrap());
        assert!(high - low >= 1, "{wobbly:?}");
    }

    #[test]
    fn hiss_is_heard_over_silence_and_the_tone_darkens_it() {
        let silence = vec![0.0; 48_000];
        let (quiet, _) = run(&mut LoFi::new(RATE, clean(&[])), &silence, &silence, 512);
        assert!(peak(&quiet) == 0.0);

        let (bright, right) = run(
            &mut LoFi::new(RATE, clean(&[("hiss", 1.0)])),
            &silence,
            &silence,
            512,
        );
        let level = rms(&bright);
        assert!((0.01..0.03).contains(&level), "{level}");
        assert_ne!(bright, right, "each side hisses on its own");

        let (dark, _) = run(
            &mut LoFi::new(RATE, clean(&[("hiss", 1.0), ("toneHz", 500.0)])),
            &silence,
            &silence,
            512,
        );
        assert!(rms(&dark) < level / 3.0);
    }

    #[test]
    fn drive_rounds_off_loud_signals() {
        let input = sine(200.0, 0.9, RATE, 9_600);
        let (soft, _) = run(&mut LoFi::new(RATE, clean(&[])), &input, &input, 128);
        let (hard, _) = run(
            &mut LoFi::new(RATE, clean(&[("drive", 1.0)])),
            &input,
            &input,
            128,
        );
        let squareness = |out: &[f32]| rms(&out[2_000..]) / peak(&out[2_000..]);
        assert!((squareness(&soft) - 0.707).abs() < 0.01);
        assert!(squareness(&hard) > 0.8, "{}", squareness(&hard));
        assert!(peak(&hard[2_000..]) < 0.6);
    }

    #[test]
    fn no_mix_is_dry_and_any_chunking_is_the_same() {
        let input = sine(440.0, 0.5, RATE, 20_000);
        let (dry, _) = run(
            &mut LoFi::new(RATE, settings(&[("mix", 0.0)])),
            &input,
            &input,
            99,
        );
        assert_eq!(dry, input);

        let whole = run(&mut LoFi::new(RATE, settings(&[])), &input, &input, 20_000);
        let single = run(&mut LoFi::new(RATE, settings(&[])), &input, &input, 1);
        assert_eq!(whole, single);
    }

    #[test]
    fn extreme_settings_stay_finite() {
        let input = sine(8_000.0, 1.0, RATE, 48_000);
        let all = settings(&[
            ("wow", 1.0),
            ("flutter", 1.0),
            ("drive", 1.0),
            ("hiss", 1.0),
            ("toneHz", 20_000.0),
        ]);
        let mut lofi = LoFi::new(RATE, all);
        let (left, right) = run(&mut lofi, &input, &input, 17);
        lofi.set_settings(settings(&[("wow", 0.0), ("toneHz", 500.0)]));
        let (after, _) = run(&mut lofi, &input, &input, 17);
        for sample in left.iter().chain(&right).chain(&after) {
            assert!(sample.is_finite() && sample.abs() < 2.0, "{sample}");
        }
    }
}

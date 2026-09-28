//! The Saturator Effect: drive into a waveshaper, for warmth or grit.
//!
//! The signal is turned up by Drive and bent by one of four shapes: soft
//! (tanh, a gentle tape-like curve), hard (a clipper), tube (a lopsided curve
//! that adds even harmonics) and fold (a wavefolder, which folds peaks back
//! down instead of flattening them). A DC blocker takes out the offset the
//! tube's lopsided shape leaves, Tone is a one-pole high-cut that tames the
//! harmonics, and Output sets the level of what comes out. Mix blends it
//! with the dry signal, for parallel saturation.

use super::params::{Param, Settings, choice, number};
use crate::dsp::{db_to_gain, flush_denormal};

/// The shapes a Saturator offers, in the order its `shape` setting picks them.
pub const SATURATOR_SHAPES: &[&str] = &["soft", "hard", "tube", "fold"];

/// The corner of the DC blocker, well below anything heard.
const DC_BLOCK_HZ: f32 = 10.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SaturatorSettings {
    pub drive_db: f32,
    /// An index into `SATURATOR_SHAPES`.
    pub shape: usize,
    pub tone_hz: f32,
    pub output_db: f32,
    /// 0..=1: 0 is only the dry signal, 1 only the saturated one.
    pub mix: f32,
}

impl Default for SaturatorSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Saturator, in the order a host sends them.
#[rustfmt::skip]
pub const SATURATOR_PARAMS: &[Param<SaturatorSettings>] = &[
    number("driveDb", "Drive", "dB", (0.0, 36.0, 6.0),
        |s| s.drive_db, |s, v| s.drive_db = v),
    choice("shape", "Shape", SATURATOR_SHAPES, 0,
        |s| s.shape as f32, |s, v| s.shape = v as usize),
    number("toneHz", "Tone", "Hz", (500.0, 20_000.0, 12_000.0),
        |s| s.tone_hz, |s, v| s.tone_hz = v),
    number("outputDb", "Output", "dB", (-24.0, 12.0, 0.0),
        |s| s.output_db, |s, v| s.output_db = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for SaturatorSettings {
    const PARAMS: &'static [Param<Self>] = SATURATOR_PARAMS;

    fn zeroed() -> Self {
        Self {
            drive_db: 0.0,
            shape: 0,
            tone_hz: 0.0,
            output_db: 0.0,
            mix: 0.0,
        }
    }
}

/// `x` bent by the shape at `shape`. Every shape keeps its output within
/// -1..=1.
pub fn saturate(shape: usize, x: f32) -> f32 {
    match shape {
        1 => x.clamp(-1.0, 1.0),
        2 => {
            // Softer on the way down than up: the lopsided curve of a tube,
            // which is what gives it even harmonics.
            if x >= 0.0 {
                x.tanh()
            } else {
                0.8 * (1.25 * x).tanh()
            }
        }
        3 => {
            // Fold anything past ±1 back in, as often as it takes.
            let t = (x + 1.0).rem_euclid(4.0);
            if t < 2.0 { t - 1.0 } else { 3.0 - t }
        }
        _ => x.tanh(),
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Side {
    /// The DC blocker's last input and output.
    dc_in: f32,
    dc_out: f32,
    /// The tone filter's state.
    tone: f32,
}

#[derive(Clone, Debug)]
pub struct Saturator {
    sample_rate: f32,
    settings: SaturatorSettings,
    drive: f32,
    output: f32,
    tone: f32,
    dc: f32,
    sides: [Side; 2],
}

impl Saturator {
    pub fn new(sample_rate: f32, settings: SaturatorSettings) -> Self {
        let mut saturator = Self {
            sample_rate,
            settings,
            drive: 1.0,
            output: 1.0,
            tone: 1.0,
            dc: 1.0 - std::f32::consts::TAU * DC_BLOCK_HZ / sample_rate,
            sides: [Side::default(); 2],
        };
        saturator.set_settings(settings);
        saturator
    }

    pub fn settings(&self) -> SaturatorSettings {
        self.settings
    }

    pub fn set_settings(&mut self, settings: SaturatorSettings) {
        self.settings = settings;
        self.drive = db_to_gain(settings.drive_db);
        self.output = db_to_gain(settings.output_db);
        let corner = settings.tone_hz.min(0.49 * self.sample_rate);
        self.tone = 1.0 - (-std::f32::consts::TAU * corner / self.sample_rate).exp();
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let mix = self.settings.mix;
        for (buffer, side) in [left, right].into_iter().zip(self.sides.iter_mut()) {
            for sample in buffer.iter_mut() {
                let shaped = saturate(self.settings.shape, *sample * self.drive);
                side.dc_out = flush_denormal(shaped - side.dc_in + self.dc * side.dc_out);
                side.dc_in = shaped;
                // Only the lopsided tube leaves an offset; blocking it on the others
                // would tilt a clipped wave past full scale.
                let centred = if self.settings.shape == 2 {
                    side.dc_out
                } else {
                    shaped
                };
                side.tone = flush_denormal(side.tone + self.tone * (centred - side.tone));
                *sample = *sample * (1.0 - mix) + side.tone * self.output * mix;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, rms, sine};

    const RATE: f32 = 48_000.0;

    fn settings(changes: &[(&str, f32)]) -> SaturatorSettings {
        let mut settings = SaturatorSettings {
            tone_hz: 20_000.0,
            ..SaturatorSettings::default()
        };
        for (name, value) in changes {
            let param = SATURATOR_PARAMS.iter().find(|p| p.name == *name).unwrap();
            param.set(&mut settings, *value);
        }
        settings
    }

    fn run(settings: SaturatorSettings, input: &[f32]) -> Vec<f32> {
        let mut saturator = Saturator::new(RATE, settings);
        let mut left = input.to_vec();
        let mut right = input.to_vec();
        saturator.process_stereo(&mut left, &mut right);
        assert_eq!(left, right, "both sides alike");
        left
    }

    #[test]
    fn every_shape_stays_within_full_scale() {
        for shape in 0..SATURATOR_SHAPES.len() {
            for x in [-100.0, -3.3, -1.0, -0.2, 0.0, 0.4, 1.0, 2.5, 50.0] {
                let y = saturate(shape, x);
                assert!(y.abs() <= 1.0 + 1e-6, "shape {shape} at {x}: {y}");
            }
        }
        assert_eq!(saturate(3, 1.5), 0.5, "folded back from the top");
        assert_eq!(saturate(1, 3.0), 1.0, "clipped flat");
    }

    #[test]
    fn silence_stays_silent() {
        let out = run(settings(&[("driveDb", 36.0)]), &[0.0; 4_800]);
        assert!(out.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn a_hard_clip_flattens_a_loud_sine_and_the_output_sets_its_level() {
        let input = sine(100.0, 0.9, RATE, 48_000);
        let out = run(settings(&[("driveDb", 24.0), ("shape", 1.0)]), &input);
        let settled = &out[24_000..];
        assert!(
            peak(settled) < 1.05 && peak(settled) > 0.95,
            "{}",
            peak(settled)
        );
        // A squared-off sine is louder for its peak than the sine was.
        assert!(rms(settled) > 0.9 * peak(settled));

        let quieter = run(
            settings(&[("driveDb", 24.0), ("shape", 1.0), ("outputDb", -6.0)]),
            &input,
        );
        let ratio = rms(&quieter[24_000..]) / rms(settled);
        assert!((ratio - 0.501).abs() < 0.01, "{ratio}");
    }

    #[test]
    fn the_tube_shape_leaves_no_offset() {
        let out = run(
            settings(&[("driveDb", 18.0), ("shape", 2.0)]),
            &sine(200.0, 0.8, RATE, 96_000),
        );
        let settled = &out[48_000..];
        let mean = settled.iter().sum::<f32>() / settled.len() as f32;
        assert!(mean.abs() < 0.01, "{mean}");
    }

    #[test]
    fn the_tone_darkens_what_it_adds() {
        let input = sine(1_000.0, 0.9, RATE, 48_000);
        let bright = run(settings(&[("driveDb", 24.0), ("shape", 1.0)]), &input);
        let dark = run(
            settings(&[("driveDb", 24.0), ("shape", 1.0), ("toneHz", 1_000.0)]),
            &input,
        );
        assert!(rms(&dark[24_000..]) < 0.9 * rms(&bright[24_000..]));
    }

    #[test]
    fn no_mix_is_the_dry_signal() {
        let input = sine(440.0, 0.5, RATE, 4_800);
        let out = run(settings(&[("driveDb", 30.0), ("mix", 0.0)]), &input);
        assert_eq!(out, input);
    }
}

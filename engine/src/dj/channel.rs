//! One DJ mixer channel, as a DJM-V10's: trim, a four-band EQ that is
//! either EQ curves or an isolator, a one-knob compressor, a Colour FX
//! knob, a peak meter and a channel fader with a curve of its choice.
//!
//! The EQ splits the signal into four bands with Linkwitz-Riley crossovers
//! (two Butterworth sections each side of every split), which add back up
//! flat, and scales each band: in EQ mode down to -26 dB, in isolator mode
//! all the way to silence.

use super::colour::ColourFx;
use crate::dsp::{Biquad, db_to_gain};
use crate::effect::{Compressor, CompressorSettings};

const BUTTERWORTH_Q: f32 = std::f32::consts::FRAC_1_SQRT_2;
/// Where the four bands meet: low, low-mid, high-mid and high.
pub const SPLITS_HZ: [f32; 3] = [200.0, 1_000.0, 5_000.0];
/// The EQ knobs' range, in dB.
pub const EQ_MIN_DB: f32 = -26.0;
pub const EQ_MAX_DB: f32 = 6.0;

/// A Linkwitz-Riley split into what is below and above a frequency.
#[derive(Clone, Copy, Debug)]
struct Split {
    low: [Biquad; 2],
    high: [Biquad; 2],
}

impl Split {
    fn new(sample_rate: f32, frequency: f32) -> Self {
        let low = Biquad::low_pass(sample_rate, frequency, BUTTERWORTH_Q);
        let high = Biquad::high_pass(sample_rate, frequency, BUTTERWORTH_Q);
        Self {
            low: [low, low],
            high: [high, high],
        }
    }

    fn process(&mut self, x: f32) -> (f32, f32) {
        let low = self.low[0].process(x);
        let low = self.low[1].process(low);
        let high = self.high[0].process(x);
        let high = self.high[1].process(high);
        (low, high)
    }
}

/// The four-band EQ of one side.
#[derive(Clone, Copy, Debug)]
struct Bands {
    splits: [Split; 3],
}

impl Bands {
    fn new(sample_rate: f32) -> Self {
        Self {
            splits: SPLITS_HZ.map(|hz| Split::new(sample_rate, hz)),
        }
    }

    /// `x` with each band, low to high, scaled by `gains`.
    fn process(&mut self, x: f32, gains: [f32; 4]) -> f32 {
        let (low, rest) = self.splits[0].process(x);
        let (low_mid, rest) = self.splits[1].process(rest);
        let (high_mid, high) = self.splits[2].process(rest);
        low * gains[0] + low_mid * gains[1] + high_mid * gains[2] + high * gains[3]
    }
}

/// The shape of a channel fader's travel.
pub fn fader_gain(position: f32, curve: u8) -> f32 {
    let x = position.clamp(0.0, 1.0);
    match curve {
        // Sharp: fully open a little way up, for scratching.
        2 => (x * 8.0).min(1.0),
        // Linear.
        1 => x,
        // Smooth: slow at the bottom, as most mixes want.
        _ => x * x,
    }
}

#[derive(Debug)]
pub struct Channel {
    pub trim_db: f32,
    /// Low, low-mid, high-mid and high, in dB.
    pub eq_db: [f32; 4],
    /// 0 is off, 1 is the heaviest.
    pub compression: f32,
    compressor: Compressor,
    /// -1 to 1: left of centre one thing, right another; 0 is off.
    pub colour: f32,
    colour_fx: ColourFx,
    pub fader: f32,
    pub curve: u8,
    /// 0 is side A, 1 THRU (past the crossfader), 2 side B.
    pub assign: u8,
    pub cue: bool,
    bands: [Bands; 2],
    /// The loudest sample before the fader, as a mixer's channel meter
    /// shows it.
    pub peak: f32,
}

impl Channel {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            trim_db: 0.0,
            eq_db: [0.0; 4],
            compression: 0.0,
            compressor: Compressor::new(sample_rate, CompressorSettings::default()),
            colour: 0.0,
            colour_fx: ColourFx::new(sample_rate),
            fader: 1.0,
            curve: 0,
            assign: 1,
            cue: false,
            bands: [Bands::new(sample_rate), Bands::new(sample_rate)],
            peak: 0.0,
        }
    }

    /// The gains of the four bands: `isolator` lets the bottom of each
    /// knob take its band out altogether.
    pub fn band_gains(&self, isolator: bool) -> [f32; 4] {
        self.eq_db.map(|db| {
            let db = db.clamp(EQ_MIN_DB, EQ_MAX_DB);
            if isolator && db <= EQ_MIN_DB + 0.01 {
                0.0
            } else {
                db_to_gain(db)
            }
        })
    }

    pub fn set_compression(&mut self, amount: f32) {
        self.compression = amount.clamp(0.0, 1.0);
        let a = self.compression;
        let threshold_db = -6.0 - 24.0 * a;
        let ratio = 1.0 + 7.0 * a;
        self.compressor.set_settings(CompressorSettings {
            threshold_db,
            ratio,
            attack: 3.0,
            release: 120.0,
            // Most of what it takes off, given back.
            makeup_db: -threshold_db * (1.0 - 1.0 / ratio) * 0.5,
            knee_db: 6.0,
        });
    }

    /// Run the Deck's sound in `left` and `right` through the channel, up
    /// to the fader: trim, EQ, compressor and Colour FX. Meters it.
    pub fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        isolator: bool,
        colour: (u8, f32),
        bpm: f64,
    ) {
        let trim = db_to_gain(self.trim_db.clamp(-24.0, 12.0));
        let gains = self.band_gains(isolator);
        let flat = gains.iter().all(|&g| (g - 1.0).abs() < 1e-6);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let (x, y) = (*l * trim, *r * trim);
            if flat {
                // The crossovers still run, so their state is ready.
                let _ = self.bands[0].process(x, gains);
                let _ = self.bands[1].process(y, gains);
                *l = x;
                *r = y;
            } else {
                *l = self.bands[0].process(x, gains);
                *r = self.bands[1].process(y, gains);
            }
        }
        if self.compression > 0.0 {
            self.compressor.process_stereo(left, right);
        }
        self.colour_fx
            .process(left, right, colour.0, self.colour, colour.1, bpm);
        let mut peak = 0.0f32;
        for (l, r) in left.iter().zip(right.iter()) {
            peak = peak.max(l.abs()).max(r.abs());
        }
        self.peak = peak;
    }

    /// The fader's gain, on its curve.
    pub fn gain(&self) -> f32 {
        fader_gain(self.fader, self.curve)
    }

    pub fn gain_reduction_db(&self) -> f32 {
        if self.compression > 0.0 {
            self.compressor.meter_db()
        } else {
            0.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rms, sine};

    const RATE: f32 = 48_000.0;

    fn level_through(channel: &mut Channel, frequency: f32, isolator: bool) -> f32 {
        let tone = sine(frequency, 0.5, RATE, 48_000);
        let (mut left, mut right) = (tone.clone(), tone);
        channel.process(&mut left, &mut right, isolator, (5, 0.0), 120.0);
        rms(&left[24_000..]) / rms(&sine(frequency, 0.5, RATE, 24_000))
    }

    #[test]
    fn a_flat_eq_leaves_the_sound_alone() {
        let mut channel = Channel::new(RATE);
        for hz in [60.0, 500.0, 2_500.0, 10_000.0] {
            let gain = level_through(&mut channel, hz, false);
            assert!((gain - 1.0).abs() < 0.02, "{hz} Hz: {gain}");
        }
    }

    #[test]
    fn the_isolator_kills_a_band_and_the_eq_only_turns_it_down() {
        let mut channel = Channel::new(RATE);
        channel.eq_db[0] = EQ_MIN_DB;
        let eq = level_through(&mut channel, 50.0, false);
        let mut channel = Channel::new(RATE);
        channel.eq_db[0] = EQ_MIN_DB;
        let killed = level_through(&mut channel, 50.0, true);
        assert!(eq > 0.03 && eq < 0.12, "EQ at the bottom: {eq}");
        assert!(killed < 0.03, "isolator at the bottom: {killed}");
        let mut channel = Channel::new(RATE);
        channel.eq_db[0] = EQ_MIN_DB;
        assert!(
            level_through(&mut channel, 8_000.0, true) > 0.9,
            "the highs stay"
        );
    }

    #[test]
    fn trim_scales_and_the_meter_reads_before_the_fader() {
        let mut channel = Channel::new(RATE);
        channel.trim_db = 6.0;
        channel.fader = 0.0;
        let tone = sine(1_000.0, 0.25, RATE, 4_800);
        let (mut left, mut right) = (tone.clone(), tone);
        channel.process(&mut left, &mut right, false, (5, 0.0), 120.0);
        assert!((channel.peak - 0.5).abs() < 0.02, "{}", channel.peak);
        assert_eq!(channel.gain(), 0.0);
    }

    #[test]
    fn fader_curves() {
        assert_eq!(fader_gain(0.5, 0), 0.25);
        assert_eq!(fader_gain(0.5, 1), 0.5);
        assert_eq!(fader_gain(0.2, 2), 1.0);
        assert_eq!(fader_gain(1.5, 1), 1.0);
    }

    #[test]
    fn the_compressor_knob_turns_loud_parts_down() {
        let mut channel = Channel::new(RATE);
        channel.set_compression(1.0);
        let tone = sine(200.0, 0.9, RATE, 24_000);
        let (mut left, mut right) = (tone.clone(), tone);
        channel.process(&mut left, &mut right, false, (5, 0.0), 120.0);
        assert!(channel.gain_reduction_db() > 3.0);
    }
}

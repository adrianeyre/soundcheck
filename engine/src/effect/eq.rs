//! The EQ Effect: a low cut, a low shelf, three bells, a high shelf and a
//! high cut, in that order.
//!
//! The cuts are 12 dB per octave (one Butterworth biquad each) and are off
//! until switched on. The shelves and bells are flat by default, so an EQ
//! that has just been added changes nothing until a setting does.

use super::params::{Param, Settings, number, switch};
use crate::dsp::Biquad;

/// How many bells the EQ has between its shelves.
pub const EQ_BANDS: usize = 3;

/// The filters in the order the signal meets them: low cut, low shelf, the
/// bells, high shelf, high cut.
const FILTERS: usize = EQ_BANDS + 4;

const BUTTERWORTH_Q: f32 = std::f32::consts::FRAC_1_SQRT_2;

/// One bell: a boost or cut of `gain_db` around `frequency`, `q` wide.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EqBand {
    pub frequency: f32,
    pub q: f32,
    pub gain_db: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EqSettings {
    pub low_cut: bool,
    pub low_cut_frequency: f32,
    pub low_shelf_frequency: f32,
    pub low_shelf_gain_db: f32,
    pub bands: [EqBand; EQ_BANDS],
    pub high_shelf_frequency: f32,
    pub high_shelf_gain_db: f32,
    pub high_cut: bool,
    pub high_cut_frequency: f32,
}

const FREQUENCY: (f32, f32) = (20.0, 20_000.0);
const GAIN: (f32, f32, f32) = (-24.0, 24.0, 0.0);
const Q: (f32, f32, f32) = (0.1, 18.0, 1.0);

const fn hz(default: f32) -> (f32, f32, f32) {
    (FREQUENCY.0, FREQUENCY.1, default)
}

/// The three settings of bell `$n`, which is `bands[$index]`.
macro_rules! band {
    ($index:literal, $n:literal, $hz:expr) => {
        [
            number(
                concat!("band", $n, "Hz"),
                concat!("Band ", $n, " frequency"),
                "Hz",
                hz($hz),
                |s| s.bands[$index].frequency,
                |s, v| s.bands[$index].frequency = v,
            ),
            number(
                concat!("band", $n, "Q"),
                concat!("Band ", $n, " Q"),
                "Q",
                Q,
                |s| s.bands[$index].q,
                |s, v| s.bands[$index].q = v,
            ),
            number(
                concat!("band", $n, "GainDb"),
                concat!("Band ", $n, " gain"),
                "dB",
                GAIN,
                |s| s.bands[$index].gain_db,
                |s, v| s.bands[$index].gain_db = v,
            ),
        ]
    };
}

const BAND_1: [Param<EqSettings>; 3] = band!(0, "1", 250.0);
const BAND_2: [Param<EqSettings>; 3] = band!(1, "2", 1_000.0);
const BAND_3: [Param<EqSettings>; 3] = band!(2, "3", 4_000.0);

/// Every setting of the EQ, in the order a host sends them.
#[rustfmt::skip]
pub const EQ_PARAMS: &[Param<EqSettings>] = &[
    switch("lowCut", "Low cut", false,
        |s| f32::from(u8::from(s.low_cut)), |s, v| s.low_cut = v >= 0.5),
    number("lowCutHz", "Low cut frequency", "Hz", hz(30.0),
        |s| s.low_cut_frequency, |s, v| s.low_cut_frequency = v),
    number("lowShelfHz", "Low shelf frequency", "Hz", hz(100.0),
        |s| s.low_shelf_frequency, |s, v| s.low_shelf_frequency = v),
    number("lowShelfGainDb", "Low shelf gain", "dB", GAIN,
        |s| s.low_shelf_gain_db, |s, v| s.low_shelf_gain_db = v),
    BAND_1[0], BAND_1[1], BAND_1[2],
    BAND_2[0], BAND_2[1], BAND_2[2],
    BAND_3[0], BAND_3[1], BAND_3[2],
    number("highShelfHz", "High shelf frequency", "Hz", hz(8_000.0),
        |s| s.high_shelf_frequency, |s, v| s.high_shelf_frequency = v),
    number("highShelfGainDb", "High shelf gain", "dB", GAIN,
        |s| s.high_shelf_gain_db, |s, v| s.high_shelf_gain_db = v),
    switch("highCut", "High cut", false,
        |s| f32::from(u8::from(s.high_cut)), |s, v| s.high_cut = v >= 0.5),
    number("highCutHz", "High cut frequency", "Hz", hz(18_000.0),
        |s| s.high_cut_frequency, |s, v| s.high_cut_frequency = v),
];

impl Settings for EqSettings {
    const PARAMS: &'static [Param<Self>] = EQ_PARAMS;

    fn zeroed() -> Self {
        let band = EqBand {
            frequency: 0.0,
            q: 0.0,
            gain_db: 0.0,
        };
        Self {
            low_cut: false,
            low_cut_frequency: 0.0,
            low_shelf_frequency: 0.0,
            low_shelf_gain_db: 0.0,
            bands: [band; EQ_BANDS],
            high_shelf_frequency: 0.0,
            high_shelf_gain_db: 0.0,
            high_cut: false,
            high_cut_frequency: 0.0,
        }
    }
}

impl Default for EqSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// The filters `settings` asks for, in signal order, each with whether it
/// does anything: a cut that is off or a shelf or bell at 0 dB is skipped.
fn design(sample_rate: f32, s: &EqSettings) -> [(Biquad, bool); FILTERS] {
    let bell = |band: &EqBand| {
        (
            Biquad::peaking(sample_rate, band.frequency, band.q, band.gain_db),
            band.gain_db != 0.0,
        )
    };
    [
        (
            Biquad::high_pass(sample_rate, s.low_cut_frequency, BUTTERWORTH_Q),
            s.low_cut,
        ),
        (
            Biquad::low_shelf(sample_rate, s.low_shelf_frequency, s.low_shelf_gain_db),
            s.low_shelf_gain_db != 0.0,
        ),
        bell(&s.bands[0]),
        bell(&s.bands[1]),
        bell(&s.bands[2]),
        (
            Biquad::high_shelf(sample_rate, s.high_shelf_frequency, s.high_shelf_gain_db),
            s.high_shelf_gain_db != 0.0,
        ),
        (
            Biquad::low_pass(sample_rate, s.high_cut_frequency, BUTTERWORTH_Q),
            s.high_cut,
        ),
    ]
}

/// How much the EQ scales a sine at `frequency`, in dB, worked out from the
/// filters' coefficients: what the frequency-response display draws.
pub fn eq_response_db(sample_rate: f32, settings: &EqSettings, frequency: f32) -> f32 {
    let gain: f32 = design(sample_rate, settings)
        .iter()
        .filter(|(_, active)| *active)
        .map(|(filter, _)| filter.magnitude(sample_rate, frequency))
        .product();
    20.0 * gain.max(1e-10).log10()
}

/// A stereo EQ: the same filters on both sides, each with its own memory.
#[derive(Clone, Debug)]
pub struct Eq {
    sample_rate: f32,
    settings: EqSettings,
    filters: [[Biquad; FILTERS]; 2],
    active: [bool; FILTERS],
}

impl Eq {
    pub fn new(sample_rate: f32, settings: EqSettings) -> Self {
        let designed = design(sample_rate, &settings);
        let filters = designed.map(|(filter, _)| filter);
        Self {
            sample_rate,
            settings,
            filters: [filters, filters],
            active: designed.map(|(_, active)| active),
        }
    }

    pub fn settings(&self) -> EqSettings {
        self.settings
    }

    /// Change the settings while running. A filter that was already working
    /// carries on from its memory, so the sound doesn't click; one that
    /// comes back on starts from silence.
    pub fn set_settings(&mut self, settings: EqSettings) {
        let designed = design(self.sample_rate, &settings);
        for side in &mut self.filters {
            for (index, (filter, _)) in designed.iter().enumerate() {
                let mut filter = *filter;
                if self.active[index] {
                    filter.restore_state(&side[index]);
                }
                side[index] = filter;
            }
        }
        self.active = designed.map(|(_, active)| active);
        self.settings = settings;
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (side, buffer) in self.filters.iter_mut().zip([left, right]) {
            for (filter, _) in side.iter_mut().zip(&self.active).filter(|(_, a)| **a) {
                filter.process_buffer(buffer);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::gain_to_db;
    use crate::dsp::measure::{rms, sine};

    const RATE: f32 = 48_000.0;

    /// The gain in dB an EQ gives a sine at `frequency`, measured by
    /// filtering one and comparing levels once the filters have settled.
    fn measured_db(settings: EqSettings, frequency: f32) -> f32 {
        let mut eq = Eq::new(RATE, settings);
        let mut left = sine(frequency, 0.5, RATE, 48_000);
        let mut right = left.clone();
        let before = rms(&left[24_000..]);
        eq.process_stereo(&mut left, &mut right);
        assert_eq!(left, right, "both sides are filtered alike");
        gain_to_db(rms(&left[24_000..]) / before)
    }

    /// A sweep of sines from 30 Hz to 15 kHz, a third of an octave apart.
    fn sweep() -> impl Iterator<Item = f32> {
        (0..28).map(|step| 30.0 * 2f32.powf(step as f32 / 3.0))
    }

    fn every_band_busy() -> EqSettings {
        let mut settings = EqSettings::default();
        for (name, value) in [
            ("lowCut", 1.0),
            ("lowCutHz", 40.0),
            ("lowShelfHz", 120.0),
            ("lowShelfGainDb", 4.0),
            ("band1Hz", 300.0),
            ("band1Q", 2.0),
            ("band1GainDb", -6.0),
            ("band2Hz", 1_200.0),
            ("band2Q", 0.7),
            ("band2GainDb", 5.0),
            ("band3Hz", 3_500.0),
            ("band3Q", 4.0),
            ("band3GainDb", -9.0),
            ("highShelfHz", 7_000.0),
            ("highShelfGainDb", 3.0),
            ("highCut", 1.0),
            ("highCutHz", 12_000.0),
        ] {
            let param = EQ_PARAMS.iter().find(|p| p.name == name).unwrap();
            param.set(&mut settings, value);
        }
        settings
    }

    #[test]
    fn the_defaults_change_nothing() {
        for frequency in sweep() {
            let db = measured_db(EqSettings::default(), frequency);
            assert!(db.abs() < 0.01, "{frequency} Hz: {db} dB");
        }
    }

    #[test]
    fn a_sine_sweep_matches_the_response_the_settings_give() {
        let settings = every_band_busy();
        for frequency in sweep() {
            let expected = eq_response_db(RATE, &settings, frequency);
            let measured = measured_db(settings, frequency);
            assert!(
                (measured - expected).abs() < 0.1,
                "{frequency} Hz: measured {measured} dB, expected {expected} dB"
            );
        }
    }

    #[test]
    fn the_response_is_what_each_setting_asks_for() {
        let settings = every_band_busy();
        let at = |frequency| eq_response_db(RATE, &settings, frequency);
        // A bell reaches its gain at its centre, give or take its
        // neighbours' skirts.
        assert!((at(300.0) - -6.0).abs() < 1.5, "band 1: {}", at(300.0));
        assert!((at(1_200.0) - 5.0).abs() < 1.5, "band 2: {}", at(1_200.0));
        assert!((at(3_500.0) - -9.0).abs() < 1.5, "band 3: {}", at(3_500.0));
        // A Butterworth cut is 3 dB down at its frequency, and falls away
        // past it at 12 dB an octave.
        let low_cut = EqSettings {
            low_cut: true,
            low_cut_frequency: 200.0,
            ..EqSettings::default()
        };
        assert!((eq_response_db(RATE, &low_cut, 200.0) - -3.01).abs() < 0.05);
        assert!((eq_response_db(RATE, &low_cut, 50.0) - -24.0).abs() < 0.5);
        let high_cut = EqSettings {
            high_cut: true,
            high_cut_frequency: 2_000.0,
            ..EqSettings::default()
        };
        assert!((eq_response_db(RATE, &high_cut, 2_000.0) - -3.01).abs() < 0.05);
        assert!(eq_response_db(RATE, &high_cut, 8_000.0) < -22.0);
        // Shelves reach their gain well past their frequency.
        let shelves = EqSettings {
            low_shelf_gain_db: 6.0,
            high_shelf_gain_db: -6.0,
            ..EqSettings::default()
        };
        assert!((eq_response_db(RATE, &shelves, 25.0) - 6.0).abs() < 0.2);
        assert!((eq_response_db(RATE, &shelves, 19_000.0) - -6.0).abs() < 0.3);
    }

    #[test]
    fn changing_settings_while_running_does_not_click() {
        let mut eq = Eq::new(RATE, every_band_busy());
        let mut left = sine(440.0, 0.5, RATE, 9_600);
        let mut right = left.clone();
        let (first_l, second_l) = left.split_at_mut(4_800);
        let (first_r, second_r) = right.split_at_mut(4_800);
        eq.process_stereo(first_l, first_r);
        eq.set_settings(EqSettings {
            low_shelf_gain_db: -2.0,
            ..every_band_busy()
        });
        eq.process_stereo(second_l, second_r);
        assert!(crate::dsp::measure::max_jump(&left) < 0.1);
    }

    #[test]
    fn the_flat_form_round_trips_and_clamps() {
        let settings = every_band_busy();
        assert_eq!(EqSettings::from_flat(&settings.to_flat()), settings);
        let wild = EqSettings::from_flat(&[5.0, 1.0, 99_999.0, -100.0]);
        assert!(wild.low_cut);
        assert_eq!(wild.low_cut_frequency, 20.0);
        assert_eq!(wild.low_shelf_frequency, 20_000.0);
        assert_eq!(wild.low_shelf_gain_db, -24.0);
        assert_eq!(wild.bands, EqSettings::default().bands, "the rest default");
    }
}

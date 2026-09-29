//! A mixer channel's EQ: four knobs, low, low-mid, high-mid and high, on
//! every Track, Bus and the Master, as a console's channel strip has. It
//! comes after the Insert Chain and before the fader and the pan.
//!
//! It is the DJ Mixer's four-band EQ (`dsp::FourBand`), meeting at the same
//! frequencies, each band turned from -12 to +12 dB. Flat, it is not there:
//! the sound passes untouched and costs nothing. Turned, it fades in over a
//! few milliseconds, and every gain glides to where it is set, so moving a
//! knob never clicks.

use crate::automation::Line;
use crate::dsp::{FourBand, db_to_gain};

/// The bands' names, low to high, as the host and Automation name them.
pub const EQ_BANDS: [&str; 4] = ["low", "lowMid", "highMid", "high"];
/// How far each band turns either way, in dB.
pub const EQ_RANGE_DB: f32 = 12.0;
/// Where the bands meet, as the DJ Mixer's do.
pub const EQ_SPLITS_HZ: [f32; 3] = [200.0, 1_000.0, 5_000.0];
/// How quickly a gain follows its knob: the time constant of its glide.
const GLIDE_SECONDS: f32 = 0.01;
/// Close enough to flat to stop processing.
const SETTLED: f32 = 1e-5;
/// Close enough for a gain to jump the rest of the way to its target: a
/// step of -80 dB of the signal, and more than a float near 1 can glide.
const SNAP: f32 = 1e-4;

#[derive(Clone, Debug)]
pub struct ChannelEq {
    sample_rate: f32,
    /// Left and right.
    bands: [FourBand; 2],
    /// Each band's gain in dB, as the host set it.
    db: [f32; 4],
    /// Each band's linear gain as it glides to its target.
    gains: [f32; 4],
    /// How much of the EQ is heard: 0 is the dry sound, untouched; it fades
    /// to 1 as soon as a band is off 0 dB, and back once they all are.
    wet: f32,
    /// How far a gain moves toward its target each frame.
    glide: f32,
}

impl Default for ChannelEq {
    fn default() -> Self {
        Self::new(48_000.0)
    }
}

impl ChannelEq {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            bands: [FourBand::new(sample_rate, EQ_SPLITS_HZ); 2],
            db: [0.0; 4],
            gains: [1.0; 4],
            wet: 0.0,
            glide: 1.0 - (-1.0 / (GLIDE_SECONDS * sample_rate)).exp(),
        }
    }

    /// Run at `sample_rate`, keeping the knobs where they are. Allocates
    /// nothing.
    pub fn set_sample_rate(&mut self, sample_rate: f32) {
        if sample_rate != self.sample_rate && sample_rate > 0.0 {
            *self = Self {
                db: self.db,
                ..Self::new(sample_rate)
            };
        }
    }

    /// Set the bands, low to high, in dB, clamped to ±`EQ_RANGE_DB`. A
    /// value that isn't a number leaves its band as it was.
    pub fn set(&mut self, db: [f32; 4]) {
        for (band, value) in self.db.iter_mut().zip(db) {
            if value.is_finite() {
                *band = value.clamp(-EQ_RANGE_DB, EQ_RANGE_DB);
            }
        }
    }

    /// The bands, low to high, in dB, as they were set.
    pub fn db(&self) -> [f32; 4] {
        self.db
    }

    /// Run `left` and `right` through the EQ in place. `lines` are the
    /// bands' Automation over `ticks`, which says where in the song each
    /// frame is: an automated band follows its line, the rest keep what
    /// they were set to. Without ticks, every band keeps its fixed value.
    /// Allocates nothing.
    pub fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        lines: [Option<Line>; 4],
        ticks: &[f64],
    ) {
        let frames = left.len().min(right.len());
        let lines = if ticks.len() == frames {
            lines
        } else {
            [None; 4]
        };
        let db_at = |band: usize, frame: usize| match lines[band] {
            Some(line) if line.is_steady() => line.at(0.0),
            Some(line) => line.at(ticks[frame]),
            None => self.db[band],
        };
        let ramping = lines
            .iter()
            .any(|line| line.is_some_and(|l| !l.is_steady()));
        let mut target = [0, 1, 2, 3].map(|band| gain_of(db_at(band, 0)));
        let mut flat = target == [1.0; 4];
        if flat && !ramping && self.wet == 0.0 {
            return;
        }
        for frame in 0..frames {
            if ramping && frame > 0 {
                target = [0, 1, 2, 3].map(|band| gain_of(db_at(band, frame)));
                flat = target == [1.0; 4];
            }
            if flat && self.settled() {
                // Back to the dry sound, which the rest of the block keeps.
                self.wet = 0.0;
                self.gains = [1.0; 4];
                for bands in &mut self.bands {
                    bands.reset();
                }
                if !ramping {
                    return;
                }
                continue;
            }
            for (gain, target) in self.gains.iter_mut().zip(target) {
                // Snapped at the end, where a float's steps are coarser
                // than what is left of the glide.
                let gap = target - *gain;
                *gain = if gap.abs() < SNAP {
                    target
                } else {
                    *gain + gap * self.glide
                };
            }
            let wet_target = if flat { 0.0 } else { 1.0 };
            let gap = wet_target - self.wet;
            self.wet = if flat || gap.abs() >= SNAP {
                self.wet + gap * self.glide
            } else {
                wet_target
            };
            let (l, r) = (left[frame], right[frame]);
            let eq_l = self.bands[0].process(l, self.gains);
            let eq_r = self.bands[1].process(r, self.gains);
            left[frame] = l + self.wet * (eq_l - l);
            right[frame] = r + self.wet * (eq_r - r);
        }
    }

    /// Whether it has faded out and every gain is back at unity, so the dry
    /// sound can take over without a step.
    fn settled(&self) -> bool {
        self.wet < SETTLED && self.gains.iter().all(|g| (g - 1.0).abs() < SETTLED)
    }
}

/// A band's linear gain, exactly 1 at 0 dB.
fn gain_of(db: f32) -> f32 {
    if db == 0.0 {
        1.0
    } else {
        db_to_gain(db.clamp(-EQ_RANGE_DB, EQ_RANGE_DB))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{max_jump, rms, sine};

    const RATE: f32 = 48_000.0;

    /// A second of a sine through an EQ set to `db`, and how much louder or
    /// quieter its second half comes out, in dB.
    fn change_db(frequency: f32, db: [f32; 4]) -> f32 {
        let mut eq = ChannelEq::new(RATE);
        eq.set(db);
        let tone = sine(frequency, 0.25, RATE, 48_000);
        let (mut left, mut right) = (tone.clone(), tone.clone());
        eq.process(&mut left, &mut right, [None; 4], &[]);
        20.0 * (rms(&left[24_000..]) / rms(&tone[24_000..])).log10()
    }

    #[test]
    fn flat_it_leaves_every_sample_exactly_as_it_was() {
        let mut eq = ChannelEq::new(RATE);
        let tone = sine(440.0, 0.5, RATE, 4_800);
        let (mut left, mut right) = (tone.clone(), tone.clone());
        eq.process(&mut left, &mut right, [None; 4], &[]);
        assert_eq!(left, tone);
        assert_eq!(right, tone);
    }

    #[test]
    fn turned_back_to_flat_it_returns_to_the_exact_dry_sound() {
        let mut eq = ChannelEq::new(RATE);
        eq.set([6.0, 0.0, 0.0, 0.0]);
        let tone = sine(100.0, 0.5, RATE, 9_600);
        let (mut left, mut right) = (tone.clone(), tone.clone());
        eq.process(&mut left, &mut right, [None; 4], &[]);
        eq.set([0.0; 4]);
        let (mut left, mut right) = (tone.clone(), tone.clone());
        eq.process(&mut left, &mut right, [None; 4], &[]);
        assert_eq!(left[7_200..], tone[7_200..], "settled back to dry");
        assert_eq!(eq.wet, 0.0);
    }

    #[test]
    fn each_band_boosts_and_cuts_its_own_region() {
        let regions = [60.0, 450.0, 2_200.0, 12_000.0];
        for (band, &hz) in regions.iter().enumerate() {
            let mut db = [0.0; 4];
            db[band] = 12.0;
            let boost = change_db(hz, db);
            assert!(
                (boost - 12.0).abs() < 2.5,
                "band {band} boost at {hz} Hz: {boost}"
            );
            db[band] = -12.0;
            let cut = change_db(hz, db);
            assert!(
                (cut + 12.0).abs() < 2.5,
                "band {band} cut at {hz} Hz: {cut}"
            );
            // Two bands away, it is left alone.
            let far = regions[(band + 2) % 4];
            let elsewhere = change_db(far, db);
            assert!(
                elsewhere.abs() < 1.5,
                "band {band} at {far} Hz: {elsewhere}"
            );
        }
    }

    #[test]
    fn a_turned_band_with_the_rest_at_unity_is_flat_elsewhere() {
        let db = change_db(10_000.0, [0.001, 0.0, 0.0, 0.0]);
        assert!(db.abs() < 0.01, "{db}");
    }

    #[test]
    fn moving_a_knob_does_not_click() {
        let tone = sine(80.0, 0.5, RATE, 9_600);
        let steady = max_jump(&tone);
        let mut eq = ChannelEq::new(RATE);
        let (mut left, mut right) = (tone.clone(), tone.clone());
        let (first_l, rest_l) = left.split_at_mut(4_800);
        let (first_r, rest_r) = right.split_at_mut(4_800);
        eq.process(first_l, first_r, [None; 4], &[]);
        eq.set([-12.0, 12.0, 12.0, 12.0]);
        eq.process(rest_l, rest_r, [None; 4], &[]);
        let jump = max_jump(&left[4_700..5_200]);
        assert!(jump < steady * 1.5, "{jump} against {steady}");
    }

    #[test]
    fn a_band_follows_its_automation() {
        let mut eq = ChannelEq::new(RATE);
        let tone = sine(60.0, 0.25, RATE, 24_000);
        let (mut left, mut right) = (tone.clone(), tone.clone());
        let ticks = vec![0.0; 24_000];
        let lines = [Some(Line::steady(-12.0)), None, None, None];
        eq.process(&mut left, &mut right, lines, &ticks);
        let db = 20.0 * (rms(&left[12_000..]) / rms(&tone[12_000..])).log10();
        assert!((db + 12.0).abs() < 2.5, "{db}");
        assert_eq!(eq.db(), [0.0; 4], "its fixed value stays");
    }

    #[test]
    fn values_are_clamped_and_nan_is_ignored() {
        let mut eq = ChannelEq::new(RATE);
        eq.set([40.0, -40.0, f32::NAN, 3.0]);
        assert_eq!(eq.db(), [12.0, -12.0, 0.0, 3.0]);
    }
}

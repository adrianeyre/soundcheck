//! What a built-in Effect that works on the stereo signal in place implements,
//! so the Insert Chain runs it without a case of its own for each: every
//! setting, the flat form and Automation come from its settings table.

use std::fmt::Debug;

use super::params::Settings;
use crate::transport::TICKS_PER_BEAT;

/// A built-in Effect that works on both sides in place.
pub trait StereoEffect: Debug + Send + 'static {
    type Settings: Settings + Copy;

    fn settings(&self) -> Self::Settings;

    fn set_settings(&mut self, settings: Self::Settings);

    /// The song's tempo where it is playing, in quarter notes per minute,
    /// for an Effect synced to it. Allocates nothing.
    fn set_tempo(&mut self, _tempo: f64) {}

    /// Jump every smoothed value to where the settings put it, so a freshly
    /// made Effect starts at the Project's settings instead of gliding there
    /// from its defaults. The chain calls it whenever it sets the settings
    /// of an Effect that hasn't processed a block yet, and once more as the
    /// first block starts, after Automation has placed its settings; later
    /// changes glide as ever. Allocates nothing.
    fn settle(&mut self) {}

    /// Process both sides in place. Allocates nothing.
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]);

    /// `process_stereo`, knowing where in the song each frame is: `ticks`
    /// has one per frame while the song is moving, and is empty while it is
    /// stopped or when the chain wasn't told. An Effect synced to the song
    /// lines itself up with it (see `SongPosition`); the rest ignore it.
    /// Allocates nothing.
    fn process_stereo_at(&mut self, left: &mut [f32], right: &mut [f32], _ticks: &[f64]) {
        self.process_stereo(left, right);
    }
}

/// Follows where the song is, frame by frame, for an Effect synced to it:
/// while the song moves, the Effect takes its phase from the song's
/// position, so its pulse lands on the beat; while it is stopped, or when
/// the chain doesn't say where it is, the Effect runs free from wherever
/// it got to.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct SongPosition {
    /// The tick of the frame before, if the song was moving there.
    last: Option<f64>,
}

impl SongPosition {
    /// Where frame `frame` of a block is in the song, when it is moving:
    /// `ticks` is the block's, one per frame while the song moves, and empty
    /// when it doesn't. Call it for every frame, in order.
    pub(super) fn step(&mut self, ticks: &[f64], frame: usize) -> Option<Moved> {
        let Some(&tick) = ticks.get(frame) else {
            self.last = None;
            return None;
        };
        // Just started, it came from nowhere: only a cycle that starts
        // exactly here starts on this frame.
        let from = self.last.replace(tick).unwrap_or(tick);
        Some(Moved {
            from: from / TICKS_PER_BEAT as f64,
            to: tick / TICKS_PER_BEAT as f64,
        })
    }
}

/// Where the song moved between two frames, in quarter notes.
#[derive(Clone, Copy, Debug)]
pub(super) struct Moved {
    pub from: f64,
    pub to: f64,
}

impl Moved {
    /// How far through a cycle `quarters` long, counted from the start of
    /// the song, the song is now: 0..1.
    pub(super) fn phase(self, quarters: f64) -> f64 {
        (self.to / quarters).rem_euclid(1.0)
    }

    /// Whether this is the first frame at or after the start of a cycle
    /// `quarters` long, counted from the start of the song. A playhead that
    /// jumped back is only on one if it landed exactly on it.
    pub(super) fn crossed(self, quarters: f64) -> bool {
        let (from, to) = (self.from / quarters, self.to / quarters);
        to.fract() == 0.0 || (to > from && to.floor() > from.floor())
    }
}

/// A `StereoEffect` as the chain holds it, whatever its settings' type.
pub(super) trait InPlace: Debug + Send {
    fn get(&self, index: usize) -> f32;
    /// Set the setting at `index`, as its table clamps and rounds it, if that
    /// changes it. Allocates nothing.
    fn set(&mut self, index: usize, value: f32);
    fn set_flat(&mut self, values: &[f32]);
    fn set_tempo(&mut self, tempo: f64);
    fn settle(&mut self);
    /// `ticks` is one per frame while the song moves, or empty.
    fn process(&mut self, left: &mut [f32], right: &mut [f32], ticks: &[f64]);
}

impl<T: StereoEffect> InPlace for T {
    fn get(&self, index: usize) -> f32 {
        T::Settings::PARAMS[index].get(&self.settings())
    }

    fn set(&mut self, index: usize, value: f32) {
        let param = T::Settings::PARAMS[index];
        let settings = self.settings();
        let mut next = settings;
        param.set(&mut next, value);
        if param.get(&next) != param.get(&settings) {
            self.set_settings(next);
        }
    }

    fn set_flat(&mut self, values: &[f32]) {
        self.set_settings(T::Settings::from_flat(values));
    }

    fn set_tempo(&mut self, tempo: f64) {
        StereoEffect::set_tempo(self, tempo);
    }

    fn settle(&mut self) {
        StereoEffect::settle(self);
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], ticks: &[f64]) {
        self.process_stereo_at(left, right, ticks);
    }
}

/// One tick per frame for `frames` frames of a song at `tempo`, playing from
/// `start`, as the Engine fills them.
#[cfg(test)]
pub(super) fn song_ticks(start: f64, tempo: f64, sample_rate: f32, frames: usize) -> Vec<f64> {
    let per_frame = tempo / 60.0 * TICKS_PER_BEAT as f64 / f64::from(sample_rate);
    (0..frames)
        .map(|frame| start + frame as f64 * per_frame)
        .collect()
}

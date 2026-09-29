//! What a built-in Effect that works on the stereo signal in place implements,
//! so the Insert Chain runs it without a case of its own for each: every
//! setting, the flat form and Automation come from its settings table.

use std::fmt::Debug;

use super::params::Settings;

/// A built-in Effect that works on both sides in place.
pub trait StereoEffect: Debug + Send + 'static {
    type Settings: Settings + Copy;

    fn settings(&self) -> Self::Settings;

    fn set_settings(&mut self, settings: Self::Settings);

    /// The song's tempo where it is playing, in quarter notes per minute,
    /// for an Effect synced to it. Allocates nothing.
    fn set_tempo(&mut self, _tempo: f64) {}

    /// Process both sides in place. Allocates nothing.
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]);
}

/// A `StereoEffect` as the chain holds it, whatever its settings' type.
pub(super) trait InPlace: Debug + Send {
    fn get(&self, index: usize) -> f32;
    /// Set the setting at `index`, as its table clamps and rounds it, if that
    /// changes it. Allocates nothing.
    fn set(&mut self, index: usize, value: f32);
    fn set_flat(&mut self, values: &[f32]);
    fn set_tempo(&mut self, tempo: f64);
    fn process(&mut self, left: &mut [f32], right: &mut [f32]);
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

    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.process_stereo(left, right);
    }
}

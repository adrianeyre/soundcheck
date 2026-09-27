//! The metronome click: a short decaying tone, higher on the first beat of
//! each bar.
//!
//! The tone starts at the peak of a cosine, so its first sample is its loudest
//! and a click's position in a rendered buffer is exact.

use std::f32::consts::TAU;

const CLICK_SECONDS: f32 = 0.03;
const ACCENT_HZ: f32 = 1_500.0;
const BEAT_HZ: f32 = 1_000.0;
pub const CLICK_LEVEL: f32 = 0.5;

#[derive(Clone, Debug)]
pub struct Metronome {
    sample_rate: f32,
    length: usize,
    decay: f32,
    /// Frames into the current click, and its frequency.
    sounding: Option<(usize, f32)>,
}

impl Metronome {
    pub fn new(sample_rate: f32) -> Self {
        let length = (CLICK_SECONDS * sample_rate) as usize;
        Self {
            sample_rate,
            length,
            // Down to 1/1000 (-60 dB) by the end of the click.
            decay: 0.001_f32.powf(1.0 / length.max(1) as f32),
            sounding: None,
        }
    }

    /// Start a click now; `accent` for the first beat of a bar.
    pub fn click(&mut self, accent: bool) {
        self.sounding = Some((0, if accent { ACCENT_HZ } else { BEAT_HZ }));
    }

    /// Stop any click that is sounding.
    pub fn silence(&mut self) {
        self.sounding = None;
    }

    /// Add the sounding click to both channels.
    pub fn render_into(&mut self, left: &mut [f32], right: &mut [f32]) {
        let Some((mut position, frequency)) = self.sounding else {
            return;
        };
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            if position >= self.length {
                self.sounding = None;
                return;
            }
            let t = position as f32;
            let sample =
                CLICK_LEVEL * (TAU * frequency * t / self.sample_rate).cos() * self.decay.powf(t);
            *l += sample;
            *r += sample;
            position += 1;
        }
        self.sounding = Some((position, frequency));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::peak;

    #[test]
    fn a_click_starts_at_full_level_and_dies_away_within_30_ms() {
        let mut metronome = Metronome::new(48_000.0);
        metronome.click(true);
        let mut left = vec![0.0; 2_000];
        let mut right = vec![0.0; 2_000];
        metronome.render_into(&mut left, &mut right);
        assert_eq!(left[0], CLICK_LEVEL);
        assert!(peak(&left[1_000..1_440]) < 0.01);
        assert_eq!(peak(&left[1_440..]), 0.0);
        assert_eq!(left, right);
    }

    #[test]
    fn silent_until_clicked() {
        let mut metronome = Metronome::new(48_000.0);
        let mut left = vec![0.0; 128];
        let mut right = vec![0.0; 128];
        metronome.render_into(&mut left, &mut right);
        assert_eq!(peak(&left), 0.0);
    }
}

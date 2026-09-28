//! **Master Tempo** and **Key Shift**: a Deck read at one speed and heard
//! at another pitch, by WSOLA (waveform-similarity overlap-add).
//!
//! The sound is built from grains of about 40 ms, each read from the file
//! at the pitch wanted and faded in and out by a Hann window, a new one
//! every half grain, so two always overlap and their windows sum to one.
//! Each grain starts near where the Deck's playhead is, which moves at its
//! tempo, so the tempo and the pitch are free of each other. Of the starts
//! within about 12 ms of the playhead, the one whose sound best matches
//! the grain fading out is chosen, so the two overlap in phase and the
//! result doesn't warble.
//!
//! Everything is read straight from the file: nothing is buffered, so
//! nothing allocates.

use super::deck::read;

const GRAIN_SECONDS: f32 = 0.042;
const SEARCH_SECONDS: f32 = 0.012;
/// Candidates are tried this many frames apart, and each compared at every
/// this-many frames: coarse, but ample to line up the grains' phase.
const SEARCH_STEP: usize = 3;
const COMPARE_STEP: usize = 6;

#[derive(Clone, Copy, Debug, Default)]
struct Grain {
    /// Where in the file its first frame is.
    start: f64,
    /// How far into the grain the next frame is.
    at: usize,
    active: bool,
}

#[derive(Debug)]
pub struct Stretcher {
    length: usize,
    search: usize,
    grains: [Grain; 2],
    /// Frames since the last grain began.
    since: usize,
    started: bool,
    /// The Hann window, worked out once.
    window: Vec<f32>,
}

impl Stretcher {
    pub fn new(sample_rate: f32) -> Self {
        let length = ((GRAIN_SECONDS * sample_rate) as usize).max(64) & !1;
        let window = (0..length)
            .map(|k| 0.5 - 0.5 * (std::f32::consts::TAU * k as f32 / length as f32).cos())
            .collect();
        Self {
            length,
            search: (SEARCH_SECONDS * sample_rate) as usize,
            grains: [Grain::default(); 2],
            since: 0,
            started: false,
            window,
        }
    }

    /// Start again from wherever the Deck is next, as after a jump.
    pub fn reset(&mut self) {
        self.started = false;
    }

    /// The next frame of `left` and `right` for a playhead at `position`
    /// moving in `direction` (1 or -1), heard at `pitch` (1 is the file's
    /// own).
    pub fn next(
        &mut self,
        left: &[f32],
        right: &[f32],
        position: f64,
        direction: f64,
        pitch: f64,
    ) -> (f32, f32) {
        let hop = self.length / 2;
        let step = direction * pitch;
        if !self.started {
            // Enter at the window's peak, so a jump isn't faded in.
            self.grains = [
                Grain {
                    start: position - step * hop as f64,
                    at: hop,
                    active: true,
                },
                Grain::default(),
            ];
            self.since = 0;
            self.started = true;
        }
        if self.since >= hop {
            self.since = 0;
            // The grain that has finished (or is furthest through) makes way.
            let finished = |g: &Grain| if g.active { g.at } else { usize::MAX };
            let (older, other) = if finished(&self.grains[0]) >= finished(&self.grains[1]) {
                (0, 1)
            } else {
                (1, 0)
            };
            let previous = self.grains[other].active.then_some(self.grains[other]);
            let fading = if self.grains[older].active {
                self.grains[older]
            } else {
                previous.unwrap_or_default()
            };
            let start = self.best_start(left, right, position, step, fading);
            self.grains[older] = Grain {
                start,
                at: 0,
                active: true,
            };
        }
        self.since += 1;

        let (mut l, mut r) = (0.0, 0.0);
        for grain in &mut self.grains {
            if !grain.active {
                continue;
            }
            let w = self.window[grain.at];
            let at = grain.start + step * grain.at as f64;
            l += w * read(left, at);
            r += w * read(right, at);
            grain.at += 1;
            if grain.at >= self.length {
                grain.active = false;
            }
        }
        (l, r)
    }

    /// Where a grain starting near `position` should start, to overlap the
    /// grain still sounding (`fading`, at its halfway point) in phase.
    fn best_start(
        &self,
        left: &[f32],
        right: &[f32],
        position: f64,
        step: f64,
        fading: Grain,
    ) -> f64 {
        let hop = self.length / 2;
        let mono = |at: f64| read(left, at) + read(right, at);
        // What the grain fading out plays from here on.
        let from = fading.start + step * fading.at as f64;
        let mut best = position;
        let mut best_score = f32::NEG_INFINITY;
        let search = self.search as isize;
        let mut offset = -search;
        while offset <= search {
            let candidate = position + offset as f64;
            let (mut dot, mut energy) = (0.0f32, 1e-9f32);
            let mut j = 0;
            while j < hop {
                let a = mono(candidate + step * j as f64);
                let b = mono(from + step * j as f64);
                dot += a * b;
                energy += a * a;
                j += COMPARE_STEP;
            }
            let score = dot / energy.sqrt();
            if score > best_score {
                best_score = score;
                best = candidate;
            }
            offset += SEARCH_STEP as isize;
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rising_zero_crossings, sine};

    const RATE: f32 = 48_000.0;

    /// Play a second of a 1 kHz sine moving at `speed` and heard at
    /// `pitch`, and count its cycles.
    fn cycles(speed: f64, pitch: f64) -> usize {
        let tone = sine(1_000.0, 0.5, RATE, 4 * RATE as usize);
        let mut stretcher = Stretcher::new(RATE);
        let mut position = 0.0;
        let out: Vec<f32> = (0..RATE as usize)
            .map(|_| {
                let (l, _) = stretcher.next(&tone, &tone, position, 1.0, pitch);
                position += speed;
                l
            })
            .collect();
        rising_zero_crossings(&out)
    }

    #[test]
    fn master_tempo_keeps_the_pitch_whatever_the_tempo() {
        for speed in [0.5, 0.84, 1.0, 1.16, 1.6] {
            let heard = cycles(speed, 1.0) as f64;
            assert!((heard - 1_000.0).abs() < 5.0, "at {speed}: {heard} Hz");
        }
    }

    #[test]
    fn a_key_shift_moves_the_pitch_and_not_the_tempo() {
        let up_a_fifth = 2f64.powf(7.0 / 12.0);
        let heard = cycles(1.0, up_a_fifth) as f64;
        assert!((heard - 1_000.0 * up_a_fifth).abs() < 30.0, "{heard} Hz");
    }

    #[test]
    fn a_steady_tone_comes_out_at_a_steady_level() {
        let tone = sine(440.0, 0.5, RATE, 2 * RATE as usize);
        let mut stretcher = Stretcher::new(RATE);
        let mut position = 0.0;
        let out: Vec<f32> = (0..RATE as usize)
            .map(|_| {
                position += 1.1;
                stretcher.next(&tone, &tone, position, 1.0, 1.0).0
            })
            .collect();
        let peak = out[4_800..].iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.4 && peak < 0.6, "{peak}");
    }
}

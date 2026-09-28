//! Beat FX, as a DJM's: one effect at a time, timed to the mix's BPM by a
//! beat division, on a channel, a side of the crossfader or the Master.
//!
//! Everything works from one ring buffer of what came in, eight seconds
//! long, allocated up front: the delays read behind the write point, the
//! rolls repeat a slice of it and the brake reads it slower and slower.

use crate::dsp::{Biquad, flush_denormal};
use crate::effect::{Reverb, ReverbSettings};

/// Every Beat FX, in the order the mixer's selector lists them.
pub const BEAT_FX: &[&str] = &[
    "delay",
    "echo",
    "pingPong",
    "spiral",
    "reverb",
    "trans",
    "filter",
    "flanger",
    "phaser",
    "pitch",
    "slipRoll",
    "roll",
    "vinylBrake",
    "helix",
];

/// The longest stretch the effects can reach back into.
const BUFFER_SECONDS: f32 = 8.0;
const PHASER_STAGES: usize = 4;

#[derive(Debug)]
pub struct BeatFx {
    sample_rate: f32,
    pub kind: u8,
    /// How long one step of the effect is, in beats: 0.0625 is 1/16 of a
    /// beat, 64 is sixteen bars of four.
    pub division: f64,
    /// Level/depth, 0 to 1.
    pub level: f32,
    pub on: bool,
    buffer: [Vec<f32>; 2],
    write: usize,
    phase: f64,
    reverb: Reverb,
    scratch: [Vec<f32>; 2],
    filters: [Biquad; 2],
    allpass: [[f32; PHASER_STAGES]; 2],
    /// Where a roll or brake took its slice from, and how far it has read.
    capture: Option<(usize, f64)>,
    was_on: bool,
}

impl BeatFx {
    pub fn new(sample_rate: f32) -> Self {
        let length = (BUFFER_SECONDS * sample_rate) as usize;
        let pass = Biquad::low_pass(sample_rate, 20_000.0, 0.7);
        Self {
            sample_rate,
            kind: 0,
            division: 1.0,
            level: 0.5,
            on: false,
            buffer: [vec![0.0; length], vec![0.0; length]],
            write: 0,
            phase: 0.0,
            reverb: Reverb::new(sample_rate, ReverbSettings::default()),
            scratch: [vec![0.0; 1_024], vec![0.0; 1_024]],
            filters: [pass; 2],
            allpass: [[0.0; PHASER_STAGES]; 2],
            capture: None,
            was_on: false,
        }
    }

    /// Frames in one step of the effect at `bpm`, held inside the buffer.
    fn step_frames(&self, bpm: f64) -> usize {
        let seconds = self.division * 60.0 / bpm.max(40.0);
        ((seconds * f64::from(self.sample_rate)) as usize).clamp(8, self.buffer[0].len() - 2)
    }

    fn behind(&self, frames: usize) -> usize {
        let length = self.buffer[0].len();
        (self.write + length - frames.min(length - 1)) % length
    }

    /// Run `left` and `right` through the effect, in place.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], bpm: f64) {
        let length = self.buffer[0].len();
        let step = self.step_frames(bpm);
        let level = self.level.clamp(0.0, 1.0);
        let starting = self.on && !self.was_on;
        self.was_on = self.on;
        if starting {
            self.capture = Some((self.behind(0), 0.0));
            self.phase = 0.0;
        }
        if !self.on {
            self.capture = None;
        }
        // The echoes ring on once the effect is off; the rest stop at once.
        let tails = matches!(self.kind, 1 | 3);
        if !self.on && !tails {
            for (l, r) in left.iter().zip(right.iter()) {
                self.buffer[0][self.write] = *l;
                self.buffer[1][self.write] = *r;
                self.write = (self.write + 1) % length;
            }
            return;
        }
        if self.kind == 4 {
            self.reverb_block(left, right, level, bpm);
            return;
        }
        let phase_step = 1.0 / step as f64;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let (x, y) = (*l, *r);
            let feed = if self.on { 1.0 } else { 0.0 };
            let (out_l, out_r, write_l, write_r) = match self.kind {
                // Delay: one repeat a step later.
                0 => {
                    let at = self.behind(step);
                    let (dl, dr) = (self.buffer[0][at], self.buffer[1][at]);
                    (x + dl * level, y + dr * level, x, y)
                }
                // Echo and Spiral: repeats that die away, fed back.
                1 | 3 => {
                    let feedback = if self.kind == 3 { 0.75 } else { 0.55 };
                    let at = self.behind(step);
                    let (dl, dr) = (self.buffer[0][at], self.buffer[1][at]);
                    let dark = |s: f32, f: &mut Biquad| f.process(s);
                    let (fl, fr) = (
                        dark(dl, &mut self.filters[0]),
                        dark(dr, &mut self.filters[1]),
                    );
                    (
                        x + dl * level,
                        y + dr * level,
                        x * feed + fl * feedback,
                        y * feed + fr * feedback,
                    )
                }
                // Ping Pong: repeats that cross from side to side.
                2 => {
                    let at = self.behind(step);
                    let (dl, dr) = (self.buffer[0][at], self.buffer[1][at]);
                    (
                        x + dr * level,
                        y + dl * level,
                        0.5 * (x + y) + dr * 0.5,
                        dl * 0.5,
                    )
                }
                // Trans: the sound cut in time, on for half of each step.
                5 => {
                    self.phase = (self.phase + phase_step).fract();
                    let gate = if self.phase < 0.5 { 1.0 } else { 1.0 - level };
                    (x * gate, y * gate, x, y)
                }
                // Filter: a low-pass swept up and down once a step.
                6 => {
                    self.phase = (self.phase + phase_step).fract();
                    let sweep = 0.5 - 0.5 * (std::f64::consts::TAU * self.phase).cos();
                    let cutoff = 20_000.0 * (0.01f32).powf(level * sweep as f32);
                    let filter = Biquad::low_pass(self.sample_rate, cutoff.max(60.0), 2.0);
                    for f in &mut self.filters {
                        let mut next = filter;
                        next.restore_state(f);
                        *f = next;
                    }
                    (self.filters[0].process(x), self.filters[1].process(y), x, y)
                }
                // Flanger: a short delay swept once a step, fed back.
                7 => {
                    self.phase = (self.phase + phase_step).fract();
                    let sweep = 0.5 - 0.5 * (std::f64::consts::TAU * self.phase).cos();
                    let delay = (0.0005 + 0.0045 * sweep) * f64::from(self.sample_rate);
                    let at = self.behind(delay as usize);
                    let (dl, dr) = (self.buffer[0][at], self.buffer[1][at]);
                    (
                        (x + dl * level) * 0.8,
                        (y + dr * level) * 0.8,
                        x + dl * 0.6,
                        y + dr * 0.6,
                    )
                }
                // Phaser: all-pass stages swept once a step.
                8 => {
                    self.phase = (self.phase + phase_step).fract();
                    let sweep = 0.5 - 0.5 * (std::f64::consts::TAU * self.phase).cos();
                    let hz = 200.0 * 2f32.powf(sweep as f32 * 5.0);
                    let t = (std::f32::consts::PI * hz / self.sample_rate).tan();
                    let a = (t - 1.0) / (t + 1.0);
                    let mut run = |side: usize, input: f32| {
                        let mut s = input;
                        for z in &mut self.allpass[side] {
                            let out = a * s + *z;
                            *z = flush_denormal(s - a * out);
                            s = out;
                        }
                        s
                    };
                    let (pl, pr) = (run(0, x), run(1, y));
                    ((x + pl * level) * 0.7, (y + pr * level) * 0.7, x, y)
                }
                // Pitch: read behind at another speed, from two taps that
                // cross-fade, up to an octave either way.
                9 => {
                    let ratio = 2f64.powf((f64::from(level) - 0.5) * 2.0);
                    let window = (0.05 * f64::from(self.sample_rate)).max(16.0);
                    self.phase = (self.phase + (1.0 - ratio) / window).rem_euclid(1.0);
                    let tap = |phase: f64| (phase * window) as usize + 1;
                    let fade = (std::f64::consts::PI * self.phase).sin() as f32;
                    let (a, b) = (
                        self.behind(tap(self.phase)),
                        self.behind(tap((self.phase + 0.5) % 1.0)),
                    );
                    let (w1, w2) = (fade * fade, 1.0 - fade * fade);
                    (
                        self.buffer[0][a] * w1 + self.buffer[0][b] * w2,
                        self.buffer[1][a] * w1 + self.buffer[1][b] * w2,
                        x,
                        y,
                    )
                }
                // Slip Roll, Roll and Helix: a step of what came in when it
                // was turned on, over and over; Helix lets the live sound
                // back in underneath.
                10 | 11 | 13 => {
                    let (start, read) = self.capture.unwrap_or((self.write, 0.0));
                    let at = (start + length - step + read as usize % step) % length;
                    let (rl, rr) = (self.buffer[0][at], self.buffer[1][at]);
                    self.capture = Some((start, read + 1.0));
                    let dry = if self.kind == 13 {
                        1.0 - level
                    } else {
                        1.0 - level.max(0.999)
                    };
                    let wet = if self.kind == 13 { level } else { 1.0 };
                    (x * dry + rl * wet, y * dry + rr * wet, x, y)
                }
                // Vinyl Brake: what came in, read slower and slower until it
                // stops, over a step.
                _ => {
                    let (start, read) = self.capture.unwrap_or((self.write, 0.0));
                    let done = (read / step as f64).min(1.0);
                    let speed = 1.0 - done;
                    let travelled = read * (1.0 - 0.5 * done);
                    let at = (start + length - step + travelled as usize) % length;
                    self.capture = Some((start, read + 1.0));
                    let gain = speed as f32;
                    (
                        self.buffer[0][at] * gain * level + x * (1.0 - level),
                        self.buffer[1][at] * gain * level + y * (1.0 - level),
                        x,
                        y,
                    )
                }
            };
            // A roll plays from its capture, so the buffer keeps only the
            // live sound behind it.
            if !(matches!(self.kind, 10..=13) && self.on) {
                self.buffer[0][self.write] = flush_denormal(write_l);
                self.buffer[1][self.write] = flush_denormal(write_r);
                self.write = (self.write + 1) % length;
            }
            *l = out_l;
            *r = out_r;
        }
    }

    fn reverb_block(&mut self, left: &mut [f32], right: &mut [f32], level: f32, bpm: f64) {
        let decay = (self.division * 60.0 / bpm.max(40.0)).clamp(0.3, 10.0) as f32;
        let mut settings = self.reverb.settings();
        if (settings.decay - decay).abs() > 0.01 || settings.mix != 1.0 {
            settings.decay = decay;
            settings.mix = 1.0;
            self.reverb.set_settings(settings);
        }
        let chunk = self.scratch[0].len();
        let mut from = 0;
        while from < left.len() {
            let to = (from + chunk).min(left.len());
            let n = to - from;
            let [scratch_l, scratch_r] = &mut self.scratch;
            scratch_l[..n].fill(0.0);
            scratch_r[..n].fill(0.0);
            self.reverb.process_stereo_into(
                &left[from..to],
                &right[from..to],
                &mut scratch_l[..n],
                &mut scratch_r[..n],
                1.0,
            );
            for i in 0..n {
                left[from + i] += scratch_l[i] * level;
                right[from + i] += scratch_r[i] * level;
            }
            from = to;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, rms, sine};

    const RATE: f32 = 48_000.0;

    fn click(frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut left = vec![0.0; frames];
        left[0] = 1.0;
        (left.clone(), left)
    }

    #[test]
    fn off_it_passes_the_sound_through() {
        let mut fx = BeatFx::new(RATE);
        let tone = sine(440.0, 0.5, RATE, 4_800);
        let (mut left, mut right) = (tone.clone(), tone.clone());
        fx.process(&mut left, &mut right, 120.0);
        assert_eq!(left, tone);
    }

    #[test]
    fn the_delay_repeats_a_click_one_division_later() {
        let mut fx = BeatFx::new(RATE);
        fx.on = true;
        fx.division = 0.5;
        fx.level = 1.0;
        let (mut left, mut right) = click(24_000);
        fx.process(&mut left, &mut right, 120.0);
        // Half a beat at 120 BPM is 0.25 s.
        assert!((left[12_000] - 1.0).abs() < 1e-6);
        assert!(left[1..12_000].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn the_echo_rings_on_after_it_is_turned_off() {
        let mut fx = BeatFx::new(RATE);
        fx.kind = 1;
        fx.on = true;
        fx.division = 0.25;
        fx.level = 1.0;
        let (mut left, mut right) = click(3_000);
        fx.process(&mut left, &mut right, 120.0);
        fx.on = false;
        let (mut left, mut right) = (vec![0.0; 24_000], vec![0.0; 24_000]);
        fx.process(&mut left, &mut right, 120.0);
        assert!(peak(&left) > 0.05);
    }

    #[test]
    fn trans_cuts_the_sound_in_time() {
        let mut fx = BeatFx::new(RATE);
        fx.kind = 5;
        fx.on = true;
        fx.division = 1.0;
        fx.level = 1.0;
        let tone = sine(440.0, 0.5, RATE, 48_000);
        let (mut left, mut right) = (tone.clone(), tone);
        fx.process(&mut left, &mut right, 120.0);
        // A beat is 24,000 frames: on for half of it, off for the other.
        assert!(rms(&left[1_000..11_000]) > 0.3);
        assert!(rms(&left[13_000..23_000]) < 1e-6);
    }

    #[test]
    fn a_roll_repeats_the_step_it_caught() {
        let mut fx = BeatFx::new(RATE);
        fx.kind = 11;
        let ramp: Vec<f32> = (0..4_800).map(|i| i as f32 / 4_800.0).collect();
        let (mut left, mut right) = (ramp.clone(), ramp.clone());
        fx.process(&mut left, &mut right, 120.0);
        fx.on = true;
        fx.division = 0.0625;
        // A sixteenth of a beat at 120 BPM is 1,500 frames.
        let (mut left, mut right) = (vec![0.0; 3_000], vec![0.0; 3_000]);
        fx.process(&mut left, &mut right, 120.0);
        assert_eq!(left[..1_500], left[1_500..]);
        assert!(peak(&left) > 0.9);
    }

    #[test]
    fn every_effect_runs_without_blowing_up() {
        for kind in 0..BEAT_FX.len() as u8 {
            let mut fx = BeatFx::new(RATE);
            fx.kind = kind;
            fx.on = true;
            fx.level = 1.0;
            let tone = sine(220.0, 0.5, RATE, 48_000);
            let (mut left, mut right) = (tone.clone(), tone);
            fx.process(&mut left, &mut right, 128.0);
            assert!(
                left.iter().all(|s| s.is_finite()),
                "{}",
                BEAT_FX[kind as usize]
            );
            assert!(
                peak(&left) < 4.0,
                "{}: {}",
                BEAT_FX[kind as usize],
                peak(&left)
            );
        }
    }
}

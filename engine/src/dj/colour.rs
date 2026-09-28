//! Colour FX, one per channel, as a DJM's: the type is picked once for the
//! mixer and each channel's knob turns it, left of centre one way and right
//! the other, off at the centre. `parameter` is the mixer's one shared
//! setting (resonance for the filter, feedback for the echo, and so on).

use crate::dsp::{Biquad, flush_denormal};
use crate::effect::{Reverb, ReverbSettings};

/// Every Colour FX, in the order the mixer's selector lists them.
pub const COLOUR_FX: &[&str] = &["space", "dubEcho", "sweep", "noise", "crush", "filter"];

/// The longest a Dub Echo waits, in seconds.
const MAX_ECHO_SECONDS: f32 = 2.0;
/// How often the filters are redesigned as the knob moves, in frames.
const REDESIGN_FRAMES: usize = 32;
/// Below this far from the centre, the knob is off.
const DEAD_ZONE: f32 = 0.02;

#[derive(Debug)]
pub struct ColourFx {
    sample_rate: f32,
    filters: [Biquad; 2],
    /// A second stage for the filter, so it sweeps with a steeper slope.
    filters_2: [Biquad; 2],
    reverb: Reverb,
    reverb_left: Vec<f32>,
    reverb_right: Vec<f32>,
    echo: [Vec<f32>; 2],
    echo_write: usize,
    echo_filter: [Biquad; 2],
    noise: u32,
    crush_hold: [f32; 2],
    crush_count: usize,
    sweep_phase: f64,
}

impl ColourFx {
    pub fn new(sample_rate: f32) -> Self {
        let echo = (MAX_ECHO_SECONDS * sample_rate) as usize + 1;
        let pass = Biquad::low_pass(sample_rate, 20_000.0, 0.7);
        Self {
            sample_rate,
            filters: [pass; 2],
            filters_2: [pass; 2],
            reverb: Reverb::new(
                sample_rate,
                ReverbSettings {
                    size: 0.8,
                    decay: 3.0,
                    damping: 0.4,
                    pre_delay: 10.0,
                    width: 1.0,
                    mix: 1.0,
                },
            ),
            reverb_left: vec![0.0; 1_024],
            reverb_right: vec![0.0; 1_024],
            echo: [vec![0.0; echo], vec![0.0; echo]],
            echo_write: 0,
            echo_filter: [pass; 2],
            noise: 0x1234_5678,
            crush_hold: [0.0; 2],
            crush_count: 0,
            sweep_phase: 0.0,
        }
    }

    fn noise(&mut self) -> f32 {
        // xorshift32: cheap, and plenty random for a hiss.
        let mut x = self.noise;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.noise = x;
        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    /// Low-pass left of centre, high-pass right, sweeping further the
    /// further the knob is turned.
    fn design_filter(&mut self, knob: f32, resonance: f32) {
        let amount = knob.abs().min(1.0);
        let q = 0.7 + resonance.clamp(0.0, 1.0) * 5.0;
        let filter = if knob < 0.0 {
            Biquad::low_pass(
                self.sample_rate,
                20_000.0 * (80.0f32 / 20_000.0).powf(amount),
                q,
            )
        } else {
            Biquad::high_pass(
                self.sample_rate,
                20.0 * (10_000.0f32 / 20.0).powf(amount),
                q,
            )
        };
        for f in self.filters.iter_mut().chain(self.filters_2.iter_mut()) {
            let mut next = filter;
            next.restore_state(f);
            *f = next;
        }
    }

    pub fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        kind: u8,
        knob: f32,
        parameter: f32,
        bpm: f64,
    ) {
        if knob.abs() < DEAD_ZONE {
            // Tails ring on: an echo or a space fades as it would.
            if kind == 1 {
                self.dub_echo(left, right, 0.0, parameter, bpm);
            }
            return;
        }
        match kind {
            0 => self.space(left, right, knob),
            1 => self.dub_echo(left, right, knob, parameter, bpm),
            2 => self.sweep(left, right, knob, parameter),
            3 => self.hiss(left, right, knob, parameter),
            4 => self.crush(left, right, knob),
            _ => self.filter(left, right, knob, parameter),
        }
    }

    fn filter(&mut self, left: &mut [f32], right: &mut [f32], knob: f32, resonance: f32) {
        for (index, (l, r)) in left.iter_mut().zip(right.iter_mut()).enumerate() {
            if index % REDESIGN_FRAMES == 0 {
                self.design_filter(knob, resonance);
            }
            *l = self.filters_2[0].process(self.filters[0].process(*l));
            *r = self.filters_2[1].process(self.filters[1].process(*r));
        }
    }

    /// A reverb that grows with the knob: to the left it thins out what it
    /// is fed, to the right it is fed everything.
    fn space(&mut self, left: &mut [f32], right: &mut [f32], knob: f32) {
        let wet = knob.abs();
        for chunk in (0..left.len()).step_by(self.reverb_left.len()) {
            let end = (chunk + self.reverb_left.len()).min(left.len());
            let n = end - chunk;
            let (in_l, in_r) = (&mut self.reverb_left[..n], &mut self.reverb_right[..n]);
            in_l.copy_from_slice(&left[chunk..end]);
            in_r.copy_from_slice(&right[chunk..end]);
            if knob < 0.0 {
                self.filters[0] = Biquad::high_pass(self.sample_rate, 600.0, 0.7);
                self.filters[0].process_buffer(in_l);
                self.filters[1] = Biquad::high_pass(self.sample_rate, 600.0, 0.7);
                self.filters[1].process_buffer(in_r);
            }
            let mut tail_l = [0.0f32; 1_024];
            let mut tail_r = [0.0f32; 1_024];
            self.reverb
                .process_stereo_into(in_l, in_r, &mut tail_l[..n], &mut tail_r[..n], 1.0);
            for i in 0..n {
                left[chunk + i] += tail_l[i] * wet;
                right[chunk + i] += tail_r[i] * wet;
            }
        }
    }

    /// An echo three quarters of a beat long whose repeats get darker (to
    /// the left) or thinner (to the right).
    fn dub_echo(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        knob: f32,
        feedback: f32,
        bpm: f64,
    ) {
        let length = self.echo[0].len();
        let seconds = (0.75 * 60.0 / bpm.max(40.0)) as f32;
        let delay =
            ((seconds.min(MAX_ECHO_SECONDS) * self.sample_rate) as usize).clamp(1, length - 1);
        let send = knob.abs();
        let feedback = 0.35 + feedback.clamp(0.0, 1.0) * 0.5;
        let filter = if knob < 0.0 {
            Biquad::low_pass(self.sample_rate, 1_800.0, 0.7)
        } else {
            Biquad::high_pass(self.sample_rate, 700.0, 0.7)
        };
        for f in &mut self.echo_filter {
            let mut next = filter;
            next.restore_state(f);
            *f = next;
        }
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let read = (self.echo_write + length - delay) % length;
            let (echo_l, echo_r) = (self.echo[0][read], self.echo[1][read]);
            let feed_l = self.echo_filter[0].process(*l * send + echo_l * feedback);
            let feed_r = self.echo_filter[1].process(*r * send + echo_r * feedback);
            self.echo[0][self.echo_write] = flush_denormal(feed_l);
            self.echo[1][self.echo_write] = flush_denormal(feed_r);
            self.echo_write = (self.echo_write + 1) % length;
            *l += echo_l;
            *r += echo_r;
        }
    }

    /// A band-pass swept by the knob, and to the left a gate chopping in
    /// time with it.
    fn sweep(&mut self, left: &mut [f32], right: &mut [f32], knob: f32, parameter: f32) {
        let amount = knob.abs();
        let centre = 150.0 * 2f32.powf(amount * 6.0);
        let q = 1.0 + parameter.clamp(0.0, 1.0) * 6.0;
        let band = Biquad::band_pass(self.sample_rate, centre, q);
        for f in &mut self.filters {
            let mut next = band;
            next.restore_state(f);
            *f = next;
        }
        let rate = 8.0 * f64::from(amount) / f64::from(self.sample_rate);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let (bl, br) = (self.filters[0].process(*l), self.filters[1].process(*r));
            let gate = if knob < 0.0 {
                self.sweep_phase = (self.sweep_phase + rate).fract();
                if self.sweep_phase < 0.5 {
                    1.0
                } else {
                    1.0 - amount
                }
            } else {
                1.0
            };
            *l = (*l * (1.0 - amount) + bl * amount * 1.5) * gate;
            *r = (*r * (1.0 - amount) + br * amount * 1.5) * gate;
        }
    }

    /// White noise, filtered as the Filter would filter the signal, added
    /// at a level that grows with the knob.
    fn hiss(&mut self, left: &mut [f32], right: &mut [f32], knob: f32, parameter: f32) {
        let level = knob.abs() * 0.3;
        for (index, (l, r)) in left.iter_mut().zip(right.iter_mut()).enumerate() {
            if index % REDESIGN_FRAMES == 0 {
                self.design_filter(knob, parameter);
            }
            let n = self.noise() * level;
            *l = self.filters[0].process(*l + n);
            *r = self.filters[1].process(*r + n);
        }
    }

    /// Fewer bits the further the knob turns; to the right the sample rate
    /// drops too.
    fn crush(&mut self, left: &mut [f32], right: &mut [f32], knob: f32) {
        let amount = knob.abs();
        let steps = 2f32.powf(16.0 - 13.0 * amount);
        let hold = if knob > 0.0 {
            1 + (amount * 24.0) as usize
        } else {
            1
        };
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            if self.crush_count == 0 {
                self.crush_hold = [(*l * steps).round() / steps, (*r * steps).round() / steps];
            }
            self.crush_count = (self.crush_count + 1) % hold;
            *l = self.crush_hold[0];
            *r = self.crush_hold[1];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{rms, sine};

    const RATE: f32 = 48_000.0;

    fn through(kind: u8, knob: f32, frequency: f32) -> f32 {
        let mut fx = ColourFx::new(RATE);
        let tone = sine(frequency, 0.5, RATE, 24_000);
        let (mut left, mut right) = (tone.clone(), tone.clone());
        fx.process(&mut left, &mut right, kind, knob, 0.0, 120.0);
        rms(&left[12_000..]) / rms(&tone[12_000..])
    }

    #[test]
    fn the_centre_is_off() {
        for kind in 0..6 {
            assert!(
                (through(kind, 0.0, 440.0) - 1.0).abs() < 1e-6,
                "{}",
                COLOUR_FX[kind as usize]
            );
        }
    }

    #[test]
    fn the_filter_takes_highs_out_to_the_left_and_lows_to_the_right() {
        assert!(through(5, -0.9, 8_000.0) < 0.05);
        assert!(through(5, -0.9, 60.0) > 0.8);
        assert!(through(5, 0.9, 60.0) < 0.05);
        assert!(through(5, 0.9, 8_000.0) > 0.8);
    }

    #[test]
    fn crush_quantises_the_signal() {
        let mut fx = ColourFx::new(RATE);
        let tone = sine(100.0, 0.5, RATE, 4_800);
        let (mut left, mut right) = (tone.clone(), tone);
        fx.process(&mut left, &mut right, 4, -1.0, 0.0, 120.0);
        let mut levels: Vec<i32> = left.iter().map(|s| (s * 1_000.0) as i32).collect();
        levels.sort_unstable();
        levels.dedup();
        assert!(levels.len() < 20, "{} levels", levels.len());
    }

    #[test]
    fn the_dub_echo_repeats_a_click_three_quarters_of_a_beat_later() {
        let mut fx = ColourFx::new(RATE);
        let mut left = vec![0.0; 48_000];
        left[0] = 1.0;
        let mut right = left.clone();
        fx.process(&mut left, &mut right, 1, 1.0, 0.0, 120.0);
        // At 120 BPM three quarters of a beat is 0.375 s.
        let at = 18_000;
        assert!(left[at - 5..at + 5].iter().any(|s| s.abs() > 0.1));
        assert!(left[100..at - 100].iter().all(|s| s.abs() < 0.05));
    }
}

//! Renders the bundled starter kit's WAV files into `engine/assets/kits/starter`.
//!
//! The samples are synthesised here rather than recorded, so that the kit is
//! this repository's own work and can be redistributed under GPL-3.0 with
//! everything else (see that folder's `LICENCE.md`). Run it with
//! `cargo run -p soundcheck-engine --example make_starter_kit`; the output is
//! identical every time, so regenerating it leaves git clean unless this file
//! changed.
//!
//! This is a development tool, not part of the engine: the engine core itself
//! never touches a file (ADR 0001) — it embeds the finished WAVs.

use std::f32::consts::TAU;
use std::fs;
use std::path::Path;

const RATE: f32 = 48_000.0;
/// Every sound is normalised to this peak, leaving a little headroom.
const PEAK: f32 = 0.95;
/// Seconds of fade at the end, so a sample never stops on a step.
const FADE: f32 = 0.005;

fn main() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/kits/starter");
    fs::create_dir_all(&folder).expect("make the kit folder");
    for (name, samples) in kit() {
        let path = folder.join(format!("{name}.wav"));
        fs::write(&path, wav(&samples)).expect("write a sample");
        println!("{} ({} frames)", path.display(), samples.len());
    }
}

/// Every sound in the kit, by file name.
fn kit() -> Vec<(&'static str, Vec<f32>)> {
    vec![
        ("kick", kick()),
        ("snare", snare()),
        ("clap", clap()),
        ("closed-hat", hat(0.09, 0.02)),
        ("open-hat", hat(0.5, 0.13)),
        ("low-tom", tom(0.45, 105.0, 78.0, 0.17)),
        ("high-tom", tom(0.38, 205.0, 152.0, 0.14)),
        ("cowbell", cowbell()),
    ]
}

/// A deterministic noise source, so every run makes the same files.
struct Noise(u32);

impl Noise {
    fn new() -> Self {
        Self(0x9E37_79B9)
    }

    /// The next sample, -1 to 1.
    fn next(&mut self) -> f32 {
        // xorshift32.
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

/// A one-pole filter, used to shape noise into a hat or a snare.
struct OnePole {
    coefficient: f32,
    state: f32,
}

impl OnePole {
    fn new(cutoff_hz: f32) -> Self {
        Self {
            coefficient: (-TAU * cutoff_hz / RATE).exp(),
            state: 0.0,
        }
    }

    fn low_pass(&mut self, input: f32) -> f32 {
        self.state = input * (1.0 - self.coefficient) + self.state * self.coefficient;
        self.state
    }

    fn high_pass(&mut self, input: f32) -> f32 {
        input - self.low_pass(input)
    }
}

fn frames(seconds: f32) -> usize {
    (seconds * RATE) as usize
}

/// Seconds at frame `n`.
fn seconds(n: usize) -> f32 {
    n as f32 / RATE
}

fn decay(t: f32, time: f32) -> f32 {
    (-t / time).exp()
}

/// A sine whose frequency falls from `from` to `to` with time constant
/// `bend`, rendered for `length` seconds and decaying over `hold`.
fn swept_sine(length: f32, from: f32, to: f32, bend: f32, hold: f32) -> Vec<f32> {
    let mut phase: f32 = 0.0;
    (0..frames(length))
        .map(|n| {
            let t = seconds(n);
            let frequency = to + (from - to) * decay(t, bend);
            let sample = phase.sin() * decay(t, hold);
            phase += TAU * frequency / RATE;
            sample
        })
        .collect()
}

fn kick() -> Vec<f32> {
    let mut noise = Noise::new();
    let mut body = swept_sine(0.42, 120.0, 45.0, 0.028, 0.13);
    for (n, sample) in body.iter_mut().enumerate() {
        let t = seconds(n);
        // A short click on the front, so it cuts through a mix.
        *sample += noise.next() * decay(t, 0.002) * 0.35;
        // A few milliseconds of attack, so the first sample isn't a step.
        *sample *= (t / 0.002).min(1.0);
    }
    finish(body)
}

fn snare() -> Vec<f32> {
    let mut noise = Noise::new();
    let mut high = OnePole::new(1_200.0);
    let mut low = OnePole::new(7_500.0);
    let mut tones = swept_sine(0.3, 190.0, 180.0, 0.05, 0.075);
    let harmonic = swept_sine(0.3, 335.0, 330.0, 0.05, 0.055);
    for (n, sample) in tones.iter_mut().enumerate() {
        let t = seconds(n);
        let rattle = low.low_pass(high.high_pass(noise.next()));
        *sample = *sample * 0.5 + harmonic[n] * 0.25 + rattle * decay(t, 0.085) * 0.9;
        *sample *= (t / 0.001).min(1.0);
    }
    finish(tones)
}

fn clap() -> Vec<f32> {
    let mut noise = Noise::new();
    let mut high = OnePole::new(900.0);
    let mut low = OnePole::new(5_000.0);
    // Three quick slaps and a tail: what makes a clap sound like hands.
    let slaps = [0.0, 0.011, 0.022];
    let samples: Vec<f32> = (0..frames(0.36))
        .map(|n| {
            let t = seconds(n);
            let shaped = low.low_pass(high.high_pass(noise.next()));
            let bursts: f32 = slaps
                .iter()
                .filter(|&&start| t >= start)
                .map(|&start| decay(t - start, 0.007))
                .sum();
            let tail = if t >= 0.03 {
                decay(t - 0.03, 0.09) * 0.4
            } else {
                0.0
            };
            shaped * (bursts + tail)
        })
        .collect();
    finish(samples)
}

/// A hi-hat: filtered noise with a metallic ring, decaying over `hold`.
fn hat(length: f32, hold: f32) -> Vec<f32> {
    let mut noise = Noise::new();
    let mut high = OnePole::new(6_000.0);
    let mut second = OnePole::new(4_000.0);
    let samples: Vec<f32> = (0..frames(length))
        .map(|n| {
            let t = seconds(n);
            let hiss = second.high_pass(high.high_pass(noise.next()));
            // A little 8 kHz ring, so it has a pitch as well as a hiss.
            let ring = (TAU * 8_200.0 * t).sin() * 0.12;
            (hiss + ring) * decay(t, hold)
        })
        .collect();
    finish(samples)
}

fn tom(length: f32, from: f32, to: f32, hold: f32) -> Vec<f32> {
    let mut noise = Noise::new();
    let mut body = swept_sine(length, from, to, 0.09, hold);
    for (n, sample) in body.iter_mut().enumerate() {
        let t = seconds(n);
        *sample += noise.next() * decay(t, 0.004) * 0.2;
        *sample *= (t / 0.002).min(1.0);
    }
    finish(body)
}

fn cowbell() -> Vec<f32> {
    // Two detuned square-ish tones, the classic 808 recipe.
    let square = |frequency: f32, t: f32| (TAU * frequency * t).sin().signum();
    let samples: Vec<f32> = (0..frames(0.3))
        .map(|n| {
            let t = seconds(n);
            let tone = square(540.0, t) * 0.5 + square(800.0, t) * 0.5;
            tone * decay(t, 0.06) * (t / 0.002).min(1.0)
        })
        .collect();
    finish(samples)
}

/// Normalise to `PEAK` and fade the last milliseconds out.
fn finish(mut samples: Vec<f32>) -> Vec<f32> {
    let peak = samples.iter().fold(0.0_f32, |max, s| max.max(s.abs()));
    let scale = if peak > 0.0 { PEAK / peak } else { 0.0 };
    let fade = frames(FADE).max(1);
    let length = samples.len();
    for (n, sample) in samples.iter_mut().enumerate() {
        let out = ((length - n) as f32 / fade as f32).min(1.0);
        *sample *= scale * out;
    }
    samples
}

/// A 16-bit mono PCM WAV of `samples`.
fn wav(samples: &[f32]) -> Vec<u8> {
    let data: Vec<u8> = samples
        .iter()
        .flat_map(|s| ((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes())
        .collect();
    let rate = RATE as u32;
    let mut out = Vec::with_capacity(44 + data.len());
    out.extend(b"RIFF");
    out.extend((36 + data.len() as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes()); // fmt chunk size
    out.extend(1u16.to_le_bytes()); // PCM
    out.extend(1u16.to_le_bytes()); // mono
    out.extend(rate.to_le_bytes());
    out.extend((rate * 2).to_le_bytes()); // bytes per second
    out.extend(2u16.to_le_bytes()); // bytes per frame
    out.extend(16u16.to_le_bytes()); // bits per sample
    out.extend(b"data");
    out.extend((data.len() as u32).to_le_bytes());
    out.extend(data);
    out
}

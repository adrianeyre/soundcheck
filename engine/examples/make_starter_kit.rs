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
        ("hard-kick", hard_kick()),
        ("rimshot", rimshot()),
        ("electric-snare", electric_snare()),
        ("low-floor-tom", tom(0.55, 82.0, 60.0, 0.21)),
        ("pedal-hat", pedal_hat()),
        ("mid-tom", tom(0.42, 150.0, 112.0, 0.155)),
        ("crash", cymbal(1.1, 0.42, 4_500.0, 11)),
        ("ride", ride()),
        ("tambourine", tambourine()),
        ("splash", cymbal(0.5, 0.14, 6_500.0, 23)),
        ("hi-conga", conga(0.25, 345.0, 0.055)),
        ("low-conga", conga(0.4, 215.0, 0.11)),
        ("maracas", maracas()),
        ("claves", claves()),
    ]
}

/// A deterministic noise source, so every run makes the same files.
struct Noise(u32);

impl Noise {
    fn new() -> Self {
        Self(0x9E37_79B9)
    }

    /// Another deterministic stream, so two sounds don't share their hiss.
    fn seeded(seed: u32) -> Self {
        let mut noise = Self(0x9E37_79B9 ^ seed.wrapping_mul(0x85EB_CA6B));
        if noise.0 == 0 {
            noise.0 = 1;
        }
        noise
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

/// A two-pole band-pass (the RBJ cookbook's, constant peak gain), for the
/// sounds a one-pole is too gentle to shape: a conga's slap, a shaker.
struct BandPass {
    b0: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl BandPass {
    fn new(centre_hz: f32, q: f32) -> Self {
        let w = TAU * centre_hz / RATE;
        let alpha = w.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b0: alpha / a0,
            b2: -alpha / a0,
            a1: -2.0 * w.cos() / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let output = self.b0 * input + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = input;
        self.y2 = self.y1;
        self.y1 = output;
        output
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

/// A hard-trance, hardstyle kick: a sine bent down from a high punch to a
/// 55 Hz tail and driven hard into a soft clip, so the tail is a long,
/// distorted, pitched boom rather than a thud.
fn hard_kick() -> Vec<f32> {
    let length = 0.7;
    let mut noise = Noise::seeded(1);
    let mut tame = OnePole::new(7_000.0);
    let mut phase: f32 = 0.0;
    let samples: Vec<f32> = (0..frames(length))
        .map(|n| {
            let t = seconds(n);
            let frequency = 55.0 + 380.0 * decay(t, 0.011) + 55.0 * decay(t, 0.07);
            let body = phase.sin() * decay(t, 0.3);
            phase += TAU * frequency / RATE;
            // The drive: most of the tail is squashed flat, which is where
            // the kick's grit and its length come from.
            let driven = (body * 7.0).tanh();
            let click = noise.next() * decay(t, 0.0015) * 0.45;
            // Let the tail go over its last quarter of a second.
            let release = if t < 0.45 {
                1.0
            } else {
                0.5 + 0.5 * (std::f32::consts::PI * (t - 0.45) / (length - 0.45)).cos()
            };
            let attack = (t / 0.001).min(1.0);
            tame.low_pass(driven + click) * release * attack
        })
        .collect();
    finish(samples)
}

/// A rimshot: the stick on the rim and the head at once, a bright knock
/// with no tail.
fn rimshot() -> Vec<f32> {
    let mut noise = Noise::seeded(2);
    let mut crack = BandPass::new(3_200.0, 1.4);
    let samples: Vec<f32> = (0..frames(0.12))
        .map(|n| {
            let t = seconds(n);
            let knock = (TAU * 1_720.0 * t).sin() * 0.6 + (TAU * 470.0 * t).sin() * 0.45;
            let snap = crack.process(noise.next()) * 2.0;
            (knock * decay(t, 0.011) + snap * decay(t, 0.006)) * (t / 0.0005).min(1.0)
        })
        .collect();
    finish(samples)
}

/// A drum machine's snare: a tighter, higher body than the Snare, bent up
/// at the front, under brighter, snappier noise.
fn electric_snare() -> Vec<f32> {
    let mut noise = Noise::seeded(3);
    let mut high = OnePole::new(2_600.0);
    let mut low = OnePole::new(11_000.0);
    let mut tones = swept_sine(0.25, 330.0, 215.0, 0.012, 0.045);
    for (n, sample) in tones.iter_mut().enumerate() {
        let t = seconds(n);
        let rattle = low.low_pass(high.high_pass(noise.next()));
        *sample = *sample * 0.55 + rattle * decay(t, 0.055) * 1.1;
        *sample *= (t / 0.0008).min(1.0);
    }
    finish(tones)
}

/// The hi-hat closed with the foot: a short "chick", lower and softer than
/// the Closed Hat, with no stick on it.
fn pedal_hat() -> Vec<f32> {
    let mut noise = Noise::seeded(4);
    let mut band = BandPass::new(7_500.0, 0.9);
    let mut high = OnePole::new(3_000.0);
    let samples: Vec<f32> = (0..frames(0.13))
        .map(|n| {
            let t = seconds(n);
            let hiss = band.process(high.high_pass(noise.next()));
            let ring = (TAU * 6_900.0 * t).sin() * 0.05;
            // The cymbals come together over a few milliseconds.
            let swell = (t / 0.004).min(1.0);
            (hiss + ring) * swell * decay(t, 0.028)
        })
        .collect();
    finish(samples)
}

/// Six square waves at the 808's inharmonic cymbal pitches, the metal in a
/// cymbal.
fn metal(t: f32) -> f32 {
    const PITCHES: [f32; 6] = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
    PITCHES
        .iter()
        .map(|&pitch| (TAU * pitch * 1.7 * t).sin().signum())
        .sum::<f32>()
        / 6.0
}

/// A crash or a splash: bright noise and metal washing out over `hold`,
/// high-passed at `cutoff`.
fn cymbal(length: f32, hold: f32, cutoff: f32, seed: u32) -> Vec<f32> {
    let mut noise = Noise::seeded(seed);
    let mut first = OnePole::new(cutoff);
    let mut second = OnePole::new(cutoff);
    let mut air = OnePole::new(15_000.0);
    let samples: Vec<f32> = (0..frames(length))
        .map(|n| {
            let t = seconds(n);
            let wash = noise.next() * 0.8 + metal(t) * 0.7;
            let bright = second.high_pass(first.high_pass(wash));
            // The first few milliseconds are the loudest and brightest.
            let hit = decay(t, hold) + decay(t, 0.012) * 0.6;
            air.low_pass(bright) * hit * (t / 0.0015).min(1.0)
        })
        .collect();
    finish(samples)
}

/// A ride: a bell-like ping over a quieter wash that rings on.
fn ride() -> Vec<f32> {
    let mut noise = Noise::seeded(5);
    let mut first = OnePole::new(5_500.0);
    let mut second = OnePole::new(5_500.0);
    let partials = [
        (2_960.0, 0.35),
        (4_410.0, 0.25),
        (5_230.0, 0.2),
        (6_870.0, 0.12),
    ];
    let samples: Vec<f32> = (0..frames(0.95))
        .map(|n| {
            let t = seconds(n);
            let ping: f32 = partials
                .iter()
                .map(|&(pitch, level)| (TAU * pitch * t).sin() * level)
                .sum();
            let wash = second.high_pass(first.high_pass(noise.next() * 0.6 + metal(t) * 0.4));
            let tick = decay(t, 0.004) * 0.8;
            (ping * decay(t, 0.3) + wash * (decay(t, 0.38) * 0.55 + tick)) * (t / 0.001).min(1.0)
        })
        .collect();
    finish(samples)
}

/// A tambourine: a hit on the head and its jingles ringing, then a second,
/// quieter shake of them.
fn tambourine() -> Vec<f32> {
    let mut noise = Noise::seeded(6);
    let mut band = BandPass::new(9_000.0, 1.2);
    let jingles = [6_450.0, 8_120.0, 9_870.0, 11_300.0];
    let samples: Vec<f32> = (0..frames(0.32))
        .map(|n| {
            let t = seconds(n);
            let ring: f32 = jingles
                .iter()
                .map(|&pitch| (TAU * pitch * t).sin())
                .sum::<f32>()
                / 4.0;
            let shake = decay(t, 0.05)
                + if t >= 0.035 {
                    decay(t - 0.035, 0.04) * 0.45
                } else {
                    0.0
                };
            let jingling = band.process(noise.next()) * 2.2 + ring * 0.35;
            jingling * shake * (t / 0.001).min(1.0)
        })
        .collect();
    finish(samples)
}

/// A conga: a hand slap on a tuned skin, a sine at `pitch` that sags a
/// little as it rings over `hold`.
fn conga(length: f32, pitch: f32, hold: f32) -> Vec<f32> {
    let mut noise = Noise::seeded(pitch as u32);
    let mut slap = BandPass::new(1_800.0, 1.1);
    let mut phase: f32 = 0.0;
    let samples: Vec<f32> = (0..frames(length))
        .map(|n| {
            let t = seconds(n);
            let frequency = pitch * (1.0 + 0.12 * decay(t, 0.012));
            let skin = phase.sin() + (phase * 2.02).sin() * 0.18 * decay(t, 0.02);
            phase += TAU * frequency / RATE;
            let hand = slap.process(noise.next()) * decay(t, 0.005) * 1.6;
            (skin * decay(t, hold) + hand) * (t / 0.001).min(1.0)
        })
        .collect();
    finish(samples)
}

/// Maracas: seeds against a shell, a short swell of high hiss.
fn maracas() -> Vec<f32> {
    let mut noise = Noise::seeded(7);
    let mut band = BandPass::new(6_800.0, 0.8);
    let mut high = OnePole::new(4_000.0);
    let samples: Vec<f32> = (0..frames(0.11))
        .map(|n| {
            let t = seconds(n);
            let seeds = band.process(high.high_pass(noise.next()));
            // It builds as the seeds land, then falls away.
            let swell = (t / 0.009).min(1.0);
            seeds * swell * decay((t - 0.009).max(0.0), 0.022)
        })
        .collect();
    finish(samples)
}

/// Claves: two hardwood sticks, a high, pure knock that barely rings.
fn claves() -> Vec<f32> {
    let samples: Vec<f32> = (0..frames(0.12))
        .map(|n| {
            let t = seconds(n);
            let tone =
                (TAU * 2_480.0 * t).sin() + (TAU * 6_710.0 * t).sin() * 0.12 * decay(t, 0.004);
            tone * decay(t, 0.026) * (t / 0.0004).min(1.0)
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

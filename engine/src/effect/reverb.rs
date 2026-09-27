//! The Reverb Effect: Freeverb (Jezar's public-domain design), with its
//! controls rebuilt so each does one thing.
//!
//! Eight parallel damped comb filters feed four series all-pass filters per
//! side; the right side's delays are slightly longer, which is what makes the
//! mono input come out wide. Size scales every delay line, so a bigger room
//! has sparser, later echoes. Decay is the time the tail takes to fall 60 dB:
//! each comb's feedback is worked out from its own length so it loses 60 dB
//! in that time, which keeps the tail's length the same whatever the size.
//! A pre-delay line holds the input back before it reaches the room.

use super::params::{Param, Settings, number};
use crate::dsp::flush_denormal;

/// Delay lengths in samples at 44.1 kHz, as Freeverb tunes them.
const COMB_TUNING: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING: [usize; 4] = [556, 441, 341, 225];
const STEREO_SPREAD: usize = 23;
const TUNING_RATE: f32 = 44_100.0;

const INPUT_GAIN: f32 = 0.015;
const ALLPASS_FEEDBACK: f32 = 0.5;
/// Freeverb's scaling of the wet signal, so a fully wet tail is about as
/// loud as the dry signal it replaces.
const WET_GAIN: f32 = 3.0;

/// Size 0 plays the delays at half Freeverb's tuning, size 1 at one and a
/// half times it; the default, 0.5, is Freeverb's own room.
const SMALLEST_ROOM: f32 = 0.5;
const LARGEST_ROOM: f32 = 1.5;
const MAX_PRE_DELAY_MS: f32 = 200.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReverbSettings {
    /// 0..=1: how big the room is, which spaces out its echoes.
    pub size: f32,
    /// Seconds for the tail to fall by 60 dB (RT60).
    pub decay: f32,
    /// 0..=1: how much faster high frequencies die away than low ones.
    pub damping: f32,
    /// Milliseconds before the tail starts.
    pub pre_delay: f32,
    /// 0..=1: stereo width of the tail.
    pub width: f32,
    /// 0..=1: 0 is only the dry signal, 1 only the tail.
    pub mix: f32,
}

impl Default for ReverbSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Reverb, in the order a host sends them.
#[rustfmt::skip]
pub const REVERB_PARAMS: &[Param<ReverbSettings>] = &[
    number("size", "Size", "", (0.0, 1.0, 0.5),
        |s| s.size, |s, v| s.size = v),
    number("decay", "Decay", "s", (0.1, 10.0, 2.0),
        |s| s.decay, |s, v| s.decay = v),
    number("damping", "Damping", "", (0.0, 1.0, 0.5),
        |s| s.damping, |s, v| s.damping = v),
    number("preDelay", "Pre-delay", "ms", (0.0, MAX_PRE_DELAY_MS, 0.0),
        |s| s.pre_delay, |s, v| s.pre_delay = v),
    number("width", "Width", "", (0.0, 1.0, 1.0),
        |s| s.width, |s, v| s.width = v),
    number("mix", "Mix", "", (0.0, 1.0, 0.25),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for ReverbSettings {
    const PARAMS: &'static [Param<Self>] = REVERB_PARAMS;

    fn zeroed() -> Self {
        Self {
            size: 0.0,
            decay: 0.0,
            damping: 0.0,
            pre_delay: 0.0,
            width: 0.0,
            mix: 0.0,
        }
    }
}

/// A delay line allocated for the largest room, played at any length up to
/// that, so changing the size never allocates.
#[derive(Clone, Debug)]
struct Delay {
    buffer: Vec<f32>,
    length: usize,
    index: usize,
}

impl Delay {
    fn new(capacity: usize) -> Self {
        Self {
            buffer: vec![0.0; capacity.max(1)],
            length: capacity.max(1),
            index: 0,
        }
    }

    fn set_length(&mut self, length: usize) {
        self.length = length.clamp(1, self.buffer.len());
        if self.index >= self.length {
            self.index = 0;
        }
    }

    /// The sample written `length` samples ago.
    fn read(&self) -> f32 {
        self.buffer[self.index]
    }

    /// Replace the sample just read, and move on.
    fn write(&mut self, value: f32) {
        self.buffer[self.index] = value;
        self.index += 1;
        if self.index == self.length {
            self.index = 0;
        }
    }
}

#[derive(Clone, Debug)]
struct Comb {
    delay: Delay,
    /// Freeverb's length for this comb at the sample rate, before the size.
    tuning: f32,
    feedback: f32,
    filter_store: f32,
}

impl Comb {
    fn new(tuning: f32) -> Self {
        Self {
            delay: Delay::new((tuning * LARGEST_ROOM).ceil() as usize),
            tuning,
            feedback: 0.0,
            filter_store: 0.0,
        }
    }

    /// Scale the length by `room`, and set the feedback so that a trip
    /// round the loop loses its share of 60 dB over `decay_samples`.
    fn tune(&mut self, room: f32, decay_samples: f32) {
        self.delay.set_length((self.tuning * room) as usize);
        let length = self.delay.length as f32;
        self.feedback = 10f32.powf(-3.0 * length / decay_samples);
    }

    fn process(&mut self, input: f32, damping: f32) -> f32 {
        let output = self.delay.read();
        self.filter_store = flush_denormal(output * (1.0 - damping) + self.filter_store * damping);
        self.delay
            .write(flush_denormal(input + self.filter_store * self.feedback));
        output
    }
}

#[derive(Clone, Debug)]
struct AllPass {
    delay: Delay,
    tuning: f32,
}

impl AllPass {
    fn new(tuning: f32) -> Self {
        Self {
            delay: Delay::new((tuning * LARGEST_ROOM).ceil() as usize),
            tuning,
        }
    }

    fn tune(&mut self, room: f32) {
        self.delay.set_length((self.tuning * room) as usize);
    }

    fn process(&mut self, input: f32) -> f32 {
        let delayed = self.delay.read();
        self.delay
            .write(flush_denormal(input + delayed * ALLPASS_FEEDBACK));
        delayed - input
    }
}

#[derive(Clone, Debug)]
struct Side {
    combs: Vec<Comb>,
    allpasses: Vec<AllPass>,
}

impl Side {
    fn new(sample_rate: f32, spread: usize) -> Self {
        let scale = |length: usize| (length + spread) as f32 * sample_rate / TUNING_RATE;
        Self {
            combs: COMB_TUNING.iter().map(|&l| Comb::new(scale(l))).collect(),
            allpasses: ALLPASS_TUNING
                .iter()
                .map(|&l| AllPass::new(scale(l)))
                .collect(),
        }
    }

    fn tune(&mut self, room: f32, decay_samples: f32) {
        for comb in &mut self.combs {
            comb.tune(room, decay_samples);
        }
        for allpass in &mut self.allpasses {
            allpass.tune(room);
        }
    }

    fn process(&mut self, input: f32, damping: f32) -> f32 {
        let combed: f32 = self
            .combs
            .iter_mut()
            .map(|comb| comb.process(input, damping))
            .sum();
        self.allpasses
            .iter_mut()
            .fold(combed, |signal, allpass| allpass.process(signal))
    }
}

/// Stereo in, fed to the room as mono; stereo out.
#[derive(Clone, Debug)]
pub struct Reverb {
    settings: ReverbSettings,
    sample_rate: f32,
    pre_delay: Vec<f32>,
    pre_delay_write: usize,
    pre_delay_samples: usize,
    left: Side,
    right: Side,
    damping: f32,
    wet_same_side: f32,
    wet_other_side: f32,
    dry: f32,
}

impl Reverb {
    pub fn new(sample_rate: f32, settings: ReverbSettings) -> Self {
        let longest_pre_delay = (MAX_PRE_DELAY_MS / 1000.0 * sample_rate).ceil() as usize;
        let mut reverb = Self {
            settings,
            sample_rate,
            pre_delay: vec![0.0; longest_pre_delay + 1],
            pre_delay_write: 0,
            pre_delay_samples: 0,
            left: Side::new(sample_rate, 0),
            right: Side::new(sample_rate, STEREO_SPREAD),
            damping: 0.0,
            wet_same_side: 0.0,
            wet_other_side: 0.0,
            dry: 0.0,
        };
        reverb.set_settings(settings);
        reverb
    }

    pub fn settings(&self) -> ReverbSettings {
        self.settings
    }

    /// Change the settings while running. Every delay line was allocated for
    /// the largest room and the longest pre-delay, so nothing allocates and
    /// the tail rings on.
    pub fn set_settings(&mut self, settings: ReverbSettings) {
        // Each setting brought into its range, as the table gives it.
        let mut clamped = settings;
        for param in REVERB_PARAMS {
            param.set(&mut clamped, param.get(&settings));
        }
        let ReverbSettings {
            size,
            decay,
            damping,
            pre_delay,
            width,
            mix,
        } = clamped;

        self.settings = clamped;
        let room = SMALLEST_ROOM + size * (LARGEST_ROOM - SMALLEST_ROOM);
        let decay_samples = decay * self.sample_rate;
        self.left.tune(room, decay_samples);
        self.right.tune(room, decay_samples);
        // Freeverb's scaling of its damping control.
        self.damping = damping * 0.4;
        self.pre_delay_samples = (pre_delay / 1000.0 * self.sample_rate).round() as usize;
        let wet = mix * WET_GAIN;
        self.wet_same_side = wet * (width / 2.0 + 0.5);
        self.wet_other_side = wet * ((1.0 - width) / 2.0);
        self.dry = 1.0 - mix;
    }

    /// Reverberate the stereo signal in `input_left` and `input_right`,
    /// adding the result (dry and wet) to `left` and `right` scaled by
    /// `gain`, so several Tracks can share one output. The dry signal keeps
    /// its sides, and the tail is fed the middle, as Freeverb's design
    /// expects.
    pub fn process_stereo_into(
        &mut self,
        input_left: &[f32],
        input_right: &[f32],
        left: &mut [f32],
        right: &mut [f32],
        gain: f32,
    ) {
        let length = self.pre_delay.len();
        let input = input_left.iter().zip(input_right);
        for (((&x, &y), l), r) in input.zip(left.iter_mut()).zip(right.iter_mut()) {
            self.pre_delay[self.pre_delay_write] = 0.5 * (x + y) * INPUT_GAIN;
            let read = (self.pre_delay_write + length - self.pre_delay_samples) % length;
            let feed = self.pre_delay[read];
            self.pre_delay_write = (self.pre_delay_write + 1) % length;

            let wet_left = self.left.process(feed, self.damping);
            let wet_right = self.right.process(feed, self.damping);
            *l += gain
                * (wet_left * self.wet_same_side + wet_right * self.wet_other_side + x * self.dry);
            *r += gain
                * (wet_right * self.wet_same_side + wet_left * self.wet_other_side + y * self.dry);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, rising_zero_crossings, rms};

    const RATE: f32 = 48_000.0;

    fn wet_only() -> ReverbSettings {
        ReverbSettings {
            mix: 1.0,
            pre_delay: 0.0,
            ..ReverbSettings::default()
        }
    }

    fn impulse_response(settings: ReverbSettings, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut reverb = Reverb::new(RATE, settings);
        let mut input = vec![0.0; frames];
        input[0] = 1.0;
        let mut left = vec![0.0; frames];
        let mut right = vec![0.0; frames];
        reverb.process_stereo_into(&input, &input, &mut left, &mut right, 1.0);
        (left, right)
    }

    /// A repeatable noise, so the tests don't depend on a random crate.
    fn noise(frames: usize, seed: u32) -> Vec<f32> {
        let mut state = seed.wrapping_mul(2_654_435_761).max(1);
        (0..frames)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as f32 / u32::MAX as f32 * 2.0 - 1.0
            })
            .collect()
    }

    /// The time the tail takes to fall 60 dB, from Schroeder's backward
    /// integration of its energy: the time from -5 dB to -25 dB, times three.
    fn rt60(response: &[f32]) -> f32 {
        let mut energy: Vec<f64> = response
            .iter()
            .map(|&s| f64::from(s) * f64::from(s))
            .collect();
        for i in (0..energy.len() - 1).rev() {
            energy[i] += energy[i + 1];
        }
        let total = energy[0];
        let crossing = |db: f64| {
            let level = total * 10f64.powf(db / 10.0);
            energy.iter().position(|&e| e < level).unwrap()
        };
        3.0 * (crossing(-25.0) - crossing(-5.0)) as f32 / RATE
    }

    fn first_sound(buffer: &[f32]) -> usize {
        buffer.iter().position(|s| s.abs() > 1e-9).unwrap()
    }

    #[test]
    fn the_tail_decays_in_about_the_decay_time() {
        for decay in [0.5, 1.0, 2.0, 4.0, 8.0] {
            let frames = ((decay * 1.5 + 0.5) * RATE) as usize;
            let settings = ReverbSettings {
                decay,
                damping: 0.0,
                ..wet_only()
            };
            let (left, right) = impulse_response(settings, frames);
            for side in [left, right] {
                let measured = rt60(&side);
                let ratio = measured / decay;
                assert!(
                    (0.8..1.25).contains(&ratio),
                    "decay {decay}s measured {measured}s"
                );
            }
        }
    }

    #[test]
    fn the_decay_holds_whatever_the_size() {
        for size in [0.0, 1.0] {
            let settings = ReverbSettings {
                size,
                damping: 0.0,
                ..wet_only()
            };
            let (left, _) = impulse_response(settings, 4 * 48_000);
            let measured = rt60(&left);
            assert!((1.6..2.5).contains(&measured), "size {size}: {measured}s");
        }
    }

    #[test]
    fn a_longer_decay_rings_longer() {
        let tail = |decay| {
            let (left, _) = impulse_response(
                ReverbSettings {
                    decay,
                    ..wet_only()
                },
                2 * 48_000,
            );
            rms(&left[48_000..])
        };
        assert!(tail(4.0) > 10.0 * tail(0.5));
    }

    #[test]
    fn no_mix_passes_the_input_unchanged() {
        let settings = ReverbSettings {
            size: 1.0,
            decay: 10.0,
            damping: 0.9,
            pre_delay: 0.0,
            width: 0.3,
            mix: 0.0,
        };
        let mut reverb = Reverb::new(RATE, settings);
        const FRAMES: usize = 256 * 200;
        let (input_left, input_right) = (noise(FRAMES, 1), noise(FRAMES, 2));
        let mut left = vec![0.0; FRAMES];
        let mut right = vec![0.0; FRAMES];
        for start in (0..FRAMES).step_by(256) {
            let block = start..start + 256;
            reverb.process_stereo_into(
                &input_left[block.clone()],
                &input_right[block.clone()],
                &mut left[block.clone()],
                &mut right[block],
                1.0,
            );
        }
        assert_eq!(left, input_left);
        assert_eq!(right, input_right);
    }

    #[test]
    fn a_full_mix_is_only_the_tail() {
        let (left, right) = impulse_response(wet_only(), 1_000);
        // The all-passes let a little of the input straight through, but not
        // the dry signal's full level.
        assert!(left[0].abs() < 0.1 && right[0].abs() < 0.1);
    }

    #[test]
    fn the_mix_crossfades_dry_and_wet() {
        let (half, _) = impulse_response(
            ReverbSettings {
                mix: 0.5,
                pre_delay: 0.0,
                ..ReverbSettings::default()
            },
            48_000,
        );
        let (wet, _) = impulse_response(wet_only(), 48_000);
        assert!((half[0] - (0.5 + wet[0] / 2.0)).abs() < 1e-6);
        assert!((rms(&half[4_800..]) - rms(&wet[4_800..]) / 2.0).abs() < 1e-6);
    }

    #[test]
    fn pre_delay_holds_the_tail_back() {
        let onset = |pre_delay| {
            let (left, _) = impulse_response(
                ReverbSettings {
                    pre_delay,
                    ..wet_only()
                },
                48_000,
            );
            first_sound(&left)
        };
        assert_eq!(onset(50.0) - onset(0.0), 2_400);
        assert_eq!(onset(200.0) - onset(0.0), 9_600);
    }

    #[test]
    fn a_bigger_room_spaces_its_echoes_out() {
        // The first echo is the shortest comb coming back round.
        let first_echo = |size| {
            let (left, _) = impulse_response(ReverbSettings { size, ..wet_only() }, 48_000);
            // Past the all-passes' immediate response to the impulse.
            let later = &left[1..];
            1 + later.iter().position(|s| s.abs() > 1e-4).unwrap()
        };
        let (small, middle, large) = (first_echo(0.0), first_echo(0.5), first_echo(1.0));
        assert!(small < middle && middle < large, "{small} {middle} {large}");
        assert!(large > 2 * small);
    }

    #[test]
    fn damping_darkens_the_tail() {
        let late_crossings = |damping| {
            let (left, _) = impulse_response(
                ReverbSettings {
                    damping,
                    ..wet_only()
                },
                2 * 48_000,
            );
            rising_zero_crossings(&left[24_000..])
        };
        assert!(late_crossings(1.0) < late_crossings(0.0) * 3 / 4);
    }

    #[test]
    fn width_spreads_the_tail_and_none_is_mono() {
        let difference = |width| {
            let (left, right) = impulse_response(
                ReverbSettings {
                    width,
                    ..wet_only()
                },
                48_000,
            );
            let diff: Vec<f32> = left.iter().zip(&right).map(|(l, r)| l - r).collect();
            peak(&diff)
        };
        assert!(difference(1.0) > 1e-3);
        assert!(difference(0.0) < 1e-7);
    }

    #[test]
    fn settings_come_into_range_and_change_while_running() {
        let mut reverb = Reverb::new(RATE, ReverbSettings::default());
        let input = noise(4_800, 3);
        let mut left = vec![0.0; 4_800];
        let mut right = vec![0.0; 4_800];
        reverb.process_stereo_into(&input, &input, &mut left, &mut right, 1.0);
        reverb.set_settings(ReverbSettings {
            size: 7.0,
            decay: f32::NAN,
            pre_delay: 1_000.0,
            mix: -1.0,
            ..ReverbSettings::default()
        });
        let settings = reverb.settings();
        assert_eq!(settings.size, 1.0);
        assert_eq!(settings.decay, 2.0);
        assert_eq!(settings.pre_delay, 200.0);
        assert_eq!(settings.mix, 0.0);
        reverb.set_settings(ReverbSettings {
            size: 0.0,
            mix: 1.0,
            ..ReverbSettings::default()
        });
        reverb.process_stereo_into(&input, &input, &mut left, &mut right, 1.0);
        assert!(left.iter().chain(&right).all(|s| s.is_finite()));
        assert!(rms(&left) > 1e-3, "the tail rang on");
    }

    /// The load test (#5) plays 16 Tracks, each running the Synth, EQ,
    /// Compressor and Reverb, and a callback is late when rendering it takes
    /// longer than the block lasts. So 16 Reverbs at their costliest must
    /// leave at least half of that budget to the rest; they take about a
    /// tenth of it, and the gap is what keeps this steady on a busy CI box.
    #[test]
    fn sixteen_reverbs_fit_in_the_load_budget() {
        const BLOCK: usize = 256;
        const SECONDS: usize = 10;
        let costliest = ReverbSettings {
            size: 1.0,
            decay: 10.0,
            pre_delay: 200.0,
            ..ReverbSettings::default()
        };
        let mut reverbs: Vec<Reverb> = (0..16).map(|_| Reverb::new(RATE, costliest)).collect();
        let inputs: Vec<Vec<f32>> = (0..16).map(|i| noise(BLOCK, i)).collect();
        let mut left = vec![0.0; BLOCK];
        let mut right = vec![0.0; BLOCK];

        let blocks = SECONDS * RATE as usize / BLOCK;
        let started = std::time::Instant::now();
        for _ in 0..blocks {
            left.fill(0.0);
            right.fill(0.0);
            for (reverb, input) in reverbs.iter_mut().zip(&inputs) {
                reverb.process_stereo_into(input, input, &mut left, &mut right, 1.0 / 16.0);
            }
        }
        let elapsed = started.elapsed().as_secs_f64();

        let audio = (blocks * BLOCK) as f64 / f64::from(RATE);
        assert!(left.iter().all(|s| s.is_finite()));
        assert!(
            elapsed < audio / 2.0,
            "16 Reverbs took {elapsed:.2}s for {audio:.1}s of audio"
        );
    }
}

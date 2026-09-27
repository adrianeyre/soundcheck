//! A bitcrusher: an example Plugin **Effect**, written only against the
//! Soundcheck SDK and its docs.
//!
//! It rounds every sample to a multiple of `2 / 2^bits`, as a converter
//! with that many bits would, and holds each for `hold` frames, which is
//! what running at a lower sample rate sounds like.
//! `mix` blends the crushed sound with the dry one.

use soundcheck_sdk::{Effect, Manifest, Setting};

pub const ID: &str = "dev.soundcheck.example.bitcrusher";

/// Where each setting is in [`Bitcrusher::MANIFEST`], the numbers `set` gets.
const BITS: usize = 0;
const HOLD: usize = 1;
const MIX: usize = 2;

pub struct Bitcrusher {
    /// Half the number of levels: a sample becomes a multiple of `1 / steps`.
    steps: f32,
    hold: u32,
    mix: f32,
    /// The crushed sample each side holds, and for how many more frames.
    held: [f32; 2],
    left_to_hold: u32,
}

impl Effect for Bitcrusher {
    const MANIFEST: Manifest = Manifest {
        id: ID,
        version: "1.0.0",
        name: "Bitcrusher",
        settings: &[
            Setting::number("bits", "Bits", "bits", 1.0, 16.0, 8.0).stepped(1.0),
            Setting::number("hold", "Hold", "frames", 1.0, 32.0, 1.0).stepped(1.0),
            Setting::number("mix", "Mix", "", 0.0, 1.0, 1.0),
        ],
    };

    // Every setting is sent to `set` with its default before the first
    // block, so these starting values are never heard.
    fn new(_sample_rate: f32, _max_frames: usize) -> Self {
        Bitcrusher {
            steps: 1.0,
            hold: 1,
            mix: 1.0,
            held: [0.0; 2],
            left_to_hold: 0,
        }
    }

    fn set(&mut self, index: usize, value: f32) {
        match index {
            BITS => self.steps = 2.0_f32.powf(value - 1.0),
            HOLD => self.hold = value as u32,
            MIX => self.mix = value,
            _ => {}
        }
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (l, r) in left.iter_mut().zip(right) {
            if self.left_to_hold == 0 {
                self.held = [self.crush(*l), self.crush(*r)];
                self.left_to_hold = self.hold;
            }
            self.left_to_hold -= 1;
            *l += (self.held[0] - *l) * self.mix;
            *r += (self.held[1] - *r) * self.mix;
        }
    }

    fn reset(&mut self) {
        self.held = [0.0; 2];
        self.left_to_hold = 0;
    }
}

impl Bitcrusher {
    /// The nearest of the levels, from -1 to 1.
    fn crush(&self, sample: f32) -> f32 {
        ((sample * self.steps).round() / self.steps).clamp(-1.0, 1.0)
    }
}

soundcheck_sdk::export_effect!(Bitcrusher);

#[cfg(test)]
mod tests {
    use super::*;

    /// A bitcrusher with its settings at their defaults, as the host makes it.
    fn bitcrusher() -> Bitcrusher {
        let mut effect = Bitcrusher::new(48_000.0, 128);
        for (index, setting) in Bitcrusher::MANIFEST.settings.iter().enumerate() {
            effect.set(index, setting.default);
        }
        effect
    }

    fn ramp() -> [Vec<f32>; 2] {
        let left: Vec<f32> = (0..128).map(|i| i as f32 / 64.0 - 1.0).collect();
        let right = left.iter().map(|sample| -sample).collect();
        [left, right]
    }

    #[test]
    fn it_rounds_every_sample_to_one_of_its_levels() {
        let mut effect = bitcrusher();
        effect.set(BITS, 3.0);
        let [mut left, mut right] = ramp();
        effect.process(&mut left, &mut right);
        for sample in left.iter().chain(&right) {
            assert_eq!((sample * 4.0).fract(), 0.0, "{sample} is a multiple of 1/4");
        }
        assert_eq!(left[0], -1.0);
        assert_eq!(left[127], 1.0);
    }

    #[test]
    fn it_holds_each_crushed_sample_for_hold_frames_across_blocks() {
        let mut effect = bitcrusher();
        effect.set(BITS, 16.0);
        effect.set(HOLD, 3.0);
        let [mut left, mut right] = ramp();
        let (first, second) = left.split_at_mut(64);
        let (first_right, second_right) = right.split_at_mut(64);
        effect.process(first, first_right);
        effect.process(second, second_right);
        for frames in left.chunks(3) {
            assert!(
                frames.iter().all(|sample| *sample == frames[0]),
                "{frames:?}"
            );
        }
        assert_ne!(left[0], left[3]);
    }

    #[test]
    fn at_no_mix_it_passes_the_audio_through() {
        let mut effect = bitcrusher();
        effect.set(BITS, 1.0);
        effect.set(MIX, 0.0);
        let [mut left, mut right] = ramp();
        effect.process(&mut left, &mut right);
        assert_eq!([left, right], ramp());
    }

    #[test]
    fn reset_forgets_the_held_sample() {
        let mut effect = bitcrusher();
        effect.set(HOLD, 32.0);
        let (mut left, mut right) = ([0.5; 4], [0.5; 4]);
        effect.process(&mut left, &mut right);
        effect.reset();
        let (mut left, mut right) = ([-0.25; 4], [-0.25; 4]);
        effect.process(&mut left, &mut right);
        assert_eq!(left, [-0.25; 4]);
    }
}

//! The Plugin **Effect** the hosts are tested with: the same module has to
//! render the same samples through wasmtime **[desktop]** and through the
//! browser's `WebAssembly`, and both are checked against
//! `expected-output.json`.
//!
//! Its DSP only adds, multiplies and divides, which WebAssembly and Rust
//! both round exactly as IEEE 754 says, so this crate's own test can check
//! the expected output natively too. It keeps a little state (a one-pole
//! filter) so that a host which forgets it, or resets it, sounds wrong.

use soundcheck_sdk::{Effect, Manifest, Setting};

pub const ID: &str = "dev.soundcheck.test.effect";

/// Smooths, widens and scales: one of each kind of setting a host handles.
pub struct TestEffect {
    gain: f32,
    smooth: f32,
    width: f32,
    state: [f32; 2],
}

impl Effect for TestEffect {
    const MANIFEST: Manifest = Manifest {
        id: ID,
        version: "1.0.0",
        name: "Test Effect",
        settings: &[
            Setting::number("gain", "Gain", "x", 0.0, 2.0, 1.0),
            Setting::number("smooth", "Smooth", "", 0.0, 0.95, 0.5),
            Setting::number("width", "Width", "", 0.0, 2.0, 1.0).stepped(0.25),
        ],
    };

    fn new(_sample_rate: f32, _max_frames: usize) -> Self {
        Self {
            gain: 1.0,
            smooth: 0.5,
            width: 1.0,
            state: [0.0; 2],
        }
    }

    fn set(&mut self, index: usize, value: f32) {
        match index {
            0 => self.gain = value,
            1 => self.smooth = value,
            2 => self.width = value,
            _ => {}
        }
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let follow = 1.0 - self.smooth;
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            self.state[0] += follow * (*l - self.state[0]);
            self.state[1] += follow * (*r - self.state[1]);
            let mid = (self.state[0] + self.state[1]) * 0.5;
            let side = (self.state[0] - self.state[1]) * 0.5 * self.width;
            *l = (mid + side) * self.gain;
            *r = (mid - side) * self.gain;
        }
    }

    fn reset(&mut self) {
        self.state = [0.0; 2];
    }
}

soundcheck_sdk::export_effect!(TestEffect);

/// What the render test plays through the Plugin: a noise every host can
/// make exactly, since each sample is a multiple of 2^-23.
pub fn input(frames: usize, seed: u32) -> [Vec<f32>; 2] {
    let mut state = seed;
    let mut next = move || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        ((state >> 8) as f32 / 16_777_216.0) * 2.0 - 1.0
    };
    let mut left = Vec::with_capacity(frames);
    let mut right = Vec::with_capacity(frames);
    for _ in 0..frames {
        left.push(next());
        right.push(next());
    }
    [left, right]
}

/// The render every host is checked against: `expected-output.json` holds
/// the recipe (the input's seed, the block size, and which setting changes
/// before which block) and the samples it makes.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const EXPECTED: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/expected-output.json");

    fn recipe() -> Value {
        json!({
            "sampleRate": 48_000,
            "seed": 1,
            "blockFrames": 128,
            "blocks": 4,
            "changes": [
                { "block": 1, "index": 0, "value": 1.5 },
                { "block": 2, "index": 2, "value": 0.5 },
                { "block": 3, "index": 1, "value": 0.25 },
            ],
        })
    }

    fn render(recipe: &Value) -> [Vec<f32>; 2] {
        let number = |key: &str| recipe[key].as_u64().unwrap() as usize;
        let (block_frames, blocks) = (number("blockFrames"), number("blocks"));
        let [mut left, mut right] = input(block_frames * blocks, number("seed") as u32);
        let mut effect = TestEffect::new(number("sampleRate") as f32, block_frames);
        let blocks = left
            .chunks_mut(block_frames)
            .zip(right.chunks_mut(block_frames));
        for (block, (left, right)) in blocks.enumerate() {
            for change in recipe["changes"].as_array().unwrap() {
                if change["block"].as_u64() == Some(block as u64) {
                    let index = change["index"].as_u64().unwrap() as usize;
                    effect.set(index, change["value"].as_f64().unwrap() as f32);
                }
            }
            effect.process(left, right);
        }
        [left, right]
    }

    #[test]
    fn the_expected_output_is_what_the_dsp_renders() {
        let [left, right] = render(&recipe());
        if std::env::var_os("BLESS").is_some() {
            let mut expected = recipe();
            expected["left"] = json!(left);
            expected["right"] = json!(right);
            std::fs::write(EXPECTED, format!("{expected}\n")).unwrap();
        }
        let expected: Value =
            serde_json::from_str(&std::fs::read_to_string(EXPECTED).unwrap()).unwrap();
        let mut recipe_only = expected.clone();
        let object = recipe_only.as_object_mut().unwrap();
        object.remove("left");
        object.remove("right");
        assert_eq!(recipe_only, recipe(), "the recipe the hosts follow");
        let side = |name: &str| -> Vec<f32> {
            let samples = expected[name].as_array().unwrap();
            samples.iter().map(|s| s.as_f64().unwrap() as f32).collect()
        };
        assert_eq!(side("left").len(), 512);
        let bits = |side: &[f32]| side.iter().map(|s| s.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&side("left")), bits(&left), "sample for sample");
        assert_eq!(bits(&side("right")), bits(&right), "sample for sample");
    }

    #[test]
    fn it_keeps_state_until_reset() {
        let mut effect = TestEffect::new(48_000.0, 4);
        let (mut left, mut right) = ([1.0; 2], [1.0; 2]);
        effect.process(&mut left, &mut right);
        assert_eq!(left, [0.5, 0.75]);
        effect.reset();
        let (mut left, mut right) = ([1.0; 2], [1.0; 2]);
        effect.process(&mut left, &mut right);
        assert_eq!(left, [0.5, 0.75]);
    }
}

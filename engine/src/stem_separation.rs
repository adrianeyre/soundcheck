//! **Stem Separation**'s math around the model (ADR 0005), shared by the
//! Desktop App, which runs htdemucs on ONNX Runtime natively, and the
//! Browser Version, which runs it on ONNX Runtime Web: the engine knows
//! nothing of the model, only of the audio going in and the Stems coming out.
//!
//! As Demucs's own `separate.py`, which the spike (`spikes/stem-separation/`)
//! measured: standardise by the mono mix, cut 7.8 s chunks overlapping by a
//! quarter, cross-fade the model's Stems for each with a triangular weight,
//! and undo the standardisation. The model runs between `chunk` and `add`,
//! one chunk at a time, however the host runs it.

use wasm_bindgen::prelude::*;

use crate::{PreparedAudioFile, SampleFormat, wav_bytes};

/// htdemucs' Stems, in the order of its output.
pub const STEM_NAMES: [&str; 4] = ["drums", "bass", "other", "vocals"];
/// The rate htdemucs was trained at. The Stems come out at it, whatever the
/// source's rate.
pub const STEM_SAMPLE_RATE: u32 = 44_100;
/// htdemucs' training segment, 7.8 s: the length the exported model takes.
pub const SEGMENT: usize = 343_980;
/// The shapes that make a model htdemucs as Mixxx exports it.
pub const MODEL_INPUT_SHAPE: [i64; 3] = [1, 2, SEGMENT as i64];
pub const MODEL_OUTPUT_SHAPE: [i64; 4] = [1, STEM_NAMES.len() as i64, 2, SEGMENT as i64];
/// Demucs's default overlap between chunks.
const OVERLAP: f64 = 0.25;
/// How far apart the chunks start.
const STRIDE: usize = ((1.0 - OVERLAP) * SEGMENT as f64) as usize;

/// One song being separated: its standardised audio, cut into chunks for
/// the model, and the Stems built up from what the model gives back.
#[wasm_bindgen]
pub struct StemSeparation {
    input: [Vec<f32>; 2],
    mean: f64,
    std: f64,
    /// The cross-fade across a chunk, peaking at 1 in its middle.
    weight: Vec<f32>,
    stems: Vec<[Vec<f32>; 2]>,
    total_weight: Vec<f32>,
    added: Vec<bool>,
}

impl StemSeparation {
    /// Start separating stereo audio at `STEM_SAMPLE_RATE`.
    pub fn new([left, right]: [&[f32]; 2]) -> Result<Self, String> {
        let frames = left.len();
        if frames == 0 || right.len() != frames {
            return Err("There's no audio to separate.".into());
        }

        // As Demucs's `Separator.separate_tensor` (api.py): standardise by
        // the mono mix, its standard deviation unbiased and nudged off zero,
        // and undo it after.
        let mono = || {
            left.iter()
                .zip(right)
                .map(|(&l, &r)| f64::from(l + r) / 2.0)
        };
        let mean = mono().sum::<f64>() / frames as f64;
        let variance =
            mono().map(|s| (s - mean).powi(2)).sum::<f64>() / (frames as f64 - 1.0).max(1.0);
        let std = variance.sqrt() + 1e-8;
        let input = [left, right].map(|side| {
            side.iter()
                .map(|&s| ((f64::from(s) - mean) / std) as f32)
                .collect::<Vec<_>>()
        });

        // As Demucs's apply_model with split: a triangular weight, peaking
        // at 1, to cross-fade the overlapping chunks with.
        let mut weight: Vec<f32> = (1..=SEGMENT / 2)
            .chain((1..=SEGMENT - SEGMENT / 2).rev())
            .map(|w| w as f32)
            .collect();
        let peak = weight.iter().copied().fold(0.0, f32::max);
        weight.iter_mut().for_each(|w| *w /= peak);

        Ok(Self {
            input,
            mean,
            std,
            weight,
            stems: vec![[vec![0.0; frames], vec![0.0; frames]]; STEM_NAMES.len()],
            total_weight: vec![0.0; frames],
            added: vec![false; frames.div_ceil(STRIDE)],
        })
    }

    /// How many chunks the model runs on: one every `STRIDE` frames.
    pub fn chunks(&self) -> usize {
        self.added.len()
    }

    /// Where chunk `index` starts in the audio, how much of it is audio, and
    /// how far into the chunk that is: centred, as Demucs's
    /// `TensorChunk.padded`.
    fn place(&self, index: usize) -> (usize, usize, usize) {
        let frames = self.total_weight.len();
        let offset = index * STRIDE;
        let length = SEGMENT.min(frames - offset);
        (offset, length, (SEGMENT - length) / 2)
    }

    /// Fill `into`, `2 * SEGMENT` long, with chunk `index`: the model's
    /// input, its left side then its right. The audio either side is there
    /// too where there is some, and silence past the ends.
    pub fn fill_chunk(&self, index: usize, into: &mut [f32]) {
        let (offset, _, pad) = self.place(index);
        let start = offset as isize - pad as isize;
        for (samples, chunk) in self.input.iter().zip(into.as_chunks_mut::<SEGMENT>().0) {
            for (i, sample) in chunk.iter_mut().enumerate() {
                let at = start + i as isize;
                *sample = usize::try_from(at)
                    .ok()
                    .and_then(|at| samples.get(at))
                    .copied()
                    .unwrap_or(0.0);
            }
        }
    }

    /// Add the model's output for chunk `index`: `4 * 2 * SEGMENT` long,
    /// Stem by Stem in `STEM_NAMES`' order, each its left side then its right.
    pub fn add(&mut self, index: usize, output: &[f32]) -> Result<(), String> {
        if output.len() != STEM_NAMES.len() * 2 * SEGMENT {
            return Err(format!(
                "The model gave Stems of {} samples, where htdemucs' shape {MODEL_OUTPUT_SHAPE:?} is {}.",
                output.len(),
                STEM_NAMES.len() * 2 * SEGMENT
            ));
        }
        match self.added.get(index) {
            None => return Err(format!("There's no chunk {index} to add.")),
            Some(true) => return Err(format!("Chunk {index} was added already.")),
            Some(false) => self.added[index] = true,
        }
        let (offset, length, pad) = self.place(index);
        let weight = &self.weight[..length];
        let sides = self.stems.iter_mut().flat_map(|stem| stem.iter_mut());
        for (samples, out) in sides.zip(output.as_chunks::<SEGMENT>().0) {
            for ((sample, &value), &w) in samples[offset..][..length]
                .iter_mut()
                .zip(&out[pad..])
                .zip(weight)
            {
                *sample += value * w;
            }
        }
        for (total, &w) in self.total_weight[offset..][..length].iter_mut().zip(weight) {
            *total += w;
        }
        Ok(())
    }

    /// Stem `source` in `STEM_NAMES`' order, once every chunk is added:
    /// its two sides, taken out of the separation.
    pub fn take_stem(&mut self, source: usize) -> Result<[Vec<f32>; 2], String> {
        if let Some(missing) = self.added.iter().position(|&added| !added) {
            return Err(format!("Chunk {missing} hasn't been added yet."));
        }
        let stem = self
            .stems
            .get_mut(source)
            .ok_or_else(|| format!("htdemucs has no Stem {source}."))?;
        if stem[0].is_empty() {
            return Err(format!(
                "The {} Stem was taken already.",
                STEM_NAMES[source]
            ));
        }
        let mut stem = std::mem::take(stem);
        // As Demucs, each Stem gets the mean back, so they sum to the input
        // plus three means: a DC offset too small to hear in real audio.
        for side in &mut stem {
            for (sample, &total) in side.iter_mut().zip(&self.total_weight) {
                *sample = (f64::from(*sample / total) * self.std + self.mean) as f32;
            }
        }
        Ok(stem)
    }

    /// The four Stems, once every chunk is added.
    pub fn finish(mut self) -> Result<Vec<[Vec<f32>; 2]>, String> {
        (0..STEM_NAMES.len())
            .map(|source| self.take_stem(source))
            .collect()
    }
}

/// For the Browser Version, through the WASM build.
#[wasm_bindgen]
impl StemSeparation {
    /// Start separating an audio file's bytes (WAV, FLAC or MP3; mono is
    /// separated as stereo), decoded as the engine decodes every file and
    /// resampled to `STEM_SAMPLE_RATE`. Throws what is wrong with the file.
    pub fn from_audio_file(bytes: &[u8]) -> Result<StemSeparation, String> {
        let file = PreparedAudioFile::decode(bytes, STEM_SAMPLE_RATE as f32)
            .map_err(|error| error.message().to_owned())?;
        Self::new([file.left(), file.right()])
    }

    #[wasm_bindgen(js_name = chunks)]
    pub fn chunk_count(&self) -> usize {
        self.chunks()
    }

    /// Chunk `index`, the model's input: `[1, 2, SEGMENT]`, flat.
    pub fn chunk(&self, index: usize) -> Vec<f32> {
        let mut chunk = vec![0.0; 2 * SEGMENT];
        self.fill_chunk(index, &mut chunk);
        chunk
    }

    /// Add the model's output for chunk `index`, `[1, 4, 2, SEGMENT]` flat.
    /// Throws if it's the wrong length or the chunk was added already.
    #[wasm_bindgen(js_name = add)]
    pub fn add_output(&mut self, index: usize, output: &[f32]) -> Result<(), String> {
        self.add(index, output)
    }

    /// Stem `source` in `STEM_NAMES`' order as a 32-bit float stereo WAV
    /// file at `STEM_SAMPLE_RATE`, once every chunk is added. Each is taken
    /// out as it is asked for, so the four are never all held twice.
    pub fn stem_wav(&mut self, source: usize) -> Result<Vec<u8>, String> {
        let [left, right] = self.take_stem(source)?;
        let interleaved: Vec<f32> = left
            .iter()
            .zip(&right)
            .flat_map(|(&l, &r)| [l, r])
            .collect();
        Ok(wav_bytes(
            &interleaved,
            STEM_SAMPLE_RATE,
            SampleFormat::Float32,
        ))
    }
}

/// What the Browser Version checks a model and its Stems against, as JSON:
/// `{"sampleRate","stems","input","output"}`.
#[wasm_bindgen]
pub fn stem_separation_model() -> String {
    serde_json::json!({
        "sampleRate": STEM_SAMPLE_RATE,
        "stems": STEM_NAMES,
        "input": MODEL_INPUT_SHAPE,
        "output": MODEL_OUTPUT_SHAPE,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `seconds` of two tones and a slow sweep, different on each side, with
    /// a little DC so undoing the standardisation is tested.
    fn song(seconds: f64) -> [Vec<f32>; 2] {
        let frames = (seconds * f64::from(STEM_SAMPLE_RATE)) as usize;
        let side = |frequency: f64, level: f64| {
            (0..frames)
                .map(|i| {
                    let t = i as f64 / f64::from(STEM_SAMPLE_RATE);
                    let sweep = (std::f64::consts::TAU * 0.3 * t).sin() * 0.2;
                    (level * (std::f64::consts::TAU * frequency * t).sin() + sweep + 0.01) as f32
                })
                .collect()
        };
        [side(220.0, 0.5), side(330.0, 0.3)]
    }

    const WEIGHTS: [f32; 4] = [0.1, 0.2, 0.3, 0.4];

    /// A stand-in for htdemucs: Stem `k` is its input times `WEIGHTS[k]`.
    fn gains(chunk: &[f32]) -> Vec<f32> {
        WEIGHTS
            .iter()
            .flat_map(|&weight| chunk.iter().map(move |&s| s * weight))
            .collect()
    }

    /// Run `model` over every chunk of `input`, in order.
    fn separate(input: &[Vec<f32>; 2], model: impl Fn(&[f32]) -> Vec<f32>) -> Vec<[Vec<f32>; 2]> {
        let mut separation = StemSeparation::new([&input[0], &input[1]]).unwrap();
        let mut chunk = vec![0.0; 2 * SEGMENT];
        for index in 0..separation.chunks() {
            separation.fill_chunk(index, &mut chunk);
            separation.add(index, &model(&chunk)).unwrap();
        }
        separation.finish().unwrap()
    }

    fn mean_of([left, right]: &[Vec<f32>; 2]) -> f32 {
        let total: f64 = left
            .iter()
            .zip(right)
            .map(|(&l, &r)| f64::from(l + r) / 2.0)
            .sum();
        (total / left.len() as f64) as f32
    }

    fn largest_difference(a: &[f32], b: &[f32]) -> f32 {
        assert_eq!(a.len(), b.len());
        a.iter()
            .zip(b)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max)
    }

    #[test]
    fn a_chunk_starts_every_three_quarters_of_a_segment() {
        let chunks = |frames: usize| {
            let silence = vec![0.0; frames];
            StemSeparation::new([&silence, &silence]).unwrap().chunks()
        };
        assert_eq!(chunks(1), 1);
        assert_eq!(chunks(STRIDE), 1);
        assert_eq!(chunks(STRIDE + 1), 2);
        // 20 s is four chunks, the last one short.
        assert_eq!(chunks(20 * 44_100), 4);
    }

    #[test]
    fn a_short_chunk_is_the_standardised_audio_centred_in_silence() {
        let left = [1.0, 3.0, 5.0];
        let right = [3.0, 5.0, 7.0];
        let separation = StemSeparation::new([&left, &right]).unwrap();
        let mut chunk = vec![f32::NAN; 2 * SEGMENT];
        separation.fill_chunk(0, &mut chunk);
        // The mono mix is 2, 4, 6: mean 4, unbiased standard deviation 2.
        let pad = (SEGMENT - 3) / 2;
        let (left, right) = chunk.split_at(SEGMENT);
        assert_eq!(&left[pad..pad + 3], [-1.5, -0.5, 0.5]);
        assert_eq!(&right[pad..pad + 3], [-0.5, 0.5, 1.5]);
        for side in [left, right] {
            assert!(
                side[..pad]
                    .iter()
                    .chain(&side[pad + 3..])
                    .all(|&s| s == 0.0)
            );
        }
    }

    #[test]
    fn a_chunk_in_the_middle_is_the_audio_from_its_offset() {
        let input = song(20.0);
        let separation = StemSeparation::new([&input[0], &input[1]]).unwrap();
        let mut chunk = vec![0.0; 2 * SEGMENT];
        separation.fill_chunk(1, &mut chunk);
        let standardised = |s: f32| ((f64::from(s) - separation.mean) / separation.std) as f32;
        assert_eq!(chunk[0], standardised(input[0][STRIDE]));
        assert_eq!(
            chunk[SEGMENT - 1],
            standardised(input[0][STRIDE + SEGMENT - 1])
        );
        assert_eq!(chunk[SEGMENT], standardised(input[1][STRIDE]));
    }

    #[test]
    fn each_stem_is_the_models_across_every_chunk_and_cross_fade() {
        let input = song(20.0);
        let stems = separate(&input, gains);
        let mean = mean_of(&input);
        for (stem, weight) in stems.iter().zip(WEIGHTS) {
            for side in 0..2 {
                let expected: Vec<f32> = input[side]
                    .iter()
                    .map(|s| (s - mean) * weight + mean)
                    .collect();
                assert!(largest_difference(&stem[side], &expected) < 1e-5);
            }
        }
    }

    #[test]
    fn an_identity_model_gives_the_input_back_as_every_stem() {
        let input = song(1.0);
        for stem in separate(&input, |chunk| chunk.repeat(4)) {
            for side in 0..2 {
                assert!(largest_difference(&stem[side], &input[side]) < 1e-5);
            }
        }
    }

    #[test]
    fn the_model_may_run_its_chunks_in_any_order() {
        let input = song(20.0);
        let mut separation = StemSeparation::new([&input[0], &input[1]]).unwrap();
        let mut chunk = vec![0.0; 2 * SEGMENT];
        for index in (0..separation.chunks()).rev() {
            separation.fill_chunk(index, &mut chunk);
            separation.add(index, &gains(&chunk)).unwrap();
        }
        let stems = separation.finish().unwrap();
        assert_eq!(stems, separate(&input, gains));
    }

    #[test]
    fn silence_is_separated_into_silence() {
        let silence = vec![0.0; 1_000];
        for stem in separate(&[silence.clone(), silence], gains) {
            assert!(stem.iter().flatten().all(|&s| s == 0.0));
        }
    }

    #[test]
    fn no_audio_or_sides_of_different_lengths_are_refused() {
        assert!(StemSeparation::new([&[], &[]]).is_err());
        assert!(StemSeparation::new([&[0.0, 1.0], &[0.0]]).is_err());
    }

    #[test]
    fn output_of_the_wrong_length_or_for_a_chunk_twice_is_refused() {
        let input = song(1.0);
        let mut separation = StemSeparation::new([&input[0], &input[1]]).unwrap();
        let mut chunk = vec![0.0; 2 * SEGMENT];
        separation.fill_chunk(0, &mut chunk);
        let wrong = separation.add(0, &chunk).unwrap_err();
        assert!(wrong.contains("shape"), "{wrong}");
        separation.add(0, &gains(&chunk)).unwrap();
        assert!(separation.add(0, &gains(&chunk)).is_err());
        assert!(separation.add(1, &gains(&chunk)).is_err());
    }

    #[test]
    fn the_stems_wait_for_every_chunk() {
        let input = song(20.0);
        let mut separation = StemSeparation::new([&input[0], &input[1]]).unwrap();
        let mut chunk = vec![0.0; 2 * SEGMENT];
        separation.fill_chunk(0, &mut chunk);
        separation.add(0, &gains(&chunk)).unwrap();
        assert!(separation.take_stem(0).is_err());
        assert!(separation.finish().is_err());
    }

    #[test]
    fn a_stem_is_taken_once() {
        let input = song(1.0);
        let mut separation = StemSeparation::new([&input[0], &input[1]]).unwrap();
        separation.add(0, &gains(&separation.chunk(0))).unwrap();
        assert!(separation.take_stem(3).is_ok());
        assert!(separation.take_stem(3).is_err());
        assert!(separation.take_stem(4).is_err());
    }

    #[test]
    fn a_file_is_separated_at_htdemucs_rate_into_float_wavs() {
        let [left, right] = song(1.0);
        let interleaved: Vec<f32> = left
            .iter()
            .zip(&right)
            .flat_map(|(&l, &r)| [l, r])
            .collect();
        let wav = wav_bytes(&interleaved, 22_050, SampleFormat::Float32);
        let mut separation = StemSeparation::from_audio_file(&wav).unwrap();
        for index in 0..separation.chunks() {
            separation
                .add(index, &gains(&separation.chunk(index)))
                .unwrap();
        }
        let stem = separation.stem_wav(0).unwrap();
        let decoded = PreparedAudioFile::decode(&stem, STEM_SAMPLE_RATE as f32).unwrap();
        // One second at 22.05 kHz is one second at 44.1 kHz.
        assert!(decoded.left().len().abs_diff(2 * left.len()) <= 1);
        // 32-bit float, format 3, in the fmt chunk.
        assert_eq!(u16::from_le_bytes([stem[20], stem[21]]), 3);
        assert!(StemSeparation::from_audio_file(b"not audio").is_err());
    }

    #[test]
    fn the_model_is_published_as_json() {
        let model: serde_json::Value = serde_json::from_str(&stem_separation_model()).unwrap();
        assert_eq!(model["sampleRate"], 44_100);
        assert_eq!(
            model["stems"],
            serde_json::json!(["drums", "bass", "other", "vocals"])
        );
        assert_eq!(model["input"], serde_json::json!([1, 2, 343_980]));
        assert_eq!(model["output"], serde_json::json!([1, 4, 2, 343_980]));
    }
}

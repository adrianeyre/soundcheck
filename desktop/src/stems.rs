//! **Stem Separation** on the desktop (ADR 0005): htdemucs, exported by
//! Mixxx's fork of Demucs to a self-contained ONNX model, run by ONNX
//! Runtime on the CPU. Here, never in the engine (ADR 0001).
//!
//! The model is never downloaded or bundled: its weights are for research
//! and personal use only. The musician exports `htdemucs.onnx` themselves
//! and installs it from that file; it is checked by its shapes and copied
//! into the app-data folder, outside any Project.
//!
//! Around the model it does what Demucs's own `separate.py` does, with the
//! engine's `StemSeparation`, which the Browser Version shares: standardise,
//! run 7.8 s chunks overlapping by a quarter, cross-fade them and undo the
//! standardisation. One separation runs at a time, on a worker thread; the
//! UI polls `StemJob::progress` over IPC and can cancel, as it does a mix
//! export.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::{Outlet, TensorElementType, TensorRef, ValueType};
use soundcheck_engine::{
    MODEL_INPUT_SHAPE as INPUT_SHAPE, MODEL_OUTPUT_SHAPE as OUTPUT_SHAPE, PreparedAudioFile,
    SampleFormat, StemSeparation, wav_bytes,
};
pub use soundcheck_engine::{SEGMENT, STEM_NAMES as SOURCES, STEM_SAMPLE_RATE as SAMPLE_RATE};

#[cfg(test)]
mod fake_model;

/// Where the installed model is kept in the app-data folder.
pub fn model_path(app_data: &Path) -> PathBuf {
    app_data.join("models").join("htdemucs.onnx")
}

pub fn is_installed(app_data: &Path) -> bool {
    model_path(app_data).is_file()
}

/// The folder `pnpm htdemucs:export` writes the model to by default, in
/// the repo, and the name it gives it. It is gitignored and never shipped:
/// the weights are for personal use only (ADR 0005).
pub const MODEL_FOLDER: &str = "model";
pub const MODEL_FILE: &str = "htdemucs.onnx";

/// Where the app looks for an exported model before asking for one: the
/// repo's `model/` folder, as it was when the app was built, then `model/`
/// beside the app itself.
pub fn model_candidates(repo: &Path, app: Option<&Path>) -> Vec<PathBuf> {
    std::iter::once(repo)
        .chain(app)
        .map(|folder| folder.join(MODEL_FOLDER).join(MODEL_FILE))
        .collect()
}

/// The first of `candidates` that is a file, if any: not yet checked to be
/// htdemucs, which installing it does.
pub fn find_model(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|path| path.is_file()).cloned()
}

/// Install the model from the musician's `htdemucs.onnx`: check it is
/// htdemucs, then copy it into the app-data folder, replacing any installed
/// one. A model that is refused leaves the installed one as it was.
pub fn install(app_data: &Path, from: &Path) -> Result<(), String> {
    // The basic optimisations work out the shapes the export leaves
    // symbolic (its output's), and on htdemucs are quicker than none.
    Model::open(from, GraphOptimizationLevel::Level1)?;
    let to = model_path(app_data);
    let folder = to.parent().expect("the model is in a folder");
    std::fs::create_dir_all(folder)
        .map_err(|error| format!("{} can't be made: {error}", folder.display()))?;
    // Copied beside it, then renamed over it, so a copy that fails part way
    // never leaves half a model installed.
    let partial = to.with_extension("onnx.partial");
    let copied = std::fs::copy(from, &partial).and_then(|_| std::fs::rename(&partial, &to));
    copied.map_err(|error| {
        let _ = std::fs::remove_file(&partial);
        format!("The model couldn't be copied to {}: {error}", to.display())
    })
}

/// htdemucs, loaded into ONNX Runtime.
pub struct Model {
    session: Session,
    input: String,
    output: String,
}

impl Model {
    /// Load the model at `path` to separate with, or say why it can't be.
    pub fn load(path: &Path) -> Result<Self, String> {
        Self::open(path, GraphOptimizationLevel::Level3)
    }

    fn open(path: &Path, level: GraphOptimizationLevel) -> Result<Self, String> {
        let not_onnx = |error: ort::Error| format!("This isn't an ONNX model: {error}");
        let session = Session::builder()
            .map_err(not_onnx)?
            .with_optimization_level(level)
            .map_err(|error| not_onnx(error.into()))?
            .commit_from_file(path)
            .map_err(not_onnx)?;
        let (input, output) = match (session.inputs(), session.outputs()) {
            ([input], [output]) => (input, output),
            (inputs, outputs) => {
                return Err(format!(
                    "This isn't htdemucs: it has {} inputs and {} outputs, and htdemucs has one of each.",
                    inputs.len(),
                    outputs.len()
                ));
            }
        };
        check_shape("input", input, &INPUT_SHAPE)?;
        check_shape("output", output, &OUTPUT_SHAPE)?;
        let (input, output) = (input.name().to_owned(), output.name().to_owned());
        Ok(Self {
            session,
            input,
            output,
        })
    }

    /// Separate stereo audio at `SAMPLE_RATE` into its Stems, in `SOURCES`'
    /// order, each two sides. `progress` hears how far it has got, 0 to 1,
    /// and answers whether to carry on; None if it didn't.
    pub fn separate(
        &mut self,
        [left, right]: [&[f32]; 2],
        mut progress: impl FnMut(f32) -> bool,
    ) -> Result<Option<Vec<[Vec<f32>; 2]>>, String> {
        let mut separation = StemSeparation::new([left, right])?;
        let chunks = separation.chunks();
        let mut chunk = vec![0.0f32; 2 * SEGMENT];
        for index in 0..chunks {
            if !progress(index as f32 / chunks as f32) {
                return Ok(None);
            }
            separation.fill_chunk(index, &mut chunk);
            let tensor = TensorRef::from_array_view((INPUT_SHAPE, chunk.as_slice()))
                .map_err(|error| format!("The audio couldn't be given to the model: {error}"))?;
            let outputs = self
                .session
                .run(ort::inputs![self.input.as_str() => tensor])
                .map_err(|error| format!("The model failed: {error}"))?;
            let (shape, data) = outputs[self.output.as_str()]
                .try_extract_tensor::<f32>()
                .map_err(|error| format!("The model's output couldn't be read: {error}"))?;
            if **shape != OUTPUT_SHAPE {
                return Err(format!("The model gave Stems of shape {shape}"));
            }
            separation.add(index, data)?;
        }
        if !progress(1.0) {
            return Ok(None);
        }
        separation.finish().map(Some)
    }
}

/// Refuse an `outlet` that isn't a float tensor of `expected`'s shape.
fn check_shape(what: &str, outlet: &Outlet, expected: &[i64]) -> Result<(), String> {
    let wrong = |found: String| {
        Err(format!(
            "This isn't htdemucs: its {what} is {found}, where htdemucs' is f32 {expected:?}. \
             Export htdemucs.onnx with tools/htdemucs-onnx, as its README says."
        ))
    };
    match outlet.dtype() {
        ValueType::Tensor {
            ty: TensorElementType::Float32,
            shape,
            ..
        } if **shape == *expected => Ok(()),
        // A dynamic dimension is -1.
        ValueType::Tensor { ty, shape, .. } => wrong(format!("{ty} {:?}", &**shape)),
        other => wrong(other.to_string()),
    }
}

/// One Stem Separation under way, shared between the thread running it and
/// the IPC commands that watch and cancel it.
#[derive(Debug, Default)]
pub struct StemJob {
    /// 0 to 1, as an `f32`'s bits.
    progress: AtomicU32,
    cancelled: AtomicBool,
    running: AtomicBool,
}

impl StemJob {
    pub fn progress(&self) -> f32 {
        f32::from_bits(self.progress.load(Ordering::Relaxed))
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    fn carry_on(&self, progress: f32) -> bool {
        self.progress.store(progress.to_bits(), Ordering::Relaxed);
        !self.cancelled.load(Ordering::Relaxed)
    }

    /// Separate an audio file's bytes (WAV, FLAC or MP3; mono is separated
    /// as stereo) with the model at `model`. The Stems come back as 32-bit
    /// float WAV files at `SAMPLE_RATE`, in `SOURCES`' order, or None if
    /// cancelled first.
    pub fn run(&self, model: &Path, audio: &[u8]) -> Result<Option<Vec<Vec<u8>>>, String> {
        self.running.store(true, Ordering::Relaxed);
        let _finished = Finished(&self.running);
        if !self.carry_on(0.0) {
            return Ok(None);
        }
        let audio = PreparedAudioFile::decode(audio, SAMPLE_RATE as f32)
            .map_err(|error| error.message().to_owned())?;
        let mut model = Model::load(model)?;
        let separated = model.separate([audio.left(), audio.right()], |progress| {
            self.carry_on(progress)
        })?;
        Ok(separated.map(|stems| {
            stems
                .iter()
                .map(|[left, right]| {
                    let interleaved: Vec<f32> =
                        left.iter().zip(right).flat_map(|(&l, &r)| [l, r]).collect();
                    wav_bytes(&interleaved, SAMPLE_RATE, SampleFormat::Float32)
                })
                .collect()
        }))
    }
}

/// Marks a job finished however its run ends.
struct Finished<'a>(&'a AtomicBool);

impl Drop for Finished<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

/// The app's Stem Separations: one at a time, and the last one's progress.
#[derive(Debug, Default)]
pub struct Separations {
    current: Mutex<Option<Arc<StemJob>>>,
}

impl Separations {
    /// A job for a new separation, or why there can't be one yet.
    pub fn start(&self) -> Result<Arc<StemJob>, String> {
        let mut current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        if current
            .as_ref()
            .is_some_and(|job| job.running.load(Ordering::Relaxed))
        {
            return Err("A Stem Separation is already running; wait for it or cancel it.".into());
        }
        let job = Arc::new(StemJob::default());
        // Running from now, before its thread starts, so a second start
        // can't slip in between.
        job.running.store(true, Ordering::Relaxed);
        *current = Some(Arc::clone(&job));
        Ok(job)
    }

    pub fn progress(&self) -> f32 {
        let current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        current.as_ref().map_or(0.0, |job| job.progress())
    }

    pub fn cancel(&self) {
        let current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(job) = current.as_ref() {
            job.cancel();
        }
    }
}

#[cfg(test)]
mod tests;

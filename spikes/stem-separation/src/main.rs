//! Spike for #115: separate a song into its four Stems with htdemucs, exported to
//! a self-contained ONNX model (Mixxx's export: the STFT is inside the graph), run
//! through ONNX Runtime on the CPU. Throwaway code; see the README.
//!
//! `separate <model.onnx> <song.wav> <out-dir> [threads]` writes drums, bass,
//! other and vocals as 32-bit float WAVs and prints the time and peak memory.
//!
//! `compare <our-dir> <reference-dir>` compares our Stems with Demucs's own
//! PyTorch output, Stem by Stem.

use std::error::Error;
use std::path::Path;
use std::time::Instant;

use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// htdemucs's order of outputs.
const SOURCES: [&str; 4] = ["drums", "bass", "other", "vocals"];
const SAMPLE_RATE: u32 = 44_100;
/// htdemucs's training segment, 7.8 s: the length the exported model takes.
const SEGMENT: usize = 343_980;
/// Demucs's default overlap between chunks.
const OVERLAP: f64 = 0.25;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["separate", model, song, out, rest @ ..] => {
            let threads = rest.first().map(|t| t.parse()).transpose()?;
            separate(Path::new(model), Path::new(song), Path::new(out), threads)
        }
        ["compare", ours, reference] => compare(Path::new(ours), Path::new(reference)),
        _ => Err("usage: separate <model.onnx> <song.wav> <out-dir> [threads] | compare <our-dir> <reference-dir>".into()),
    }
}

fn separate(model: &Path, song: &Path, out: &Path, threads: Option<usize>) -> Result<()> {
    let [left, right] = read_stereo(song)?;
    let frames = left.len();
    println!(
        "{}: {:.1} s of audio",
        song.display(),
        frames as f64 / f64::from(SAMPLE_RATE)
    );

    let loading = Instant::now();
    let mut builder =
        Session::builder()?.with_optimization_level(GraphOptimizationLevel::Level3)?;
    if let Some(threads) = threads {
        builder = builder.with_intra_threads(threads)?;
    }
    let mut session = builder.commit_from_file(model)?;
    println!("model loaded in {:.2} s", loading.elapsed().as_secs_f64());

    // As Demucs's Separator.separate_tensor (api.py, which separate.py calls):
    // standardise by the mono mix, and undo it after. Its std is unbiased and
    // has 1e-8 added, not a floor.
    let mono: Vec<f32> = left
        .iter()
        .zip(&right)
        .map(|(l, r)| (l + r) / 2.0)
        .collect();
    let mean = mono.iter().map(|&s| f64::from(s)).sum::<f64>() / frames as f64;
    let variance = mono
        .iter()
        .map(|&s| (f64::from(s) - mean).powi(2))
        .sum::<f64>()
        / (frames as f64 - 1.0).max(1.0);
    let std = variance.sqrt() + 1e-8;
    let norm = |s: f32| ((f64::from(s) - mean) / std) as f32;
    let input = [
        left.iter().map(|&s| norm(s)).collect::<Vec<_>>(),
        right.iter().map(|&s| norm(s)).collect(),
    ];

    // As Demucs's apply_model with split: overlapping chunks, each padded out to
    // SEGMENT with the audio around it, cross-faded with a triangular weight.
    let mut weight: Vec<f32> = (1..=SEGMENT / 2)
        .chain((1..=SEGMENT - SEGMENT / 2).rev())
        .map(|w| w as f32)
        .collect();
    let peak = weight.iter().copied().fold(0.0, f32::max);
    weight.iter_mut().for_each(|w| *w /= peak);
    let stride = ((1.0 - OVERLAP) * SEGMENT as f64) as usize;

    let mut stems = vec![vec![vec![0.0f32; frames]; 2]; SOURCES.len()];
    let mut total_weight = vec![0.0f32; frames];
    let running = Instant::now();
    let chunks = frames.div_ceil(stride);
    for (index, offset) in (0..frames).step_by(stride).enumerate() {
        let length = SEGMENT.min(frames - offset);
        let pad = (SEGMENT - length) / 2;
        let start = offset as isize - pad as isize;
        let mut chunk = vec![0.0f32; 2 * SEGMENT];
        for (channel, samples) in input.iter().enumerate() {
            for i in 0..SEGMENT {
                let at = start + i as isize;
                if (0..frames as isize).contains(&at) {
                    chunk[channel * SEGMENT + i] = samples[at as usize];
                }
            }
        }
        let tensor = Tensor::from_array(([1usize, 2, SEGMENT], chunk.into_boxed_slice()))?;
        let outputs = session.run(ort::inputs!["input" => tensor])?;
        let (shape, data) = outputs["output"].try_extract_tensor::<f32>()?;
        assert_eq!(
            **shape,
            [1, SOURCES.len() as i64, 2, SEGMENT as i64],
            "unexpected output shape"
        );
        for (source, stem) in stems.iter_mut().enumerate() {
            for (channel, samples) in stem.iter_mut().enumerate() {
                let base = (source * 2 + channel) * SEGMENT + pad;
                for i in 0..length {
                    samples[offset + i] += data[base + i] * weight[i];
                }
            }
        }
        for i in 0..length {
            total_weight[offset + i] += weight[i];
        }
        println!("chunk {}/{chunks}", index + 1);
    }
    let seconds = running.elapsed().as_secs_f64();

    std::fs::create_dir_all(out)?;
    for (name, stem) in SOURCES.iter().zip(&stems) {
        let denorm = |channel: usize, i: usize| {
            (f64::from(stem[channel][i] / total_weight[i]) * std + mean) as f32
        };
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(out.join(format!("{name}.wav")), spec)?;
        for i in 0..frames {
            writer.write_sample(denorm(0, i))?;
            writer.write_sample(denorm(1, i))?;
        }
        writer.finalize()?;
    }

    let audio = frames as f64 / f64::from(SAMPLE_RATE);
    println!(
        "separated in {seconds:.1} s ({:.1} s per minute of audio, {:.2}x real time)",
        seconds / audio * 60.0,
        audio / seconds
    );
    match peak_memory_mb() {
        Some(mb) => println!("peak memory {mb:.0} MB"),
        None => println!("peak memory: not available on this platform"),
    }
    println!(
        "model file {:.0} MB",
        std::fs::metadata(model)?.len() as f64 / 1e6
    );
    Ok(())
}

/// Per Stem: the largest sample difference and the signal-to-difference ratio
/// in dB (higher is closer; above ~60 dB is inaudible).
fn compare(ours: &Path, reference: &Path) -> Result<()> {
    for name in SOURCES {
        let a = read_stereo(&ours.join(format!("{name}.wav")))?;
        let b = read_stereo(&reference.join(format!("{name}.wav")))?;
        let (mut max, mut signal, mut noise) = (0.0f64, 0.0f64, 0.0f64);
        for (x, y) in a.iter().zip(&b) {
            for (&x, &y) in x.iter().zip(y) {
                let (x, y) = (f64::from(x), f64::from(y));
                max = max.max((x - y).abs());
                signal += y * y;
                noise += (x - y).powi(2);
            }
        }
        println!(
            "{name:>6}: max difference {max:.2e}, {:.1} dB",
            10.0 * (signal / noise.max(1e-20)).log10()
        );
    }
    Ok(())
}

/// A 44.1 kHz WAV as two channels; mono is used on both sides.
fn read_stereo(path: &Path) -> Result<[Vec<f32>; 2]> {
    let mut reader =
        hound::WavReader::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE {
        return Err(format!(
            "{}: {} Hz; convert it to 44.1 kHz first (ffmpeg -i in -ar 44100 out.wav)",
            path.display(),
            spec.sample_rate
        )
        .into());
    }
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<std::result::Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|s| s as f32 / scale))
                .collect::<std::result::Result<_, _>>()?
        }
    };
    let channels = usize::from(spec.channels);
    let side = |c: usize| {
        samples
            .chunks_exact(channels)
            .map(|frame| frame[c.min(channels - 1)])
            .collect()
    };
    Ok([side(0), side(1)])
}

#[cfg(target_os = "linux")]
fn peak_memory_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024.0)
}

#[cfg(windows)]
fn peak_memory_mb() -> Option<f64> {
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    let size = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // SAFETY: the counters struct is ours and `size` is its size.
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size) };
    (ok != 0).then(|| counters.PeakWorkingSetSize as f64 / 1e6)
}

#[cfg(not(any(target_os = "linux", windows)))]
fn peak_memory_mb() -> Option<f64> {
    None
}

//! With tiny fake models of our own (`fake_model`), never Demucs weights;
//! one ignored test runs the real `htdemucs.onnx` where the musician names it.

use std::time::Instant;

use super::fake_model::{self, WEIGHTS};
use super::*;

/// A file in a folder of its own, for as long as the folder is held.
fn file_of(bytes: &[u8], name: &str) -> (tempfile::TempDir, PathBuf) {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join(name);
    std::fs::write(&path, bytes).unwrap();
    (folder, path)
}

fn fake_htdemucs() -> (tempfile::TempDir, PathBuf) {
    file_of(&fake_model::htdemucs(), "htdemucs.onnx")
}

/// `seconds` of two tones and a slow sweep, different on each side, with a
/// little DC so undoing the standardisation is tested.
fn song(seconds: f64) -> [Vec<f32>; 2] {
    let frames = (seconds * f64::from(SAMPLE_RATE)) as usize;
    let side = |frequency: f64, level: f64| {
        (0..frames)
            .map(|i| {
                let t = i as f64 / f64::from(SAMPLE_RATE);
                let sweep = (std::f64::consts::TAU * 0.3 * t).sin() * 0.2;
                (level * (std::f64::consts::TAU * frequency * t).sin() + sweep + 0.01) as f32
            })
            .collect()
    };
    [side(220.0, 0.5), side(330.0, 0.3)]
}

fn wav_of([left, right]: &[Vec<f32>; 2]) -> Vec<u8> {
    let interleaved: Vec<f32> = left.iter().zip(right).flat_map(|(&l, &r)| [l, r]).collect();
    wav_bytes(&interleaved, SAMPLE_RATE, SampleFormat::Float32)
}

fn decoded(wav: &[u8]) -> [Vec<f32>; 2] {
    let file = PreparedAudioFile::decode(wav, SAMPLE_RATE as f32).unwrap();
    [file.left().to_vec(), file.right().to_vec()]
}

fn largest_difference(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f32::max)
}

/// Each side of the four Stems, added up.
fn sum_of(stems: &[[Vec<f32>; 2]]) -> [Vec<f32>; 2] {
    [0, 1].map(|side| {
        (0..stems[0][side].len())
            .map(|i| stems.iter().map(|stem| stem[side][i]).sum())
            .collect()
    })
}

fn mean_of([left, right]: &[Vec<f32>; 2]) -> f32 {
    let total: f64 = left
        .iter()
        .zip(right)
        .map(|(&l, &r)| f64::from(l + r) / 2.0)
        .sum();
    (total / left.len() as f64) as f32
}

#[test]
fn the_four_stems_of_a_short_file_sum_to_it() {
    let (_folder, model) = fake_htdemucs();
    let input = song(1.0);
    let stems = StemJob::default()
        .run(&model, &wav_of(&input))
        .unwrap()
        .expect("not cancelled");
    assert_eq!(stems.len(), SOURCES.len());
    let stems: Vec<_> = stems.iter().map(|wav| decoded(wav)).collect();
    let sum = sum_of(&stems);
    // Exactly the input, bar Demucs's three extra means (see `separate`).
    let offset = 3.0 * mean_of(&input);
    for side in 0..2 {
        let expected: Vec<f32> = input[side].iter().map(|s| s + offset).collect();
        assert!(largest_difference(&sum[side], &expected) < 1e-5);
    }
}

#[test]
fn each_stem_is_the_models_across_every_chunk_and_cross_fade() {
    let (_folder, path) = fake_htdemucs();
    // Four chunks, the last one short.
    let input = song(20.0);
    let stems = Model::load(&path)
        .unwrap()
        .separate([&input[0], &input[1]], |_| true)
        .unwrap()
        .unwrap();
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
fn a_mono_file_is_separated_as_stereo() {
    let (_folder, model) = fake_htdemucs();
    let mono = &song(0.5)[0];
    let wav = soundcheck_engine::mono_wav_bytes(mono, SAMPLE_RATE, SampleFormat::Float32);
    let stems = StemJob::default().run(&model, &wav).unwrap().unwrap();
    for stem in &stems {
        let [left, right] = decoded(stem);
        assert_eq!(left.len(), mono.len());
        assert_eq!(left, right);
    }
}

#[test]
fn the_stems_are_at_htdemucs_rate_whatever_the_files() {
    let (_folder, model) = fake_htdemucs();
    let [left, right] = song(1.0);
    let interleaved: Vec<f32> = left
        .iter()
        .zip(&right)
        .flat_map(|(&l, &r)| [l, r])
        .collect();
    let wav = wav_bytes(&interleaved, 22_050, SampleFormat::Float32);
    let stems = StemJob::default().run(&model, &wav).unwrap().unwrap();
    let file = PreparedAudioFile::decode(&stems[0], SAMPLE_RATE as f32).unwrap();
    // Two seconds' worth at 22.05 kHz is two seconds at 44.1 kHz.
    assert!(file.left().len().abs_diff(2 * left.len()) <= 1);
}

#[test]
fn progress_rises_from_zero_to_one() {
    let (_folder, path) = fake_htdemucs();
    let input = song(20.0);
    let mut reports = Vec::new();
    Model::load(&path)
        .unwrap()
        .separate([&input[0], &input[1]], |progress| {
            reports.push(progress);
            true
        })
        .unwrap()
        .unwrap();
    assert_eq!(reports, [0.0, 0.25, 0.5, 0.75, 1.0]);
}

#[test]
fn a_job_reports_how_far_it_has_got() {
    let (_folder, model) = fake_htdemucs();
    let job = StemJob::default();
    assert_eq!(job.progress(), 0.0);
    assert!(job.run(&model, &wav_of(&song(1.0))).unwrap().is_some());
    assert_eq!(job.progress(), 1.0);
}

#[test]
fn cancelling_stops_the_separation_and_returns_nothing() {
    let (_folder, path) = fake_htdemucs();
    let input = song(20.0);
    let mut chunks = 0;
    let separated = Model::load(&path)
        .unwrap()
        .separate([&input[0], &input[1]], |_| {
            chunks += 1;
            chunks < 2
        })
        .unwrap();
    assert!(separated.is_none());
    // It stopped at the second chunk rather than running on.
    assert_eq!(chunks, 2);

    let job = StemJob::default();
    job.cancel();
    assert_eq!(job.run(&path, &wav_of(&input)), Ok(None));
}

#[test]
fn cancelling_a_job_on_another_thread_stops_it() {
    let (_folder, path) = fake_htdemucs();
    let separations = Separations::default();
    let job = separations.start().unwrap();
    let wav = wav_of(&song(60.0));
    let running = std::thread::spawn(move || job.run(&path, &wav));
    while separations.progress() == 0.0 {
        std::thread::yield_now();
    }
    separations.cancel();
    assert_eq!(running.join().unwrap(), Ok(None));
    assert!(separations.progress() < 1.0);
}

#[test]
fn only_one_separation_runs_at_a_time() {
    let (_folder, model) = fake_htdemucs();
    let separations = Separations::default();
    let job = separations.start().unwrap();
    let refused = separations.start().unwrap_err();
    assert!(refused.contains("already running"), "{refused}");

    // Once it ends, however it ends, the next may start.
    assert!(job.run(&model, b"not audio").is_err());
    let next = separations.start().unwrap();
    assert!(next.run(&model, &wav_of(&song(0.5))).unwrap().is_some());
    assert!(separations.start().is_ok());
}

#[test]
fn audio_that_cant_be_read_is_refused_with_a_reason() {
    let (_folder, model) = fake_htdemucs();
    let refused = StemJob::default().run(&model, b"not audio").unwrap_err();
    assert!(!refused.is_empty());
}

#[test]
fn an_exported_model_is_found_in_the_repo_first_then_beside_the_app() {
    let repo = tempfile::tempdir().unwrap();
    let app = tempfile::tempdir().unwrap();
    let candidates = model_candidates(repo.path(), Some(app.path()));
    assert_eq!(
        candidates,
        [
            repo.path().join("model").join("htdemucs.onnx"),
            app.path().join("model").join("htdemucs.onnx"),
        ]
    );
    assert_eq!(find_model(&candidates), None);

    std::fs::create_dir(app.path().join("model")).unwrap();
    std::fs::write(&candidates[1], b"beside the app").unwrap();
    assert_eq!(find_model(&candidates).as_ref(), Some(&candidates[1]));

    std::fs::create_dir(repo.path().join("model")).unwrap();
    std::fs::write(&candidates[0], b"in the repo").unwrap();
    assert_eq!(find_model(&candidates).as_ref(), Some(&candidates[0]));

    // A folder of that name isn't a model.
    let folder = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(folder.path().join("model").join("htdemucs.onnx")).unwrap();
    assert_eq!(find_model(&model_candidates(folder.path(), None)), None);
}

#[test]
fn installing_htdemucs_copies_it_into_the_app_data_folder() {
    let app_data = tempfile::tempdir().unwrap();
    assert!(!is_installed(app_data.path()));
    let (_folder, model) = fake_htdemucs();
    install(app_data.path(), &model).unwrap();
    assert!(is_installed(app_data.path()));
    let installed = model_path(app_data.path());
    assert!(installed.starts_with(app_data.path()));
    assert_eq!(std::fs::read(&installed).unwrap(), fake_model::htdemucs());
    // The installed copy is what separates, and nothing is left beside it.
    assert!(
        StemJob::default()
            .run(&installed, &wav_of(&song(0.5)))
            .unwrap()
            .is_some()
    );
    let files = std::fs::read_dir(installed.parent().unwrap())
        .unwrap()
        .count();
    assert_eq!(files, 1);
}

#[test]
fn htdemucs_installs_as_the_export_writes_it_with_its_output_shape_left_open() {
    let app_data = tempfile::tempdir().unwrap();
    let (_folder, model) = file_of(&fake_model::htdemucs_as_exported(), "htdemucs.onnx");
    install(app_data.path(), &model).unwrap();
    let stems = StemJob::default()
        .run(&model_path(app_data.path()), &wav_of(&song(0.5)))
        .unwrap();
    assert_eq!(stems.map(|stems| stems.len()), Some(SOURCES.len()));
}

/// Try to install `bytes` as the model, over a good one: the reason it's
/// refused, having checked the good one is still there.
fn refused(bytes: &[u8]) -> String {
    let app_data = tempfile::tempdir().unwrap();
    let (_good_folder, good) = fake_htdemucs();
    install(app_data.path(), &good).unwrap();
    let (_folder, path) = file_of(bytes, "model.onnx");
    let reason = install(app_data.path(), &path).unwrap_err();
    let installed = std::fs::read(model_path(app_data.path())).unwrap();
    assert_eq!(
        installed,
        fake_model::htdemucs(),
        "the installed model changed"
    );
    reason
}

#[test]
fn a_model_that_takes_other_audio_is_refused() {
    let reason = refused(&fake_model::stems(44_100, &WEIGHTS));
    assert!(reason.contains("isn't htdemucs"), "{reason}");
    assert!(reason.contains("input is f32 [1, 2, 44100]"), "{reason}");
}

#[test]
fn a_model_with_other_stems_is_refused() {
    // As htdemucs_6s, whose piano Stem ADR 0005 leaves out.
    let reason = refused(&fake_model::stems(
        SEGMENT as i64,
        &[0.1, 0.1, 0.2, 0.2, 0.2, 0.2],
    ));
    assert!(
        reason.contains("output is f32 [1, 6, 2, 343980]"),
        "{reason}"
    );
}

#[test]
fn a_file_that_isnt_onnx_is_refused() {
    let reason = refused(b"RIFF....WAVEfmt this is a song, not a model");
    assert!(reason.contains("isn't an ONNX model"), "{reason}");
}

#[test]
fn a_missing_file_is_refused() {
    let app_data = tempfile::tempdir().unwrap();
    let missing = app_data.path().join("nowhere.onnx");
    assert!(install(app_data.path(), &missing).is_err());
    assert!(!is_installed(app_data.path()));
}

/// The Stems the fake model gives for `shared_song`, which the Browser
/// Version's test (`app/src/stems/browser-stem-separator.test.ts`) checks its
/// own against: the same Stems on both platforms. `BLESS=1` rewrites it.
const SHARED_STEMS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../app/src/stems/fake-htdemucs-stems.json"
);
/// Every how many frames `SHARED_STEMS` keeps a sample.
const SHARED_EVERY: usize = 3_001;

/// 8 s of 16-bit stereo noise with a little DC, at 48 kHz so it is
/// resampled, as a WAV file. The Browser Version's test makes the same bytes
/// from the same xorshift32.
fn shared_song() -> Vec<u8> {
    let (rate, frames) = (48_000u32, 8 * 48_000usize);
    let mut x: u32 = 0x5eed_5eed;
    let mut data = Vec::with_capacity(frames * 4);
    for _ in 0..frames * 2 {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        let sample = (x >> 20) as i16 - 2_048 + 300;
        data.extend(sample.to_le_bytes());
    }
    let mut wav = Vec::new();
    wav.extend(b"RIFF");
    wav.extend((36 + data.len() as u32).to_le_bytes());
    wav.extend(b"WAVEfmt ");
    wav.extend(16u32.to_le_bytes());
    wav.extend(1u16.to_le_bytes()); // PCM
    wav.extend(2u16.to_le_bytes());
    wav.extend(rate.to_le_bytes());
    wav.extend((rate * 4).to_le_bytes());
    wav.extend(4u16.to_le_bytes());
    wav.extend(16u16.to_le_bytes());
    wav.extend(b"data");
    wav.extend((data.len() as u32).to_le_bytes());
    wav.extend(data);
    wav
}

#[test]
fn the_browser_versions_stems_are_the_desktops() {
    let (_folder, model) = fake_htdemucs();
    let stems = StemJob::default()
        .run(&model, &shared_song())
        .unwrap()
        .unwrap();
    let mut kept = serde_json::Map::new();
    let mut frames = 0;
    for (name, wav) in SOURCES.iter().zip(&stems) {
        let [left, right] = decoded(wav);
        frames = left.len();
        let every =
            |side: &[f32]| -> Vec<f32> { side.iter().step_by(SHARED_EVERY).copied().collect() };
        kept.insert(
            (*name).into(),
            serde_json::json!({ "left": every(&left), "right": every(&right) }),
        );
    }
    let found = serde_json::json!({ "frames": frames, "every": SHARED_EVERY, "stems": kept });
    if std::env::var_os("BLESS").is_some() {
        std::fs::write(SHARED_STEMS, format!("{found}\n")).unwrap();
    }
    let expected: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(SHARED_STEMS).unwrap()).unwrap();
    assert_eq!(expected["frames"], found["frames"]);
    assert_eq!(expected["every"], found["every"]);
    for name in SOURCES {
        for side in ["left", "right"] {
            let samples = |stems: &serde_json::Value| -> Vec<f32> {
                stems["stems"][name][side]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_f64().unwrap() as f32)
                    .collect()
            };
            let (expected, found) = (samples(&expected), samples(&found));
            assert!(
                largest_difference(&expected, &found) < 1e-6,
                "{name} {side}"
            );
        }
    }
}

/// The real model, which the musician exports (`tools/htdemucs-onnx/`)
/// and which is never in the repo. Run it with
/// `SOUNDCHECK_HTDEMUCS=/path/to/htdemucs.onnx cargo test --release -p
/// soundcheck-desktop real_htdemucs -- --ignored --nocapture`, adding
/// `SOUNDCHECK_SONG=/path/to/song.wav` to separate a song rather than the
/// test's tones.
#[test]
#[ignore = "needs the musician's htdemucs.onnx in SOUNDCHECK_HTDEMUCS"]
fn real_htdemucs_gives_four_stems_that_sum_close_to_the_input() {
    let model = std::env::var_os("SOUNDCHECK_HTDEMUCS")
        .map(PathBuf::from)
        .expect("SOUNDCHECK_HTDEMUCS names htdemucs.onnx");
    let wav = match std::env::var_os("SOUNDCHECK_SONG") {
        Some(song) => std::fs::read(song).unwrap(),
        None => wav_of(&song(20.0)),
    };
    let input = decoded(&wav);

    let app_data = tempfile::tempdir().unwrap();
    let started = Instant::now();
    install(app_data.path(), &model).unwrap();
    println!(
        "checked and installed in {:.1} s",
        started.elapsed().as_secs_f64()
    );

    let started = Instant::now();
    let stems = StemJob::default()
        .run(&model_path(app_data.path()), &wav)
        .unwrap()
        .unwrap();
    let seconds = started.elapsed().as_secs_f64();
    let audio = input[0].len() as f64 / f64::from(SAMPLE_RATE);
    println!(
        "separated {audio:.1} s of audio in {seconds:.1} s ({:.1} s per minute of audio)",
        seconds / audio * 60.0
    );

    let stems: Vec<_> = stems.iter().map(|stem| decoded(stem)).collect();
    let sum = sum_of(&stems);
    let offset = 3.0 * mean_of(&input);
    let (mut signal, mut difference) = (0.0f64, 0.0f64);
    for side in 0..2 {
        for (&x, &y) in input[side].iter().zip(&sum[side]) {
            signal += f64::from(x).powi(2);
            difference += f64::from(y - offset - x).powi(2);
        }
    }
    let db = 10.0 * (signal / difference.max(1e-20)).log10();
    println!("the Stems' sum is {db:.1} dB above its difference from the input");
    // htdemucs isn't made to sum exactly to its input, only close. 20 dB is
    // a first guess at "close", to tighten once a real run has measured it.
    assert!(db > 20.0, "the Stems sum to {db:.1} dB from the input");
}

//! The Soundcheck desktop app: the React UI in a Tauri window, with the
//! Audio Engine running natively on the audio device through cpal and MIDI
//! keyboards read through midir (ADR 0002).
//!
//! The engine crate stays platform-free (ADR 0001); everything that touches
//! a device lives here.

pub mod analyse;
pub mod audio;
pub mod audio_input;
pub mod command;
pub mod export;
pub mod headphones;
pub mod host;
pub mod library;
pub mod midi;
pub mod monitor;
pub mod plugin;
pub mod project_files;
pub mod recorder;
pub mod samples;
pub mod secrets;
pub mod stats;
pub mod stems;
pub mod update;
pub mod vst3;

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use soundcheck_engine::{Attachments, Listening, SampleFormat, wav_bytes};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::audio::{AudioOutput, OpenInfo, OpenOptions};
use crate::audio_input::{AudioInput, InputDevice, InputInfo};
use crate::command::{EngineCommand, RecordedNoteEvent};
use crate::export::{ClipExport, ExportJob, ExportKind, ExportRequest};
use crate::midi::Midi;
use crate::monitor::MonitorFeed;
use crate::recorder::Tap;
use crate::stats::Measured;

/// Everything the IPC commands share. Locked on IPC threads only; the audio
/// callback never sees these locks.
#[derive(Default)]
struct App {
    audio: Mutex<Option<AudioOutput>>,
    /// The input the armed Tracks record from, if one is open.
    input: Mutex<Option<AudioInput>>,
    /// The last recording's WAV files, one per armed Track, until the UI
    /// takes them.
    takes: Mutex<Vec<Vec<u8>>>,
    midi: Mutex<Midi>,
    /// The export under way, or the last one.
    export: Mutex<Option<Arc<ExportJob>>>,
    /// The Stem Separation under way, or the last one.
    separations: stems::Separations,
    /// The last separation's Stems as WAV files, in `stems::SOURCES`' order,
    /// until the UI takes them.
    stems: Mutex<Vec<Vec<u8>>>,
    /// The Mixer page's headphone cue on a second device: the one chosen,
    /// and its stream while the main output runs.
    headphones: Mutex<Headphones>,
}

#[derive(Default)]
struct Headphones {
    device: Option<String>,
    stream: Option<headphones::HeadphoneStream>,
    /// Why the chosen device couldn't be opened, until it is chosen again.
    error: Option<String>,
}

/// Open the chosen headphone device against the running output, if both
/// are there, handing the output's engine a fresh ring; with no device,
/// close it and stop feeding it.
fn apply_headphones(audio: &mut Option<AudioOutput>, phones: &mut Headphones) {
    phones.stream = None;
    phones.error = None;
    let Some(output) = audio.as_mut() else {
        return;
    };
    let Some(device) = phones.device.clone() else {
        output.controller.set_headphones(None);
        return;
    };
    let rate = output.controller.sample_rate();
    let (producer, consumer) = headphones::ring(rate);
    match headphones::open(Some(output.info.host.as_str()), &device, rate, consumer) {
        Ok(stream) => {
            output.controller.set_headphones(Some(producer));
            phones.stream = Some(stream);
        }
        Err(error) => {
            output.controller.set_headphones(None);
            phones.error = Some(error);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The audio hosts to choose from: WASAPI, and ASIO in an `asio` build, on
/// Windows; ALSA and JACK on Linux; CoreAudio on macOS.
#[tauri::command]
fn audio_hosts() -> Vec<String> {
    audio::host_names()
}

/// Start the engine on the output device, replacing any running one.
#[tauri::command]
fn audio_open(app: State<'_, App>, options: OpenOptions) -> Result<OpenInfo, String> {
    let mut running = lock(&app.audio);
    *running = None;
    let (output, midi_queue) = audio::open(&options)?;
    lock(&app.midi).route_to(Some(midi_queue));
    let info = output.info.clone();
    *running = Some(output);
    // The headphones chosen before follow the new output.
    apply_headphones(&mut running, &mut lock(&app.headphones));
    Ok(info)
}

#[tauri::command]
fn audio_send(app: State<'_, App>, command: EngineCommand) {
    if let Some(output) = lock(&app.audio).as_mut() {
        output.controller.send(command);
    }
}

/// Audition `path` in the sample folder `folder` (#52): straight to the
/// output at the preview level, past the mixer, so it is never in the mix or
/// an export. The file is read and decoded here, off the audio thread.
#[tauri::command]
fn audio_audition(app: State<'_, App>, folder: String, path: String) -> Result<(), String> {
    let bytes = project_files::read_bytes(&folder, &path)?;
    match lock(&app.audio).as_mut() {
        Some(output) => output
            .controller
            .audition(&bytes)
            .map_err(|error| format!("{path} can't be auditioned: {error}")),
        None => Err("Start audio to audition a sample".into()),
    }
}

/// Audition the Reference Track (#106), whose bytes the UI holds, as a
/// sample auditions but at `gain`: its own level (1), or turned down to the
/// mix's loudness. Never in the mix, the meters or an export.
#[tauri::command]
fn audio_audition_reference(app: State<'_, App>, bytes: Vec<u8>, gain: f32) -> Result<(), String> {
    match lock(&app.audio).as_mut() {
        Some(output) => output
            .controller
            .audition_at(&bytes, gain)
            .map_err(|error| format!("The Reference Track can't be auditioned: {error}")),
        None => Err("Start audio to audition the Reference Track".into()),
    }
}

/// Put a file on a Deck of the Mixer page's DJ Mixer (ADR 0013). It is
/// decoded and analysed here, outside the lock and off the audio thread;
/// what is wrong with it comes back as the error. Answers its BPM, Beat
/// Grid, key and waveform, as JSON.
#[tauri::command]
fn dj_load(app: State<'_, App>, deck: usize, bytes: Vec<u8>) -> Result<String, String> {
    let rate = match lock(&app.audio).as_ref() {
        Some(output) => output.controller.sample_rate(),
        None => return Err("Start audio to load a Deck".into()),
    };
    let prepared = soundcheck_engine::PreparedDjTrack::decode(&bytes, rate)
        .map_err(|error| format!("The file can't be loaded: {}", error.message()))?;
    match lock(&app.audio).as_mut() {
        Some(output) if output.controller.sample_rate() == rate => {
            Ok(output.controller.dj_put(deck, prepared))
        }
        _ => Err("The audio stopped while the file was loading".into()),
    }
}

/// Put a sample in a Sampler Slot of the Mixer page's DJ Mixer. It is
/// decoded here, outside the lock and off the audio thread; what is wrong with
/// it comes back as the error. Answers how long it plays, in seconds.
#[tauri::command]
fn dj_sample_load(app: State<'_, App>, slot: usize, bytes: Vec<u8>) -> Result<f64, String> {
    let rate = match lock(&app.audio).as_ref() {
        Some(output) => output.controller.sample_rate(),
        None => return Err("Start audio to load a Sampler Slot".into()),
    };
    let file = soundcheck_engine::PreparedAudioFile::decode(&bytes, rate)
        .map_err(|error| format!("The sample can't be loaded: {}", error.message()))?;
    let seconds = file.left().len() as f64 / f64::from(rate);
    match lock(&app.audio).as_mut() {
        Some(output) if output.controller.sample_rate() == rate => {
            output.controller.dj_put_sample(slot, file);
            Ok(seconds)
        }
        _ => Err("The audio stopped while the sample was loading".into()),
    }
}

#[tauri::command]
fn dj_sample_unload(app: State<'_, App>, slot: usize) {
    if let Some(output) = lock(&app.audio).as_mut() {
        output.controller.dj_unload_sample(slot);
    }
}

#[tauri::command]
fn dj_unload(app: State<'_, App>, deck: usize) {
    if let Some(output) = lock(&app.audio).as_mut() {
        output.controller.dj_unload(deck);
    }
}

/// The DJ mix recorded since the last call: interleaved stereo 32-bit
/// floats, little-endian, as raw bytes.
#[tauri::command]
fn dj_recording_take(app: State<'_, App>) -> tauri::ipc::Response {
    let samples = lock(&app.audio)
        .as_mut()
        .map(|output| output.controller.take_dj_recording())
        .unwrap_or_default();
    tauri::ipc::Response::new(
        samples
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect::<Vec<u8>>(),
    )
}

/// Write a recording of the DJ mix, which the UI encoded, where the DJ
/// chose with `export_choose_file`.
#[tauri::command]
fn dj_save_recording(path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, bytes).map_err(|error| format!("{path} couldn't be written: {error}"))
}

#[tauri::command]
fn audio_audition_stop(app: State<'_, App>) {
    if let Some(output) = lock(&app.audio).as_mut() {
        output.controller.stop_audition();
    }
}

/// How `audio_analyse` encodes the render when the Assistant is to hear it,
/// as the UI's `LISTENING` gives it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListeningFormat {
    sample_rate: u32,
    max_seconds: f64,
}

/// The latest figures, or None when no audio is running.
/// Audio Analysis of the Project as `commands` describe it, on a fresh
/// engine of its own and a blocking thread, so neither the audio thread nor
/// the IPC ones wait on the render.
#[tauri::command]
async fn audio_analyse(
    commands: Vec<EngineCommand>,
    start: f64,
    end: f64,
    track: Option<usize>,
    spectrogram: Option<bool>,
    audio: Option<ListeningFormat>,
) -> Result<analyse::Analysed, String> {
    let attachments = Attachments {
        spectrogram: spectrogram.unwrap_or(false),
        audio: audio.map(|format| Listening {
            sample_rate: format.sample_rate,
            max_seconds: format.max_seconds,
        }),
    };
    tauri::async_runtime::spawn_blocking(move || {
        analyse::analyse_with(commands, start, end, track, attachments)
    })
    .await
    .map_err(|error| format!("The analysis failed: {error}"))
}

#[tauri::command]
fn audio_stats(app: State<'_, App>) -> Option<Measured> {
    lock(&app.audio)
        .as_mut()
        .map(|output| output.controller.stats().snapshot())
}

/// The live notes recorded since the last call. Empty when no audio is
/// running, or when nothing was played.
#[tauri::command]
fn audio_recorded_notes(app: State<'_, App>) -> Vec<RecordedNoteEvent> {
    lock(&app.audio)
        .as_mut()
        .map(|output| output.controller.take_recorded_notes())
        .unwrap_or_default()
}

#[tauri::command]
fn audio_reset_counters(app: State<'_, App>) {
    if let Some(output) = lock(&app.audio).as_mut() {
        output.controller.stats().reset_counters();
    }
}

#[tauri::command]
fn audio_close(app: State<'_, App>) {
    lock(&app.midi).route_to(None);
    lock(&app.headphones).stream = None;
    *lock(&app.audio) = None;
}

/// The output devices headphones can be on, on the running output's host.
#[tauri::command]
fn headphones_devices(app: State<'_, App>) -> Result<Vec<headphones::HeadphoneDevice>, String> {
    let host = lock(&app.audio)
        .as_ref()
        .map(|output| output.info.host.clone());
    headphones::devices(host.as_deref())
}

/// Play the headphone cue out of `device`, or out of no second device with
/// None. Kept for the next time audio starts, too.
#[tauri::command]
fn headphones_choose(app: State<'_, App>, device: Option<String>) -> headphones::HeadphoneStatus {
    let mut audio = lock(&app.audio);
    let mut phones = lock(&app.headphones);
    phones.device = device;
    apply_headphones(&mut audio, &mut phones);
    status(&phones)
}

#[tauri::command]
fn headphones_status(app: State<'_, App>) -> headphones::HeadphoneStatus {
    status(&lock(&app.headphones))
}

fn status(phones: &Headphones) -> headphones::HeadphoneStatus {
    match &phones.stream {
        Some(stream) => stream.status(),
        None => headphones::HeadphoneStatus {
            device: phones.device.clone(),
            sample_rate: None,
            failed: phones.error.clone(),
        },
    }
}

/// The audio inputs on the running output's host, the default first, with
/// their channel counts.
#[tauri::command]
fn audio_input_devices(app: State<'_, App>) -> Result<Vec<InputDevice>, String> {
    let host = lock(&app.audio)
        .as_ref()
        .map(|output| output.info.host.clone());
    audio_input::input_devices(host.as_deref())
}

/// Arm: open `device` (or the default input) on the output's host, replacing
/// any open input, and start metering it, with one take for each armed
/// Track's channels in `taps`. `tracks` are those Tracks' places in the
/// engine, in the same order: each hears its tap when its Input Monitoring
/// is on, when the input runs at the output's sample rate (the engine
/// resamples a take, but not live input).
#[tauri::command]
fn audio_input_open(
    app: State<'_, App>,
    device: Option<String>,
    taps: Vec<Tap>,
    tracks: Vec<usize>,
) -> Result<InputInfo, String> {
    // The output before the input, as recording locks them.
    let mut audio = lock(&app.audio);
    let mut open = lock(&app.input);
    *open = None;
    if let Some(output) = audio.as_mut() {
        output.controller.set_monitor(None);
    }
    let host = audio.as_ref().map(|output| output.info.host.clone());
    let (writer, reader) = monitor::monitor(taps.len());
    let input = audio_input::open(host.as_deref(), device.as_deref(), &taps, Some(writer))?;
    if let Some(output) = audio.as_mut()
        && output.info.sample_rate == input.info.sample_rate
        && tracks.len() == taps.len()
    {
        output
            .controller
            .set_monitor(Some(MonitorFeed::new(reader, tracks)));
    }
    let info = input.info.clone();
    *open = Some(input);
    Ok(info)
}

/// Each armed Track's loudest sample since the last call, in the order they
/// were opened; none when no input is open.
#[tauri::command]
fn audio_input_levels(app: State<'_, App>) -> Vec<f32> {
    lock(&app.input)
        .as_ref()
        .map(|input| input.recorder.take_peaks())
        .unwrap_or_default()
}

#[tauri::command]
fn audio_input_close(app: State<'_, App>) {
    *lock(&app.input) = None;
    if let Some(output) = lock(&app.audio).as_mut() {
        output.controller.set_monitor(None);
    }
}

/// Start a take on the open input, timed against the running output. The UI
/// starts the transport straight after.
#[tauri::command]
fn audio_record_start(app: State<'_, App>) -> Result<(), String> {
    let audio = lock(&app.audio);
    let output = audio.as_ref().ok_or("Start audio before recording")?;
    let input = lock(&app.input);
    let input = input.as_ref().ok_or("Choose an input to record from")?;
    input.recorder.start(&output.clock);
    Ok(())
}

/// Where a finished take goes, in the UI's terms. Its WAV file is fetched
/// with `audio_record_take`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordedTake {
    start_tick: u64,
    seconds: f64,
}

/// Stop the takes and place them on the timeline, taking `offset_ms` of
/// latency the driver doesn't report off: one per armed Track, in the order
/// they were opened, or none when nothing was recorded.
#[tauri::command]
fn audio_record_stop(app: State<'_, App>, offset_ms: f64) -> Result<Vec<RecordedTake>, String> {
    let placed = {
        let audio = lock(&app.audio);
        let output = audio.as_ref().ok_or("Audio stopped before the take did")?;
        let input = lock(&app.input);
        let input = input
            .as_ref()
            .ok_or("The input closed before the take stopped")?;
        input.recorder.stop(&output.clock, offset_ms / 1_000.0)?
    };
    *lock(&app.takes) = placed
        .iter()
        .map(|take| wav_bytes(&take.samples, take.sample_rate, SampleFormat::Int24))
        .collect();
    Ok(placed
        .iter()
        .map(|take| RecordedTake {
            start_tick: take.start_tick,
            seconds: take.seconds(),
        })
        .collect())
}

/// The last recording's `index`th WAV file, as raw bytes rather than JSON;
/// empty once taken.
#[tauri::command]
fn audio_record_take(app: State<'_, App>, index: usize) -> tauri::ipc::Response {
    let bytes = lock(&app.takes)
        .get_mut(index)
        .map(std::mem::take)
        .unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

/// Which folder chooser to show: one for an existing Project folder, or one
/// that names a new folder to save into.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum ChooseMode {
    Open,
    Save,
}

/// Ask for a Project folder. The path comes back as the UI's folder id; None
/// when the musician closes the chooser. Saving makes the folder, so the
/// chooser can name one that isn't there yet.
#[tauri::command]
async fn project_choose_folder(
    app: tauri::AppHandle,
    mode: ChooseMode,
    name: Option<String>,
) -> Result<Option<String>, String> {
    let dialog = app.dialog().file().set_title(match mode {
        ChooseMode::Open => "Open Project",
        ChooseMode::Save => "Save Project as a folder",
    });
    let chosen = match mode {
        ChooseMode::Open => dialog.blocking_pick_folder(),
        // A save chooser, so a new folder can be named rather than only picked.
        ChooseMode::Save => dialog
            .set_file_name(name.unwrap_or_else(|| "Untitled".into()))
            .blocking_save_file(),
    };
    let Some(path) = chosen
        .as_ref()
        .and_then(tauri_plugin_dialog::FilePath::as_path)
    else {
        return Ok(None);
    };
    if mode == ChooseMode::Save {
        project_files::make_folder(path)?;
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn project_read_text(folder: String, path: String) -> Result<String, String> {
    project_files::read_text(&folder, &path)
}

#[tauri::command]
fn project_write_text(folder: String, path: String, text: String) -> Result<(), String> {
    project_files::write_text(&folder, &path, &text)
}

/// The bytes of a file in the Project folder: a pad's WAV, read back when
/// the Project is opened. They cross Tauri's JSON IPC as a list of numbers.
#[tauri::command]
fn project_read_bytes(folder: String, path: String) -> Result<Vec<u8>, String> {
    project_files::read_bytes(&folder, &path)
}

#[tauri::command]
fn project_write_bytes(folder: String, path: String, bytes: Vec<u8>) -> Result<(), String> {
    project_files::write_bytes(&folder, &path, &bytes)
}

#[tauri::command]
fn project_append_text(folder: String, path: String, text: String) -> Result<(), String> {
    project_files::append_text(&folder, &path, &text)
}

/// The lines added to a Shared Project's file of Changes since byte `from`.
#[tauri::command]
fn project_read_lines(
    folder: String,
    path: String,
    from: u64,
) -> Result<project_files::Lines, String> {
    project_files::read_lines(&folder, &path, from)
}

#[tauri::command]
fn project_list_files(folder: String, path: String) -> Result<Vec<String>, String> {
    project_files::list_files(&folder, &path)
}

#[tauri::command]
fn project_copy_file(
    from_folder: String,
    from_path: String,
    to_folder: String,
    to_path: String,
) -> Result<(), String> {
    project_files::copy_file(&from_folder, &from_path, &to_folder, &to_path)
}

/// Ask for a folder of samples to add to the sample browser; None when the
/// musician closes the chooser.
#[tauri::command]
async fn samples_choose_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Add a sample folder")
        .blocking_pick_folder()
        .as_ref()
        .and_then(tauri_plugin_dialog::FilePath::as_path)
        .map(|path| path.to_string_lossy().into_owned())
}

/// A file the musician chose, by its own name, with its bytes.
#[derive(Debug, Serialize)]
struct ChosenFile {
    name: String,
    bytes: Vec<u8>,
}

/// Ask for an audio file to be the Project's Reference Track (#106), and read
/// it; None when the musician closes the chooser. The UI copies it into the
/// Project, so the original is never read again.
#[tauri::command]
async fn reference_choose_file(app: tauri::AppHandle) -> Result<Option<ChosenFile>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Choose a Reference Track")
        .add_filter("Audio", &["wav", "flac", "mp3"])
        .blocking_pick_file()
        .as_ref()
        .and_then(tauri_plugin_dialog::FilePath::as_path)
        .map(std::path::Path::to_path_buf)
    else {
        return Ok(None);
    };
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("{} can't be read: {error}", path.display()))?;
    let name = path.file_name().map_or_else(
        || "reference".into(),
        |name| name.to_string_lossy().into_owned(),
    );
    Ok(Some(ChosenFile { name, bytes }))
}

/// The audio files in a sample folder, and every folder inside it.
#[tauri::command]
fn samples_list_audio(folder: String) -> Result<Vec<String>, String> {
    samples::list_audio(&folder)
}

/// The library's folder in the app-data folder, where User Presets and saved
/// Kits are kept outside any Project.
fn library_folder(app: &tauri::AppHandle) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("The app-data folder couldn't be found: {error}"))?;
    Ok(library::folder(&app_data))
}

#[tauri::command]
fn library_read_text(app: tauri::AppHandle, path: String) -> Result<String, String> {
    project_files::read_text(&library_folder(&app)?, &path)
}

#[tauri::command]
fn library_write_text(app: tauri::AppHandle, path: String, text: String) -> Result<(), String> {
    project_files::write_text(&library_folder(&app)?, &path, &text)
}

/// A saved Kit's sample, read back when the Kit is loaded into a Project.
#[tauri::command]
fn library_read_bytes(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    project_files::read_bytes(&library_folder(&app)?, &path)
}

#[tauri::command]
fn library_write_bytes(app: tauri::AppHandle, path: String, bytes: Vec<u8>) -> Result<(), String> {
    project_files::write_bytes(&library_folder(&app)?, &path, &bytes)
}

#[tauri::command]
fn library_list_files(app: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    project_files::list_files(&library_folder(&app)?, &path)
}

#[tauri::command]
fn library_delete_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    project_files::delete_file(&library_folder(&app)?, &path)
}

/// The Plugins folder in the app-data folder, where WASM Plugins are
/// installed for every Project to use.
fn plugins_folder(app: &tauri::AppHandle) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("The app-data folder couldn't be found: {error}"))?;
    Ok(plugin::folder(&app_data))
}

/// Install a Plugin's `.wasm`, checked by compiling it, and say what it is.
#[tauri::command]
fn plugins_install(app: tauri::AppHandle, wasm: Vec<u8>) -> Result<plugin::Installed, String> {
    plugin::install(&plugins_folder(&app)?, &wasm)
}

#[tauri::command]
fn plugins_list(app: tauri::AppHandle) -> Result<Vec<plugin::Installed>, String> {
    plugin::list(&plugins_folder(&app)?)
}

/// An installed Plugin's `.wasm`, for the UI to send the engine.
#[tauri::command]
fn plugins_read(app: tauri::AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    plugin::read(&plugins_folder(&app)?, &id).map(tauri::ipc::Response::new)
}

/// The saved Claude API key, or None when the user hasn't entered one.
#[tauri::command]
fn api_key_read() -> Result<Option<String>, String> {
    secrets::read()
}

#[tauri::command]
fn api_key_write(key: String) -> Result<(), String> {
    secrets::write(&key)
}

#[tauri::command]
fn api_key_clear() -> Result<(), String> {
    secrets::delete()
}

/// Connect to any new MIDI keyboards, and name every connected one.
#[tauri::command]
fn midi_devices(app: State<'_, App>) -> Result<Vec<String>, String> {
    lock(&app.midi).refresh()
}

/// Ask where to export the mix, or an Audio Clip when `clip` is true. The
/// path comes back, or None when the musician closes the chooser. Unlike a
/// Project folder, the file can go anywhere.
#[tauri::command]
async fn export_choose_file(
    app: tauri::AppHandle,
    name: String,
    kind: ExportKind,
    clip: Option<bool>,
) -> Option<String> {
    let (format, filter, extension) = match kind {
        ExportKind::Wav => ("WAV", "WAV audio", "wav"),
        ExportKind::Mp3 => ("MP3", "MP3 audio", "mp3"),
    };
    let what = if clip == Some(true) {
        "the Clip"
    } else {
        "the mix"
    };
    app.dialog()
        .file()
        .set_title(format!("Export {what} as {format}"))
        .add_filter(filter, &[extension])
        .set_file_name(format!("{name}.{extension}"))
        .blocking_save_file()
        .as_ref()
        .and_then(tauri_plugin_dialog::FilePath::as_path)
        .map(|path| path.to_string_lossy().into_owned())
}

/// Ask for a folder to export an Audio Clip's Slices into, one file each,
/// from the Audio Editor. The folder's path comes back, or None when the
/// musician closes the chooser.
#[tauri::command]
async fn export_choose_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Export the Slices into")
        .blocking_pick_folder()
        .as_ref()
        .and_then(tauri_plugin_dialog::FilePath::as_path)
        .map(|path| path.to_string_lossy().into_owned())
}

/// Render the mix offline on its own Engine, on a worker thread, and write it
/// to `path`. True once written; false if cancelled, when nothing is written.
/// Any export already under way is cancelled.
#[tauri::command]
async fn export_mix(
    app: State<'_, App>,
    path: String,
    request: ExportRequest,
) -> Result<bool, String> {
    let job = Arc::new(ExportJob::default());
    if let Some(previous) = lock(&app.export).replace(Arc::clone(&job)) {
        previous.cancel();
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = job.render(&request)? else {
            return Ok(false);
        };
        std::fs::write(&path, file).map_err(|error| format!("Couldn't write {path}: {error}"))?;
        Ok(true)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Write one Audio Clip's own audio, the stretch of its file it plays, to a
/// file, on a worker thread. The raw body is `export::read_clip_body`'s: the
/// path and the request, then the audio file. True once written; false if
/// cancelled, when nothing is written. It shares the mix's export slot, so
/// `export_progress` and `export_cancel` watch it, and it cancels any
/// export already under way.
#[tauri::command]
async fn export_clip(
    app: State<'_, App>,
    request: tauri::ipc::Request<'_>,
) -> Result<bool, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("The Clip to export must be sent as raw bytes.".into());
    };
    let body = body.clone();
    let job = Arc::new(ExportJob::default());
    if let Some(previous) = lock(&app.export).replace(Arc::clone(&job)) {
        previous.cancel();
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (ClipExport { path, request }, audio) = export::read_clip_body(&body)?;
        let Some(file) = job.render_clip(audio, &request)? else {
            return Ok(false);
        };
        std::fs::write(&path, file).map_err(|error| format!("Couldn't write {path}: {error}"))?;
        Ok(true)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// How far the export has got, 0 to 1.
#[tauri::command]
fn export_progress(app: State<'_, App>) -> f32 {
    lock(&app.export).as_ref().map_or(0.0, |job| job.progress())
}

#[tauri::command]
fn export_cancel(app: State<'_, App>) {
    if let Some(job) = lock(&app.export).as_ref() {
        job.cancel();
    }
}

/// The app-data folder, outside any Project, where the separation model is
/// installed.
fn app_data(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("The app-data folder couldn't be found: {error}"))
}

#[tauri::command]
fn stems_model_installed(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(stems::is_installed(&app_data(&app)?))
}

/// An `htdemucs.onnx` the musician exported where the app looks first
/// (`stems::model_candidates`): the repo's `model/` folder, then `model/`
/// beside the app. None when there isn't one, and the musician is asked.
#[tauri::command]
fn stems_find_model() -> Option<String> {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let exe = std::env::current_exe().ok();
    let beside_app = exe.as_deref().and_then(std::path::Path::parent);
    stems::find_model(&stems::model_candidates(repo, beside_app))
        .map(|path| path.to_string_lossy().into_owned())
}

/// Ask for the musician's `htdemucs.onnx`. The path comes back, or None
/// when the musician closes the chooser.
#[tauri::command]
async fn stems_choose_model(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Choose htdemucs.onnx")
        .add_filter("ONNX model", &["onnx"])
        .blocking_pick_file()
        .as_ref()
        .and_then(tauri_plugin_dialog::FilePath::as_path)
        .map(|path| path.to_string_lossy().into_owned())
}

/// Check the model at `path` is htdemucs and copy it into the app-data
/// folder, or say why not. On a blocking thread: the model is ~300 MB.
#[tauri::command]
async fn stems_install_model(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let app_data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        stems::install(&app_data, std::path::Path::new(&path))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Separate the audio file sent as the request's raw body into its Stems, on
/// a worker thread. Their names come back, in the order `stems_take` hands
/// them out, or None if cancelled, when nothing is kept. Refused while
/// another separation runs.
#[tauri::command]
async fn stems_separate(
    app: tauri::AppHandle,
    state: State<'_, App>,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<Vec<String>>, String> {
    let tauri::ipc::InvokeBody::Raw(audio) = request.body() else {
        return Err("The audio to separate must be sent as raw bytes.".into());
    };
    let audio = audio.clone();
    let model = stems::model_path(&app_data(&app)?);
    if !model.is_file() {
        return Err("The Stem Separation model isn't installed.".into());
    }
    let job = state.separations.start()?;
    lock(&state.stems).clear();
    let separated = tauri::async_runtime::spawn_blocking(move || job.run(&model, &audio))
        .await
        .map_err(|error| error.to_string())??;
    Ok(separated.map(|files| {
        *lock(&state.stems) = files;
        stems::SOURCES.map(String::from).to_vec()
    }))
}

/// How far the separation has got, 0 to 1.
#[tauri::command]
fn stems_progress(state: State<'_, App>) -> f32 {
    state.separations.progress()
}

#[tauri::command]
fn stems_cancel(state: State<'_, App>) {
    state.separations.cancel();
}

/// The last separation's `index`th Stem as a WAV file, as raw bytes rather
/// than JSON; empty once taken.
#[tauri::command]
fn stems_take(state: State<'_, App>, index: usize) -> tauri::ipc::Response {
    let bytes = lock(&state.stems)
        .get_mut(index)
        .map(std::mem::take)
        .unwrap_or_default();
    tauri::ipc::Response::new(bytes)
}

/// Open the app's window.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(App::default())
        .manage(update::Updates::default())
        .invoke_handler(tauri::generate_handler![
            audio_hosts,
            audio_open,
            audio_send,
            audio_analyse,
            audio_stats,
            audio_recorded_notes,
            audio_reset_counters,
            audio_close,
            audio_audition,
            audio_audition_reference,
            audio_audition_stop,
            dj_load,
            dj_unload,
            dj_sample_load,
            dj_sample_unload,
            dj_recording_take,
            dj_save_recording,
            headphones_devices,
            headphones_choose,
            headphones_status,
            audio_input_devices,
            audio_input_open,
            audio_input_levels,
            audio_input_close,
            audio_record_start,
            audio_record_stop,
            audio_record_take,
            midi_devices,
            project_choose_folder,
            project_read_text,
            project_write_text,
            project_read_bytes,
            project_write_bytes,
            project_list_files,
            project_append_text,
            project_read_lines,
            project_copy_file,
            samples_choose_folder,
            reference_choose_file,
            samples_list_audio,
            library_read_text,
            library_write_text,
            library_read_bytes,
            library_write_bytes,
            library_list_files,
            library_delete_file,
            plugins_install,
            plugins_list,
            plugins_read,
            api_key_read,
            api_key_write,
            api_key_clear,
            export_choose_file,
            export_choose_folder,
            export_mix,
            export_clip,
            export_progress,
            export_cancel,
            stems_model_installed,
            stems_find_model,
            stems_choose_model,
            stems_install_model,
            stems_separate,
            stems_progress,
            stems_cancel,
            stems_take,
            update::update_status,
            update::update_check,
            update::update_install,
            update::update_progress,
            vst3::commands::vst3_default_folders,
            vst3::commands::vst3_scan,
            vst3::commands::vst3_load,
            vst3::commands::vst3_unload,
            vst3::commands::vst3_keys,
            vst3::commands::vst3_poll,
            vst3::commands::vst3_state,
            vst3::commands::vst3_settings,
            vst3::commands::vst3_text,
            vst3::commands::vst3_open_editor,
            vst3::commands::vst3_close_editor,
        ])
        .run(tauri::generate_context!())
        .expect("the Soundcheck window failed to open");
}

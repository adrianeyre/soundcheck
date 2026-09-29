//! The Soundcheck Audio Engine core.
//!
//! This crate knows nothing about where it runs (ADR 0001): no audio devices,
//! no files, no browser APIs. A host adapter feeds it and plays what it
//! renders. Tests therefore render into buffers and assert on samples; neither
//! CI nor the sandbox has a sound device.

mod analysis;
mod audio_clip;
mod audio_file;
mod audio_recording;
mod audition;
mod automation;
mod bus;
mod channel_eq;
mod clip_render;
mod clip_waveform;
mod dj;
mod dsp;
mod effect;
mod engine;
mod instrument;
mod metronome;
mod mp3_writer;
mod pattern;
mod plugin;
mod record;
mod schedule;
mod stem_separation;
mod tempo_map;
mod track;
mod transport;
mod wav_writer;

use wasm_bindgen::prelude::*;

pub use analysis::{
    Analysis, BANDS, Band, ClipRegion, FILE_ANALYSIS_RATE, Key, Position, Source, Tempo,
    analyse_file, base64,
};
pub use audio_file::AudioFileError;
pub use audio_recording::{PlacedRecording, PlaybackAnchor, peak, place_recording};
pub use audition::{AUDITION_GAIN, Audition};
pub use automation::{Automatable, MAX_BREAKPOINTS};
pub use bus::{MAX_BUSES, MAX_SEND_LEVEL};
pub use channel_eq::{EQ_BANDS, EQ_RANGE_DB};
pub use clip_render::ClipRender;
pub use clip_waveform::ClipWaveform;
pub use dj::{
    BEAT_FX, COLOUR_FX, DECK_FIELDS, DECKS, DJ_REPORT_LEN, DjControl, DjMixer, DjTrack,
    GLOBAL_FIELDS, PreparedDjSample, PreparedDjTrack, SAMPLER_BANK_SLOTS, SAMPLER_BANKS,
    SAMPLER_FIELDS, SAMPLER_SLOTS, SLOT_PITCH_RANGE, SlotMode, SlotState, TrackAnalysis,
    WAVEFORM_RATE,
};
pub use dj::{
    DeckMode, PositionTable, TIMECODE_FIELDS, TIMECODE_FORMATS, TimecodeDecoder, TimecodeFormat,
    TimecodeGenerator, VinylFrame, timecode_format,
};
pub use effect::{EffectKind, MAX_EFFECTS};
pub use engine::{
    Attached, Attachments, Engine, Listening, MAX_TRACKS, PreparedAudioClips, PreparedAudioFile,
    PreparedAutomation, PreparedBus, PreparedEffect, PreparedInstrument, PreparedSample,
    PreparedSends, PreparedTempoChanges, PreparedTrack, bus_chain,
};
pub use instrument::{
    KEYS_PARAMS, KeysPreset, KeysSettings, MAX_PADS, PARAMS, Param, Preset, SynthSettings,
    WavError, factory_presets, keys_factory_presets,
};
pub use mp3_writer::{MP3_BITRATES, encode_mp3, mp3_bytes};
pub use plugin::{
    ABI_VERSION, MAX_PLUGIN_SETTINGS, PluginBlock, PluginFault, PluginInstance, PluginKind,
    PluginManifest, PluginRuntime, PluginSetting,
};
pub use record::{RECORDING_CAPACITY, RecordedNote};
pub use schedule::NoteList;
pub use stem_separation::{
    MODEL_INPUT_SHAPE, MODEL_OUTPUT_SHAPE, SEGMENT, STEM_NAMES, STEM_SAMPLE_RATE, StemSeparation,
    stem_separation_model,
};
pub use transport::TICKS_PER_BEAT;
pub use wav_writer::{SampleFormat, encode_wav, mono_wav_bytes, wav_bytes};

/// The engine's version, so the UI can show which build it loaded: the
/// app's, from the root `package.json` (`build.rs`).
#[wasm_bindgen]
pub fn engine_version() -> String {
    env!("SOUNDCHECK_VERSION").to_string()
}

/// Every Synth setting the UI can draw and the **Assistant** can set, as
/// JSON: name, label, unit, range, default and choices for each.
#[wasm_bindgen]
pub fn synth_parameters() -> String {
    instrument::parameters_json()
}

/// Every Effect's settings as JSON, keyed by the Effect's name (one of
/// `EffectKind::ALL`'s, such as "eq" or "trancegate"): name, label, unit,
/// range, default and choices for each, in the order the flat form lists them.
#[wasm_bindgen]
pub fn effect_parameters() -> String {
    effect::effect_parameters_json()
}

/// A Plugin's manifest, checked and written out in one form, so the UI
/// reads a Plugin's settings exactly as the engine hosts them. Throws what is
/// wrong with one that doesn't check out.
#[wasm_bindgen]
pub fn plugin_manifest(json: &str) -> Result<String, String> {
    PluginManifest::parse(json).map(|manifest| manifest.to_json())
}

/// The Plugin ABI version this engine hosts (ADR 0003).
#[wasm_bindgen]
pub fn plugin_abi_version() -> u32 {
    ABI_VERSION
}

/// How much an EQ with `settings` (its flat form) scales a sine at each of
/// `frequencies`, in dB, at `sample_rate`: the curve the frequency-response
/// display draws, worked out from the same filters the EQ runs.
#[wasm_bindgen]
pub fn eq_response(settings: &[f32], frequencies: &[f32], sample_rate: f32) -> Vec<f32> {
    use effect::Settings;
    let settings = effect::EqSettings::from_flat(settings);
    frequencies
        .iter()
        .map(|&frequency| effect::eq_response_db(sample_rate, &settings, frequency))
        .collect()
}

/// The factory presets as JSON: name, category, description and settings for
/// each, in the order the preset picker lists them.
#[wasm_bindgen]
pub fn synth_presets() -> String {
    instrument::presets_json()
}

/// Every setting of the Keys as JSON, as `synth_parameters` has the Synth's.
#[wasm_bindgen]
pub fn keys_parameters() -> String {
    instrument::keys_parameters_json()
}

/// The Keys' factory presets as JSON: name, category, description and settings for each.
#[wasm_bindgen]
pub fn keys_presets() -> String {
    instrument::keys_presets_json()
}

/// The bundled starter kit's pads as JSON — name, note and choke group for
/// each, in pad order — so the UI labels the Step Sequencer with the same
/// pads the engine plays.
#[wasm_bindgen]
pub fn starter_kit() -> String {
    instrument::starter_kit_json()
}

/// What the UI needs to place and draw an audio file before it plays: its
/// length in seconds, then the loudest sample in each of `points` equal
/// stretches of it, for its waveform. Throws what is wrong with a file that
/// isn't WAV, FLAC or MP3.
#[wasm_bindgen]
pub fn audio_file_summary(bytes: &[u8], points: usize) -> Result<Vec<f32>, String> {
    let decoded = audio_file::decode(bytes).map_err(|error| error.message().to_string())?;
    let mut summary = vec![decoded.seconds() as f32];
    summary.extend(decoded.peaks(points));
    Ok(summary)
}

/// The whole of an audio file measured, as `Engine::analyse` measures a
/// render, in the same compact JSON: the Reference Track's measurements
/// (#106). Throws what is wrong with a file that isn't WAV, FLAC or MP3.
#[wasm_bindgen]
pub fn analyse_audio_file(bytes: &[u8]) -> Result<String, String> {
    analysis::analyse_file(bytes)
        .map(|analysis| analysis.to_json())
        .map_err(|error| error.message().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_audio_files_summary_is_its_length_then_its_waveform() {
        let summary = audio_file_summary(audio_file::tests::TONE_FLAC, 10).unwrap();
        assert_eq!(summary.len(), 11);
        assert!((summary[0] - 0.25).abs() < 1e-6);
        assert!(summary[1..].iter().all(|&peak| (peak - 0.5).abs() < 0.01));
        assert!(audio_file_summary(b"nope", 10).is_err());
    }

    #[test]
    fn the_version_is_the_apps() {
        let package: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).unwrap();
        assert_eq!(engine_version(), package["version"].as_str().unwrap());
    }

    #[test]
    fn the_settings_and_presets_are_published_as_json() {
        assert!(synth_parameters().contains("\"name\":\"cutoffHz\""));
        assert!(synth_presets().contains("\"name\":\"Warm Pad\""));
        assert!(keys_parameters().contains("\"name\":\"rootNote\""));
        assert!(keys_presets().contains("\"name\":\"Honky-Tonk\""));
    }

    #[test]
    fn the_effects_settings_and_the_eq_curve_are_published() {
        assert!(effect_parameters().contains(r#""name":"band1GainDb""#));
        let flat = eq_response(&[], &[100.0, 1_000.0], 48_000.0);
        assert_eq!(flat.len(), 2);
        assert!(flat.iter().all(|db| db.abs() < 1e-3), "{flat:?}");
    }

    #[test]
    fn the_starter_kit_is_published_as_json() {
        assert!(starter_kit().contains("\"name\":\"Kick\""));
    }
}

/// A file decoded, converted to `sample_rate` and analysed for a Deck of
/// the DJ Mixer, off the audio thread: the browser does this on the page's
/// thread and hands the samples to the AudioWorklet.
#[wasm_bindgen]
pub struct DjPrepared(PreparedDjTrack);

#[wasm_bindgen]
impl DjPrepared {
    pub fn left(&self) -> Vec<f32> {
        self.0.track.file.left().to_vec()
    }

    pub fn right(&self) -> Vec<f32> {
        self.0.track.file.right().to_vec()
    }

    pub fn bpm(&self) -> f64 {
        self.0.track.bpm
    }

    pub fn first_beat(&self) -> f64 {
        self.0.track.first_beat
    }

    /// Its BPM, Beat Grid, key and waveform, as JSON.
    pub fn analysis(&self) -> String {
        self.0.analysis.to_json()
    }
}

/// Decode and analyse a WAV, FLAC or MP3 file for a Deck at `sample_rate`.
#[wasm_bindgen]
pub fn dj_prepare(bytes: &[u8], sample_rate: f32) -> Result<DjPrepared, String> {
    PreparedDjTrack::decode(bytes, sample_rate)
        .map(DjPrepared)
        .map_err(|error| error.message().to_string())
}

/// A sample decoded for a Sampler Slot at the engine's rate, and its tempo
/// found, on the page's thread, so the audio thread only moves it in.
#[wasm_bindgen]
pub struct DjPreparedSample(PreparedDjSample);

#[wasm_bindgen]
impl DjPreparedSample {
    pub fn left(&self) -> Vec<f32> {
        self.0.file.left().to_vec()
    }

    pub fn right(&self) -> Vec<f32> {
        self.0.file.right().to_vec()
    }

    /// How long it plays, in seconds at `sample_rate`.
    pub fn seconds(&self, sample_rate: f32) -> f64 {
        self.0.seconds(sample_rate)
    }

    /// Its tempo, by the Decks' analysis; 0 when none was found.
    pub fn bpm(&self) -> f64 {
        self.0.bpm
    }
}

/// Decode a WAV, FLAC or MP3 file for a Sampler Slot at `sample_rate`, and
/// find its tempo.
#[wasm_bindgen]
pub fn dj_prepare_sample(bytes: &[u8], sample_rate: f32) -> Result<DjPreparedSample, String> {
    PreparedDjSample::decode(bytes, sample_rate)
        .map(DjPreparedSample)
        .map_err(|error| error.message().to_string())
}

/// The bundled Starter Kit's sample at `index` (in `starter_kit`'s order),
/// as the WAV file's bytes, or nothing past its end: the Sampler's first
/// bank plays these out of the box.
#[wasm_bindgen]
pub fn starter_kit_wav(index: usize) -> Option<Vec<u8>> {
    instrument::kit_wav(index).map(<[u8]>::to_vec)
}

/// The Beat FX and Colour FX, by name, in the order the mixer selects them.
#[wasm_bindgen]
pub fn dj_effects() -> String {
    let list = |names: &[&str]| {
        names
            .iter()
            .map(|n| format!(r#""{n}""#))
            .collect::<Vec<_>>()
            .join(",")
    };
    format!(
        r#"{{"beatFx":[{}],"colourFx":[{}],"reportLength":{DJ_REPORT_LEN},"samplerSlots":{SAMPLER_SLOTS}}}"#,
        list(BEAT_FX),
        list(COLOUR_FX)
    )
}

/// The timecode records a Deck can read in REL and ABS, in the order its
/// `timecodeFormat` control numbers them from 1 (0 is Auto), as JSON:
/// each one's id, label and carrier in Hz.
#[wasm_bindgen]
pub fn timecode_formats() -> String {
    let formats = TIMECODE_FORMATS
        .iter()
        .map(|f| {
            format!(
                r#"{{"id":"{}","label":"{}","carrier":{}}}"#,
                f.id,
                f.label.replace('"', "\\\""),
                f.carrier
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("[{formats}]")
}

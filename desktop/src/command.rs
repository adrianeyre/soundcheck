//! What the UI asks the Audio Engine to do, and what reaches the audio thread.
//!
//! `EngineCommand` mirrors `EngineCommand` in `app/src/audio/audio-output.ts`
//! and arrives over Tauri IPC as JSON. The control side turns each into
//! `RtCommand`s, doing any allocating first, so the audio thread only ever
//! moves prepared data into the engine.

use serde::{Deserialize, Serialize};
use soundcheck_engine::{
    DjControl, DjMixer, DjTrack, KeysSettings, NoteList, PreparedAudioClips, PreparedAudioFile,
    PreparedAutomation, PreparedBus, PreparedEffect, PreparedInstrument, PreparedSample,
    PreparedSends, PreparedTempoChanges, PreparedTrack, RecordedNote, SynthSettings,
};

use crate::monitor::MonitorFeed;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EngineCommand {
    NoteOn {
        note: u8,
        velocity: f32,
    },
    NoteOff {
        note: u8,
    },
    SetTrackCount {
        count: usize,
    },
    SetTrackNotes {
        track: usize,
        notes: Vec<f64>,
    },
    SetTrackMixer {
        track: usize,
        volume: f32,
        pan: f32,
        mute: bool,
        solo: bool,
    },
    SetMasterVolume {
        volume: f32,
    },
    /// The Automation of one setting of a Track, a Bus or the Master,
    /// numbered as an Insert Chain is (`Engine::set_automation` names the
    /// settings): flat tick, value and hold for each breakpoint.
    SetAutomation {
        target: i32,
        setting: String,
        points: Vec<f64>,
    },
    SetBusCount {
        count: usize,
    },
    SetBusMixer {
        bus: usize,
        volume: f32,
        pan: f32,
        mute: bool,
        solo: bool,
    },
    /// Where a Track's signal goes: a Bus's index, or below zero for the
    /// Master.
    SetTrackOutput {
        track: usize,
        output: i32,
    },
    /// Where a Bus's signal goes, as for a Track. The engine refuses a loop.
    SetBusOutput {
        bus: usize,
        output: i32,
    },
    /// A Track's or Bus's Sends: `channel` numbers it as chains do (a
    /// Track's index, or -2 - b for Bus b), and `sends` is flat, a Bus's
    /// index and a level for each. The engine refuses a loop.
    SetSends {
        channel: i32,
        sends: Vec<f64>,
    },
    SetSynthSettings {
        /// The Track's index, or below zero for the live Track.
        track: i32,
        settings: Vec<f32>,
    },
    SetTrackInstrument {
        track: usize,
        instrument: String,
        /// How many pads a Drum Sampler's kit has (up to 32), or the bundled
        /// kit's own size where the UI doesn't say. Nothing to any other
        /// Instrument.
        #[serde(default)]
        pads: Option<usize>,
    },
    SetPad {
        track: usize,
        pad: usize,
        note: u8,
        volume: f32,
        pan: f32,
        pitch: f32,
        choke_group: u8,
    },
    /// The bytes of a WAV file, as the UI sends them: JSON has no bytes, so
    /// they arrive as a list of numbers.
    SetPadSample {
        track: usize,
        pad: usize,
        wav: Vec<u8>,
    },
    /// Take the musician's own WAV off a pad, so that it plays the bundled
    /// kit's own sample again, or nothing past the kit's end.
    ClearPadSample {
        track: usize,
        pad: usize,
    },
    /// The Keys' settings, flat, as their table declares them.
    SetKeysSettings {
        track: usize,
        settings: Vec<f32>,
    },
    /// The WAV the Keys play across the keyboard, as `setPadSample` sends one.
    SetKeysSample {
        track: usize,
        wav: Vec<u8>,
    },
    /// Take the sample off the Keys.
    ClearKeysSample {
        track: usize,
    },
    /// Add an Effect, with its default settings, to an Insert Chain.
    /// `chain` is a Track's index, -1 for the Master's, or -2 - b for Bus b's.
    InsertEffect {
        chain: i32,
        index: usize,
        effect: String,
    },
    /// Compile a WASM Plugin's `.wasm`, as a list of numbers, so Effect
    /// slots can host it by its id. Sent once per installed Plugin the
    /// Project uses, before any `InsertPlugin` of it.
    LoadPlugin {
        plugin: String,
        wasm: Vec<u8>,
    },
    /// Add the Plugin Effect `plugin`, at its default settings, to an Insert
    /// Chain. A Plugin this host hasn't loaded goes in as a missing Plugin,
    /// which passes audio through.
    InsertPlugin {
        chain: i32,
        index: usize,
        plugin: String,
    },
    /// Make a Track's Instrument the Plugin Instrument `plugin`, at its
    /// default settings. A Plugin this host hasn't loaded, or one that isn't
    /// an Instrument, goes in as a missing Plugin, which is silent.
    SetTrackPlugin {
        track: usize,
        plugin: String,
    },
    /// Add the VST3 Plugin Effect loaded as `instance` (its key in the
    /// Desktop App's registry), in the load `generation` names, to an Insert
    /// Chain, where its settings are now. One that isn't loaded, or is loaded
    /// again since, goes in as a missing Plugin, which passes audio through.
    InsertVst3 {
        chain: i32,
        index: usize,
        instance: String,
        generation: u32,
    },
    /// Make a Track's Instrument the VST3 Plugin Instrument loaded as
    /// `instance`, as `InsertVst3`; missing, it is silent.
    SetTrackVst3 {
        track: usize,
        instance: String,
        generation: u32,
    },
    /// The flat form a Plugin Instrument's settings table declares.
    SetInstrumentSettings {
        track: usize,
        settings: Vec<f32>,
    },
    RemoveEffect {
        chain: i32,
        index: usize,
    },
    /// Move the Effect at `from` to `to`, its position once moved.
    MoveEffect {
        chain: i32,
        from: usize,
        to: usize,
    },
    SetEffectBypassed {
        chain: i32,
        index: usize,
        bypassed: bool,
    },
    /// The flat form the Effect's settings table declares.
    SetEffectSettings {
        chain: i32,
        index: usize,
        settings: Vec<f32>,
    },
    /// Make a Track an Audio Track, or an Instrument Track again.
    SetTrackAudio {
        track: usize,
        audio: bool,
    },
    /// Turn an Audio Track's Input Monitoring on or off: while it is armed,
    /// it plays its live input through its Insert Chain.
    SetTrackMonitoring {
        track: usize,
        on: bool,
    },
    /// The bytes of a WAV, FLAC or MP3 file, as a list of numbers, for Audio
    /// Clips to play as file number `file`.
    LoadAudioFile {
        file: u32,
        bytes: Vec<u8>,
    },
    UnloadAudioFile {
        file: u32,
    },
    /// Flat start tick, length in seconds, file number and seconds into the
    /// file, for each Audio Clip.
    SetTrackAudioClips {
        track: usize,
        clips: Vec<f64>,
    },
    SetPatternPlaying {
        playing: bool,
    },
    SetLatencyTest {
        on: bool,
    },
    /// Play live notes through this Instrument Track, or through the engine's
    /// own live Synth with `null`.
    SetLiveTrack {
        track: Option<usize>,
    },
    SetRecording {
        on: bool,
    },
    Play,
    Stop,
    Seek {
        tick: f64,
    },
    SetTempo {
        bpm: f64,
    },
    SetTimeSignature {
        beats_per_bar: u32,
        beat_unit: u32,
    },
    /// Flat tick, tempo, beats per bar and beat unit for each Tempo Change.
    SetTempoChanges {
        changes: Vec<f64>,
    },
    SetLoop {
        start_tick: f64,
        end_tick: f64,
        enabled: bool,
    },
    /// Where Play stops, and goes back to, while the loop is off.
    SetPlayRange {
        start_tick: f64,
        end_tick: f64,
    },
    SetMetronome {
        on: bool,
    },
    /// A control of the Mixer page's DJ Mixer (ADR 0013): `kind` is
    /// "deck", "channel" or "mixer", and `index` the Deck's or channel's.
    DjSet {
        kind: String,
        index: usize,
        name: String,
        value: f64,
    },
}

/// One change the audio thread makes to the engine. Nothing here allocates
/// or frees when applied: prepared data moves in, and what it replaces goes
/// back as `Garbage`.
pub enum RtCommand {
    NoteOn {
        note: u8,
        velocity: f32,
    },
    NoteOff {
        note: u8,
    },
    SetNotes {
        track: usize,
        notes: NoteList,
    },
    SetTrackMixer {
        track: usize,
        volume: f32,
        pan: f32,
        mute: bool,
        solo: bool,
    },
    SetMasterVolume(f32),
    SetAutomation {
        target: i32,
        automation: PreparedAutomation,
    },
    AddBus(PreparedBus),
    RemoveBus,
    SetBusMixer {
        bus: usize,
        volume: f32,
        pan: f32,
        mute: bool,
        solo: bool,
    },
    SetTrackOutput {
        track: usize,
        output: i32,
    },
    SetBusOutput {
        bus: usize,
        output: i32,
    },
    SetSends(PreparedSends),
    SetSynth {
        track: i32,
        settings: SynthSettings,
    },
    AddTrack(PreparedTrack),
    RemoveTrack,
    SetInstrument {
        track: usize,
        instrument: PreparedInstrument,
    },
    SetPad {
        track: usize,
        pad: usize,
        note: u8,
        volume: f32,
        pan: f32,
        pitch: f32,
        choke_group: u8,
    },
    SetPadSample {
        track: usize,
        pad: usize,
        sample: PreparedSample,
    },
    /// Leave a pad with no sample: the pads past the bundled kit's end have
    /// no sound of their own to go back to.
    ClearPadSample {
        track: usize,
        pad: usize,
    },
    SetKeys {
        track: usize,
        settings: KeysSettings,
    },
    /// The Keys' sample, decoded on the control side, or none to take it off.
    SetKeysSample {
        track: usize,
        sample: Option<PreparedSample>,
    },
    InsertEffect {
        chain: i32,
        index: usize,
        effect: PreparedEffect,
    },
    RemoveEffect {
        chain: i32,
        index: usize,
    },
    MoveEffect {
        chain: i32,
        from: usize,
        to: usize,
    },
    SetEffectBypassed {
        chain: i32,
        index: usize,
        bypassed: bool,
    },
    SetEffectSettings {
        chain: i32,
        index: usize,
        settings: EffectSettings,
    },
    /// A Plugin Instrument's settings, which fit the same fixed array as an
    /// Effect's.
    SetInstrumentSettings {
        track: usize,
        settings: EffectSettings,
    },
    SetTrackAudio {
        track: usize,
        audio: bool,
    },
    SetTrackMonitoring {
        track: usize,
        on: bool,
    },
    /// The live input armed Tracks monitor, or none once the input closes.
    SetMonitor(Option<Box<MonitorFeed>>),
    SetAudioClips {
        track: usize,
        clips: PreparedAudioClips,
    },
    SetLatencyTest(bool),
    SetLiveTrack(Option<usize>),
    SetRecording(bool),
    Play,
    Stop,
    Seek(f64),
    SetTempo(f64),
    SetTimeSignature {
        beats_per_bar: u32,
        beat_unit: u32,
    },
    SetTempoChanges(PreparedTempoChanges),
    SetLoop {
        start: f64,
        end: f64,
        enabled: bool,
    },
    SetPlayRange {
        start: f64,
        end: f64,
    },
    SetMetronome(bool),
    /// Audition a file from the sample browser or the Reference Track,
    /// straight to the output, at a linear gain.
    Audition(PreparedAudioFile, f32),
    StopAudition,
    /// The DJ Mixer, built off the audio thread the first time the Mixing
    /// page is used.
    DjInstall(Box<DjMixer>),
    /// A file for a Deck, decoded and analysed, or None to take it off.
    DjLoad {
        deck: usize,
        track: Option<DjTrack>,
    },
    DjSet(DjControl, f64),
    /// Where the headphone cue goes for a second output device, or None
    /// when there is none (`headphones.rs`).
    SetHeadphones(Option<Box<rtrb::Producer<f32>>>),
}

/// The most settings any Effect has: a Plugin may declare this many.
pub const MAX_EFFECT_SETTINGS: usize = soundcheck_engine::MAX_PLUGIN_SETTINGS;

/// An Effect's settings in their flat form, held in a fixed array so the
/// audio thread can take them without anything to free. The engine clamps
/// them to the Effect's table as it applies them, which allocates nothing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EffectSettings {
    values: [f32; MAX_EFFECT_SETTINGS],
    len: usize,
}

impl EffectSettings {
    /// The first `MAX_EFFECT_SETTINGS` of `values`.
    pub fn from_flat(values: &[f32]) -> Self {
        let len = values.len().min(MAX_EFFECT_SETTINGS);
        let mut settings = Self {
            values: [0.0; MAX_EFFECT_SETTINGS],
            len,
        };
        settings.values[..len].copy_from_slice(&values[..len]);
        settings
    }

    pub fn as_slice(&self) -> &[f32] {
        &self.values[..self.len]
    }
}

/// A live note the engine recorded, as the UI reads it. Mirrors
/// `RecordedNoteEvent` in `app/src/audio/audio-output.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedNoteEvent {
    /// The transport position, in ticks, when the note reached the engine.
    pub tick: f64,
    pub pitch: u8,
    /// 0..=1, and 0 for a note-off.
    pub velocity: f32,
    /// A note-on; a note-off otherwise.
    pub on: bool,
}

impl From<RecordedNote> for RecordedNoteEvent {
    fn from(note: RecordedNote) -> Self {
        Self {
            tick: note.tick,
            pitch: note.pitch,
            velocity: note.velocity,
            on: note.on,
        }
    }
}

/// What the audio thread hands back, to be dropped on the control side.
pub enum Garbage {
    Notes(NoteList),
    Track(PreparedTrack),
    Bus(PreparedBus),
    Instrument(PreparedInstrument),
    Sample(PreparedSample),
    Effect(PreparedEffect),
    AudioClips(PreparedAudioClips),
    TempoChanges(PreparedTempoChanges),
    Automation(PreparedAutomation),
    Sends(PreparedSends),
    AudioFile(PreparedAudioFile),
    Monitor(Box<MonitorFeed>),
    DjTrack(DjTrack),
    DjMixer(Box<DjMixer>),
    Headphones(Box<rtrb::Producer<f32>>),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> EngineCommand {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn a_dj_control_arrives_under_the_names_the_typescript_uses() {
        assert_eq!(
            parse(r#"{"type":"djSet","kind":"deck","index":1,"name":"tempo","value":0.04}"#),
            EngineCommand::DjSet {
                kind: "deck".into(),
                index: 1,
                name: "tempo".into(),
                value: 0.04,
            }
        );
    }

    #[test]
    fn insert_chain_commands_arrive_under_the_names_the_typescript_uses() {
        assert_eq!(
            parse(r#"{"type":"insertEffect","chain":-1,"index":0,"effect":"eq"}"#),
            EngineCommand::InsertEffect {
                chain: -1,
                index: 0,
                effect: "eq".to_string()
            }
        );
        assert_eq!(
            parse(r#"{"type":"moveEffect","chain":2,"from":0,"to":1}"#),
            EngineCommand::MoveEffect {
                chain: 2,
                from: 0,
                to: 1
            }
        );
        assert_eq!(
            parse(r#"{"type":"setEffectBypassed","chain":0,"index":1,"bypassed":true}"#),
            EngineCommand::SetEffectBypassed {
                chain: 0,
                index: 1,
                bypassed: true
            }
        );
        assert_eq!(
            parse(r#"{"type":"setEffectSettings","chain":0,"index":1,"settings":[1,2]}"#),
            EngineCommand::SetEffectSettings {
                chain: 0,
                index: 1,
                settings: vec![1.0, 2.0]
            }
        );
        assert_eq!(
            parse(r#"{"type":"removeEffect","chain":0,"index":1}"#),
            EngineCommand::RemoveEffect { chain: 0, index: 1 }
        );
    }

    #[test]
    fn bus_commands_arrive_under_the_names_the_typescript_uses() {
        assert_eq!(
            parse(r#"{"type":"setBusCount","count":2}"#),
            EngineCommand::SetBusCount { count: 2 }
        );
        assert_eq!(
            parse(
                r#"{"type":"setBusMixer","bus":1,"volume":0.5,"pan":0,"mute":true,"solo":false}"#
            ),
            EngineCommand::SetBusMixer {
                bus: 1,
                volume: 0.5,
                pan: 0.0,
                mute: true,
                solo: false
            }
        );
        assert_eq!(
            parse(r#"{"type":"setTrackOutput","track":3,"output":-1}"#),
            EngineCommand::SetTrackOutput {
                track: 3,
                output: -1
            }
        );
        assert_eq!(
            parse(r#"{"type":"setBusOutput","bus":0,"output":1}"#),
            EngineCommand::SetBusOutput { bus: 0, output: 1 }
        );
        assert_eq!(
            parse(r#"{"type":"setSends","channel":-2,"sends":[1,0.5]}"#),
            EngineCommand::SetSends {
                channel: -2,
                sends: vec![1.0, 0.5]
            }
        );
    }

    #[test]
    fn every_effects_settings_fit() {
        for kind in soundcheck_engine::EffectKind::ALL {
            assert!(kind.param_count() <= MAX_EFFECT_SETTINGS, "{kind:?}");
        }
        let settings = EffectSettings::from_flat(&[1.0; 70]);
        assert_eq!(settings.as_slice().len(), MAX_EFFECT_SETTINGS);
    }

    /// A recorded note reaches the UI under the names the TypeScript uses.
    #[test]
    fn recorded_notes_serialise_as_the_ui_reads_them() {
        let event = RecordedNoteEvent::from(RecordedNote {
            tick: 960.0,
            pitch: 60,
            velocity: 0.5,
            on: true,
        });
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"tick":960.0,"pitch":60,"velocity":0.5,"on":true}"#
        );
    }

    #[test]
    fn commands_read_the_same_json_the_ui_sends() {
        assert_eq!(
            parse(r#"{"type":"noteOn","note":60,"velocity":0.8}"#),
            EngineCommand::NoteOn {
                note: 60,
                velocity: 0.8
            }
        );
        assert_eq!(parse(r#"{"type":"play"}"#), EngineCommand::Play);
        assert_eq!(
            parse(r#"{"type":"setLoop","startTick":0,"endTick":3840,"enabled":true}"#),
            EngineCommand::SetLoop {
                start_tick: 0.0,
                end_tick: 3840.0,
                enabled: true
            }
        );
        assert_eq!(
            parse(r#"{"type":"setTimeSignature","beatsPerBar":7,"beatUnit":8}"#),
            EngineCommand::SetTimeSignature {
                beats_per_bar: 7,
                beat_unit: 8
            }
        );
        assert_eq!(
            parse(r#"{"type":"setTempoChanges","changes":[3840,90,3,4]}"#),
            EngineCommand::SetTempoChanges {
                changes: vec![3840.0, 90.0, 3.0, 4.0]
            }
        );
        assert_eq!(
            parse(r#"{"type":"setLiveTrack","track":2}"#),
            EngineCommand::SetLiveTrack { track: Some(2) }
        );
        assert_eq!(
            parse(r#"{"type":"setLiveTrack","track":null}"#),
            EngineCommand::SetLiveTrack { track: None }
        );
        assert_eq!(
            parse(r#"{"type":"setRecording","on":true}"#),
            EngineCommand::SetRecording { on: true }
        );
        assert_eq!(
            parse(r#"{"type":"setTrackNotes","track":2,"notes":[0,480,60,1]}"#),
            EngineCommand::SetTrackNotes {
                track: 2,
                notes: vec![0.0, 480.0, 60.0, 1.0]
            }
        );
        assert_eq!(
            parse(
                r#"{"type":"setTrackMixer","track":1,"volume":0.5,"pan":-1,"mute":false,"solo":true}"#
            ),
            EngineCommand::SetTrackMixer {
                track: 1,
                volume: 0.5,
                pan: -1.0,
                mute: false,
                solo: true
            }
        );
        assert_eq!(
            parse(r#"{"type":"setMasterVolume","volume":0.8}"#),
            EngineCommand::SetMasterVolume { volume: 0.8 }
        );
        assert_eq!(
            parse(r#"{"type":"setAutomation","target":-1,"setting":"volume","points":[0,1,1]}"#),
            EngineCommand::SetAutomation {
                target: -1,
                setting: "volume".into(),
                points: vec![0.0, 1.0, 1.0]
            }
        );
        assert_eq!(
            parse(r#"{"type":"setSynthSettings","track":-1,"settings":[0,1,7]}"#),
            EngineCommand::SetSynthSettings {
                track: -1,
                settings: vec![0.0, 1.0, 7.0]
            }
        );
    }

    #[test]
    fn the_drum_sampler_commands_read_the_json_the_ui_sends() {
        assert_eq!(
            parse(
                r#"{"type":"setTrackInstrument","track":1,"instrument":"drumSampler","pads":12}"#
            ),
            EngineCommand::SetTrackInstrument {
                track: 1,
                instrument: "drumSampler".to_string(),
                pads: Some(12)
            }
        );
        assert_eq!(
            parse(r#"{"type":"loadAudioFile","file":3,"bytes":[82,73,70,70]}"#),
            EngineCommand::LoadAudioFile {
                file: 3,
                bytes: b"RIFF".to_vec()
            }
        );
        assert_eq!(
            parse(r#"{"type":"setTrackAudioClips","track":2,"clips":[0,960,3,0.5]}"#),
            EngineCommand::SetTrackAudioClips {
                track: 2,
                clips: vec![0.0, 960.0, 3.0, 0.5]
            }
        );
        assert_eq!(
            parse(r#"{"type":"setTrackMonitoring","track":1,"on":true}"#),
            EngineCommand::SetTrackMonitoring { track: 1, on: true }
        );
        assert_eq!(
            parse(r#"{"type":"setTrackAudio","track":2,"audio":true}"#),
            EngineCommand::SetTrackAudio {
                track: 2,
                audio: true
            }
        );
        assert_eq!(
            parse(r#"{"type":"unloadAudioFile","file":3}"#),
            EngineCommand::UnloadAudioFile { file: 3 }
        );
        assert_eq!(
            parse(r#"{"type":"loadPlugin","plugin":"dev.x","wasm":[0,97,115,109]}"#),
            EngineCommand::LoadPlugin {
                plugin: "dev.x".to_string(),
                wasm: b"\0asm".to_vec()
            }
        );
        assert_eq!(
            parse(r#"{"type":"insertPlugin","chain":-2,"index":1,"plugin":"dev.x"}"#),
            EngineCommand::InsertPlugin {
                chain: -2,
                index: 1,
                plugin: "dev.x".to_string()
            }
        );
        assert_eq!(
            parse(r#"{"type":"insertVst3","chain":0,"index":2,"instance":"fx7","generation":3}"#),
            EngineCommand::InsertVst3 {
                chain: 0,
                index: 2,
                instance: "fx7".to_string(),
                generation: 3
            }
        );
        assert_eq!(
            parse(r#"{"type":"setTrackVst3","track":1,"instance":"t2","generation":4}"#),
            EngineCommand::SetTrackVst3 {
                track: 1,
                instance: "t2".to_string(),
                generation: 4
            }
        );
        assert_eq!(
            parse(r#"{"type":"setTrackPlugin","track":1,"plugin":"dev.x"}"#),
            EngineCommand::SetTrackPlugin {
                track: 1,
                plugin: "dev.x".to_string()
            }
        );
        assert_eq!(
            parse(r#"{"type":"setInstrumentSettings","track":1,"settings":[0.5,2]}"#),
            EngineCommand::SetInstrumentSettings {
                track: 1,
                settings: vec![0.5, 2.0]
            }
        );
        // A Synth has no pads, and an older UI sends none at all.
        assert_eq!(
            parse(r#"{"type":"setTrackInstrument","track":1,"instrument":"synth","pads":null}"#),
            EngineCommand::SetTrackInstrument {
                track: 1,
                instrument: "synth".to_string(),
                pads: None
            }
        );
        assert_eq!(
            parse(r#"{"type":"clearPadSample","track":0,"pad":2}"#),
            EngineCommand::ClearPadSample { track: 0, pad: 2 }
        );
        assert_eq!(
            parse(
                r#"{"type":"setPad","track":0,"pad":4,"note":46,"volume":0.8,"pan":-0.5,"pitch":-2,"chokeGroup":1}"#
            ),
            EngineCommand::SetPad {
                track: 0,
                pad: 4,
                note: 46,
                volume: 0.8,
                pan: -0.5,
                pitch: -2.0,
                choke_group: 1
            }
        );
        // The bytes of a file, as a list of numbers: JSON has no bytes.
        assert_eq!(
            parse(r#"{"type":"setPadSample","track":0,"pad":1,"wav":[82,73,70,70]}"#),
            EngineCommand::SetPadSample {
                track: 0,
                pad: 1,
                wav: b"RIFF".to_vec()
            }
        );
    }

    #[test]
    fn the_keys_commands_read_the_json_the_ui_sends() {
        assert_eq!(
            parse(r#"{"type":"setKeysSettings","track":2,"settings":[1,0.5]}"#),
            EngineCommand::SetKeysSettings {
                track: 2,
                settings: vec![1.0, 0.5]
            }
        );
        assert_eq!(
            parse(r#"{"type":"setKeysSample","track":0,"wav":[82,73,70,70]}"#),
            EngineCommand::SetKeysSample {
                track: 0,
                wav: vec![82, 73, 70, 70]
            }
        );
        assert_eq!(
            parse(r#"{"type":"clearKeysSample","track":3}"#),
            EngineCommand::ClearKeysSample { track: 3 }
        );
    }
}

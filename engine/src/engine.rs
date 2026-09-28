//! The Engine a host drives: every Track, the live Track the keyboard plays,
//! the transport and metronome, and the latency-test transient, mixed to
//! stereo.
//!
//! A host calls `render` once per block and copies the result out of the
//! buffers `left_ptr` and `right_ptr` point at, inside the engine's own
//! memory. Rendering therefore allocates nothing once the buffers and Tracks
//! exist, which matters on an audio thread.
//!
//! While the transport plays, `render` splits each block at the exact frame
//! of every note start, note end, metronome beat and loop wrap, so scheduled
//! events are sample-accurate whatever the block size.
//!
//! Live notes (a MIDI or computer keyboard) play the engine's own live Track
//! until `set_live_track` points them at one of the host's Tracks, and are
//! logged with the transport's position while `set_recording` is on, so a
//! host can record them into a Pattern Clip.
//!
//! Each Track and Bus feeds the Master or a Bus, and any Buses its Sends
//! name. Tracks add their signal to whatever they feed as each segment
//! renders; once the block is rendered, the Buses are mixed in an order where
//! each comes before what it feeds, so a Bus's Insert Chain hears the whole
//! block of everything that feeds it.

use wasm_bindgen::prelude::*;

use crate::audio_clip::{AudioClip, AudioClips};
use crate::audio_file::{AudioFile, AudioFileError};
use crate::automation::{Automatable, Automation, Line};
use crate::bus::{Bus, BusSend, MAX_BUSES, Output, add_following, add_scaled};
use crate::dj::{DJ_REPORT_LEN, DjControl, DjMixer, DjTrack};
use crate::effect::{Effect, EffectKind, InsertChain};
use crate::instrument::{
    DrumSampler, Instrument, MAX_PADS, PadSettings, PluginInstrument, Sample, SynthSettings,
    WavError,
};
use crate::metronome::Metronome;
use crate::plugin::{HostedPlugin, PluginInstance, PluginManifest};
use crate::record::{RecordedNote, RecordingLog};
use crate::schedule::NoteList;
use crate::tempo_map::TempoChanges;
use crate::track::{Mixer, Track};
use crate::transport::{LoopRegion, TimeSignature, Transport};

use std::collections::HashMap;
use std::sync::Arc;

/// Enough to find a machine's limit without letting a typo allocate gigabytes.
pub const MAX_TRACKS: usize = 512;

/// The Tracks' combined level, before dividing by √(Track count).
pub(crate) const TRACKS_GAIN: f32 = 0.5;
const LIVE_GAIN: f32 = 0.7;

/// The latency-test transient: one cycle of a full-scale 500 Hz square wave.
/// Its first edge is a step from silence, easy to find in a recording.
const CLICK_SECONDS: f32 = 0.002;
const CLICK_LEVEL: f32 = 0.9;

/// Block size for offline rendering; any size gives the same result.
const OFFLINE_BLOCK: usize = 1_024;

/// How fast a meter falls back from a peak, in dB per second. Slow enough
/// that a UI reading it a few times a second sees every peak, fast enough to
/// follow the music.
const METER_FALL_DB_PER_SECOND: f32 = 20.0;

/// The widest a fader goes, matching the Project's own limit.
const MAX_VOLUME: f32 = 2.0;

/// How many pads a Drum Sampler has when the host doesn't say: the bundled
/// kit's own size.
const DEFAULT_PADS: usize = crate::instrument::STARTER_KIT_PADS;

#[wasm_bindgen]
pub struct Engine {
    sample_rate: f32,
    /// Boxed, so a native host can hand one in or out without moving or
    /// freeing it on the audio thread.
    #[allow(clippy::vec_box)]
    tracks: Vec<Box<Track>>,
    /// Boxed for the same reason as the Tracks.
    #[allow(clippy::vec_box)]
    buses: Vec<Box<Bus>>,
    /// Every Bus's index, deepest first, so each Bus is mixed before the Bus
    /// it feeds.
    bus_order: Vec<usize>,
    /// A Track's output after its fader, for a Track with Sends, so the same
    /// signal reaches its output and every Send.
    post_left: Vec<f32>,
    post_right: Vec<f32>,
    live: Track,
    /// The Track live notes play, instead of `live`, while it exists.
    live_track: Option<usize>,
    /// Which pitches the live keyboard is holding down, so that changing the
    /// live Track doesn't leave a note sounding on the old one.
    live_held: [bool; 128],
    recorded: RecordingLog,
    transport: Transport,
    metronome: Metronome,
    metronome_on: bool,
    /// Scheduled events at ticks before this have been played.
    scan_from: u64,
    /// What Play plays when the loop is off: from its start, stopping at its
    /// end and going back to its start, as a song stops where it ends. None
    /// plays on for ever. An offline render ignores it, as it does the loop.
    play_range: Option<LoopRegion>,
    pattern_loaded: bool,
    latency_test: bool,
    click_frames: usize,
    click_position: Option<usize>,
    left: Vec<f32>,
    right: Vec<f32>,
    /// The Master fader: every Track goes through it.
    master_volume: f32,
    /// What moves the Master fader while the song plays.
    master_automation: Automation,
    /// The Master fader's gain at each frame of the block, following its
    /// Automation.
    master_gain: Vec<f32>,
    /// Where in the song each frame of the block is, in ticks, for
    /// Automation.
    ticks: Vec<f64>,
    /// The Master's Insert Chain, which the whole mix goes through before
    /// the fader.
    master_chain: InsertChain,
    /// The loudest sample of the last output, for the Master's meter.
    master_meter: f32,
    /// While set, only this Track renders: nothing else, not even the live
    /// Track or metronome, and mute and solo are ignored. Audio Analysis
    /// sets it around an offline render.
    isolate: Option<usize>,
    /// The offline render `start_render` began, until it finishes.
    offline: Option<export::Offline>,
    /// The audio files Audio Clips play, decoded, by the number the host
    /// gave each. A native host keeps its own and hands clips in ready-made.
    audio_files: HashMap<u32, Arc<AudioFile>>,
    /// The Mixer page's DJ Mixer (ADR 0013), once it is first used: added
    /// to the output after the song's Master is metered, so no meter,
    /// analysis or export of the song hears it.
    dj: Option<Box<DjMixer>>,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Engine {
        Engine {
            sample_rate,
            tracks: Vec::new(),
            buses: Vec::new(),
            bus_order: Vec::new(),
            post_left: Vec::new(),
            post_right: Vec::new(),
            live: Track::new(sample_rate),
            live_track: None,
            live_held: [false; 128],
            recorded: RecordingLog::default(),
            transport: Transport::new(sample_rate),
            metronome: Metronome::new(sample_rate),
            metronome_on: false,
            scan_from: 0,
            play_range: None,
            pattern_loaded: false,
            latency_test: false,
            click_frames: (CLICK_SECONDS * sample_rate) as usize,
            click_position: None,
            left: Vec::new(),
            right: Vec::new(),
            master_volume: 1.0,
            master_automation: Automation::default(),
            master_gain: Vec::new(),
            ticks: Vec::new(),
            master_chain: InsertChain::default(),
            master_meter: 0.0,
            isolate: None,
            offline: None,
            audio_files: HashMap::new(),
            dj: None,
        }
    }

    /// Set Track `track`'s mixer channel: `volume` is a linear gain from 0 to
    /// 2, `pan` runs -1 (left) to 1 (right). Values that aren't numbers, and
    /// Tracks that don't exist, are ignored.
    pub fn set_track_mixer(&mut self, track: usize, volume: f32, pan: f32, mute: bool, solo: bool) {
        if !volume.is_finite() || !pan.is_finite() {
            return;
        }
        if let Some(track) = self.tracks.get_mut(track) {
            track.set_mixer(Mixer {
                volume: volume.clamp(0.0, MAX_VOLUME),
                pan: pan.clamp(-1.0, 1.0),
                mute,
                solo,
            });
        }
    }

    /// The Master fader, a linear gain from 0 to 2.
    pub fn set_master_volume(&mut self, volume: f32) {
        if volume.is_finite() {
            self.master_volume = volume.clamp(0.0, MAX_VOLUME);
        }
    }

    pub fn master_volume(&self) -> f32 {
        self.master_volume
    }

    /// Replace the Automation of one setting of a Track, a Bus or the
    /// Master, numbered as an Insert Chain is (see `insert_effect`). The
    /// setting is "volume", "pan", "send:<bus>" for the level of the Send
    /// to that Bus, "effect:<index>:<setting>" for a number in the Effect
    /// there's table, "instrument:<setting>" for a number in the Synth's
    /// table, or "pad:<pad>:<setting>" for the "volume", "pan" or "pitch" of
    /// the Drum Sampler's pad there, counting from 0 (see
    /// `Automatable::named`).
    /// `points` is flat: tick, value and hold (anything but 0 holds) for
    /// each breakpoint; none leaves the setting at its fixed value. Anything
    /// else is ignored.
    pub fn set_automation(&mut self, target: i32, setting: &str, points: &[f64]) {
        if let Some(automation) = PreparedAutomation::new(setting, points) {
            self.swap_automation(target, automation);
        }
    }

    /// Add an Effect, with its default settings, to an Insert Chain at
    /// `index`, or at the end when `index` is past it. `chain` is a Track's
    /// index, -1 for the Master, or -2 - b for Bus b (see `bus_chain`).
    /// `kind` is one of `EffectKind`'s names, such as "eq" or "limiter".
    /// Answers whether it
    /// happened: an unknown kind, a Track that doesn't exist, or a full chain
    /// changes nothing.
    pub fn insert_effect(&mut self, chain: i32, index: usize, kind: &str) -> bool {
        let Some(kind) = EffectKind::named(kind) else {
            return false;
        };
        let effect = PreparedEffect::new(kind, self.sample_rate);
        self.insert_prepared_effect(chain, index, effect).is_ok()
    }

    /// Add a Plugin Effect to an Insert Chain, as `insert_effect` adds a
    /// built-in: `manifest` is its manifest's JSON, and `instance` is what
    /// the host's Plugin runtime made of it (see `plugin::js`). Answers
    /// whether it happened: a manifest that doesn't check out, a Track that
    /// doesn't exist, or a full chain changes nothing.
    #[cfg(target_arch = "wasm32")]
    pub fn insert_plugin_effect(
        &mut self,
        chain: i32,
        index: usize,
        manifest: &str,
        instance: crate::plugin::js::JsPluginInstance,
    ) -> bool {
        let Ok(manifest) = PluginManifest::parse(manifest) else {
            return false;
        };
        let instance = Box::new(crate::plugin::js::JsPlugin::new(instance));
        let effect = PreparedEffect::plugin(Arc::new(manifest), instance);
        self.insert_prepared_effect(chain, index, effect).is_ok()
    }

    /// Hold the place of the Plugin `id`, which the host doesn't have, in an
    /// Insert Chain: audio passes it untouched. Answers whether it happened.
    pub fn insert_missing_plugin(&mut self, chain: i32, index: usize, id: &str) -> bool {
        let effect = PreparedEffect::missing_plugin(id);
        self.insert_prepared_effect(chain, index, effect).is_ok()
    }

    /// Take the Effect at `index` out of an Insert Chain.
    pub fn remove_effect(&mut self, chain: i32, index: usize) {
        self.take_effect(chain, index);
    }

    /// Move the Effect at `from` in an Insert Chain to `to`, its position
    /// once moved. Out of range, nothing moves.
    pub fn move_effect(&mut self, chain: i32, from: usize, to: usize) {
        if let Some(chain) = self.chain_mut(chain) {
            chain.move_effect(from, to);
        }
    }

    /// Bypass an Effect, so the signal passes it untouched, or bring it
    /// back.
    pub fn set_effect_bypassed(&mut self, chain: i32, index: usize, bypassed: bool) {
        if let Some(effect) = self.effect_mut(chain, index) {
            effect.set_bypassed(bypassed);
        }
    }

    /// Change an Effect's settings: `settings` is the flat form its table
    /// declares (`effect_parameters`), and anything missing or out of range
    /// takes its default. Allocates nothing, so a native host's audio thread
    /// calls it directly.
    pub fn set_effect_settings(&mut self, chain: i32, index: usize, settings: &[f32]) {
        if let Some(effect) = self.effect_mut(chain, index) {
            effect.set_flat(settings);
        }
    }

    /// An Effect's settings in their flat form, or none if there is no such
    /// Effect.
    pub fn effect_settings(&self, chain: i32, index: usize) -> Vec<f32> {
        self.chain(chain)
            .and_then(|chain| chain.effect(index))
            .map(Effect::to_flat)
            .unwrap_or_default()
    }

    /// The kinds of the Effects in an Insert Chain, in order, joined by
    /// commas: "eq,reverb", with "plugin:<id>" for a Plugin and
    /// "missing:<id>" for one the host doesn't have.
    pub fn chain_effects(&self, chain: i32) -> String {
        let Some(chain) = self.chain(chain) else {
            return String::new();
        };
        (0..chain.len())
            .filter_map(|index| chain.effect(index))
            .map(Effect::name)
            .collect::<Vec<_>>()
            .join(",")
    }

    /// How many Effects an Insert Chain holds: 0 for a Track that doesn't
    /// exist.
    pub fn effect_count(&self, chain: i32) -> usize {
        self.chain(chain).map_or(0, InsertChain::len)
    }

    /// An Effect's gain-reduction meter, in dB (0 or more): how far a
    /// Compressor pulled the level down in the latest block. 0 for any other
    /// Effect, a bypassed one, or one that doesn't exist. Allocates nothing,
    /// so a native host's audio thread reads it directly.
    pub fn effect_gain_reduction(&self, chain: i32, index: usize) -> f32 {
        self.chain(chain)
            .and_then(|chain| chain.effect(index))
            .map_or(0.0, Effect::gain_reduction_db)
    }

    /// Whether an Effect is a Plugin that trapped or ran past its host's
    /// deadline, and is bypassed from then on. False for any other Effect,
    /// or one that doesn't exist.
    pub fn effect_faulted(&self, chain: i32, index: usize) -> bool {
        self.chain(chain)
            .and_then(|chain| chain.effect(index))
            .is_some_and(Effect::faulted)
    }

    /// Track `track`'s meter: the loudest sample it has lately put into the
    /// mix, falling back from each peak. 0 for a Track that doesn't exist.
    pub fn track_peak(&self, track: usize) -> f32 {
        self.tracks.get(track).map_or(0.0, |track| track.meter())
    }

    /// The Master's meter: the loudest sample of the engine's own output.
    pub fn master_peak(&self) -> f32 {
        self.master_meter
    }

    /// Add or remove Buses, up to `MAX_BUSES`. Whatever fed a Bus that goes
    /// feeds the Master instead.
    pub fn set_bus_count(&mut self, count: usize) {
        let count = count.min(MAX_BUSES);
        while self.buses.len() > count {
            self.remove_bus();
        }
        while self.buses.len() < count {
            self.buses.push(Box::new(Bus::new()));
            self.route();
        }
    }

    pub fn bus_count(&self) -> usize {
        self.buses.len()
    }

    /// Set Bus `bus`'s mixer channel, as `set_track_mixer` does a Track's.
    pub fn set_bus_mixer(&mut self, bus: usize, volume: f32, pan: f32, mute: bool, solo: bool) {
        if !volume.is_finite() || !pan.is_finite() {
            return;
        }
        if let Some(bus) = self.buses.get_mut(bus) {
            bus.set_mixer(Mixer {
                volume: volume.clamp(0.0, MAX_VOLUME),
                pan: pan.clamp(-1.0, 1.0),
                mute,
                solo,
            });
        }
    }

    /// Send Track `track` to Bus `output`, or to the Master when `output` is
    /// below zero. Answers whether it happened: a Track or Bus that doesn't
    /// exist changes nothing.
    pub fn set_track_output(&mut self, track: usize, output: i32) -> bool {
        let output = Output::from_index(output);
        if output.bus().is_some_and(|bus| bus >= self.buses.len()) {
            return false;
        }
        match self.tracks.get_mut(track) {
            Some(track) => {
                track.set_output(output);
                true
            }
            None => false,
        }
    }

    /// Send Bus `bus` to Bus `output`, or to the Master when `output` is
    /// below zero. Answers whether it happened: a Bus that doesn't exist,
    /// or a loop (a Bus feeding itself, however indirectly, through outputs
    /// or Sends), changes nothing. Allocates nothing.
    pub fn set_bus_output(&mut self, bus: usize, output: i32) -> bool {
        let count = self.buses.len();
        let output = Output::from_index(output);
        if bus >= count || output.bus().is_some_and(|to| to >= count) {
            return false;
        }
        let was = self.buses[bus].output();
        self.buses[bus].set_output(output);
        if self.route() {
            return true;
        }
        self.buses[bus].set_output(was);
        self.route();
        false
    }

    /// Replace the Sends of `channel`, a Track's index or -2 - b for Bus b
    /// (the numbers chains use; the Master has none). `sends` is flat: a Bus
    /// index and a level (a linear gain, 0 to 2) for each. Answers whether
    /// it happened: a channel or Bus that doesn't exist, a level that isn't
    /// a number, or a loop changes nothing.
    pub fn set_sends(&mut self, channel: i32, sends: &[f64]) -> bool {
        PreparedSends::new(channel, sends).is_some_and(|sends| self.swap_sends(sends).is_ok())
    }

    /// Bus `bus`'s meter, as `track_peak` is a Track's. 0 for a Bus that
    /// doesn't exist.
    pub fn bus_peak(&self, bus: usize) -> f32 {
        self.buses.get(bus).map_or(0.0, |bus| bus.meter())
    }

    /// Add or remove Tracks, up to `MAX_TRACKS`.
    pub fn set_track_count(&mut self, count: usize) {
        let count = count.min(MAX_TRACKS);
        self.tracks.truncate(count);
        let from = self.scan_from;
        for index in self.tracks.len()..count {
            let mut track = Track::new(self.sample_rate);
            if self.pattern_loaded {
                track.set_notes(NoteList::load_test_pattern(index), from);
            }
            self.tracks.push(Box::new(track));
        }
    }

    pub fn track_count(&self) -> usize {
        self.tracks.len()
    }

    /// Replace the notes Track `track` plays. `notes` is flat: start tick,
    /// length in ticks, MIDI pitch and velocity (0..=1) for each note. Ignored
    /// for a Track that doesn't exist.
    pub fn set_track_notes(&mut self, track: usize, notes: &[f64]) {
        self.set_track_note_list(track, NoteList::from_flat(notes));
    }

    /// Change a Track's Synth settings. `track` is the Track's index, or
    /// below zero for the live Track the keyboard plays. `settings` is the
    /// flat form the settings table declares; anything missing or out of
    /// range takes its default. Notes already sounding carry on with the new
    /// sound. Ignored for a Track that doesn't exist.
    pub fn set_track_synth(&mut self, track: i32, settings: &[f32]) {
        self.set_track_synth_settings(track, SynthSettings::from_flat(settings));
    }

    /// A Track's Synth settings in their flat form, or the defaults for a
    /// Track that doesn't exist.
    pub fn track_synth(&self, track: i32) -> Vec<f32> {
        self.synth_track(track)
            .and_then(Track::synth_settings)
            .unwrap_or_default()
            .to_flat()
    }

    /// Give Track `track` the Instrument the UI names: "synth", or
    /// "drumSampler" for the Drum Sampler with the bundled starter kit on
    /// its pads. `pads` is how many pads that kit has, for a Drum Sampler
    /// the Project says is bigger than the bundled 8 (8 to 16, PRD #10);
    /// leave it out for the bundled kit's own size. Answers whether it
    /// happened: an unknown name, or a Track that doesn't exist, changes
    /// nothing.
    pub fn set_track_instrument(
        &mut self,
        track: usize,
        instrument: &str,
        pads: Option<usize>,
    ) -> bool {
        let sample_rate = self.sample_rate;
        let pads = pads.unwrap_or(DEFAULT_PADS).clamp(1, MAX_PADS);
        let Some(track) = self.tracks.get_mut(track) else {
            return false;
        };
        if track.instrument().kind() == instrument
            && track.instrument().pad_count().is_none_or(|had| had == pads)
        {
            // Already this Instrument, and the same size: leave it, rather
            // than decoding the kit again and cutting off whatever is
            // sounding.
            return true;
        }
        match Instrument::named(instrument, sample_rate, pads) {
            Some(instrument) => {
                track.set_instrument(instrument);
                true
            }
            None => false,
        }
    }

    /// Give Track `track` an Instrument Plugin, as `set_track_instrument`
    /// gives it a built-in: `manifest` is its manifest's JSON, which must
    /// say it is an Instrument, and `instance` is what the host's Plugin
    /// runtime made of it (see `plugin::js`). It starts at its defaults.
    /// Answers whether it happened.
    #[cfg(target_arch = "wasm32")]
    pub fn set_track_plugin_instrument(
        &mut self,
        track: usize,
        manifest: &str,
        instance: crate::plugin::js::JsPluginInstance,
    ) -> bool {
        let Ok(manifest) = PluginManifest::parse(manifest) else {
            return false;
        };
        if manifest.kind != crate::plugin::PluginKind::Instrument || track >= self.tracks.len() {
            return false;
        }
        let instance = Box::new(crate::plugin::js::JsPlugin::new(instance));
        let instrument = PreparedInstrument::plugin(Arc::new(manifest), instance);
        self.swap_track_instrument(track, instrument);
        true
    }

    /// Hold the place of the Instrument Plugin `id`, which the host doesn't
    /// have, on Track `track`: it is silent. Answers whether it happened.
    pub fn set_track_missing_instrument(&mut self, track: usize, id: &str) -> bool {
        if track >= self.tracks.len() {
            return false;
        }
        self.swap_track_instrument(track, PreparedInstrument::missing(id));
        true
    }

    /// What Track `track` plays, as the UI names it: "synth",
    /// "drumSampler", "plugin:<id>" or "missing:<id>". Empty for a Track
    /// that doesn't exist.
    pub fn track_instrument(&self, track: usize) -> String {
        self.tracks
            .get(track)
            .map(|track| track.instrument().name())
            .unwrap_or_default()
    }

    /// Change the settings of Track `track`'s Instrument Plugin: `settings`
    /// is one value per setting in its manifest's order, and anything
    /// missing or out of range takes its default. Allocates nothing, so a
    /// native host's audio thread calls it directly. Ignored unless the
    /// Track plays a Plugin.
    pub fn set_track_instrument_settings(&mut self, track: usize, settings: &[f32]) {
        if let Some(plugin) = self
            .tracks
            .get_mut(track)
            .and_then(|track| track.instrument_mut().plugin_mut())
        {
            plugin.set_flat(settings);
        }
    }

    /// Track `track`'s Instrument Plugin's settings, as the host set them,
    /// or none unless it plays a Plugin.
    pub fn track_instrument_settings(&self, track: usize) -> Vec<f32> {
        self.tracks
            .get(track)
            .and_then(|track| track.instrument().plugin())
            .map(PluginInstrument::to_flat)
            .unwrap_or_default()
    }

    /// Whether Track `track` plays an Instrument Plugin that trapped or ran
    /// past its host's deadline, and is silent from then on.
    pub fn track_instrument_faulted(&self, track: usize) -> bool {
        self.tracks
            .get(track)
            .and_then(|track| track.instrument().plugin())
            .is_some_and(|plugin| plugin.plugin().faulted())
    }

    /// Set what one Drum Sampler pad does: the note that triggers it, its
    /// volume (0 to 2) and pan (-1 to 1), how far it is transposed in
    /// semitones, and its choke group (0 for none). Ignored unless that
    /// Track's Instrument is the Drum Sampler.
    // A pad is a handful of plain numbers, and wasm-bindgen takes them one
    // by one; a struct would only make the UI's side longer.
    #[allow(clippy::too_many_arguments)]
    pub fn set_track_pad(
        &mut self,
        track: usize,
        pad: usize,
        note: u8,
        volume: f32,
        pan: f32,
        pitch: f32,
        choke_group: u8,
    ) {
        if let Some(drums) = self.drums(track) {
            drums.set_pad(
                pad,
                PadSettings {
                    note,
                    volume,
                    pan,
                    pitch,
                    choke_group,
                },
            );
        }
    }

    /// Put the musician's own WAV on a pad, as the bytes of the file. It is
    /// kept in memory; copying it into the Project folder waits for #16.
    /// Answers with what is wrong with the file, or nothing if it loaded.
    pub fn load_track_pad_sample(
        &mut self,
        track: usize,
        pad: usize,
        wav: &[u8],
    ) -> Option<String> {
        let sample = match crate::instrument::decode(wav) {
            Ok(sample) => sample,
            Err(error) => return Some(error.message().to_string()),
        };
        match self.drums(track) {
            Some(drums) if pad < drums.pad_count() => {
                drums.set_sample(pad, Some(Arc::new(sample)));
                None
            }
            Some(_) => Some("This kit has no such pad".to_string()),
            None => Some("That Track isn't playing the Drum Sampler".to_string()),
        }
    }

    /// Change the settings of Track `track`'s Keys: `settings` is the flat
    /// form their table declares, and anything missing or out of range takes
    /// its default. Notes sounding carry on as they were struck. Ignored
    /// unless the Track plays the Keys.
    pub fn set_track_keys(&mut self, track: usize, settings: &[f32]) {
        self.set_track_keys_settings(track, crate::instrument::KeysSettings::from_flat(settings));
    }

    /// Track `track`'s Keys settings in their flat form, or none unless it plays the Keys.
    pub fn track_keys(&self, track: usize) -> Vec<f32> {
        self.tracks
            .get(track)
            .and_then(|track| track.keys_settings())
            .map(|settings| settings.to_flat())
            .unwrap_or_default()
    }

    /// Give Track `track`'s Keys a WAV file to play across the keyboard,
    /// from its root note, when their source is the sample. Answers what is
    /// wrong, or `None` when it was loaded.
    pub fn load_track_keys_sample(&mut self, track: usize, wav: &[u8]) -> Option<String> {
        let sample = match crate::instrument::decode(wav) {
            Ok(sample) => sample,
            Err(error) => return Some(error.message().to_string()),
        };
        match self.keys(track) {
            Some(keys) => {
                keys.set_sample(Some(Arc::new(sample)));
                None
            }
            None => Some("That Track isn't playing the Keys".to_string()),
        }
    }

    /// Take the sample off Track `track`'s Keys: the sample source is silent until another comes.
    pub fn clear_track_keys_sample(&mut self, track: usize) {
        if let Some(keys) = self.keys(track) {
            keys.set_sample(None);
        }
    }

    /// Take the musician's own WAV off a pad, so that it plays the bundled
    /// kit's own sample again — or nothing, on a pad past the kit's end.
    /// The engine has no other way back to the kit's sound.
    pub fn clear_track_pad_sample(&mut self, track: usize, pad: usize) {
        let sample = crate::instrument::kit_sample(pad).map(Arc::new);
        if let Some(drums) = self.drums(track) {
            drums.set_sample(pad, sample);
        }
    }

    /// Make Track `track` an Audio Track, which plays its Audio Clips and
    /// no Instrument, or an Instrument Track again. Ignored for a Track that
    /// doesn't exist.
    pub fn set_track_audio(&mut self, track: usize, audio: bool) {
        if let Some(track) = self.tracks.get_mut(track) {
            track.set_audio(audio);
        }
    }

    /// Turn Input Monitoring on or off for Track `track`: while on, an Audio
    /// Track plays the live input `set_track_input` hands it, with its
    /// Clips, through its Insert Chain, fader, Sends and meter. Ignored for a
    /// Track that doesn't exist; an Instrument Track never plays its input.
    pub fn set_track_monitoring(&mut self, track: usize, on: bool) {
        if let Some(track) = self.tracks.get_mut(track) {
            track.set_monitoring(on);
        }
    }

    /// Hand Track `track` its live input for the next `render`: the host's
    /// audio input, block by block, lined up with the output. Played once,
    /// from the block's first frame; a block it is short of, or isn't handed,
    /// is silent there. Heard only while the Track is monitoring. Refused
    /// during an offline render, which never has live input in it, and for a
    /// Track that doesn't exist. Allocates nothing for up to the frames
    /// `prepare` sized for.
    pub fn set_track_input(&mut self, track: usize, left: &[f32], right: &[f32]) {
        if self.offline.is_some() {
            return;
        }
        if let Some(track) = self.tracks.get_mut(track) {
            track.set_input(left, right);
        }
    }

    /// Decode a WAV, FLAC or MP3 file's bytes, converting them to the
    /// engine's sample rate, for Audio Clips to play as file number `file`.
    /// Answers with what is wrong with the file, or nothing if it loaded.
    pub fn load_audio_file(&mut self, file: u32, bytes: &[u8]) -> Option<String> {
        match AudioFile::decode(bytes, self.sample_rate) {
            Ok(decoded) => {
                self.audio_files.insert(file, Arc::new(decoded));
                None
            }
            Err(error) => Some(error.message().to_string()),
        }
    }

    /// Forget file number `file`. Clips already playing it keep their copy
    /// until their Track's Clips are next replaced.
    pub fn unload_audio_file(&mut self, file: u32) {
        self.audio_files.remove(&file);
    }

    /// Replace the Audio Clips Track `track` plays. `clips` is flat: start
    /// tick, length in seconds, file number and the seconds into the file
    /// where the Clip starts, for each Clip. A Clip whose file isn't loaded
    /// is left out. Ignored for a Track that doesn't exist.
    pub fn set_track_audio_clips(&mut self, track: usize, clips: &[f64]) {
        let files = &self.audio_files;
        let clips = PreparedAudioClips::new(self.sample_rate, clips, |file| {
            files.get(&file).cloned().map(PreparedAudioFile)
        });
        self.swap_track_audio_clips(track, clips);
    }

    /// Give every Track the load-test pattern and play it from the top, or
    /// take the pattern away and stop. Looping it is the host's choice.
    pub fn set_pattern_playing(&mut self, playing: bool) {
        self.pattern_loaded = playing;
        for (index, track) in self.tracks.iter_mut().enumerate() {
            let notes = if playing {
                NoteList::load_test_pattern(index)
            } else {
                NoteList::default()
            };
            track.set_notes(notes, 0);
        }
        if playing {
            self.seek(0.0);
            self.play();
        } else {
            self.stop();
        }
    }

    /// Start playing from the current position.
    pub fn play(&mut self) {
        if self.transport.is_playing() {
            return;
        }
        let from = self.transport.position().ceil() as u64;
        self.rewind_to(from);
        self.transport.play();
    }

    /// Stop playing, keeping the position. Sounding notes are released.
    pub fn stop(&mut self) {
        self.transport.stop();
        self.tracks.iter_mut().for_each(|t| t.silence());
        self.metronome.silence();
    }

    /// Move the playback position to `tick`, playing or not.
    pub fn seek(&mut self, tick: f64) {
        let tick = tick.max(0.0) as u64;
        self.transport.seek(tick);
        self.rewind_to(tick);
    }

    pub fn is_playing(&self) -> bool {
        self.transport.is_playing()
    }

    /// Where playback is, in ticks (960 to a quarter note).
    pub fn position(&self) -> f64 {
        self.transport.position()
    }

    /// The song's starting tempo, in quarter notes per minute, 20 to 999.
    /// Playback stays in time: the position doesn't jump, only the speed from
    /// here on changes.
    pub fn set_tempo(&mut self, bpm: f64) {
        if bpm.is_finite() {
            self.transport.set_tempo(bpm);
        }
    }

    /// The tempo where playback is.
    pub fn tempo(&self) -> f64 {
        self.transport.tempo()
    }

    /// The song's starting time signature: `beats_per_bar` 1 to 32,
    /// `beat_unit` 1, 2, 4, 8, 16 or 32. Anything else is ignored.
    pub fn set_time_signature(&mut self, beats_per_bar: u32, beat_unit: u32) {
        let signature = TimeSignature {
            beats_per_bar,
            beat_unit,
        };
        if signature.is_valid() {
            self.transport.set_time_signature(signature);
        }
    }

    /// Replace the song's Tempo Changes. `changes` is flat: tick, tempo,
    /// beats per bar and beat unit for each, the tempo and time signature
    /// in force from that tick on. Playback stays on the tick it is at.
    pub fn set_tempo_changes(&mut self, changes: &[f64]) {
        self.swap_tempo_changes(PreparedTempoChanges::new(changes));
    }

    /// Loop from `start` to `end` ticks while `enabled`.
    pub fn set_loop(&mut self, start: f64, end: f64, enabled: bool) {
        let region = LoopRegion {
            start: start.max(0.0) as u64,
            end: end.max(0.0) as u64,
        };
        self.transport.set_loop(enabled.then_some(region));
    }

    /// Stop at `end` ticks and go back to `start`, when the loop is off: the
    /// song's end, or the stretch the musician chose to play. An `end` at or
    /// before `start` plays on for ever.
    pub fn set_play_range(&mut self, start: f64, end: f64) {
        let region = LoopRegion {
            start: start.max(0.0) as u64,
            end: end.max(0.0) as u64,
        };
        self.play_range = (region.end > region.start).then_some(region);
    }

    /// The play range to stop at: only when the loop is off, and never in an
    /// offline render.
    fn stop_at(&self) -> Option<LoopRegion> {
        if self.transport.loop_region().is_some() || self.offline.is_some() {
            return None;
        }
        self.play_range
    }

    /// Click on every beat while playing, higher on the first of each bar.
    pub fn set_metronome(&mut self, on: bool) {
        self.metronome_on = on;
        if !on {
            self.metronome.silence();
        }
    }

    /// In latency-test mode a live note-on plays the transient instead of the
    /// Synth.
    pub fn set_latency_test(&mut self, on: bool) {
        self.latency_test = on;
    }

    /// Play live notes through Instrument Track `track`, through the engine's
    /// own live Synth with `None`, and through the live Synth as well when
    /// there is no such Track. Anything held is released first, so a key down
    /// across the change doesn't stick on the Track it leaves.
    pub fn set_live_track(&mut self, track: Option<usize>) {
        if track == self.live_track {
            return;
        }
        self.release_live_notes();
        self.live_track = track;
    }

    /// While on, every live note-on and note-off is logged with the tick the
    /// transport was at, for the host to drain and record.
    pub fn set_recording(&mut self, on: bool) {
        self.recorded.set_on(on);
    }

    pub fn is_recording(&self) -> bool {
        self.recorded.is_on()
    }

    /// Live notes there was no room to log, since the engine started.
    pub fn dropped_notes(&self) -> u32 {
        self.recorded.dropped()
    }

    /// Drain the recording log for a JS host: flat tick, pitch, velocity and
    /// 1 for a note-on or 0 for a note-off, for each note. A native host uses
    /// `recorded_notes` instead, which allocates nothing.
    pub fn take_recorded_notes(&mut self) -> Vec<f64> {
        self.recorded.take_flat()
    }

    /// A key pressed on the live keyboard. `velocity` is 0..=1.
    pub fn note_on(&mut self, note: u8, velocity: f32) {
        self.log_note(note, velocity, true);
        if self.latency_test {
            self.click_position = Some(0);
            return;
        }
        self.hold(note, true);
        self.live_target().note_on(note, velocity);
    }

    pub fn note_off(&mut self, note: u8) {
        self.log_note(note, 0.0, false);
        self.hold(note, false);
        self.live_target().note_off(note);
    }

    /// Voices sounding across every Track, the live one included.
    pub fn active_voices(&self) -> usize {
        self.live.active_voices() + self.tracks.iter().map(|t| t.active_voices()).sum::<usize>()
    }

    /// Render the next block of `frames` into the output buffers.
    pub fn render(&mut self, frames: usize) {
        if self.left.len() < frames {
            self.left.resize(frames, 0.0);
            self.right.resize(frames, 0.0);
        }
        if self.master_gain.len() < frames {
            self.master_gain.resize(frames, 1.0);
            self.ticks.resize(frames, 0.0);
            self.post_left.resize(frames, 0.0);
            self.post_right.resize(frames, 0.0);
        }
        self.left[..frames].fill(0.0);
        self.right[..frames].fill(0.0);
        for bus in &mut self.buses {
            bus.clear(frames);
        }
        self.fall_meters(frames);
        self.update_audible();

        // The Buses and the Master take the block a segment at a time, as the
        // Tracks do, so a synced Delay on them retimes on the very frame of a
        // Tempo Change and their Automation has no breakpoint inside what
        // they process, however the block falls.
        let mut cursor = 0;
        loop {
            let remaining = frames - cursor;
            let due = self
                .transport
                .is_playing()
                .then(|| self.next_event())
                .flatten()
                .map(|tick| {
                    let offset = self
                        .transport
                        .frame_of(tick)
                        .saturating_sub(self.transport.now());
                    (tick, offset as usize)
                })
                .filter(|&(_, offset)| offset < remaining);

            let until = due.map_or(remaining, |(_, offset)| offset);
            let tempo = self.transport.tempo();
            self.render_segment(cursor, cursor + until);
            self.mix_down(cursor, cursor + until, tempo);
            self.transport.advance(until as u64);
            cursor += until;

            match due {
                Some((tick, _)) => self.play_events_at(tick),
                None => break,
            }
        }
        for ((l, r), &gain) in self.left[..frames]
            .iter_mut()
            .zip(self.right[..frames].iter_mut())
            .zip(&self.master_gain[..frames])
        {
            *l *= gain;
            *r *= gain;
        }
        self.render_transient(frames);
        // Live input is for one block only.
        for track in &mut self.tracks {
            track.clear_input();
        }

        let mut meter = self.master_meter;
        for sample in self.left[..frames]
            .iter_mut()
            .chain(self.right[..frames].iter_mut())
        {
            *sample = sample.clamp(-1.0, 1.0);
            meter = meter.max(sample.abs());
        }
        self.master_meter = meter;
        self.render_dj(frames);
    }

    /// Put a file on a Deck of the DJ Mixer from its samples, already at the
    /// engine's rate and analysed (`dj_prepare`), so the audio thread only
    /// copies them.
    pub fn dj_load_samples(
        &mut self,
        deck: usize,
        left: Vec<f32>,
        right: Vec<f32>,
        bpm: f64,
        first_beat: f64,
    ) {
        let frames = left.len().min(right.len());
        let (mut left, mut right) = (left, right);
        left.truncate(frames);
        right.truncate(frames);
        let file = PreparedAudioFile::from_file(AudioFile::from_samples(left, right));
        let track = DjTrack {
            file,
            bpm,
            first_beat,
        };
        self.swap_dj_track(deck, Some(track));
    }

    /// Take the file off a Deck.
    pub fn dj_unload(&mut self, deck: usize) {
        self.swap_dj_track(deck, None);
    }

    /// Set the DJ Mixer's control `name` of a `kind` ("deck", "channel" or
    /// "mixer"), numbered by `index`, to `value`. Answers whether there is
    /// such a control.
    pub fn dj_set(&mut self, kind: &str, index: usize, name: &str, value: f64) -> bool {
        let Some(control) = DjControl::parse(kind, index, name) else {
            return false;
        };
        self.dj_apply(control, value);
        true
    }

    /// Where everything on the Mixer page is, as `app/src/dj/dj-report.ts`
    /// reads it.
    pub fn dj_report(&self) -> Vec<f64> {
        let mut out = vec![0.0; DJ_REPORT_LEN];
        self.dj_report_into(&mut out);
        out
    }

    /// Where the last block's headphone cue starts in the engine's memory,
    /// left side; null before the DJ Mixer is used.
    pub fn dj_headphone_left_ptr(&self) -> *const f32 {
        self.dj_headphones()
            .map_or(std::ptr::null(), |(left, _)| left.as_ptr())
    }

    pub fn dj_headphone_right_ptr(&self) -> *const f32 {
        self.dj_headphones()
            .map_or(std::ptr::null(), |(_, right)| right.as_ptr())
    }

    /// The DJ mix recorded since the last call, interleaved stereo.
    pub fn dj_take_recording(&mut self) -> Vec<f32> {
        match &mut self.dj {
            Some(dj) => {
                let taken = dj.recorded().to_vec();
                dj.clear_recorded();
                taken
            }
            None => Vec::new(),
        }
    }

    /// Render from `start` to `end` ticks without an audio device, as fast as
    /// the machine allows, ignoring the loop. Returns interleaved stereo.
    ///
    /// This uses the engine's own Tracks and transport, so a host that is
    /// also playing live gives offline work its own Engine.
    pub fn render_range(&mut self, start: f64, end: f64) -> Vec<f32> {
        let total = self.start_render(start, end, 0.0);
        let mut out = Vec::with_capacity(total * 2);
        loop {
            let block = self.render_next(OFFLINE_BLOCK);
            if block.is_empty() {
                return out;
            }
            out.extend(block);
        }
    }

    /// Where the last block's left channel starts in the engine's memory.
    pub fn left_ptr(&self) -> *const f32 {
        self.left.as_ptr()
    }

    /// Where the last block's right channel starts in the engine's memory.
    pub fn right_ptr(&self) -> *const f32 {
        self.right.as_ptr()
    }
}

/// A channel's Sends, built off the audio thread, ready for
/// `Engine::swap_sends`.
pub struct PreparedSends {
    channel: i32,
    sends: Vec<BusSend>,
}

impl PreparedSends {
    /// Sends for `channel` (as `Engine::set_sends` numbers it) from the same
    /// flat list. None if the list is malformed.
    pub fn new(channel: i32, flat: &[f64]) -> Option<Self> {
        BusSend::from_flat(flat).map(|sends| Self { channel, sends })
    }
}

/// A Bus built off the audio thread, ready for `Engine::add_bus`.
pub struct PreparedBus(Box<Bus>);

impl PreparedBus {
    /// A Bus at unity feeding the Master, with its buffers sized for blocks
    /// of up to `max_frames`.
    pub fn new(max_frames: usize) -> Self {
        let mut bus = Box::new(Bus::new());
        bus.prepare(max_frames);
        Self(bus)
    }
}

/// An Effect built off the audio thread, ready for
/// `Engine::insert_prepared_effect`.
pub struct PreparedEffect(Box<Effect>);

impl PreparedEffect {
    /// An Effect of `kind` with its default settings.
    pub fn new(kind: EffectKind, sample_rate: f32) -> Self {
        Self(Box::new(Effect::new(kind, sample_rate)))
    }

    /// The Effect the UI names (one of `EffectKind`'s names, such as "eq"),
    /// or `None` for a name there is no Effect for.
    pub fn named(kind: &str, sample_rate: f32) -> Option<Self> {
        EffectKind::named(kind).map(|kind| Self::new(kind, sample_rate))
    }

    /// A Plugin Effect: `instance` is what the host's Plugin runtime made
    /// of the Plugin `manifest` describes, and starts at its defaults.
    pub fn plugin(manifest: Arc<PluginManifest>, instance: Box<dyn PluginInstance>) -> Self {
        Self(Box::new(Effect::plugin(HostedPlugin::new(
            manifest, instance,
        ))))
    }

    /// A Plugin Effect restored from its own state, a **VST3 Plugin**'s:
    /// its settings start at `values`, which it already has.
    pub fn restored_plugin(
        manifest: Arc<PluginManifest>,
        instance: Box<dyn PluginInstance>,
        values: &[f32],
    ) -> Self {
        Self(Box::new(Effect::plugin(HostedPlugin::with_values(
            manifest, instance, values,
        ))))
    }

    /// The slot of the Plugin `id`, which this host doesn't have: it passes
    /// audio through, so the chain's other Effects keep their places.
    pub fn missing_plugin(id: &str) -> Self {
        Self(Box::new(Effect::missing_plugin(id)))
    }
}

/// A Track built off the audio thread, ready for `Engine::add_track`.
pub struct PreparedTrack(Box<Track>);

impl PreparedTrack {
    /// A Track that renders blocks of up to `max_frames` without
    /// allocating, playing `notes` from the top.
    pub fn new(sample_rate: f32, max_frames: usize, notes: NoteList) -> Self {
        let mut track = Track::new(sample_rate);
        track.prepare(max_frames);
        track.set_notes(notes, 0);
        Self(Box::new(track))
    }
}

/// An Instrument built off the audio thread, ready for
/// `Engine::swap_track_instrument`.
pub struct PreparedInstrument(Instrument);

impl PreparedInstrument {
    /// The Instrument the UI names ("synth" or "drumSampler"), with the
    /// bundled kit already decoded where that is the Drum Sampler, on `pads`
    /// pads (8 to 16, PRD #10) or the kit's own size where the host doesn't
    /// say.
    pub fn named(kind: &str, sample_rate: f32, pads: Option<usize>) -> Option<Self> {
        let pads = pads.unwrap_or(DEFAULT_PADS).clamp(1, MAX_PADS);
        Instrument::named(kind, sample_rate, pads).map(Self)
    }

    /// An Instrument Plugin: `instance` is what the host's Plugin runtime
    /// made of the Plugin `manifest` describes, and starts at its defaults.
    pub fn plugin(manifest: Arc<PluginManifest>, instance: Box<dyn PluginInstance>) -> Self {
        Self(Instrument::Plugin(PluginInstrument::new(
            HostedPlugin::new(manifest, instance),
        )))
    }

    /// An Instrument Plugin restored from its own state, a **VST3
    /// Plugin**'s: its settings start at `values`, which it already has.
    pub fn restored_plugin(
        manifest: Arc<PluginManifest>,
        instance: Box<dyn PluginInstance>,
        values: &[f32],
    ) -> Self {
        Self(Instrument::Plugin(PluginInstrument::new(
            HostedPlugin::with_values(manifest, instance, values),
        )))
    }

    /// The place of the Instrument Plugin `id`, which this host doesn't
    /// have: it is silent.
    pub fn missing(id: &str) -> Self {
        Self(Instrument::Missing(id.to_string()))
    }
}

/// A WAV decoded off the audio thread, ready for `Engine::swap_pad_sample`.
pub struct PreparedSample(Arc<Sample>);

impl PreparedSample {
    /// Decode the bytes of a WAV file, or say what is wrong with it.
    pub fn decode(wav: &[u8]) -> Result<Self, WavError> {
        crate::instrument::decode(wav).map(|sample| Self(Arc::new(sample)))
    }

    /// The bundled kit's own sample for pad `pad`, decoded here rather than
    /// on the audio thread, or `None` for a pad the kit doesn't reach: what
    /// a native host puts back when the musician's own sample comes off.
    pub fn kit(pad: usize) -> Option<Self> {
        crate::instrument::kit_sample(pad).map(|sample| Self(Arc::new(sample)))
    }
}

/// An audio file decoded, and converted to the engine's rate, off the audio
/// thread. Cheap to clone: every Clip playing it shares the one copy.
#[derive(Clone, Debug)]
pub struct PreparedAudioFile(Arc<AudioFile>);

impl PreparedAudioFile {
    /// Decode a WAV, FLAC or MP3 file's bytes for an engine running at
    /// `sample_rate`, or say what is wrong with it.
    pub fn decode(bytes: &[u8], sample_rate: f32) -> Result<Self, AudioFileError> {
        AudioFile::decode(bytes, sample_rate).map(|file| Self(Arc::new(file)))
    }

    /// A file already decoded and at the engine's rate.
    pub(crate) fn from_file(file: AudioFile) -> Self {
        Self(Arc::new(file))
    }

    /// The left side, at the engine's rate; a mono file has it on both.
    pub fn left(&self) -> &[f32] {
        self.0.left()
    }

    pub fn right(&self) -> &[f32] {
        self.0.right()
    }

    /// The decoded file, at the engine's rate.
    pub(crate) fn file(&self) -> &AudioFile {
        &self.0
    }
}

/// An Audio Track's Clips built off the audio thread, ready for
/// `Engine::swap_track_audio_clips`.
#[derive(Debug, Default)]
pub struct PreparedAudioClips(AudioClips);

impl PreparedAudioClips {
    /// `clips` is flat, as `Engine::set_track_audio_clips` takes it; `files`
    /// finds each Clip's file by its number. A Clip whose file isn't found,
    /// or whose numbers make no sense, is left out.
    pub fn new(
        sample_rate: f32,
        clips: &[f64],
        files: impl Fn(u32) -> Option<PreparedAudioFile>,
    ) -> Self {
        let clips = clips
            .as_chunks::<4>()
            .0
            .iter()
            .filter(|clip| clip.iter().all(|n| n.is_finite() && *n >= 0.0))
            .filter_map(|&[start, seconds, file, offset]| {
                let PreparedAudioFile(file) = files(file as u32)?;
                let offset = (offset * f64::from(sample_rate)).round() as usize;
                Some(AudioClip::new(start as u64, seconds, file, offset))
            })
            .collect();
        Self(AudioClips::new(clips))
    }
}

/// Tempo Changes built off the audio thread, ready for
/// `Engine::swap_tempo_changes`.
#[derive(Debug, Default)]
pub struct PreparedTempoChanges(TempoChanges);

impl PreparedTempoChanges {
    /// `changes` is flat, as `Engine::set_tempo_changes` takes it.
    pub fn new(changes: &[f64]) -> Self {
        Self(TempoChanges::from_flat(changes))
    }
}

/// A setting's Automation, built off the audio thread for
/// `Engine::swap_automation`.
#[derive(Debug)]
pub struct PreparedAutomation {
    setting: Automatable,
    automation: Automation,
}

impl PreparedAutomation {
    /// `points` is flat, as `Engine::set_automation` takes it; none for a
    /// setting that can't be automated.
    pub fn new(setting: &str, points: &[f64]) -> Option<Self> {
        let setting = Automatable::named(setting)?;
        Some(Self {
            setting,
            automation: Automation::from_flat(points, setting),
        })
    }
}

/// Realtime-safe control, for a native host running `render` on an audio
/// thread. Whatever allocates (a Track, a list of notes) is built beforehand
/// on another thread and handed in; whatever it replaces is handed back, to be
/// dropped there. None of these allocate, lock or free memory.
impl Engine {
    /// Size every buffer for blocks of up to `max_frames`, and make room for
    /// `MAX_TRACKS`, so that nothing after this allocates. Call it before
    /// the audio thread takes the Engine; afterwards, render at most
    /// `max_frames` at a time.
    /// Give the Engine a DJ Mixer built off the audio thread, if it has
    /// none; the one handed back, if any, is to be dropped there.
    pub fn install_dj(&mut self, dj: Box<DjMixer>) -> Option<Box<DjMixer>> {
        if self.dj.is_some() {
            return Some(dj);
        }
        self.dj = Some(dj);
        None
    }

    pub fn has_dj(&self) -> bool {
        self.dj.is_some()
    }

    /// Put a prepared file on a Deck, or take it off with None, handing
    /// back the one it replaces. Without a DJ Mixer the file comes back.
    pub fn swap_dj_track(&mut self, deck: usize, track: Option<DjTrack>) -> Option<DjTrack> {
        match &mut self.dj {
            Some(dj) => dj.load(deck, track),
            None if cfg!(target_arch = "wasm32") || track.is_none() => {
                // The worklet builds its mixer on first use.
                track.as_ref()?;
                let mut dj = Box::new(DjMixer::new(self.sample_rate));
                let back = dj.load(deck, track);
                self.dj = Some(dj);
                back
            }
            None => track,
        }
    }

    /// Set a DJ Mixer control. Allocates nothing on a native host, which
    /// installs the mixer first; the browser builds it on first use.
    pub fn dj_apply(&mut self, control: DjControl, value: f64) {
        if self.dj.is_none() {
            if !cfg!(target_arch = "wasm32") {
                return;
            }
            self.dj = Some(Box::new(DjMixer::new(self.sample_rate)));
        }
        if let Some(dj) = &mut self.dj {
            dj.apply(control, value);
        }
    }

    /// `dj_report` into `out`, which holds at least `DJ_REPORT_LEN`: all
    /// zeros before the mixer is first used.
    pub fn dj_report_into(&self, out: &mut [f64]) {
        match &self.dj {
            Some(dj) => dj.report(out),
            None => out.iter_mut().for_each(|value| *value = 0.0),
        }
    }

    /// The DJ mix recorded since the last `dj_clear_recorded`, interleaved.
    pub fn dj_recorded(&self) -> &[f32] {
        self.dj.as_ref().map_or(&[], |dj| dj.recorded())
    }

    pub fn dj_clear_recorded(&mut self) {
        if let Some(dj) = &mut self.dj {
            dj.clear_recorded();
        }
    }

    /// The last block's headphone mix, or None before the mixer is used.
    pub fn dj_headphones(&self) -> Option<(&[f32], &[f32])> {
        self.dj.as_ref().map(|dj| dj.headphones())
    }

    /// Add the DJ Mixer's next block to the output, after the song's Master
    /// has been metered.
    fn render_dj(&mut self, frames: usize) {
        let Some(dj) = &mut self.dj else {
            return;
        };
        dj.render(frames);
        let (left, right) = dj.output();
        for (out, s) in self.left[..frames].iter_mut().zip(&left[..frames]) {
            *out = (*out + s).clamp(-1.0, 1.0);
        }
        for (out, s) in self.right[..frames].iter_mut().zip(&right[..frames]) {
            *out = (*out + s).clamp(-1.0, 1.0);
        }
    }

    pub fn prepare(&mut self, max_frames: usize) {
        self.tracks.reserve_exact(MAX_TRACKS - self.tracks.len());
        self.buses.reserve_exact(MAX_BUSES - self.buses.len());
        self.bus_order
            .reserve_exact(MAX_BUSES - self.bus_order.len());
        if self.left.len() < max_frames {
            self.left.resize(max_frames, 0.0);
            self.right.resize(max_frames, 0.0);
        }
        if self.master_gain.len() < max_frames {
            self.master_gain.resize(max_frames, 1.0);
            self.ticks.resize(max_frames, 0.0);
            self.post_left.resize(max_frames, 0.0);
            self.post_right.resize(max_frames, 0.0);
        }
        if let Some(dj) = &mut self.dj {
            dj.prepare(max_frames);
        }
        self.live.prepare(max_frames);
        self.master_chain.prepare(max_frames);
        for track in &mut self.tracks {
            track.prepare(max_frames);
        }
        for bus in &mut self.buses {
            bus.prepare(max_frames);
        }
    }

    /// Replace the notes Track `track` plays, handing back the old ones, or
    /// `notes` itself if there is no such Track.
    pub fn set_track_note_list(&mut self, track: usize, notes: NoteList) -> NoteList {
        let from = self.scan_from;
        match self.tracks.get_mut(track) {
            Some(track) => track.set_notes(notes, from),
            None => notes,
        }
    }

    /// Change a Track's Synth settings, with the settings already parsed:
    /// what the desktop host's audio thread calls, since nothing here
    /// allocates. `track` below zero is the live Track.
    pub fn set_track_synth_settings(&mut self, track: i32, settings: SynthSettings) {
        if let Some(track) = self.synth_track_mut(track) {
            track.set_synth_settings(settings);
        }
    }

    /// Add a Track after the last. Handed back if there is no room left: at
    /// `MAX_TRACKS`, or past what `prepare` reserved.
    pub fn add_track(&mut self, track: PreparedTrack) -> Result<(), PreparedTrack> {
        if self.tracks.len() >= self.tracks.capacity().min(MAX_TRACKS) {
            return Err(track);
        }
        let PreparedTrack(mut track) = track;
        track.rewind(self.scan_from, &self.transport);
        self.tracks.push(track);
        Ok(())
    }

    /// Put an Effect built elsewhere into an Insert Chain at `index`, or at
    /// the end when `index` is past it: what a native host's audio thread
    /// calls, since nothing here allocates. Handed back if there is no such
    /// chain or it is full.
    pub fn insert_prepared_effect(
        &mut self,
        chain: i32,
        index: usize,
        effect: PreparedEffect,
    ) -> Result<(), PreparedEffect> {
        match self.chain_mut(chain) {
            Some(chain) => chain.insert(index, effect.0).map_err(PreparedEffect),
            None => Err(effect),
        }
    }

    /// Take the Effect at `index` out of an Insert Chain, to be dropped off
    /// the audio thread.
    pub fn take_effect(&mut self, chain: i32, index: usize) -> Option<PreparedEffect> {
        self.chain_mut(chain)?.remove(index).map(PreparedEffect)
    }

    /// Give Track `track` Audio Clips built elsewhere, handing back the ones
    /// they replace — or `clips` themselves if there is no such Track. A
    /// Clip under the playhead joins in where it has got to.
    pub fn swap_track_audio_clips(
        &mut self,
        track: usize,
        clips: PreparedAudioClips,
    ) -> PreparedAudioClips {
        let PreparedAudioClips(clips) = clips;
        let playing = self.transport.is_playing().then(|| {
            let position = self.transport.position();
            // Nothing was due between `scan_from` and the playhead, or it
            // would have played: a Clip that started there is under it.
            let from = self.scan_from.max(position.ceil() as u64);
            (from, &self.transport)
        });
        match self.tracks.get_mut(track) {
            Some(track) => PreparedAudioClips(track.set_clips(clips, playing)),
            None => PreparedAudioClips(clips),
        }
    }

    /// Replace the song's Tempo Changes with ones built elsewhere, handing
    /// back the old ones to be dropped off the audio thread.
    pub fn swap_tempo_changes(&mut self, changes: PreparedTempoChanges) -> PreparedTempoChanges {
        PreparedTempoChanges(self.transport.swap_tempo_changes(changes.0))
    }

    /// Give a Track, Bus or the Master (`target` is numbered as an Insert
    /// Chain is: see `insert_effect`) Automation built elsewhere, handing
    /// back what it replaces, or `automation` itself when there is no such
    /// channel or setting. The Master has only its volume and its Effects'
    /// settings to automate, and a Bus has no Instrument. Allocates nothing.
    pub fn swap_automation(
        &mut self,
        target: i32,
        automation: PreparedAutomation,
    ) -> PreparedAutomation {
        let PreparedAutomation {
            setting,
            automation,
        } = automation;
        let old = match (ChainOwner::of(target), setting) {
            (ChainOwner::Track(track), _) => match self.tracks.get_mut(track) {
                Some(track) => track.set_automation(setting, automation),
                None => automation,
            },
            (ChainOwner::Bus(_), Automatable::Instrument(_)) => automation,
            (ChainOwner::Bus(bus), _) => match self.buses.get_mut(bus) {
                Some(bus) => bus.set_automation(setting, automation),
                None => automation,
            },
            (ChainOwner::Master, Automatable::Volume) => {
                std::mem::replace(&mut self.master_automation, automation)
            }
            (ChainOwner::Master, Automatable::Effect { index, param }) => {
                match self.master_chain.effect_mut(index) {
                    Some(effect) => effect.set_automation(param.as_str(), automation),
                    None => automation,
                }
            }
            (ChainOwner::Master, _) => automation,
        };
        PreparedAutomation {
            setting,
            automation: old,
        }
    }

    /// Give a channel Sends built elsewhere. Hands back the Sends it
    /// replaced, or, refused, the ones it was given: the channel or a Bus
    /// doesn't exist, or they would make a loop. Either way, drop what comes
    /// back off the audio thread. Allocates nothing.
    pub fn swap_sends(&mut self, sends: PreparedSends) -> Result<PreparedSends, PreparedSends> {
        let PreparedSends { channel, sends } = sends;
        let count = self.buses.len();
        if sends.iter().any(|send| send.bus >= count) {
            return Err(PreparedSends { channel, sends });
        }
        let result = match ChainOwner::of(channel) {
            ChainOwner::Track(track) => match self.tracks.get_mut(track) {
                Some(track) => Ok(track.swap_sends(sends)),
                None => Err(sends),
            },
            ChainOwner::Bus(bus) if bus < count => {
                let old = self.buses[bus].swap_sends(sends);
                if self.route() {
                    Ok(old)
                } else {
                    let refused = self.buses[bus].swap_sends(old);
                    self.route();
                    Err(refused)
                }
            }
            _ => Err(sends),
        };
        result
            .map(|sends| PreparedSends { channel, sends })
            .map_err(|sends| PreparedSends { channel, sends })
    }

    /// Take the last Track away, to be dropped off the audio thread.
    pub fn remove_track(&mut self) -> Option<PreparedTrack> {
        self.tracks.pop().map(PreparedTrack)
    }

    /// Add a Bus after the last, feeding the Master. Handed back if there is
    /// no room left: at `MAX_BUSES`, or past what `prepare` reserved.
    pub fn add_bus(&mut self, bus: PreparedBus) -> Result<(), PreparedBus> {
        if self.buses.len() >= self.buses.capacity().min(MAX_BUSES) {
            return Err(bus);
        }
        self.buses.push(bus.0);
        self.route();
        Ok(())
    }

    /// Take the last Bus away, to be dropped off the audio thread. Whatever
    /// fed it feeds the Master instead.
    pub fn remove_bus(&mut self) -> Option<PreparedBus> {
        let bus = self.buses.pop()?;
        let gone = Output::Bus(self.buses.len());
        let gone_bus = self.buses.len();
        for track in &mut self.tracks {
            if track.output() == gone {
                track.set_output(Output::Master);
            }
            track.sends_mut().retain(|send| send.bus != gone_bus);
        }
        for other in &mut self.buses {
            if other.output() == gone {
                other.set_output(Output::Master);
            }
            other.sends_mut().retain(|send| send.bus != gone_bus);
        }
        self.route();
        Some(PreparedBus(bus))
    }

    /// The live notes logged since the last `clear_recorded_notes`. A native
    /// host copies them out after each callback and clears the log; both
    /// allocate nothing.
    pub fn recorded_notes(&self) -> &[RecordedNote] {
        self.recorded.notes()
    }

    pub fn clear_recorded_notes(&mut self) {
        self.recorded.clear();
    }

    /// Give Track `track` an Instrument built elsewhere, handing back the one
    /// it replaces — or `instrument` itself if there is no such Track.
    pub fn swap_track_instrument(
        &mut self,
        track: usize,
        instrument: PreparedInstrument,
    ) -> PreparedInstrument {
        let PreparedInstrument(instrument) = instrument;
        match self.tracks.get_mut(track) {
            Some(track) => PreparedInstrument(track.set_instrument(instrument)),
            None => PreparedInstrument(instrument),
        }
    }

    /// Put a sample decoded elsewhere on a pad, handing back the one it
    /// replaces, if any, to be dropped off the audio thread.
    pub fn swap_pad_sample(
        &mut self,
        track: usize,
        pad: usize,
        sample: PreparedSample,
    ) -> Option<PreparedSample> {
        let PreparedSample(sample) = sample;
        match self.drums(track) {
            Some(drums) => drums.set_sample(pad, Some(sample)).map(PreparedSample),
            None => Some(PreparedSample(sample)),
        }
    }

    /// Change Track `track`'s Keys settings, already parsed: what a native
    /// host's audio thread calls, since nothing here allocates.
    pub fn set_track_keys_settings(
        &mut self,
        track: usize,
        settings: crate::instrument::KeysSettings,
    ) {
        if let Some(track) = self.tracks.get_mut(track) {
            track.set_keys_settings(settings);
        }
    }

    /// Give Track `track`'s Keys a sample decoded elsewhere, or none,
    /// handing back the one it replaces to be dropped off the audio thread.
    pub fn swap_keys_sample(
        &mut self,
        track: usize,
        sample: Option<PreparedSample>,
    ) -> Option<PreparedSample> {
        let sample = sample.map(|PreparedSample(sample)| sample);
        match self.keys(track) {
            Some(keys) => keys.set_sample(sample).map(PreparedSample),
            None => sample.map(PreparedSample),
        }
    }

    /// Leave a pad with no sample at all, handing back the one it had to be
    /// dropped off the audio thread. A host puts the kit's own sample back
    /// with `swap_pad_sample` where the kit has one; this is for the pads
    /// past its end.
    pub fn take_pad_sample(&mut self, track: usize, pad: usize) -> Option<PreparedSample> {
        self.drums(track)?.set_sample(pad, None).map(PreparedSample)
    }
}

impl Engine {
    /// Where live notes play: the chosen Track, or the engine's own.
    fn live_target(&mut self) -> &mut Track {
        match self.live_track.filter(|&track| track < self.tracks.len()) {
            Some(track) => &mut self.tracks[track],
            None => &mut self.live,
        }
    }

    /// Log a live note at the transport's position, which is the start of the
    /// block it arrived in: a host applies its commands between renders.
    fn log_note(&mut self, pitch: u8, velocity: f32, on: bool) {
        self.recorded.push(RecordedNote {
            tick: self.transport.position(),
            pitch,
            velocity,
            on,
        });
    }

    fn hold(&mut self, pitch: u8, held: bool) {
        if let Some(pitch) = self.live_held.get_mut(usize::from(pitch)) {
            *pitch = held;
        }
    }

    /// End every live note being held, on whichever Track it is playing.
    fn release_live_notes(&mut self) {
        for pitch in 0..self.live_held.len() {
            if std::mem::replace(&mut self.live_held[pitch], false) {
                self.live_target().note_off(pitch as u8);
            }
        }
    }

    /// The Track a Synth command names: below zero is the live Track.
    fn synth_track(&self, track: i32) -> Option<&Track> {
        if track < 0 {
            Some(&self.live)
        } else {
            self.tracks.get(track as usize).map(Box::as_ref)
        }
    }

    fn synth_track_mut(&mut self, track: i32) -> Option<&mut Track> {
        if track < 0 {
            Some(&mut self.live)
        } else {
            self.tracks.get_mut(track as usize).map(Box::as_mut)
        }
    }

    /// Track `track`'s Drum Sampler, when that is its Instrument.
    /// The Insert Chain a chain command names: a Track's index, -1 for the
    /// Master's, or a Bus's `bus_chain`.
    fn chain(&self, chain: i32) -> Option<&InsertChain> {
        match ChainOwner::of(chain) {
            ChainOwner::Track(track) => self.tracks.get(track).map(|track| track.chain()),
            ChainOwner::Master => Some(&self.master_chain),
            ChainOwner::Bus(bus) => self.buses.get(bus).map(|bus| bus.chain()),
        }
    }

    fn chain_mut(&mut self, chain: i32) -> Option<&mut InsertChain> {
        match ChainOwner::of(chain) {
            ChainOwner::Track(track) => self.tracks.get_mut(track).map(|track| track.chain_mut()),
            ChainOwner::Master => Some(&mut self.master_chain),
            ChainOwner::Bus(bus) => self.buses.get_mut(bus).map(|bus| bus.chain_mut()),
        }
    }

    /// Work out each Bus's depth after its routing changed, and the order
    /// they are mixed in. A Bus's depth is one more than the deepest Bus it
    /// feeds, through its output or a Send, so each is mixed before all it
    /// feeds. Answers false if the routing loops: then no depth settles, and
    /// the caller undoes the change. Allocates nothing once `prepare` has
    /// reserved room.
    fn route(&mut self) -> bool {
        let count = self.buses.len();
        for bus in &mut self.buses {
            bus.set_depth(1);
        }
        // Without a loop, no way passes more than every Bus once, so the
        // depths settle within `count` passes; one more finds nothing to
        // change.
        let mut settled = false;
        for _ in 0..=count {
            let mut changed = false;
            for at in 0..count {
                let buses = &self.buses;
                let deepest = buses[at]
                    .feeds()
                    .filter(|&to| to < count)
                    .map(|to| buses[to].depth())
                    .max()
                    .unwrap_or(0);
                if deepest + 1 != buses[at].depth() {
                    self.buses[at].set_depth(deepest + 1);
                    changed = true;
                }
            }
            if !changed {
                settled = true;
                break;
            }
        }
        self.bus_order.clear();
        self.bus_order.extend(0..count);
        let buses = &self.buses;
        self.bus_order
            .sort_unstable_by_key(|&bus| std::cmp::Reverse(buses[bus].depth()));
        settled
    }

    /// Work out which Tracks and Buses are in the mix this block. With
    /// nothing soloed, that is everything not muted. With something soloed,
    /// it is what is soloed, every Bus it feeds on its way to the Master
    /// (through outputs and Sends), and whatever feeds a soloed Bus, as long
    /// as it isn't muted.
    fn update_audible(&mut self) {
        let soloing = self.tracks.iter().any(|track| track.mixer().solo)
            || self.buses.iter().any(|bus| bus.mixer().solo);
        if !soloing {
            for track in &mut self.tracks {
                track.set_audible(!track.mixer().mute);
            }
            for bus in &mut self.buses {
                bus.set_audible(!bus.mixer().mute);
            }
            return;
        }
        let count = self.buses.len();
        // Every Bus a soloed channel feeds, however indirectly: first what a
        // soloed Track feeds, then, in mixing order, each Bus before what it
        // feeds, onwards from every soloed or already reached Bus.
        let mut downstream = [false; MAX_BUSES];
        for track in &self.tracks {
            if track.mixer().solo {
                track
                    .feeds()
                    .filter(|&to| to < count)
                    .for_each(|to| downstream[to] = true);
            }
        }
        for &at in &self.bus_order {
            let bus = &self.buses[at];
            if bus.mixer().solo || downstream[at] {
                bus.feeds()
                    .filter(|&to| to < count)
                    .for_each(|to| downstream[to] = true);
            }
        }
        // Every Bus that feeds a soloed Bus, however indirectly: in reverse
        // mixing order, each Bus after what it feeds.
        let mut upstream = [false; MAX_BUSES];
        let feeds_a_solo = |upstream: &[bool], to: usize| {
            to < count && (self.buses[to].mixer().solo || upstream[to])
        };
        for &at in self.bus_order.iter().rev() {
            upstream[at] = self.buses[at].feeds().any(|to| feeds_a_solo(&upstream, to));
        }
        for track in &mut self.tracks {
            let mixer = track.mixer();
            let heard = mixer.solo || track.feeds().any(|to| feeds_a_solo(&upstream, to));
            track.set_audible(!mixer.mute && heard);
        }
        for (at, bus) in self.buses.iter_mut().enumerate() {
            let mixer = bus.mixer();
            let heard = mixer.solo || downstream[at] || upstream[at];
            bus.set_audible(!mixer.mute && heard);
        }
    }

    /// Mix each Bus into what it feeds, in order, for a block of `frames`.
    /// Run frames `start` to `end` of the Buses, then the Master, through
    /// their Insert Chains at `tempo`. Audio Analysis of one Track measures
    /// it alone, before the Buses and the Master.
    fn mix_down(&mut self, start: usize, end: usize, tempo: f64) {
        if self.isolate.is_some() || start == end {
            return;
        }
        for bus in &mut self.buses {
            bus.chain_mut().set_tempo(tempo);
        }
        self.master_chain.set_tempo(tempo);
        self.mix_buses(start, end);
        self.master_chain.process_at(
            &mut self.left[start..end],
            &mut self.right[start..end],
            &self.ticks[start..end],
        );
    }

    fn mix_buses(&mut self, start: usize, end: usize) {
        for position in 0..self.bus_order.len() {
            let from = self.bus_order[position];
            if !self.buses[from].audible() {
                continue;
            }
            self.buses[from].process(start, end, &self.ticks[start..end]);
            self.feed(from, self.buses[from].output(), 1.0, None, (start, end));
            for index in 0..self.buses[from].sends().len() {
                let send = self.buses[from].sends()[index];
                let line = self.buses[from]
                    .automation()
                    .send_line(send.bus, &self.ticks[start..end]);
                self.feed(from, Output::Bus(send.bus), send.level, line, (start, end));
            }
        }
    }

    /// Add frames `start` to `end` of Bus `from`'s output, scaled by
    /// `level` or following `line`, to `to`.
    fn feed(
        &mut self,
        from: usize,
        to: Output,
        level: f32,
        line: Option<Line>,
        (start, end): (usize, usize),
    ) {
        let ticks = &self.ticks[start..end];
        match to {
            Output::Bus(to) if to != from && to < self.buses.len() => {
                let (from, to) = two_mut(&mut self.buses, from, to);
                from.add_to(start, to.input(start, end), level, line, ticks);
            }
            _ => self.buses[from].add_to(
                start,
                (&mut self.left[start..end], &mut self.right[start..end]),
                level,
                line,
                ticks,
            ),
        }
    }

    fn effect_mut(&mut self, chain: i32, index: usize) -> Option<&mut Effect> {
        self.chain_mut(chain)?.effect_mut(index)
    }

    fn drums(&mut self, track: usize) -> Option<&mut DrumSampler> {
        self.tracks.get_mut(track)?.instrument_mut().drums_mut()
    }

    fn keys(&mut self, track: usize) -> Option<&mut crate::instrument::Keys> {
        self.tracks.get_mut(track)?.instrument_mut().keys_mut()
    }

    /// The earliest tick, at or after `scan_from`, when something is due.
    fn next_event(&self) -> Option<u64> {
        let from = self.scan_from;
        let notes = self.tracks.iter().filter_map(|t| t.next_event(from)).min();
        let beat = self
            .metronome_on
            .then(|| self.transport.tempo_map().next_beat(from));
        let loop_end = self
            .transport
            .loop_region()
            .or(self.stop_at())
            .map(|r| r.end)
            .filter(|&end| end >= from);
        // Nothing plays at a Tempo Change or a breakpoint, but a segment
        // starts there.
        let tempo_change = self.transport.tempo_map().next_change(from);
        let breakpoint = self
            .tracks
            .iter()
            .filter_map(|t| t.next_breakpoint(from))
            .chain(self.buses.iter().filter_map(|b| b.next_breakpoint(from)))
            .chain(self.master_automation.next_point(from))
            .chain(self.master_chain.next_breakpoint(from))
            .min();
        [notes, beat, loop_end, tempo_change, breakpoint]
            .into_iter()
            .flatten()
            .min()
    }

    /// Everything due at `tick`. At the loop's end that is only the wrap: the
    /// loop's end is exclusive, and what starts at its start plays next.
    fn play_events_at(&mut self, tick: u64) {
        self.scan_from = tick + 1;

        if let Some(region) = self.transport.loop_region()
            && tick == region.end
        {
            self.transport.seek(region.start);
            self.rewind_to(region.start);
            return;
        }
        // At the end of what Play plays, it stops, ready to play it again.
        if let Some(range) = self.stop_at()
            && tick == range.end
        {
            self.stop();
            self.seek(range.start as f64);
            return;
        }

        for track in &mut self.tracks {
            track.play_events_at(tick, &self.transport);
        }
        if self.metronome_on
            && let Some(accent) = self.transport.tempo_map().beat_at(tick)
        {
            self.metronome.click(accent);
        }
    }

    /// Let every meter fall for a block of `frames`, before the block's own
    /// peaks raise them again.
    fn fall_meters(&mut self, frames: usize) {
        let db = METER_FALL_DB_PER_SECOND * frames as f32 / self.sample_rate;
        let factor = 10.0_f32.powf(-db / 20.0);
        self.master_meter *= factor;
        for track in &mut self.tracks {
            track.fall(factor);
        }
        for bus in &mut self.buses {
            bus.fall(factor);
        }
    }

    /// Release scheduled notes and continue scheduling from `tick`.
    fn rewind_to(&mut self, tick: u64) {
        self.scan_from = tick;
        for track in &mut self.tracks {
            track.rewind(tick, &self.transport);
        }
    }

    fn render_segment(&mut self, start: usize, end: usize) {
        if start == end {
            return;
        }
        // Automation follows the song across the segment, which has no
        // breakpoint inside it, frame by frame: each frame's tick depends
        // only on where it is in the song, so export and playback agree
        // however their blocks fall.
        let ticks = &mut self.ticks[start..end];
        for (frame, tick) in ticks.iter_mut().enumerate() {
            *tick = self.transport.position_after(frame as u64);
        }
        let ticks = &self.ticks[start..end];
        let master = self
            .master_automation
            .line(ticks[0], ticks[ticks.len() - 1]);
        for (gain, &tick) in self.master_gain[start..end].iter_mut().zip(ticks) {
            *gain = master.map_or(self.master_volume, |line| line.at(tick));
        }
        let left = &mut self.left[start..end];
        let right = &mut self.right[start..end];
        let gain = TRACKS_GAIN / (self.tracks.len().max(1) as f32).sqrt();
        let isolate = self.isolate;
        // A synced Delay takes the tempo where the segment starts, and a
        // Tempo Change always starts one.
        let tempo = self.transport.tempo();
        for (index, track) in self.tracks.iter_mut().enumerate() {
            track.chain_mut().set_tempo(tempo);
            let audible = match isolate {
                // Isolated for Audio Analysis: that Track alone, whatever the
                // mixer says, and before whatever it feeds.
                Some(isolate) => isolate == index,
                None => track.audible(),
            };
            if !audible {
                continue;
            }
            if isolate.is_none() && !track.sends().is_empty() {
                // Render once, after the fader, then hand the same signal to
                // the output and each Send. Starting from silence, adding it
                // on is exactly what rendering straight in would give.
                let post_left = &mut self.post_left[start..end];
                let post_right = &mut self.post_right[start..end];
                post_left.fill(0.0);
                post_right.fill(0.0);
                track.render_at(post_left, post_right, gain, ticks);
                let feeds = track.output().bus().into_iter().map(|bus| (bus, 1.0, None));
                let automation = track.automation();
                let sends = track
                    .sends()
                    .iter()
                    .map(|send| (send.bus, send.level, automation.send_line(send.bus, ticks)));
                if track.output().bus().is_none() {
                    add_scaled(post_left, post_right, left, right, 1.0);
                }
                for (bus, level, line) in feeds.chain(sends) {
                    if let Some(bus) = self.buses.get_mut(bus) {
                        let from = (&post_left[..], &post_right[..]);
                        add_following(from, bus.input(start, end), level, line, ticks);
                    }
                }
                continue;
            }
            let bus = track
                .output()
                .bus()
                .filter(|_| isolate.is_none())
                .and_then(|bus| self.buses.get_mut(bus));
            match bus {
                Some(bus) => {
                    let (bus_left, bus_right) = bus.input(start, end);
                    track.render_at(bus_left, bus_right, gain, ticks);
                }
                None => track.render_at(left, right, gain, ticks),
            }
        }
        if isolate.is_some() {
            return;
        }
        self.live.render_into(left, right, LIVE_GAIN);
        self.metronome.render_into(left, right);
    }

    fn render_transient(&mut self, frames: usize) {
        let Some(start) = self.click_position else {
            return;
        };
        let half = self.click_frames / 2;
        let left = &mut self.left[..frames];
        let right = &mut self.right[..frames];
        for (offset, (l, r)) in left.iter_mut().zip(right.iter_mut()).enumerate() {
            let position = start + offset;
            if position >= self.click_frames {
                break;
            }
            let level = if position < half {
                CLICK_LEVEL
            } else {
                -CLICK_LEVEL
            };
            *l = level;
            *r = level;
        }
        let next = start + frames;
        self.click_position = (next < self.click_frames).then_some(next);
    }

    /// The last block's left channel, for native callers (tests, a future
    /// desktop host), which can borrow it instead of reading raw memory.
    pub fn left(&self) -> &[f32] {
        &self.left
    }

    /// The last block's right channel.
    pub fn right(&self) -> &[f32] {
        &self.right
    }
}

/// Which Insert Chain a host's chain number names.
enum ChainOwner {
    Track(usize),
    Master,
    Bus(usize),
}

impl ChainOwner {
    fn of(chain: i32) -> Self {
        match usize::try_from(chain) {
            Ok(track) => ChainOwner::Track(track),
            Err(_) if chain == -1 => ChainOwner::Master,
            Err(_) => ChainOwner::Bus((-2 - i64::from(chain)) as usize),
        }
    }
}

/// The number a chain command gives Bus `bus`'s Insert Chain: -2 for the
/// first Bus, -3 for the next, and so on, below the Master's -1.
pub fn bus_chain(bus: usize) -> i32 {
    -2 - bus as i32
}

/// Two different Buses, mutably at once.
#[allow(clippy::vec_box)]
fn two_mut(buses: &mut [Box<Bus>], a: usize, b: usize) -> (&mut Bus, &mut Bus) {
    if a < b {
        let (low, high) = buses.split_at_mut(b);
        (&mut low[a], &mut high[0])
    } else {
        let (low, high) = buses.split_at_mut(a);
        (&mut high[0], &mut low[b])
    }
}

mod analyse;
pub use analyse::{Attached, Attachments, Listening};
#[cfg(test)]
mod audio_tests;
#[cfg(test)]
mod automation_tests;
#[cfg(test)]
mod bus_tests;
#[cfg(test)]
mod delay_tests;
mod export;
#[cfg(test)]
mod monitor_tests;
#[cfg(test)]
mod plugin_tests;
#[cfg(test)]
mod send_tests;
#[cfg(test)]
mod settings_automation_tests;
#[cfg(test)]
mod tempo_change_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod whole_song_tests;

//! The engine on a native audio thread, and the control side that drives it.
//!
//! `Renderer` owns the Engine and runs inside the audio callback. It takes
//! no locks and allocates nothing: commands reach it through lock-free
//! queues (one from the UI's `Controller`, one from the MIDI thread), and
//! anything it replaces goes back through a third to be dropped by the
//! `Controller`, and live notes the engine recorded come back through a
//! fourth. Nothing here knows about audio devices, so tests drive the
//! render path directly and assert on the samples.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Instant;

use rtrb::{Consumer, Producer, RingBuffer};
use soundcheck_engine::{
    AUDITION_GAIN, Audition, DJ_REPORT_LEN, DjControl, DjMixer, Engine, KeysSettings, MAX_BUSES,
    MAX_TRACKS, NoteList, PluginKind, PluginRuntime, PreparedAudioClips, PreparedAudioFile,
    PreparedAutomation, PreparedBus, PreparedDjTrack, PreparedEffect, PreparedInstrument,
    PreparedSample, PreparedSends, PreparedTempoChanges, PreparedTrack, RECORDING_CAPACITY,
    SynthSettings, TICKS_PER_BEAT, bus_chain,
};

use crate::command::{EffectSettings, EngineCommand, Garbage, RecordedNoteEvent, RtCommand};
use crate::monitor::MonitorFeed;
use crate::recorder::PlaybackClock;
use crate::stats::{EngineState, SharedStats};

/// The most frames the engine renders at once. A callback asking for more
/// is rendered in several blocks.
pub const MAX_BLOCK: usize = 1_024;

/// Room for a burst of commands, e.g. setting every Track's notes at once.
const QUEUE: usize = 4_096;
const MIDI_QUEUE: usize = 1_024;
/// Seconds of the DJ mix's recording the audio thread can hand over before
/// the UI next takes it.
const DJ_RECORDING_SECONDS: f32 = 10.0;

/// Build a Renderer for the audio thread, the Controller that drives it, and
/// the producer end of the MIDI queue.
pub fn host(sample_rate: f32, track_count: usize) -> (Controller, Renderer, Producer<RtCommand>) {
    let (commands, command_queue) = RingBuffer::new(QUEUE);
    let (midi, midi_queue) = RingBuffer::new(MIDI_QUEUE);
    // Every command hands back at most one thing, and a whole queue of
    // commands plus every Track can be outstanding.
    let (garbage_out, garbage) = RingBuffer::new(QUEUE + MAX_TRACKS + MAX_BUSES);
    // The engine's log holds a whole burst between callbacks, and the UI
    // drains this queue far less often, so give it several bursts' room.
    let (recorded_out, recorded) = RingBuffer::new(RECORDING_CAPACITY);
    let (dj_recording_out, dj_recording) =
        RingBuffer::new((DJ_RECORDING_SECONDS * sample_rate) as usize * 2);
    let stats = Arc::new(SharedStats::default());

    let mut engine = Engine::new(sample_rate);
    engine.prepare(MAX_BLOCK);
    let renderer = Renderer {
        engine,
        sample_rate,
        commands: command_queue,
        midi: midi_queue,
        garbage: garbage_out,
        recorded: recorded_out,
        stats: Arc::clone(&stats),
        clock: Arc::default(),
        played_at: None,
        audition: Audition::default(),
        monitor: None,
        dj_recording: dj_recording_out,
        dj_report: [0.0; DJ_REPORT_LEN],
        headphones: None,
    };
    let mut controller = Controller {
        sample_rate,
        commands,
        pending: VecDeque::new(),
        garbage,
        recorded,
        stats,
        track_count: 0,
        bus_count: 0,
        pattern_playing: false,
        audio_files: HashMap::new(),
        plugins: HashMap::new(),
        offline: false,
        dj_installed: false,
        dj_recording,
    };
    controller.send(EngineCommand::SetTrackCount { count: track_count });
    (controller, renderer, midi)
}

/// A Renderer no device plays, brought to `commands` through a Controller of
/// its own exactly as the live one is, so an offline render (Audio Analysis,
/// an export) hears what plays.
pub fn offline(sample_rate: f32, commands: impl IntoIterator<Item = EngineCommand>) -> Renderer {
    let (mut controller, mut renderer, _midi) = host(sample_rate, 0);
    controller.offline = true;
    // One command becomes far fewer prepared ones than the queue holds, so
    // applying after each one never leaves any waiting.
    for command in commands {
        controller.send(command);
        renderer.apply_queued();
    }
    renderer
}

/// The control side: turns the UI's commands into prepared ones for the
/// audio thread, and drops what comes back.
pub struct Controller {
    sample_rate: f32,
    commands: Producer<RtCommand>,
    /// Commands that didn't fit in the queue yet, sent on the next call.
    pending: VecDeque<RtCommand>,
    garbage: Consumer<Garbage>,
    recorded: Consumer<RecordedNoteEvent>,
    stats: Arc<SharedStats>,
    track_count: usize,
    bus_count: usize,
    pattern_playing: bool,
    /// The audio files Audio Clips play, decoded here, by the UI's number
    /// for each.
    audio_files: HashMap<u32, PreparedAudioFile>,
    /// The WASM Plugins Effect slots can host, compiled here, by id.
    plugins: HashMap<String, crate::plugin::LoadedPlugin>,
    /// Whether this is an offline render's, whose VST3 Plugins are copies of
    /// the live ones in helpers of their own (ADR 0008).
    offline: bool,
    /// Whether the audio thread has been given its DJ Mixer yet.
    dj_installed: bool,
    /// The DJ mix's recording, as the audio thread hands it over.
    dj_recording: Consumer<f32>,
}

impl Controller {
    pub fn send(&mut self, command: EngineCommand) {
        self.collect_garbage();
        match command {
            EngineCommand::NoteOn { note, velocity } => {
                self.push(RtCommand::NoteOn { note, velocity })
            }
            EngineCommand::NoteOff { note } => self.push(RtCommand::NoteOff { note }),
            EngineCommand::SetTrackCount { count } => self.set_track_count(count),
            EngineCommand::SetTrackNotes { track, notes } => {
                let notes = NoteList::from_flat(&notes);
                self.push(RtCommand::SetNotes { track, notes });
            }
            EngineCommand::SetTrackMixer {
                track,
                volume,
                pan,
                mute,
                solo,
            } => self.push(RtCommand::SetTrackMixer {
                track,
                volume,
                pan,
                mute,
                solo,
            }),
            EngineCommand::SetBusCount { count } => self.set_bus_count(count),
            EngineCommand::SetBusMixer {
                bus,
                volume,
                pan,
                mute,
                solo,
            } => self.push(RtCommand::SetBusMixer {
                bus,
                volume,
                pan,
                mute,
                solo,
            }),
            EngineCommand::SetTrackOutput { track, output } => {
                self.push(RtCommand::SetTrackOutput { track, output })
            }
            EngineCommand::SetBusOutput { bus, output } => {
                self.push(RtCommand::SetBusOutput { bus, output })
            }
            EngineCommand::SetSends { channel, sends } => {
                // The list is built here, off the audio thread.
                if let Some(sends) = PreparedSends::new(channel, &sends) {
                    self.push(RtCommand::SetSends(sends));
                }
            }
            EngineCommand::SetMasterVolume { volume } => {
                self.push(RtCommand::SetMasterVolume(volume))
            }
            EngineCommand::SetAutomation {
                target,
                setting,
                points,
            } => {
                // Sorting the breakpoints allocates, so it happens here.
                if let Some(automation) = PreparedAutomation::new(&setting, &points) {
                    self.push(RtCommand::SetAutomation { target, automation });
                }
            }
            EngineCommand::SetSynthSettings { track, settings } => {
                // Parsed here, on the control side: `SynthSettings` is plain
                // numbers, so applying it on the audio thread allocates
                // nothing.
                let settings = SynthSettings::from_flat(&settings);
                self.push(RtCommand::SetSynth { track, settings });
            }
            EngineCommand::SetTrackInstrument {
                track,
                instrument,
                pads,
            } => {
                // The Drum Sampler decodes the bundled kit as it is built, so
                // it is built here, at the size the Project says; an unknown
                // name is nothing to send.
                let built = PreparedInstrument::named(&instrument, self.sample_rate, pads);
                if let Some(instrument) = built {
                    self.push(RtCommand::SetInstrument { track, instrument });
                }
            }
            EngineCommand::SetPad {
                track,
                pad,
                note,
                volume,
                pan,
                pitch,
                choke_group,
            } => self.push(RtCommand::SetPad {
                track,
                pad,
                note,
                volume,
                pan,
                pitch,
                choke_group,
            }),
            EngineCommand::SetPadSample { track, pad, wav } => {
                // Decoding allocates, so it happens here. What is wrong with
                // a file is the UI's to report: it checked before sending.
                if let Ok(sample) = PreparedSample::decode(&wav) {
                    self.push(RtCommand::SetPadSample { track, pad, sample });
                }
            }
            EngineCommand::ClearPadSample { track, pad } => {
                // Back to the kit's own sample, decoded here rather than on
                // the audio thread; a pad past the kit's end has none.
                match PreparedSample::kit(pad) {
                    Some(sample) => self.push(RtCommand::SetPadSample { track, pad, sample }),
                    None => self.push(RtCommand::ClearPadSample { track, pad }),
                }
            }
            EngineCommand::SetKeysSettings { track, settings } => {
                // Parsed here, as the Synth's are: plain numbers on the audio thread.
                let settings = KeysSettings::from_flat(&settings);
                self.push(RtCommand::SetKeys { track, settings });
            }
            EngineCommand::SetKeysSample { track, wav } => {
                // Decoded here, as a pad's sample is; the UI checked the file.
                if let Ok(sample) = PreparedSample::decode(&wav) {
                    self.push(RtCommand::SetKeysSample {
                        track,
                        sample: Some(sample),
                    });
                }
            }
            EngineCommand::ClearKeysSample { track } => self.push(RtCommand::SetKeysSample {
                track,
                sample: None,
            }),
            EngineCommand::InsertEffect {
                chain,
                index,
                effect,
            } => {
                // Built here: the Reverb's delay lines allocate.
                if let Some(effect) = PreparedEffect::named(&effect, self.sample_rate) {
                    self.push(RtCommand::InsertEffect {
                        chain,
                        index,
                        effect,
                    });
                }
            }
            EngineCommand::LoadPlugin { plugin, wasm } => {
                // Compiling takes tens of milliseconds, so it happens here,
                // once. A Plugin that won't load is the UI's to report: it
                // checked when the Plugin was installed.
                if let Ok(loaded) = crate::plugin::load(&wasm)
                    && loaded.manifest.id == plugin
                {
                    self.plugins.insert(plugin, loaded);
                }
            }
            EngineCommand::InsertPlugin {
                chain,
                index,
                plugin,
            } => {
                // Instantiating runs the Plugin's `sc_init`, which allocates.
                let effect = self
                    .plugins
                    .get(&plugin)
                    .and_then(|loaded| {
                        let runtime = crate::plugin::runtime();
                        runtime
                            .instantiate(
                                &loaded.module,
                                &loaded.manifest,
                                self.sample_rate,
                                MAX_BLOCK,
                            )
                            .ok()
                            .map(|instance| {
                                PreparedEffect::plugin(Arc::clone(&loaded.manifest), instance)
                            })
                    })
                    .unwrap_or_else(|| PreparedEffect::missing_plugin(&plugin));
                self.push(RtCommand::InsertEffect {
                    chain,
                    index,
                    effect,
                });
            }
            EngineCommand::SetTrackPlugin { track, plugin } => {
                // As `InsertPlugin`: instantiating runs `sc_init` here.
                let instrument = self
                    .plugins
                    .get(&plugin)
                    .filter(|loaded| loaded.manifest.kind == PluginKind::Instrument)
                    .and_then(|loaded| {
                        let runtime = crate::plugin::runtime();
                        runtime
                            .instantiate(
                                &loaded.module,
                                &loaded.manifest,
                                self.sample_rate,
                                MAX_BLOCK,
                            )
                            .ok()
                            .map(|instance| {
                                PreparedInstrument::plugin(Arc::clone(&loaded.manifest), instance)
                            })
                    })
                    .unwrap_or_else(|| PreparedInstrument::missing(&plugin));
                self.push(RtCommand::SetInstrument { track, instrument });
            }
            EngineCommand::InsertVst3 {
                chain,
                index,
                instance,
                generation,
            } => {
                // An offline copy starts a helper here, and a live one at a
                // new rate is loaded again: both block for a while.
                let effect = self
                    .vst3(&instance, generation, PluginKind::Effect)
                    .map(|hosted| {
                        PreparedEffect::restored_plugin(
                            hosted.manifest,
                            hosted.instance,
                            &hosted.values,
                        )
                    })
                    .unwrap_or_else(|| PreparedEffect::missing_plugin(&format!("vst3:{instance}")));
                self.push(RtCommand::InsertEffect {
                    chain,
                    index,
                    effect,
                });
            }
            EngineCommand::SetTrackVst3 {
                track,
                instance,
                generation,
            } => {
                let instrument = self
                    .vst3(&instance, generation, PluginKind::Instrument)
                    .map(|hosted| {
                        PreparedInstrument::restored_plugin(
                            hosted.manifest,
                            hosted.instance,
                            &hosted.values,
                        )
                    })
                    .unwrap_or_else(|| PreparedInstrument::missing(&format!("vst3:{instance}")));
                self.push(RtCommand::SetInstrument { track, instrument });
            }
            EngineCommand::SetInstrumentSettings { track, settings } => {
                let settings = EffectSettings::from_flat(&settings);
                self.push(RtCommand::SetInstrumentSettings { track, settings });
            }
            EngineCommand::RemoveEffect { chain, index } => {
                self.push(RtCommand::RemoveEffect { chain, index })
            }
            EngineCommand::MoveEffect { chain, from, to } => {
                self.push(RtCommand::MoveEffect { chain, from, to })
            }
            EngineCommand::SetEffectBypassed {
                chain,
                index,
                bypassed,
            } => self.push(RtCommand::SetEffectBypassed {
                chain,
                index,
                bypassed,
            }),
            EngineCommand::SetEffectSettings {
                chain,
                index,
                settings,
            } => {
                let settings = EffectSettings::from_flat(&settings);
                self.push(RtCommand::SetEffectSettings {
                    chain,
                    index,
                    settings,
                });
            }
            EngineCommand::SetTrackMonitoring { track, on } => {
                self.push(RtCommand::SetTrackMonitoring { track, on })
            }
            EngineCommand::SetTrackAudio { track, audio } => {
                self.push(RtCommand::SetTrackAudio { track, audio })
            }
            EngineCommand::LoadAudioFile { file, bytes } => {
                // Decoding and resampling allocate, so they happen here. What
                // is wrong with a file is the UI's to report: it checked.
                if let Ok(decoded) = PreparedAudioFile::decode(&bytes, self.sample_rate) {
                    self.audio_files.insert(file, decoded);
                }
            }
            EngineCommand::UnloadAudioFile { file } => {
                self.audio_files.remove(&file);
            }
            EngineCommand::SetTrackAudioClips { track, clips } => {
                let files = &self.audio_files;
                let clips = PreparedAudioClips::new(self.sample_rate, &clips, |file| {
                    files.get(&file).cloned()
                });
                self.push(RtCommand::SetAudioClips { track, clips });
            }
            EngineCommand::SetPatternPlaying { playing } => {
                self.pattern_playing = playing;
                for track in 0..self.track_count {
                    let notes = self.notes_for_new_track(track);
                    self.push(RtCommand::SetNotes { track, notes });
                }
                if playing {
                    self.push(RtCommand::Seek(0.0));
                    self.push(RtCommand::Play);
                } else {
                    self.push(RtCommand::Stop);
                }
            }
            EngineCommand::SetLatencyTest { on } => self.push(RtCommand::SetLatencyTest(on)),
            EngineCommand::SetLiveTrack { track } => self.push(RtCommand::SetLiveTrack(track)),
            EngineCommand::SetRecording { on } => self.push(RtCommand::SetRecording(on)),
            EngineCommand::Play => self.push(RtCommand::Play),
            EngineCommand::Stop => self.push(RtCommand::Stop),
            EngineCommand::Seek { tick } => self.push(RtCommand::Seek(tick)),
            EngineCommand::SetTempo { bpm } => self.push(RtCommand::SetTempo(bpm)),
            EngineCommand::SetTimeSignature {
                beats_per_bar,
                beat_unit,
            } => self.push(RtCommand::SetTimeSignature {
                beats_per_bar,
                beat_unit,
            }),
            EngineCommand::SetTempoChanges { changes } => {
                // Sorting the changes allocates, so it happens here.
                let changes = PreparedTempoChanges::new(&changes);
                self.push(RtCommand::SetTempoChanges(changes));
            }
            EngineCommand::SetLoop {
                start_tick,
                end_tick,
                enabled,
            } => self.push(RtCommand::SetLoop {
                start: start_tick,
                end: end_tick,
                enabled,
            }),
            EngineCommand::SetPlayRange {
                start_tick,
                end_tick,
            } => self.push(RtCommand::SetPlayRange {
                start: start_tick,
                end: end_tick,
            }),
            EngineCommand::SetMetronome { on } => self.push(RtCommand::SetMetronome(on)),
            EngineCommand::DjSet {
                kind,
                index,
                name,
                value,
            } => {
                // Parsed here, so the audio thread only matches an enum.
                if let Some(control) = DjControl::parse(&kind, index, &name) {
                    self.install_dj();
                    self.push(RtCommand::DjSet(control, value));
                }
            }
        }
    }

    /// Build the DJ Mixer the first time the Mixer page needs it: it
    /// allocates, so it happens here.
    fn install_dj(&mut self) {
        if !self.dj_installed {
            let mut dj = Box::new(DjMixer::new(self.sample_rate));
            dj.prepare(MAX_BLOCK);
            self.push(RtCommand::DjInstall(dj));
            self.dj_installed = true;
        }
    }

    /// Put a file decoded and analysed for Deck `deck` (at this
    /// Controller's sample rate, off the audio thread) there. Answers its
    /// BPM, Beat Grid, key and waveform, as JSON.
    pub fn dj_put(&mut self, deck: usize, prepared: PreparedDjTrack) -> String {
        self.collect_garbage();
        self.install_dj();
        let analysis = prepared.analysis.to_json();
        self.push(RtCommand::DjLoad {
            deck,
            track: Some(prepared.track),
        });
        analysis
    }

    /// Take the file off Deck `deck`.
    pub fn dj_unload(&mut self, deck: usize) {
        self.collect_garbage();
        if self.dj_installed {
            self.push(RtCommand::DjLoad { deck, track: None });
        }
    }

    /// Send the headphone cue into `ring` for a second output device to
    /// play, replacing any ring it went to; None stops sending it.
    pub fn set_headphones(&mut self, ring: Option<Producer<f32>>) {
        self.collect_garbage();
        self.push(RtCommand::SetHeadphones(ring.map(Box::new)));
    }

    /// The DJ mix recorded since the last call, interleaved stereo.
    pub fn take_dj_recording(&mut self) -> Vec<f32> {
        let mut taken = Vec::with_capacity(self.dj_recording.slots());
        while let Ok(sample) = self.dj_recording.pop() {
            taken.push(sample);
        }
        taken
    }

    /// Audition a file from the sample browser (#52): it plays once at the
    /// preview level, straight to the output and past the mixer, replacing
    /// any file already auditioning. Decoding allocates, so it happens here;
    /// what is wrong with the file comes back as the error.
    pub fn audition(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.audition_at(bytes, AUDITION_GAIN)
    }

    /// `audition`, at a linear `gain` of its own: the Reference Track (#106),
    /// at its own level or turned down to the mix's loudness.
    pub fn audition_at(&mut self, bytes: &[u8], gain: f32) -> Result<(), String> {
        let file = PreparedAudioFile::decode(bytes, self.sample_rate)
            .map_err(|error| error.message().to_string())?;
        self.collect_garbage();
        self.push(RtCommand::Audition(file, gain.max(0.0)));
        Ok(())
    }

    pub fn stop_audition(&mut self) {
        self.collect_garbage();
        self.push(RtCommand::StopAudition);
    }

    /// Give the audio thread the live input armed Tracks monitor, replacing
    /// any it has, or take it away with None.
    pub fn set_monitor(&mut self, feed: Option<MonitorFeed>) {
        self.collect_garbage();
        self.push(RtCommand::SetMonitor(feed.map(Box::new)));
    }

    /// Every live note the engine has recorded since the last call, in the
    /// order it was played.
    pub fn take_recorded_notes(&mut self) -> Vec<RecordedNoteEvent> {
        let mut notes = Vec::new();
        while let Ok(note) = self.recorded.pop() {
            notes.push(note);
        }
        notes
    }

    pub fn stats(&mut self) -> &SharedStats {
        self.collect_garbage();
        self.flush();
        &self.stats
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    /// Drop whatever the audio thread has handed back.
    fn collect_garbage(&mut self) {
        while self.garbage.pop().is_ok() {}
    }

    fn set_track_count(&mut self, count: usize) {
        let count = count.min(MAX_TRACKS);
        while self.track_count < count {
            let notes = self.notes_for_new_track(self.track_count);
            let track = PreparedTrack::new(self.sample_rate, MAX_BLOCK, notes);
            self.push(RtCommand::AddTrack(track));
            self.track_count += 1;
        }
        while self.track_count > count {
            self.push(RtCommand::RemoveTrack);
            self.track_count -= 1;
        }
    }

    fn set_bus_count(&mut self, count: usize) {
        let count = count.min(MAX_BUSES);
        while self.bus_count < count {
            self.push(RtCommand::AddBus(PreparedBus::new(MAX_BLOCK)));
            self.bus_count += 1;
        }
        while self.bus_count > count {
            self.push(RtCommand::RemoveBus);
            self.bus_count -= 1;
        }
    }

    /// Like the engine's own `set_track_count`: a Track added while the
    /// load-test pattern plays joins in.
    fn notes_for_new_track(&self, index: usize) -> NoteList {
        if self.pattern_playing {
            NoteList::load_test_pattern(index)
        } else {
            NoteList::default()
        }
    }

    /// The VST3 Plugin loaded as `instance`, for a slot of `kind`: the live
    /// one, or for an offline render a copy of it.
    fn vst3(
        &self,
        instance: &str,
        generation: u32,
        kind: PluginKind,
    ) -> Option<crate::vst3::Hosted> {
        let mode = if self.offline {
            crate::vst3::process::Mode::Offline
        } else {
            crate::vst3::process::Mode::Realtime
        };
        crate::vst3::registry().hosted(instance, generation, kind, self.sample_rate, mode)
    }

    fn push(&mut self, command: RtCommand) {
        self.pending.push_back(command);
        self.flush();
    }

    /// Send what's pending, in order, as far as the queue has room.
    fn flush(&mut self) {
        while let Some(command) = self.pending.pop_front() {
            if let Err(rtrb::PushError::Full(command)) = self.commands.push(command) {
                self.pending.push_front(command);
                return;
            }
        }
    }
}

/// The audio side: owns the Engine and fills the device's buffers.
pub struct Renderer {
    engine: Engine,
    sample_rate: f32,
    commands: Consumer<RtCommand>,
    midi: Consumer<RtCommand>,
    garbage: Producer<Garbage>,
    recorded: Producer<RecordedNoteEvent>,
    stats: Arc<SharedStats>,
    /// Where an audio recording learns what was playing when.
    clock: Arc<PlaybackClock>,
    /// When the next callback's first frame will be heard, if the device says.
    played_at: Option<f64>,
    /// A file from the sample browser, added to the output after the engine
    /// has rendered, so no fader, Effect or meter of the song's sees it.
    audition: Audition,
    /// The live input armed Tracks monitor, while an input is open.
    monitor: Option<Box<MonitorFeed>>,
    /// Where the DJ mix's recording goes, for the Controller to take.
    dj_recording: Producer<f32>,
    /// The DJ Mixer's report, filled each callback without allocating.
    dj_report: [f64; DJ_REPORT_LEN],
    /// Where the headphone cue goes for a second output device to play.
    headphones: Option<Box<Producer<f32>>>,
}

impl Renderer {
    /// Fill `out`, interleaved with `channels` channels: left and right in
    /// the first two, silence in any others, the mix in both halves of mono.
    /// Applies queued commands first. Allocates nothing and takes no locks.
    pub fn process(&mut self, out: &mut [f32], channels: usize) {
        self.process_as(out, channels, |sample| sample);
    }

    /// `process` for a device that takes samples of another type: each one
    /// is converted from the engine's `f32` with `convert`.
    pub fn process_as<T: Copy>(
        &mut self,
        out: &mut [T],
        channels: usize,
        convert: impl Fn(f32) -> T,
    ) {
        let started = Instant::now();
        let channels = channels.max(1);
        let frames = out.len() / channels;

        self.apply_queued();
        if let Some(seconds) = self.played_at.take()
            && self.engine.is_playing()
        {
            let ticks_per_second = self.engine.tempo() / 60.0 * TICKS_PER_BEAT as f64;
            self.clock
                .offer(seconds, self.engine.position(), ticks_per_second);
        }

        if let Some(monitor) = &mut self.monitor {
            monitor.begin(frames);
        }
        for chunk in out.chunks_mut(MAX_BLOCK * channels) {
            let block = chunk.len() / channels;
            if let Some(monitor) = &mut self.monitor {
                monitor.feed(&mut self.engine, block);
            }
            self.engine.render(block);
            let left = &self.engine.left()[..block];
            let right = &self.engine.right()[..block];
            // The DJ Mixer's headphone cue goes out of outputs 3 and 4 of an
            // interface that has them, as a DJ interface does (ADR 0013).
            let headphones = self
                .engine
                .dj_headphones()
                .filter(|_| channels >= 4)
                .map(|(l, r)| (&l[..block], &r[..block]));
            for (index, (frame, (l, r))) in chunk
                .chunks_exact_mut(channels)
                .zip(left.iter().zip(right))
                .enumerate()
            {
                let (audition_l, audition_r) = self.audition.next_frame();
                let (l, r) = (l + audition_l, r + audition_r);
                if channels == 1 {
                    frame[0] = convert(0.5 * (l + r));
                } else {
                    frame[0] = convert(l);
                    frame[1] = convert(r);
                    frame[2..].fill(convert(0.0));
                    if let Some((cue_l, cue_r)) = headphones {
                        frame[2] = convert(cue_l[index]);
                        frame[3] = convert(cue_r[index]);
                    }
                }
            }
            // And to a second device's ring, a whole frame at a time; one
            // that isn't keeping up loses the rest of this block.
            if let (Some(ring), Some((cue_l, cue_r))) =
                (&mut self.headphones, self.engine.dj_headphones())
            {
                for (&l, &r) in cue_l[..block].iter().zip(&cue_r[..block]) {
                    if ring.slots() < 2 {
                        break;
                    }
                    let _ = ring.push(l);
                    let _ = ring.push(r);
                }
            }
            for &sample in self.engine.dj_recorded() {
                // If the UI stops taking it, the rest is dropped rather than
                // waited for.
                if self.dj_recording.push(sample).is_err() {
                    break;
                }
            }
            self.engine.dj_clear_recorded();
        }
        if self.engine.has_dj() {
            self.engine.dj_report_into(&mut self.dj_report);
            self.stats.record_dj(&self.dj_report);
        }

        self.take_recorded_notes();

        self.stats.record_engine(EngineState {
            track_count: self.engine.track_count() as u32,
            active_voices: self.engine.active_voices() as u32,
            playing: self.engine.is_playing(),
            position: self.engine.position(),
        });
        // One meter per Track, plus the Master's, read straight off the
        // engine: no allocation, so the audio thread can publish them.
        self.stats.record_master_peak(self.engine.master_peak());
        for track in 0..self.engine.track_count() {
            self.stats
                .record_track_peak(track, self.engine.track_peak(track));
        }
        self.stats.record_bus_count(self.engine.bus_count());
        for bus in 0..self.engine.bus_count() {
            self.stats.record_bus_peak(bus, self.engine.bus_peak(bus));
        }
        // And each Effect's gain-reduction meter, on every chain: the
        // Buses' below the Master's.
        let buses = bus_chain(self.engine.bus_count()) + 1;
        for chain in buses..self.engine.track_count() as i32 {
            let count = self.engine.effect_count(chain);
            self.stats.record_effect_count(chain, count);
            for index in 0..count {
                self.stats.record_gain_reduction(
                    chain,
                    index,
                    self.engine.effect_gain_reduction(chain, index),
                );
            }
        }
        let budget = frames as f64 / f64::from(self.sample_rate);
        self.stats
            .record_callback(frames as u32, started.elapsed().as_secs_f64(), budget);
    }

    pub fn stats(&self) -> &Arc<SharedStats> {
        &self.stats
    }

    /// Say when the next `process` call's first frame will be heard, in
    /// `host_seconds`, so an audio recording can be lined up with it.
    pub fn set_played_at(&mut self, seconds: f64) {
        self.played_at = Some(seconds);
    }

    pub fn playback_clock(&self) -> &Arc<PlaybackClock> {
        &self.clock
    }

    /// Apply every queued command, from the UI and then from MIDI, without
    /// rendering anything.
    pub fn apply_queued(&mut self) {
        while let Ok(command) = self.commands.pop() {
            self.apply(command);
        }
        while let Ok(command) = self.midi.pop() {
            self.apply(command);
        }
    }

    /// The engine itself, for work off the audio thread such as Audio
    /// Analysis on a Renderer no device is playing.
    pub fn engine_mut(&mut self) -> &mut Engine {
        &mut self.engine
    }

    /// Move the engine's recorded notes into the queue to the `Controller`.
    /// Copying fixed-size values into a ring buffer allocates nothing. If
    /// the UI has stopped draining, the rest of this batch is dropped, like
    /// the engine's own log does when it fills.
    fn take_recorded_notes(&mut self) {
        for note in self.engine.recorded_notes() {
            if self.recorded.push(RecordedNoteEvent::from(*note)).is_err() {
                break;
            }
        }
        self.engine.clear_recorded_notes();
    }

    fn apply(&mut self, command: RtCommand) {
        let engine = &mut self.engine;
        match command {
            RtCommand::NoteOn { note, velocity } => engine.note_on(note, velocity),
            RtCommand::NoteOff { note } => engine.note_off(note),
            RtCommand::SetNotes { track, notes } => {
                let old = engine.set_track_note_list(track, notes);
                self.discard(Garbage::Notes(old));
            }
            RtCommand::SetTrackMixer {
                track,
                volume,
                pan,
                mute,
                solo,
            } => engine.set_track_mixer(track, volume, pan, mute, solo),
            RtCommand::SetMasterVolume(volume) => engine.set_master_volume(volume),
            RtCommand::SetAutomation { target, automation } => {
                let old = engine.swap_automation(target, automation);
                self.discard(Garbage::Automation(old));
            }
            RtCommand::AddBus(bus) => {
                if let Err(bus) = engine.add_bus(bus) {
                    self.discard(Garbage::Bus(bus));
                }
            }
            RtCommand::RemoveBus => {
                if let Some(bus) = engine.remove_bus() {
                    self.discard(Garbage::Bus(bus));
                }
            }
            RtCommand::SetBusMixer {
                bus,
                volume,
                pan,
                mute,
                solo,
            } => engine.set_bus_mixer(bus, volume, pan, mute, solo),
            // The UI refuses a loop before it gets here; if one did, the
            // engine refuses it too and the routing stays as it was.
            RtCommand::SetTrackOutput { track, output } => {
                engine.set_track_output(track, output);
            }
            RtCommand::SetBusOutput { bus, output } => {
                engine.set_bus_output(bus, output);
            }
            // Refused or replaced, the Sends that come back are freed off the
            // audio thread.
            RtCommand::SetSends(sends) => {
                let back = engine.swap_sends(sends).unwrap_or_else(|refused| refused);
                self.discard(Garbage::Sends(back));
            }
            RtCommand::SetSynth { track, settings } => {
                engine.set_track_synth_settings(track, settings);
            }
            RtCommand::AddTrack(track) => {
                if let Err(track) = engine.add_track(track) {
                    self.discard(Garbage::Track(track));
                }
            }
            RtCommand::RemoveTrack => {
                if let Some(track) = engine.remove_track() {
                    self.discard(Garbage::Track(track));
                }
            }
            RtCommand::SetInstrument { track, instrument } => {
                let old = engine.swap_track_instrument(track, instrument);
                self.discard(Garbage::Instrument(old));
            }
            RtCommand::SetPad {
                track,
                pad,
                note,
                volume,
                pan,
                pitch,
                choke_group,
            } => engine.set_track_pad(track, pad, note, volume, pan, pitch, choke_group),
            RtCommand::SetPadSample { track, pad, sample } => {
                if let Some(old) = engine.swap_pad_sample(track, pad, sample) {
                    self.discard(Garbage::Sample(old));
                }
            }
            RtCommand::ClearPadSample { track, pad } => {
                if let Some(old) = engine.take_pad_sample(track, pad) {
                    self.discard(Garbage::Sample(old));
                }
            }
            RtCommand::SetKeys { track, settings } => {
                engine.set_track_keys_settings(track, settings)
            }
            RtCommand::SetKeysSample { track, sample } => {
                if let Some(old) = engine.swap_keys_sample(track, sample) {
                    self.discard(Garbage::Sample(old));
                }
            }
            RtCommand::InsertEffect {
                chain,
                index,
                effect,
            } => {
                // A chain that is full, or a Track that has gone, hands it
                // straight back.
                if let Err(effect) = engine.insert_prepared_effect(chain, index, effect) {
                    self.discard(Garbage::Effect(effect));
                }
            }
            RtCommand::RemoveEffect { chain, index } => {
                if let Some(effect) = engine.take_effect(chain, index) {
                    self.discard(Garbage::Effect(effect));
                }
            }
            RtCommand::MoveEffect { chain, from, to } => engine.move_effect(chain, from, to),
            RtCommand::SetEffectBypassed {
                chain,
                index,
                bypassed,
            } => engine.set_effect_bypassed(chain, index, bypassed),
            RtCommand::SetEffectSettings {
                chain,
                index,
                settings,
            } => engine.set_effect_settings(chain, index, settings.as_slice()),
            RtCommand::SetInstrumentSettings { track, settings } => {
                engine.set_track_instrument_settings(track, settings.as_slice())
            }
            RtCommand::SetTrackAudio { track, audio } => engine.set_track_audio(track, audio),
            RtCommand::SetTrackMonitoring { track, on } => engine.set_track_monitoring(track, on),
            RtCommand::SetMonitor(feed) => {
                if let Some(old) = std::mem::replace(&mut self.monitor, feed) {
                    self.discard(Garbage::Monitor(old));
                }
            }
            RtCommand::SetAudioClips { track, clips } => {
                let old = engine.swap_track_audio_clips(track, clips);
                self.discard(Garbage::AudioClips(old));
            }
            RtCommand::SetLatencyTest(on) => engine.set_latency_test(on),
            RtCommand::SetLiveTrack(track) => engine.set_live_track(track),
            RtCommand::SetRecording(on) => engine.set_recording(on),
            RtCommand::Play => engine.play(),
            RtCommand::Stop => engine.stop(),
            RtCommand::Seek(tick) => engine.seek(tick),
            RtCommand::SetTempo(bpm) => engine.set_tempo(bpm),
            RtCommand::SetTimeSignature {
                beats_per_bar,
                beat_unit,
            } => engine.set_time_signature(beats_per_bar, beat_unit),
            RtCommand::SetTempoChanges(changes) => {
                let old = engine.swap_tempo_changes(changes);
                self.discard(Garbage::TempoChanges(old));
            }
            RtCommand::SetLoop {
                start,
                end,
                enabled,
            } => engine.set_loop(start, end, enabled),
            RtCommand::SetPlayRange { start, end } => engine.set_play_range(start, end),
            RtCommand::SetMetronome(on) => engine.set_metronome(on),
            RtCommand::Audition(file, gain) => {
                if let Some(old) = self.audition.play(file, gain) {
                    self.discard(Garbage::AudioFile(old));
                }
            }
            RtCommand::StopAudition => {
                if let Some(old) = self.audition.stop() {
                    self.discard(Garbage::AudioFile(old));
                }
            }
            RtCommand::DjInstall(dj) => {
                if let Some(back) = engine.install_dj(dj) {
                    self.discard(Garbage::DjMixer(back));
                }
            }
            RtCommand::DjLoad { deck, track } => {
                if let Some(old) = engine.swap_dj_track(deck, track) {
                    self.discard(Garbage::DjTrack(old));
                }
            }
            RtCommand::DjSet(control, value) => engine.dj_apply(control, value),
            RtCommand::SetHeadphones(ring) => {
                if let Some(old) = std::mem::replace(&mut self.headphones, ring) {
                    self.discard(Garbage::Headphones(old));
                }
            }
        }
    }

    /// Hand `garbage` back to be freed off this thread. The queue has room
    /// for everything that can be outstanding; if it is ever full anyway,
    /// leaking beats freeing memory in the audio callback.
    fn discard(&mut self, garbage: Garbage) {
        if let Err(rtrb::PushError::Full(garbage)) = self.garbage.push(garbage) {
            std::mem::forget(garbage);
        }
    }
}

#[cfg(test)]
mod tests;

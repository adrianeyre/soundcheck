/**
 * The seam between the UI and wherever the Audio Engine is actually running.
 *
 * Two implementations: the browser dev host (an AudioWorklet) and the
 * desktop app (the engine native on cpal, over Tauri IPC). The UI is the
 * same on both; `platform.ts` picks one.
 */

/** Something the UI asks the Audio Engine to do. */
export type EngineCommand =
  | { type: "noteOn"; note: number; velocity: number }
  | { type: "noteOff"; note: number }
  | { type: "setTrackCount"; count: number }
  /**
   * Replace the notes Track `track` plays: flat start, length (ticks), MIDI
   * pitch and velocity (0..=1) for each note.
   */
  | { type: "setTrackNotes"; track: number; notes: number[] }
  /**
   * Track `track`'s mixer channel: `volume` is a linear gain (1 is unity),
   * `pan` runs -1 (left) to 1 (right).
   */
  | { type: "setTrackMixer"; track: number; volume: number; pan: number; mute: boolean; solo: boolean }
  /** The Master fader, the same linear gain. */
  | { type: "setMasterVolume"; volume: number }
  /** Buses are numbered from 0 in Bus-list order, like Tracks. */
  | { type: "setBusCount"; count: number }
  | { type: "setBusMixer"; bus: number; volume: number; pan: number; mute: boolean; solo: boolean }
  /** `output` is a Bus's number, or -1 for the Master. */
  | { type: "setTrackOutput"; track: number; output: number }
  /** As `setTrackOutput`. The engine refuses a loop, leaving the routing as it was. */
  | { type: "setBusOutput"; bus: number; output: number }
  /**
   * A Track's or Bus's Sends: `channel` is a Track's index, or -2 - b for Bus
   * b, as chains number them. `sends` is flat, a Bus's number and a level for
   * each. The engine refuses a loop, leaving the Sends as they were.
   */
  | { type: "setSends"; channel: number; sends: number[] }
  /**
   * The Insert Chains. `chain` is a Track's index, or below zero for the
   * Master; `index` is a place in the chain, `from` and `to` too. `effect` is
   * one of `EFFECT_TYPES` ("eq", "compressor", … "utility"), and `settings` one number per
   * setting, in the order its settings table declares them
   * (`effectSettingsToFlat`).
   */
  | { type: "insertEffect"; chain: number; index: number; effect: string }
  | { type: "removeEffect"; chain: number; index: number }
  | { type: "moveEffect"; chain: number; from: number; to: number }
  | { type: "setEffectBypassed"; chain: number; index: number; bypassed: boolean }
  | { type: "setEffectSettings"; chain: number; index: number; settings: number[] }
  /**
   * WASM Plugins (ADR 0003). `loadPlugin` compiles an installed Plugin's
   * `.wasm` so slots can host it by its id; it is sent once, before the
   * first `insertPlugin` of it. `insertPlugin` adds a Plugin Effect at its
   * defaults, or, for a Plugin the engine hasn't loaded, holds its place,
   * passing audio through. Its settings then go by `setEffectSettings`, in
   * the order its manifest declares them.
   */
  | { type: "loadPlugin"; plugin: string; wasm: Uint8Array }
  | { type: "insertPlugin"; chain: number; index: number; plugin: string }
  /**
   * Make a Track's Instrument the Plugin Instrument `plugin`, loaded first
   * by `loadPlugin`, at its defaults; for a Plugin the engine hasn't loaded,
   * or one that isn't an Instrument, it holds its place and is silent. Its
   * settings then go by `setInstrumentSettings`, in the order its manifest
   * declares them.
   */
  | { type: "setTrackPlugin"; track: number; plugin: string }
  /**
   * VST3 Plugins (ADR 0008), which only the Desktop App hosts, each loaded
   * into a helper process as `instance` beforehand. The slot hosts that load
   * of it, `generation`; one not loaded, or loaded again since, holds its
   * place as a missing Plugin does. Their settings go as a WASM Plugin's.
   */
  | { type: "insertVst3"; chain: number; index: number; instance: string; generation: number }
  | { type: "setTrackVst3"; track: number; instance: string; generation: number }
  | { type: "setInstrumentSettings"; track: number; settings: number[] }
  /**
   * Change a Track's Synth: one number per setting, in the order the Synth's
   * settings table declares them (`synthSettingsToFlat`). `track` is below
   * zero for the live Track the keyboard plays.
   */
  | { type: "setSynthSettings"; track: number; settings: number[] }
  /**
   * "synth" or "drumSampler"; the Drum Sampler arrives with the bundled kit
   * on `pads` pads (8 to 16), filled from the kit as far as it reaches.
   * `pads` is null for an Instrument that has none.
   */
  | { type: "setTrackInstrument"; track: number; instrument: string; pads: number | null }
  /** One Drum Sampler pad, as plain numbers the engine can take as they are. */
  | {
      type: "setPad";
      track: number;
      pad: number;
      note: number;
      volume: number;
      pan: number;
      pitch: number;
      chokeGroup: number;
    }
  /**
   * Put the musician's own WAV on a pad. The bytes of the file, as plain
   * numbers: they cross a MessagePort in the browser and Tauri's JSON IPC on
   * the desktop, and a byte array survives both.
   */
  | { type: "setPadSample"; track: number; pad: number; wav: number[] }
  /**
   * Take the musician's own WAV off a pad, so that it plays the bundled
   * kit's own sample again — or nothing, on a pad past the kit's end. The
   * engine has no other way back to the kit's sound.
   */
  | { type: "clearPadSample"; track: number; pad: number }
  /** Make a Track an Audio Track, which plays Audio Clips and no Instrument. */
  | { type: "setTrackAudio"; track: number; audio: boolean }
  /**
   * An Audio Track's Input Monitoring: while on, the live input the platform
   * hands it (desktop only, while it is armed) plays through its Insert Chain.
   */
  | { type: "setTrackMonitoring"; track: number; on: boolean }
  /**
   * The bytes of a WAV, FLAC or MP3 file, as plain numbers, for Audio Clips
   * to play as file number `file`. The engine decodes it and converts it to
   * its own sample rate.
   */
  | { type: "loadAudioFile"; file: number; bytes: number[] }
  /** Let go of a file no Audio Clip plays any more. */
  | { type: "unloadAudioFile"; file: number }
  /**
   * An Audio Track's Clips, flat: start tick, length in ticks, file number
   * and seconds into the file for each.
   */
  | { type: "setTrackAudioClips"; track: number; clips: number[] }
  | { type: "setPatternPlaying"; playing: boolean }
  | { type: "setLatencyTest"; on: boolean }
  /**
   * Play live notes through this Instrument Track, or through the engine's
   * own Synth with null.
   */
  | { type: "setLiveTrack"; track: number | null }
  /** Log every live note played from now on, for recording into a Clip. */
  | { type: "setRecording"; on: boolean }
  | { type: "play" }
  | { type: "stop" }
  /** Positions and lengths are in ticks (`TICKS_PER_BEAT` to a quarter note). */
  | { type: "seek"; tick: number }
  | { type: "setTempo"; bpm: number }
  | { type: "setTimeSignature"; beatsPerBar: number; beatUnit: number }
  /** Flat tick, tempo, beats per bar and beat unit for each Tempo Change. */
  | { type: "setTempoChanges"; changes: number[] }
  /**
   * Flat tick, value and hold (1 or 0) for each breakpoint of a setting of a
   * Track (by index), the Master (-1) or a Bus (`busChain` of its index):
   * "volume", "pan", "send:<engine Bus>", "effect:<index in its Insert
   * Chain>:<setting>", "instrument:<Synth or Plugin setting>" or
   * "pad:<index in its kit>:<volume, pan or pitch>". None stops automating
   * it.
   */
  | { type: "setAutomation"; target: number; setting: string; points: number[] }
  | { type: "setLoop"; startTick: number; endTick: number; enabled: boolean }
  /**
   * Where Play stops, going back to `startTick`, while the loop is off: the
   * song's end, or the Section or ruler region chosen. An `endTick` at or
   * before `startTick` plays on for ever.
   */
  | { type: "setPlayRange"; startTick: number; endTick: number }
  | { type: "setMetronome"; on: boolean }
  /**
   * A control of the Mixer page's DJ Mixer (ADR 0013): `name` of a Deck or
   * a mixer channel (both by `index`, from 0) or of the mixer. Mirrors
   * `DjControl::parse` in `engine/src/dj/mod.rs`; switches are 1 or 0.
   */
  | { type: "djSet"; kind: DjControlKind; index: number; name: string; value: number };

export type DjControlKind = "deck" | "channel" | "mixer";

/**
 * What the engine found in a file loaded onto a Deck: `TrackAnalysis` in
 * `engine/src/dj/analysis.rs`. The waveform is flat, four numbers a point
 * (the lows', mids' and highs' peaks, and the whole signal's), `waveformRate`
 * points a second.
 */
export interface DjAnalysis {
  seconds: number;
  /** 0 when no steady beat was found. */
  bpm: number;
  /** Seconds into the file of the first beat of its Beat Grid. */
  firstBeat: number;
  /** The tonic's pitch class (0 is C), and whether the key is minor. */
  key: { tonic: number; minor: boolean } | null;
  waveformRate: number;
  waveform: number[];
}

/**
 * The DJ Mixer's side of an audio output (ADR 0013): what isn't a plain
 * command, because it carries a file or brings audio back.
 */
export interface DjHost {
  /** Decode and analyse `bytes` off the audio thread and put the file on Deck `deck`. */
  load(deck: number, bytes: Uint8Array): Promise<DjAnalysis>;
  unload(deck: number): void;
  /** The mix recorded since the last call, interleaved stereo at the output's rate. */
  takeRecording(): Promise<Float32Array>;
  /**
   * Whether the headphone cue is heard out of outputs 3 and 4, on an
   * interface that has them. A second device is `HeadphoneOutput`'s.
   */
  headphones: boolean;
  /** The headphone cue as a stream, for the browser to play to a second device; absent elsewhere. */
  headphoneStream?: () => MediaStream;
}

/**
 * A live note the Audio Engine recorded, stamped where it arrived: the
 * transport position at the start of the block it reached the engine in.
 * Mirrors `RecordedNoteEvent` in `desktop/src/command.rs`.
 */
export interface RecordedNoteEvent {
  /** The playback position, in ticks, when the note arrived. */
  tick: number;
  pitch: number;
  /** 0..=1, and 0 for a note-off. */
  velocity: number;
  /** A note-on; a note-off otherwise. */
  on: boolean;
}

/** What the Audio Engine reports about itself, a few times a second. */
export interface EngineReport {
  trackCount: number;
  activeVoices: number;
  playing: boolean;
  /** The playback position, in ticks. */
  position: number;
}

/**
 * The mixer's meters, as the engine measures them: the loudest sample each
 * channel has lately put into the mix, falling back from each peak. 1 is
 * full scale. One per engine Track, in Track order, plus the Master's, and
 * one per Bus, in Bus order.
 */
export interface Meters {
  master: number;
  tracks: number[];
  /** Absent from a host that reports none. */
  buses?: number[];
  /** Each Insert Chain's gain-reduction meters; absent from a host that reports none. */
  gainReduction?: GainReductionMeters;
}

/**
 * How far each Effect pulled the level down in the latest block, in dB (0
 * or more): one per Effect in chain order, 0 for an Effect that doesn't
 * reduce gain (only the Compressor does) or is bypassed. The Master's, then
 * one list per engine Track, in Track order, then one per Bus, in Bus order.
 */
export interface GainReductionMeters {
  master: number[];
  tracks: number[][];
  /** Absent from a host that reports none. */
  buses?: number[][];
}

/** Underruns as the platform itself counts them. Times are in seconds. */
export interface UnderrunStats {
  events: number;
  duration: number;
  averageLatency: number;
  minimumLatency: number;
  maximumLatency: number;
}

/** Callbacks the native host timed itself. */
export interface CallbackStats {
  callbacks: number;
  /** Callbacks whose render took longer than the audio it rendered lasts. */
  late: number;
  /** Seconds, the slowest render since the counters were reset. */
  slowestRender: number;
}

export interface AudioOutputStats {
  /** Where the engine is playing, e.g. "Browser AudioWorklet" or "WASAPI: Speakers". */
  host: string;
  sampleRate: number;
  /** Frames the engine renders per call: the buffer size actually granted. */
  blockFrames: number;
  /** The buffer size asked for, where the platform lets you choose one. */
  requestedBufferFrames: number | null;
  /** Seconds of latency the output adds before the device (baseLatency). */
  baseLatency: number;
  /** Seconds from the device to the speaker, where the platform reports it. */
  outputLatency: number | null;
  /**
   * Null when the platform doesn't report underruns. There is no fallback
   * estimate: watching the audio clock from the main thread proved to miss
   * most underruns under load and to count false ones on Windows.
   */
  underruns: UnderrunStats | null;
  /** Null in the browser, which can't time its own audio callback. */
  callbacks: CallbackStats | null;
  /** The latest report from the engine, or null before the first. */
  engine: EngineReport | null;
  /** The latest meters from the engine, or null before the first report. */
  meters: Meters | null;
  /**
   * The DJ Mixer's latest report (`DjMixer::report`), flat, or null before
   * the Mixer page is first used; absent from a host that has none.
   */
  dj?: number[] | null;
}

export type LatencyHint = "interactive" | "balanced" | "playback" | number;

export interface AudioOutputOptions {
  /** The browser's choice: a named category, or seconds. Ignored on desktop. */
  latencyHint?: LatencyHint;
  /** Frames per callback to ask the desktop's audio device for. */
  bufferFrames?: number;
  /** A desktop audio host, e.g. "WASAPI" or "ASIO"; the default otherwise. */
  host?: string;
  trackCount: number;
}

export interface AudioOutput {
  send(command: EngineCommand): void;
  stats(): AudioOutputStats;
  /** Seconds of audio played so far, for drawing a playhead. */
  currentTime(): number;
  /**
   * Every live note recorded since the last call, in the order played.
   * Both hosts hand these over with their reports, so a note played in the
   * last report's worth of audio arrives on the next call.
   */
  takeRecordedNotes(): RecordedNoteEvent[];
  /** Zero the dropout counters, e.g. once start-up is over. */
  resetCounters(): void;
  close(): Promise<void>;
  /** The Mixer page's DJ Mixer; absent from a host that has none, such as a test's. */
  dj?: DjHost;
}

export type OpenAudioOutput = (options: AudioOutputOptions) => Promise<AudioOutput>;

/**
 * The Project: one song, as plain, versioned data.
 *
 * Nothing here changes a Project. Every change goes through a command
 * (`commands.ts`), which the UI and the Assistant both use, and through
 * `ProjectHistory` (`history.ts`), which makes it undoable. Times are integer
 * ticks (`time.ts`) unless a name says otherwise.
 */
import {
  type BitcrusherSettings,
  type ChorusSettings,
  type CompressorSettings,
  type DelaySettings,
  defaultEffectSettings,
  EFFECT_TYPES,
  type EffectSettingsByType,
  type EqSettings,
  type FilterSettings,
  type GateSettings,
  type LimiterSettings,
  type PhaserSettings,
  type ReverbSettings,
  type SaturatorSettings,
  type UtilitySettings,
} from "../effect/effect-params";
import { defaultKeysSettings, type KeysSettings } from "../instrument/keys-params";
import { defaultSynthSettings, type SynthSettings } from "../instrument/synth-params";
import { type TempoMap, type TimeSignature, tickAfter } from "./time";

export type {
  BitcrusherSettings,
  ChorusSettings,
  CompressorSettings,
  DelaySettings,
  EqSettings,
  FilterSettings,
  GateSettings,
  LimiterSettings,
  PhaserSettings,
  ReverbSettings,
  SaturatorSettings,
  SynthSettings,
  UtilitySettings,
};

/** Bumped whenever the shape below changes; `serialise.ts` migrates old ones. */
export const SCHEMA_VERSION = 20;

export interface Project {
  schemaVersion: typeof SCHEMA_VERSION;
  name: string;
  /** Quarter notes per minute at the song's start. */
  tempo: number;
  /** The time signature at the song's start. */
  timeSignature: TimeSignature;
  /** In tick order, none at tick 0 (that is `tempo` and `timeSignature`). */
  tempoChanges: TempoChange[];
  /** In bar order, none overlapping. */
  sections: Section[];
  tracks: Track[];
  /** In the order the mixer shows them. */
  buses: Bus[];
  master: Master;
  /** The finished song the mix is compared against, or none. */
  referenceTrack: ReferenceTrack | null;
}

/**
 * A finished song the musician compares the mix against: an audio file
 * copied into the Project folder's `audio/`, as an Audio Clip's is, so the
 * folder is complete on its own. It is never in the mix, the meters or an
 * export: nothing sends it to the engine that plays or renders the song. It
 * is only auditioned, past the mixer, and measured for `compare_to_reference`.
 */
export interface ReferenceTrack {
  /** The audio file, relative to the Project folder. */
  file: string;
}

/**
 * An instant change of tempo, time signature or both, from `tick` on. A
 * `null` keeps what came before. A time signature changes only at a bar line,
 * and starts a new bar there.
 */
export interface TempoChange {
  id: string;
  tick: number;
  tempo: number | null;
  timeSignature: TimeSignature | null;
}

/**
 * A named part of the song, such as an intro, verse or chorus: `bars` whole
 * bars from bar `startBar`, counting from 1. It is kept in bars, not ticks, so
 * it stays on bar lines whatever the time signature does. It marks the song
 * and changes nothing heard.
 */
export interface Section {
  id: string;
  name: string;
  startBar: number;
  bars: number;
}

/**
 * A channel EQ: the gain of each of four bands, in dB from -12 to 12, 0
 * leaving it flat. The bands meet at 200 Hz, 1 kHz and 5 kHz, as the DJ
 * Mixer's do. It comes after the Insert Chain and before the fader.
 */
export interface ChannelEq {
  low: number;
  lowMid: number;
  highMid: number;
  high: number;
}

/** The bands of a channel EQ, low to high. */
export const EQ_BANDS = ["low", "lowMid", "highMid", "high"] as const satisfies readonly (keyof ChannelEq)[];

export type EqBand = (typeof EQ_BANDS)[number];

/** Every band at 0 dB: the EQ changes nothing. */
export const FLAT_EQ: Readonly<ChannelEq> = Object.freeze({ low: 0, lowMid: 0, highMid: 0, high: 0 });

/** A Track's or Bus's mixer channel. */
export interface Mixer {
  /** Linear gain: 1 is unity, 2 is +6 dB. */
  volume: number;
  /** -1 (left) to 1 (right). */
  pan: number;
  mute: boolean;
  solo: boolean;
  eq: ChannelEq;
}

/**
 * Where a Track or Bus sends its signal: a Bus, by id, or `null` for the
 * Master. A Bus never feeds itself, however indirectly.
 */
export type Output = string | null;

/**
 * A post-fader copy of a Track's or Bus's signal, fed to a Bus at a level.
 * A channel has at most one Send to each Bus, and Sends never make a loop.
 */
export interface Send {
  busId: string;
  /** Linear gain, like a fader: 1 is unity, 2 is +6 dB. */
  level: number;
}

/**
 * A mixer channel fed by Tracks and other Buses, with its own Insert Chain,
 * feeding the Master or another Bus. It holds no Clips.
 */
export interface Bus {
  id: string;
  name: string;
  mixer: Mixer;
  insertChain: Effect[];
  output: Output;
  /** In the order they were added. */
  sends: Send[];
  /** At most one per setting. */
  automation: Automation[];
}

/** The final mixer channel every Track and Bus ends up feeding. */
export interface Master {
  volume: number;
  eq: ChannelEq;
  insertChain: Effect[];
  /** Its volume, its EQ and its Effects' settings can be automated. */
  automation: Automation[];
}

interface TrackBase {
  id: string;
  name: string;
  mixer: Mixer;
  insertChain: Effect[];
  output: Output;
  /** In the order they were added. */
  sends: Send[];
  /** At most one per setting. */
  automation: Automation[];
}

/**
 * A setting Automation can move: a channel's volume or pan, a band of its
 * EQ (`eq:low`, `eq:lowMid`, `eq:highMid` or `eq:high`), its Send to a
 * Bus (`send:<busId>`), a numeric setting of one of its Effects
 * (`effect:<effectId>:<setting>`) or of its Instrument
 * (`instrument:<setting>`), a Drum Sampler Pad's by the note that plays it
 * (`instrument:pad<note>.volume`, `.pan` or `.pitch`). Mute, solo, bypass
 * and settings that pick from a list or switch on and off can't be
 * automated.
 */
export type AutomatedSetting =
  | "volume"
  | "pan"
  | `eq:${EqBand}`
  | `send:${string}`
  | `effect:${string}:${string}`
  | `instrument:${string}`;

/**
 * A setting's value at a tick. From one breakpoint to the next the value
 * ramps in a straight line, unless the first holds: then it keeps its value
 * and steps to the next's at the next's tick.
 */
export interface Breakpoint {
  tick: number;
  /** In the setting's own range: volume and a Send 0 to 2, pan -1 to 1. */
  value: number;
  hold: boolean;
}

/**
 * The breakpoints of one setting over time, drawn in an Automation Lane.
 * While the song plays it moves the setting and overrides its fixed value.
 * Before the first breakpoint the value is the first's; after the last, the
 * last's. Never empty: taking the last breakpoint away takes the Automation.
 */
export interface Automation {
  setting: AutomatedSetting;
  /** In tick order, at most one per tick. */
  breakpoints: Breakpoint[];
}

/**
 * An Audio Track's Input: which audio input device it records from, and
 * which of its channels, numbered from 0. One channel is mono, copied to
 * both sides of the take; two are its left and right.
 */
export interface TrackInput {
  /** The device's name, or null for the platform's default input. */
  device: string | null;
  /** Null for the device's first two, or its only one copied to both sides. */
  channels: [number] | [number, number] | null;
}

/** The Input a new Audio Track, and one from before Inputs, records from. */
export const DEFAULT_TRACK_INPUT: TrackInput = { device: null, channels: null };

export interface AudioTrack extends TrackBase {
  kind: "audio";
  input: TrackInput;
  /**
   * Input Monitoring: while the Track is armed, its live input plays
   * through its Insert Chain and the rest of the mix. Off for a new Track,
   * and never in an export or Audio Analysis.
   */
  monitoring: boolean;
  clips: AudioClip[];
}

export interface InstrumentTrack extends TrackBase {
  kind: "instrument";
  instrument: Instrument;
  clips: PatternClip[];
}

export type Track = AudioTrack | InstrumentTrack;

interface ClipBase {
  id: string;
  /** Where the Clip starts on its Track. */
  start: number;
}

/**
 * Audio plays at its natural speed whatever the tempo, so an Audio Clip's
 * length is in seconds and its length in ticks depends on the tempo map.
 */
export interface AudioClip extends ClipBase {
  kind: "audio";
  /** Seconds of the file the Clip plays. */
  duration: number;
  /** The audio file, relative to the Project folder. */
  file: string;
  /** Seconds into the file where the Clip starts playing. */
  fileOffset: number;
}

export interface PatternClip extends ClipBase {
  kind: "pattern";
  length: number;
  notes: Note[];
}

export type Clip = AudioClip | PatternClip;

/** Where a Clip ends, in ticks: fractional for an Audio Clip. */
export function clipEnd(clip: Clip, map: TempoMap): number {
  return clip.kind === "audio" ? tickAfter(map, clip.start, clip.duration) : clip.start + clip.length;
}

/** How long a Clip is, in ticks. */
export function clipLength(clip: Clip, map: TempoMap): number {
  return clipEnd(clip, map) - clip.start;
}

export interface Note {
  /** MIDI note number, 0 to 127. */
  pitch: number;
  /** From the start of its Clip. */
  start: number;
  length: number;
  /** 0 to 1. */
  velocity: number;
}

export interface DrumPad {
  /** What the musician sees on the pad, e.g. "Closed Hat". */
  name: string;
  /** The note that triggers it: the General MIDI drum map. */
  note: number;
  /**
   * A sample file relative to the Project folder, or none: the pad plays
   * the bundled kit's own sample, which ships with the app and is never
   * copied into a Project. A WAV the musician loads gets a path in the
   * folder's `audio/`, where saving the Project puts its bytes.
   */
  sample: string | null;
  /** Linear gain: 1 is unity, 2 is +6 dB. */
  volume: number;
  /** -1 (left) to 1 (right). */
  pan: number;
  /** Semitones, -24 to 24: how far the sample is transposed. */
  pitch: number;
  /** Pads sharing a group above 0 cut each other off; 0 is no choking. */
  chokeGroup: number;
}

export type Instrument =
  | { type: "synth"; preset: string | null; settings: SynthSettings }
  | { type: "drumSampler"; preset: string | null; pads: DrumPad[] }
  | KeysInstrument
  | PluginInstrument;

/**
 * The Keys: a modelled piano, played by one of its Presets' settings, or a
 * sample the musician loads, played at each key's pitch from `rootNote`.
 * `sample` is the file's path in the Project folder, as a pad's is, or null
 * for none; it is kept when the source goes back to the piano.
 */
export interface KeysInstrument {
  type: "keys";
  preset: string | null;
  settings: KeysSettings;
  sample: string | null;
}

/**
 * A WASM Plugin Instrument (ADR 0003), found by its id in the Plugins
 * folder. As a Plugin Effect's, its settings are the ones its manifest
 * declares, by name, and are kept exactly as they were while the Plugin is
 * missing.
 */
export interface PluginInstrument {
  type: "plugin";
  plugin: { id: string; version: string };
  settings: Record<string, number>;
  /** Only for a VST3 Plugin, whose id is `vst3.<class id>`. */
  vst3?: Vst3Part;
}

/**
 * What a VST3 Plugin (ADR 0008) keeps in the Project beside its id and
 * settings: its name and vendor, to say what is missing where it isn't
 * installed, and its state as the Plugin gave it. Its settings are its
 * automatable ones, by `p<ParamID>`, as normalised values from 0 to 1.
 */
export interface Vst3Part {
  name: string;
  vendor: string;
  /** Base64, each at most 16 MB once decoded. */
  state: { component: string; controller: string };
}

/** The prefix of a VST3 Plugin's id, before its class id in lower case. */
export const VST3_ID_PREFIX = "vst3.";

/** Whether a Plugin id names a VST3 Plugin rather than a WASM one. */
export function isVst3Id(id: string): boolean {
  return id.startsWith(VST3_ID_PREFIX);
}

interface EffectBase {
  id: string;
  bypassed: boolean;
}

/** One of the Audio Engine's own Effects, with the settings its kind keeps. */
export type BuiltInEffect = {
  [T in keyof EffectSettingsByType]: EffectBase & { type: T; settings: EffectSettingsByType[T] };
}[keyof EffectSettingsByType];

export type EffectType = BuiltInEffect["type"];

/**
 * A WASM Plugin Effect (ADR 0003), found by its id in the Plugins folder.
 * Its settings are the ones its manifest declares, by name; when the Plugin
 * is missing they are kept exactly as they were, to be heard again once it
 * is installed.
 */
export interface PluginEffect extends EffectBase {
  type: "plugin";
  plugin: { id: string; version: string };
  settings: Record<string, number>;
  /** Only for a VST3 Plugin, whose id is `vst3.<class id>`. */
  vst3?: Vst3Part;
}

export type Effect = BuiltInEffect | PluginEffect;

// Defaults match the Audio Engine's.

/** Its EQ is `FLAT_EQ` itself, frozen: a new channel takes a copy. */
export const DEFAULT_MIXER: Mixer = { volume: 1, pan: 0, mute: false, solo: false, eq: FLAT_EQ };

/** The Synth's defaults, as its settings table declares them. */
export const DEFAULT_SYNTH: SynthSettings = defaultSynthSettings();

/**
 * The bundled starter kit, pad for pad as the Audio Engine has it (its
 * `starter_kit()` says so, and a test checks the two agree). The three
 * hi-hats share choke group 1, so closing the hat cuts the open one off.
 *
 * The first eight are the kit as it first shipped, in their first order, and
 * the rest follow by note: a pad plays the kit's sample at its own index until
 * a sample is loaded over it, so a Project saved with those eight hears the
 * same sounds it always did.
 */
export const STARTER_KIT: readonly DrumPad[] = [
  drumPad("Kick", 36),
  drumPad("Snare", 38),
  drumPad("Clap", 39),
  drumPad("Closed Hat", 42, 1),
  drumPad("Open Hat", 46, 1),
  drumPad("Low Tom", 45),
  drumPad("High Tom", 48),
  drumPad("Cowbell", 56),
  drumPad("Hard Kick", 35),
  drumPad("Rimshot", 37),
  drumPad("Electric Snare", 40),
  drumPad("Low Floor Tom", 41),
  drumPad("Pedal Hat", 44, 1),
  drumPad("Mid Tom", 47),
  drumPad("Crash", 49),
  drumPad("Ride", 51),
  drumPad("Tambourine", 54),
  drumPad("Splash", 55),
  drumPad("Hi Conga", 62),
  drumPad("Low Conga", 64),
  drumPad("Maracas", 70),
  drumPad("Claves", 75),
];

/**
 * The starter kit as it was before it grew past eight pads: what a schema 1
 * Project, whose pads held only a sample and a volume, was playing.
 */
export const FIRST_STARTER_KIT: readonly DrumPad[] = STARTER_KIT.slice(0, 8);

/**
 * The Pad a Drum Sampler gains next, after `pads`: the Starter Kit's Pad at
 * that position, which is the kit sound an unloaded Pad there plays, or past
 * the kit's end an empty "Pad N", silent until a sample is loaded onto it.
 * Either answers a note no other Pad has: its own, or else the lowest one
 * free above the kit's.
 */
export function nextDrumPad(pads: readonly DrumPad[]): DrumPad {
  const taken = new Set(pads.map((pad) => pad.note));
  const kit = STARTER_KIT[pads.length];
  const pad = kit ? { ...kit } : drumPad(`Pad ${pads.length + 1}`, 0);
  if (kit && !taken.has(kit.note)) return pad;
  const afterTheKit = Math.max(...STARTER_KIT.map((candidate) => candidate.note)) + 1;
  // Up from the kit's highest note, then down from it: a Drum Sampler holds
  // far fewer Pads than there are notes, so one is always free.
  for (let note = afterTheKit; note <= 127; note++) if (!taken.has(note)) return { ...pad, note };
  for (let note = afterTheKit - 1; note >= 0; note--) if (!taken.has(note)) return { ...pad, note };
  return pad;
}

function drumPad(name: string, note: number, chokeGroup = 0): DrumPad {
  return { name, note, sample: null, volume: 1, pan: 0, pitch: 0, chokeGroup };
}

/** Each Effect's defaults, as its settings table declares them. */
export const DEFAULT_EFFECT_SETTINGS = Object.fromEntries(EFFECT_TYPES.map((type) => [type, defaultEffectSettings(type)])) as {
  readonly [T in EffectType]: EffectSettingsByType[T];
};

/** The preset name a Track loaded with the bundled kit carries. */
export const STARTER_KIT_PRESET = "Starter Kit";

/** Where `newId` takes its ids from: fresh ones, unless `withIds` says otherwise. */
let idSource: () => string = () => crypto.randomUUID();

/** A fresh id for a Track, Bus, Clip, Effect, Tempo Change or Section. */
export function newId(): string {
  return idSource();
}

/**
 * Run `work` with every id `newId` gives taken from `source`, so a tool
 * call worked out again can make the ids it made the first time. `work`
 * must be synchronous: the ids go back to fresh ones when it returns.
 */
export function withIds<T>(source: () => string, work: () => T): T {
  const before = idSource;
  idSource = source;
  try {
    return work();
  } finally {
    idSource = before;
  }
}

export function createProject(name = "Untitled"): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    tempo: 120,
    timeSignature: { beatsPerBar: 4, beatUnit: 4 },
    tempoChanges: [],
    sections: [],
    tracks: [],
    buses: [],
    master: { volume: 1, eq: { ...FLAT_EQ }, insertChain: [], automation: [] },
    referenceTrack: null,
  };
}

export function createInstrumentTrack(name: string, id = newId()): InstrumentTrack {
  return {
    id,
    kind: "instrument",
    name,
    mixer: { ...DEFAULT_MIXER, eq: { ...FLAT_EQ } },
    insertChain: [],
    output: null,
    sends: [],
    automation: [],
    instrument: { type: "synth", preset: null, settings: { ...DEFAULT_SYNTH } },
    clips: [],
  };
}

/**
 * The three kinds of Track as the musician tells them apart, each drawn in a
 * colour of its own: an Instrument Track, one playing the Drum Sampler (a
 * Drum Track), and an Audio Track.
 */
export type TrackKind = "instrument" | "drum" | "audio";

export const TRACK_KIND_NAMES: Record<TrackKind, string> = {
  instrument: "Instrument Track",
  drum: "Drum Track",
  audio: "Audio Track",
};

export function trackKind(track: Track): TrackKind {
  if (track.kind === "audio") return "audio";
  return track.instrument.type === "drumSampler" ? "drum" : "instrument";
}

/** An Instrument Track playing the Keys, with the default piano. */
export function createKeysTrack(name: string, id = newId(), preset: { name: string; settings: KeysSettings } | null = null): InstrumentTrack {
  return {
    ...createInstrumentTrack(name, id),
    instrument: { type: "keys", preset: preset?.name ?? null, settings: { ...(preset?.settings ?? defaultKeysSettings()) }, sample: null },
  };
}

/** An Instrument Track playing the Drum Sampler, loaded with the starter kit. */
export function createDrumTrack(name: string, id = newId()): InstrumentTrack {
  return {
    ...createInstrumentTrack(name, id),
    instrument: {
      type: "drumSampler",
      preset: STARTER_KIT_PRESET,
      pads: STARTER_KIT.map((pad) => ({ ...pad })),
    },
  };
}

export function createAudioTrack(name: string, id = newId()): AudioTrack {
  return {
    id,
    kind: "audio",
    name,
    input: { ...DEFAULT_TRACK_INPUT },
    monitoring: false,
    mixer: { ...DEFAULT_MIXER, eq: { ...FLAT_EQ } },
    insertChain: [],
    output: null,
    sends: [],
    automation: [],
    clips: [],
  };
}

/** A Bus at unity, with no Effects, feeding the Master. */
export function createBus(name: string, id = newId()): Bus {
  return {
    id,
    name,
    mixer: { ...DEFAULT_MIXER, eq: { ...FLAT_EQ } },
    insertChain: [],
    output: null,
    sends: [],
    automation: [],
  };
}

export function createEffect<T extends EffectType>(type: T, id = newId()): Extract<BuiltInEffect, { type: T }> {
  return { id, type, bypassed: false, settings: { ...DEFAULT_EFFECT_SETTINGS[type] } } as Extract<BuiltInEffect, { type: T }>;
}

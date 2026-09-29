/**
 * Keeps the Audio Engine playing what the Project says: one engine Track per
 * Track, in Track-list order. An Instrument Track is given its Instrument,
 * the notes of its Pattern Clips laid out in song time, and either the
 * Synth's settings or, for a Drum Sampler, its pads and the bytes of any WAV
 * loaded onto one. An Audio Track is given its Audio Clips, and the bytes of
 * each file they play, once however many Clips play it. Every Track gets its
 * mixer channel, its Sends and its Insert Chain, and the Project its tempo map (the
 * starting tempo and time signature, then each Tempo Change), and the
 * Master's volume, EQ and Insert Chain.
 *
 * Replacing a Track's notes or its Instrument releases whatever it is
 * sounding, so only what actually changed is sent.
 */
import type { EngineCommand } from "../audio/audio-output";
import { effectFlat, pluginManifestOf } from "../effect/effect-table";
import { instrumentManifestOf, isMissingInstrument, pluginInstrumentFlat } from "../instrument/instrument-table";
import { installedPlugin } from "../plugin/plugins";
import { vst3Generation, vst3InstrumentKey } from "../plugin/vst3";
import { keysSettingsToFlat } from "../instrument/keys-params";
import { synthSettingsToFlat } from "../instrument/synth-params";
import { parsePadSetting, parseSetting } from "./automation";
import {
  type ChannelEq,
  DEFAULT_MIXER,
  EQ_BANDS,
  FLAT_EQ,
  type AudioTrack,
  type Automation,
  type DrumPad,
  type Effect,
  type Instrument,
  type InstrumentTrack,
  type Mixer,
  type Project,
  type Send,
} from "./model";
import { tempoMapOf } from "./time";
import { busChain } from "../audio/gain-reduction";

/**
 * An audio file held in memory because the engine takes bytes and not paths
 * (ADR 0001): a WAV loaded onto a pad, or the file an Audio Clip plays,
 * whether it was just read from the musician's own file or from the Project
 * folder's `audio/`. The object's identity says which file it is, so
 * re-reading the same file loads it again.
 */
export interface LoadedSample {
  /** The file's name, for the pad to show. */
  name: string;
  /** The bytes of the file. */
  bytes: number[];
}

/**
 * The audio in memory, by the path a pad or an Audio Clip names it with,
 * relative to the Project folder: one entry however many play it.
 */
export type LoadedSamples = ReadonlyMap<string, LoadedSample>;

/**
 * A Track's notes as the engine takes them: flat start, length, pitch and
 * velocity for each, in ticks from the start of the song. A Clip is a window
 * onto its notes, so a note that runs past its Clip's end is cut there.
 */
export function trackNotes(track: InstrumentTrack): number[] {
  const flat: number[] = [];
  for (const clip of track.clips) {
    for (const note of clip.notes) {
      const length = Math.min(note.length, clip.length - note.start);
      if (length <= 0) continue;
      flat.push(clip.start + note.start, length, note.pitch, note.velocity);
    }
  }
  return flat;
}

/**
 * A Project's Tempo Changes as the engine takes them: flat tick, tempo, beats
 * per bar and beat unit for each, with what a change leaves alone filled in
 * from the one before it.
 */
export function tempoChangesToFlat(project: Project): number[] {
  return tempoMapOf(project)
    .segments.slice(1)
    .flatMap((s) => [s.tick, s.tempo, s.timeSignature.beatsPerBar, s.timeSignature.beatUnit]);
}

/**
 * An Audio Track's Clips as the engine takes them: flat start tick, seconds
 * long, file number and seconds into the file for each, leaving out any Clip whose file
 * isn't in memory. `fileNumber` gives each file the engine's number for it.
 */
export function trackAudioClips(
  track: AudioTrack,
  samples: LoadedSamples,
  fileNumber: (file: LoadedSample) => number,
): number[] {
  const flat: number[] = [];
  for (const clip of track.clips) {
    const loaded = samples.get(clip.file);
    if (!loaded || clip.duration <= 0) continue;
    flat.push(clip.start, clip.duration, fileNumber(loaded), clip.fileOffset);
  }
  return flat;
}

export function instrumentTracks(project: Project): InstrumentTrack[] {
  return project.tracks.filter((track): track is InstrumentTrack => track.kind === "instrument");
}

/**
 * A Track's Synth settings as the engine takes them, or null for a Track
 * whose Instrument isn't the Synth: one number per declared setting.
 */
export function trackSynth(track: InstrumentTrack): number[] | null {
  const instrument = track.instrument;
  return instrument.type === "synth" ? synthSettingsToFlat(instrument.settings) : null;
}

/** The pads of a Drum Sampler Track, or none for any other Instrument. */
function trackPads(track: InstrumentTrack): readonly DrumPad[] {
  return track.instrument.type === "drumSampler" ? track.instrument.pads : [];
}

/** What one engine Track was last told. */
interface Sent {
  /** Whether it is playing an Audio Track. */
  audio: boolean;
  /** Its Audio Clips, flat. */
  clips: number[];
  /** Whether an Audio Track's Input Monitoring is on. */
  monitoring: boolean;
  instrument: string;
  /** The Synth's settings, flat, or null for any other Instrument. */
  synth: number[] | null;
  /** An installed Plugin Instrument's settings, flat, or null for any other Instrument. */
  plugin: number[] | null;
  /** The Keys' settings, flat, or null for any other Instrument. */
  keys: number[] | null;
  /** The sample the Keys were last sent, by identity, or null for none. */
  keysSample: LoadedSample | null;
  pads: DrumPad[];
  /** The sample last sent for each pad, by identity, or null for none. */
  samples: (LoadedSample | null)[];
  notes: number[];
  mixer: Mixer;
  chain: SentEffect[];
  /** The engine Bus it feeds, or `MASTER` for the Master. */
  output: number;
  /** Its Sends, flat: an engine Bus and a level for each. */
  sends: number[];
  automation: SentAutomation;
}

/**
 * Each setting's breakpoints as last sent, flat, as JSON, by the engine's
 * name for the setting; a setting that isn't there was never automated or
 * was sent none.
 */
type SentAutomation = Record<string, string>;

/** Flat tick, value and hold (1 or 0) for each breakpoint. */
function automationToFlat(lane: Automation): number[] {
  return lane.breakpoints.flatMap((point) => [point.tick, point.value, point.hold ? 1 : 0]);
}

/**
 * A channel's own Automation (not its Effects') by the engine's name for
 * each setting: a Send by the engine's number for its Bus, and a Drum
 * Sampler Pad's setting as `pad:<index>:<setting>`, by where the Pad is in
 * `pads`.
 */
function channelAutomation(
  automation: readonly Automation[],
  busIndex: ReadonlyMap<string, number>,
  pads: readonly DrumPad[] = [],
): Map<string, number[]> {
  const wanted = new Map<string, number[]>();
  for (const lane of automation) {
    const parsed = parseSetting(lane.setting);
    if (!parsed || parsed.kind === "effect") continue;
    const pad = parsed.kind === "instrument" ? parsePadSetting(parsed.param) : undefined;
    if (pad) {
      const index = pads.findIndex((candidate) => candidate.note === pad.note);
      if (index >= 0) wanted.set(`pad:${index}:${pad.param}`, automationToFlat(lane));
    } else if (parsed.kind !== "send") wanted.set(lane.setting, automationToFlat(lane));
    else if (busIndex.has(parsed.busId)) wanted.set(`send:${busIndex.get(parsed.busId)}`, automationToFlat(lane));
  }
  return wanted;
}

/**
 * Bring what the engine automates for `target` up to date: `wanted` holds
 * every setting that should be automated, and any other it was sent is
 * sent none.
 */
function updateAutomation(target: number, sent: SentAutomation, wanted: ReadonlyMap<string, number[]>): EngineCommand[] {
  const commands: EngineCommand[] = [];
  for (const setting of new Set([...Object.keys(sent), ...wanted.keys()])) {
    const points = wanted.get(setting) ?? [];
    const key = JSON.stringify(points);
    if (key === (sent[setting] ?? "[]")) continue;
    if (points.length === 0) delete sent[setting];
    else sent[setting] = key;
    commands.push({ type: "setAutomation", target, setting, points });
  }
  return commands;
}

/** What one engine Bus was last told. */
interface SentBus {
  mixer: Mixer;
  chain: SentEffect[];
  /** The engine Bus it feeds, or `MASTER` for the Master. */
  output: number;
  /** Its Sends, flat: an engine Bus and a level for each. */
  sends: number[];
  automation: SentAutomation;
}

/** The engine's number for the Master as an output. */
const MASTER = -1;

/** An Effect in one of the engine's Insert Chains, as it was last told. */
interface SentEffect {
  id: string;
  /** What the engine hosts in the slot: see `slotKind`. */
  kind: string;
  bypassed: boolean;
  /** Its settings, flat, or null until they are first sent. */
  settings: number[] | null;
  /** By setting name: its Automation lives on it, and moves with it. */
  automation: SentAutomation;
}

/**
 * An engine Track as it is the moment it appears: a Synth with the default
 * sound, playing nothing, its mixer channel at unity.
 */
function fresh(instrument = "synth"): Sent {
  return {
    audio: false,
    clips: [],
    monitoring: false,
    instrument,
    synth: null,
    plugin: null,
    keys: null,
    keysSample: null,
    pads: [],
    samples: [],
    notes: [],
    mixer: { ...DEFAULT_MIXER },
    chain: [],
    output: MASTER,
    sends: [],
    automation: {},
  };
}

/** An engine Bus as it is the moment it appears: at unity, feeding the Master. */
function freshBus(): SentBus {
  return { mixer: { ...DEFAULT_MIXER }, chain: [], output: MASTER, sends: [], automation: {} };
}

/** Remembers what the engine was last told, and works out what's changed. */
export class EngineSync {
  #sent: Sent[] = [];
  #tempo: number | null = null;
  #signature: string | null = null;
  #tempoChanges = "[]";
  #masterVolume: number | null = null;
  /** The engine's Master starts flat. */
  #masterEq: ChannelEq = { ...FLAT_EQ };
  #masterChain: SentEffect[] = [];
  #masterAutomation: SentAutomation = {};
  #buses: SentBus[] = [];
  /** The engine's number for each audio file it has loaded for Clips. */
  #files = new Map<LoadedSample, number>();
  #nextFile = 1;
  /** The `.wasm` the engine has loaded for each Plugin, by its id. */
  #plugins: LoadedPlugins = new Map();

  /**
   * The commands that bring the engine from its last state to `project`,
   * with `samples` holding the WAVs the musician has loaded onto pads.
   */
  update(project: Project, samples: LoadedSamples = new Map()): EngineCommand[] {
    const commands: EngineCommand[] = [];
    if (project.tempo !== this.#tempo) {
      this.#tempo = project.tempo;
      commands.push({ type: "setTempo", bpm: project.tempo });
    }
    const signature = `${project.timeSignature.beatsPerBar}/${project.timeSignature.beatUnit}`;
    if (signature !== this.#signature) {
      this.#signature = signature;
      commands.push({ type: "setTimeSignature", ...project.timeSignature });
    }
    const tempoChanges = tempoChangesToFlat(project);
    if (JSON.stringify(tempoChanges) !== this.#tempoChanges) {
      this.#tempoChanges = JSON.stringify(tempoChanges);
      commands.push({ type: "setTempoChanges", changes: tempoChanges });
    }

    if (project.master.volume !== this.#masterVolume) {
      this.#masterVolume = project.master.volume;
      commands.push({ type: "setMasterVolume", volume: project.master.volume });
    }
    if (!sameEq(this.#masterEq, project.master.eq)) {
      this.#masterEq = { ...project.master.eq };
      commands.push({ type: "setChannelEq", chain: MASTER_CHAIN, ...project.master.eq });
    }
    const busIndex = new Map(project.buses.map((bus, index) => [bus.id, index]));
    commands.push(...updateChain(this.#plugins, MASTER_CHAIN, this.#masterChain, project.master.insertChain, project.master.automation));
    commands.push(
      ...updateAutomation(MASTER, this.#masterAutomation, channelAutomation(project.master.automation, busIndex)),
    );

    // The Buses come before the Tracks, so every Bus a Track feeds exists.
    const outputOf = (output: string | null) => (output === null ? MASTER : (busIndex.get(output) ?? MASTER));
    const sendsOf = (sends: readonly Send[]) =>
      sends.flatMap((send) => {
        const bus = busIndex.get(send.busId);
        return bus === undefined ? [] : [bus, send.level];
      });
    commands.push(...this.#updateBuses(project, outputOf, sendsOf, busIndex));

    const tracks = project.tracks;
    if (tracks.length !== this.#sent.length) {
      commands.push({ type: "setTrackCount", count: tracks.length });
      // A new engine Track starts as a Synth playing nothing.
      this.#sent.length = Math.min(this.#sent.length, tracks.length);
    }
    const used = new Set<LoadedSample>();
    const fileNumber = (file: LoadedSample): number => {
      used.add(file);
      let number = this.#files.get(file);
      if (number === undefined) {
        number = this.#nextFile++;
        this.#files.set(file, number);
        commands.push({ type: "loadAudioFile", file: number, bytes: file.bytes });
      }
      return number;
    };
    tracks.forEach((track, index) => {
      commands.push(
        ...(track.kind === "audio"
          ? this.#updateAudioTrack(track, index, samples, fileNumber)
          : this.#updateTrack(track, index, samples)),
      );
      const sent = this.#sent[index]!;
      const output = outputOf(track.output);
      if (sent.output !== output) {
        commands.push({ type: "setTrackOutput", track: index, output });
        sent.output = output;
      }
      const sends = sendsOf(track.sends);
      if (!sameNumbers(sent.sends, sends)) {
        commands.push({ type: "setSends", channel: index, sends });
        sent.sends = sends;
      }
      const pads = track.kind === "instrument" ? trackPads(track) : [];
      commands.push(...updateAutomation(index, sent.automation, channelAutomation(track.automation, busIndex, pads)));
    });
    // A file no Clip plays any more is let go of, after the Clips that
    // played it have been replaced.
    for (const [file, number] of this.#files) {
      if (used.has(file)) continue;
      this.#files.delete(file);
      commands.push({ type: "unloadAudioFile", file: number });
    }
    return commands;
  }

  #updateBuses(
    project: Project,
    outputOf: (output: string | null) => number,
    sendsOf: (sends: readonly Send[]) => number[],
    busIndex: ReadonlyMap<string, number>,
  ): EngineCommand[] {
    const commands: EngineCommand[] = [];
    const buses = project.buses;
    if (buses.length !== this.#buses.length) {
      commands.push({ type: "setBusCount", count: buses.length });
      if (buses.length < this.#buses.length) {
        this.#buses.length = buses.length;
        // The engine sends whatever fed a Bus it lets go of to the Master.
        // Sends to it are dropped.
        for (const sent of [...this.#sent, ...this.#buses]) {
          if (sent.output >= buses.length) sent.output = MASTER;
          sent.sends = sent.sends.filter((_, at, flat) => flat[at - (at % 2)]! < buses.length);
        }
      }
      while (this.#buses.length < buses.length) this.#buses.push(freshBus());
    }
    buses.forEach((bus, index) => {
      const sent = this.#buses[index]!;
      commands.push(...mixerCommands({ bus: index }, sent.mixer, bus.mixer));
      sent.mixer = copyMixer(bus.mixer);
      commands.push(...updateChain(this.#plugins, busChain(index), sent.chain, bus.insertChain, bus.automation));
    });
    // The engine refuses a loop even for a moment, so every Bus whose output
    // changes is first sent to the Master, and every Bus whose Sends change
    // loses them, before any goes on to where it goes. What is left is part
    // of the Project's routing, and so is each step after it, and the
    // Project's routing has no loop.
    const moving = buses.flatMap((bus, index) => {
      const output = outputOf(bus.output);
      return this.#buses[index]!.output === output ? [] : [{ index, output }];
    });
    const resending = buses.flatMap((bus, index) => {
      const sends = sendsOf(bus.sends);
      return sameNumbers(this.#buses[index]!.sends, sends) ? [] : [{ index, sends }];
    });
    for (const { index } of moving) {
      const sent = this.#buses[index]!;
      if (sent.output === MASTER) continue;
      commands.push({ type: "setBusOutput", bus: index, output: MASTER });
      sent.output = MASTER;
    }
    for (const { index } of resending) {
      const sent = this.#buses[index]!;
      if (sent.sends.length === 0) continue;
      commands.push({ type: "setSends", channel: busChain(index), sends: [] });
      sent.sends = [];
    }
    for (const { index, output } of moving) {
      if (output === MASTER) continue;
      commands.push({ type: "setBusOutput", bus: index, output });
      this.#buses[index]!.output = output;
    }
    for (const { index, sends } of resending) {
      if (sends.length === 0) continue;
      commands.push({ type: "setSends", channel: busChain(index), sends });
      this.#buses[index]!.sends = sends;
    }
    // After the Sends, so each automated Send is there to follow it.
    buses.forEach((bus, index) => {
      const sent = this.#buses[index]!;
      commands.push(...updateAutomation(busChain(index), sent.automation, channelAutomation(bus.automation, busIndex)));
    });
    return commands;
  }

  #updateAudioTrack(
    track: AudioTrack,
    index: number,
    samples: LoadedSamples,
    fileNumber: (file: LoadedSample) => number,
  ): EngineCommand[] {
    const commands: EngineCommand[] = [];
    let sent = this.#sent[index] ?? fresh();
    if (!sent.audio) {
      // What an Instrument Track left in this slot is cleared first, so that
      // it is a plain Synth playing nothing again if an Instrument Track
      // takes the slot back.
      if (sent.instrument !== "synth" || sent.pads.length > 0) {
        commands.push(...clearInstrumentAutomation(index, sent.automation));
        commands.push({ type: "setTrackInstrument", track: index, instrument: "synth", pads: null });
      }
      if (sent.notes.length > 0) commands.push({ type: "setTrackNotes", track: index, notes: [] });
      commands.push({ type: "setTrackAudio", track: index, audio: true });
      // The mixer channel and the Insert Chain are the engine Track's, not
      // the Instrument's, so they stay as they were.
      sent = { ...fresh(), audio: true, mixer: sent.mixer, chain: sent.chain, output: sent.output, sends: sent.sends, automation: sent.automation };
    }

    const clips = trackAudioClips(track, samples, fileNumber);
    if (!sameNumbers(sent.clips, clips)) commands.push({ type: "setTrackAudioClips", track: index, clips });
    const { monitoring } = track;
    if (monitoring !== sent.monitoring) commands.push({ type: "setTrackMonitoring", track: index, on: monitoring });

    const { mixer } = track;
    commands.push(...mixerCommands({ track: index }, sent.mixer, mixer));

    commands.push(...updateChain(this.#plugins, index, sent.chain, track.insertChain, track.automation));

    this.#sent[index] = { ...sent, clips, monitoring, mixer: copyMixer(mixer) };
    return commands;
  }

  #updateTrack(track: InstrumentTrack, index: number, samples: LoadedSamples): EngineCommand[] {
    const commands: EngineCommand[] = [];
    const instrument = instrumentKind(track.instrument, track.id);
    const pads = trackPads(track);
    let sent = this.#sent[index] ?? fresh();
    if (sent.audio) {
      // An Audio Track had this slot: its Clips go, and it plays notes again.
      if (sent.clips.length > 0) commands.push({ type: "setTrackAudioClips", track: index, clips: [] });
      if (sent.monitoring) commands.push({ type: "setTrackMonitoring", track: index, on: false });
      commands.push({ type: "setTrackAudio", track: index, audio: false });
      sent = { ...fresh(), mixer: sent.mixer, chain: sent.chain, output: sent.output, sends: sent.sends, automation: sent.automation };
    }
    // The engine builds the kit, so it is built at the size the Project
    // says: a kit that changes size is a new Instrument to it.
    if (instrument !== sent.instrument || pads.length !== sent.pads.length) {
      // A Plugin Instrument holds its own Automation and the Synth's is the
      // Track's, so what was automated is cleared while the old Instrument
      // is there to take it, and sent again to the new one.
      commands.push(...clearInstrumentAutomation(index, sent.automation));
      const vst3 = track.instrument.type === "plugin" ? vst3Generation(vst3InstrumentKey(track.id), track.instrument.plugin.id) : undefined;
      if (vst3 !== undefined) {
        commands.push({ type: "setTrackVst3", track: index, instance: vst3InstrumentKey(track.id), generation: vst3 });
      } else if (track.instrument.type === "plugin") {
        commands.push(...loadCommands(this.#plugins, track.instrument.plugin.id));
        commands.push({ type: "setTrackPlugin", track: index, plugin: track.instrument.plugin.id });
      } else {
        const count = instrument === "drumSampler" ? pads.length : null;
        commands.push({ type: "setTrackInstrument", track: index, instrument, pads: count });
      }
      // A new Instrument comes with the default Synth sound, or the bundled
      // kit on its pads and nothing loaded, so everything the Project says
      // about it is sent again. The mixer channel is the Track's, not the
      // Instrument's, and so is the Insert Chain, so they stay as they were.
      sent = { ...fresh(instrument), mixer: sent.mixer, chain: sent.chain, output: sent.output, sends: sent.sends, automation: sent.automation };
    }

    const synth = trackSynth(track);
    if (synth && !sameNumbers(sent.synth ?? [], synth)) {
      commands.push({ type: "setSynthSettings", track: index, settings: synth });
    }
    // A missing Plugin has nothing to take its settings: they are sent once
    // it is installed, and the slot rebuilt.
    const plugin = track.instrument.type === "plugin" && !isMissingInstrument(track.instrument) ? pluginInstrumentFlat(track.instrument) : null;
    if (plugin && (!sent.plugin || !sameNumbers(sent.plugin, plugin))) {
      commands.push({ type: "setInstrumentSettings", track: index, settings: plugin });
    }

    // The Keys' settings, and the sample they play across the keyboard.
    const keysInstrument = track.instrument.type === "keys" ? track.instrument : null;
    const keys = keysInstrument ? keysSettingsToFlat(keysInstrument.settings) : null;
    if (keys && !sameNumbers(sent.keys ?? [], keys)) commands.push({ type: "setKeysSettings", track: index, settings: keys });
    const keysSample = keysInstrument?.sample ? (samples.get(keysInstrument.sample) ?? null) : null;
    if (keysInstrument && keysSample !== sent.keysSample) {
      commands.push(keysSample ? { type: "setKeysSample", track: index, wav: keysSample.bytes } : { type: "clearKeysSample", track: index });
    }

    const sample = (pad: number): LoadedSample | null => {
      const path = pads[pad]?.sample;
      return (path ? samples.get(path) : null) ?? null;
    };
    pads.forEach((pad, padIndex) => {
      const before = sent.pads[padIndex];
      if (before && samePad(before, pad)) return;
      const { note, volume, pan, pitch, chokeGroup } = pad;
      commands.push({ type: "setPad", track: index, pad: padIndex, note, volume, pan, pitch, chokeGroup });
    });
    pads.forEach((_, padIndex) => {
      const loaded = sample(padIndex);
      if (loaded === (sent.samples[padIndex] ?? null)) return;
      // A pad whose sample goes — taken off, or the Track in this engine
      // Track's slot replaced by another — is told to go back to the kit's
      // own sound, which the engine has no other way back to.
      commands.push(
        loaded
          ? { type: "setPadSample", track: index, pad: padIndex, wav: loaded.bytes }
          : { type: "clearPadSample", track: index, pad: padIndex },
      );
    });

    const notes = trackNotes(track);
    if (!sameNumbers(sent.notes, notes)) {
      commands.push({ type: "setTrackNotes", track: index, notes });
    }

    const { mixer } = track;
    commands.push(...mixerCommands({ track: index }, sent.mixer, mixer));

    commands.push(...updateChain(this.#plugins, index, sent.chain, track.insertChain, track.automation));

    this.#sent[index] = {
      audio: false,
      clips: [],
      monitoring: false,
      instrument,
      synth,
      plugin,
      keys,
      keysSample,
      pads: pads.map((pad) => ({ ...pad })),
      samples: pads.map((_, padIndex) => sample(padIndex)),
      notes,
      mixer: copyMixer(mixer),
      chain: sent.chain,
      output: sent.output,
      sends: sent.sends,
      automation: sent.automation,
    };
    return commands;
  }
}

/**
 * The engine's name for the Master's Insert Chain; a Track's is its index,
 * and a Bus's is `busChain` of its index.
 */
const MASTER_CHAIN = -1;

/** The `.wasm` the engine has loaded for each Plugin, by its id. */
type LoadedPlugins = Map<string, Uint8Array>;

/**
 * What the engine hosts in an Effect's slot: a built-in by its type, a
 * Plugin by its id and the version installed, a VST3 Plugin by the load of
 * its instance, or the place of a Plugin this machine hasn't got (or hasn't
 * loaded yet). When it changes (the Plugin is installed, say, or a crashed
 * VST3 Plugin reloaded) the slot is rebuilt, so the Effect sounds right
 * again.
 */
function slotKind(effect: Effect): string {
  if (effect.type !== "plugin") return effect.type;
  const vst3 = vst3Generation(effect.id, effect.plugin.id);
  if (vst3 !== undefined) return `vst3:${effect.id}#${vst3}`;
  const manifest = pluginManifestOf(effect);
  return manifest ? `plugin:${effect.plugin.id}@${manifest.version}` : `missing:${effect.plugin.id}`;
}

/**
 * What the engine plays on an Instrument Track: a built-in by its type, a
 * Plugin Instrument by its id and the version installed, or the place of one
 * this machine hasn't got, as `slotKind` has an Effect's.
 */
function instrumentKind(instrument: Instrument, trackId: string): string {
  if (instrument.type !== "plugin") return instrument.type;
  const vst3 = vst3Generation(vst3InstrumentKey(trackId), instrument.plugin.id);
  if (vst3 !== undefined) return `vst3:${vst3InstrumentKey(trackId)}#${vst3}`;
  const manifest = instrumentManifestOf(instrument);
  return manifest ? `plugin:${instrument.plugin.id}@${manifest.version}` : `missing:${instrument.plugin.id}`;
}

/** Send no Automation for each Instrument setting (a Pad's too) `sent` has, and forget it was sent. */
function clearInstrumentAutomation(track: number, sent: SentAutomation): EngineCommand[] {
  const commands: EngineCommand[] = [];
  for (const setting of Object.keys(sent)) {
    if (!setting.startsWith("instrument:") && !setting.startsWith("pad:")) continue;
    commands.push({ type: "setAutomation", target: track, setting, points: [] });
    delete sent[setting];
  }
  return commands;
}

/** Load the installed Plugin `id`'s `.wasm`, unless the engine has this one already. */
function loadCommands(loaded: LoadedPlugins, id: string): EngineCommand[] {
  const installed = installedPlugin(id);
  if (!installed || loaded.get(id) === installed.wasm) return [];
  loaded.set(id, installed.wasm);
  return [{ type: "loadPlugin", plugin: id, wasm: installed.wasm }];
}

/**
 * The commands that insert `effect` at `index` in `chain`: a built-in by its
 * type, a Plugin by its id, loading its `.wasm` first if the engine hasn't
 * got this one, or a VST3 Plugin by its instance. The engine holds the place
 * of a Plugin it hasn't loaded, so a missing one passes audio through.
 */
function insertCommands(loaded: LoadedPlugins, chain: number, index: number, effect: Effect): EngineCommand[] {
  if (effect.type !== "plugin") return [{ type: "insertEffect", chain, index, effect: effect.type }];
  const vst3 = vst3Generation(effect.id, effect.plugin.id);
  if (vst3 !== undefined) return [{ type: "insertVst3", chain, index, instance: effect.id, generation: vst3 }];
  return [...loadCommands(loaded, effect.plugin.id), { type: "insertPlugin", chain, index, plugin: effect.plugin.id }];
}

/**
 * The commands that turn the Insert Chain the engine was last told about,
 * `sent`, into `effects`, updating `sent` to match as they go. Effects are
 * matched by id, so one that moves is moved, keeping its sound (a Reverb's
 * tail, say) and its Automation, rather than rebuilt. `automation` is the
 * owner's, of which each Effect's settings are sent to it by its index
 * once the chain is in order.
 */
function updateChain(
  plugins: LoadedPlugins,
  chain: number,
  sent: SentEffect[],
  effects: readonly Effect[],
  automation: readonly Automation[],
): EngineCommand[] {
  const commands: EngineCommand[] = [];
  const wanted = new Map(effects.map((effect) => [effect.id, slotKind(effect)]));
  // Take out what has gone, from the end so each index is still right.
  for (let index = sent.length - 1; index >= 0; index--) {
    const effect = sent[index]!;
    if (wanted.get(effect.id) === effect.kind) continue;
    commands.push({ type: "removeEffect", chain, index });
    sent.splice(index, 1);
  }
  effects.forEach((effect, index) => {
    if (sent[index]?.id !== effect.id) {
      const from = sent.findIndex((other) => other.id === effect.id);
      if (from >= 0) {
        commands.push({ type: "moveEffect", chain, from, to: index });
        sent.splice(index, 0, ...sent.splice(from, 1));
      } else {
        commands.push(...insertCommands(plugins, chain, index, effect));
        // A new Effect starts at its defaults and not bypassed; its settings
        // are sent anyway, so there is no need to know what the defaults are.
        sent.splice(index, 0, { id: effect.id, kind: wanted.get(effect.id)!, bypassed: false, settings: null, automation: {} });
      }
    }
    const current = sent[index]!;
    const settings = effectFlat(effect);
    if (!current.settings || !sameNumbers(current.settings, settings)) {
      commands.push({ type: "setEffectSettings", chain, index, settings });
      current.settings = settings;
    }
    if (current.bypassed !== effect.bypassed) {
      commands.push({ type: "setEffectBypassed", chain, index, bypassed: effect.bypassed });
      current.bypassed = effect.bypassed;
    }
  });
  effects.forEach((effect, index) => {
    const prefix = `effect:${effect.id}:`;
    const lanes = new Map(
      automation
        .filter((lane) => lane.setting.startsWith(prefix))
        .map((lane) => [lane.setting.slice(prefix.length), automationToFlat(lane)]),
    );
    const effectCommands = updateAutomation(chain, sent[index]!.automation, lanes);
    for (const command of effectCommands) {
      if (command.type === "setAutomation") command.setting = `effect:${index}:${command.setting}`;
    }
    commands.push(...effectCommands);
  });
  return commands;
}

function samePad(a: DrumPad, b: DrumPad): boolean {
  return (
    a.note === b.note &&
    a.volume === b.volume &&
    a.pan === b.pan &&
    a.pitch === b.pitch &&
    a.chokeGroup === b.chokeGroup
  );
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameMixer(a: Mixer, b: Mixer): boolean {
  return a.volume === b.volume && a.pan === b.pan && a.mute === b.mute && a.solo === b.solo;
}

function sameEq(a: ChannelEq, b: ChannelEq): boolean {
  return EQ_BANDS.every((band) => a[band] === b[band]);
}

function copyMixer(mixer: Mixer): Mixer {
  return { ...mixer, eq: { ...mixer.eq } };
}

/**
 * What brings a Track's or Bus's mixer channel from `sent` to `mixer`: its
 * fader, pan and buttons in one command, and its EQ in another, each only
 * when it changed.
 */
function mixerCommands(channel: { track: number } | { bus: number }, sent: Mixer, mixer: Mixer): EngineCommand[] {
  const { eq, ...fader } = mixer;
  const commands: EngineCommand[] = [];
  if (!sameMixer(sent, mixer)) {
    commands.push("track" in channel ? { type: "setTrackMixer", ...channel, ...fader } : { type: "setBusMixer", ...channel, ...fader });
  }
  if (!sameEq(sent.eq, eq)) {
    const chain = "track" in channel ? channel.track : busChain(channel.bus);
    commands.push({ type: "setChannelEq", chain, ...eq });
  }
  return commands;
}

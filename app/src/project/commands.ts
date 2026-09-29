/**
 * Every change to a Project is one of these commands. The UI and the
 * Assistant both use them, and `ProjectHistory` makes each one undoable.
 *
 * Commands are data, so they can be logged, sent from the Assistant's tools
 * and replayed. Anything a command creates (a Track, Clip or Effect) carries
 * its id already, so applying the same command always gives the same result.
 */
import type {
  AutomatedSetting,
  Breakpoint,
  Bus,
  Clip,
  CompressorSettings,
  DelaySettings,
  DrumPad,
  Effect,
  EqSettings,
  Instrument,
  KeysInstrument,
  ChannelEq,
  Mixer,
  Note,
  Output,
  Project,
  ReferenceTrack,
  ReverbSettings,
  Section,
  Send,
  SynthSettings,
  TempoChange,
  Track,
  TrackInput,
} from "./model";
import { nextDrumPad } from "./model";
import type { Arrangement } from "./arrangement";
import { automatableSetting, pruneAutomation, sortAutomation } from "./automation";
import type { KeysSettings } from "../instrument/keys-params";
import { keysPreset } from "../instrument/keys-presets";
import { synthPreset } from "../instrument/synth-presets";
import { findBus as busById, type Channel, routingProblem, sendProblem } from "./routing";
import { overlappingSection, sectionBarsText, type SectionRange } from "./sections";
import { secondsBetween, type TimeSignature, tempoMapOf } from "./time";
import { LIMITS, validateProject } from "./validate";

/** Which Insert Chain: the Master's, a Track's or a Bus's. */
export type ChainTarget = "master" | { trackId: string } | { busId: string };

/** Whose Automation: the Master's, a Track's or a Bus's. */
export type AutomationTarget = "master" | { trackId: string } | { busId: string };

export type Command =
  | { type: "setProjectName"; name: string }
  | { type: "setTempo"; tempo: number }
  | { type: "setTimeSignature"; timeSignature: TimeSignature }
  | { type: "addTempoChange"; tempoChange: TempoChange }
  /** Only the fields given change; `null` stops the change changing that. */
  | {
      type: "setTempoChange";
      tempoChangeId: string;
      tempo?: number | null;
      timeSignature?: TimeSignature | null;
    }
  | { type: "moveTempoChange"; tempoChangeId: string; tick: number }
  | { type: "deleteTempoChange"; tempoChangeId: string }
  /** Refused if it would overlap another Section. */
  | { type: "addSection"; section: Section }
  | { type: "renameSection"; sectionId: string; name: string }
  /** Move either edge, or both: refused if it would overlap another Section. */
  | { type: "resizeSection"; sectionId: string; startBar: number; bars: number }
  | { type: "deleteSection"; sectionId: string }
  /** Set the Reference Track, whose file is already copied in, or remove it with null. */
  | { type: "setReferenceTrack"; referenceTrack: ReferenceTrack | null }
  /**
   * Lay the song out again: its tempo map, Sections, every Track's Clips and
   * every channel's Automation, as an arrangement edit (`arrangement.ts`)
   * worked them out. Every Track, Bus and the Master is listed.
   */
  | { type: "rearrange"; arrangement: Arrangement }
  /** At `index` in the Track list, or at the end. */
  | { type: "addTrack"; track: Track; index?: number }
  | { type: "renameTrack"; trackId: string; name: string }
  | { type: "moveTrack"; trackId: string; index: number }
  | { type: "deleteTrack"; trackId: string }
  | { type: "setInstrument"; trackId: string; instrument: Instrument }
  /** Only the settings given change; the Track keeps its Instrument. */
  | { type: "setSynthSettings"; trackId: string; settings: Partial<SynthSettings> }
  /** A Plugin Instrument's; only the settings given change. */
  | { type: "setInstrumentSettings"; trackId: string; settings: Record<string, number> }
  /**
   * Load a preset, settings and all. A Factory Preset is found by name; a
   * User Preset brings its settings, since the library is outside the Project.
   */
  | { type: "setSynthPreset"; trackId: string; preset: string; settings?: SynthSettings }
  /** The Keys' settings; only the settings given change. */
  | { type: "setKeysSettings"; trackId: string; settings: Partial<KeysSettings> }
  /** Load one of the Keys' presets, as `setSynthPreset` does the Synth's. */
  | { type: "setKeysPreset"; trackId: string; preset: string; settings?: KeysSettings }
  /**
   * The sample the Keys play across the keyboard: a file in the Project
   * folder, or null to take it off. Setting one plays it: the source
   * becomes the sample, from `rootNote` if given.
   */
  | { type: "setKeysSample"; trackId: string; sample: string | null; rootNote?: number }
  /** One Drum Sampler pad; only the fields given change. */
  | { type: "setDrumPad"; trackId: string; pad: number; settings: Partial<DrumPad> }
  /**
   * One more Pad after a Drum Sampler's last: `nextDrumPad`'s, the Starter
   * Kit's Pad at that position or, past the kit, an empty one.
   */
  | { type: "addDrumPad"; trackId: string }
  /**
   * Take a Drum Sampler's last Pad off, and its Automation with it. Only the
   * last, so no other Pad moves, and each keeps the kit sound of its place.
   * Notes on its note stay in the Clips, playing nothing.
   */
  | { type: "removeDrumPad"; trackId: string }
  /** Only the fields given change, down to single bands of the EQ. */
  | { type: "setTrackMixer"; trackId: string; mixer: MixerChange }
  | { type: "setMasterVolume"; volume: number }
  /** Only the bands given change. */
  | { type: "setMasterEq"; eq: Partial<ChannelEq> }
  /** Where a Track sends its signal: a Bus's id, or `null` for the Master. */
  | { type: "setTrackOutput"; trackId: string; output: Output }
  /** Which input device, and which of its channels, an Audio Track records from. */
  | { type: "setTrackInput"; trackId: string; input: TrackInput }
  /** Input Monitoring on an Audio Track: heard through its Effects while armed. */
  | { type: "setTrackMonitoring"; trackId: string; monitoring: boolean }
  /** At `index` in the Bus list, or at the end. */
  | { type: "addBus"; bus: Bus; index?: number }
  | { type: "renameBus"; busId: string; name: string }
  /** Whatever fed the Bus feeds the Master instead. */
  | { type: "deleteBus"; busId: string }
  /** To `index` in the Bus list, which is only where it is listed: what it feeds and what feeds it stay. */
  | { type: "moveBus"; busId: string; index: number }
  /** Only the fields given change, as `setTrackMixer`'s. */
  | { type: "setBusMixer"; busId: string; mixer: MixerChange }
  /** Where a Bus sends its signal: another Bus's id, or `null` for the Master. */
  | { type: "setBusOutput"; busId: string; output: Output }
  /** A post-fader Send from a Track or Bus to a Bus, after its others. */
  | { type: "addSend"; from: Channel; busId: string; level: number }
  | { type: "setSendLevel"; from: Channel; busId: string; level: number }
  | { type: "removeSend"; from: Channel; busId: string }
  | { type: "addClip"; trackId: string; clip: Clip }
  /** To a new start, and optionally onto another Track of the same kind. */
  | { type: "moveClip"; clipId: string; start: number; trackId?: string }
  /**
   * Change where a Clip starts and ends. For an Audio Clip, `fileOffset`
   * moves where in its file it plays from, and the `length` in ticks
   * becomes the seconds it spans on the tempo map.
   */
  | { type: "trimClip"; clipId: string; start: number; length: number; fileOffset?: number }
  | { type: "deleteClip"; clipId: string }
  | { type: "setPatternNotes"; clipId: string; notes: Note[] }
  /**
   * Replace a setting's breakpoints, in any order. None takes its Automation
   * away, giving it back its fixed value.
   */
  | { type: "setAutomation"; target: AutomationTarget; setting: AutomatedSetting; breakpoints: Breakpoint[] }
  | { type: "addEffect"; target: ChainTarget; effect: Effect; index?: number }
  | { type: "removeEffect"; effectId: string }
  | { type: "moveEffect"; effectId: string; index: number }
  | { type: "setEffectBypassed"; effectId: string; bypassed: boolean }
  /** Only the settings given change. */
  | {
      type: "setEffectSettings";
      effectId: string;
      settings:
        | Partial<EqSettings>
        | Partial<CompressorSettings>
        | Partial<ReverbSettings>
        | Partial<DelaySettings>
        | Record<string, number>;
    };

export type CommandType = Command["type"];

export type Result = { ok: true; project: Project } | { ok: false; error: string };

/** A short description of what a command does, for undo and redo. */
export const COMMAND_LABELS: Record<CommandType, string> = {
  setProjectName: "Rename Project",
  setTempo: "Set tempo",
  setTimeSignature: "Set time signature",
  addTempoChange: "Add Tempo Change",
  setTempoChange: "Edit Tempo Change",
  moveTempoChange: "Move Tempo Change",
  deleteTempoChange: "Delete Tempo Change",
  addSection: "Add Section",
  renameSection: "Rename Section",
  resizeSection: "Resize Section",
  deleteSection: "Delete Section",
  setReferenceTrack: "Set Reference Track",
  rearrange: "Rearrange",
  addTrack: "Add Track",
  renameTrack: "Rename Track",
  moveTrack: "Move Track",
  deleteTrack: "Delete Track",
  setInstrument: "Set Instrument",
  setSynthSettings: "Change Synth",
  setInstrumentSettings: "Change Instrument",
  setSynthPreset: "Load Synth preset",
  setKeysSettings: "Change Keys",
  setKeysPreset: "Load Keys preset",
  setKeysSample: "Load Keys sample",
  setDrumPad: "Change pad",
  addDrumPad: "Add Pad",
  removeDrumPad: "Remove Pad",
  setTrackMixer: "Change mixer",
  setMasterVolume: "Set Master volume",
  setMasterEq: "Change Master EQ",
  setTrackOutput: "Route Track",
  setTrackInput: "Set Track Input",
  setTrackMonitoring: "Set Input Monitoring",
  addBus: "Add Bus",
  renameBus: "Rename Bus",
  deleteBus: "Delete Bus",
  moveBus: "Move Bus",
  setBusMixer: "Change Bus mixer",
  setBusOutput: "Route Bus",
  addSend: "Add Send",
  setSendLevel: "Change Send level",
  removeSend: "Remove Send",
  addClip: "Add Clip",
  moveClip: "Move Clip",
  trimClip: "Trim Clip",
  deleteClip: "Delete Clip",
  setPatternNotes: "Edit notes",
  setAutomation: "Edit Automation",
  addEffect: "Add Effect",
  removeEffect: "Remove Effect",
  moveEffect: "Move Effect",
  setEffectBypassed: "Bypass Effect",
  setEffectSettings: "Change Effect",
};

class Rejected extends Error {}

function reject(message: string): never {
  throw new Rejected(message);
}

/** A change to a mixer channel: only the fields given, and only the EQ bands given. */
export type MixerChange = Partial<Omit<Mixer, "eq">> & { eq?: Partial<ChannelEq> };

function changedMixer(mixer: Mixer, changes: MixerChange): Mixer {
  return { ...mixer, ...changes, eq: { ...mixer.eq, ...changes.eq } };
}

/**
 * Apply `command` to `project`, returning a new Project. `project` itself is
 * never changed. A command that names something that doesn't exist, or would
 * leave the Project breaking its rules, is rejected with the reason.
 */
export function applyCommand(project: Project, command: Command): Result {
  const next = structuredClone(project);
  try {
    change(next, command);
    pruneAutomation(next);
  } catch (error) {
    if (error instanceof Rejected) return { ok: false, error: error.message };
    throw error;
  }
  const invalid = validateProject(next);
  return invalid ? { ok: false, error: invalid } : { ok: true, project: next };
}

/** Apply several commands in order; if any is rejected, none are applied. */
export function applyCommands(project: Project, commands: readonly Command[]): Result {
  let current = project;
  for (const command of commands) {
    const result = applyCommand(current, command);
    if (!result.ok) return result;
    current = result.project;
  }
  return { ok: true, project: current };
}

/** Make the change on `project`, which is a private copy. */
function change(project: Project, command: Command): void {
  switch (command.type) {
    case "setProjectName":
      project.name = command.name;
      return;
    case "setTempo":
      project.tempo = command.tempo;
      return;
    case "setTimeSignature":
      project.timeSignature = structuredClone(command.timeSignature);
      return;
    case "addTempoChange":
      project.tempoChanges.push(structuredClone(command.tempoChange));
      sortTempoChanges(project);
      return;
    case "setTempoChange": {
      const tempoChange = findTempoChange(project, command.tempoChangeId);
      if (command.tempo !== undefined) tempoChange.tempo = command.tempo;
      if (command.timeSignature !== undefined) tempoChange.timeSignature = structuredClone(command.timeSignature);
      return;
    }
    case "moveTempoChange":
      findTempoChange(project, command.tempoChangeId).tick = command.tick;
      sortTempoChanges(project);
      return;
    case "deleteTempoChange": {
      const tempoChange = findTempoChange(project, command.tempoChangeId);
      project.tempoChanges.splice(project.tempoChanges.indexOf(tempoChange), 1);
      return;
    }

    case "setReferenceTrack":
      project.referenceTrack = structuredClone(command.referenceTrack);
      return;

    case "addSection":
      checkSectionFree(project, command.section.name, command.section);
      project.sections.push(structuredClone(command.section));
      sortSections(project);
      return;
    case "renameSection":
      findSection(project, command.sectionId).name = command.name;
      return;
    case "resizeSection": {
      const section = findSection(project, command.sectionId);
      const range = { startBar: command.startBar, bars: command.bars };
      checkSectionFree(project, section.name, range, section.id);
      Object.assign(section, range);
      sortSections(project);
      return;
    }
    case "deleteSection": {
      const section = findSection(project, command.sectionId);
      project.sections.splice(project.sections.indexOf(section), 1);
      return;
    }

    case "rearrange": {
      const { arrangement } = command;
      const listed = (ids: string[], owners: { id: string }[], what: string) => {
        const expected = owners.map((owner) => owner.id).toSorted();
        if (ids.toSorted().join("\n") !== expected.join("\n")) reject(`A rearrangement must list every ${what} once`);
      };
      listed(arrangement.tracks.map((track) => track.trackId), project.tracks, "Track");
      listed(arrangement.buses.map((bus) => bus.busId), project.buses, "Bus");
      project.tempo = arrangement.tempo;
      project.timeSignature = structuredClone(arrangement.timeSignature);
      project.tempoChanges = structuredClone(arrangement.tempoChanges);
      project.sections = structuredClone(arrangement.sections);
      for (const { trackId, clips, automation } of arrangement.tracks) {
        const track = findTrack(project, trackId);
        track.clips = structuredClone(clips) as typeof track.clips;
        sortClips(track);
        track.automation = sortAutomation(structuredClone(automation));
      }
      for (const { busId, automation } of arrangement.buses) {
        findBus(project, busId).automation = sortAutomation(structuredClone(automation));
      }
      project.master.automation = sortAutomation(structuredClone(arrangement.masterAutomation));
      return;
    }

    case "addTrack":
      insertAt(project.tracks, structuredClone(command.track), command.index);
      return;
    case "renameTrack":
      findTrack(project, command.trackId).name = command.name;
      return;
    case "moveTrack": {
      const from = trackIndex(project, command.trackId);
      const [track] = project.tracks.splice(from, 1);
      insertAt(project.tracks, track!, checkIndex(command.index, project.tracks.length));
      return;
    }
    case "deleteTrack":
      project.tracks.splice(trackIndex(project, command.trackId), 1);
      return;
    case "setInstrument": {
      const track = findTrack(project, command.trackId);
      if (track.kind !== "instrument") reject(`${track.name} is an Audio Track: it has no Instrument`);
      // Another kind of Instrument, or another Plugin, may share a setting's
      // name but not its meaning: its Automation goes with the old one.
      if (instrumentIdentity(track.instrument) !== instrumentIdentity(command.instrument)) {
        track.automation = track.automation.filter((lane) => !lane.setting.startsWith("instrument:"));
      }
      track.instrument = structuredClone(command.instrument);
      return;
    }
    case "setSynthSettings": {
      const synth = findSynth(project, command.trackId);
      synth.settings = { ...synth.settings, ...command.settings };
      return;
    }
    case "setInstrumentSettings": {
      const track = findTrack(project, command.trackId);
      if (track.kind !== "instrument" || track.instrument.type !== "plugin") {
        reject(`${track.name} has no Plugin Instrument`);
      }
      Object.assign(track.instrument.settings, command.settings);
      return;
    }
    case "setSynthPreset": {
      const settings = command.settings ?? synthPreset(command.preset)?.settings;
      if (!settings) reject(`There is no preset called ${command.preset}`);
      const synth = findSynth(project, command.trackId);
      synth.preset = command.preset;
      synth.settings = { ...settings };
      return;
    }
    case "setKeysSettings": {
      const keys = findKeys(project, command.trackId);
      keys.settings = { ...keys.settings, ...command.settings };
      return;
    }
    case "setKeysPreset": {
      const settings = command.settings ?? keysPreset(command.preset)?.settings;
      if (!settings) reject(`There is no Keys preset called ${command.preset}`);
      const keys = findKeys(project, command.trackId);
      keys.preset = command.preset;
      keys.settings = { ...settings };
      return;
    }
    case "setKeysSample": {
      const keys = findKeys(project, command.trackId);
      keys.sample = command.sample;
      if (command.sample !== null) {
        keys.settings = { ...keys.settings, source: "sample", ...(command.rootNote !== undefined && { rootNote: command.rootNote }) };
      } else if (keys.settings.source === "sample") {
        keys.settings = { ...keys.settings, source: "piano" };
      }
      return;
    }
    case "setDrumPad": {
      const { track, pads } = findDrumSampler(project, command.trackId);
      const pad = pads[command.pad];
      if (!pad) reject(`${track.name} has no pad ${command.pad + 1}`);
      Object.assign(pad, command.settings);
      return;
    }
    case "addDrumPad": {
      const { track, pads } = findDrumSampler(project, command.trackId);
      if (pads.length >= LIMITS.drumPads[1]) reject(`${track.name} has ${pads.length} Pads already, the most a Drum Sampler holds`);
      pads.push(nextDrumPad(pads));
      return;
    }
    case "removeDrumPad": {
      const { track, pads } = findDrumSampler(project, command.trackId);
      if (pads.length <= LIMITS.drumPads[0]) reject(`${track.name} has only ${pads.length} Pad left, and a Drum Sampler keeps at least ${LIMITS.drumPads[0]}`);
      // Its Automation goes with it, as `pruneAutomation` finds.
      pads.pop();
      return;
    }
    case "setTrackMixer": {
      const track = findTrack(project, command.trackId);
      track.mixer = changedMixer(track.mixer, command.mixer);
      return;
    }
    case "setMasterVolume":
      project.master.volume = command.volume;
      return;
    case "setMasterEq":
      project.master.eq = { ...project.master.eq, ...command.eq };
      return;
    case "setTrackOutput": {
      const track = findTrack(project, command.trackId);
      refuseRouting(project, { trackId: track.id }, command.output);
      track.output = command.output;
      return;
    }
    case "setTrackInput": {
      const track = findTrack(project, command.trackId);
      if (track.kind !== "audio") reject(`${track.name} isn't an Audio Track, so it records from no Input`);
      track.input = structuredClone(command.input);
      return;
    }
    case "setTrackMonitoring": {
      const track = findTrack(project, command.trackId);
      if (track.kind !== "audio") reject(`${track.name} isn't an Audio Track, so it has no input to monitor`);
      track.monitoring = command.monitoring;
      return;
    }

    case "addBus":
      insertAt(project.buses, structuredClone(command.bus), command.index);
      return;
    case "renameBus":
      findBus(project, command.busId).name = command.name;
      return;
    case "deleteBus": {
      const bus = findBus(project, command.busId);
      project.buses.splice(project.buses.indexOf(bus), 1);
      for (const channel of [...project.tracks, ...project.buses]) {
        if (channel.output === bus.id) channel.output = null;
        channel.sends = channel.sends.filter((send) => send.busId !== bus.id);
      }
      return;
    }
    case "moveBus": {
      const bus = findBus(project, command.busId);
      project.buses.splice(project.buses.indexOf(bus), 1);
      insertAt(project.buses, bus, checkIndex(command.index, project.buses.length));
      return;
    }
    case "setBusMixer": {
      const bus = findBus(project, command.busId);
      bus.mixer = changedMixer(bus.mixer, command.mixer);
      return;
    }
    case "setBusOutput": {
      const bus = findBus(project, command.busId);
      refuseRouting(project, { busId: bus.id }, command.output);
      bus.output = command.output;
      return;
    }
    case "addSend": {
      const channel = findChannel(project, command.from);
      const problem = sendProblem(project, command.from, command.busId);
      if (problem) reject(problem);
      channel.sends.push({ busId: command.busId, level: command.level });
      return;
    }
    case "setSendLevel":
      findSend(project, command.from, command.busId).level = command.level;
      return;
    case "removeSend": {
      const channel = findChannel(project, command.from);
      channel.sends.splice(channel.sends.indexOf(findSend(project, command.from, command.busId)), 1);
      return;
    }

    case "addClip": {
      const track = findTrack(project, command.trackId);
      (track.clips as Clip[]).push(structuredClone(command.clip));
      sortClips(track);
      return;
    }
    case "moveClip": {
      const { track, clip } = findClip(project, command.clipId);
      clip.start = command.start;
      if (command.trackId !== undefined && command.trackId !== track.id) {
        const destination = findTrack(project, command.trackId);
        if (destination.kind !== track.kind) {
          reject(`A Clip can only move to another ${track.kind === "audio" ? "Audio" : "Instrument"} Track`);
        }
        track.clips.splice(track.clips.indexOf(clip as never), 1);
        (destination.clips as Clip[]).push(clip);
        sortClips(destination);
      }
      sortClips(track);
      return;
    }
    case "trimClip": {
      const { track, clip } = findClip(project, command.clipId);
      const moved = command.start - clip.start;
      clip.start = command.start;
      if (clip.kind === "audio") {
        clip.duration = secondsBetween(tempoMapOf(project), command.start, command.start + command.length);
      } else {
        clip.length = command.length;
      }
      if (command.fileOffset !== undefined) {
        if (clip.kind !== "audio") reject("Only an Audio Clip has a file offset");
        clip.fileOffset = command.fileOffset;
      }
      if (clip.kind === "pattern") {
        // Notes are held relative to the Clip's start, so moving that start
        // shifts them back, leaving the music where it sounded — the same as
        // an Audio Clip's `fileOffset` moving with its start. Notes that no
        // longer start inside the Clip are cut.
        clip.notes = clip.notes
          .map((note) => (moved === 0 ? note : { ...note, start: note.start - moved }))
          .filter((note) => note.start >= 0 && note.start < clip.length);
      }
      sortClips(track);
      return;
    }
    case "deleteClip": {
      const { track, clip } = findClip(project, command.clipId);
      track.clips.splice(track.clips.indexOf(clip as never), 1);
      return;
    }
    case "setPatternNotes": {
      const { clip } = findClip(project, command.clipId);
      if (clip.kind !== "pattern") reject("Only a Pattern Clip has notes");
      clip.notes = sortNotes(structuredClone(command.notes));
      return;
    }
    case "setAutomation": {
      const owner = command.target === "master" ? project.master : findChannel(project, command.target);
      if (!automatableSetting(project, owner, command.setting)) {
        const whose = "name" in owner ? owner.name : "The Master";
        reject(`${whose} has no setting ${command.setting} to automate`);
      }
      const others = owner.automation.filter((lane) => lane.setting !== command.setting);
      const breakpoints = structuredClone(command.breakpoints).toSorted((a, b) => a.tick - b.tick);
      owner.automation = sortAutomation(
        breakpoints.length === 0 ? others : [...others, { setting: command.setting, breakpoints }],
      );
      return;
    }

    case "addEffect":
      insertAt(chainOf(project, command.target), structuredClone(command.effect), command.index);
      return;
    case "removeEffect": {
      const { chain, index } = findEffect(project, command.effectId);
      chain.splice(index, 1);
      return;
    }
    case "moveEffect": {
      const { chain, index } = findEffect(project, command.effectId);
      const [effect] = chain.splice(index, 1);
      insertAt(chain, effect!, checkIndex(command.index, chain.length));
      return;
    }
    case "setEffectBypassed":
      findEffect(project, command.effectId).effect.bypassed = command.bypassed;
      return;
    case "setEffectSettings": {
      const { effect } = findEffect(project, command.effectId);
      Object.assign(effect.settings, command.settings);
      return;
    }
  }
}

function checkIndex(index: number, length: number): number {
  if (!Number.isInteger(index) || index < 0 || index > length) {
    reject(`Position ${index} is outside the list (0 to ${length})`);
  }
  return index;
}

function insertAt<T>(list: T[], item: T, index = list.length) {
  list.splice(checkIndex(index, list.length), 0, item);
}

function trackIndex(project: Project, trackId: string): number {
  const index = project.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) reject(`There is no Track ${trackId}`);
  return index;
}

function findTrack(project: Project, trackId: string): Track {
  return project.tracks[trackIndex(project, trackId)]!;
}

function findBus(project: Project, busId: string): Bus {
  return busById(project, busId) ?? reject(`There is no Bus ${busId}`);
}

/** The Track or Bus a channel names. */
function findChannel(project: Project, channel: Channel): Track | Bus {
  return "busId" in channel ? findBus(project, channel.busId) : findTrack(project, channel.trackId);
}

function findSend(project: Project, from: Channel, busId: string): Send {
  const channel = findChannel(project, from);
  return (
    channel.sends.find((send) => send.busId === busId) ??
    reject(`${channel.name} has no Send to ${busById(project, busId)?.name ?? busId}`)
  );
}

/** Refuse, with the reason, an output that doesn't exist or makes a loop. */
function refuseRouting(project: Project, channel: { trackId: string } | { busId: string }, output: Output) {
  const problem = routingProblem(project, channel, output);
  if (problem) reject(problem);
}

/** Which Instrument it is: its type, or a Plugin's id. */
function instrumentIdentity(instrument: Instrument): string {
  return instrument.type === "plugin" ? `plugin:${instrument.plugin.id}` : instrument.type;
}

/** A Track's Synth, or a rejection if it hasn't got one. */
function findSynth(project: Project, trackId: string): Extract<Instrument, { type: "synth" }> {
  const track = findTrack(project, trackId);
  if (track.kind !== "instrument" || track.instrument.type !== "synth") {
    reject(`${track.name} has no Synth`);
  }
  return track.instrument;
}

/** A Track's Drum Sampler's Pads, or a rejection if it isn't playing one. */
function findDrumSampler(project: Project, trackId: string): { track: Track; pads: DrumPad[] } {
  const track = findTrack(project, trackId);
  if (track.kind !== "instrument" || track.instrument.type !== "drumSampler") {
    reject(`${track.name} isn't playing the Drum Sampler`);
  }
  return { track, pads: track.instrument.pads };
}

/** A Track's Keys, or a rejection if it hasn't got them. */
function findKeys(project: Project, trackId: string): KeysInstrument {
  const track = findTrack(project, trackId);
  if (track.kind !== "instrument" || track.instrument.type !== "keys") {
    reject(`${track.name} isn't playing the Keys`);
  }
  return track.instrument;
}

function findTempoChange(project: Project, tempoChangeId: string): TempoChange {
  return (
    project.tempoChanges.find((candidate) => candidate.id === tempoChangeId) ??
    reject(`There's no Tempo Change with id ${tempoChangeId}`)
  );
}

function sortTempoChanges(project: Project) {
  project.tempoChanges.sort((a, b) => a.tick - b.tick);
}

function findSection(project: Project, sectionId: string): Section {
  return project.sections.find((candidate) => candidate.id === sectionId) ?? reject(`There's no Section with id ${sectionId}`);
}

/** Refuse a Section named `name` at `range` if it would overlap another. */
function checkSectionFree(project: Project, name: string, range: SectionRange, ignoreId?: string) {
  const other = overlappingSection(project.sections, range, ignoreId);
  if (other) {
    reject(`“${name}” at ${sectionBarsText(range)} would overlap the Section “${other.name}” (${sectionBarsText(other)})`);
  }
}

function sortSections(project: Project) {
  project.sections.sort((a, b) => a.startBar - b.startBar);
}

function findClip(project: Project, clipId: string): { track: Track; clip: Clip } {
  for (const track of project.tracks) {
    const clip = (track.clips as Clip[]).find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  reject(`There is no Clip ${clipId}`);
}

function chainOf(project: Project, target: ChainTarget): Effect[] {
  if (target === "master") return project.master.insertChain;
  if ("busId" in target) return findBus(project, target.busId).insertChain;
  return findTrack(project, target.trackId).insertChain;
}

function findEffect(project: Project, effectId: string) {
  const chains = [project.master.insertChain, ...[...project.tracks, ...project.buses].map((c) => c.insertChain)];
  for (const chain of chains) {
    const index = chain.findIndex((effect) => effect.id === effectId);
    if (index >= 0) return { chain, index, effect: chain[index]! };
  }
  reject(`There is no Effect ${effectId}`);
}

/** Clips are kept in time order, so the same arrangement is the same data. */
function sortClips(track: Track) {
  (track.clips as Clip[]).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

function sortNotes(notes: Note[]): Note[] {
  return notes.toSorted((a, b) => a.start - b.start || a.pitch - b.pitch);
}

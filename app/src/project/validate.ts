/**
 * The rules a Project must follow. Commands check the Project they produce
 * against these, and so does opening a saved one, so there is one set of
 * rules for both. Unknown fields are rules broken too: the Project is exactly
 * its schema, nothing more.
 */
import { EFFECT_NAMES, EFFECT_TYPES, type EffectType, effectParams } from "../effect/effect-params";
import { SYNTH_PARAMS } from "../instrument/synth-params";
import type { PluginManifest } from "../plugin/plugins";
import {
  type Bus,
  type Send,
  type Clip,
  type Effect,
  type Instrument,
  isVst3Id,
  type Mixer,
  type Note,
  type PluginEffect,
  type Project,
  SCHEMA_VERSION,
  type Section,
  type TempoChange,
  type Track,
} from "./model";
import { type AutomatableSetting, type AutomationOwner, automatableSettings, isMaster } from "./automation";
import { routingLoop } from "./routing";
import { overlappingSection, sectionBarsText } from "./sections";
import { BEAT_UNITS, isBarLine, type TimeSignature, tempoMapOf } from "./time";

export const LIMITS = {
  tempo: [20, 999],
  beatsPerBar: [1, 32],
  volume: [0, 2],
  pan: [-1, 1],
  pitch: [0, 127],
  velocity: [0, 1],
  drumPads: [1, 16],
  padPitch: [-24, 24],
  chokeGroup: [0, 16],
  /** The most Effects an Insert Chain holds: the engine's `MAX_EFFECTS`. */
  effects: 16,
  /** The most Buses a Project holds: the engine's `MAX_BUSES`. */
  buses: 128,
  /** The most breakpoints one Automation holds: the engine's `MAX_BREAKPOINTS`. */
  breakpoints: 4096,
  nameLength: 200,
  /** The longest Plugin id or version: the engine's `MAX_ID` (`plugin.rs`). */
  pluginId: 128,
  /** The most settings a Plugin declares: the engine's `MAX_PLUGIN_SETTINGS`. */
  pluginSettings: 64,
  /** The largest VST3 Plugin state, each of its two, in bytes once decoded (ADR 0008). */
  vst3State: 16 * 1024 * 1024,
  /** The highest channel an Input names, from 0: far past any interface's. */
  inputChannel: 1023,
} as const;

class Invalid extends Error {}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Invalid(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  what: string,
): asserts value is Record<string, unknown> {
  check(isObject(value), `${what} must be an object`);
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  check(extra.length === 0, `${what} has unknown fields: ${extra.join(", ")}`);
  const missing = keys.filter((key) => !(key in value));
  check(missing.length === 0, `${what} is missing: ${missing.join(", ")}`);
}

function inRange(value: unknown, [min, max]: readonly [number, number], what: string) {
  check(
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max,
    `${what} must be a number from ${min} to ${max}`,
  );
}

function isTick(value: unknown, what: string, { positive = false } = {}) {
  check(
    Number.isInteger(value) && (value as number) >= (positive ? 1 : 0),
    `${what} must be a whole number of ticks${positive ? " above 0" : ""}`,
  );
}

function isName(value: unknown, what: string) {
  check(
    typeof value === "string" && value.trim().length > 0 && value.length <= LIMITS.nameLength,
    `${what} must be 1 to ${LIMITS.nameLength} characters`,
  );
}

function isId(value: unknown, seen: Set<string>, what: string) {
  check(typeof value === "string" && value.length > 0, `${what} id must be a non-empty string`);
  check(!seen.has(value), `${what} id ${value} is already used`);
  seen.add(value);
}

/** Validate a Project, returning what is wrong with it, or null. */
export function validateProject(project: unknown): string | null {
  return problem(() => checkProject(project));
}

/**
 * What is wrong with a Synth's settings, or null: a User Preset's, read back
 * from the library, is checked by the same rules as a Project's.
 */
export function validateSynthSettings(settings: unknown): string | null {
  return problem(() => checkSynthSettings(settings, "The Synth settings"));
}

/**
 * What is wrong with an Instrument, or null: a saved Kit's Pads, read back
 * from the library, are checked as a Drum Sampler's in a Project are.
 */
export function validateInstrument(instrument: unknown): string | null {
  return problem(() => checkInstrument(instrument, "The Kit"));
}

/** What is wrong with an Effect's settings, or null. */
export function validateEffectSettings(type: EffectType, settings: unknown): string | null {
  return problem(() => checkEffectSettings(type, settings));
}

/** What is wrong with a Plugin Effect's settings, or null: checked against its manifest, when there is one. */
export function validatePluginSettings(manifest: PluginManifest | undefined, settings: unknown): string | null {
  return problem(() => checkPluginSettings(manifest, settings));
}

function problem(checkAll: () => void): string | null {
  try {
    checkAll();
    return null;
  } catch (error) {
    if (error instanceof Invalid) return error.message;
    throw error;
  }
}

function checkProject(project: unknown): asserts project is Project {
  exactKeys(
    project,
    ["schemaVersion", "name", "tempo", "timeSignature", "tempoChanges", "sections", "tracks", "buses", "master", "referenceTrack"],
    "Project",
  );
  check(project.schemaVersion === SCHEMA_VERSION, `schemaVersion must be ${SCHEMA_VERSION}`);
  isName(project.name, "The Project name");
  inRange(project.tempo, LIMITS.tempo, "Tempo");

  checkTimeSignature(project.timeSignature, "The time signature");

  // Ids are unique across the whole Project, so a command can name any Track,
  // Clip, Effect, Tempo Change or Section by id alone.
  const ids = new Set<string>();
  checkTempoChanges(project as Record<string, unknown> & Pick<Project, "tempo" | "timeSignature">, ids);
  checkSections(project.sections, ids);
  checkReferenceTrack(project.referenceTrack);
  check(Array.isArray(project.tracks), "Tracks must be a list");
  for (const track of project.tracks) checkTrack(track, ids);
  check(Array.isArray(project.buses), "Buses must be a list");
  check(project.buses.length <= LIMITS.buses, `A Project holds at most ${LIMITS.buses} Buses`);
  for (const bus of project.buses) checkBus(bus, ids);
  checkRouting(project as unknown as Pick<Project, "tracks" | "buses">);

  exactKeys(project.master, ["volume", "insertChain", "automation"], "The Master");
  const master = project.master as Record<string, unknown>;
  inRange(master.volume, LIMITS.volume, "The Master volume");
  checkInsertChain(master.insertChain, ids, "The Master");

  // Last, because what a channel can automate depends on its Sends, its
  // Effects and its Instrument, all checked by now.
  const owners = [project.master, ...project.tracks, ...project.buses] as unknown as AutomationOwner[];
  for (const owner of owners) {
    const what = isMaster(owner) ? "The Master" : `${"kind" in owner ? "Track" : "Bus"} ${owner.name}`;
    checkAutomation(owner.automation, automatableSettings(project as unknown as Project, owner), what);
  }
}

/** What a Track, Bus or the Master automates: each of `settings` at most once. */
function checkAutomation(automation: unknown, settings: readonly AutomatableSetting[], what: string) {
  check(Array.isArray(automation), `${what}'s Automation must be a list`);
  const seen = new Set<unknown>();
  for (const lane of automation) {
    exactKeys(lane, ["setting", "breakpoints"], `${what}'s Automation`);
    const automatable = settings.find((candidate) => candidate.setting === lane.setting);
    check(automatable !== undefined, `${what} has no setting ${String(lane.setting)} to automate`);
    check(!seen.has(lane.setting), `${what} automates its ${automatable.label.toLowerCase()} twice`);
    seen.add(lane.setting);
    const setting = automatable.label.toLowerCase();
    const { breakpoints } = lane;
    check(
      Array.isArray(breakpoints) && breakpoints.length >= 1 && breakpoints.length <= LIMITS.breakpoints,
      `${what}'s ${setting} Automation has 1 to ${LIMITS.breakpoints} breakpoints`,
    );
    let previous = -1;
    for (const point of breakpoints) {
      exactKeys(point, ["tick", "value", "hold"], "A breakpoint");
      isTick(point.tick, "A breakpoint's position");
      check((point.tick as number) > previous, `${what}'s ${setting} breakpoints must be in order, one to a tick`);
      previous = point.tick as number;
      inRange(point.value, [automatable.min, automatable.max], `A ${setting} breakpoint's value`);
      check(typeof point.hold === "boolean", "A breakpoint's hold must be true or false");
    }
  }
}

function checkTimeSignature(signature: unknown, what: string): asserts signature is TimeSignature {
  exactKeys(signature, ["beatsPerBar", "beatUnit"], what);
  const { beatsPerBar, beatUnit } = signature;
  const [minBeats, maxBeats] = LIMITS.beatsPerBar;
  check(
    Number.isInteger(beatsPerBar) &&
      (beatsPerBar as number) >= minBeats &&
      (beatsPerBar as number) <= maxBeats,
    `Beats per bar must be a whole number from ${minBeats} to ${maxBeats}`,
  );
  check(
    (BEAT_UNITS as readonly unknown[]).includes(beatUnit),
    `The beat unit must be one of ${BEAT_UNITS.join(", ")}`,
  );
}

/**
 * Tempo Changes come after the start, one to a tick, in order. Each changes
 * something, and a time signature changes only at a bar line of the map
 * before it, so bars never break part way.
 */
function checkTempoChanges(project: Record<string, unknown> & Pick<Project, "tempo" | "timeSignature">, ids: Set<string>) {
  const changes = project.tempoChanges;
  check(Array.isArray(changes), "Tempo Changes must be a list");
  const checked: TempoChange[] = [];
  for (const change of changes as unknown[]) {
    exactKeys(change, ["id", "tick", "tempo", "timeSignature"], "A Tempo Change");
    isId(change.id, ids, "Tempo Change");
    isTick(change.tick, "A Tempo Change's tick", { positive: true });
    const previous = checked.at(-1);
    check(!previous || (change.tick as number) > previous.tick, "Tempo Changes must be in order, one to a tick");
    check(change.tempo !== null || change.timeSignature !== null, "A Tempo Change must change the tempo or the time signature");
    if (change.tempo !== null) inRange(change.tempo, LIMITS.tempo, "A Tempo Change's tempo");
    if (change.timeSignature !== null) {
      checkTimeSignature(change.timeSignature, "A Tempo Change's time signature");
      const before = tempoMapOf({ tempo: project.tempo, timeSignature: project.timeSignature, tempoChanges: checked });
      check(
        isBarLine(before, change.tick as number),
        `A time signature can only change at a bar line, and tick ${change.tick} isn't one`,
      );
    }
    checked.push(change as unknown as TempoChange);
  }
}

/** None, or a file in the Project folder. */
function checkReferenceTrack(reference: unknown) {
  if (reference === null) return;
  exactKeys(reference, ["file"], "The Reference Track");
  check(typeof reference.file === "string" && reference.file.length > 0, "The Reference Track needs a file");
}

/** Sections are whole bars from bar 1 on, in bar order, and never overlap. */
function checkSections(sections: unknown, ids: Set<string>) {
  check(Array.isArray(sections), "Sections must be a list");
  const checked: Section[] = [];
  for (const section of sections as unknown[]) {
    exactKeys(section, ["id", "name", "startBar", "bars"], "A Section");
    isId(section.id, ids, "Section");
    isName(section.name, "A Section name");
    check(
      Number.isInteger(section.startBar) && (section.startBar as number) >= 1,
      `Section “${section.name}” must start at a whole bar from 1`,
    );
    check(Number.isInteger(section.bars) && (section.bars as number) >= 1, `Section “${section.name}” must last a whole number of bars`);
    const range = section as unknown as Section;
    const overlapped = overlappingSection(checked, range);
    if (overlapped) {
      check(false, `Section “${range.name}” (${sectionBarsText(range)}) overlaps “${overlapped.name}” (${sectionBarsText(overlapped)})`);
    }
    const previous = checked.at(-1);
    check(!previous || range.startBar > previous.startBar, "Sections must be in bar order");
    checked.push(range);
  }
}

function checkTrack(track: unknown, ids: Set<string>): asserts track is Track {
  check(isObject(track), "A Track must be an object");
  const common = ["id", "kind", "name", "mixer", "insertChain", "output", "sends", "automation", "clips"];
  if (track.kind === "instrument") exactKeys(track, [...common, "instrument"], "An Instrument Track");
  else if (track.kind === "audio") exactKeys(track, [...common, "input", "monitoring"], "An Audio Track");
  else check(false, 'A Track\'s kind must be "audio" or "instrument"');

  isId(track.id, ids, "Track");
  const what = `Track ${String(track.name)}`;
  isName(track.name, "A Track name");
  checkMixer(track.mixer, what);
  checkInsertChain(track.insertChain, ids, what);
  check(Array.isArray(track.automation), `${what}'s Automation must be a list`);
  if (track.kind === "instrument") checkInstrument(track.instrument, what);
  if (track.kind === "audio") {
    checkInput(track.input, what);
    check(typeof track.monitoring === "boolean", `${what}'s Input Monitoring must be on or off`);
  }

  check(Array.isArray(track.clips), `${what}'s Clips must be a list`);
  for (const clip of track.clips) checkClip(clip, track.kind, ids, what);
}

/** A device by name or the default, and no channels, one, or two different ones. */
function checkInput(input: unknown, what: string) {
  exactKeys(input, ["device", "channels"], `${what}'s Input`);
  check(
    input.device === null || (typeof input.device === "string" && input.device.length > 0),
    `${what}'s Input device must be a name, or null for the default input`,
  );
  const { channels } = input;
  if (channels === null) return;
  check(
    Array.isArray(channels) &&
      (channels.length === 1 || channels.length === 2) &&
      channels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= LIMITS.inputChannel),
    `${what}'s Input channels must be null, one channel or a pair, each a whole number from 0 to ${LIMITS.inputChannel}`,
  );
  check(channels.length === 1 || channels[0] !== channels[1], `${what}'s Input pair must be two different channels`);
}

function checkBus(bus: unknown, ids: Set<string>): asserts bus is Bus {
  exactKeys(bus, ["id", "name", "mixer", "insertChain", "output", "sends", "automation"], "A Bus");
  isId(bus.id, ids, "Bus");
  const what = `Bus ${String(bus.name)}`;
  isName(bus.name, "A Bus name");
  checkMixer(bus.mixer, what);
  checkInsertChain(bus.insertChain, ids, what);
  check(Array.isArray(bus.automation), `${what}'s Automation must be a list`);
}

/**
 * Every Track and Bus feeds the Master (null) or a Bus in the Project, each
 * of its Sends feeds a different Bus in the Project at a level from 0 to 2,
 * and no Bus feeds itself, directly or through other Buses, by outputs or
 * Sends.
 */
function checkRouting(project: Pick<Project, "tracks" | "buses">) {
  const buses = new Set(project.buses.map((bus) => bus.id));
  const channels: { name: string; output: unknown; sends: unknown; kind: string }[] = [
    ...project.tracks.map((track) => ({ name: track.name, output: track.output, sends: track.sends, kind: "Track" })),
    ...project.buses.map((bus) => ({ name: bus.name, output: bus.output, sends: bus.sends, kind: "Bus" })),
  ];
  for (const { name, output, sends, kind } of channels) {
    check(
      output === null || (typeof output === "string" && buses.has(output)),
      `${kind} ${name}'s output must be the Master (null) or a Bus in the Project, not ${JSON.stringify(output)}`,
    );
    checkSends(sends, buses, `${kind} ${name}`);
  }
  const loop = routingLoop(project);
  check(loop === null, `The Buses feed each other in a loop (${loop?.join(" → ")}), so the signal would never reach the Master`);
}

function checkSends(sends: unknown, buses: Set<string>, what: string): asserts sends is Send[] {
  check(Array.isArray(sends), `${what}'s Sends must be a list`);
  check(sends.length <= LIMITS.buses, `${what} has at most ${LIMITS.buses} Sends`);
  const to = new Set<string>();
  for (const send of sends as unknown[]) {
    exactKeys(send, ["busId", "level"], `${what}'s Send`);
    check(
      typeof send.busId === "string" && buses.has(send.busId),
      `${what}'s Send must feed a Bus in the Project, not ${JSON.stringify(send.busId)}`,
    );
    check(!to.has(send.busId), `${what} has two Sends to one Bus`);
    to.add(send.busId);
    inRange(send.level, LIMITS.volume, `${what}'s Send level`);
  }
}

function checkMixer(mixer: unknown, what: string): asserts mixer is Mixer {
  exactKeys(mixer, ["volume", "pan", "mute", "solo"], `${what}'s mixer`);
  inRange(mixer.volume, LIMITS.volume, `${what}'s volume`);
  inRange(mixer.pan, LIMITS.pan, `${what}'s pan`);
  check(typeof mixer.mute === "boolean", `${what}'s mute must be true or false`);
  check(typeof mixer.solo === "boolean", `${what}'s solo must be true or false`);
}

function checkInstrument(instrument: unknown, what: string): asserts instrument is Instrument {
  check(isObject(instrument), `${what}'s Instrument must be an object`);
  if (instrument.type === "plugin") {
    const vst3 = "vst3" in instrument ? ["vst3"] : [];
    exactKeys(instrument, ["type", "plugin", "settings", ...vst3], `${what}'s Plugin Instrument`);
    checkPlugin(instrument.plugin, "A Plugin Instrument's Plugin");
    checkPluginSettings(undefined, instrument.settings, "A Plugin Instrument's settings");
    checkVst3(instrument.plugin.id, instrument.vst3, "A Plugin Instrument");
    return;
  }
  const preset = instrument.preset;
  if (instrument.type === "synth") {
    exactKeys(instrument, ["type", "preset", "settings"], `${what}'s Synth`);
    checkSynthSettings(instrument.settings, `${what}'s Synth settings`);
  } else if (instrument.type === "drumSampler") {
    exactKeys(instrument, ["type", "preset", "pads"], `${what}'s Drum Sampler`);
    const pads = instrument.pads;
    check(
      Array.isArray(pads) && pads.length >= LIMITS.drumPads[0] && pads.length <= LIMITS.drumPads[1],
      `A Drum Sampler has ${LIMITS.drumPads[0]} to ${LIMITS.drumPads[1]} pads`,
    );
    const notes = new Set<number>();
    for (const pad of pads) {
      exactKeys(pad, ["name", "note", "sample", "volume", "pan", "pitch", "chokeGroup"], "A Drum Sampler pad");
      isName(pad.name, "A pad name");
      check(
        Number.isInteger(pad.note) && (pad.note as number) >= 0 && (pad.note as number) <= 127,
        "A pad's note must be a MIDI note number from 0 to 127",
      );
      check(!notes.has(pad.note as number), `Two pads answer to note ${String(pad.note)}`);
      notes.add(pad.note as number);
      check(pad.sample === null || typeof pad.sample === "string", "A pad's sample must be a file or null");
      inRange(pad.volume, LIMITS.volume, "A pad's volume");
      inRange(pad.pan, LIMITS.pan, "A pad's pan");
      inRange(pad.pitch, LIMITS.padPitch, "A pad's pitch");
      const [, maxGroup] = LIMITS.chokeGroup;
      check(
        Number.isInteger(pad.chokeGroup) && (pad.chokeGroup as number) >= 0 && (pad.chokeGroup as number) <= maxGroup,
        `A pad's choke group must be a whole number from 0 to ${maxGroup}`,
      );
    }
  } else {
    check(false, `${what}'s Instrument must be the Synth, the Drum Sampler or a Plugin`);
  }
  check(preset === null || typeof preset === "string", "A preset must be a name or null");
}

function checkClip(clip: unknown, trackKind: Track["kind"], ids: Set<string>, what: string): asserts clip is Clip {
  check(isObject(clip), "A Clip must be an object");
  if (trackKind === "audio") {
    check(clip.kind === "audio", `${what} is an Audio Track, so it only holds Audio Clips`);
    exactKeys(clip, ["id", "kind", "start", "duration", "file", "fileOffset"], "An Audio Clip");
    check(typeof clip.file === "string" && clip.file.length > 0, "An Audio Clip needs a file");
    check(
      typeof clip.duration === "number" && Number.isFinite(clip.duration) && clip.duration > 0,
      "An Audio Clip's duration must be a number of seconds above 0",
    );
    inRange(clip.fileOffset, [0, Number.MAX_VALUE], "An Audio Clip's file offset");
  } else {
    check(clip.kind === "pattern", `${what} is an Instrument Track, so it only holds Pattern Clips`);
    exactKeys(clip, ["id", "kind", "start", "length", "notes"], "A Pattern Clip");
  }
  isId(clip.id, ids, "Clip");
  isTick(clip.start, "A Clip's start");
  if (clip.kind === "pattern") {
    isTick(clip.length, "A Clip's length", { positive: true });
    check(Array.isArray(clip.notes), "A Pattern Clip's notes must be a list");
    for (const note of clip.notes) checkNote(note, clip.length as number);
  }
}

function checkNote(note: unknown, clipLength: number): asserts note is Note {
  exactKeys(note, ["pitch", "start", "length", "velocity"], "A note");
  check(
    Number.isInteger(note.pitch) && (note.pitch as number) >= 0 && (note.pitch as number) <= 127,
    "A note's pitch must be a MIDI note number from 0 to 127",
  );
  isTick(note.start, "A note's start");
  check((note.start as number) < clipLength, "A note must start inside its Clip");
  isTick(note.length, "A note's length", { positive: true });
  inRange(note.velocity, LIMITS.velocity, "A note's velocity");
}

function checkInsertChain(chain: unknown, ids: Set<string>, what: string) {
  check(Array.isArray(chain), `${what}'s Insert Chain must be a list`);
  check(chain.length <= LIMITS.effects, `${what}'s Insert Chain can hold at most ${LIMITS.effects} Effects`);
  for (const effect of chain) checkEffect(effect, ids);
}

function checkEffect(effect: unknown, ids: Set<string>): asserts effect is Effect {
  const plugin = isObject(effect) && effect.type === "plugin";
  const vst3 = plugin && "vst3" in effect ? ["vst3"] : [];
  exactKeys(effect, ["id", "type", "bypassed", ...(plugin ? ["plugin"] : []), "settings", ...vst3], "An Effect");
  isId(effect.id, ids, "Effect");
  check(typeof effect.bypassed === "boolean", "An Effect's bypass must be true or false");
  if (plugin) {
    checkPlugin(effect.plugin);
    checkPluginSettings(undefined, effect.settings);
    checkVst3(effect.plugin.id, effect.vst3, "A Plugin Effect");
    return;
  }
  check(
    typeof effect.type === "string" && (EFFECT_TYPES as readonly string[]).includes(effect.type),
    "An Effect must be an EQ, Compressor, Reverb, Delay or Plugin",
  );
  checkEffectSettings(effect.type as EffectType, effect.settings);
}

/**
 * The Synth's settings are exactly what its table declares, each within the
 * range the table gives and, where it picks from a list, one of the names on
 * it.
 */
function checkSynthSettings(settings: unknown, what: string): asserts settings is Record<string, unknown> {
  exactKeys(
    settings,
    SYNTH_PARAMS.map((param) => param.name),
    what,
  );
  for (const param of SYNTH_PARAMS) {
    const value = settings[param.name];
    if (param.choices.length > 0) {
      check(
        typeof value === "string" && param.choices.includes(value),
        `Synth ${param.name} must be one of ${param.choices.join(", ")}`,
      );
    } else {
      inRange(value, [param.min, param.max], `Synth ${param.name}`);
      if (param.step > 0) {
        check(
          Number.isInteger((value as number) / param.step),
          `Synth ${param.name} must be a multiple of ${param.step}`,
        );
      }
    }
  }
}

/**
 * Which Plugin a Plugin Effect is: its id and version, as its manifest
 * gives them. Whether this machine has it installed doesn't matter here: a
 * Project using a missing Plugin still opens.
 */
function checkPlugin(plugin: unknown, what = "A Plugin Effect's Plugin"): asserts plugin is PluginEffect["plugin"] {
  exactKeys(plugin, ["id", "version"], what);
  for (const key of ["id", "version"] as const) {
    const value = plugin[key];
    check(
      typeof value === "string" && value.length > 0 && value.length <= LIMITS.pluginId,
      `A Plugin's ${key} must be 1 to ${LIMITS.pluginId} characters`,
    );
  }
}

/**
 * A VST3 Plugin's own part, which it has exactly when its id says it is one:
 * its name and vendor, and its two states in base64, each at most
 * `LIMITS.vst3State` once decoded. Never a path: it is found by class id
 * wherever it is installed.
 */
function checkVst3(id: string, vst3: unknown, what: string) {
  if (!isVst3Id(id)) {
    check(vst3 === undefined, `${what} that isn't a VST3 Plugin has no VST3 part`);
    return;
  }
  exactKeys(vst3, ["name", "vendor", "state"], `${what}'s VST3 part`);
  isName(vst3.name, `${what}'s VST3 name`);
  check(
    typeof vst3.vendor === "string" && vst3.vendor.length <= LIMITS.nameLength,
    `${what}'s VST3 vendor must be at most ${LIMITS.nameLength} characters`,
  );
  exactKeys(vst3.state, ["component", "controller"], `${what}'s VST3 state`);
  const largest = Math.ceil(LIMITS.vst3State / 3) * 4;
  for (const part of ["component", "controller"] as const) {
    const value = vst3.state[part];
    check(
      typeof value === "string" && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
      `${what}'s VST3 ${part} state must be base64`,
    );
    check(value.length <= largest, `${what}'s VST3 ${part} state must be at most 16 MB`);
  }
}

/**
 * A Plugin's settings: numbers by name. With its manifest they must
 * be exactly what it declares, in range, as a built-in's are; without one
 * (its Plugin is missing) they are only checked to be numbers, and kept.
 */
function checkPluginSettings(
  manifest: PluginManifest | undefined,
  settings: unknown,
  unnamed = "A Plugin Effect's settings",
): asserts settings is Record<string, number> {
  const what = manifest ? `${manifest.name} settings` : unnamed;
  check(isObject(settings), `${what} must be an object`);
  const entries = Object.entries(settings);
  check(entries.length <= LIMITS.pluginSettings, `${what} can have at most ${LIMITS.pluginSettings} settings`);
  for (const [name, value] of entries) {
    check(typeof value === "number" && Number.isFinite(value), `${what}: ${name} must be a number`);
  }
  if (!manifest) return;
  exactKeys(
    settings,
    manifest.settings.map((param) => param.name),
    what,
  );
  for (const param of manifest.settings) inRange(settings[param.name], [param.min, param.max], `${manifest.name} ${param.name}`);
}

function checkEffectSettings(type: EffectType, settings: unknown): asserts settings is Record<string, unknown> {
  const what = `${EFFECT_NAMES[type]} settings`;
  const params = effectParams(type);
  exactKeys(
    settings,
    params.map((param) => param.name),
    what,
  );
  for (const param of params) {
    const value = settings[param.name];
    if (param.choices.length > 0) {
      check(
        typeof value === "string" && param.choices.includes(value),
        `${EFFECT_NAMES[type]} ${param.name} must be one of ${param.choices.join(", ")}`,
      );
    } else {
      inRange(value, [param.min, param.max], `${EFFECT_NAMES[type]} ${param.name}`);
    }
  }
}

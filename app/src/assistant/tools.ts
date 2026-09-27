/**
 * The tools the Assistant can call, and what each one does to the Project.
 *
 * Every tool turns into `commands.ts` commands — the same ones the UI uses —
 * so the Assistant can do nothing the musician couldn't do by hand, and
 * everything it does undoes. Nothing here talks to Claude: a tool call is
 * just a name and some JSON, whether it came from the model or from a test.
 *
 * `analyse_audio` is the one tool that changes nothing: its plan says what to
 * listen to, and the Assistant renders and measures it.
 *
 * A Request starts with the core tools only: reading, Tracks, Clips, the
 * mixer basics and listening. The rest are in groups, and `load_tools` adds
 * one to the Request, so a Request sends only the definitions it needs.
 *
 * Tool inputs arrive from a language model, so they are checked here before
 * they become commands. A call that doesn't check out changes nothing and is
 * reported back to the model to try again.
 */
import type { AnalysisRange } from "../audio/audio-analyser";
import { LISTENING } from "../audio/listening";
import { EFFECT_NAMES, EFFECT_TYPES, effectParams } from "../effect/effect-params";
import { effectPresets } from "../effect/effect-presets";
import {
  createPluginEffect,
  effectName,
  effectTable,
  isMissingPlugin,
  type TableParam,
} from "../effect/effect-table";
import { clipFileName, songEndTick } from "../export/mix-exporter";
import {
  createPluginInstrument,
  instrumentName,
  isMissingInstrument,
  pluginInstrumentTable,
} from "../instrument/instrument-table";
import { SYNTH_PARAMS } from "../instrument/synth-params";
import { synthPresetNames } from "../instrument/synth-presets";
import { BUNDLED_KIT, type SavedKit } from "../kit/kit-library";
import { formatDb } from "../mixer/level";
import {
  findPreset,
  instrumentPresetTarget,
  presetsFor,
  presetTargetOf,
  synthPresetCommand,
  targetName,
  type ListedPreset,
  type PresetSettings,
  type PresetTarget,
  type UserPreset,
} from "../preset/preset-library";
import {
  type AutomatableSetting,
  type AutomationOwner,
  automatableSettings,
  PAD_PARAMS,
  parsePadSetting,
} from "../project/automation";
import { arrange, type ArrangementEdit, arrangementProblem } from "../project/arrangement";
import type { ChainTarget, Command } from "../project/commands";
import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import {
  createAudioTrack,
  createBus,
  createDrumTrack,
  createEffect,
  createInstrumentTrack,
  isVst3Id,
  newId,
  STARTER_KIT_PRESET,
  type AudioClip,
  type AudioTrack,
  type AutomatedSetting,
  type Automation,
  type Breakpoint,
  type Bus,
  type Clip,
  clipEnd,
  type DrumPad,
  type Effect,
  type InstrumentTrack,
  type PluginInstrument,
  type Note,
  type PatternClip,
  type Project,
  type Section,
  type TempoChange,
  type Track,
  type Vst3Part,
} from "../project/model";
import { installedPlugin } from "../plugin/plugins";
import {
  DEFAULT_SEND_LEVEL,
  findBus as busById,
  outputName,
  routingProblem,
  sendProblem,
  type Channel as Feeder,
} from "../project/routing";
import { overlappingSection, sectionBarsText, sectionEndBar, sectionTicks } from "../project/sections";
import {
  BEAT_UNITS,
  barBeatTick,
  barTicks,
  formatPosition,
  isBarLine,
  roundSeconds,
  sameSignature,
  secondsAt,
  secondsBetween,
  segmentAt,
  signatureAt,
  type TempoMap,
  tempoMapOf,
  tickAfter,
  tickAt,
  tickAtBars,
  TICKS_PER_BEAT,
  type TimeSignature,
} from "../project/time";
import { LIMITS } from "../project/validate";
import { merged, noteKey, PIANO_SNAPS, quantiseNotes } from "../song/piano-roll";
import { STEP_VELOCITY } from "../song/step-grid";
import { copyOf } from "../song/timeline-view";
import type { SampleFolder, SampleRef } from "../samples/sample-source";
import { fileName } from "../storage/project-folder";
import { placeStems, STEM_LABELS, STEM_TRACK_ORDER } from "../stems/place-stems";
import { STEM_NAMES, type Stem, type StemName } from "../stems/stem-separator";
import { type AudioFileLength, EMPTY_LIBRARY, type LibraryContents } from "./library";
import { automationDetail, channelDetail, inRange, noteIds, notesDetail, type TickRange } from "./read";

/** A tool call, as the model sends it. */
export interface ToolCall {
  /** The model's own id for the call, which its result quotes back. */
  id: string;
  name: string;
  input: unknown;
}

/** What one accepted tool call does. */
export interface ToolPlan {
  /** Applied together with the rest of the Request, as one undo step. */
  commands: Command[];
  /**
   * One line of the summary the musician reads afterwards, or none for a
   * tool that only listens.
   */
  change?: string;
  /** What the model is told, including any id it will need next. */
  report: string;
  /**
   * What to render and measure, for `analyse_audio`: the measurements go to
   * the model after `report`.
   */
  listen?: AnalysisRange;
  /**
   * With `listen.audio`, what the attached audio is of: all of the range, or
   * its first `LISTENING.maxSeconds` and where it was cut.
   */
  audioNote?: string;
  /** What `listen` hears, for the analysis the Request keeps and compares. */
  heard?: Heard;
  /**
   * The two analyses to compare, for `compare_audio`, by id: left out,
   * the first and latest of the same target and range.
   */
  compare?: { before?: string; after?: string };
  /**
   * The Reference Track to set `listen`'s mix against, for
   * `compare_to_reference`: its file in the Project, and its name.
   */
  reference?: { file: string; name: string };
  /** The group `load_tools` adds, for the rest of the Request. */
  load?: ToolGroup;
  /**
   * What to save into the app's library, for `save_preset` and `save_kit`:
   * outside the Project, so not undone with the Request. `commands` is empty.
   */
  save?: { preset: { target: PresetTarget; name: string; settings: PresetSettings } } | { kit: { name: string; pads: DrumPad[] } };
  /**
   * A saved Kit to put on a Drum Sampler, for `set_instrument`: its samples
   * are read from the library and copied into the Project first, and the
   * command that loads its Pads is then executed. `commands` is empty.
   */
  loadKit?: { trackId: string; kit: SavedKit };
  /**
   * The sample folders to list, for `list_samples`: the Request reads each
   * one's files, or why it couldn't, and `report` says what is in them.
   * Changes nothing.
   */
  listSamples?: { folders: SampleFolder[]; report: (files: readonly (readonly string[] | Error)[]) => string };
  /**
   * A sample from the sample browser to copy into the Project, for
   * `place_audio_clip`: the Request copies it in, as a drop does, and
   * `next` gives the plan that places the copy. `commands` is empty.
   */
  copySample?: { sample: SampleRef; next: (copied: AudioFileLength) => ToolPlan };
  /**
   * An Audio Clip to separate into its Stems, for `separate_stems`: the
   * Request separates the stretch it plays, which takes a while, and `next`
   * places the Stems it gives in its place (`placeStems`), clear of the
   * loaded audio as it is then, with the Stems' audio to add to it.
   * `commands` is empty.
   */
  separate?: { clip: AudioClip; next: (stems: readonly Stem[], samples: LoadedSamples) => SeparatedPlan };
}

/** The plan placing a separation's Stems, and their audio, by the path each Stem Clip names. */
export interface SeparatedPlan {
  plan: ToolPlan;
  samples: ReadonlyMap<string, LoadedSample>;
}

/** What an `analyse_audio` call heard, in words, and which of the song it was. */
export interface Heard {
  /** The Track heard on its own, or null for the whole mix. */
  trackId: string | null;
  /** "the whole mix", or the Track on its own. */
  what: string;
  /** Where in the song, as bar.beat and seconds: "from 1.1.000 (0 s) to 2.1.000 (2 s)". */
  span: string;
}

/** A tool call that can't be carried out. Nothing changes; the model is told. */
export class InvalidToolCall extends Error {}

function reject(message: string): never {
  throw new InvalidToolCall(message);
}

/**
 * The groups of tools past the core, and what each is for, as the model is
 * told. A group with no tools yet is still listed: the slices that fill it
 * come later, and the model is told it is empty.
 */
export const TOOL_GROUPS = {
  notes: "writing and editing a Pattern Clip's notes",
  routing: "Buses, where each Track and Bus outputs, and Sends",
  automation: "Automation: the breakpoints that move a setting while the song plays",
  time: "the tempo, Tempo Changes and time signatures",
  sounds: "Instruments, Effects and Presets: what a Track plays and what its Insert Chain does to it",
  audio_clips:
    "Audio Clips on Audio Tracks: placing a sample from the sample browser's folders or one of the Project's audio files, trimming and copying one, and separating one into its Stems",
  arrangement:
    "Sections, the named parts of the song, and arranging it: copying Clips, inserting and deleting bars, and duplicating and moving a Section with everything in it",
} as const;

export type ToolGroup = keyof typeof TOOL_GROUPS;

const GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroup[];

interface Tool {
  /** The group `load_tools` adds it with, or none for a core tool, which every Request has. */
  group?: ToolGroup;
  /** For a core tool the smaller core leaves out, the group it comes with there instead. */
  smallCoreGroup?: ToolGroup;
  description: string;
  /** JSON Schema, as sent to the model. */
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  /**
   * What a model the Request doesn't send audio is sent instead, for a tool
   * with an argument that attaches it (`analyse_audio`'s `listen`).
   */
  unheard?: { description: string; schema: Tool["schema"] };
  /** `library` is the musician's User Presets and saved Kits, from outside the Project. */
  plan: (input: Record<string, unknown>, project: Project, library: LibraryContents) => ToolPlan;
}

/**
 * How high a mix's true peak may go, in dBTP. A true peak between it and
 * 0 dBTP clips no samples, but still overshoots once the song is converted
 * (to MP3 or AAC, or resampled by a player). The system prompt and
 * `analyse_audio`'s description both give it, and every analysis says
 * where its true peak is against it (`truePeakNote`).
 */
export const TRUE_PEAK_CEILING_DBTP = -1;

/** What `analyse_audio`'s report says when it asks for a spectrogram; `withoutImage` takes it back out. */
export const SPECTROGRAM_ATTACHED = " (the spectrogram is attached)";

/** What `analyse_audio`'s report says when it asks for the audio; `withoutAudio` takes it back out. */
export const AUDIO_ATTACHED = " (the audio is attached)";

/** How `analyse_audio`'s line on its attached audio starts; `withoutAudio` takes it out too. */
export const AUDIO_NOTE_START = "The audio attached is";

/** The audio `analyse_audio` attaches, in words, from `LISTENING`. */
const LISTENING_TEXT = `a ${LISTENING.format.toUpperCase()} file, mono at ${LISTENING.sampleRate / 1000} kHz, of at most the first ${LISTENING.maxSeconds} s of the range`;

const CEILING = `the ceiling of ${TRUE_PEAK_CEILING_DBTP} dBTP`;

/**
 * What an analysis's true peak is against the ceiling, for the model to read
 * after the measurements; nothing for silence, which has no peak.
 * `measurements` is the engine's JSON, so the verdict is on the same
 * rounded number the model sees.
 */
export function truePeakNote(measurements: string): string | null {
  const measured = JSON.parse(measurements) as { true_peak_dbtp: number | null; clipping: { clipped_samples: number } };
  const peak = measured.true_peak_dbtp;
  if (peak === null) return null;
  const truePeak = `the true peak, ${peak} dBTP,`;
  if (peak <= TRUE_PEAK_CEILING_DBTP) return `The true peak, ${peak} dBTP, is within ${CEILING}.`;
  const clipped = measured.clipping.clipped_samples;
  if (clipped === 0) return `No samples clip, but ${truePeak} is above ${CEILING}: it would still overshoot once the song is converted.`;
  return `${clipped} ${clipped === 1 ? "sample clips" : "samples clip"}, and ${truePeak} is above ${CEILING}.`;
}

/** A list of notes, as `place_clip` and `set_pattern_notes` take them. */
const NOTES_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      pitch: {
        type: "integer",
        minimum: LIMITS.pitch[0],
        maximum: LIMITS.pitch[1],
        description: "MIDI note number: 60 is middle C. On a Drum Sampler, the note of the Pad to play.",
      },
      start: { type: "integer", minimum: 0, description: "Ticks from the start of the Clip; inside the Clip." },
      length: { type: "integer", minimum: 1, description: "In ticks." },
      velocity: {
        type: "number",
        minimum: LIMITS.velocity[0],
        maximum: LIMITS.velocity[1],
        description: `How hard it is played. Left out, ${STEP_VELOCITY}.`,
      },
    },
    required: ["pitch", "start", "length"],
    additionalProperties: false,
  },
};

const NOTE_KEYS = Object.keys(NOTES_SCHEMA.items.properties);

const PATTERN_CLIP_SCHEMA = { type: "string", description: "The Pattern Clip's id, as listed in the Project." };

const NOTE_IDS_SCHEMA = {
  type: "array",
  minItems: 1,
  items: { type: "string" },
  description: "Which notes, by the ids read_notes gives.",
};

/** How the note tools' ticks count, for their descriptions. */
const NOTE_TICKS_TEXT = `Note starts are ticks from the start of the Clip, and lengths ticks: ${TICKS_PER_BEAT} to a beat (a 1/4 note), ${TICKS_PER_BEAT / 4} to a 1/16, and ${TICKS_PER_BEAT * 4} to a bar of 4/4 (a bar is the ticksPerBar of its time signature), so bar n of a Clip that starts on a bar line starts at (n - 1) * ticksPerBar.`;

/** What an edit tool's result says about the notes it leaves. */
const NEW_IDS_TEXT =
  "It reports the notes it changed with their ids, which change when a note moves. A note moved onto another's pitch and start replaces it, as in the Piano Roll.";

/** The Piano Roll's snap grids, bar "off", as quantise_notes takes them. */
const QUANTISE_GRIDS = PIANO_SNAPS.filter((snap) => snap.id !== "off");

/** The first and last tick of the notes a note tool takes by range, as read_notes has them. */
const NOTE_RANGE_PROPERTIES = {
  start: {
    type: "integer",
    minimum: 0,
    description: "The first tick, from the start of the Clip, of the notes to change: those that start from here. Left out, the start of the Clip.",
  },
  end: {
    type: "integer",
    minimum: 0,
    description: "The tick, from the start of the Clip, to change notes starting up to but not including. Left out, the end of the Clip.",
  },
};

const CHANNEL_SCHEMA = {
  type: "string",
  description: 'Whose Insert Chain: a Track\'s or a Bus\'s id, as listed in the Project, or "master" for the Master.',
};

const BUS_ID_SCHEMA = { type: "string", description: "The Bus's id, as listed in the Project." };

/** A channel that feeds others: the Master feeds nothing, so it has no output or Sends. */
const FEEDER_SCHEMA = { type: "string", description: "Which channel: a Track's or a Bus's id, as listed in the Project." };

const EFFECT_ID_SCHEMA = { type: "string", description: "The Effect's id, as listed in the Project." };

/** An Effect's settings by name; which names depends on the Effect, so they are listed in the description. */
const SETTINGS_SCHEMA = { type: "object", additionalProperties: { type: ["number", "string"] } };

/**
 * Every Effect's settings and what each may be, read from the Effects' own
 * tables so an Effect that is added or changed is described without touching
 * the tools.
 */
const EFFECT_SETTINGS_TEXT = `Each Effect's settings, and the values they take: ${EFFECT_TYPES.map(
  (type) => `${EFFECT_NAMES[type]} (${type}): ${effectParams(type).map(paramText).join(", ")}.`,
).join(" ")}`;

/** Each Effect's factory Presets, for the tools that load one. */
const EFFECT_PRESETS_TEXT = EFFECT_TYPES.filter((type) => effectPresets(type).length > 0)
  .map((type) => {
    const presets = effectPresets(type).map((preset) => `“${preset.name}” (${preset.description})`);
    return `${EFFECT_NAMES[type]}: ${presets.join(", ")}.`;
  })
  .join(" ");

const AUTOMATION_CHANNEL_SCHEMA = {
  type: "string",
  description: 'Whose setting: a Track\'s or a Bus\'s id, as listed in the Project, or "master" for the Master.',
};

const AUTOMATION_SETTING_SCHEMA = {
  type: "string",
  description:
    "The setting, as the summary and read_automation name it: volume, pan, send:<busId>, effect:<effectId>:<setting>, instrument:<setting> or, for a Drum Sampler's Pad, instrument:pad<note>.<setting>.",
};

/** A numeric setting's name and range, for the settings Automation can move. */
function numericParamsText(params: readonly TableParam[]): string {
  return params
    .filter((param) => param.choices.length === 0)
    .map((param) => `${param.name} (${withUnit(param.min, param.unit)} to ${withUnit(param.max, param.unit)})`)
    .join(", ");
}

/**
 * What a setting Automation moves is called, and the values each takes, read
 * from the Effects' and the Synth's own tables as the other tools' are.
 */
const AUTOMATABLE_TEXT = `The setting is named as the summary and read_automation name it, and each takes values in its own units and range: volume, a linear gain from 0 to 2 (1 is unity, 0.5 about -6 dB, 0 silent); pan, from -1 (left) to 1 (right), which the Master hasn't; send:<busId>, the level of its Send to that Bus, a linear gain from 0 to 2; effect:<effectId>:<setting>, a number of one of its own Effects; instrument:<setting>, a number of its Synth or Plugin Instrument; and instrument:pad<note>.<setting>, a number of its Drum Sampler's Pad that the note plays. The Effects' numbers: ${EFFECT_TYPES.map(
  (type) => `${EFFECT_NAMES[type]} (${type}): ${numericParamsText(effectParams(type))}.`,
).join(" ")} The Synth's: ${numericParamsText(SYNTH_PARAMS)}. A Pad's: ${PAD_PARAMS.map((param) => `${param.name} (${withUnit(param.min, param.unit)} to ${withUnit(param.max, param.unit)})`).join(", ")}, so a Kick on note 36 has instrument:pad36.volume. A Plugin's take the ranges its Plugin declares. read_channel gives each setting's value now. Mute, solo, bypass and settings that pick from a list or switch on and off are never automated.`;

/** How a sample from the sample browser is named to place_audio_clip, before its folder and path. */
const LIBRARY_PREFIX = "library:";

/**
 * The most files one list_samples call returns, so a big sample library
 * can't fill the model's context: about 200 paths is 6,000 characters, and
 * folder and match narrow it.
 */
export const MAX_LISTED_SAMPLES = 200;

const NO_SAMPLE_BROWSER =
  "The sample browser isn't available here (the browser version of Soundcheck has none), so only the Project's own audio files can be placed.";

/** What `analyse_audio` says of itself, whether or not the model is sent audio. */
const ANALYSE_AUDIO_DESCRIPTION = [
  "Listen to the song: the Audio Engine renders it offline and measures it, returning loudness (integrated and short-term LUFS, RMS), sample and true peaks, clipping (how many samples, and where), energy per frequency band, the detected key and tempo, and where sounds start (onsets). Positions come back in seconds and as bar.beat.",
  "Call it only when the Request needs to hear the song: a question about how it sounds (\"is anything clipping?\", \"why does it sound muddy?\"), or a fix that depends on the sound, and then again afterwards, of the same Track or mix and range, to check the fix worked: compare_audio then gives the differences.",
  "Each result has an analysisId, which compare_audio takes, and is kept for the rest of the Request.",
  `The mix's true peak should end at or below ${CEILING}, and each result says whether it does: above it, the mix is too loud even when no samples clip. To fix that, hear each Track on its own as well as the mix, and turn down the Track that is too loud rather than the Master.`,
  "Do not call it for a Request the Project's data already answers, such as setting the tempo, adding, renaming or deleting a Track, or setting a volume to a value the musician gave: rendering takes time, and it changes nothing.",
  "Leave out trackId for the whole mix through the Master, and start and end for the whole song.",
];

const SPECTROGRAM_DESCRIPTION =
  "Set spectrogram to also see the sound as an image: a spectrogram of the same render, frequency (Hz, log scale) against bars and beats, with the waveform above it (red where it clips) and a dB colour scale. Ask for it only when the numbers aren't enough, such as where in the song the mix gets muddy or which frequencies a Track fills: an image costs far more than the numbers.";

/** `analyse_audio`'s arguments but `listen`, which only a model sent audio has. */
const ANALYSE_AUDIO_PROPERTIES = {
  trackId: {
    type: "string",
    description:
      "One Track, Instrument or Audio, to hear on its own, through its Insert Chain, its mixer channel and the Master, straight from its fader: not through any Bus it feeds or sends to. Left out, the whole mix.",
  },
  start: {
    type: "number",
    minimum: 0,
    description:
      "Where to start, in ticks: for a bar, its tick under the Tempo Changes. Left out, the start of the song.",
  },
  end: {
    type: "number",
    minimum: 0,
    description: "Where to stop, in ticks. Left out, the end of the last Clip.",
  },
  spectrogram: {
    type: "boolean",
    description: "Also return a spectrogram image of what was heard. Left out, the measurements only.",
  },
};

const TOOLS = {
  read_channel: {
    description:
      "Read a Track's, a Bus's or the Master's settings in full, which the Project summary leaves out: its volume, pan, mute and solo, its Instrument with its preset and every setting (a Drum Sampler's Pads, by note), its Insert Chain with each Effect's settings, its output and each Send's level, and which of its settings are automated. Changes nothing.",
    schema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: 'Whose settings: a Track\'s or a Bus\'s id, as listed in the Project, or "master" for the Master.',
        },
      },
      required: ["channel"],
      additionalProperties: false,
    },
    plan(input, project) {
      const channel = findChannel(input.channel, project);
      return {
        commands: [],
        report: `${channel.id}, in full:\n${JSON.stringify(channelDetail(project, channelModel(channel, project)))}`,
      };
    },
  },

  read_automation: {
    smallCoreGroup: "automation",
    description:
      "Read the Automation of a Track's, a Bus's or the Master's settings: each automated setting's breakpoints, in tick order, as {tick, value, hold}. The Project summary lists which settings are automated but not their breakpoints. Changes nothing.",
    schema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: 'Whose Automation: a Track\'s or a Bus\'s id, as listed in the Project, or "master" for the Master.',
        },
        setting: {
          type: "string",
          description: "One automated setting, as the summary lists it, e.g. volume or effect:<effectId>:<setting>. Left out, every one the channel automates.",
        },
        start: {
          type: "integer",
          minimum: 0,
          description: "The first tick, from the top of the song, of the breakpoints to read. Left out, the start of the song.",
        },
        end: {
          type: "integer",
          minimum: 0,
          description: "The tick, from the top of the song, to read up to but not including. Left out, the end of the Automation.",
        },
      },
      required: ["channel"],
      additionalProperties: false,
    },
    plan(input, project) {
      const channel = findChannel(input.channel, project);
      const range = checkTickRange(input);
      const automation = automationOf(channel, project);
      if (automation.length === 0) {
        return { commands: [], report: `${channel.id} has no Automation: none of its settings is automated.` };
      }
      let lanes = automation;
      if (input.setting !== undefined) {
        lanes = automation.filter((lane) => lane.setting === input.setting);
        if (lanes.length === 0) {
          const settings = automation.map((lane) => lane.setting).join(", ");
          reject(`${channel.id} has no Automation of ${JSON.stringify(input.setting)}. Its automated settings are: ${settings}.`);
        }
      }
      return {
        commands: [],
        report: `${channel.id}'s Automation${readRangeText(range, "of the song")}:\n${JSON.stringify(automationDetail(lanes, range))}`,
      };
    },
  },

  read_notes: {
    description:
      "Read a Pattern Clip's notes, which the Project summary only counts: each with its id, pitch, start (in ticks from the start of the Clip), length and velocity, in order of start and then pitch. A note's id is its start and pitch, as <start>:<pitch>, so it stays the same while other notes change. Changes nothing.",
    schema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "The Pattern Clip's id, as listed in the Project." },
        start: {
          type: "integer",
          minimum: 0,
          description: "The first tick, from the start of the Clip, of the notes to read: those that start from here. Left out, the start of the Clip.",
        },
        end: {
          type: "integer",
          minimum: 0,
          description: "The tick, from the start of the Clip, to read notes starting up to but not including. Left out, the end of the Clip.",
        },
      },
      required: ["clipId"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findClip(input.clipId, project);
      if (clip.kind !== "pattern") reject(`Clip ${clip.id} is an Audio Clip: it has no notes`);
      const range = checkTickRange(input);
      const notes = notesDetail(clip, range);
      const counted = notes.length === clip.notes.length ? `its ${clip.notes.length}` : `${notes.length} of its ${clip.notes.length}`;
      return {
        commands: [],
        report: `Clip ${clip.id} on Track ${track.id} (“${track.name}”), ${counted} ${clip.notes.length === 1 ? "note" : "notes"}${readRangeText(range, "of the Clip")}:\n${JSON.stringify(notes)}`,
      };
    },
  },

  create_track: {
    description:
      "Add a Track to the Project. An Instrument Track plays Pattern Clips through its own Instrument (a Synth by default); an Audio Track holds recorded or imported audio.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "What to call the Track, e.g. \"Kick\" or \"Bass\"." },
        kind: { type: "string", enum: ["instrument", "audio"], description: "The kind of Track." },
        index: {
          type: "integer",
          minimum: 0,
          description: "Where in the Track list to put it. Left out, it goes at the end.",
        },
      },
      required: ["name", "kind"],
      additionalProperties: false,
    },
    plan(input, project) {
      const name = checkName(input.name, "name");
      const kind = checkChoice(input.kind, ["instrument", "audio"] as const, "kind");
      const index = input.index === undefined ? undefined : checkIndex(input.index, project.tracks.length);
      const track = kind === "instrument" ? createInstrumentTrack(name, newId()) : createAudioTrack(name, newId());
      return {
        commands: [{ type: "addTrack", track, index }],
        change: `Added the ${kindName(kind)} Track “${name}”`,
        report: `Added the ${kindName(kind)} Track “${name}”, whose trackId is ${track.id}.`,
      };
    },
  },

  rename_track: {
    description: "Change a Track's name.",
    schema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "The Track's id, as listed in the Project." },
        name: { type: "string", description: "The new name." },
      },
      required: ["trackId", "name"],
      additionalProperties: false,
    },
    plan(input, project) {
      const track = findTrack(input.trackId, project);
      const name = checkName(input.name, "name");
      return {
        commands: [{ type: "renameTrack", trackId: track.id, name }],
        change: `Renamed “${track.name}” to “${name}”`,
        report: `Track ${track.id} is now called “${name}”.`,
      };
    },
  },

  delete_track: {
    description: "Remove a Track from the Project, with everything on it.",
    schema: {
      type: "object",
      properties: { trackId: { type: "string", description: "The Track's id, as listed in the Project." } },
      required: ["trackId"],
      additionalProperties: false,
    },
    plan(input, project) {
      const track = findTrack(input.trackId, project);
      return {
        commands: [{ type: "deleteTrack", trackId: track.id }],
        change: `Deleted the Track “${track.name}”`,
        report: `Track ${track.id} (“${track.name}”) is gone.`,
      };
    },
  },

  set_instrument: {
    group: "sounds",
    description:
      "Choose an Instrument Track's Instrument and load one of its presets. The Synth's preset replaces all its settings; the Drum Sampler loads a Kit, the bundled one or one the musician saved, whose Pads each play on their own note; a Plugin Instrument starts from its defaults, or from one of the musician's User Presets for it, with any settings given here changed. Its notes stay on the Track.",
    schema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "The Instrument Track's id, as listed in the Project." },
        instrument: {
          type: "string",
          description:
            "synth, drumSampler, or plugin:<id> for one of the installed Plugin Instruments listed after the Project.",
        },
        preset: {
          type: "string",
          description: `The preset to load. Synth: ${synthPresetNames().join(", ")}, or one of the musician's User Presets for the Synth. Drum Sampler: the ${STARTER_KIT_PRESET}, or one of the musician's saved Kits, listed after the Project, whose samples are copied into the Project. Plugin Instrument: one of the musician's User Presets for that Plugin. Left out, the Synth and a Plugin Instrument start from their defaults and the Drum Sampler from the ${STARTER_KIT_PRESET}.`,
        },
        settings: {
          ...SETTINGS_SCHEMA,
          description: "Only for a Plugin Instrument: settings to change from its defaults, or from the preset. Left out, none are changed.",
        },
      },
      required: ["trackId", "instrument"],
      additionalProperties: false,
    },
    plan(input, project, { userPresets, savedKits }) {
      const track = findInstrumentTrack(input.trackId, project);
      if (typeof input.instrument === "string" && input.instrument.startsWith("plugin:")) {
        return setPluginInstrument(track, input.instrument.slice("plugin:".length), input, userPresets);
      }
      if (input.settings !== undefined) {
        reject("settings are only for a Plugin Instrument: change the Synth with a preset, and the Drum Sampler's Pads on its panel");
      }
      const type = checkChoice(input.instrument, ["synth", "drumSampler"] as const, "instrument");

      if (type === "synth") {
        const preset = input.preset === undefined ? undefined : checkPreset(input.preset, "synth", userPresets);
        const commands: Command[] = [
          { type: "setInstrument", trackId: track.id, instrument: createInstrumentTrack(track.name).instrument },
        ];
        if (preset) commands.push(synthPresetCommand(track.id, preset));
        const loaded = preset ? `the Synth with its ${presetText(preset)}` : "the Synth, from its defaults";
        const settings = SYNTH_PARAMS.map((param) => param.name);
        const kept = track.instrument.type === "synth" ? synthOverridden(track.automation, settings) : instrumentGone(track);
        return {
          commands,
          change: `“${track.name}” plays ${loaded}`,
          report: `Track ${track.id} plays ${loaded}.${kept}`,
        };
      }

      const kit = input.preset === undefined ? BUNDLED_KIT : checkKit(input.preset, savedKits);
      if (kit !== BUNDLED_KIT) {
        return {
          commands: [],
          loadKit: { trackId: track.id, kit },
          change: `“${track.name}” plays the Drum Sampler with the saved Kit “${kit.name}”`,
          report: `Track ${track.id} plays the Drum Sampler with the saved Kit “${kit.name}”, whose samples are copied into the Project. Its Pads, by pitch: ${padsText(kit.pads)}.${padsOverridden(track, kit.pads)}`,
        };
      }
      const { instrument } = createDrumTrack(track.name);
      if (instrument.type !== "drumSampler") throw new Error("createDrumTrack made no Drum Sampler");
      return {
        commands: [{ type: "setInstrument", trackId: track.id, instrument }],
        change: `“${track.name}” plays the Drum Sampler with the ${STARTER_KIT_PRESET}`,
        report: `Track ${track.id} plays the Drum Sampler with the ${STARTER_KIT_PRESET}. Its Pads, by pitch: ${padsText(instrument.pads)}.${padsOverridden(track, instrument.pads)}`,
      };
    },
  },

  set_instrument_settings: {
    group: "sounds",
    description:
      "Change some of a Plugin Instrument's settings, within the ranges its Plugin declares; the rest stay as they are. The Synth changes with load_preset, and the Drum Sampler's Pads on its panel.",
    schema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "The Instrument Track playing the Plugin Instrument, by its id." },
        settings: { ...SETTINGS_SCHEMA, description: "The settings to change, by name, with their new values." },
      },
      required: ["trackId", "settings"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, instrument } = findPluginInstrument(input.trackId, project);
      const name = instrumentName(instrument);
      const settings = checkTableSettings(input.settings, name, pluginInstrumentTable(instrument)) as Record<string, number>;
      if (Object.keys(settings).length === 0) reject("settings must name at least one setting to change");
      return {
        commands: [{ type: "setInstrumentSettings", trackId: track.id, settings }],
        change: `Set the ${name} on “${track.name}”${instrumentSettingsText(instrument, settings, ": ")}`,
        report: `Track ${track.id}'s ${name} now has settings: ${JSON.stringify({ ...instrument.settings, ...settings })}.${synthOverridden(track.automation, Object.keys(settings))}`,
      };
    },
  },

  place_clip: {
    description:
      "Put a new Pattern Clip on an Instrument Track, optionally with its notes. Clips on one Track may overlap.",
    schema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "The Instrument Track's id, as listed in the Project." },
        start: {
          type: "integer",
          minimum: 0,
          description: "Where the Clip starts, in ticks from the top of the song.",
        },
        length: { type: "integer", minimum: 1, description: "How long the Clip is, in ticks." },
        notes: { ...NOTES_SCHEMA, description: "The Clip's notes. Left out, the Clip starts empty." },
      },
      required: ["trackId", "start", "length"],
      additionalProperties: false,
    },
    plan(input, project) {
      const track = findInstrumentTrack(input.trackId, project);
      const start = checkTicks(input.start, "start", 0);
      const length = checkTicks(input.length, "length", 1);
      const notes = input.notes === undefined ? [] : checkNotes(input.notes, length, track);
      const clip: PatternClip = { id: newId(), kind: "pattern", start, length, notes };
      return {
        commands: [{ type: "addClip", trackId: track.id, clip }],
        change: `Placed a Pattern Clip on “${track.name}” at ${formatPosition(start, tempoMapOf(project))}${noteCount(notes)}`,
        report: `Placed a Pattern Clip${noteCount(notes)} on Track ${track.id}, whose clipId is ${clip.id}.`,
      };
    },
  },

  set_pattern_notes: {
    group: "notes",
    description:
      "Replace all of a Pattern Clip's notes with these, to write a Clip from scratch. An empty list clears it. To change some of its notes, use the other notes tools, which keep the rest.",
    schema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "The Pattern Clip's id, as listed in the Project." },
        notes: { ...NOTES_SCHEMA, description: "Every note the Clip will hold." },
      },
      required: ["clipId", "notes"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findClip(input.clipId, project);
      if (track.kind !== "instrument" || clip.kind !== "pattern")
        reject(`Clip ${clip.id} is an Audio Clip: it has no notes`);
      const notes = checkNotes(input.notes, clip.length, track);
      return {
        commands: [{ type: "setPatternNotes", clipId: clip.id, notes }],
        change: `Wrote ${notes.length} ${notes.length === 1 ? "note" : "notes"} into a Clip on “${track.name}”`,
        report: `Clip ${clip.id} now holds ${notes.length} ${notes.length === 1 ? "note" : "notes"}.`,
      };
    },
  },

  add_notes: {
    group: "notes",
    description: `Add notes to a Pattern Clip, keeping those it has. A note added on another's pitch and start replaces it. ${NOTE_TICKS_TEXT} It reports the notes it added with their ids.`,
    schema: {
      type: "object",
      properties: {
        clipId: PATTERN_CLIP_SCHEMA,
        notes: { ...NOTES_SCHEMA, minItems: 1, description: "The notes to add." },
      },
      required: ["clipId", "notes"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findPatternClip(input.clipId, project);
      const notes = checkNotes(input.notes, clip.length, track);
      if (notes.length === 0) reject("notes must hold at least one note");
      return editNotes(track, clip, [], notes, {
        change: `Added ${notesText(notes.length)} to a Clip on “${track.name}”`,
        report: `Added ${notesText(notes.length)} to Clip ${clip.id}`,
      });
    },
  },

  delete_notes: {
    group: "notes",
    description: "Delete notes from a Pattern Clip, by their ids. The other notes keep theirs.",
    schema: {
      type: "object",
      properties: { clipId: PATTERN_CLIP_SCHEMA, noteIds: NOTE_IDS_SCHEMA },
      required: ["clipId", "noteIds"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findPatternClip(input.clipId, project);
      const chosen = new Set(findNotes(input.noteIds, clip));
      const notes = clip.notes.filter((_, index) => !chosen.has(index));
      return {
        commands: [{ type: "setPatternNotes", clipId: clip.id, notes }],
        change: `Deleted ${notesText(chosen.size)} from a Clip on “${track.name}”`,
        report: `Deleted ${notesText(chosen.size)} from Clip ${clip.id}, which now holds ${notesText(notes.length)}.`,
      };
    },
  },

  move_notes: {
    group: "notes",
    description: `Move notes of a Pattern Clip, by their ids, later or earlier by a number of ticks, up or down by a number of semitones, or both: 12 semitones is an octave. Each stays inside its Clip. ${NOTE_TICKS_TEXT} ${NEW_IDS_TEXT}`,
    schema: {
      type: "object",
      properties: {
        clipId: PATTERN_CLIP_SCHEMA,
        noteIds: NOTE_IDS_SCHEMA,
        ticks: { type: "integer", description: "How far to move them in time: later if positive, earlier if negative. Left out, 0." },
        semitones: { type: "integer", description: "How far to move them in pitch: up if positive, down if negative. Left out, 0." },
      },
      required: ["clipId", "noteIds"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findPatternClip(input.clipId, project);
      const indices = findNotes(input.noteIds, clip);
      if (input.ticks === undefined && input.semitones === undefined) reject("Give ticks, semitones or both to move the notes by");
      const ticks = input.ticks === undefined ? 0 : checkWhole(input.ticks, "ticks");
      const semitones = input.semitones === undefined ? 0 : checkWhole(input.semitones, "semitones");
      const ids = noteIds(clip.notes);
      const moved = indices.map((index) => {
        const note = clip.notes[index]!;
        const start = note.start + ticks;
        if (start < 0 || start >= clip.length) {
          reject(
            `Moving note ${ids[index]} by ${ticks} ticks would start it at ${start}, outside its Clip, whose notes start from 0 to ${clip.length - 1}`,
          );
        }
        return { ...note, start, pitch: checkPitch(note.pitch + semitones, `Moving note ${ids[index]} by ${semitones} semitones`) };
      });
      checkNotesPlayable(moved, track, (index) => `Note ${ids[indices[index]!]}`);
      const how = [ticks !== 0 && ticksText(ticks), semitones !== 0 && semitonesText(semitones)].filter(Boolean).join(" and ");
      return editNotes(track, clip, indices, moved, {
        change: `Moved ${notesText(moved.length)} in a Clip on “${track.name}”${how ? ` ${how}` : ""}`,
        report: `Moved ${notesText(moved.length)} in Clip ${clip.id}${how ? ` ${how}` : ""}`,
      });
    },
  },

  resize_notes: {
    group: "notes",
    description: `Make notes of a Pattern Clip, by their ids, longer or shorter: to a length in ticks, or by a number of ticks. Their starts stay. ${NOTE_TICKS_TEXT} Give length or by, not both.`,
    schema: {
      type: "object",
      properties: {
        clipId: PATTERN_CLIP_SCHEMA,
        noteIds: NOTE_IDS_SCHEMA,
        length: { type: "integer", minimum: 1, description: "Each note's new length, in ticks." },
        by: { type: "integer", description: "How many ticks to add to each note's length: shorter if negative." },
      },
      required: ["clipId", "noteIds"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findPatternClip(input.clipId, project);
      const indices = findNotes(input.noteIds, clip);
      if ((input.length === undefined) === (input.by === undefined)) reject("Give either length or by, not both or neither");
      const ids = noteIds(clip.notes);
      const length = input.length === undefined ? undefined : checkTicks(input.length, "length", 1);
      const by = input.by === undefined ? 0 : checkWhole(input.by, "by");
      const resized = indices.map((index) => {
        const note = clip.notes[index]!;
        const next = length ?? note.length + by;
        if (next < 1) reject(`Shortening note ${ids[index]}, ${note.length} ticks long, by ${-by} ticks would leave nothing of it`);
        return { ...note, length: next };
      });
      const how = length === undefined ? `by ${by} ticks` : `to ${length} ticks`;
      return editNotes(track, clip, indices, resized, {
        change: `Resized ${notesText(resized.length)} in a Clip on “${track.name}” ${how}`,
        report: `Resized ${notesText(resized.length)} in Clip ${clip.id} ${how}`,
      });
    },
  },

  set_note_velocity: {
    group: "notes",
    description: `Set how hard notes of a Pattern Clip, by their ids, are played: their velocity, from ${LIMITS.velocity[0]} to ${LIMITS.velocity[1]}. Lower is softer.`,
    schema: {
      type: "object",
      properties: {
        clipId: PATTERN_CLIP_SCHEMA,
        noteIds: NOTE_IDS_SCHEMA,
        velocity: { type: "number", minimum: LIMITS.velocity[0], maximum: LIMITS.velocity[1], description: "Every one of the notes' new velocity." },
      },
      required: ["clipId", "noteIds", "velocity"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findPatternClip(input.clipId, project);
      const indices = findNotes(input.noteIds, clip);
      const velocity = checkRange(input.velocity, LIMITS.velocity, "velocity");
      const changed = indices.map((index) => ({ ...clip.notes[index]!, velocity }));
      return editNotes(track, clip, indices, changed, {
        change: `Set the velocity of ${notesText(changed.length)} in a Clip on “${track.name}” to ${velocity}`,
        report: `Set the velocity of ${notesText(changed.length)} in Clip ${clip.id} to ${velocity}`,
      });
    },
  },

  quantise_notes: {
    group: "notes",
    description: `Move the notes of a Pattern Clip, or those starting in a range of it, towards the nearest step of a grid, as the Piano Roll's Quantise does: at 100% onto it, at 50% halfway. Their lengths stay. ${NOTE_TICKS_TEXT} ${NEW_IDS_TEXT}`,
    schema: {
      type: "object",
      properties: {
        clipId: PATTERN_CLIP_SCHEMA,
        grid: {
          type: "string",
          enum: QUANTISE_GRIDS.map((snap) => snap.id),
          description: `The grid, as a note value: ${QUANTISE_GRIDS.map((snap) => `${snap.id} (${snap.ticks} ticks)`).join(", ")}. A T is a triplet, three in the space of two.`,
        },
        strength: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "How far to move each note towards its grid step, in percent. Left out, 100.",
        },
        ...NOTE_RANGE_PROPERTIES,
      },
      required: ["clipId", "grid"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findPatternClip(input.clipId, project);
      const grid = checkChoice(input.grid, QUANTISE_GRIDS.map((snap) => snap.id), "grid");
      const snap = QUANTISE_GRIDS.find((choice) => choice.id === grid)!;
      const strength = input.strength === undefined ? 100 : checkRange(input.strength, [0, 100], "strength");
      const range = checkTickRange(input);
      const indices = notesInRange(clip, range);
      const chosen = indices.map((index) => clip.notes[index]!);
      const quantised = quantiseNotes(chosen, new Set(chosen.map(noteKey)), snap.ticks, clip.length, strength / 100).notes;
      const how = `to ${snap.label}${strength === 100 ? "" : ` at ${strength}%`}`;
      return editNotes(track, clip, indices, quantised, {
        change: `Quantised ${notesText(quantised.length)} in a Clip on “${track.name}” ${how}`,
        report: `Quantised ${notesText(quantised.length)} in Clip ${clip.id} ${how}${readRangeText(range, "of the Clip")}`,
      });
    },
  },

  transpose_notes: {
    group: "notes",
    description: `Transpose the notes of a Pattern Clip, or those starting in a range of it, up or down by a number of semitones: 12 is an octave. To move only some notes in pitch, use move_notes. ${NOTE_TICKS_TEXT} ${NEW_IDS_TEXT}`,
    schema: {
      type: "object",
      properties: {
        clipId: PATTERN_CLIP_SCHEMA,
        semitones: { type: "integer", description: "How far: up if positive, down if negative." },
        ...NOTE_RANGE_PROPERTIES,
      },
      required: ["clipId", "semitones"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findPatternClip(input.clipId, project);
      const semitones = checkWhole(input.semitones, "semitones");
      const range = checkTickRange(input);
      const indices = notesInRange(clip, range);
      const ids = noteIds(clip.notes);
      const transposed = indices.map((index) => {
        const note = clip.notes[index]!;
        return { ...note, pitch: checkPitch(note.pitch + semitones, `Transposing note ${ids[index]} by ${semitones} semitones`) };
      });
      checkNotesPlayable(transposed, track, (index) => `Note ${ids[indices[index]!]}`);
      return editNotes(track, clip, indices, transposed, {
        change: `Transposed ${notesText(transposed.length)} in a Clip on “${track.name}” ${semitonesText(semitones)}`,
        report: `Transposed ${notesText(transposed.length)} in Clip ${clip.id} ${semitonesText(semitones)}${readRangeText(range, "of the Clip")}`,
      });
    },
  },

  move_clip: {
    description: "Move a Clip to a new start, and optionally onto another Track of the same kind.",
    schema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "The Clip's id, as listed in the Project." },
        start: { type: "integer", minimum: 0, description: "Its new start, in ticks from the top of the song." },
        trackId: { type: "string", description: "The Track to move it onto. Left out, it stays on its own." },
      },
      required: ["clipId", "start"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findClip(input.clipId, project);
      const start = checkTicks(input.start, "start", 0);
      const destination = input.trackId === undefined ? track : findTrack(input.trackId, project);
      if (destination.kind !== track.kind) {
        reject(`Clip ${clip.id} can only move onto another ${kindName(track.kind)} Track`);
      }
      if (destination.kind === "instrument" && clip.kind === "pattern") checkNotesPlayable(clip.notes, destination);
      const onto = destination === track ? "" : ` onto “${destination.name}”`;
      return {
        commands: [
          { type: "moveClip", clipId: clip.id, start, ...(destination === track ? {} : { trackId: destination.id }) },
        ],
        change: `Moved a Clip on “${track.name}” to ${formatPosition(start, tempoMapOf(project))}${onto}`,
        report: `Clip ${clip.id} now starts at tick ${start} on Track ${destination.id}.`,
      };
    },
  },

  delete_clip: {
    description: "Remove a Clip, with its notes or audio.",
    schema: {
      type: "object",
      properties: { clipId: { type: "string", description: "The Clip's id, as listed in the Project." } },
      required: ["clipId"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findClip(input.clipId, project);
      return {
        commands: [{ type: "deleteClip", clipId: clip.id }],
        change: `Deleted a Clip on “${track.name}” at ${formatPosition(clip.start, tempoMapOf(project))}`,
        report: `Clip ${clip.id} is gone from Track ${track.id}.`,
      };
    },
  },

  list_samples: {
    group: "audio_clips",
    description: `List the audio files in the sample browser's folders on the musician's machine, which place_audio_clip places from as library:<folder>/<path>. At most ${MAX_LISTED_SAMPLES} files come back at a time: narrow a big library with folder or match. Where there is no sample browser (the browser version of Soundcheck) it says so, and only the Project's own audio files, listed after the Project, can be placed. Changes nothing.`,
    schema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "One folder to list, by name. Left out, every folder." },
        match: {
          type: "string",
          description: 'Only the files whose path has this in it, ignoring case, e.g. "vocal" or "kick". Left out, every file.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    plan(input, _project, { sampleFolders, audioFiles }) {
      if (sampleFolders === null) {
        return { commands: [], report: `${NO_SAMPLE_BROWSER} ${projectFilesText(audioFiles)}` };
      }
      const named = sampleFolderNames(sampleFolders);
      const chosen = input.folder === undefined ? named : [findSampleFolder(input.folder, named)];
      if (input.match !== undefined && typeof input.match !== "string") reject("match must be text to look for in a file's path");
      const match = (input.match ?? "").trim().toLowerCase();
      if (chosen.length === 0) {
        return {
          commands: [],
          report: `The musician hasn't added any folders to the sample browser, so there are no samples to list. ${projectFilesText(audioFiles)}`,
        };
      }
      return {
        commands: [],
        listSamples: {
          folders: chosen.map(({ folder }) => folder),
          report(files) {
            let room = MAX_LISTED_SAMPLES;
            const listed = chosen.map(({ name }, at) => {
              const found = files[at]!;
              if (found instanceof Error) return { folder: name, error: `It couldn't be read: ${found.message}` };
              const matching = found.filter((path) => path.toLowerCase().includes(match));
              const shown = matching.slice(0, room);
              room -= shown.length;
              return { folder: name, files: shown, ...(matching.length > shown.length && { more: matching.length - shown.length }) };
            });
            const more = listed.some((folder) => "more" in folder)
              ? ` Some folders have more files than fit, counted by more: list them with folder, or narrow them with match.`
              : "";
            const matched = match === "" ? "" : ` whose path has “${match}” in it`;
            return `The sample browser's files${matched}, by folder, as folder-relative paths: place one with place_audio_clip's source as library:<folder>/<path>.${more}\n${JSON.stringify(listed)}`;
          },
        },
        report: "",
      };
    },
  },

  place_audio_clip: {
    group: "audio_clips",
    description:
      "Put an audio file on an Audio Track as a new Audio Clip, as the musician drops one there from the sample browser: the whole file, from start, playing for as long as it lasts whatever the tempo. The source is one of the Project's audio files, by the path listed after the Project (e.g. audio/vocal take.wav), or a sample from the sample browser's folders, as library:<folder>/<path> from list_samples, which is copied into the Project first so the Project keeps its own copy. Where there is no sample browser (the browser version of Soundcheck) only the Project's files can be placed. Clips on one Track may overlap. To make a new Audio Track for it, use create_track with kind audio first.",
    schema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "The Audio Track's id, as listed in the Project." },
        source: {
          type: "string",
          description: "What to place: a Project audio file's path, e.g. audio/vocal take.wav, or library:<folder>/<path> for a sample.",
        },
        start: { type: "integer", minimum: 0, description: "Where the Clip starts, in ticks from the top of the song." },
      },
      required: ["trackId", "source", "start"],
      additionalProperties: false,
    },
    plan(input, project, { sampleFolders, audioFiles }) {
      const track = findAudioTrack(input.trackId, project);
      const start = checkTicks(input.start, "start", 0);
      if (typeof input.source !== "string" || input.source.trim() === "") {
        reject("source must be a Project audio file's path or library:<folder>/<path>");
      }
      const source = input.source.trim();
      const id = newId();
      const at = formatPosition(start, tempoMapOf(project));
      const place = ({ file, seconds }: AudioFileLength, from: string): ToolPlan => {
        const clip: AudioClip = { id, kind: "audio", start, duration: seconds, file, fileOffset: 0 };
        return {
          commands: [{ type: "addClip", trackId: track.id, clip }],
          change: `Placed ${from} on “${track.name}” at ${at}`,
          report: `Placed ${file}, ${roundSeconds(seconds)} s long, on Track ${track.id} from tick ${start} (${at}), whose clipId is ${id}.`,
        };
      };
      if (!source.startsWith(LIBRARY_PREFIX)) {
        const file = audioFiles.find((candidate) => candidate.file === source);
        if (!file) {
          const library = sampleFolders === null ? ` ${NO_SAMPLE_BROWSER}` : " A sample from the sample browser is placed as library:<folder>/<path>, from list_samples.";
          reject(`The Project has no audio file ${source}. ${projectFilesText(audioFiles)}${library}`);
        }
        return place(file, `“${fileName(file.file)}”`);
      }
      if (sampleFolders === null) reject(`${NO_SAMPLE_BROWSER} ${projectFilesText(audioFiles)}`);
      const sample = findSample(source.slice(LIBRARY_PREFIX.length), sampleFolderNames(sampleFolders));
      return {
        commands: [],
        copySample: {
          sample,
          next(copied) {
            const plan = place(copied, `the sample “${fileName(sample.path)}”`);
            return {
              ...plan,
              change: `${plan.change}, copied into the Project as ${copied.file}`,
              report: `Copied ${source} into the Project as ${copied.file}. ${plan.report}`,
            };
          },
        },
        report: "",
      };
    },
  },

  trim_audio_clip: {
    group: "audio_clips",
    description:
      "Trim an Audio Clip's start or end, as dragging its edges on the timeline does, by where in its audio file it starts and stops playing: in seconds into the file, as the Project lists its fileOffset and duration. The sound stays where it is in the song: trimming the start moves the Clip's start with it, so trimming 0.5 s of silence off the start makes the Clip start 0.5 s later. Move it afterwards with move_clip if the Request wants it somewhere else. An end past the file's length, listed after the Project, is refused. analyse_audio's onsets of the Track say where sounds start.",
    schema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "The Audio Clip's id, as listed in the Project." },
        startOffset: {
          type: "number",
          minimum: 0,
          description: "Seconds into the file where the Clip starts playing. Left out, its start stays.",
        },
        endOffset: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Seconds into the file where the Clip stops playing. Left out, its end stays.",
        },
      },
      required: ["clipId"],
      additionalProperties: false,
    },
    plan(input, project, { audioFiles }) {
      const { track, clip } = findAudioClip(input.clipId, project);
      if (input.startOffset === undefined && input.endOffset === undefined) reject("trim_audio_clip needs startOffset, endOffset or both");
      const map = tempoMapOf(project);
      // Beyond the file's length there is nothing to play; where it isn't
      // known, the Clip can be trimmed shorter but not made longer.
      const length = audioFiles.find(({ file }) => file === clip.file)?.seconds ?? clip.fileOffset + clip.duration;
      const shown = roundSeconds(length);
      const startOffset = input.startOffset === undefined ? clip.fileOffset : checkRange(input.startOffset, [0, shown], "startOffset");
      const endOffset =
        input.endOffset === undefined ? clip.fileOffset + clip.duration : Math.min(checkRange(input.endOffset, [0, shown], "endOffset"), length);
      if (endOffset <= startOffset) reject(`endOffset must be after startOffset, ${roundSeconds(startOffset)} s: the Clip would play nothing`);
      // Where the file's start is in the song, so both edges keep the sound where it is.
      const fileStart = secondsAt(map, clip.start) - clip.fileOffset;
      if (fileStart + startOffset < 0) {
        reject(`The Clip can't start before the top of the song: startOffset must be at least ${roundSeconds(-fileStart)} s`);
      }
      // A Clip starts on a whole tick, and its file offset follows the tick, as the timeline's trim does.
      const start = input.startOffset === undefined ? clip.start : Math.round(tickAt(map, fileStart + startOffset));
      const fileOffset = Math.max(0, clip.fileOffset + secondsBetween(map, clip.start, start));
      const end = input.endOffset === undefined ? clipEnd(clip, map) : tickAt(map, fileStart + endOffset);
      if (end <= start) reject("The Clip would play nothing: leave more of it between startOffset and endOffset");
      const duration = secondsBetween(map, start, end);
      const plays = `${roundSeconds(fileOffset)} s to ${roundSeconds(fileOffset + duration)} s of ${clip.file}`;
      return {
        commands: [{ type: "trimClip", clipId: clip.id, start, length: end - start, fileOffset }],
        change: `Trimmed an Audio Clip on “${track.name}” to play ${roundSeconds(fileOffset)} s to ${roundSeconds(fileOffset + duration)} s of “${fileName(clip.file)}”, from ${formatPosition(start, map)}`,
        report: `Clip ${clip.id} now plays ${plays}, ${roundSeconds(duration)} s, from tick ${start} (${formatPosition(start, map)}).`,
      };
    },
  },

  copy_audio_clip: {
    group: "audio_clips",
    description:
      "Copy an Audio Clip, trimmed as it is, to a new start on its own or another Audio Track, as the timeline's copy does. The copy plays the same file, so nothing is copied on disk.",
    schema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "The Audio Clip's id, as listed in the Project." },
        start: { type: "integer", minimum: 0, description: "Where the copy starts, in ticks from the top of the song." },
        trackId: { type: "string", description: "The Audio Track to put the copy on. Left out, the Clip's own." },
      },
      required: ["clipId", "start"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findAudioClip(input.clipId, project);
      const start = checkTicks(input.start, "start", 0);
      const destination = input.trackId === undefined ? track : findAudioTrack(input.trackId, project);
      const copy = copyOf(clip, start, newId());
      const onto = destination === track ? "" : ` onto “${destination.name}”`;
      return {
        commands: [{ type: "addClip", trackId: destination.id, clip: copy }],
        change: `Copied an Audio Clip on “${track.name}” to ${formatPosition(start, tempoMapOf(project))}${onto}`,
        report: `Copied Clip ${clip.id} to tick ${start} on Track ${destination.id}: the copy's clipId is ${copy.id}.`,
      };
    },
  },

  separate_stems: {
    group: "audio_clips",
    description:
      "Separate an Audio Clip into its Stems, as its context menu's Separate into Stems does: its vocals, drums, bass and other (everything else). Only the stretch the Clip plays is separated. It takes a while, often minutes for a whole song, while the musician waits with a Cancel, so separate only when the Request needs it, and each Clip once. Each kept Stem goes on a new Audio Track directly under the Clip's Track, called \"<Clip name> – Vocals\", \"– Drums\", \"– Bass\" or \"– Other\", as an Audio Clip where the Clip was and as long. The source Clip is removed whatever is kept, so the song sounds roughly as it did only with all four. The Stems are an estimate: a little of one bleeds into another. The result gives the new Tracks' ids, to analyse, mix or edit them. It fails, changing nothing, where the separation model isn't installed, which only the musician can do, and where Stem Separation isn't available (the browser version of Soundcheck).",
    schema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "The Audio Clip's id, as listed in the Project." },
        keep: {
          type: "array",
          items: { type: "string", enum: [...STEM_TRACK_ORDER] },
          minItems: 1,
          uniqueItems: true,
          description: "The Stems to keep, e.g. [\"vocals\"]: only these get Tracks, and the rest are discarded. Left out, all four are kept.",
        },
      },
      required: ["clipId"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { track, clip } = findAudioClip(input.clipId, project);
      const keep = checkStems(input.keep);
      const name = clipFileName(clip);
      const kept = STEM_TRACK_ORDER.filter((stem) => keep.includes(stem));
      const discarded = STEM_TRACK_ORDER.filter((stem) => !keep.includes(stem));
      return {
        commands: [],
        separate: {
          clip,
          next(stems, samples) {
            const placed = placeStems(project, samples, clip, stems, newId, keep);
            if (!placed.ok) reject(placed.error);
            const tracks = placed.trackIds.map((id, at) => `${id} “${name} – ${STEM_LABELS[kept[at]!]}” (${kept[at]})`);
            const gone = discarded.length > 0 ? ` The ${stemLabels(discarded)} Stems were discarded.` : "";
            return {
              plan: {
                commands: placed.commands,
                change: `Separated “${name}” on “${track.name}” into Stems, keeping ${stemLabels(kept)}, in place of the Clip`,
                report: `Separated Clip ${clip.id} into its Stems and removed it. The new Audio Tracks, under Track ${track.id}, top to bottom, by trackId: ${tracks.join(", ")}.${gone}`,
              },
              samples: placed.samples,
            };
          },
        },
        report: "",
      };
    },
  },

  set_tempo: {
    group: "time",
    description:
      "Set the Project's tempo at the start of the song. A song with Tempo Changes lists them in the Project: each keeps its own tempo, so this sets the tempo only up to the first that changes it. To change the tempo later in the song, add_tempo_change.",
    schema: {
      type: "object",
      properties: {
        tempo: {
          type: "number",
          minimum: LIMITS.tempo[0],
          maximum: LIMITS.tempo[1],
          description: "Quarter notes per minute.",
        },
      },
      required: ["tempo"],
      additionalProperties: false,
    },
    plan(input, project) {
      const tempo = checkRange(input.tempo, LIMITS.tempo, "tempo");
      const map = tempoMapOf(project);
      const firstTempo = project.tempoChanges.find((change) => change.tempo !== null);
      if (!firstTempo) {
        return {
          commands: [{ type: "setTempo", tempo }],
          change: `Set the tempo to ${tempo} BPM`,
          report: `The tempo is now ${tempo} BPM.`,
        };
      }
      const from = formatPosition(firstTempo.tick, map);
      return {
        commands: [{ type: "setTempo", tempo }],
        change: `Set the starting tempo to ${tempo} BPM`,
        report: `The song starts at ${tempo} BPM. It has Tempo Changes, so that tempo lasts until ${from}, where a Tempo Change sets ${firstTempo.tempo} BPM; the Tempo Changes kept their tempos.`,
      };
    },
  },

  add_tempo_change: {
    group: "time",
    description:
      "Change the tempo instantly from a point in the song, until the next Tempo Change that sets a tempo; there are no ramps. For a slower bridge, add one at its first bar and another back at the bar after it. Only the tempo moves: every Clip, Automation breakpoint and Section stays in the bar it was in. Pattern Clips follow the change, their notes playing faster or slower after it. Audio Clips keep their start and play at their natural speed, so one under the change lasts the same seconds and a different number of ticks. At a bar where a Tempo Change already is, it sets that one's tempo.",
    schema: {
      type: "object",
      properties: {
        bar: {
          type: "number",
          exclusiveMinimum: 1,
          description:
            "Where, in bars counting from 1: 9 is the bar line of bar 9, 9.5 half way through it. Bar 1 is the song's start, whose tempo set_tempo sets.",
        },
        tempo: { type: "number", minimum: LIMITS.tempo[0], maximum: LIMITS.tempo[1], description: "Quarter notes per minute from there." },
      },
      required: ["bar", "tempo"],
      additionalProperties: false,
    },
    plan(input, project) {
      const map = tempoMapOf(project);
      const tick = checkChangeBar(input.bar, map, false);
      const tempo = checkRange(input.tempo, LIMITS.tempo, "tempo");
      const at = formatPosition(tick, map);
      const existing = project.tempoChanges.find((change) => change.tick === tick);
      if (existing) {
        return {
          commands: [{ type: "setTempoChange", tempoChangeId: existing.id, tempo }],
          change: `Set the Tempo Change at ${at} to ${tempo} BPM`,
          report: `Tempo Change ${existing.id}, at ${at} (tick ${tick}), now sets ${tempo} BPM${existing.timeSignature ? `, and still ${signatureText(existing.timeSignature)}` : ""}.`,
        };
      }
      const tempoChange: TempoChange = { id: newId(), tick, tempo, timeSignature: null };
      return {
        commands: [{ type: "addTempoChange", tempoChange }],
        change: `Changed the tempo to ${tempo} BPM at ${at}`,
        report: `Added Tempo Change ${tempoChange.id} at ${at} (tick ${tick}, ${roundSeconds(secondsAt(map, tick))} s): ${tempo} BPM from there.`,
      };
    },
  },

  move_tempo_change: {
    group: "time",
    description:
      "Move a Tempo Change to another bar, keeping what it sets. One that sets a time signature moves only to a bar line, a whole bar. It can't go to bar 1 or onto another Tempo Change. Clips, Automation and Sections stay where they are; Pattern Clips follow the tempo where it now changes, and Audio Clips keep their start and natural speed.",
    schema: {
      type: "object",
      properties: {
        tempoChangeId: { type: "string", description: "The Tempo Change's id, as listed in the Project." },
        bar: {
          type: "number",
          exclusiveMinimum: 1,
          description: "Where to, in bars counting from 1, as the bars run without this Tempo Change: 9 is the bar line of bar 9, 9.5 half way through it.",
        },
      },
      required: ["tempoChangeId", "bar"],
      additionalProperties: false,
    },
    plan(input, project) {
      const change = findTempoChange(input.tempoChangeId, project);
      const map = tempoMapOf(project);
      const others = project.tempoChanges.filter((other) => other !== change);
      const without = tempoMapOf({ ...project, tempoChanges: others });
      const tick = checkChangeBar(input.bar, without, change.timeSignature !== null);
      const from = formatPosition(change.tick, map);
      if (tick === change.tick) reject(`Tempo Change ${change.id} is already at ${from}`);
      const there = others.find((other) => other.tick === tick);
      if (there) reject(`Tempo Change ${there.id} is already at ${formatPosition(tick, map)}: move or delete that one first`);
      const moved = [...others, { ...change, tick }].toSorted((a, b) => a.tick - b.tick);
      checkSignaturesOnBarLines(project, project.timeSignature, moved, `Moving Tempo Change ${change.id}`);
      const to = formatPosition(tick, tempoMapOf({ ...project, tempoChanges: moved }));
      return {
        commands: [{ type: "moveTempoChange", tempoChangeId: change.id, tick }],
        change: `Moved the Tempo Change at ${from} to ${to}`,
        report: `Tempo Change ${change.id} is now at ${to} (tick ${tick}).`,
      };
    },
  },

  delete_tempo_change: {
    group: "time",
    description:
      "Take away a Tempo Change: the tempo and time signature before it hold on to the next. Taking away one that sets a time signature moves the bar lines after it, as set_time_signature says.",
    schema: {
      type: "object",
      properties: {
        tempoChangeId: { type: "string", description: "The Tempo Change's id, as listed in the Project." },
      },
      required: ["tempoChangeId"],
      additionalProperties: false,
    },
    plan(input, project) {
      const change = findTempoChange(input.tempoChangeId, project);
      const others = project.tempoChanges.filter((other) => other !== change);
      checkSignaturesOnBarLines(project, project.timeSignature, others, `Deleting Tempo Change ${change.id}`);
      const at = formatPosition(change.tick, tempoMapOf(project));
      const after = tempoMapOf({ ...project, tempoChanges: others });
      return {
        commands: [{ type: "deleteTempoChange", tempoChangeId: change.id }],
        change: `Deleted the Tempo Change at ${at}`,
        report: `Tempo Change ${change.id} is gone: from tick ${change.tick} the song is at ${tempoAtText(after, change.tick)}.`,
      };
    },
  },

  set_time_signature: {
    group: "time",
    description:
      "Set the time signature from a bar line on: at bar 1 the song's own, and later a Tempo Change at that bar, or the one already there. A time signature changes only at a bar line, so bar is a whole bar. The tempo stays in quarter notes per minute. It moves the bar lines after it: Clips and Automation keep their ticks, and so their time, but may then fall in other bars; Sections are whole bars, so they move with the bar lines. A change that would leave a later time signature off a bar line is refused.",
    schema: {
      type: "object",
      properties: {
        bar: { type: "integer", minimum: 1, description: "The bar it starts at, counting from 1: bar 1 is the song's start." },
        beatsPerBar: { type: "integer", minimum: LIMITS.beatsPerBar[0], maximum: LIMITS.beatsPerBar[1], description: "The top number: beats in a bar." },
        beatUnit: { type: "integer", enum: [...BEAT_UNITS], description: "The bottom number: the note a beat is, 4 for a quarter note, 8 for an eighth." },
      },
      required: ["bar", "beatsPerBar", "beatUnit"],
      additionalProperties: false,
    },
    plan(input, project) {
      const map = tempoMapOf(project);
      if (typeof input.bar !== "number" || !Number.isFinite(input.bar) || input.bar < 1) reject("bar must be a bar number, 1 or more");
      if (!Number.isInteger(input.bar)) {
        reject(`A time signature can only change at a bar line, and bar ${input.bar} is part way through bar ${Math.floor(input.bar)}: give a whole bar`);
      }
      const bar = input.bar;
      const beatsPerBar = input.beatsPerBar;
      if (!Number.isInteger(beatsPerBar) || (beatsPerBar as number) < LIMITS.beatsPerBar[0] || (beatsPerBar as number) > LIMITS.beatsPerBar[1]) {
        reject(`beatsPerBar must be a whole number from ${LIMITS.beatsPerBar[0]} to ${LIMITS.beatsPerBar[1]}`);
      }
      if (!(BEAT_UNITS as readonly unknown[]).includes(input.beatUnit)) reject(`beatUnit must be one of ${BEAT_UNITS.join(", ")}`);
      const timeSignature: TimeSignature = { beatsPerBar: beatsPerBar as number, beatUnit: input.beatUnit as TimeSignature["beatUnit"] };
      const text = signatureText(timeSignature);
      const tick = Math.round(tickAtBars(map, bar));
      if (sameSignature(signatureAt(map, tick), timeSignature)) reject(`The time signature at bar ${bar} is already ${text}`);

      if (tick === 0) {
        checkSignaturesOnBarLines(project, timeSignature, project.tempoChanges, `Setting ${text} at bar 1`);
        return {
          commands: [{ type: "setTimeSignature", timeSignature }],
          change: `Set the time signature to ${text}`,
          report: `The song starts in ${text}, ${barTicksText(timeSignature)}.`,
        };
      }
      const at = formatPosition(tick, map);
      const existing = project.tempoChanges.find((change) => change.tick === tick);
      const tempoChange: TempoChange = existing ? { ...existing, timeSignature } : { id: newId(), tick, tempo: null, timeSignature };
      const changes = [...project.tempoChanges.filter((change) => change !== existing), tempoChange].toSorted((a, b) => a.tick - b.tick);
      checkSignaturesOnBarLines(project, project.timeSignature, changes, `Setting ${text} at bar ${bar}`);
      return {
        commands: [
          existing
            ? { type: "setTempoChange", tempoChangeId: existing.id, timeSignature }
            : { type: "addTempoChange", tempoChange },
        ],
        change: `Set the time signature to ${text} at ${at}`,
        report: existing
          ? `Tempo Change ${existing.id}, at ${at} (tick ${tick}), now sets ${text}, ${barTicksText(timeSignature)}${existing.tempo !== null ? `, and still ${existing.tempo} BPM` : ""}.`
          : `Added Tempo Change ${tempoChange.id} at ${at} (tick ${tick}): ${text} from there, ${barTicksText(timeSignature)}.`,
      };
    },
  },

  add_section: {
    group: "arrangement",
    description:
      "Name a part of the song, such as an intro, verse or chorus, as a Section: whole bars from a bar line. Sections can't overlap, so it must be in bars no Section listed in the Project covers. It marks the song and changes nothing heard.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'What to call it, e.g. "Verse 1" or "Chorus".' },
        startBar: { type: "integer", minimum: 1, description: "The bar it starts at, counting from 1." },
        bars: { type: "integer", minimum: 1, description: "How many bars it lasts." },
      },
      required: ["name", "startBar", "bars"],
      additionalProperties: false,
    },
    plan(input, project) {
      const name = checkName(input.name, "name");
      const startBar = checkBars(input.startBar, "startBar");
      const bars = checkBars(input.bars, "bars");
      const range = { startBar, bars };
      const other = overlappingSection(project.sections, range);
      if (other) {
        reject(
          `${sectionBarsText(range)} would overlap the Section “${other.name}” (${sectionBarsText(other)}); Sections can't overlap, so pick bars no Section covers or change that one first`,
        );
      }
      const section = { id: newId(), name, startBar, bars };
      const { start, end } = sectionTicks(section, tempoMapOf(project));
      return {
        commands: [{ type: "addSection", section }],
        change: `Named ${sectionBarsText(section)} “${name}”`,
        report: `Added the Section “${name}” at ${sectionBarsText(section)}, ticks ${start} up to ${end}, whose sectionId is ${section.id}.`,
      };
    },
  },

  rename_section: {
    group: "arrangement",
    description: "Change a Section's name.",
    schema: {
      type: "object",
      properties: {
        sectionId: { type: "string", description: "The Section's id, as listed in the Project." },
        name: { type: "string", description: "The new name." },
      },
      required: ["sectionId", "name"],
      additionalProperties: false,
    },
    plan(input, project) {
      const section = findSection(input.sectionId, project);
      const name = checkName(input.name, "name");
      return {
        commands: [{ type: "renameSection", sectionId: section.id, name }],
        change: `Renamed the Section “${section.name}” to “${name}”`,
        report: `Section ${section.id} is now called “${name}”.`,
      };
    },
  },

  delete_section: {
    group: "arrangement",
    description: "Remove a Section. Only its name on the ruler goes: the Clips and Automation in its bars stay as they are.",
    schema: {
      type: "object",
      properties: { sectionId: { type: "string", description: "The Section's id, as listed in the Project." } },
      required: ["sectionId"],
      additionalProperties: false,
    },
    plan(input, project) {
      const section = findSection(input.sectionId, project);
      return {
        commands: [{ type: "deleteSection", sectionId: section.id }],
        change: `Deleted the Section “${section.name}”`,
        report: `Section ${section.id} (“${section.name}”, ${sectionBarsText(section)}) is gone; nothing in its bars changed.`,
      };
    },
  },

  copy_clips: {
    group: "arrangement",
    description:
      "Copy Clips, as they are, by an offset: onto their own Tracks, or all onto one other Track of the same kind. Only the Clips are copied, not the Automation under them; to repeat a whole Section with its Automation and Tempo Changes, duplicate_section. The copies go over whatever is there already: Clips on a Track can overlap.",
    schema: {
      type: "object",
      properties: {
        clipIds: { type: "array", minItems: 1, items: { type: "string" }, description: "The Clips' ids, as listed in the Project." },
        offset: {
          type: "integer",
          description: `How much later each copy starts than its Clip, in ticks, or earlier if below 0: a bar of 4/4 is ${TICKS_PER_BEAT * 4}.`,
        },
        trackId: { type: "string", description: "The Track to put every copy on. Left out, each goes on its own Clip's Track." },
      },
      required: ["clipIds", "offset"],
      additionalProperties: false,
    },
    plan(input, project) {
      if (!Array.isArray(input.clipIds) || input.clipIds.length === 0) reject("clipIds must list at least one Clip's id");
      if (!Number.isInteger(input.offset)) reject("offset must be a whole number of ticks");
      const offset = input.offset as number;
      const seen = new Set<unknown>();
      const found = input.clipIds.map((clipId: unknown) => {
        if (seen.has(clipId)) reject(`Clip ${String(clipId)} is listed twice`);
        seen.add(clipId);
        return findClip(clipId, project);
      });
      const destination = input.trackId === undefined ? undefined : findTrack(input.trackId, project);
      const map = tempoMapOf(project);
      const copies = found.map(({ track, clip }) => {
        const onto = destination ?? track;
        if (onto.kind !== track.kind) reject(`Clip ${clip.id} can only be copied onto another ${kindName(track.kind)} Track`);
        if (onto.kind === "instrument" && clip.kind === "pattern") checkNotesPlayable(clip.notes, onto);
        if (clip.start + offset < 0) {
          reject(`Clip ${clip.id} starts at tick ${clip.start}, so its copy would start before the song does: the offset can be no less than -${clip.start}`);
        }
        return { from: clip, onto, copy: copyOf(clip, clip.start + offset, newId()) };
      });
      const names = [...new Set(copies.map(({ onto }) => `“${onto.name}”`))].join(", ");
      const first = copies.reduce((earliest, copy) => (copy.from.start < earliest.from.start ? copy : earliest));
      const change =
        copies.length === 1
          ? `Copied a Clip on ${names} to ${formatPosition(first.copy.start, map)}`
          : `Copied ${copies.length} Clips on ${names} from ${formatPosition(first.from.start, map)} to ${formatPosition(first.copy.start, map)}`;
      return {
        commands: copies.map(({ onto, copy }) => ({ type: "addClip", trackId: onto.id, clip: copy })),
        change,
        report: `Copied ${copies.map(({ from, onto, copy }) => `Clip ${from.id} to tick ${copy.start} on Track ${onto.id}, whose clipId is ${copy.id}`).join("; ")}.`,
      };
    },
  },

  insert_bars: {
    group: "arrangement",
    description:
      "Insert empty bars before a bar, moving everything from that bar on later by them on every Track, Bus and the Master: Clips, Automation breakpoints, Tempo Changes and Sections. The new bars have the tempo and time signature of the bar before them, and each automated setting holds the value it has at that bar through them. A Clip across the bar line is split there, its later part moving with the rest. A Section the bars go inside grows by them.",
    schema: {
      type: "object",
      properties: {
        at: { type: "integer", minimum: 1, description: "The bar they go before, counting from 1: a Section's startBar puts them just before it." },
        count: { type: "integer", minimum: 1, description: "How many bars." },
      },
      required: ["at", "count"],
      additionalProperties: false,
    },
    plan(input, project) {
      const at = checkBars(input.at, "at");
      const count = checkBars(input.count, "count");
      return arrangementPlan(project, { kind: "insertBars", at, count }, `Inserted ${barsText(count)} before bar ${at}`);
    },
  },

  delete_bars: {
    group: "arrangement",
    description:
      "Delete bars and everything in them on every Track, Bus and the Master, moving everything after them earlier to close the gap: Clips, Automation breakpoints, Tempo Changes and Sections. A Clip across either edge is split there and keeps its part outside, and each automated setting keeps its values on both sides. A Section in the bars goes; one partly in them loses those bars. The bars after keep the tempo and time signature they had.",
    schema: {
      type: "object",
      properties: {
        startBar: { type: "integer", minimum: 1, description: "The first bar to delete, counting from 1." },
        bars: { type: "integer", minimum: 1, description: "How many bars." },
      },
      required: ["startBar", "bars"],
      additionalProperties: false,
    },
    plan(input, project) {
      const startBar = checkBars(input.startBar, "startBar");
      const bars = checkBars(input.bars, "bars");
      return arrangementPlan(project, { kind: "deleteBars", startBar, bars }, `Deleted ${sectionBarsText({ startBar, bars })}`);
    },
  },

  duplicate_section: {
    group: "arrangement",
    description:
      "Repeat a Section: insert a copy of it, with everything in its bars on every Track, Bus and the Master (Clips, Automation and Tempo Changes, and the tempo and time signature it starts with), before a bar, moving everything from there on later. The copy is a new Section of the same name, and sounds as the original does. A Clip across the Section's edge is split there, and only its part inside is copied. It goes right after the Section unless at says where.",
    schema: {
      type: "object",
      properties: {
        section: { type: "string", description: "The Section: its sectionId, or its name if no other Section has it." },
        at: {
          type: "integer",
          minimum: 1,
          description: "The bar the copy goes before, counting from 1, as the song is now: another Section's startBar, or the bar after one ends; not inside a Section. Left out, the bar after the Section.",
        },
      },
      required: ["section"],
      additionalProperties: false,
    },
    plan(input, project) {
      const section = findNamedSection(input.section, project);
      const at = input.at === undefined ? sectionEndBar(section) : checkBars(input.at, "at");
      return arrangementPlan(
        project,
        { kind: "duplicateSection", sectionId: section.id, at },
        (made) => `Duplicated the Section “${section.name}” (${sectionBarsText(section)}) to ${sectionBarsText(made!)}`,
      );
    },
  },

  move_section: {
    group: "arrangement",
    description:
      "Move a Section, with everything in its bars on every Track, Bus and the Master (Clips, Automation and Tempo Changes, and the tempo and time signature it starts with), to before another bar: the bars between close up behind it and make room for it. To swap two Sections next to each other, move the later one to the earlier one's startBar. A Clip across the Section's edge is split there. The bars around it keep the tempo and time signature they had.",
    schema: {
      type: "object",
      properties: {
        section: { type: "string", description: "The Section: its sectionId, or its name if no other Section has it." },
        to: {
          type: "integer",
          minimum: 1,
          description: "The bar it goes before, counting from 1, as the song is now, before the move: another Section's startBar, or the bar after one ends; not inside a Section. Moved later, it starts its own length before that bar.",
        },
      },
      required: ["section", "to"],
      additionalProperties: false,
    },
    plan(input, project) {
      const section = findNamedSection(input.section, project);
      const to = checkBars(input.to, "to");
      return arrangementPlan(
        project,
        { kind: "moveSection", sectionId: section.id, to },
        (moved) => `Moved the Section “${section.name}” (${sectionBarsText(section)}) to ${sectionBarsText(moved!)}`,
      );
    },
  },

  set_track_volume: {
    description:
      "Set a Track's volume on the mixer, as a linear gain: 1 is unity (0 dB, where every Track starts), 0.5 is about -6 dB, 2 is +6 dB and 0 is silent. Its Sends come after it, so they follow it.",
    schema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "The Track's id, as listed in the Project." },
        volume: {
          type: "number",
          minimum: LIMITS.volume[0],
          maximum: LIMITS.volume[1],
          description: "The new volume, a linear gain.",
        },
      },
      required: ["trackId", "volume"],
      additionalProperties: false,
    },
    plan(input, project) {
      const track = findTrack(input.trackId, project);
      const volume = checkRange(input.volume, LIMITS.volume, "volume");
      return {
        commands: [{ type: "setTrackMixer", trackId: track.id, mixer: { volume } }],
        change: `Set “${track.name}” to ${formatDb(volume)}`,
        report: `Track ${track.id} (“${track.name}”) is at volume ${volume} (${formatDb(volume)}).${overridden(track.automation, "volume")}`,
      };
    },
  },

  set_track_pan: {
    description: "Set where a Track sits between the speakers on the mixer.",
    schema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "The Track's id, as listed in the Project." },
        pan: {
          type: "number",
          minimum: LIMITS.pan[0],
          maximum: LIMITS.pan[1],
          description: "-1 is hard left, 0 the centre (where every Track starts) and 1 hard right.",
        },
      },
      required: ["trackId", "pan"],
      additionalProperties: false,
    },
    plan(input, project) {
      const track = findTrack(input.trackId, project);
      const pan = checkRange(input.pan, LIMITS.pan, "pan");
      return {
        commands: [{ type: "setTrackMixer", trackId: track.id, mixer: { pan } }],
        change: `Panned “${track.name}” ${panText(pan)}`,
        report: `Track ${track.id} (“${track.name}”) is panned to ${pan} (${panText(pan)}).${overridden(track.automation, "pan")}`,
      };
    },
  },

  set_track_mute: {
    description: "Mute a Track on the mixer, or unmute it. A muted Track plays nothing, not even through its Sends.",
    schema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "The Track's id, as listed in the Project." },
        mute: { type: "boolean", description: "true to mute it, false to unmute it." },
      },
      required: ["trackId", "mute"],
      additionalProperties: false,
    },
    plan(input, project) {
      const track = findTrack(input.trackId, project);
      const mute = checkBoolean(input.mute, "mute");
      return {
        commands: [{ type: "setTrackMixer", trackId: track.id, mixer: { mute } }],
        change: `${mute ? "Muted" : "Unmuted"} “${track.name}”`,
        report: `Track ${track.id} (“${track.name}”) is ${mute ? "muted" : "not muted"}.`,
      };
    },
  },

  set_track_solo: {
    smallCoreGroup: "routing",
    description:
      "Solo a Track on the mixer, or unsolo it. While any Track is soloed, only the soloed Tracks play, through the Buses they feed or send to; muting still silences a soloed Track.",
    schema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "The Track's id, as listed in the Project." },
        solo: { type: "boolean", description: "true to solo it, false to unsolo it." },
      },
      required: ["trackId", "solo"],
      additionalProperties: false,
    },
    plan(input, project) {
      const track = findTrack(input.trackId, project);
      const solo = checkBoolean(input.solo, "solo");
      return {
        commands: [{ type: "setTrackMixer", trackId: track.id, mixer: { solo } }],
        change: `${solo ? "Soloed" : "Unsoloed"} “${track.name}”`,
        report: `Track ${track.id} (“${track.name}”) is ${solo ? "soloed" : "not soloed"}.`,
      };
    },
  },

  set_master_volume: {
    smallCoreGroup: "routing",
    description:
      "Set the Master's volume, which every Track and Bus ends up feeding, as a linear gain: 1 is unity (0 dB, where it starts), 0.5 is about -6 dB and 2 is +6 dB.",
    schema: {
      type: "object",
      properties: {
        volume: {
          type: "number",
          minimum: LIMITS.volume[0],
          maximum: LIMITS.volume[1],
          description: "The new volume, a linear gain.",
        },
      },
      required: ["volume"],
      additionalProperties: false,
    },
    plan(input, project) {
      const volume = checkRange(input.volume, LIMITS.volume, "volume");
      return {
        commands: [{ type: "setMasterVolume", volume }],
        change: `Set the Master to ${formatDb(volume)}`,
        report: `The Master is at volume ${volume} (${formatDb(volume)}).${overridden(project.master.automation, "volume")}`,
      };
    },
  },

  add_bus: {
    group: "routing",
    description:
      "Add a Bus to the Project: a mixer channel with its own Insert Chain, volume, pan, mute and solo, which runs what feeds it, by output or Send, before passing it on. It starts at unity, with no Effects, feeding the Master; set_output routes Tracks and Buses to it, and add_send sends to it.",
    schema: {
      type: "object",
      properties: { name: { type: "string", description: "What to call the Bus, e.g. \"Drums\" or \"Reverb\"." } },
      required: ["name"],
      additionalProperties: false,
    },
    plan(input) {
      const name = checkName(input.name, "name");
      const bus = createBus(name, newId());
      return {
        commands: [{ type: "addBus", bus }],
        change: `Added the Bus “${name}”`,
        report: `Added the Bus “${name}”, whose busId is ${bus.id}. It feeds the Master, and nothing feeds it yet.`,
      };
    },
  },

  rename_bus: {
    group: "routing",
    description: "Change a Bus's name.",
    schema: {
      type: "object",
      properties: {
        busId: BUS_ID_SCHEMA,
        name: { type: "string", description: "The new name." },
      },
      required: ["busId", "name"],
      additionalProperties: false,
    },
    plan(input, project) {
      const bus = findBus(input.busId, project, "busId");
      const name = checkName(input.name, "name");
      return {
        commands: [{ type: "renameBus", busId: bus.id, name }],
        change: `Renamed the Bus “${bus.name}” to “${name}”`,
        report: `Bus ${bus.id} is now called “${name}”.`,
      };
    },
  },

  delete_bus: {
    group: "routing",
    description:
      "Remove a Bus from the Project, with its Insert Chain, its Sends and its Automation, as the mixer does: every Track and Bus that output to it outputs to the Master instead, and every Send to it is removed, with that Send's Automation.",
    schema: {
      type: "object",
      properties: { busId: BUS_ID_SCHEMA },
      required: ["busId"],
      additionalProperties: false,
    },
    plan(input, project) {
      const bus = findBus(input.busId, project, "busId");
      const others = [...project.tracks, ...project.buses].filter((channel) => channel !== bus);
      const fed = others.filter((channel) => channel.output === bus.id);
      const senders = others.filter((channel) => channel.sends.some((send) => send.busId === bus.id));
      const automated = senders.filter((channel) => channel.automation.some((lane) => lane.setting === `send:${bus.id}`));
      const rerouted = fed.length > 0 ? ` ${feedersText(fed)} now ${fed.length === 1 ? "outputs" : "output"} to the Master.` : "";
      const sends =
        senders.length > 0
          ? ` The ${senders.length === 1 ? "Send" : "Sends"} to it from ${feedersText(senders)} ${senders.length === 1 ? "is" : "are"} gone${automated.length > 0 ? `, and so is the Automation of the ${automated.length === 1 ? "Send" : "Sends"} from ${feedersText(automated)}` : ""}.`
          : "";
      return {
        commands: [{ type: "deleteBus", busId: bus.id }],
        change: `Deleted the Bus “${bus.name}”`,
        report: `Bus ${bus.id} (“${bus.name}”) is gone.${rerouted}${sends}`,
      };
    },
  },

  set_output: {
    group: "routing",
    description:
      "Set where a Track or a Bus outputs its signal: the Master, or a Bus, which runs it through its own Insert Chain, volume and pan before passing it on. A Bus can't output to itself, or to a Bus that feeds it, through outputs or Sends, however indirectly: the signal would go round in a loop, and that is refused.",
    schema: {
      type: "object",
      properties: {
        channel: FEEDER_SCHEMA,
        target: { type: "string", description: 'Where it outputs: a Bus\'s id, as listed in the Project, or "master" for the Master.' },
      },
      required: ["channel", "target"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { owner, from, channel } = findFeeder(input.channel, project);
      const output = input.target === "master" ? null : findBus(input.target, project, "target").id;
      const problem = routingProblem(project, from, output);
      if (problem) reject(`${problem}.`);
      const to = output === null ? "the Master" : `the Bus “${outputName(project, output)}”`;
      return {
        commands: ["busId" in from ? { type: "setBusOutput", busId: from.busId, output } : { type: "setTrackOutput", trackId: from.trackId, output }],
        change: `Routed ${channel.name} to ${to}`,
        report: `${feederText(owner)} outputs to ${output === null ? "the Master" : `Bus ${output} (“${outputName(project, output)}”)`}.`,
      };
    },
  },

  add_send: {
    group: "routing",
    description:
      "Add a Send from a Track or a Bus to a Bus: it passes what leaves the channel, after its volume and pan, to the Bus at a level of its own, as many Tracks send to one Reverb Bus. A channel sends to each Bus at most once. A Bus can't send to itself, or to a Bus that feeds it, through outputs or Sends, however indirectly: the signal would go round in a loop, and that is refused.",
    schema: {
      type: "object",
      properties: {
        channel: FEEDER_SCHEMA,
        busId: { type: "string", description: "The Bus to send to, by its id as listed in the Project." },
        level: {
          type: "number",
          minimum: LIMITS.volume[0],
          maximum: LIMITS.volume[1],
          description: `The Send's level, a linear gain: 1 is unity, 0.5 about -6 dB and 0.25 about -12 dB. Left out, ${DEFAULT_SEND_LEVEL}, as the mixer adds one.`,
        },
      },
      required: ["channel", "busId"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { owner, from, channel } = findFeeder(input.channel, project);
      const bus = findBus(input.busId, project, "busId");
      const level = input.level === undefined ? DEFAULT_SEND_LEVEL : checkRange(input.level, LIMITS.volume, "level");
      const problem = sendProblem(project, from, bus.id);
      if (problem) reject(`${problem}.`);
      return {
        commands: [{ type: "addSend", from, busId: bus.id, level }],
        change: `Added a Send from ${channel.name} to the Bus “${bus.name}” at ${formatDb(level)}`,
        report: `${feederText(owner)} sends to Bus ${bus.id} (“${bus.name}”) at level ${level} (${formatDb(level)}).`,
      };
    },
  },

  remove_send: {
    group: "routing",
    description: "Remove a Track's or a Bus's Send to a Bus, with the Automation of its level.",
    schema: {
      type: "object",
      properties: {
        channel: FEEDER_SCHEMA,
        busId: { type: "string", description: "The Bus the Send goes to, by its id as listed under the channel's sends." },
      },
      required: ["channel", "busId"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { owner, from, channel } = findFeeder(input.channel, project);
      const { bus } = findSend(owner, input.busId, project);
      const automated = owner.automation.some((lane) => lane.setting === `send:${bus.id}`);
      return {
        commands: [{ type: "removeSend", from, busId: bus.id }],
        change: `Removed the Send from ${channel.name} to the Bus “${bus.name}”`,
        report: `${feederText(owner)} no longer sends to Bus ${bus.id} (“${bus.name}”)${automated ? ", and the Automation of its level is gone" : ""}.`,
      };
    },
  },

  set_send_level: {
    group: "routing",
    description:
      "Set the level of a Track's or a Bus's Send to a Bus, as a linear gain: 1 is unity, 0.5 is about -6 dB and 0 sends nothing. It comes after the channel's volume and pan, so it follows them.",
    schema: {
      type: "object",
      properties: {
        channel: FEEDER_SCHEMA,
        busId: { type: "string", description: "The Bus the Send goes to, by its id as listed under the channel's sends." },
        level: {
          type: "number",
          minimum: LIMITS.volume[0],
          maximum: LIMITS.volume[1],
          description: "The new level, a linear gain.",
        },
      },
      required: ["channel", "busId", "level"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { owner, from, channel } = findFeeder(input.channel, project);
      const { bus } = findSend(owner, input.busId, project);
      const level = checkRange(input.level, LIMITS.volume, "level");
      return {
        commands: [{ type: "setSendLevel", from, busId: bus.id, level }],
        change: `Set the Send from ${channel.name} to the Bus “${bus.name}” to ${formatDb(level)}`,
        report: `${feederText(owner)} sends to Bus ${bus.id} (“${bus.name}”) at level ${level} (${formatDb(level)}).${overridden(owner.automation, `send:${bus.id}`, () => "Send's level")}`,
      };
    },
  },

  set_bus_volume: {
    group: "routing",
    description:
      "Set a Bus's volume on the mixer, as a linear gain: 1 is unity (0 dB, where every Bus starts), 0.5 is about -6 dB, 2 is +6 dB and 0 is silent. It turns down everything that feeds it; its Sends come after it, so they follow it.",
    schema: {
      type: "object",
      properties: {
        busId: BUS_ID_SCHEMA,
        volume: {
          type: "number",
          minimum: LIMITS.volume[0],
          maximum: LIMITS.volume[1],
          description: "The new volume, a linear gain.",
        },
      },
      required: ["busId", "volume"],
      additionalProperties: false,
    },
    plan(input, project) {
      const bus = findBus(input.busId, project, "busId");
      const volume = checkRange(input.volume, LIMITS.volume, "volume");
      return {
        commands: [{ type: "setBusMixer", busId: bus.id, mixer: { volume } }],
        change: `Set the Bus “${bus.name}” to ${formatDb(volume)}`,
        report: `Bus ${bus.id} (“${bus.name}”) is at volume ${volume} (${formatDb(volume)}).${overridden(bus.automation, "volume")}`,
      };
    },
  },

  set_bus_pan: {
    group: "routing",
    description: "Set where a Bus sits between the speakers on the mixer.",
    schema: {
      type: "object",
      properties: {
        busId: BUS_ID_SCHEMA,
        pan: {
          type: "number",
          minimum: LIMITS.pan[0],
          maximum: LIMITS.pan[1],
          description: "-1 is hard left, 0 the centre (where every Bus starts) and 1 hard right.",
        },
      },
      required: ["busId", "pan"],
      additionalProperties: false,
    },
    plan(input, project) {
      const bus = findBus(input.busId, project, "busId");
      const pan = checkRange(input.pan, LIMITS.pan, "pan");
      return {
        commands: [{ type: "setBusMixer", busId: bus.id, mixer: { pan } }],
        change: `Panned the Bus “${bus.name}” ${panText(pan)}`,
        report: `Bus ${bus.id} (“${bus.name}”) is panned to ${pan} (${panText(pan)}).${overridden(bus.automation, "pan")}`,
      };
    },
  },

  set_bus_mute: {
    group: "routing",
    description:
      "Mute a Bus on the mixer, or unmute it. A muted Bus plays nothing, not even through its Sends, so it silences everything that feeds it, unless that also reaches the Master another way.",
    schema: {
      type: "object",
      properties: {
        busId: BUS_ID_SCHEMA,
        mute: { type: "boolean", description: "true to mute it, false to unmute it." },
      },
      required: ["busId", "mute"],
      additionalProperties: false,
    },
    plan(input, project) {
      const bus = findBus(input.busId, project, "busId");
      const mute = checkBoolean(input.mute, "mute");
      return {
        commands: [{ type: "setBusMixer", busId: bus.id, mixer: { mute } }],
        change: `${mute ? "Muted" : "Unmuted"} the Bus “${bus.name}”`,
        report: `Bus ${bus.id} (“${bus.name}”) is ${mute ? "muted" : "not muted"}.`,
      };
    },
  },

  set_bus_solo: {
    group: "routing",
    description:
      "Solo a Bus on the mixer, or unsolo it. While any Track or Bus is soloed, only what is soloed plays: a soloed Bus plays with everything that feeds it or sends to it, and the Buses it feeds.",
    schema: {
      type: "object",
      properties: {
        busId: BUS_ID_SCHEMA,
        solo: { type: "boolean", description: "true to solo it, false to unsolo it." },
      },
      required: ["busId", "solo"],
      additionalProperties: false,
    },
    plan(input, project) {
      const bus = findBus(input.busId, project, "busId");
      const solo = checkBoolean(input.solo, "solo");
      return {
        commands: [{ type: "setBusMixer", busId: bus.id, mixer: { solo } }],
        change: `${solo ? "Soloed" : "Unsoloed"} the Bus “${bus.name}”`,
        report: `Bus ${bus.id} (“${bus.name}”) is ${solo ? "soloed" : "not soloed"}.`,
      };
    },
  },

  set_automation: {
    group: "automation",
    description: `Draw a setting's Automation over a range of the song: the breakpoints given replace any the setting has from start to end, both included, and those outside the range stay as they are, so a fade or a sweep can be drawn over part of a lane. Each breakpoint is a tick from the top of the song and a value. From one to the next the value ramps in a straight line, unless the first holds: then it keeps its value and steps to the next's at the next's tick. Before a lane's first breakpoint the value is the first's, and after its last the last's, so a lane that starts with your range sets the setting before it too. While a setting is automated its Automation overrides its fixed value. ${AUTOMATABLE_TEXT} A value out of its setting's range, or a setting the channel can't automate, is refused with what it can take.`,
    schema: {
      type: "object",
      properties: {
        channel: AUTOMATION_CHANNEL_SCHEMA,
        setting: AUTOMATION_SETTING_SCHEMA,
        start: {
          type: "integer",
          minimum: 0,
          description: "The first tick, from the top of the song, of the range the breakpoints replace.",
        },
        end: {
          type: "integer",
          minimum: 0,
          description: "The last tick, from the top of the song, of the range the breakpoints replace, included: a breakpoint may be at end.",
        },
        breakpoints: {
          type: "array",
          minItems: 1,
          description: "The breakpoints from start to end, one to a tick, in any order. To take breakpoints away without drawing new ones, use clear_automation.",
          items: {
            type: "object",
            properties: {
              tick: { type: "integer", minimum: 0, description: "Where, in ticks from the top of the song: from start to end." },
              value: { type: "number", description: "The setting's value there, in its own units and range." },
              hold: {
                type: "boolean",
                description: "true to keep this value until the next breakpoint and step to that one's there. Left out, false: a straight ramp to the next.",
              },
            },
            required: ["tick", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["channel", "setting", "start", "end", "breakpoints"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { channel, owner, automatable } = findAutomationTarget(input, project);
      const start = checkTicks(input.start, "start", 0);
      const end = checkTicks(input.end, "end", 0);
      if (end < start) reject("end must not be before start");
      const drawn = checkBreakpoints(input.breakpoints, { start, end }, automatable, channel);
      const lane = owner.automation.find((candidate) => candidate.setting === automatable.setting)?.breakpoints ?? [];
      const kept = lane.filter((point) => !inAutomationRange(point.tick, { start, end }));
      const breakpoints = [...kept, ...drawn].toSorted((a, b) => a.tick - b.tick);
      if (breakpoints.length > LIMITS.breakpoints) {
        reject(`An Automation holds at most ${LIMITS.breakpoints} breakpoints, and this would leave ${breakpoints.length}`);
      }
      const map = tempoMapOf(project);
      const replaced = lane.length - kept.length;
      return {
        commands: [{ type: "setAutomation", target: channel.target, setting: automatable.setting, breakpoints }],
        change: `Automated ${possessive(channel.name)} ${automatable.label} from ${formatPosition(start, map)} to ${formatPosition(end, map)}`,
        report: `${settingText(channel, automatable)} is automated from tick ${start} to tick ${end} by ${breakpointsText(drawn.length)}${replaced > 0 ? `, in place of the ${replaced} there` : ""}; ${kept.length === 0 ? "it has none outside that range" : `the ${breakpointsText(kept.length)} outside that range ${kept.length === 1 ? "is" : "are"} kept`}. Its Automation overrides its fixed value while the song plays.`,
      };
    },
  },

  clear_automation: {
    group: "automation",
    description:
      "Take away a setting's Automation: all of it, giving the setting back its fixed value, or only the breakpoints from start to end, both included, keeping the rest. A lane left with no breakpoints goes, as if cleared.",
    schema: {
      type: "object",
      properties: {
        channel: AUTOMATION_CHANNEL_SCHEMA,
        setting: { type: "string", description: "The automated setting, as the summary and read_automation name it, e.g. volume or effect:<effectId>:<setting>." },
        start: {
          type: "integer",
          minimum: 0,
          description: "The first tick, from the top of the song, of the breakpoints to take away. Left out, the start of the song.",
        },
        end: {
          type: "integer",
          minimum: 0,
          description: "The last tick, from the top of the song, of the breakpoints to take away, included. Left out, the end of the Automation.",
        },
      },
      required: ["channel", "setting"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { channel, owner, automatable } = findAutomationTarget(input, project);
      const start = input.start === undefined ? undefined : checkTicks(input.start, "start", 0);
      const end = input.end === undefined ? undefined : checkTicks(input.end, "end", 0);
      if (start !== undefined && end !== undefined && end < start) reject("end must not be before start");
      const range = { start, end };
      const lane = owner.automation.find((candidate) => candidate.setting === automatable.setting);
      if (!lane) {
        const automated = owner.automation.map((candidate) => candidate.setting);
        reject(
          `${settingText(channel, automatable)} isn't automated, so there is nothing to clear. ${automated.length > 0 ? `Its automated settings are: ${automated.join(", ")}.` : "None of its settings is automated."}`,
        );
      }
      const kept = lane.breakpoints.filter((point) => !inAutomationRange(point.tick, range));
      const cleared = lane.breakpoints.length - kept.length;
      const whole = range.start === undefined && range.end === undefined;
      if (cleared === 0) {
        reject(`${settingText(channel, automatable)} has no breakpoints${automationRangeText(range)}. read_automation reads where they are.`);
      }
      const map = tempoMapOf(project);
      const where = whole
        ? ""
        : ` from ${formatPosition(range.start ?? 0, map)}${range.end === undefined ? " on" : ` to ${formatPosition(range.end, map)}`}`;
      return {
        commands: [{ type: "setAutomation", target: channel.target, setting: automatable.setting, breakpoints: kept }],
        change: `Cleared ${possessive(channel.name)} ${automatable.label} Automation${where}`,
        report:
          kept.length === 0
            ? `${settingText(channel, automatable)} is no longer automated: its ${breakpointsText(cleared)} are gone, and it is back at its fixed value, ${withUnit(automatable.fixed, automatable.unit)}.`
            : `${settingText(channel, automatable)} lost its ${breakpointsText(cleared)}${automationRangeText(range)}; the ${breakpointsText(kept.length)} outside that range ${kept.length === 1 ? "is" : "are"} kept.`,
      };
    },
  },

  add_effect: {
    group: "sounds",
    description: `Add an Effect to the Insert Chain of a Track, a Bus or the Master. Sound passes through a chain's Effects in order, first to last, before the channel's volume and pan. It starts from the Effect's default settings, with any given here changed. ${EFFECT_SETTINGS_TEXT}`,
    schema: {
      type: "object",
      properties: {
        channel: CHANNEL_SCHEMA,
        effect: {
          type: "string",
          description: `The kind of Effect: ${EFFECT_TYPES.join(", ")}, or plugin:<id> for one of the installed Plugins listed after the Project.`,
        },
        index: {
          type: "integer",
          minimum: 0,
          description: "Where in the chain to put it: 0 is first. Left out, it goes at the end.",
        },
        preset: {
          type: "string",
          description: `A Preset to start from instead of the defaults: a factory one, or one of the musician's User Presets for this Effect. ${EFFECT_PRESETS_TEXT}`,
        },
        settings: {
          ...SETTINGS_SCHEMA,
          description: "Settings to change from the defaults, or from the preset. Left out, none are changed.",
        },
      },
      required: ["channel", "effect"],
      additionalProperties: false,
    },
    plan(input, project, { userPresets }) {
      const channel = findChannel(input.channel, project);
      const effect = checkNewEffect(input.effect);
      const index = input.index === undefined ? undefined : checkIndex(input.index, channel.chain.length);
      const target = presetTargetOf(effect);
      const preset = input.preset === undefined ? undefined : checkPreset(input.preset, target, userPresets);
      const settings = input.settings === undefined ? {} : checkEffectSettings(input.settings, effect);
      Object.assign(effect.settings, preset?.settings, settings);
      const name = effectName(effect);
      const position = index ?? channel.chain.length;
      const from = preset ? ` from its ${presetText(preset)}` : "";
      return {
        commands: [{ type: "addEffect", target: channel.target, effect, index }],
        change: `Added ${article(name)} ${name} to ${channel.name}${from}${settingsText(effect, settings, ", with ")}`,
        report: `Added ${article(name)} ${name} to ${channel.id} at index ${position}, whose effectId is ${effect.id}. Its settings: ${JSON.stringify(effect.settings)}.`,
      };
    },
  },

  remove_effect: {
    group: "sounds",
    description: "Take an Effect out of its Insert Chain.",
    schema: {
      type: "object",
      properties: { effectId: EFFECT_ID_SCHEMA },
      required: ["effectId"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { effect, channel } = findEffect(input.effectId, project);
      const name = effectName(effect);
      const automated = effectAutomated(automationOf(channel, project), effect.id);
      const gone = automated.length > 0 ? ` Its Automation, of ${automated.join(", ")}, went with it.` : "";
      return {
        commands: [{ type: "removeEffect", effectId: effect.id }],
        change: `Removed the ${name} from ${channel.name}`,
        report: `Effect ${effect.id} (${name}) is gone from ${channel.id}.${gone}`,
      };
    },
  },

  move_effect: {
    group: "sounds",
    description: "Move an Effect to another place in its own Insert Chain, which changes the order sound passes through.",
    schema: {
      type: "object",
      properties: {
        effectId: EFFECT_ID_SCHEMA,
        index: { type: "integer", minimum: 0, description: "Its new place in the chain: 0 is first." },
      },
      required: ["effectId", "index"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { effect, channel } = findEffect(input.effectId, project);
      const last = channel.chain.length - 1;
      if (!Number.isInteger(input.index) || (input.index as number) < 0 || (input.index as number) > last) {
        reject(`index must be a whole number from 0 to ${last}, a place in the chain of ${channel.chain.length}`);
      }
      const index = input.index as number;
      const name = effectName(effect);
      const order = channel.chain.filter((other) => other !== effect);
      order.splice(index, 0, effect);
      return {
        commands: [{ type: "moveEffect", effectId: effect.id, index }],
        change: `Moved the ${name} on ${channel.name} to ${ordinal(index + 1)} of ${channel.chain.length}`,
        report: `The Insert Chain of ${channel.id} now runs: ${order.map((other) => `${other.id} (${effectName(other)})`).join(", ")}.`,
      };
    },
  },

  set_effect_settings: {
    group: "sounds",
    description: `Change some of an Effect's settings; the rest stay as they are. ${EFFECT_SETTINGS_TEXT}`,
    schema: {
      type: "object",
      properties: {
        effectId: EFFECT_ID_SCHEMA,
        settings: { ...SETTINGS_SCHEMA, description: "The settings to change, by name, with their new values." },
      },
      required: ["effectId", "settings"],
      additionalProperties: false,
    },
    plan(input, project) {
      const { effect, channel } = findEffect(input.effectId, project);
      const settings = checkEffectSettings(input.settings, effect);
      const name = effectName(effect);
      if (Object.keys(settings).length === 0) reject("settings must name at least one setting to change");
      return {
        commands: [{ type: "setEffectSettings", effectId: effect.id, settings }],
        change: `Set the ${name} on ${channel.name}${settingsText(effect, settings, ": ")}`,
        report: `Effect ${effect.id} (${name}) on ${channel.id} now has settings: ${JSON.stringify({ ...effect.settings, ...settings })}.${effectOverridden(automationOf(channel, project), effect.id, Object.keys(settings))}`,
      };
    },
  },

  load_preset: {
    group: "sounds",
    description:
      "Load a Preset into a Track's Synth or Plugin Instrument, or into an Effect already in an Insert Chain: its settings replace all of the Instrument's or the Effect's, which can then be changed. It may be a factory Preset or one of the musician's User Presets, which are listed after the Project and live outside it. Give trackId for a Synth or a Plugin Instrument, or effectId for an Effect.",
    schema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "An Instrument Track playing the Synth or a Plugin Instrument, by its id." },
        effectId: EFFECT_ID_SCHEMA,
        preset: { type: "string", description: "The Preset's name, factory or User." },
      },
      required: ["preset"],
      additionalProperties: false,
    },
    plan(input, project, { userPresets }) {
      if ((input.trackId === undefined) === (input.effectId === undefined)) {
        reject("load_preset needs trackId, for a Synth or a Plugin Instrument, or effectId, for an Effect: one of them");
      }
      if (input.trackId !== undefined) {
        const track = findInstrumentTrack(input.trackId, project);
        if (track.instrument.type === "drumSampler") {
          reject(`“${track.name}” plays the Drum Sampler, whose Presets are Kits: use set_instrument`);
        }
        if (track.instrument.type === "plugin") {
          const { instrument } = findPluginInstrument(track.id, project);
          const preset = checkPreset(input.preset, instrumentPresetTarget(instrument), userPresets);
          const name = instrumentName(instrument);
          return {
            commands: [{ type: "setInstrumentSettings", trackId: track.id, settings: { ...(preset.settings as Record<string, number>) } }],
            change: `Loaded the ${presetText(preset)} into the ${name} on “${track.name}”`,
            report: `Track ${track.id}'s ${name} has the ${presetText(preset)}. Its settings: ${JSON.stringify(preset.settings)}.${synthOverridden(track.automation, Object.keys(preset.settings))}`,
          };
        }
        const preset = checkPreset(input.preset, "synth", userPresets);
        return {
          commands: [synthPresetCommand(track.id, preset)],
          change: `Loaded the ${presetText(preset)} into “${track.name}”`,
          report: `Track ${track.id}'s Synth has the ${presetText(preset)}. Its settings: ${JSON.stringify(preset.settings)}.${synthOverridden(track.automation, Object.keys(preset.settings))}`,
        };
      }
      const { effect, channel } = findEffect(input.effectId, project);
      rejectMissingPlugin(effect);
      const preset = checkPreset(input.preset, presetTargetOf(effect), userPresets);
      const name = effectName(effect);
      return {
        commands: [{ type: "setEffectSettings", effectId: effect.id, settings: { ...preset.settings } }],
        change: `Loaded the ${presetText(preset)} into the ${name} on ${channel.name}`,
        report: `Effect ${effect.id} (${name}) on ${channel.id} has the ${presetText(preset)}. Its settings: ${JSON.stringify(preset.settings)}.${effectOverridden(automationOf(channel, project), effect.id, Object.keys(preset.settings))}`,
      };
    },
  },

  save_preset: {
    group: "sounds",
    description: `Save the settings a Track's Synth or Plugin Instrument, or an Effect, has now as one of the musician's User Presets, named, in the app's library: load_preset, set_instrument and add_effect then load it by name, in this Project or any other. The library is outside the Project, so saving isn't part of the Request's undo: undoing the Request leaves the Preset saved. A name the Synth, that Plugin or that kind of Effect already has a Preset called, factory or User, is refused rather than saved over: pick another. Automation isn't saved, only each setting's fixed value. A Drum Sampler's Pads are saved as a Kit, with save_kit.`,
    schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "What to save: an Instrument Track playing the Synth or a Plugin Instrument, by its trackId, or an Effect, by its effectId.",
        },
        name: { type: "string", description: `The User Preset's name, 1 to ${LIMITS.nameLength} characters.` },
      },
      required: ["source", "name"],
      additionalProperties: false,
    },
    plan(input, project) {
      const source = findPresetSource(input.source, project);
      const name = checkName(input.name, "name");
      const loads = source.instrument ? "load_preset and set_instrument load" : "load_preset and add_effect load";
      return {
        commands: [],
        save: { preset: { target: source.target, name, settings: source.settings } },
        change: `Saved the settings of ${source.what} as the User Preset “${name}” in the library, outside the Project, which undo leaves as it is`,
        report: `Saved the settings of ${source.what} as the ${targetName(source.target)} User Preset “${name}” in the library, outside the Project, so undoing this Request doesn't remove it: ${loads} it by name, in this Project or any other. Its settings: ${JSON.stringify(source.settings)}.${source.automated}`,
      };
    },
  },

  save_kit: {
    group: "sounds",
    description: `Save a Drum Sampler's Pads as a Kit, named, in the app's library, with a copy of every sample its Pads play: set_instrument then loads it onto a Drum Sampler by name, in this Project or any other. The library is outside the Project, so saving isn't part of the Request's undo: undoing the Request leaves the Kit saved. A name a Kit already has, or the ${STARTER_KIT_PRESET}'s, is refused rather than saved over: pick another. A Synth's or an Effect's settings are saved as a Preset, with save_preset.`,
    schema: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "The Instrument Track playing the Drum Sampler, by its id." },
        name: { type: "string", description: `The Kit's name, 1 to ${LIMITS.nameLength} characters.` },
      },
      required: ["trackId", "name"],
      additionalProperties: false,
    },
    plan(input, project) {
      const track = findInstrumentTrack(input.trackId, project);
      const { instrument } = track;
      if (instrument.type !== "drumSampler") {
        const preset = instrument.type === "synth" ? ": save the Synth's settings with save_preset" : "";
        reject(`“${track.name}” plays the ${instrumentName(instrument)}, not the Drum Sampler, and only a Drum Sampler's Pads are saved as a Kit${preset}`);
      }
      const name = checkName(input.name, "name");
      const samples = new Set(instrument.pads.flatMap((pad) => (pad.sample ? [pad.sample] : []))).size;
      const copied = samples === 0 ? "its Pads all play the bundled sounds, which come with the app" : `with a copy of the ${samples === 1 ? "sample" : `${samples} samples`} its Pads play`;
      return {
        commands: [],
        save: { kit: { name, pads: instrument.pads.map((pad) => ({ ...pad })) } },
        change: `Saved “${track.name}”'s Pads as the Kit “${name}” in the library, outside the Project, which undo leaves as it is`,
        report: `Saved “${track.name}”'s Pads as the Kit “${name}” in the library, ${copied}. The library is outside the Project, so undoing this Request doesn't remove it: set_instrument loads it onto a Drum Sampler by name, in this Project or any other. Its Pads, by pitch: ${padsText(instrument.pads)}.${notSaved(padsAutomated(track.automation)).replace("the Preset", "the Kit")}`,
      };
    },
  },

  load_tools: {
    description:
      "Load a group of tools, listed in the system prompt, for the rest of the Request: its tools can be called from your next turn. Load every group the Request needs together, in one turn, before calling their tools. Changes nothing.",
    schema: {
      type: "object",
      properties: { group: { type: "string", enum: GROUP_NAMES, description: "The group to load." } },
      required: ["group"],
      additionalProperties: false,
    },
    // What it loads depends on the core, so the Request says so (`loadedReport`).
    plan: (input) => ({ commands: [], report: "", load: checkChoice(input.group, GROUP_NAMES, "group") }),
  },
  analyse_audio: {
    description: [
      ...ANALYSE_AUDIO_DESCRIPTION,
      SPECTROGRAM_DESCRIPTION,
      `Set listen to also hear the sound itself: the same render as audio, attached to the result as ${LISTENING_TEXT}. Listen when the numbers can't tell you, such as whether a part sounds right, a mix sounds balanced or a sound is harsh, and hear one Track with trackId: audio costs more than the numbers, so don't listen on every call. A range longer than ${LISTENING.maxSeconds} s is cut to its first ${LISTENING.maxSeconds} s, and the result says so and where: the measurements are still of the whole range, and a later start hears the rest.`,
    ].join(" "),
    schema: {
      type: "object",
      properties: {
        ...ANALYSE_AUDIO_PROPERTIES,
        listen: {
          type: "boolean",
          description: `Also attach what was heard as audio: ${LISTENING_TEXT}. Left out, no audio.`,
        },
      },
      required: [],
      additionalProperties: false,
    },
    unheard: {
      description: [
        ...ANALYSE_AUDIO_DESCRIPTION,
        SPECTROGRAM_DESCRIPTION,
        "You are not sent the audio itself: this model doesn't take audio here, so you get the numbers (and the spectrogram, if you ask for it) only.",
      ].join(" "),
      schema: {
        type: "object",
        properties: { ...ANALYSE_AUDIO_PROPERTIES },
        required: [],
        additionalProperties: false,
      },
    },
    plan(input, project) {
      // The model often asks for the whole mix with an empty trackId, or
      // "master" as the effect tools name the Master, rather than leaving it out.
      const wholeMix = input.trackId === undefined || input.trackId === "" || input.trackId === "master";
      const track = wholeMix ? null : findTrack(input.trackId, project);
      const { start, end, map, at, span } = heardRange(input, project);
      const spectrogram = input.spectrogram === undefined ? false : checkBoolean(input.spectrogram, "spectrogram");
      const audio = input.listen === undefined ? false : checkBoolean(input.listen, "listen");
      const what = track ? `Track ${track.id} (“${track.name}”) on its own` : "the whole mix";
      const attached = `${spectrogram ? SPECTROGRAM_ATTACHED : ""}${audio ? AUDIO_ATTACHED : ""}`;
      return {
        commands: [],
        report: `${what[0]!.toUpperCase()}${what.slice(1)}, ${span}, measured${attached}:`,
        // The engine plays every Track, Audio Tracks included, in Track-list
        // order.
        listen: { start, end, track: track ? project.tracks.indexOf(track) : null, spectrogram, ...(audio && { audio }) },
        ...(audio && { audioNote: audioNote(map, start, end, at) }),
        heard: { trackId: track?.id ?? null, what, span },
      };
    },
  },

  compare_audio: {
    description: [
      "Compare two analyse_audio results of this Request, to check what a change did to the sound: \"did that fix it?\". Returns each measurement before and after and the change (integrated and short-term loudness, RMS, sample and true peaks, clipped samples and regions, energy per frequency band, and the number of onsets), then a line on what got better and what got worse.",
      "Only two analyses of the same thing (the whole mix, or the same Track on its own) over the same range compare: analyse before the change and again, the same way, after it.",
      "Leave out both for the first and the latest analysis of whatever was heard last. It can go in the same turn, straight after the analyse_audio it compares. Changes nothing.",
    ].join(" "),
    schema: {
      type: "object",
      properties: {
        before: {
          type: "string",
          description: "The analysisId of the analysis before the change. Left out, the first of the same target and range as after.",
        },
        after: {
          type: "string",
          description: "The analysisId of the analysis after the change. Left out, the latest of the same target and range as before, or the latest of all.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    plan(input) {
      return {
        commands: [],
        report: "",
        compare: { before: checkAnalysisId(input.before, "before"), after: checkAnalysisId(input.after, "after") },
      };
    },
  },

  compare_to_reference: {
    description: [
      "Compare the mix with the Project's Reference Track, a finished song the musician wants theirs to sound like: \"make my mix sound more like the reference\". Measures the mix as analyse_audio does, and the whole reference the same way.",
      "Returns both and the difference (mix less reference) in integrated and short-term loudness, RMS, true peak and each frequency band; a band's matched difference leaves out the loudness difference, so it is the tonal balance to fix.",
      "Call it before changing the mix and again after, to check it came closer. Its mix analysis has an analysisId for compare_audio. Changes nothing.",
    ].join(" "),
    schema: {
      type: "object",
      properties: {
        start: { type: "number", minimum: 0, description: "Where in the mix to start, in ticks. Left out, the start of the song." },
        end: { type: "number", minimum: 0, description: "Where to stop, in ticks. Left out, the end of the last Clip." },
      },
      required: [],
      additionalProperties: false,
    },
    // A smaller model loads it with the Effects that act on what it finds.
    smallCoreGroup: "sounds",
    plan(input, project) {
      const reference = project.referenceTrack;
      if (!reference) {
        reject("The Project has no Reference Track to compare against: the musician adds one next to the transport. Tell them so.");
      }
      const { start, end, span } = heardRange(input, project);
      return {
        commands: [],
        report: "",
        listen: { start, end, track: null, spectrogram: false },
        heard: { trackId: null, what: "the whole mix", span },
        reference: { file: reference.file, name: fileName(reference.file) },
      };
    },
  },
} satisfies Record<string, Tool>;

export type ToolName = keyof typeof TOOLS;

/**
 * The ticks `input`'s start and end name, the whole song where they are left
 * out, as `analyse_audio` and `compare_to_reference` hear it, and where
 * that is in words. Throws `InvalidToolCall` for a range with nothing in it.
 */
function heardRange(input: Record<string, unknown>, project: Project) {
  const songEnd = songEndTick(project);
  const start = input.start === undefined ? 0 : checkTickPosition(input.start, "start");
  const end = input.end === undefined ? songEnd : checkTickPosition(input.end, "end");
  if (end <= start) {
    reject(
      songEnd === 0 && input.end === undefined
        ? "The Project has no Clips yet, so there is nothing to hear."
        : "end must be after start",
    );
  }
  const map = tempoMapOf(project);
  // Where it is in seconds too, as the measurements place what they find.
  const at = (ticks: number) => `${formatPosition(ticks, map)} (${roundSeconds(secondsAt(map, ticks))} s)`;
  return { start, end, map, at, span: `from ${at(start)} to ${at(end)}` };
}

/**
 * What `analyse_audio`'s attached audio is of: the whole range, or, past
 * `LISTENING.maxSeconds`, its start, and where it was cut and the rest
 * starts. `at` places a tick as the report does.
 */
function audioNote(map: TempoMap, start: number, end: number, at: (ticks: number) => string): string {
  const seconds = secondsBetween(map, start, end);
  if (seconds <= LISTENING.maxSeconds) return `${AUDIO_NOTE_START} all of it, ${LISTENING_TEXT}.`;
  const cut = Math.floor(tickAfter(map, start, LISTENING.maxSeconds));
  return `${AUDIO_NOTE_START} cut to the first ${LISTENING.maxSeconds} s of the ${roundSeconds(seconds)} s, to ${at(cut)}: listening is capped at ${LISTENING.maxSeconds} s. The measurements are of the whole range; to hear the rest, call analyse_audio with listen again from start ${cut}.`;
}

/** One tool as it is sent to the model; each Provider puts it in its own shape. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Tool["schema"];
}

function definition([name, tool]: [string, Tool]): ToolDefinition {
  return { name, description: tool.description, input_schema: tool.schema };
}

/** A tool's definition for a model the Request sends no audio: without the argument that attaches it. */
function unheardDefinition([name, tool]: [string, Tool]): ToolDefinition {
  return tool.unheard ? definition([name, { ...tool, ...tool.unheard }]) : definition([name, tool]);
}

const ENTRIES: [string, Tool][] = Object.entries(TOOLS);

/** Every tool's definition, in a fixed order, whatever its group. */
export const TOOL_DEFINITIONS: ToolDefinition[] = ENTRIES.map(unheardDefinition);

/** The core tools' definitions, which every Request starts with. */
export const CORE_TOOL_DEFINITIONS: ToolDefinition[] = toolDefinitions([]);

/**
 * The smaller core's, which a Local model starts with by default: the core
 * without read_automation, which comes with the automation tools, and
 * set_track_solo and set_master_volume, which come with the routing tools.
 * A smaller model is less reliable the more tools it has to choose from,
 * and each is sent on every turn of a context often only a few thousand
 * tokens long. read_automation is only needed to change Automation, and the
 * summary already says what is automated; soloing is how a musician
 * listens, which analyse_audio's trackId does without leaving a Track
 * soloed; and a smaller model fixing clipping reaches for the Master, which
 * should come down only once the Tracks are balanced.
 */
export const SMALL_CORE_TOOL_DEFINITIONS: ToolDefinition[] = toolDefinitions([], true);

/** The group a tool comes with, whichever core the Request has: `undefined` for one of its core. */
function groupOf(tool: Tool, smallCore: boolean): ToolGroup | undefined {
  return tool.group ?? (smallCore ? tool.smallCoreGroup : undefined);
}

/**
 * The definitions a Request with `loaded` groups sends: its core's and
 * theirs, in the fixed order. `smallCore` for the smaller core, and
 * `hearsAudio` for a Request whose model is sent audio, which alone is
 * offered `analyse_audio`'s `listen`.
 */
export function toolDefinitions(loaded: Iterable<ToolGroup>, smallCore = false, hearsAudio = false): ToolDefinition[] {
  const groups = new Set(loaded);
  return ENTRIES.filter(([, tool]) => {
    const group = groupOf(tool, smallCore);
    return group === undefined || groups.has(group);
  }).map(hearsAudio ? definition : unheardDefinition);
}

/** The group a tool is loaded with, or undefined for one of the core or one that doesn't exist. */
export function toolGroupOf(name: string, smallCore = false): ToolGroup | undefined {
  const tool: Tool | undefined = (TOOLS as Record<string, Tool>)[name];
  return tool && groupOf(tool, smallCore);
}

/** The names of a group's tools, in the fixed order. */
export function groupToolNames(group: ToolGroup, smallCore = false): string[] {
  return ENTRIES.filter(([, tool]) => groupOf(tool, smallCore) === group).map(([name]) => name);
}

/** What the model is told when load_tools loads `group`. */
export function loadedReport(group: ToolGroup, smallCore = false): string {
  const names = groupToolNames(group, smallCore);
  return names.length === 0
    ? `The ${group} group has no tools yet, so what it is for can't be done here: say so if the Request needs it.`
    : `The ${group} tools are loaded for the rest of the Request, to call from your next turn: ${names.join(", ")}.`;
}

/**
 * Check one tool call and work out the commands it becomes. Throws
 * `InvalidToolCall` if the model asked for something it can't have; the
 * Project is only read, never changed.
 */
export function planToolCall(call: ToolCall, project: Project, library: LibraryContents = EMPTY_LIBRARY): ToolPlan {
  const tool: Tool | undefined = (TOOLS as Record<string, Tool>)[call.name];
  if (!tool) reject(`There is no tool called ${call.name}. The tools are: ${Object.keys(TOOLS).join(", ")}.`);
  if (typeof call.input !== "object" || call.input === null || Array.isArray(call.input)) {
    reject(`${call.name} takes an object of arguments`);
  }
  const input = call.input as Record<string, unknown>;
  const extra = Object.keys(input).filter((key) => !(key in tool.schema.properties));
  if (extra.length > 0) reject(`${call.name} has no argument called ${extra.join(" or ")}`);
  const missing = tool.schema.required.filter((key) => input[key] === undefined);
  if (missing.length > 0) reject(`${call.name} needs ${missing.join(" and ")}`);
  return tool.plan(input, project, library);
}

function kindName(kind: Track["kind"]): string {
  return kind === "instrument" ? "Instrument" : "Audio";
}

/** An analysisId as compare_audio takes it, or undefined when left out; which analysis it is, the Request checks. */
function checkAnalysisId(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") reject(`${what} must be an analysisId, as analyse_audio reported it`);
  return value.trim();
}

function checkName(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > LIMITS.nameLength) {
    reject(`${what} must be 1 to ${LIMITS.nameLength} characters`);
  }
  return value.trim();
}

function checkBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") reject(`${what} must be true or false`);
  return value;
}

function checkChoice<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    reject(`${what} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function checkRange(value: unknown, [min, max]: readonly [number, number], what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    reject(`${what} must be a number from ${min} to ${max}`);
  }
  return value;
}

function checkIndex(value: unknown, length: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > length) {
    reject(`index must be a whole number from 0 to ${length}`);
  }
  return value as number;
}

/**
 * What a report adds when the setting it set is automated: that its fixed
 * value changes nothing heard while it is.
 */
function overridden(
  automation: readonly Automation[],
  settings: AutomatedSetting | readonly AutomatedSetting[],
  name: (setting: AutomatedSetting) => string = (setting) => setting,
): string {
  const automated = [settings].flat().filter((setting) => automation.some((lane) => lane.setting === setting));
  if (automated.length === 0) return "";
  const names = automated.map(name).join(", ");
  return automated.length === 1
    ? ` But its ${names} is automated, and its Automation overrides this value while the song plays: the musician hears the Automation, not this, until its Automation is cleared with clear_automation.`
    : ` But its ${names} are automated, and their Automation overrides these values while the song plays: the musician hears the Automation, not these, until their Automation is cleared with clear_automation.`;
}

/** The settings of the Effect `effectId` that `automation` automates, by name. */
function effectAutomated(automation: readonly Automation[], effectId: string): string[] {
  const prefix = `effect:${effectId}:`;
  return automation.flatMap((lane) => (lane.setting.startsWith(prefix) ? [lane.setting.slice(prefix.length)] : []));
}

/** What an Effect's report adds when some of `settings` are automated. */
function effectOverridden(automation: readonly Automation[], effectId: string, settings: readonly string[]): string {
  const prefix = `effect:${effectId}:`;
  return overridden(
    automation,
    settings.map((setting): AutomatedSetting => `effect:${effectId}:${setting}`),
    (setting) => setting.slice(prefix.length),
  );
}

/** What a Synth's report adds when some of `settings` are automated. */
function synthOverridden(automation: readonly Automation[], settings: readonly string[]): string {
  return overridden(
    automation,
    settings.map((setting): AutomatedSetting => `instrument:${setting}`),
    (setting) => setting.slice("instrument:".length),
  );
}

/** What a report adds when the Synth's Automation goes with the Synth. */
function synthGone(automation: readonly Automation[]): string {
  const automated = automation.flatMap((lane) =>
    lane.setting.startsWith("instrument:") ? [lane.setting.slice("instrument:".length)] : [],
  );
  return automated.length > 0 ? ` The Synth's Automation, of ${automated.join(", ")}, went with it.` : "";
}

/** What a report adds when a Track's Instrument Automation goes with its Instrument. */
function instrumentGone(track: InstrumentTrack): string {
  return synthGone(track.automation).replace("The Synth's", `The ${instrumentName(track.instrument)}'s`);
}

/**
 * What a report adds when a Drum Sampler's Pads are replaced by `pads`: the
 * Automation of a Pad the new ones have on its note stays, and overrides
 * what they are set to; a Pad's the new ones haven't got goes with it. Any
 * other Instrument's Automation goes with that Instrument.
 */
function padsOverridden(track: InstrumentTrack, pads: readonly DrumPad[]): string {
  if (track.instrument.type !== "drumSampler") return instrumentGone(track);
  const automated = padsAutomated(track.automation);
  const kept = (param: string) => pads.some((pad) => pad.note === parsePadSetting(param)?.note);
  const gone = automated.filter((param) => !kept(param));
  const overrides = synthOverridden(track.automation, automated.filter(kept));
  return `${overrides}${gone.length > 0 ? ` The Automation of ${gone.join(", ")} went with the Pads the Kit hasn't got.` : ""}`;
}

/** The Automation of a channel's settings and its Effects'. */
function automationOf(channel: Channel, project: Project): readonly Automation[] {
  const { target } = channel;
  if (target === "master") return project.master.automation;
  if ("busId" in target) return busById(project, target.busId)?.automation ?? [];
  return project.tracks.find((track) => track.id === target.trackId)?.automation ?? [];
}

/**
 * The channel and setting a call's `channel` and `setting` name, or a
 * refusal that says which is wrong and, for a setting, lists every one the
 * channel can automate with its range.
 */
function findAutomationTarget(
  input: Record<string, unknown>,
  project: Project,
): { channel: Channel; owner: AutomationOwner; automatable: AutomatableSetting } {
  const channel = findChannel(input.channel, project);
  const model = channelModel(channel, project);
  const owner = model === "master" ? project.master : model;
  const settings = automatableSettings(project, owner);
  const automatable = settings.find((candidate) => candidate.setting === input.setting);
  if (!automatable) {
    const known = settings.map((candidate) => `${candidate.setting} (${candidate.label}, ${automatableRange(candidate)})`);
    reject(
      `${channel.id} has no setting ${JSON.stringify(input.setting)} to automate: mute, solo, bypass and settings that pick from a list or switch on and off never are. It can automate: ${known.join("; ")}.`,
    );
  }
  return { channel, owner, automatable };
}

/** "0 to 2", or "20 to 20000 Hz". */
function automatableRange({ min, max, unit }: AutomatableSetting): string {
  return `${withUnit(min, unit)} to ${withUnit(max, unit)}`;
}

/** For the model: Track pad (“Pad”)'s volume (“Volume”). */
function settingText(channel: Channel, { setting, label }: AutomatableSetting): string {
  return `${possessive(channel.id)} ${setting} (“${label}”)`;
}

function possessive(name: string): string {
  return `${name}'s`;
}

function breakpointsText(count: number): string {
  return `${count} breakpoint${count === 1 ? "" : "s"}`;
}

/** Whether `tick` is in an Automation tool's range, which includes its end. */
function inAutomationRange(tick: number, { start = 0, end = Infinity }: TickRange): boolean {
  return tick >= start && tick <= end;
}

/** What a report says of an Automation tool's range, or nothing for all of it. */
function automationRangeText({ start, end }: TickRange): string {
  if (start === undefined && end === undefined) return "";
  return ` from tick ${start ?? 0}${end === undefined ? " on" : ` to tick ${end}`}`;
}

/**
 * set_automation's breakpoints, each at a tick in `range`, one to a tick,
 * with a value `automatable` takes; `hold` left out is false.
 */
function checkBreakpoints(
  value: unknown,
  range: Required<TickRange>,
  automatable: AutomatableSetting,
  channel: Channel,
): Breakpoint[] {
  if (!Array.isArray(value) || value.length === 0) {
    reject("breakpoints must be a list of at least one {tick, value, hold}; clear_automation takes breakpoints away");
  }
  const seen = new Set<number>();
  return value.map((point: unknown, index): Breakpoint => {
    const what = `breakpoints[${index}]`;
    if (typeof point !== "object" || point === null || Array.isArray(point)) reject(`${what} must be an object of tick, value and hold`);
    const fields = point as Record<string, unknown>;
    const extra = Object.keys(fields).filter((key) => !["tick", "value", "hold"].includes(key));
    if (extra.length > 0) reject(`${what} has no field called ${extra.join(" or ")}: a breakpoint is a tick, a value and hold`);
    const tick = checkTicks(fields.tick, `${what}.tick`, 0);
    if (!inAutomationRange(tick, range)) {
      reject(`${what}.tick, ${tick}, is outside the range: every breakpoint must be from start (${range.start}) to end (${range.end})`);
    }
    if (seen.has(tick)) reject(`${what} is a second breakpoint at tick ${tick}: there may be one to a tick`);
    seen.add(tick);
    const { min, max } = automatable;
    if (typeof fields.value !== "number" || !Number.isFinite(fields.value) || fields.value < min || fields.value > max) {
      reject(
        `${what}.value, ${JSON.stringify(fields.value)}, is out of range: ${settingText(channel, automatable)} takes a number from ${automatableRange(automatable)}`,
      );
    }
    const hold = fields.hold === undefined ? false : checkBoolean(fields.hold, `${what}.hold`);
    return { tick, value: fields.value, hold };
  });
}

/** set_instrument's plan for the installed Plugin Instrument `id`. */
function setPluginInstrument(
  track: InstrumentTrack,
  id: string,
  input: Record<string, unknown>,
  userPresets: readonly UserPreset[],
): ToolPlan {
  if (isVst3Id(id)) reject(VST3_NOT_ADDED);
  const plugin = installedPlugin(id);
  if (plugin?.manifest.kind !== "instrument") {
    reject(`There is no installed Plugin Instrument ${id}. The installed Plugins are listed after the Project.`);
  }
  const instrument = createPluginInstrument(plugin.manifest);
  const name = instrumentName(instrument);
  const preset =
    input.preset === undefined ? undefined : checkPreset(input.preset, instrumentPresetTarget(instrument), userPresets);
  const settings =
    input.settings === undefined
      ? {}
      : (checkTableSettings(input.settings, name, pluginInstrumentTable(instrument)) as Record<string, number>);
  Object.assign(instrument.settings, preset?.settings, settings);
  const from = preset ? ` with its ${presetText(preset)}` : "";
  return {
    commands: [{ type: "setInstrument", trackId: track.id, instrument }],
    change: `“${track.name}” plays the ${name}${from}${instrumentSettingsText(instrument, settings, preset ? ", and " : ", with ")}`,
    report: `Track ${track.id} plays the ${name}${from}. Its settings: ${JSON.stringify(instrument.settings)}.${instrumentGone(track)}`,
  };
}

function findTrack(value: unknown, project: Project): Track {
  if (typeof value !== "string") reject("trackId must be a Track's id");
  const track = project.tracks.find((candidate) => candidate.id === value);
  if (!track) {
    const known = project.tracks.map((candidate) => `${candidate.id} (“${candidate.name}”)`).join(", ");
    reject(`There is no Track ${value}. The Project has: ${known || "no Tracks"}.`);
  }
  return track;
}

/** The Project's audio files, for a message that offers them. */
function projectFilesText(audioFiles: readonly AudioFileLength[]): string {
  if (audioFiles.length === 0) return "The Project has no audio files of its own.";
  return `The Project's audio files: ${audioFiles.map(({ file, seconds }) => `${file} (${roundSeconds(seconds)} s)`).join(", ")}.`;
}

/**
 * Each sample folder by the name the model uses for it: its label, and a
 * number after it where two folders share one.
 */
export function sampleFolderNames(folders: readonly SampleFolder[]): { name: string; folder: SampleFolder }[] {
  const counts = new Map<string, number>();
  return folders.map((folder) => {
    const count = (counts.get(folder.label) ?? 0) + 1;
    counts.set(folder.label, count);
    return { name: count === 1 ? folder.label : `${folder.label} (${count})`, folder };
  });
}

function findSampleFolder(value: unknown, named: readonly { name: string; folder: SampleFolder }[]) {
  const found = named.find(({ name }) => name === value);
  if (!found) reject(`There is no sample folder ${String(value)}. The folders are: ${named.map(({ name }) => name).join(", ")}.`);
  return found;
}

/** A sample named as <folder>/<path>: the longest folder name it starts with, so a name with a slash in it still works. */
function findSample(value: string, named: readonly { name: string; folder: SampleFolder }[]): SampleRef {
  const found = named
    .filter(({ name }) => value.startsWith(`${name}/`) && value.length > name.length + 1)
    .toSorted((a, b) => b.name.length - a.name.length)[0];
  if (!found) {
    const folders = named.length === 0 ? "The musician hasn't added any." : `They are: ${named.map(({ name }) => name).join(", ")}.`;
    reject(`library:${value} isn't in any of the sample browser's folders, named as library:<folder>/<path> from list_samples. ${folders}`);
  }
  return { folder: found.folder, path: value.slice(found.name.length + 1) };
}

function findAudioTrack(value: unknown, project: Project): AudioTrack {
  const track = findTrack(value, project);
  if (track.kind !== "audio") reject(`${track.name} is an Instrument Track: Audio Clips go on an Audio Track, which create_track makes`);
  return track;
}

function findAudioClip(value: unknown, project: Project): { track: AudioTrack; clip: AudioClip } {
  const { track, clip } = findClip(value, project);
  if (track.kind !== "audio" || clip.kind !== "audio") reject(`Clip ${clip.id} is a Pattern Clip: these tools take an Audio Clip`);
  return { track, clip };
}

/** Stems as the musician reads them: "Vocals, Bass". */
function stemLabels(stems: readonly StemName[]): string {
  return stems.map((stem) => STEM_LABELS[stem]).join(", ");
}

/** `separate_stems`' keep: some of the Stems, by name, or all four when left out. */
function checkStems(value: unknown): StemName[] {
  if (value === undefined) return [...STEM_NAMES];
  const names = STEM_TRACK_ORDER.join(", ");
  if (!Array.isArray(value) || value.length === 0) reject(`keep must be a list of the Stems to keep, of ${names}`);
  for (const stem of value) {
    if (!STEM_NAMES.includes(stem as StemName)) reject(`keep can only name ${names}, not ${JSON.stringify(stem)}`);
  }
  return [...new Set(value as StemName[])];
}

function findInstrumentTrack(value: unknown, project: Project): InstrumentTrack {
  const track = findTrack(value, project);
  if (track.kind !== "instrument") reject(`${track.name} is an Audio Track: it has no Instrument or Pattern Clips`);
  return track;
}

function findClip(value: unknown, project: Project): { track: Track; clip: Clip } {
  if (typeof value !== "string") reject("clipId must be a Clip's id");
  for (const track of project.tracks) {
    const clip = (track.clips as Clip[]).find((candidate) => candidate.id === value);
    if (clip) return { track, clip };
  }
  reject(`There is no Clip ${value}. Each Track's Clips, with their ids, are listed in the Project.`);
}

/** The Preset for `target` called `value`, factory or User; the ones there are are named if not. */
function checkPreset(value: unknown, target: PresetTarget, userPresets: readonly UserPreset[]): ListedPreset {
  const preset = typeof value === "string" ? findPreset(target, value, userPresets) : undefined;
  if (!preset) {
    const names = presetsFor(target, userPresets).map((candidate) => candidate.name);
    const known = names.length > 0 ? `Its presets are: ${names.join(", ")}.` : "It has none.";
    reject(`The ${targetName(target)} has no preset called ${JSON.stringify(value)}. ${known}`);
  }
  return preset;
}

/** “Name” preset, or “Name” User Preset, as the change and report say it. */
function presetText(preset: ListedPreset): string {
  return `“${preset.name}” ${preset.source === "user" ? "User Preset" : "preset"}`;
}

/**
 * The Kit called `value`: the bundled one, or one of the musician's saved
 * Kits, an exact name first and then one that differs only in case. The
 * ones there are are named if not.
 */
function checkKit(value: unknown, savedKits: readonly SavedKit[]): SavedKit {
  const kits = [BUNDLED_KIT, ...savedKits];
  const kit =
    typeof value === "string"
      ? (kits.find((candidate) => candidate.name === value) ??
        kits.find((candidate) => candidate.name.trim().toLowerCase() === value.trim().toLowerCase()))
      : undefined;
  if (!kit) {
    reject(`The Drum Sampler has no Kit called ${JSON.stringify(value)}. Its Kits are: ${kits.map((candidate) => candidate.name).join(", ")}.`);
  }
  return kit;
}

/**
 * What `save_preset` saves from: a Track's Synth or Plugin Instrument, by
 * its trackId, or an Effect, by its effectId, with its settings now and a
 * note for any of them that is automated, whose Automation a Preset
 * doesn't keep.
 */
function findPresetSource(
  value: unknown,
  project: Project,
): { target: PresetTarget; settings: PresetSettings; what: string; automated: string; instrument: boolean } {
  if (typeof value !== "string") reject("source must be an Instrument Track's trackId or an Effect's effectId");
  const track = project.tracks.find((candidate) => candidate.id === value);
  if (track) {
    if (track.kind !== "instrument") reject(`${track.name} is an Audio Track: it has no Instrument to save`);
    const { instrument } = track;
    if (instrument.type === "drumSampler") {
      reject(`“${track.name}” plays the Drum Sampler, whose Pads are saved as a Kit: use save_kit`);
    }
    // A missing Plugin's settings are kept as they were, but not saved.
    if (instrument.type === "plugin") findPluginInstrument(track.id, project);
    const lanes = track.automation.filter((lane) => lane.setting.startsWith("instrument:"));
    const names = lanes.map((lane) => lane.setting.slice("instrument:".length));
    return {
      target: instrument.type === "plugin" ? instrumentPresetTarget(instrument) : "synth",
      settings: { ...instrument.settings },
      what: `the ${instrumentName(instrument)} on “${track.name}”`,
      automated: notSaved(names),
      instrument: true,
    };
  }
  let found;
  try {
    found = findEffect(value, project);
  } catch {
    reject(`There is no Track or Effect ${value}. source is an Instrument Track's trackId or an Effect's effectId, as listed in the Project.`);
  }
  const { effect, channel } = found;
  rejectMissingPlugin(effect);
  const prefix = `effect:${effect.id}:`;
  const names = automationOf(channel, project).flatMap((lane) => (lane.setting.startsWith(prefix) ? [lane.setting.slice(prefix.length)] : []));
  return {
    target: presetTargetOf(effect),
    settings: { ...effect.settings },
    what: `the ${effectName(effect)} on ${channel.name}`,
    automated: notSaved(names),
    instrument: false,
  };
}

/** What a save_preset report adds for settings that are automated: a Preset keeps their fixed values. */
function notSaved(settings: readonly string[]): string {
  if (settings.length === 0) return "";
  const are = settings.length === 1 ? "is" : "are";
  return ` ${settings.join(", ")} ${are} automated: the Preset keeps ${settings.length === 1 ? "its" : "their"} fixed value, not the Automation.`;
}

/** The Pad settings `automation` automates, as the Instrument names them: pad36.volume. */
function padsAutomated(automation: readonly Automation[]): string[] {
  return automation.flatMap((lane) => {
    const param = lane.setting.startsWith("instrument:") ? lane.setting.slice("instrument:".length) : "";
    return parsePadSetting(param) ? [param] : [];
  });
}

/** A Kit's Pads as the model reads them: each one's name and the note that plays it. */
function padsText(pads: readonly DrumPad[]): string {
  return pads.map((pad) => `${pad.name} ${pad.note}`).join(", ");
}

function checkTicks(value: unknown, what: string, min: number): number {
  if (!Number.isInteger(value) || (value as number) < min) {
    reject(`${what} must be a whole number of ticks, ${min} or more`);
  }
  return value as number;
}

function checkBars(value: unknown, what: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) reject(`${what} must be a whole number of bars, 1 or more`);
  return value as number;
}

/** Where a Tempo Change at `value` bars (counting from 1, past bar 1) goes on `map`: a whole bar if `barLine`. */
function checkChangeBar(value: unknown, map: TempoMap, barLine: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 1) {
    reject("bar must be a bar number past 1, counting from 1: bar 1 is the song's start, whose tempo set_tempo sets and whose time signature set_time_signature sets");
  }
  if (barLine && !Number.isInteger(value)) {
    reject(`A time signature can only change at a bar line, and bar ${value} is part way through bar ${Math.floor(value)}: give a whole bar`);
  }
  return Math.round(tickAtBars(map, value));
}

function findTempoChange(value: unknown, project: Project): TempoChange {
  const change = project.tempoChanges.find((candidate) => candidate.id === value);
  if (!change) {
    const map = tempoMapOf(project);
    const ids = project.tempoChanges.map((candidate) => `${candidate.id} (at ${formatPosition(candidate.tick, map)})`).join(", ");
    reject(`There's no Tempo Change with id ${String(value)}. ${ids ? `The Tempo Changes are: ${ids}.` : "The song has no Tempo Changes."}`);
  }
  return change;
}

/**
 * Refuse `tempoChanges`, from `timeSignature` at the start, if a time
 * signature in them would fall off a bar line: a time signature moves every
 * bar line after it.
 */
function checkSignaturesOnBarLines(project: Project, timeSignature: TimeSignature, tempoChanges: readonly TempoChange[], doing: string) {
  tempoChanges.forEach((change, index) => {
    if (!change.timeSignature) return;
    const before = tempoMapOf({ tempo: project.tempo, timeSignature, tempoChanges: tempoChanges.slice(0, index) });
    if (isBarLine(before, change.tick)) return;
    const { bar } = barBeatTick(before, change.tick);
    reject(
      `${doing} would leave Tempo Change ${change.id}'s time signature, ${signatureText(change.timeSignature)} at tick ${change.tick}, part way through bar ${bar}, and a time signature can only change at a bar line. Delete that Tempo Change first and set its time signature again at the bar you want`,
    );
  });
}

function signatureText({ beatsPerBar, beatUnit }: TimeSignature): string {
  return `${beatsPerBar}/${beatUnit}`;
}

function barTicksText(timeSignature: TimeSignature): string {
  return `${barTicks(timeSignature)} ticks to a bar`;
}

/** The tempo and time signature at `tick`, as "90 BPM in 4/4". */
function tempoAtText(map: TempoMap, tick: number): string {
  const segment = segmentAt(map, tick);
  return `${segment.tempo} BPM in ${signatureText(segment.timeSignature)}`;
}

/**
 * The plan for an arrangement edit: one `rearrange` command, and a report
 * of what moved and the Sections as they are now, for the model to go on
 * from. `change` is the musician's line, given the Section made or moved.
 */
function arrangementPlan(project: Project, edit: ArrangementEdit, change: string | ((section?: Section) => string)): ToolPlan {
  const problem = arrangementProblem(project, edit);
  if (problem) reject(problem);
  const { arrangement, split, removed, section } = arrange(project, edit);
  const line = typeof change === "string" ? change : change(section);
  const after = tempoMapOf(arrangement);
  const clips = [
    split > 0 ? `${split === 1 ? "1 Clip was" : `${split} Clips were`} split at its edges` : "",
    removed > 0 ? `${removed === 1 ? "1 Clip was" : `${removed} Clips were`} deleted with the bars` : "",
  ].filter(Boolean);
  const sections =
    arrangement.sections.length === 0
      ? "The song has no Sections."
      : `The Sections are now: ${arrangement.sections
          .map((each) => `“${each.name}” (${sectionBarsText(each)}, ticks ${sectionTicks(each, after).start} up to ${sectionTicks(each, after).end}, sectionId ${each.id})`)
          .join(", ")}.`;
  return {
    commands: [{ type: "rearrange", arrangement }],
    change: line,
    report: `${line}.${clips.length > 0 ? ` ${clips.join(", and ")}.` : ""} Every Clip, breakpoint and Tempo Change after it moved with its bars, so ids and ticks you read before may have changed: read them again before changing them. ${sections}`,
  };
}

function barsText(count: number): string {
  return count === 1 ? "1 bar" : `${count} bars`;
}

/** A Section by its id, or by its name (ignoring case) if only one has it. */
function findNamedSection(value: unknown, project: Project): Section {
  const byId = project.sections.find((candidate) => candidate.id === value);
  if (byId) return byId;
  const named =
    typeof value === "string" ? project.sections.filter((candidate) => candidate.name.toLowerCase() === value.trim().toLowerCase()) : [];
  if (named.length === 1) return named[0]!;
  const ids = project.sections.map((candidate) => `${candidate.id} (“${candidate.name}”, ${sectionBarsText(candidate)})`).join(", ");
  if (named.length > 1) reject(`${named.length} Sections are called “${named[0]!.name}”: give the sectionId of the one you mean. The Sections are: ${ids}.`);
  reject(`There's no Section with id or name ${String(value)}. ${ids ? `The Sections are: ${ids}.` : "The song has no Sections."}`);
}

function findSection(value: unknown, project: Project): Section {
  const section = project.sections.find((candidate) => candidate.id === value);
  if (!section) {
    const ids = project.sections.map((candidate) => `${candidate.id} (“${candidate.name}”)`).join(", ");
    reject(`There's no Section with id ${String(value)}. ${ids ? `The Sections are: ${ids}.` : "The song has no Sections."}`);
  }
  return section;
}

/** Notes from the model, checked to fit a Clip `clipLength` long on `track`. */
function checkNotes(value: unknown, clipLength: number, track: InstrumentTrack): Note[] {
  if (!Array.isArray(value)) reject("notes must be a list of notes");
  const notes = value.map((note: unknown, index): Note => {
    const which = `Note ${index + 1}`;
    if (typeof note !== "object" || note === null || Array.isArray(note)) reject(`${which} must be an object`);
    const fields = note as Record<string, unknown>;
    const extra = Object.keys(fields).filter((key) => !NOTE_KEYS.includes(key));
    if (extra.length > 0) reject(`${which} has no field called ${extra.join(" or ")}`);
    const [low, high] = LIMITS.pitch;
    if (!Number.isInteger(fields.pitch) || (fields.pitch as number) < low || (fields.pitch as number) > high) {
      reject(`${which}'s pitch must be a MIDI note number from ${low} to ${high}`);
    }
    const start = fields.start;
    if (!Number.isInteger(start) || (start as number) < 0 || (start as number) >= clipLength) {
      reject(`${which}'s start must be a whole number of ticks from 0 to ${clipLength - 1}, inside its Clip`);
    }
    const length = checkTicks(fields.length, `${which}'s length`, 1);
    const velocity =
      fields.velocity === undefined
        ? STEP_VELOCITY
        : checkRange(fields.velocity, LIMITS.velocity, `${which}'s velocity`);
    return { pitch: fields.pitch as number, start: start as number, length, velocity };
  });
  checkNotesPlayable(notes, track);
  return notes;
}

/**
 * On a Drum Sampler, a note no Pad plays would be silent, so it is refused.
 * `which` names a note by its place in `notes`.
 */
function checkNotesPlayable(
  notes: readonly Note[],
  track: InstrumentTrack,
  which: (index: number) => string = (index) => `Note ${index + 1}`,
) {
  if (track.instrument.type !== "drumSampler") return;
  const pads = track.instrument.pads;
  const index = notes.findIndex((note) => !pads.some((pad) => pad.note === note.pitch));
  if (index === -1) return;
  const known = pads.map((pad) => `${pad.name} ${pad.note}`).join(", ");
  reject(
    `${which(index)}'s pitch ${notes[index]!.pitch} plays no Pad on “${track.name}”, a Drum Sampler. Its Pads, by pitch: ${known}.`,
  );
}

/** A Pattern Clip, for the tools that edit its notes. */
function findPatternClip(value: unknown, project: Project): { track: InstrumentTrack; clip: PatternClip } {
  const { track, clip } = findClip(value, project);
  if (track.kind !== "instrument" || clip.kind !== "pattern") reject(`Clip ${clip.id} is an Audio Clip: it has no notes`);
  return { track, clip };
}

/**
 * Where in the Clip's notes the notes `value` names by id are, each once.
 * An id the Clip doesn't have is refused, naming it, and nothing changes.
 */
function findNotes(value: unknown, clip: PatternClip): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== "string")) {
    reject("noteIds must be a list of note ids, as read_notes gives them");
  }
  const ids = noteIds(clip.notes);
  const unknown = (value as string[]).filter((id) => !ids.includes(id));
  if (unknown.length > 0) {
    const them = unknown.length === 1 ? `note with id ${unknown[0]}` : `notes with ids ${unknown.join(", ")}`;
    reject(`Clip ${clip.id} has no ${them}. read_notes gives its notes' ids, which change when a note moves.`);
  }
  return [...new Set(value as string[])].map((id) => ids.indexOf(id));
}

/** Where in the Clip's notes those starting in `range` are, for a tool that takes a range; none is refused. */
function notesInRange(clip: PatternClip, range: TickRange): number[] {
  const indices = clip.notes.flatMap((note, index) => (inRange(note.start, range) ? [index] : []));
  if (indices.length === 0) reject(`Clip ${clip.id} has no notes${readRangeText(range, "of the Clip")}`);
  return indices;
}

/**
 * A note tool's plan: the Clip's notes with `edited` in place of those at
 * `indices`, merged as the Piano Roll merges an edit, so one landing on
 * another's pitch and start replaces it. It is one `setPatternNotes`
 * command, the one the Piano Roll makes, so either editor shows it. The
 * report lists the edited notes with their ids as the Clip will have them.
 */
function editNotes(
  track: InstrumentTrack,
  clip: PatternClip,
  indices: readonly number[],
  edited: Note[],
  said: { change: string; report: string },
): ToolPlan {
  const chosen = new Set(indices);
  const kept = clip.notes.filter((_, index) => !chosen.has(index));
  const { notes } = merged(kept, edited);
  const replaced = kept.length + edited.length - notes.length;
  // The order `setPatternNotes` keeps them in, which their ids count by.
  const sorted = notes.toSorted((a, b) => a.start - b.start || a.pitch - b.pitch);
  const ids = noteIds(sorted);
  const detail = edited.map((note) => ({ id: ids[sorted.indexOf(note)]!, ...note }));
  const landed = replaced === 0 ? "" : `, replacing ${notesText(replaced)} they landed on`;
  return {
    commands: [{ type: "setPatternNotes", clipId: clip.id, notes }],
    change: `${said.change}${landed}`,
    report: `${said.report}${landed}. Clip ${clip.id} on Track ${track.id} now holds ${notesText(notes.length)}; the ones changed:\n${JSON.stringify(detail)}`,
  };
}

function notesText(count: number): string {
  return `${count} ${count === 1 ? "note" : "notes"}`;
}

function ticksText(ticks: number): string {
  return `${Math.abs(ticks)} ${Math.abs(ticks) === 1 ? "tick" : "ticks"} ${ticks > 0 ? "later" : "earlier"}`;
}

function semitonesText(semitones: number): string {
  if (semitones === 0) return "by 0 semitones";
  return `${Math.abs(semitones)} ${Math.abs(semitones) === 1 ? "semitone" : "semitones"} ${semitones > 0 ? "up" : "down"}`;
}

function checkWhole(value: unknown, what: string): number {
  if (!Number.isInteger(value)) reject(`${what} must be a whole number`);
  return value as number;
}

/** A pitch a move or transposition lands a note on, which must still be a MIDI note. */
function checkPitch(pitch: number, what: string): number {
  const [low, high] = LIMITS.pitch;
  if (pitch < low || pitch > high) reject(`${what} would take it to ${pitch}, past the MIDI notes ${low} to ${high}`);
  return pitch;
}

function noteCount(notes: readonly Note[]): string {
  if (notes.length === 0) return "";
  return ` with ${notes.length} ${notes.length === 1 ? "note" : "notes"}`;
}
/** A position on the Timeline, which need not fall on a whole tick. */
function checkTickPosition(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    reject(`${what} must be a number of ticks, 0 or more`);
  }
  return value;
}

function panText(pan: number): string {
  if (pan === 0) return "to the centre";
  return `${Math.round(Math.abs(pan) * 100)}% ${pan < 0 ? "left" : "right"}`;
}

/** The Track, Bus or Master a channel is. */
function channelModel(channel: Channel, project: Project): Track | Bus | "master" {
  const { target } = channel;
  if (target === "master") return "master";
  const found = "busId" in target ? busById(project, target.busId) : project.tracks.find((track) => track.id === target.trackId);
  if (!found) throw new Error(`${channel.id} is gone`);
  return found;
}

/** A read tool's start and end, in whole ticks; either may be left out. */
function checkTickRange(input: Record<string, unknown>): TickRange {
  const start = input.start === undefined ? undefined : checkTicks(input.start, "start", 0);
  const end = input.end === undefined ? undefined : checkTicks(input.end, "end", 0);
  if (start !== undefined && end !== undefined && end <= start) reject("end must be after start");
  return { start, end };
}

/** What a read's report says of its range, or nothing for the whole of `whole`. */
function readRangeText({ start, end }: TickRange, whole: string): string {
  if (start === undefined && end === undefined) return "";
  return `, from tick ${start ?? 0}${end === undefined ? ` to the end ${whole}` : ` up to tick ${end}`}`;
}

/** A mixer channel with an Insert Chain: a Track's, a Bus's or the Master's. */
interface Channel {
  target: ChainTarget;
  chain: readonly Effect[];
  /** For the musician: “Keys”, or the Master. */
  name: string;
  /** For the model: Track keys (“Keys”), Bus band (“Band”), or the Master. */
  id: string;
}

function findChannel(value: unknown, project: Project): Channel {
  if (value === "master") {
    return { target: "master", chain: project.master.insertChain, name: "the Master", id: "the Master" };
  }
  if (typeof value !== "string") reject('channel must be a Track\'s or a Bus\'s id, or "master"');
  const bus = busById(project, value);
  if (bus) {
    return {
      target: { busId: bus.id },
      chain: bus.insertChain,
      name: `the Bus “${bus.name}”`,
      id: `Bus ${bus.id} (“${bus.name}”)`,
    };
  }
  if (!project.tracks.some((track) => track.id === value) && project.buses.length > 0) {
    const known = [...project.tracks, ...project.buses].map((channel) => `${channel.id} (“${channel.name}”)`).join(", ");
    reject(`There is no Track or Bus ${value}. The Project has: ${known}.`);
  }
  const track = findTrack(value, project);
  return {
    target: { trackId: track.id },
    chain: track.insertChain,
    name: `“${track.name}”`,
    id: `Track ${track.id} (“${track.name}”)`,
  };
}

/** The Bus `value` names, or a refusal that lists the Buses there are. */
function findBus(value: unknown, project: Project, what: string): Bus {
  if (typeof value !== "string") reject(`${what} must be a Bus's id`);
  const bus = busById(project, value);
  if (!bus) {
    const known = project.buses.map((candidate) => `${candidate.id} (“${candidate.name}”)`).join(", ");
    reject(`There is no Bus ${value}. ${known ? `The Project's Buses are: ${known}.` : "The Project has no Buses: add_bus adds one."}`);
  }
  return bus;
}

/** The Track or Bus `value` names, as a channel that feeds others: the Master feeds nothing. */
function findFeeder(value: unknown, project: Project): { owner: Track | Bus; from: Feeder; channel: Channel } {
  if (value === "master") reject("The Master has no output or Sends: it is where every Track and Bus ends up");
  const channel = findChannel(value, project);
  return { owner: channelModel(channel, project) as Track | Bus, from: channel.target as Feeder, channel };
}

/** A Track or Bus, for the model: Track bass (“Bass”), or Bus band (“Band”). */
function feederText(channel: Track | Bus): string {
  return `${"kind" in channel ? "Track" : "Bus"} ${channel.id} (“${channel.name}”)`;
}

function feedersText(channels: readonly (Track | Bus)[]): string {
  return channels.map(feederText).join(", ");
}

/** `owner`'s Send to the Bus `value` names, or a refusal that lists the Sends it has. */
function findSend(owner: Track | Bus, value: unknown, project: Project): { bus: Bus } {
  const bus = findBus(value, project, "busId");
  if (!owner.sends.some((send) => send.busId === bus.id)) {
    const sends = owner.sends.map((send) => send.busId).join(", ");
    reject(`${feederText(owner)} has no Send to Bus ${bus.id} (“${bus.name}”). ${sends ? `It sends to: ${sends}.` : "It has no Sends: add_send adds one."}`);
  }
  return { bus };
}

function findEffect(value: unknown, project: Project): { effect: Effect; channel: Channel } {
  if (typeof value !== "string") reject("effectId must be an Effect's id");
  const channels = ["master", ...project.tracks.map((track) => track.id), ...project.buses.map((bus) => bus.id)];
  for (const channel of channels.map((id) => findChannel(id, project))) {
    const effect = channel.chain.find((candidate) => candidate.id === value);
    if (effect) return { effect, channel };
  }
  reject(`There is no Effect ${value}. Each Insert Chain's Effects, with their ids, are listed in the Project.`);
}

/**
 * The Effect `value` names, new and at its defaults: a built-in by its type,
 * or an installed Plugin as plugin:<id>.
 */
function checkNewEffect(value: unknown): Effect {
  if (typeof value === "string" && value.startsWith("plugin:")) {
    if (isVst3Id(value.slice("plugin:".length))) reject(VST3_NOT_ADDED);
    const plugin = installedPlugin(value.slice("plugin:".length));
    if (plugin?.manifest.kind === "effect") return createPluginEffect(plugin.manifest);
    reject(`There is no installed Plugin ${value.slice("plugin:".length)}. The installed Plugins are listed after the Project.`);
  }
  return createEffect(checkChoice(value, EFFECT_TYPES, "effect"));
}

/**
 * A VST3 Plugin is loaded into a process of its own before it is added, which
 * can take a minute and may need the musician (a licence, a login), so only
 * the musician adds one.
 */
const VST3_NOT_ADDED =
  "A VST3 Plugin is added by the musician, from an Insert Chain or the Tracks menu: the Assistant changes only the settings of those already in the Project, which read_channel lists.";

/** Which Plugin is missing, and until when its settings can't be changed. */
function missingPlugin({ plugin, vst3 }: { plugin: { id: string; version: string }; vst3?: Vst3Part }): { which: string; until: string } {
  return vst3
    ? {
        which: `the VST3 Plugin ${vst3.name} (${vst3.vendor}), which isn't running here: it isn't installed on this machine, hasn't loaded yet or has crashed, or this is the browser version of Soundcheck`,
        until: "until it is running",
      }
    : { which: `the Plugin ${plugin.id} ${plugin.version}, which isn't installed`, until: "until the musician installs it" };
}

/** A Plugin Effect whose Plugin isn't installed declares no settings, so none can be changed. */
function rejectMissingPlugin(effect: Effect): void {
  if (isMissingPlugin(effect)) {
    const { which, until } = missingPlugin(effect);
    reject(
      `Effect ${effect.id} is ${which}: it passes the sound through untouched and keeps its settings, which can't be changed ${until}.`,
    );
  }
}

/**
 * Settings from the model for `effect`, each checked against the range the
 * Effect declares, a Plugin's in its manifest. Only the settings given are
 * returned.
 */
function checkEffectSettings(value: unknown, effect: Effect): Record<string, string | number> {
  rejectMissingPlugin(effect);
  return checkTableSettings(value, effectName(effect), effectTable(effect));
}

/** Settings from the model, each checked against the range `table` declares; only those given are returned. */
function checkTableSettings(value: unknown, name: string, table: readonly TableParam[]): Record<string, string | number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("settings must be an object of settings by name");
  }
  const settings: Record<string, string | number> = {};
  for (const [key, setting] of Object.entries(value)) {
    const param = table.find((candidate) => candidate.name === key);
    if (!param) {
      const known = table.map((candidate) => candidate.name);
      reject(`The ${name} has no setting called ${key}. Its settings are: ${known.join(", ")}.`);
    }
    if (param.choices.length > 0) {
      if (typeof setting !== "string" || !param.choices.includes(setting)) {
        reject(`The ${name}'s ${key} must be one of ${param.choices.join(", ")}`);
      }
    } else if (
      typeof setting !== "number" ||
      !Number.isFinite(setting) ||
      setting < param.min ||
      setting > param.max ||
      !onStep(param, setting)
    ) {
      reject(`The ${name}'s ${key} must be ${rangeText(param)}`);
    }
    settings[key] = setting;
  }
  // Every name is one of its settings and every value one it may take.
  return settings;
}

/** A Track's Plugin Instrument, or a rejection if it hasn't one or its Plugin is missing. */
function findPluginInstrument(value: unknown, project: Project): { track: InstrumentTrack; instrument: PluginInstrument } {
  const track = findInstrumentTrack(value, project);
  const { instrument } = track;
  if (instrument.type !== "plugin") {
    reject(`“${track.name}” plays the ${instrumentName(instrument)}, not a Plugin Instrument: its settings aren't changed here`);
  }
  if (isMissingInstrument(instrument)) {
    const { which, until } = missingPlugin(instrument);
    reject(`Track ${track.id} plays ${which}: it is silent and keeps its settings, which can't be changed ${until}.`);
  }
  return { track, instrument };
}

/** A Plugin Instrument's settings changed, in the musician's words. */
function instrumentSettingsText(instrument: PluginInstrument, settings: Record<string, number>, lead: string): string {
  const entries = Object.entries(settings);
  if (entries.length === 0) return "";
  const table = pluginInstrumentTable(instrument);
  const parts = entries.map(([key, value]) => {
    const param = table.find((candidate) => candidate.name === key)!;
    return `${param.label.toLowerCase()} ${withUnit(value, param.unit)}`;
  });
  return lead + parts.join(", ");
}

function onStep(param: TableParam, value: number): boolean {
  if (param.step <= 0) return true;
  const steps = (value - param.min) / param.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/** What a setting may be, as the model reads it: "a number from 20 to 20000 Hz". */
function rangeText(param: TableParam): string {
  const step = param.step > 0 ? `, in steps of ${param.step}` : "";
  return `a number from ${param.min} to ${withUnit(param.max, param.unit)}${step}`;
}

function paramText(param: TableParam): string {
  const values = param.choices.length > 0 ? param.choices.join(" or ") : rangeText(param).replace("a number from ", "");
  return `${param.name} (${values})`;
}

/** "20 Hz", or "4:1" for a unit that reads as part of the number. */
function withUnit(value: string | number, unit: string): string {
  if (!unit) return String(value);
  return /^\w/.test(unit) ? `${value} ${unit}` : `${value}${unit}`;
}

/** The settings changed, in the musician's words, or nothing if none were. */
function settingsText(effect: Effect, settings: Record<string, string | number>, lead: string): string {
  const entries = Object.entries(settings);
  if (entries.length === 0) return "";
  const table = effectTable(effect);
  const parts = entries.map(([key, value]) => {
    const param = table.find((candidate) => candidate.name === key)!;
    return `${param.label.toLowerCase()} ${param.choices.length > 0 ? value : withUnit(value, param.unit)}`;
  });
  return lead + parts.join(", ");
}

function article(word: string): string {
  return /^[AEIOU]/.test(word) ? "an" : "a";
}

function ordinal(place: number): string {
  const suffix = place % 100 >= 11 && place % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][place % 10] ?? "th");
  return `${place}${suffix}`;
}

import { describe, expect, test } from "vitest";

import { arrange } from "./arrangement";
import type { Command, CommandType } from "./commands";
import { applyCommand, applyCommands } from "./commands";
import { deepFreeze, sampleProject } from "./fixtures";
import { ProjectHistory } from "./history";
import { keysPreset } from "../instrument/keys-presets";
import { synthPreset } from "../instrument/synth-presets";
import {
  createAudioTrack,
  createBus,
  createDrumTrack,
  createEffect,
  createInstrumentTrack,
  createKeysTrack,
  DEFAULT_SYNTH,
  type Project,
  STARTER_KIT,
} from "./model";

/** A Tempo Change to 90 BPM at bar 3, for the cases that edit one. */
const ninety: Command = {
  type: "addTempoChange",
  tempoChange: { id: "tc", tick: 7680, tempo: 90, timeSignature: null },
};

/** An eight-bar chorus from bar 9, for the cases that edit one. */
const chorus: Command = { type: "addSection", section: { id: "chorus", name: "Chorus", startBar: 9, bars: 8 } };

/** The sample song and its chorus with two bars inserted before bar 1, for `rearrange`. */
const withChorus = applyCommand(sampleProject(), chorus);
const twoBarsIn: Command = {
  type: "rearrange",
  arrangement: arrange(withChorus.ok ? withChorus.project : sampleProject(), { kind: "insertBars", at: 1, count: 2 }).arrangement,
};

/** A second Bus, Drums, feeding Band, and Keys feeding Drums. */
const buses: Command[] = [
  { type: "addBus", bus: createBus("Drums", "drum-bus") },
  { type: "setBusOutput", busId: "drum-bus", output: "band" },
  { type: "setTrackOutput", trackId: "keys", output: "drum-bus" },
];

/** The Track "keys" given the Keys, for the commands that change them. */
const KEYS_ON_TRACK: Command = { type: "setInstrument", trackId: "keys", instrument: createKeysTrack("Piano").instrument };

/**
 * One case per command: the command, and what should be true afterwards. The
 * `Record<CommandType, …>` type means a new command doesn't compile until it
 * has a case here.
 */
const cases: Record<CommandType, { command: Command; check: (p: Project) => void; before?: Command[] }> = {
  setProjectName: {
    command: { type: "setProjectName", name: "Night drive" },
    check: (p) => expect(p.name).toBe("Night drive"),
  },
  setTempo: {
    command: { type: "setTempo", tempo: 92.5 },
    check: (p) => expect(p.tempo).toBe(92.5),
  },
  addTempoChange: {
    command: ninety,
    check: (p) => expect(p.tempoChanges).toEqual([{ id: "tc", tick: 7680, tempo: 90, timeSignature: null }]),
  },
  setTempoChange: {
    before: [ninety],
    command: { type: "setTempoChange", tempoChangeId: "tc", timeSignature: { beatsPerBar: 3, beatUnit: 4 } },
    check: (p) =>
      expect(p.tempoChanges[0]).toMatchObject({ tempo: 90, timeSignature: { beatsPerBar: 3, beatUnit: 4 } }),
  },
  moveTempoChange: {
    before: [ninety],
    command: { type: "moveTempoChange", tempoChangeId: "tc", tick: 960 },
    check: (p) => expect(p.tempoChanges[0]).toMatchObject({ id: "tc", tick: 960 }),
  },
  addSection: {
    command: chorus,
    check: (p) => expect(p.sections).toEqual([{ id: "chorus", name: "Chorus", startBar: 9, bars: 8 }]),
  },
  renameSection: {
    before: [chorus],
    command: { type: "renameSection", sectionId: "chorus", name: "Last chorus" },
    check: (p) => expect(p.sections[0]).toMatchObject({ id: "chorus", name: "Last chorus" }),
  },
  resizeSection: {
    before: [chorus],
    command: { type: "resizeSection", sectionId: "chorus", startBar: 5, bars: 4 },
    check: (p) => expect(p.sections[0]).toMatchObject({ id: "chorus", startBar: 5, bars: 4 }),
  },
  deleteSection: {
    before: [chorus],
    command: { type: "deleteSection", sectionId: "chorus" },
    check: (p) => expect(p.sections).toEqual([]),
  },
  setReferenceTrack: {
    command: { type: "setReferenceTrack", referenceTrack: { file: "audio/finished.wav" } },
    check: (p) => expect(p.referenceTrack).toEqual({ file: "audio/finished.wav" }),
  },
  rearrange: {
    before: [chorus],
    command: twoBarsIn,
    check: (p) => {
      expect(p.sections).toEqual([{ id: "chorus", name: "Chorus", startBar: 11, bars: 8 }]);
      const moved = sampleProject().tracks.flatMap((track) => track.clips.map((clip) => clip.start + 2 * 3840));
      expect(p.tracks.flatMap((track) => track.clips.map((clip) => clip.start))).toEqual(moved);
    },
  },
  deleteTempoChange: {
    before: [ninety],
    command: { type: "deleteTempoChange", tempoChangeId: "tc" },
    check: (p) => expect(p.tempoChanges).toEqual([]),
  },
  setTimeSignature: {
    command: { type: "setTimeSignature", timeSignature: { beatsPerBar: 6, beatUnit: 8 } },
    check: (p) => expect(p.timeSignature).toEqual({ beatsPerBar: 6, beatUnit: 8 }),
  },
  addTrack: {
    command: { type: "addTrack", track: createAudioTrack("Guitar", "guitar"), index: 1 },
    check: (p) => expect(p.tracks.map((t) => t.id)).toEqual(["keys", "guitar", "bass", "vocals", "drums"]),
  },
  renameTrack: {
    command: { type: "renameTrack", trackId: "bass", name: "Sub bass" },
    check: (p) => expect(p.tracks[1]!.name).toBe("Sub bass"),
  },
  moveTrack: {
    command: { type: "moveTrack", trackId: "vocals", index: 0 },
    check: (p) => expect(p.tracks.map((t) => t.id)).toEqual(["vocals", "keys", "bass", "drums"]),
  },
  setTrackInput: {
    command: { type: "setTrackInput", trackId: "vocals", input: { device: "Interface", channels: [2, 3] } },
    check: (p) => expect(p.tracks.find((t) => t.id === "vocals")).toMatchObject({ input: { device: "Interface", channels: [2, 3] } }),
  },
  setTrackMonitoring: {
    command: { type: "setTrackMonitoring", trackId: "vocals", monitoring: true },
    check: (p) => expect(p.tracks.find((t) => t.id === "vocals")).toMatchObject({ monitoring: true }),
  },
  deleteTrack: {
    command: { type: "deleteTrack", trackId: "keys" },
    check: (p) => expect(p.tracks.map((t) => t.id)).toEqual(["bass", "vocals", "drums"]),
  },
  setInstrument: {
    command: { type: "setInstrument", trackId: "bass", instrument: createDrumTrack("x").instrument },
    check: (p) => {
      const bass = p.tracks[1]!;
      expect(bass.kind === "instrument" && bass.instrument.type).toBe("drumSampler");
    },
  },
  setSynthSettings: {
    command: { type: "setSynthSettings", trackId: "keys", settings: { cutoffHz: 900, osc1Wave: "square" } },
    check: (p) => {
      const keys = p.tracks[0]!;
      const synth = keys.kind === "instrument" && keys.instrument.type === "synth" && keys.instrument;
      expect(synth && synth.settings.cutoffHz).toBe(900);
      expect(synth && synth.settings.osc1Wave).toBe("square");
      // The settings not given are left as they were.
      expect(synth && synth.settings.release).toBe(DEFAULT_SYNTH.release);
    },
  },
  setInstrumentSettings: {
    before: [
      {
        type: "setInstrument",
        trackId: "keys",
        instrument: { type: "plugin", plugin: { id: "dev.example.keys", version: "1.0.0" }, settings: { level: 0.5, attack: 5 } },
      },
    ],
    command: { type: "setInstrumentSettings", trackId: "keys", settings: { level: 0.8 } },
    check: (p) => {
      const keys = p.tracks[0]!;
      // The settings not given are left as they were.
      expect(keys.kind === "instrument" && keys.instrument).toMatchObject({ settings: { level: 0.8, attack: 5 } });
    },
  },
  setSynthPreset: {
    command: { type: "setSynthPreset", trackId: "keys", preset: "Warm Pad" },
    check: (p) => {
      const keys = p.tracks[0]!;
      const synth = keys.kind === "instrument" && keys.instrument.type === "synth" && keys.instrument;
      expect(synth && synth.preset).toBe("Warm Pad");
      expect(synth && synth.settings).toEqual(synthPreset("Warm Pad")!.settings);
    },
  },
  setKeysSettings: {
    before: [KEYS_ON_TRACK],
    command: { type: "setKeysSettings", trackId: "keys", settings: { brightness: 0.9, source: "sample" } },
    check: (p) => {
      const track = p.tracks[0]!;
      const keys = track.kind === "instrument" && track.instrument.type === "keys" && track.instrument;
      expect(keys && keys.settings).toMatchObject({ brightness: 0.9, source: "sample", decay: 8 });
    },
  },
  setKeysPreset: {
    before: [KEYS_ON_TRACK],
    command: { type: "setKeysPreset", trackId: "keys", preset: "Honky-Tonk" },
    check: (p) => {
      const track = p.tracks[0]!;
      const keys = track.kind === "instrument" && track.instrument.type === "keys" && track.instrument;
      expect(keys && keys.preset).toBe("Honky-Tonk");
      expect(keys && keys.settings).toEqual(keysPreset("Honky-Tonk")!.settings);
    },
  },
  setKeysSample: {
    before: [KEYS_ON_TRACK],
    command: { type: "setKeysSample", trackId: "keys", sample: "audio/choir.wav", rootNote: 57 },
    check: (p) => {
      const track = p.tracks[0]!;
      const keys = track.kind === "instrument" && track.instrument.type === "keys" && track.instrument;
      expect(keys && keys.sample).toBe("audio/choir.wav");
      expect(keys && keys.settings).toMatchObject({ source: "sample", rootNote: 57 });
    },
  },
  setDrumPad: {
    command: { type: "setDrumPad", trackId: "drums", pad: 4, settings: { pan: -0.5, pitch: -2, chokeGroup: 2 } },
    check: (p) => {
      const drums = p.tracks[3]!;
      const pads = drums.kind === "instrument" && drums.instrument.type === "drumSampler" && drums.instrument.pads;
      expect(pads && pads[4]).toEqual({
        name: "Open Hat",
        note: 46,
        sample: null,
        volume: 1,
        pan: -0.5,
        pitch: -2,
        chokeGroup: 2,
      });
      // Only that pad moved.
      expect(pads && pads[3]!.chokeGroup).toBe(1);
    },
  },
  setTrackMixer: {
    command: { type: "setTrackMixer", trackId: "keys", mixer: { volume: 0.5, solo: true } },
    check: (p) => expect(p.tracks[0]!.mixer).toEqual({ volume: 0.5, pan: 0, mute: false, solo: true }),
  },
  setMasterVolume: {
    command: { type: "setMasterVolume", volume: 0.8 },
    check: (p) => expect(p.master.volume).toBe(0.8),
  },
  setTrackOutput: {
    command: { type: "setTrackOutput", trackId: "vocals", output: "band" },
    before: buses,
    check: (p) => expect(p.tracks.map((t) => t.output)).toEqual(["drum-bus", "band", "band", null]),
  },
  addBus: {
    command: { type: "addBus", bus: createBus("Strings", "strings"), index: 0 },
    before: buses,
    check: (p) => expect(p.buses.map((b) => b.id)).toEqual(["strings", "band", "drum-bus"]),
  },
  renameBus: {
    command: { type: "renameBus", busId: "band", name: "Everything" },
    before: buses,
    check: (p) => expect(p.buses[0]!.name).toBe("Everything"),
  },
  deleteBus: {
    command: { type: "deleteBus", busId: "drum-bus" },
    before: buses,
    check: (p) => {
      expect(p.buses.map((b) => b.id)).toEqual(["band"]);
      // Keys fed the deleted Bus, so it feeds the Master now.
      expect(p.tracks[0]!.output).toBeNull();
    },
  },
  moveBus: {
    command: { type: "moveBus", busId: "band", index: 1 },
    before: buses,
    check: (p) => {
      expect(p.buses.map((b) => b.id)).toEqual(["drum-bus", "band"]);
      // Only its place in the list moves: Keys still feeds the Drum Bus.
      expect(p.tracks[0]!.output).toBe("drum-bus");
    },
  },
  setBusMixer: {
    command: { type: "setBusMixer", busId: "band", mixer: { pan: -0.5, mute: true } },
    before: buses,
    check: (p) => expect(p.buses[0]!.mixer).toEqual({ volume: 1, pan: -0.5, mute: true, solo: false }),
  },
  setBusOutput: {
    command: { type: "setBusOutput", busId: "drum-bus", output: null },
    before: buses,
    check: (p) => expect(p.buses[1]!.output).toBeNull(),
  },
  addSend: {
    command: { type: "addSend", from: { trackId: "keys" }, busId: "band", level: 0.7 },
    check: (p) => expect(p.tracks[0]!.sends).toEqual([{ busId: "band", level: 0.7 }]),
  },
  setSendLevel: {
    command: { type: "setSendLevel", from: { trackId: "vocals" }, busId: "band", level: 1.5 },
    check: (p) => expect(p.tracks[2]!.sends).toEqual([{ busId: "band", level: 1.5 }]),
  },
  removeSend: {
    command: { type: "removeSend", from: { trackId: "vocals" }, busId: "band" },
    check: (p) => expect(p.tracks[2]!.sends).toEqual([]),
  },
  addClip: {
    command: {
      type: "addClip",
      trackId: "bass",
      clip: { id: "bass-1", kind: "pattern", start: 7680, length: 3840, notes: [] },
    },
    check: (p) => expect(p.tracks[1]!.clips.map((c) => c.id)).toEqual(["bass-1"]),
  },
  moveClip: {
    command: { type: "moveClip", clipId: "keys-1", start: 960, trackId: "bass" },
    check: (p) => {
      expect(p.tracks[0]!.clips).toEqual([]);
      expect(p.tracks[1]!.clips[0]).toMatchObject({ id: "keys-1", start: 960 });
    },
  },
  trimClip: {
    command: { type: "trimClip", clipId: "keys-1", start: 0, length: 960 },
    check: (p) => {
      const clip = p.tracks[0]!.clips[0]!;
      expect(clip.kind === "pattern" && clip.length).toBe(960);
      // The note at 960 no longer starts inside the Clip.
      expect(clip.kind === "pattern" && clip.notes.map((n) => n.pitch)).toEqual([60]);
    },
  },
  deleteClip: {
    command: { type: "deleteClip", clipId: "vocals-1" },
    check: (p) => expect(p.tracks[2]!.clips).toEqual([]),
  },
  setPatternNotes: {
    command: {
      type: "setPatternNotes",
      clipId: "keys-1",
      notes: [
        { pitch: 67, start: 480, length: 240, velocity: 1 },
        { pitch: 55, start: 0, length: 240, velocity: 1 },
      ],
    },
    check: (p) => {
      const clip = p.tracks[0]!.clips[0]!;
      expect(clip.kind === "pattern" && clip.notes.map((n) => n.pitch)).toEqual([55, 67]);
    },
  },
  setAutomation: {
    command: {
      type: "setAutomation",
      target: { trackId: "keys" },
      setting: "pan",
      breakpoints: [
        { tick: 960, value: 1, hold: false },
        { tick: 0, value: -1, hold: true },
      ],
    },
    check: (p) =>
      expect(p.tracks[0]!.automation).toEqual([
        {
          setting: "pan",
          breakpoints: [
            { tick: 0, value: -1, hold: true },
            { tick: 960, value: 1, hold: false },
          ],
        },
      ]),
  },
  addEffect: {
    command: { type: "addEffect", target: "master", effect: createEffect("reverb", "master-reverb"), index: 0 },
    check: (p) => expect(p.master.insertChain.map((e) => e.id)).toEqual(["master-reverb", "master-comp"]),
  },
  removeEffect: {
    command: { type: "removeEffect", effectId: "keys-eq" },
    check: (p) => expect(p.tracks[0]!.insertChain.map((e) => e.id)).toEqual(["keys-reverb"]),
  },
  moveEffect: {
    command: { type: "moveEffect", effectId: "keys-reverb", index: 0 },
    check: (p) => expect(p.tracks[0]!.insertChain.map((e) => e.id)).toEqual(["keys-reverb", "keys-eq"]),
  },
  setEffectBypassed: {
    command: { type: "setEffectBypassed", effectId: "master-comp", bypassed: true },
    check: (p) => expect(p.master.insertChain[0]!.bypassed).toBe(true),
  },
  setEffectSettings: {
    command: { type: "setEffectSettings", effectId: "master-comp", settings: { ratio: 8 } },
    check: (p) => expect(p.master.insertChain[0]!.settings).toMatchObject({ ratio: 8, thresholdDb: -18 }),
  },
};

describe.each(Object.entries(cases))("%s", (_, { command, check, before = [] }) => {
  test("applies, undoes and redoes", () => {
    const setUp = applyCommands(sampleProject(), before);
    if (!setUp.ok) throw new Error(setUp.error);
    const original = deepFreeze(setUp.project);
    const history = new ProjectHistory(original);

    const result = history.execute(command);
    // On failure this shows the error the command was rejected with.
    expect(result).toMatchObject({ ok: true });
    check(history.project);
    const after = history.project;

    expect(history.undo()).toBe(true);
    expect(history.project).toEqual(original);
    expect(history.redo()).toBe(true);
    expect(history.project).toEqual(after);
  });
});

describe("invalid commands are rejected and change nothing", () => {
  const invalid: [string, Command][] = [
    [
      "a Pattern Clip on an Audio Track",
      { type: "addClip", trackId: "vocals", clip: { id: "x", kind: "pattern", start: 0, length: 960, notes: [] } },
    ],
    [
      "an Audio Clip on an Instrument Track",
      { type: "addClip", trackId: "keys", clip: { id: "x", kind: "audio", start: 0, duration: 0.5, file: "a.wav", fileOffset: 0 } },
    ],
    ["a Clip moved to a Track of the other kind", { type: "moveClip", clipId: "keys-1", start: 0, trackId: "vocals" }],
    ["an id that is already used", { type: "addTrack", track: createInstrumentTrack("Again", "keys-eq") }],
    ["a Track that doesn't exist", { type: "renameTrack", trackId: "nope", name: "X" }],
    ["an empty name", { type: "renameTrack", trackId: "keys", name: "  " }],
    ["an Input on an Instrument Track", { type: "setTrackInput", trackId: "keys", input: { device: null, channels: [0] } }],
    ["Input Monitoring on an Instrument Track", { type: "setTrackMonitoring", trackId: "keys", monitoring: true }],
    ["an Input of three channels", { type: "setTrackInput", trackId: "vocals", input: { device: null, channels: [0, 1, 2] as never } }],
    ["an Input pair of one channel twice", { type: "setTrackInput", trackId: "vocals", input: { device: null, channels: [3, 3] } }],
    ["a negative Input channel", { type: "setTrackInput", trackId: "vocals", input: { device: null, channels: [-1] } }],
    ["an Input device with no name", { type: "setTrackInput", trackId: "vocals", input: { device: "", channels: null } }],
    ["a tempo out of range", { type: "setTempo", tempo: 5 }],
    ["a tempo that isn't a number", { type: "setTempo", tempo: Number.NaN }],
    ["a beat unit that isn't a note value", { type: "setTimeSignature", timeSignature: { beatsPerBar: 4, beatUnit: 3 } }],
    ["a pitch above 127", { type: "setPatternNotes", clipId: "keys-1", notes: [{ pitch: 200, start: 0, length: 1, velocity: 1 }] }],
    ["a note outside its Clip", { type: "setPatternNotes", clipId: "keys-1", notes: [{ pitch: 60, start: 3840, length: 1, velocity: 1 }] }],
    ["notes on an Audio Clip", { type: "setPatternNotes", clipId: "vocals-1", notes: [] }],
    [
      "the Master's pan automated",
      { type: "setAutomation", target: "master", setting: "pan", breakpoints: [{ tick: 0, value: 0, hold: false }] },
    ],
    [
      "a pan breakpoint out of range",
      { type: "setAutomation", target: { trackId: "keys" }, setting: "pan", breakpoints: [{ tick: 0, value: 2, hold: false }] },
    ],
    [
      "two breakpoints at one tick",
      {
        type: "setAutomation",
        target: { trackId: "keys" },
        setting: "volume",
        breakpoints: [
          { tick: 0, value: 1, hold: false },
          { tick: 0, value: 0, hold: false },
        ],
      },
    ],
    [
      "an EQ breakpoint out of range",
      {
        type: "setAutomation",
        target: { trackId: "keys" },
        setting: "effect:keys-eq:lowShelfGainDb",
        breakpoints: [{ tick: 0, value: 30, hold: false }],
      },
    ],
    [
      "Automation of an Effect on another channel",
      { type: "setAutomation", target: { trackId: "bass" }, setting: "effect:keys-eq:lowShelfGainDb", breakpoints: [{ tick: 0, value: 0, hold: false }] },
    ],
    [
      "Automation of a Send that isn't there",
      { type: "setAutomation", target: { trackId: "keys" }, setting: "send:band", breakpoints: [{ tick: 0, value: 1, hold: false }] },
    ],
    [
      "Automation of a setting that picks from a list",
      { type: "setAutomation", target: { trackId: "keys" }, setting: "instrument:osc1Wave", breakpoints: [{ tick: 0, value: 1, hold: false }] },
    ],
    [
      "Automation of a Drum Sampler's Synth",
      { type: "setAutomation", target: { trackId: "drums" }, setting: "instrument:cutoffHz", breakpoints: [{ tick: 0, value: 500, hold: false }] },
    ],
    [
      "the Master's Sends automated",
      { type: "setAutomation", target: "master", setting: "send:band", breakpoints: [{ tick: 0, value: 1, hold: false }] },
    ],
    ["Automation on a Track that doesn't exist", { type: "setAutomation", target: { trackId: "nope" }, setting: "volume", breakpoints: [] }],
    ["an Instrument on an Audio Track", { type: "setInstrument", trackId: "vocals", instrument: createInstrumentTrack("x").instrument }],
    ["a volume too high", { type: "setTrackMixer", trackId: "keys", mixer: { volume: 3 } }],
    ["a Clip of no length", { type: "trimClip", clipId: "keys-1", start: 0, length: 0 }],
    ["a file offset on a Pattern Clip", { type: "trimClip", clipId: "keys-1", start: 0, length: 960, fileOffset: 1 }],
    ["a position outside the list", { type: "moveTrack", trackId: "keys", index: 9 }],
    ["an Effect setting out of range", { type: "setEffectSettings", effectId: "master-comp", settings: { ratio: 100 } }],
    ["a setting the Effect doesn't have", { type: "setEffectSettings", effectId: "master-comp", settings: { roomSize: 1 } as never }],
    ["an Effect that doesn't exist", { type: "removeEffect", effectId: "nope" }],
    ["a Synth setting out of range", { type: "setSynthSettings", trackId: "keys", settings: { cutoffHz: 40_000 } }],
    ["a waveform that isn't one of the choices", { type: "setSynthSettings", trackId: "keys", settings: { osc1Wave: "noise" as never } }],
    ["a preset that doesn't exist", { type: "setSynthPreset", trackId: "keys", preset: "Nope" }],
    [
      "a User Preset whose settings break the Synth's rules",
      { type: "setSynthPreset", trackId: "keys", preset: "Broken", settings: { ...DEFAULT_SYNTH, cutoffHz: -5 } },
    ],
    ["a Synth setting on an Audio Track", { type: "setSynthSettings", trackId: "vocals", settings: { cutoffHz: 900 } }],
    ["a pad on a Track playing the Synth", { type: "setDrumPad", trackId: "keys", pad: 0, settings: { volume: 0.5 } }],
    ["a pad the kit doesn't have", { type: "setDrumPad", trackId: "drums", pad: 40, settings: { volume: 0.5 } }],
    ["a pad's pan out of range", { type: "setDrumPad", trackId: "drums", pad: 0, settings: { pan: 2 } }],
    ["a pad transposed further than the engine goes", { type: "setDrumPad", trackId: "drums", pad: 0, settings: { pitch: 36 } }],
    ["two pads answering to one note", { type: "setDrumPad", trackId: "drums", pad: 0, settings: { note: 38 } }],
    ["a Tempo Change at the song's start", { type: "addTempoChange", tempoChange: { id: "t", tick: 0, tempo: 90, timeSignature: null } }],
    ["a Tempo Change that changes nothing", { type: "addTempoChange", tempoChange: { id: "t", tick: 960, tempo: null, timeSignature: null } }],
    ["a Tempo Change's tempo out of range", { type: "addTempoChange", tempoChange: { id: "t", tick: 960, tempo: 1000, timeSignature: null } }],
    [
      "a time signature changing off a bar line",
      { type: "addTempoChange", tempoChange: { id: "t", tick: 960, tempo: null, timeSignature: { beatsPerBar: 3, beatUnit: 4 } } },
    ],
    ["a Tempo Change that doesn't exist", { type: "deleteTempoChange", tempoChangeId: "nope" }],
  ];

  test.each(invalid)("%s", (_, command) => {
    const original = deepFreeze(sampleProject());
    const history = new ProjectHistory(original);
    const result = history.execute(command);
    expect(result.ok).toBe(false);
    expect(result.ok || result.error.length > 0).toBe(true);
    expect(history.project).toBe(original);
    expect(history.canUndo).toBe(false);
  });
});

/** A Tempo Change to 90 bpm at `tick`. */
function at(id: string, tick: number): Command {
  return { type: "addTempoChange", tempoChange: { id, tick, tempo: 90, timeSignature: null } };
}

test("two Tempo Changes can't share a tick, and are kept in order", () => {
  const result = applyCommands(sampleProject(), [at("late", 7680), at("early", 3840)]);
  expect(result.ok && result.project.tempoChanges.map((c) => c.id)).toEqual(["early", "late"]);
  const clash = applyCommands(sampleProject(), [at("a", 3840), at("b", 3840)]);
  expect(clash).toMatchObject({ ok: false, error: "Tempo Changes must be in order, one to a tick" });
});

/** A Section named for its id. */
function section(id: string, startBar: number, bars: number): Command {
  return { type: "addSection", section: { id, name: id, startBar, bars } };
}

describe("Sections", () => {
  test("are kept in bar order, and may touch end to start", () => {
    const result = applyCommands(sampleProject(), [section("chorus", 9, 8), section("intro", 1, 4), section("verse", 5, 4)]);
    expect(result.ok && result.project.sections.map((s) => s.id)).toEqual(["intro", "verse", "chorus"]);
  });

  test("can't be added over another, and the refusal names it", () => {
    const history = new ProjectHistory(deepFreeze(sampleProject()));
    history.execute(section("verse", 5, 8));
    const before = history.project;
    for (const [startBar, bars] of [
      [5, 8],
      [1, 5],
      [12, 4],
      [6, 2],
      [1, 20],
    ] as const) {
      const result = history.execute(section("chorus", startBar, bars));
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("would overlap the Section “verse” (bars 5–12)") });
      expect(history.project).toBe(before);
    }
  });

  test("can't be resized over another, from either edge, but can over their own bars", () => {
    const setUp = applyCommands(sampleProject(), [section("verse", 5, 4), section("chorus", 9, 8)]);
    if (!setUp.ok) throw new Error(setUp.error);
    const resize = (startBar: number, bars: number) =>
      applyCommand(setUp.project, { type: "resizeSection", sectionId: "chorus", startBar, bars });

    expect(resize(8, 9)).toMatchObject({ ok: false, error: expect.stringContaining("“verse” (bars 5–8)") });
    expect(resize(1, 30)).toMatchObject({ ok: false });
    expect(resize(9, 2)).toMatchObject({ ok: true });
    expect(resize(10, 12)).toMatchObject({ ok: true });
    // Past another, it keeps the list in bar order.
    const moved = resize(1, 4);
    expect(moved.ok && moved.project.sections.map((s) => s.id)).toEqual(["chorus", "verse"]);
  });

  test("need a name and whole bars from bar 1", () => {
    for (const command of [
      section("x", 0, 4),
      section("x", 1, 0),
      section("x", 1.5, 4),
      section("x", 1, 2.5),
      { type: "addSection", section: { id: "x", name: " ", startBar: 1, bars: 4 } },
      { type: "renameSection", sectionId: "nope", name: "X" },
      { type: "deleteSection", sectionId: "nope" },
      { type: "addSection", section: { id: "keys", name: "Taken id", startBar: 1, bars: 4 } },
    ] satisfies Command[]) {
      expect(applyCommand(sampleProject(), command).ok).toBe(false);
    }
  });
});

test("trimming an Audio Clip under a Tempo Change keeps its seconds on the map", () => {
  // The vocals start at bar 2; from bar 3 the song is at 60 BPM, so the bar
  // from 3 to 4 lasts 4 seconds.
  const result = applyCommands(sampleProject(), [
    { type: "addTempoChange", tempoChange: { id: "t", tick: 7680, tempo: 60, timeSignature: null } },
    { type: "trimClip", clipId: "vocals-1", start: 3840, length: 7680 },
  ]);
  if (!result.ok) throw new Error(result.error);
  expect(result.project.tracks[2]!.clips[0]).toMatchObject({ start: 3840, duration: 2 + 4 });
});

function withBuses(): Project {
  const result = applyCommands(sampleProject(), buses);
  if (!result.ok) throw new Error(result.error);
  return deepFreeze(result.project);
}

describe("Buses", () => {
  test.each<[string, Command, string]>([
    ["a Bus fed by the one it would feed", { type: "setBusOutput", busId: "band", output: "drum-bus" }, "Band can't feed Drums: the signal would go round in a loop (Band → Drums → Band)"],
    ["a Bus feeding itself", { type: "setBusOutput", busId: "band", output: "band" }, "Band can't feed itself"],
    ["a Bus that doesn't exist", { type: "setTrackOutput", trackId: "keys", output: "nope" }, "There is no Bus nope"],
    ["a Bus that doesn't exist", { type: "deleteBus", busId: "nope" }, "There is no Bus nope"],
    [
      "a Bus added feeding one that doesn't exist",
      { type: "addBus", bus: { ...createBus("Loop", "drum-bus-2"), output: "nope" } },
      "Bus Loop's output must be the Master (null) or a Bus in the Project, not \"nope\"",
    ],
  ])("refuses %s, with the reason", (_, command, error) => {
    const history = new ProjectHistory(withBuses());
    expect(history.execute(command)).toEqual({ ok: false, error });
    expect(history.canUndo).toBe(false);
  });

  test("a longer loop is refused, and names every Bus in it", () => {
    const three = applyCommands(withBuses(), [
      { type: "addBus", bus: createBus("Top", "top") },
      { type: "setBusOutput", busId: "band", output: "top" },
    ]);
    if (!three.ok) throw new Error(three.error);
    expect(applyCommand(three.project, { type: "setBusOutput", busId: "top", output: "drum-bus" })).toEqual({
      ok: false,
      error: "Top can't feed Drums: the signal would go round in a loop (Top → Drums → Band → Top)",
    });
  });

  test("deleting a Bus sends whatever fed it to the Master, and undo puts it all back", () => {
    const original = withBuses();
    const history = new ProjectHistory(original);
    expect(history.execute({ type: "deleteBus", busId: "band" })).toMatchObject({ ok: true });
    // Drums and Bass fed Band, so they feed the Master; Keys still feeds Drums.
    expect(history.project.buses).toMatchObject([{ id: "drum-bus", output: null }]);
    expect(history.project.tracks.map((t) => t.output)).toEqual(["drum-bus", null, null, null]);
    expect(history.undo()).toBe(true);
    expect(history.project).toEqual(original);
  });

  test.each<[string, Command, string]>([
    [
      "a Send that closes a loop through an output",
      { type: "addSend", from: { busId: "band" }, busId: "drum-bus", level: 1 },
      "Band can't send to Drums: the signal would go round in a loop (Band → Drums → Band)",
    ],
    ["a Bus sending to itself", { type: "addSend", from: { busId: "band" }, busId: "band", level: 1 }, "Band can't send to itself"],
    ["a Send to a Bus that doesn't exist", { type: "addSend", from: { trackId: "keys" }, busId: "nope", level: 1 }, "There is no Bus nope"],
    ["a second Send to one Bus", { type: "addSend", from: { trackId: "vocals" }, busId: "band", level: 1 }, "Vocals already sends to Band"],
    ["a Send level past +6 dB", { type: "setSendLevel", from: { trackId: "vocals" }, busId: "band", level: 3 }, "Track Vocals's Send level must be a number from 0 to 2"],
    ["a Send that isn't there", { type: "removeSend", from: { trackId: "keys" }, busId: "band" }, "Keys has no Send to Band"],
  ])("refuses %s, with the reason", (_, command, error) => {
    const history = new ProjectHistory(withBuses());
    expect(history.execute(command)).toEqual({ ok: false, error });
    expect(history.canUndo).toBe(false);
  });

  test("an Output that closes a loop through a Send is refused", () => {
    const sent = applyCommands(withBuses(), [
      { type: "addBus", bus: createBus("Reverb", "verb") },
      { type: "addSend", from: { busId: "band" }, busId: "verb", level: 0.5 },
    ]);
    if (!sent.ok) throw new Error(sent.error);
    expect(applyCommand(sent.project, { type: "setBusOutput", busId: "verb", output: "drum-bus" })).toEqual({
      ok: false,
      error: "Reverb can't feed Drums: the signal would go round in a loop (Reverb → Drums → Band → Reverb)",
    });
    // A Send alongside an Output to the same Bus is no loop.
    expect(applyCommand(sent.project, { type: "addSend", from: { busId: "drum-bus" }, busId: "band", level: 1 })).toMatchObject({ ok: true });
  });

  test("deleting a Bus removes the Sends to it, and undo puts them back", () => {
    const original = withBuses();
    const history = new ProjectHistory(original);
    expect(history.execute({ type: "addSend", from: { busId: "drum-bus" }, busId: "band", level: 0.3 })).toMatchObject({ ok: true });
    const sent = history.project;
    expect(history.execute({ type: "deleteBus", busId: "band" })).toMatchObject({ ok: true });
    expect(history.project.tracks.every((track) => track.sends.length === 0)).toBe(true);
    expect(history.project.buses[0]!.sends).toEqual([]);
    expect(history.undo()).toBe(true);
    expect(history.project).toEqual(sent);
  });

  test("a Bus's Insert Chain is edited like any other", () => {
    const result = applyCommands(withBuses(), [
      { type: "addEffect", target: { busId: "band" }, effect: createEffect("reverb", "band-verb"), index: 0 },
      { type: "setEffectSettings", effectId: "band-verb", settings: { mix: 0.5 } },
      { type: "setEffectBypassed", effectId: "band-verb", bypassed: true },
    ]);
    if (!result.ok) throw new Error(result.error);
    expect(result.project.buses[0]!.insertChain[0]).toMatchObject({ id: "band-verb", bypassed: true, settings: { mix: 0.5 } });
    expect(applyCommand(result.project, { type: "removeEffect", effectId: "band-verb" })).toMatchObject({ ok: true });
  });

  test("deleting a Track leaves the Buses alone", () => {
    const result = applyCommand(withBuses(), { type: "deleteTrack", trackId: "keys" });
    expect(result.ok && result.project.buses).toEqual(withBuses().buses);
  });
});

test("applying a command never changes the Project it was given", () => {
  const original = deepFreeze(sampleProject());
  const result = applyCommand(original, { type: "deleteTrack", trackId: "keys" });
  expect(result.ok).toBe(true);
  expect(original).toEqual(sampleProject());
});

test("the error says what was wrong", () => {
  const result = applyCommand(sampleProject(), {
    type: "addClip",
    trackId: "vocals",
    clip: { id: "x", kind: "pattern", start: 0, length: 960, notes: [] },
  });
  expect(result).toEqual({
    ok: false,
    error: "Track Vocals is an Audio Track, so it only holds Audio Clips",
  });
});

test("trimming a Clip's start shifts its notes with it, so the music stays put", () => {
  // The Keys Clip holds notes at 0 and 960 and runs from 0 for 3840 ticks.
  const history = new ProjectHistory(deepFreeze(sampleProject()));
  expect(history.execute({ type: "trimClip", clipId: "keys-1", start: 960, length: 2880 }).ok).toBe(true);

  const clip = history.project.tracks[0]!.clips[0]!;
  // The note that was at 960 in the song is still at 960: 0 in a Clip that
  // now starts there. The one before the new start is gone.
  expect(clip.kind === "pattern" && clip.notes).toEqual([{ pitch: 64, start: 0, length: 480, velocity: 0.7 }]);

  history.undo();
  expect(history.project).toEqual(sampleProject());
});

test("Automation is drawn, moved and deleted a breakpoint at a time, each step undoable", () => {
  const history = new ProjectHistory(sampleProject());
  const lane = () => history.project.tracks[0]!.automation.find((a) => a.setting === "volume")?.breakpoints;
  const set = (breakpoints: { tick: number; value: number; hold: boolean }[]) =>
    history.execute({ type: "setAutomation", target: { trackId: "keys" }, setting: "volume", breakpoints });

  set([{ tick: 0, value: 1, hold: false }]);
  set([
    { tick: 0, value: 1, hold: false },
    { tick: 960, value: 0.5, hold: false },
  ]);
  set([
    { tick: 0, value: 1, hold: false },
    { tick: 1920, value: 0.25, hold: false },
  ]);
  set([{ tick: 0, value: 1, hold: false }]);
  set([]);
  expect(lane()).toBeUndefined();

  history.undo();
  expect(lane()).toEqual([{ tick: 0, value: 1, hold: false }]);
  history.undo();
  expect(lane()?.[1]).toEqual({ tick: 1920, value: 0.25, hold: false });
  history.undo();
  expect(lane()?.[1]).toEqual({ tick: 960, value: 0.5, hold: false });
  history.undo();
  history.undo();
  expect(lane()).toBeUndefined();
  expect(history.project).toEqual(sampleProject());
});

test("a Track's volume and pan Automation are kept volume first, whichever came first", () => {
  const project = sampleProject();
  const point = [{ tick: 0, value: 0, hold: false }];
  const result = applyCommands(project, [
    { type: "setAutomation", target: { trackId: "keys" }, setting: "pan", breakpoints: point },
    { type: "setAutomation", target: { trackId: "keys" }, setting: "volume", breakpoints: point },
  ]);
  expect(result.ok && result.project.tracks[0]!.automation.map((a) => a.setting)).toEqual(["volume", "pan"]);
});

const point = (value: number) => [{ tick: 0, value, hold: false }];

test("every channel's Automation is kept volume, pan, Sends, Effects then the Instrument", () => {
  const result = applyCommands(sampleProject(), [
    { type: "addSend", from: { trackId: "keys" }, busId: "band", level: 1 },
    { type: "setAutomation", target: { trackId: "keys" }, setting: "instrument:cutoffHz", breakpoints: point(500) },
    { type: "setAutomation", target: { trackId: "keys" }, setting: "effect:keys-reverb:mix", breakpoints: point(0.5) },
    { type: "setAutomation", target: { trackId: "keys" }, setting: "effect:keys-eq:lowShelfGainDb", breakpoints: point(6) },
    { type: "setAutomation", target: { trackId: "keys" }, setting: "send:band", breakpoints: point(1) },
    { type: "setAutomation", target: { trackId: "keys" }, setting: "pan", breakpoints: point(0) },
    { type: "setAutomation", target: { busId: "band" }, setting: "effect:band-eq:highShelfGainDb", breakpoints: point(-6) },
    { type: "setAutomation", target: { busId: "band" }, setting: "volume", breakpoints: point(1) },
    { type: "setAutomation", target: "master", setting: "effect:master-comp:thresholdDb", breakpoints: point(-12) },
  ]);
  if (!result.ok) throw new Error(result.error);
  expect(result.project.tracks[0]!.automation.map((a) => a.setting)).toEqual([
    "pan",
    "send:band",
    "effect:keys-eq:lowShelfGainDb",
    "effect:keys-reverb:mix",
    "instrument:cutoffHz",
  ]);
  expect(result.project.buses[0]!.automation.map((a) => a.setting)).toEqual(["volume", "effect:band-eq:highShelfGainDb"]);
  expect(result.project.master.automation.map((a) => a.setting)).toEqual(["volume", "effect:master-comp:thresholdDb"]);
});

describe("taking a setting away takes its Automation, undoably", () => {
  const removals: [string, Command[], Command, (p: Project) => unknown][] = [
    [
      "removing an Effect",
      [{ type: "setAutomation", target: { trackId: "keys" }, setting: "effect:keys-eq:lowShelfGainDb", breakpoints: point(6) }],
      { type: "removeEffect", effectId: "keys-eq" },
      (p) => p.tracks[0]!.automation,
    ],
    [
      "removing a Master Effect",
      [{ type: "setAutomation", target: "master", setting: "effect:master-comp:thresholdDb", breakpoints: point(-12) }],
      { type: "removeEffect", effectId: "master-comp" },
      (p) => p.master.automation,
    ],
    [
      "removing a Send",
      [{ type: "setAutomation", target: { trackId: "vocals" }, setting: "send:band", breakpoints: point(1) }],
      { type: "removeSend", from: { trackId: "vocals" }, busId: "band" },
      (p) => p.tracks[2]!.automation.map((a) => a.setting),
    ],
    [
      "deleting the Bus a Send feeds",
      [{ type: "setAutomation", target: { trackId: "vocals" }, setting: "send:band", breakpoints: point(1) }],
      { type: "deleteBus", busId: "band" },
      (p) => p.tracks[2]!.automation.map((a) => a.setting),
    ],
    [
      "swapping the Synth for the Drum Sampler",
      [{ type: "setAutomation", target: { trackId: "keys" }, setting: "instrument:cutoffHz", breakpoints: point(500) }],
      { type: "setInstrument", trackId: "keys", instrument: createDrumTrack("x").instrument },
      (p) => p.tracks[0]!.automation,
    ],
    [
      "swapping the Drum Sampler for the Synth",
      [{ type: "setAutomation", target: { trackId: "drums" }, setting: "instrument:pad36.volume", breakpoints: point(0.5) }],
      { type: "setInstrument", trackId: "drums", instrument: createInstrumentTrack("x").instrument },
      (p) => p.tracks[3]!.automation,
    ],
    [
      "loading a Kit with no Pad on the automated Pad's note",
      [{ type: "setAutomation", target: { trackId: "drums" }, setting: "instrument:pad36.volume", breakpoints: point(0.5) }],
      {
        type: "setInstrument",
        trackId: "drums",
        instrument: { type: "drumSampler", preset: "No Kick", pads: STARTER_KIT.filter((pad) => pad.note !== 36).map((pad) => ({ ...pad })) },
      },
      (p) => p.tracks[3]!.automation,
    ],
  ];
  test.each(removals)("%s", (_, setup, command, automation) => {
    const history = new ProjectHistory(sampleProject());
    for (const step of setup) expect(history.execute(step).ok).toBe(true);
    const before = automation(history.project);

    expect(history.execute(command).ok).toBe(true);
    expect(automation(history.project)).not.toEqual(before);
    expect(JSON.stringify(automation(history.project))).not.toMatch(/effect:|send:|instrument:/);

    history.undo();
    expect(automation(history.project)).toEqual(before);
  });
});

test("moving an Effect keeps its Automation", () => {
  const result = applyCommands(sampleProject(), [
    { type: "setAutomation", target: { trackId: "keys" }, setting: "effect:keys-eq:lowShelfGainDb", breakpoints: point(6) },
    { type: "moveEffect", effectId: "keys-eq", index: 1 },
  ]);
  expect(result.ok && result.project.tracks[0]!.automation.map((a) => a.setting)).toEqual(["effect:keys-eq:lowShelfGainDb"]);
});

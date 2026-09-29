import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { beforeAll, describe, expect, test } from "vitest";

import { applyEngineCommand } from "../audio/apply-engine-command";
import type { EngineCommand } from "../audio/audio-output";
import { EngineSync, trackNotes, trackSynth, type LoadedSample } from "./engine-sync";
import { defaultEffectSettings, effectSettingsFromFlat, effectSettingsToFlat } from "../effect/effect-params";
import { effectFlat } from "../effect/effect-table";
import { synthSettingsToFlat } from "../instrument/synth-params";
import { synthPreset } from "../instrument/synth-presets";
import {
  createAudioTrack,
  createDrumTrack,
  createEffect,
  createInstrumentTrack,
  createProject,
  DEFAULT_SYNTH,
  STARTER_KIT,
  type AudioClip,
  type AudioTrack,
  type BuiltInEffect,
  type DrumPad,
  type Effect,
  type InstrumentTrack,
  type Note,
  type PatternClip,
  type Project,
} from "./model";
import { parseProject, serialiseProject } from "./serialise";
import { TICKS_PER_BEAT } from "./time";
import { stereoWav } from "../song/test-wav";

const BAR = TICKS_PER_BEAT * 4;
const SIXTEENTH = TICKS_PER_BEAT / 4;

function clip(id: string, start: number, notes: Note[], length = 4 * BAR): PatternClip {
  return { id, kind: "pattern", start, length, notes };
}

function projectWith(...clipsPerTrack: PatternClip[][]): Project {
  const project = createProject();
  clipsPerTrack.forEach((clips, index) => {
    const track = createInstrumentTrack(`Synth ${index + 1}`, `t${index}`);
    track.clips = clips;
    project.tracks.push(track);
  });
  return project;
}

describe("trackNotes", () => {
  test("lays Clips' notes out in song time and cuts them at the Clip's end", () => {
    const track = createInstrumentTrack("Keys");
    track.clips = [
      clip("a", 0, [{ pitch: 60, start: 0, length: 480, velocity: 0.8 }]),
      clip("b", BAR, [{ pitch: 64, start: 960, length: BAR, velocity: 0.5 }], BAR),
    ];
    expect(trackNotes(track)).toEqual([0, 480, 60, 0.8, BAR + 960, BAR - 960, 64, 0.5]);
  });
});

describe("EngineSync", () => {
  test("first sends everything, then only what changed", () => {
    const sync = new EngineSync();
    const project = projectWith([clip("a", 0, [{ pitch: 60, start: 0, length: 480, velocity: 1 }])], []);
    const defaults = synthSettingsToFlat(DEFAULT_SYNTH);
    expect(sync.update(project)).toEqual([
      { type: "setTempo", bpm: 120 },
      { type: "setTimeSignature", beatsPerBar: 4, beatUnit: 4 },
      { type: "setMasterVolume", volume: 1 },
      { type: "setTrackCount", count: 2 },
      // Each Track is set up in turn: its Instrument's sound before the
      // notes it plays. An empty Track starts with no notes and its mixer at
      // unity, so there is nothing to send for either; both Tracks' Synths
      // are sent, since a new engine Track has the engine's defaults, not
      // the Project's.
      { type: "setSynthSettings", track: 0, settings: defaults },
      { type: "setTrackNotes", track: 0, notes: [0, 480, 60, 1] },
      { type: "setSynthSettings", track: 1, settings: defaults },
    ]);
    expect(sync.update(project)).toEqual([]);

    const edited = structuredClone(project);
    (edited.tracks[1]!.clips as PatternClip[]).push(clip("b", 0, [{ pitch: 62, start: 0, length: 240, velocity: 1 }]));
    expect(sync.update(edited)).toEqual([{ type: "setTrackNotes", track: 1, notes: [0, 240, 62, 1] }]);
  });

  test("sends a mixer channel and the Master fader only when they change", () => {
    const sync = new EngineSync();
    const project = projectWith([clip("a", 0, [])], []);
    sync.update(project);

    const mixed = structuredClone(project);
    mixed.tracks[1]!.mixer = { volume: 0.5, pan: -1, mute: true, solo: false };
    mixed.master.volume = 0.75;
    expect(sync.update(mixed)).toEqual([
      { type: "setMasterVolume", volume: 0.75 },
      { type: "setTrackMixer", track: 1, volume: 0.5, pan: -1, mute: true, solo: false },
    ]);
    expect(sync.update(mixed)).toEqual([]);
  });

  test("sends a Track's Synth when its sound changes, and nothing when it doesn't", () => {
    const sync = new EngineSync();
    const project = projectWith([clip("a", 0, [])]);
    sync.update(project);

    const pad = structuredClone(project);
    const instrument = (pad.tracks[0] as InstrumentTrack).instrument;
    if (instrument.type !== "synth") throw new Error("a Synth Track");
    instrument.preset = "Warm Pad";
    instrument.settings = { ...synthPreset("Warm Pad")!.settings };
    expect(sync.update(pad)).toEqual([
      { type: "setSynthSettings", track: 0, settings: trackSynth(pad.tracks[0] as InstrumentTrack) },
    ]);

    // The preset's name is not part of the sound: renaming it sends nothing.
    const renamed = structuredClone(pad);
    ((renamed.tracks[0] as InstrumentTrack).instrument as { preset: string }).preset = "Warm Pad (edited)";
    expect(sync.update(renamed)).toEqual([]);
  });

  test("follows reordering and deletion, Audio Tracks included", () => {
    const sync = new EngineSync();
    const a = clip("a", 0, [{ pitch: 60, start: 0, length: 480, velocity: 1 }]);
    const project = projectWith([a], []);
    project.tracks.splice(1, 0, createAudioTrack("Vocals"));
    expect(sync.update(project)).toContainEqual({ type: "setTrackAudio", track: 1, audio: true });

    // The Audio Track moves to the end, and the Instrument Track it swaps
    // places with takes the slot back as a Synth.
    const reordered = structuredClone(project);
    reordered.tracks.push(...reordered.tracks.splice(1, 1));
    const commands = sync.update(reordered);
    expect(commands).toContainEqual({ type: "setTrackAudio", track: 1, audio: false });
    expect(commands).toContainEqual({ type: "setTrackAudio", track: 2, audio: true });
    expect(commands.filter((c) => c.type === "setTrackNotes")).toEqual([]);
    expect(sync.update(reordered)).toEqual([]);

    const deleted = structuredClone(reordered);
    deleted.tracks.pop();
    expect(sync.update(deleted)).toEqual([{ type: "setTrackCount", count: 2 }]);
  });

  test("an Audio Track sends its Clips, and each file once however many Clips play it", () => {
    const sync = new EngineSync();
    const take: LoadedSample = { name: "take.wav", bytes: [1, 2, 3] };
    const project = audioProject([
      audioClip("x", 0, 0.5, "audio/take.wav", 0),
      audioClip("y", 1920, 0.25, "audio/take.wav", 1.5),
      audioClip("z", 3840, 0.25, "audio/missing.wav", 0),
    ]);
    const samples = new Map([["audio/take.wav", take]]);
    const audio = new Set(["setTrackAudio", "loadAudioFile", "setTrackAudioClips", "unloadAudioFile"]);
    expect(sync.update(project, samples).filter((c) => audio.has(c.type))).toEqual([
      { type: "loadAudioFile", file: 1, bytes: [1, 2, 3] },
      { type: "setTrackAudio", track: 0, audio: true },
      // The Clip whose file isn't in memory is left out.
      { type: "setTrackAudioClips", track: 0, clips: [0, 0.5, 1, 0, 1920, 0.25, 1, 1.5] },
    ]);
    expect(sync.update(project, samples)).toEqual([]);

    // Moving a Clip sends the Clips again, but not the file.
    const moved = structuredClone(project);
    audioTrackOf(moved).clips[0]!.start = 480;
    expect(sync.update(moved, samples)).toEqual([
      { type: "setTrackAudioClips", track: 0, clips: [480, 0.5, 1, 0, 1920, 0.25, 1, 1.5] },
    ]);

    // Once no Clip plays it, the engine lets the file go.
    const emptied = structuredClone(moved);
    audioTrackOf(emptied).clips = [];
    expect(sync.update(emptied, samples)).toEqual([
      { type: "setTrackAudioClips", track: 0, clips: [] },
      { type: "unloadAudioFile", file: 1 },
    ]);
  });

  test("an Audio Track's Input Monitoring is sent when it changes, and turned off when an Instrument Track takes the slot", () => {
    const sync = new EngineSync();
    const project = audioProject([]);
    // Off, as the engine's Track starts: nothing to send.
    expect(sync.update(project).filter((c) => c.type === "setTrackMonitoring")).toEqual([]);

    const on = structuredClone(project);
    audioTrackOf(on).monitoring = true;
    expect(sync.update(on)).toEqual([{ type: "setTrackMonitoring", track: 0, on: true }]);
    expect(sync.update(on)).toEqual([]);

    const replaced = structuredClone(on);
    replaced.tracks = [createInstrumentTrack("Keys", "keys")];
    expect(sync.update(replaced)).toContainEqual({ type: "setTrackMonitoring", track: 0, on: false });
  });

  test("a Drum Sampler Track sends its Instrument, then only the pads that change", () => {
    const sync = new EngineSync();
    const project = createProject();
    project.tracks.push(createDrumTrack("Drums", "drums"));
    const commands = sync.update(project);
    expect(commands).toContainEqual({
      type: "setTrackInstrument",
      track: 0,
      instrument: "drumSampler",
      pads: STARTER_KIT.length,
    });
    // Every pad is sent, because a fresh Drum Sampler is only the bundled kit.
    expect(commands.filter((c) => c.type === "setPad")).toHaveLength(STARTER_KIT.length);
    expect(commands).toContainEqual({
      type: "setPad",
      track: 0,
      pad: 4,
      note: 46,
      volume: 1,
      pan: 0,
      pitch: 0,
      chokeGroup: 1,
    });
    expect(sync.update(project)).toEqual([]);

    const edited = structuredClone(project);
    const instrument = edited.tracks[0]!;
    if (instrument.kind !== "instrument" || instrument.instrument.type !== "drumSampler") throw new Error("no pads");
    instrument.instrument.pads[0]!.pan = -0.5;
    expect(sync.update(edited)).toEqual([
      { type: "setPad", track: 0, pad: 0, note: 36, volume: 1, pan: -0.5, pitch: 0, chokeGroup: 0 },
    ]);
  });

  test("the sample a pad names is sent once, and again whenever the Instrument is", () => {
    const sync = new EngineSync();
    const project = createProject();
    project.tracks.push(createDrumTrack("Drums", "drums"));
    // The pad names where its sample lives in the Project folder; the bytes
    // are in memory under that same path, however they got there.
    padsOf(project)[2]!.sample = "audio/clap.wav";
    const samples = new Map([["audio/clap.wav", { name: "clap.wav", bytes: [1, 2, 3] }]]);
    expect(sync.update(project, samples)).toContainEqual({ type: "setPadSample", track: 0, pad: 2, wav: [1, 2, 3] });
    expect(sync.update(project, samples)).toEqual([]);

    // Another WAV on the same pad is another sample, with a path of its own.
    const replaced = structuredClone(project);
    padsOf(replaced)[2]!.sample = "audio/clap-2.wav";
    const both = new Map([...samples, ["audio/clap-2.wav", { name: "clap.wav", bytes: [4, 5, 6] }]]);
    expect(sync.update(replaced, both)).toEqual([{ type: "setPadSample", track: 0, pad: 2, wav: [4, 5, 6] }]);

    // Going back to the Synth and returning takes the kit away and brings a
    // fresh one, so the pads and the sample are sent again.
    const synth = structuredClone(replaced);
    synth.tracks[0] = { ...createInstrumentTrack("Drums", "drums") };
    sync.update(synth, both);
    const back = sync.update(replaced, both);
    expect(back[0]).toEqual({ type: "setTrackInstrument", track: 0, instrument: "drumSampler", pads: STARTER_KIT.length });
    expect(back).toContainEqual({ type: "setPadSample", track: 0, pad: 2, wav: [4, 5, 6] });
  });

  test("a pad goes back to the kit's own sound when its sample goes", () => {
    const sync = new EngineSync();
    const project = createProject();
    project.tracks.push(createDrumTrack("Drums A", "a"), createDrumTrack("Drums B", "b"));
    padsOf(project)[2]!.sample = "audio/clap.wav";
    const samples = new Map([["audio/clap.wav", { name: "clap.wav", bytes: [1, 2, 3] }]]);
    expect(sync.update(project, samples)).toContainEqual({ type: "setPadSample", track: 0, pad: 2, wav: [1, 2, 3] });

    // Taking the sample off the pad takes it off the engine's pad too.
    const off = structuredClone(project);
    padsOf(off)[2]!.sample = null;
    expect(sync.update(off, samples)).toEqual([{ type: "clearPadSample", track: 0, pad: 2 }]);
    expect(sync.update(off, samples)).toEqual([]);

    // And so does deleting the Track that had it: the Drum Track that takes
    // its engine Track plays its own pads, not the deleted Track's.
    sync.update(project, samples);
    const deleted = structuredClone(project);
    deleted.tracks.shift();
    expect(sync.update(deleted, samples)).toContainEqual({ type: "clearPadSample", track: 0, pad: 2 });
  });

  test("the engine is told how many pads a kit has, and told again when that changes", () => {
    const sync = new EngineSync();
    const project = createProject();
    project.tracks.push(createInstrumentTrack("Synth 1", "synth"), createDrumTrack("Drums", "drums"));
    const sent = sync.update(project);
    expect(sent).toContainEqual({ type: "setTrackInstrument", track: 1, instrument: "drumSampler", pads: STARTER_KIT.length });

    // A Project may have more pads than the kit, up to 32; the engine builds
    // the kit, so it is told the size and everything on the pads is sent again.
    const wider = structuredClone(project);
    const pads = padsOf({ ...wider, tracks: [wider.tracks[1]!] } as Project);
    pads.push({ name: "Shaker", note: 82, sample: null, volume: 1, pan: 0, pitch: 0, chokeGroup: 0 });
    const commands = sync.update(wider);
    expect(commands[0]).toEqual({ type: "setTrackInstrument", track: 1, instrument: "drumSampler", pads: STARTER_KIT.length + 1 });
    expect(commands).toContainEqual({
      type: "setPad",
      track: 1,
      pad: STARTER_KIT.length,
      note: 82,
      volume: 1,
      pan: 0,
      pitch: 0,
      chokeGroup: 0,
    });
  });

  test("a pad whose sample the folder hasn't got keeps the kit's own sound", () => {
    const sync = new EngineSync();
    const project = createProject();
    project.tracks.push(createDrumTrack("Drums", "drums"));
    padsOf(project)[2]!.sample = "audio/gone.wav";
    // Opening a Project reports the missing file; nothing is sent for it.
    expect(sync.update(project, new Map())).not.toContainEqual(
      expect.objectContaining({ type: "setPadSample" }),
    );
  });
});

/** The pads of the first Track, which the test has just made a Drum Track. */
function audioClip(id: string, start: number, duration: number, file: string, fileOffset: number): AudioClip {
  return { id, kind: "audio", start, duration, file, fileOffset };
}

/** A Project with one Audio Track playing `clips`. */
function audioProject(clips: AudioClip[]): Project {
  const project = createProject();
  const track = createAudioTrack("Vocals");
  track.clips = clips;
  project.tracks = [track];
  return project;
}

function audioTrackOf(project: Project): AudioTrack {
  const track = project.tracks[0];
  if (track?.kind !== "audio") throw new Error("no Audio Track");
  return track;
}

function padsOf(project: Project): DrumPad[] {
  const track = project.tracks[0];
  if (track?.kind !== "instrument" || track.instrument.type !== "drumSampler") throw new Error("no pads");
  return track.instrument.pads;
}

/** An EQ with its middle band at `band2GainDb`. */
function eq(id: string, band2GainDb = 0): Effect {
  return { ...createEffect("eq", id), settings: { ...defaultEffectSettings("eq"), band2GainDb } } as Effect;
}

const flat = effectFlat;

describe("EngineSync's Insert Chains", () => {

  test("an Effect added is inserted where it goes, with its settings", () => {
    const sync = new EngineSync();
    const project = projectWith([]);
    sync.update(project);
    project.tracks[0]!.insertChain.push(eq("e1", 3));
    project.master.insertChain.push(createEffect("reverb", "r1"));
    expect(sync.update(project)).toEqual([
      { type: "insertEffect", chain: -1, index: 0, effect: "reverb" },
      { type: "setEffectSettings", chain: -1, index: 0, settings: flat(project.master.insertChain[0]!) },
      { type: "insertEffect", chain: 0, index: 0, effect: "eq" },
      { type: "setEffectSettings", chain: 0, index: 0, settings: flat(project.tracks[0]!.insertChain[0]!) },
    ]);
    expect(sync.update(project)).toEqual([]);
  });

  test("settings and bypass are sent only when they change", () => {
    const sync = new EngineSync();
    const project = projectWith([]);
    project.tracks[0]!.insertChain.push(eq("e1"), createEffect("compressor", "c1"));
    sync.update(project);

    const edited = structuredClone(project);
    edited.tracks[0]!.insertChain[1]!.bypassed = true;
    edited.tracks[0]!.insertChain[0] = eq("e1", -4);
    expect(sync.update(edited)).toEqual([
      { type: "setEffectSettings", chain: 0, index: 0, settings: flat(edited.tracks[0]!.insertChain[0]!) },
      { type: "setEffectBypassed", chain: 0, index: 1, bypassed: true },
    ]);
  });

  test("an Effect that moves is moved, not rebuilt, and one that goes is removed", () => {
    const sync = new EngineSync();
    const project = projectWith([]);
    project.tracks[0]!.insertChain.push(eq("a"), createEffect("compressor", "b"), createEffect("reverb", "c"));
    sync.update(project);

    const moved = structuredClone(project);
    const chain = moved.tracks[0]!.insertChain;
    chain.unshift(chain.pop()!);
    expect(sync.update(moved)).toEqual([{ type: "moveEffect", chain: 0, from: 2, to: 0 }]);

    const removed = structuredClone(moved);
    removed.tracks[0]!.insertChain.splice(1, 1);
    expect(sync.update(removed)).toEqual([{ type: "removeEffect", chain: 0, index: 1 }]);
  });

  test("a Track that takes another's place gets that Track's chain, and a new Instrument keeps it", () => {
    const sync = new EngineSync();
    const project = projectWith([], []);
    project.tracks[0]!.insertChain.push(eq("a"));
    project.tracks[1]!.insertChain.push(createEffect("reverb", "b"));
    sync.update(project);

    const deleted = structuredClone(project);
    deleted.tracks.splice(0, 1);
    const commands = sync.update(deleted);
    expect(commands.filter((command) => command.type.includes("Effect"))).toEqual([
      { type: "removeEffect", chain: 0, index: 0 },
      { type: "insertEffect", chain: 0, index: 0, effect: "reverb" },
      { type: "setEffectSettings", chain: 0, index: 0, settings: flat(deleted.tracks[0]!.insertChain[0]!) },
    ]);

    const drums = structuredClone(deleted);
    const track = drums.tracks[0] as InstrumentTrack;
    drums.tracks[0] = { ...createDrumTrack("Drums", track.id), insertChain: track.insertChain };
    expect(sync.update(drums).some((command) => command.type.includes("Effect"))).toBe(false);
  });

  test("an Audio Track has an Insert Chain too, and one taking an Instrument Track's slot swaps the chain", () => {
    const sync = new EngineSync();
    const project = projectWith([]);
    project.tracks[0]!.insertChain.push(eq("a"));
    sync.update(project);

    const vocals = structuredClone(project);
    vocals.tracks[0] = createAudioTrack("Vocals");
    vocals.tracks[0].insertChain.push(createEffect("reverb", "b"));
    expect(sync.update(vocals).filter((command) => command.type.includes("Effect"))).toEqual([
      { type: "removeEffect", chain: 0, index: 0 },
      { type: "insertEffect", chain: 0, index: 0, effect: "reverb" },
      { type: "setEffectSettings", chain: 0, index: 0, settings: flat(vocals.tracks[0].insertChain[0]!) },
    ]);
    expect(sync.update(vocals)).toEqual([]);
  });
});

/** Drive the real WASM engine with the commands the UI sends, as the AudioWorklet does. */
function apply(engine: Engine, commands: EngineCommand[]) {
  for (const command of commands) applyEngineCommand(engine, command);
}

/** `project` rendered offline, from the top to `endTick`. */
function renderStereo(
  project: Project,
  endTick: number,
  samples: ReadonlyMap<string, LoadedSample> = new Map(),
): { left: Float32Array; right: Float32Array } {
  const engine = new Engine(48_000);
  try {
    apply(engine, new EngineSync().update(project, samples));
    const stereo = engine.render_range(0, endTick);
    return {
      left: stereo.filter((_: number, index: number) => index % 2 === 0),
      right: stereo.filter((_: number, index: number) => index % 2 === 1),
    };
  } finally {
    engine.free();
  }
}

/** The left channel of `project` rendered offline, from the top to `endTick`. */
function render(project: Project, endTick: number): Float32Array {
  return renderStereo(project, endTick).left;
}

// The real WASM engine, driven by the same commands the UI sends.
/** The first frame at or after `tick`, at 97 bpm and 48 kHz. */
function frameAt97(tick: number): number {
  return Math.ceil((tick * 60 * 48_000) / (97 * TICKS_PER_BEAT) - 1e-6);
}

describe("playing a Project in the engine", () => {
  beforeAll(() => {
    initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
  });

  test("a 4-bar Pattern Clip's notes start on their exact samples", () => {
    // A 4-bar Clip starting at bar 2, one note in each of its bars, on
    // 16th-note steps: the Step Sequencer's grid.
    const steps = [0, 21, 38, 63];
    const notes: Note[] = steps.map((step, index) => ({
      pitch: 60 + index * 4,
      start: step * SIXTEENTH,
      length: SIXTEENTH * 2,
      velocity: 0.8,
    }));
    const end = 5 * BAR;

    // Each note's onset is where the render with it first differs from the
    // render without it, which works however the earlier notes' tails ring.
    let without = render(projectWith([clip("c", BAR, [])]), end);
    for (const [index, step] of steps.entries()) {
      const withNote = render(projectWith([clip("c", BAR, notes.slice(0, index + 1))]), end);
      const onset = withNote.findIndex((sample, frame) => sample !== without[frame]);
      // 120 BPM at 48 kHz: 6000 frames per 16th. The saw's first sample is 0,
      // so the first sound is the frame after the note starts.
      expect(onset).toBe((16 + step) * 6_000 + 1);
      without = withNote;
    }
  });

  test("a Track's volume and pan come out of the render at exactly what the Project says", () => {
    // Acceptance: the numbers in the Project, not something near them.
    const notes: Note[] = [{ pitch: 60, start: 0, length: BAR, velocity: 0.8 }];
    const end = 2 * BAR;
    const unity = renderStereo(projectWith([clip("c", 0, notes)]), end);

    const mixed = projectWith([clip("c", 0, notes)]);
    mixed.tracks[0]!.mixer = { volume: 0.5, pan: 0.5, mute: false, solo: false };
    const played = renderStereo(mixed, end);

    // Pan is a balance: half right leaves the right side at the fader's gain
    // and takes the left side half way down.
    expect(played.left.length).toBe(unity.left.length);
    for (let frame = 0; frame < unity.left.length; frame++) {
      expect(played.left[frame]).toBeCloseTo(unity.left[frame]! * 0.5 * 0.5, 6);
      expect(played.right[frame]).toBeCloseTo(unity.right[frame]! * 0.5, 6);
    }
    expect(unity.left.some((sample) => sample !== 0)).toBe(true);
  });

  test("the Master fader and mute are what the render plays", () => {
    const notes: Note[] = [{ pitch: 60, start: 0, length: BAR, velocity: 0.8 }];
    const end = 2 * BAR;
    const unity = render(projectWith([clip("c", 0, notes)]), end);

    const quieter = projectWith([clip("c", 0, notes)]);
    quieter.master.volume = 0.25;
    const played = render(quieter, end);
    for (let frame = 0; frame < unity.length; frame++) {
      expect(played[frame]).toBeCloseTo(unity[frame]! * 0.25, 6);
    }

    const muted = projectWith([clip("c", 0, notes)]);
    muted.tracks[0]!.mixer = { volume: 1, pan: 0, mute: true, solo: false };
    expect(render(muted, end).every((sample) => sample === 0)).toBe(true);
  });

  test("a four-on-the-floor pattern plays the bundled kick on every beat", () => {
    const project = createProject();
    const track = createDrumTrack("Drums", "drums");
    const kick = STARTER_KIT[0]!.note;
    track.clips = [
      clip(
        "beat",
        0,
        [0, 1, 2, 3].map((beat) => ({
          pitch: kick,
          start: beat * TICKS_PER_BEAT,
          length: SIXTEENTH,
          velocity: 0.8,
        })),
        BAR,
      ),
    ];
    project.tracks.push(track);
    const left = render(project, BAR);

    // 120 BPM at 48 kHz: a beat is 24 000 frames. The kick sounds at the
    // start of each and has died away by the end of it.
    for (const beat of [0, 1, 2, 3]) {
      const at = beat * 24_000;
      const attack = peak(left.slice(at, at + 2_400));
      const tail = peak(left.slice(at + 21_600, at + 24_000));
      expect(attack).toBeGreaterThan(0.2);
      expect(attack).toBeGreaterThan(4 * tail);
    }
  });

  test("an Audio Clip plays its file through the real engine, trimmed and in time", () => {
    // A 48 kHz ramp, every frame different, so the render shows exactly which
    // frames played.
    const frames = 48_000;
    const left = Array.from({ length: frames }, (_, i) => ((i % 20_000) + 100) / 40_000);
    const right = left.map((s) => -s);
    const wav = stereoWav(left, right, 48_000);
    // From beat 2 for half a beat, 0.1 s into the file.
    const project = audioProject([audioClip("x", TICKS_PER_BEAT, 0.25, "audio/ramp.wav", 0.1)]);
    const stereo = renderStereo(project, 2 * TICKS_PER_BEAT, new Map([["audio/ramp.wav", { name: "ramp.wav", bytes: wav }]]));

    // At 120 bpm a beat is 24,000 frames; one Track alone reaches the Master
    // at the engine's Track gain.
    const start = 24_000;
    const end = 36_000;
    const gain = stereo.left[start]! / (left[4_800]!);
    expect(gain).toBeGreaterThan(0.1);
    expect(stereo.left.slice(0, start).every((s) => s === 0)).toBe(true);
    expect(stereo.left[start - 1]).toBe(0);
    for (const i of [start, start + 1, 30_000, end - 1]) {
      expect(stereo.left[i]).toBeCloseTo(left[4_800 + i - start]! * gain, 4);
      expect(stereo.right[i]).toBeCloseTo(right[4_800 + i - start]! * gain, 4);
    }
    expect(stereo.left.slice(end).every((s) => s === 0)).toBe(true);
  });

  test("notes after a Tempo Change land on the samples the new tempo puts them on", () => {
    const project = createProject();
    const keys = createInstrumentTrack("Keys", "keys");
    keys.clips = [clip("a", 0, [{ pitch: 60, start: 2 * BAR, length: SIXTEENTH, velocity: 0.8 }], 3 * BAR)];
    project.tracks = [keys];
    // 120 BPM up to the last beat of bar 2 (3.5 s), then 60: a beat is
    // 48,000 frames, so bar 3 starts at 4.5 s.
    project.tempoChanges = [{ id: "t", tick: 2 * BAR - TICKS_PER_BEAT, tempo: 60, timeSignature: null }];
    const left = render(project, 3 * BAR);
    const onset = 4.5 * 48_000;
    expect(left.slice(0, onset).every((s) => s === 0)).toBe(true);
    expect(left[onset + 1]).not.toBe(0);
    expect(left.length).toBe(onset + 4 * 48_000);
  });

  test("a schema 4 Project opens and plays exactly as it did", () => {
    // Saved before Tempo Changes, at a tempo whose ticks aren't whole
    // frames: its Audio Clip held a length in ticks.
    const project = audioProject([]);
    const saved = JSON.parse(serialiseProject(project)) as Record<string, unknown>;
    delete saved.tempoChanges;
    const vocals = (saved.tracks as Record<string, unknown>[])[0]!;
    vocals.clips = [{ id: "x", kind: "audio", start: 1000, length: 1003, file: "audio/tone.wav", fileOffset: 0 }];
    const opened = parseProject(JSON.stringify({ ...saved, schemaVersion: 4, tempo: 97 }));
    if (!opened.ok) throw new Error(opened.error);

    const tone = Array.from({ length: 96_000 }, () => 0.5);
    const samples = new Map([["audio/tone.wav", { name: "tone.wav", bytes: stereoWav(tone, tone, 48_000) }]]);
    const { left } = renderStereo(opened.project, 3000, samples);
    // Before, the Clip sounded from the first frame at or after tick 1000
    // up to the first frame at or after tick 2003.
    expect(left.findIndex((s) => s !== 0)).toBe(frameAt97(1000));
    expect(left.findLastIndex((s) => s !== 0)).toBe(frameAt97(2003) - 1);
  });
});

describe("Insert Chains in the engine", () => {
  beforeAll(() => {
    initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
  });

  test("after any run of edits the engine's chains are the Project's, Effect for Effect", () => {
    // A seeded shuffle of adds, removes, moves, bypasses and settings, on
    // two Tracks and the Master, checked against the engine after each.
    let seed = 13;
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const engine = new Engine(48_000);
    const sync = new EngineSync();
    const project = projectWith([], []);
    let next = 0;
    try {
      for (let step = 0; step < 200; step++) {
        const chain = pick([project.tracks[0]!.insertChain, project.tracks[1]!.insertChain, project.master.insertChain]);
        const edit = chain.length === 0 ? 0 : Math.floor(random() * 5);
        if (edit === 0 && chain.length < 16) {
          chain.splice(Math.floor(random() * (chain.length + 1)), 0, createEffect(pick(["eq", "compressor", "reverb"] as const), `fx${next++}`));
        } else if (edit === 1) {
          chain.splice(Math.floor(random() * chain.length), 1);
        } else if (edit === 2) {
          const [effect] = chain.splice(Math.floor(random() * chain.length), 1);
          chain.splice(Math.floor(random() * (chain.length + 1)), 0, effect!);
        } else if (edit === 3) {
          const effect = pick(chain);
          effect.bypassed = !effect.bypassed;
        } else if (chain.length > 0) {
          const effect = pick(chain) as BuiltInEffect;
          const values = effectSettingsToFlat(effect.type, effect.settings).map(() => random() * 1_000 - 500);
          effect.settings = effectSettingsFromFlat(effect.type, values);
        }
        apply(engine, sync.update(project));

        const chains = [[0, project.tracks[0]!.insertChain], [1, project.tracks[1]!.insertChain], [-1, project.master.insertChain]] as const;
        for (const [index, effects] of chains) {
          expect(engine.chain_effects(index)).toBe(effects.map((effect) => effect.type).join(","));
          effects.forEach((effect, position) => {
            const played = [...engine.effect_settings(index, position)];
            const wanted = effectFlat(effect);
            played.forEach((value, setting) => expect(value).toBeCloseTo(wanted[setting]!, 3));
          });
        }
      }
    } finally {
      engine.free();
    }
  });

  test("a bypassed Effect plays as if it weren't there, and reordering changes the render", () => {
    const notes: Note[] = [{ pitch: 57, start: 0, length: BAR, velocity: 1 }];
    const end = 2 * BAR;
    const dry = render(projectWith([clip("c", 0, notes)]), end);

    const withChain = (...effects: Effect[]) => {
      const project = projectWith([clip("c", 0, notes)]);
      project.tracks[0]!.insertChain.push(...effects);
      return render(project, end);
    };
    // A compressor that squashes hard and an EQ that takes 18 dB off
    // everything: the compressor hears a loud signal before the EQ and a
    // quiet one after it.
    const squash = createEffect("compressor", "c");
    squash.settings = { thresholdDb: -30, ratio: 20, attack: 1, release: 100, makeupDb: 0, kneeDb: 0 };
    const quieter = createEffect("eq", "e");
    quieter.settings = { ...defaultEffectSettings("eq"), lowShelfHz: 20000, lowShelfGainDb: -18 };

    const bypassed = { ...quieter, bypassed: true };
    expect(withChain(bypassed)).toEqual(dry);

    const compressedFirst = peak(withChain(squash, quieter));
    const cutFirst = peak(withChain(quieter, squash));
    expect(20 * Math.log10(compressedFirst / cutFirst)).toBeLessThan(-6);
    expect(peak(withChain(quieter))).toBeLessThan(peak(dry) / 4);
  });
});

function peak(samples: Float32Array): number {
  return samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
}

import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { beforeAll, describe, expect, test } from "vitest";

import { applyEngineCommand } from "../audio/apply-engine-command";
import type { EngineCommand } from "../audio/audio-output";
import { applyCommands, type Command } from "./commands";
import { busChain } from "../audio/gain-reduction";
import { EngineSync } from "./engine-sync";
import { createBus, createDrumTrack, createEffect, createInstrumentTrack, createProject, type Project } from "./model";
import { TICKS_PER_BEAT } from "./time";

const BAR = TICKS_PER_BEAT * 4;

/** Two Tracks, each holding one note for two bars. */
function project(): Project {
  const song = createProject();
  [48, 55].forEach((pitch, index) => {
    const track = createInstrumentTrack(`Synth ${index + 1}`, `t${index}`);
    const notes = [{ pitch, start: 0, length: 2 * BAR, velocity: 1 }];
    track.clips.push({ id: `c${index}`, kind: "pattern", start: 0, length: 2 * BAR, notes });
    song.tracks.push(track);
  });
  return song;
}

function edited(from: Project, ...commands: Command[]): Project {
  const result = applyCommands(from, commands);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

const ramp: Command = {
  type: "setAutomation",
  target: { trackId: "t1" },
  setting: "volume",
  breakpoints: [
    { tick: 0, value: 0, hold: false },
    { tick: BAR, value: 1, hold: true },
  ],
};

describe("EngineSync's Automation", () => {
  test("sends a setting's breakpoints flat when they change, and none when it stops being automated", () => {
    const sync = new EngineSync();
    const plain = project();
    const sent = (song: Project) => sync.update(song).filter((command) => command.type === "setAutomation");
    expect(sent(plain)).toEqual([]);

    const automated = edited(plain, ramp, {
      type: "setAutomation",
      target: "master",
      setting: "volume",
      breakpoints: [{ tick: 960, value: 0.5, hold: false }],
    });
    expect(sent(automated)).toEqual([
      { type: "setAutomation", target: -1, setting: "volume", points: [960, 0.5, 0] },
      { type: "setAutomation", target: 1, setting: "volume", points: [0, 0, 0, BAR, 1, 1] },
    ]);
    expect(sync.update(automated)).toEqual([]);

    const cleared = edited(automated, { ...ramp, breakpoints: [] });
    expect(sent(cleared)).toEqual([{ type: "setAutomation", target: 1, setting: "volume", points: [] }]);
  });

  test("a Track's Automation stays with it in the engine when its Instrument changes, and moves when it does", () => {
    const sync = new EngineSync();
    const automated = edited(project(), ramp);
    sync.update(automated);

    const kit = edited(automated, { type: "setInstrument", trackId: "t1", instrument: createDrumTrack("x").instrument });
    const commands = sync.update(kit);
    expect(commands.some((command) => command.type === "setTrackInstrument")).toBe(true);
    expect(commands.filter((command) => command.type === "setAutomation")).toEqual([]);

    const moved = edited(automated, { type: "moveTrack", trackId: "t1", index: 0 });
    expect(sync.update(moved).filter((command) => command.type === "setAutomation")).toEqual([
      { type: "setAutomation", target: 0, setting: "volume", points: [0, 0, 0, BAR, 1, 1] },
      { type: "setAutomation", target: 1, setting: "volume", points: [] },
    ]);
  });

  test("sends a Track's Send, Synth and Effect Automation by the engine's numbers", () => {
    const sync = new EngineSync();
    const withBusesAndEq = edited(
      project(),
      { type: "addBus", bus: createBus("A", "a") },
      { type: "addBus", bus: createBus("B", "b") },
      { type: "addSend", from: { trackId: "t1" }, busId: "b", level: 1 },
      { type: "addEffect", target: { trackId: "t1" }, effect: createEffect("reverb", "verb") },
      { type: "addEffect", target: { trackId: "t1" }, effect: createEffect("eq", "eq") },
    );
    sync.update(withBusesAndEq);
    const automated = edited(
      withBusesAndEq,
      { type: "setAutomation", target: { trackId: "t1" }, setting: "send:b", breakpoints: point(0.5) },
      { type: "setAutomation", target: { trackId: "t1" }, setting: "effect:eq:lowShelfGainDb", breakpoints: point(6) },
      { type: "setAutomation", target: { trackId: "t1" }, setting: "instrument:cutoffHz", breakpoints: point(500) },
    );
    expect(automations(sync.update(automated))).toEqual([
      { type: "setAutomation", target: 1, setting: "effect:1:lowShelfGainDb", points: [0, 6, 0] },
      { type: "setAutomation", target: 1, setting: "send:1", points: [0, 0.5, 0] },
      { type: "setAutomation", target: 1, setting: "instrument:cutoffHz", points: [0, 500, 0] },
    ]);
    expect(sync.update(automated)).toEqual([]);

    // Bus A goes, so B is the engine's Bus 0 now; the Reverb goes, so the EQ
    // is first in the chain, its Automation moving with it in the engine.
    const shifted = edited(automated, { type: "deleteBus", busId: "a" }, { type: "removeEffect", effectId: "verb" });
    expect(automations(sync.update(shifted))).toEqual([
      { type: "setAutomation", target: 1, setting: "send:1", points: [] },
      { type: "setAutomation", target: 1, setting: "send:0", points: [0, 0.5, 0] },
    ]);

    // Taking the EQ away takes its Automation with it, in the engine too.
    const commands = sync.update(edited(shifted, { type: "removeEffect", effectId: "eq" }));
    expect(commands).toContainEqual({ type: "removeEffect", chain: 1, index: 0 });
    expect(automations(commands)).toEqual([]);
  });

  test("sends a Drum Sampler Pad's Automation by where the Pad with its note is in the kit, and none once the Pads go", () => {
    const sync = new EngineSync();
    const kit = edited(project(), { type: "setInstrument", trackId: "t1", instrument: createDrumTrack("x").instrument });
    sync.update(kit);
    // The Starter Kit's closed hat, note 42, is its fourth Pad.
    const automated = edited(kit, { type: "setAutomation", target: { trackId: "t1" }, setting: "instrument:pad42.pitch", breakpoints: point(-7) });
    expect(automations(sync.update(automated))).toEqual([{ type: "setAutomation", target: 1, setting: "pad:3:pitch", points: [0, -7, 0] }]);

    // A Kit with the hat first: its Automation follows it there.
    const pads = kit.tracks[1]!.kind === "instrument" && kit.tracks[1]!.instrument.type === "drumSampler" ? kit.tracks[1]!.instrument.pads : [];
    const reordered = edited(automated, {
      type: "setInstrument",
      trackId: "t1",
      instrument: { type: "drumSampler", preset: "Mine", pads: [pads[3]!, ...pads.filter((_, index) => index !== 3)] },
    });
    expect(reordered.tracks[1]!.automation).toEqual(automated.tracks[1]!.automation);
    expect(automations(sync.update(reordered))).toEqual([
      { type: "setAutomation", target: 1, setting: "pad:3:pitch", points: [] },
      { type: "setAutomation", target: 1, setting: "pad:0:pitch", points: [0, -7, 0] },
    ]);

    // The Synth takes the Track's place: the Pad's Automation goes, in the engine too.
    const synth = edited(reordered, { type: "setInstrument", trackId: "t1", instrument: createInstrumentTrack("x").instrument });
    expect(synth.tracks[1]!.automation).toEqual([]);
    expect(automations(sync.update(synth))).toEqual([{ type: "setAutomation", target: 1, setting: "pad:0:pitch", points: [] }]);
  });

  test("sends a Bus's and the Master's Automation, their Effects' included", () => {
    const sync = new EngineSync();
    const song = edited(
      project(),
      { type: "addBus", bus: createBus("A", "a") },
      { type: "addBus", bus: createBus("B", "b") },
      { type: "addSend", from: { busId: "a" }, busId: "b", level: 1 },
      { type: "addEffect", target: { busId: "b" }, effect: createEffect("delay", "echo") },
      { type: "addEffect", target: "master", effect: createEffect("compressor", "glue") },
      { type: "setAutomation", target: { busId: "a" }, setting: "send:b", breakpoints: point(2) },
      { type: "setAutomation", target: { busId: "b" }, setting: "pan", breakpoints: point(-1) },
      { type: "setAutomation", target: { busId: "b" }, setting: "effect:echo:mix", breakpoints: point(1) },
      { type: "setAutomation", target: "master", setting: "effect:glue:thresholdDb", breakpoints: point(-30) },
    );
    expect(automations(sync.update(song))).toEqual([
      { type: "setAutomation", target: -1, setting: "effect:0:thresholdDb", points: [0, -30, 0] },
      { type: "setAutomation", target: busChain(1), setting: "effect:0:mix", points: [0, 1, 0] },
      { type: "setAutomation", target: busChain(0), setting: "send:1", points: [0, 2, 0] },
      { type: "setAutomation", target: busChain(1), setting: "pan", points: [0, -1, 0] },
    ]);
  });
});

function point(value: number) {
  return [{ tick: 0, value, hold: false }];
}

function automations(commands: EngineCommand[]): EngineCommand[] {
  return commands.filter((command) => command.type === "setAutomation");
}

/** Two bars of `song` from the real engine, driven by the commands the UI sends. */
function render(song: Project): Float32Array {
  const engine = new Engine(48_000);
  try {
    for (const command of new EngineSync().update(song)) applyEngineCommand(engine, command as EngineCommand);
    return engine.render_range(0, 2 * BAR);
  } finally {
    engine.free();
  }
}

describe("Automation in the engine", () => {
  beforeAll(() => {
    initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
  });

  test("an automated Track plays silent at its first breakpoint, then at its fader once the ramp is done", () => {
    const solo = (song: Project) =>
      edited(song, { type: "setTrackMixer", trackId: "t0", mixer: { mute: true } });
    const automated = render(solo(edited(project(), ramp)));
    const fixed = render(solo(project()));
    // At 120 bpm and 48 kHz a bar is 96 000 frames, two samples each.
    const bar = 96_000 * 2;
    expect(automated.slice(0, 20).every((sample) => Math.abs(sample) < 1e-6)).toBe(true);
    for (let index = bar; index < 2 * bar; index += 37) {
      expect(automated[index]).toBeCloseTo(fixed[index]!, 6);
    }
    // Half way up the ramp, half the level.
    const middle = bar / 2;
    expect(automated[middle]).toBeCloseTo(fixed[middle]! * 0.5, 3);
  });

  test("an Effect's or the Synth's setting held by Automation sounds as if it were set there", () => {
    const withEq = edited(project(), { type: "addEffect", target: { trackId: "t1" }, effect: createEffect("eq", "eq") });
    const fixedly = render(
      edited(
        withEq,
        { type: "setEffectSettings", effectId: "eq", settings: { lowShelfGainDb: 12 } },
        { type: "setSynthSettings", trackId: "t1", settings: { cutoffHz: 400 } },
      ),
    );
    const automated = render(
      edited(
        withEq,
        { type: "setAutomation", target: { trackId: "t1" }, setting: "effect:eq:lowShelfGainDb", breakpoints: point(12) },
        { type: "setAutomation", target: { trackId: "t1" }, setting: "instrument:cutoffHz", breakpoints: point(400) },
      ),
    );
    expect(Array.from(automated)).toEqual(Array.from(fixedly));
    expect(Array.from(render(withEq))).not.toEqual(Array.from(fixedly));
  });

  test("a Drum Sampler Pad's settings held by Automation sound as if they were set there", () => {
    const drums = createDrumTrack("Drums", "d");
    drums.clips.push({ id: "d1", kind: "pattern", start: 0, length: BAR, notes: [0, 1, 2, 3].map((beat) => ({ pitch: 38, start: beat * TICKS_PER_BEAT, length: 120, velocity: 1 })) });
    const song = createProject();
    song.tracks.push(drums);
    // The Starter Kit's snare, note 38, is its second Pad.
    const fixedly = render(edited(song, { type: "setDrumPad", trackId: "d", pad: 1, settings: { volume: 0.4, pan: -0.5, pitch: 5 } }));
    const automated = render(
      edited(
        song,
        { type: "setAutomation", target: { trackId: "d" }, setting: "instrument:pad38.volume", breakpoints: point(0.4) },
        { type: "setAutomation", target: { trackId: "d" }, setting: "instrument:pad38.pan", breakpoints: point(-0.5) },
        { type: "setAutomation", target: { trackId: "d" }, setting: "instrument:pad38.pitch", breakpoints: point(5) },
      ),
    );
    expect(Array.from(automated)).toEqual(Array.from(fixedly));
    expect(Array.from(render(song))).not.toEqual(Array.from(fixedly));
  });
});

import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { applyEngineCommand } from "../audio/apply-engine-command";
import type { EngineCommand } from "../audio/audio-output";
import { createPluginEffect } from "../effect/effect-table";
import { createPluginInstrument } from "../instrument/instrument-table";
import { EngineSync } from "../project/engine-sync";
import { createInstrumentTrack, createProject, type Project } from "../project/model";
import { TICKS_PER_BEAT } from "../project/time";
import { setInstalledPlugins, type InstalledPlugin } from "./plugins";
import { exampleWasm, installedTestPlugin } from "./test-plugin";
import { WasmPluginHost } from "./wasm-plugin-runtime";

/** 120 BPM at 48 kHz: a second is two beats. */
const RATE = 48_000;
const SECOND = TICKS_PER_BEAT * 2;

let bitcrusher: InstalledPlugin;
let wavetable: InstalledPlugin;

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
  bitcrusher = installedTestPlugin(exampleWasm("bitcrusher"));
  wavetable = installedTestPlugin(exampleWasm("wavetable"));
}, 300_000);

afterEach(() => setInstalledPlugins([]));

/**
 * A song whose one Instrument Track plays `pitch` for a second on the example
 * wavetable, a sine with no attack, and what its Master plays (the left side)
 * through the browser's `WebAssembly`, as the worklet has it.
 */
function play(pitch: number, crushMaster = false): number[] {
  setInstalledPlugins([bitcrusher, wavetable]);
  const track = createInstrumentTrack("Keys", "keys");
  track.instrument = {
    ...createPluginInstrument(wavetable.manifest),
    settings: { shape: 0, attack: 0, release: 200, level: 0.5 },
  };
  track.clips.push({
    id: "clip",
    kind: "pattern",
    start: 0,
    length: SECOND,
    notes: [{ pitch, start: 0, length: SECOND, velocity: 1 }],
  });
  const project: Project = createProject("Examples");
  project.tracks.push(track);
  if (crushMaster) {
    project.master.insertChain.push({
      ...createPluginEffect(bitcrusher.manifest, "crush"),
      settings: { bits: 3, hold: 1, mix: 1 },
    });
  }
  const engine = new Engine(RATE);
  const host = new WasmPluginHost(RATE);
  for (const command of new EngineSync().update(project) as EngineCommand[]) {
    applyEngineCommand(engine, command, host);
  }
  const played = engine.render_range(0, SECOND);
  engine.free();
  return [...played].filter((_, index) => index % 2 === 0);
}

/** The pitch of a sine at 48 kHz, from how often it rises through zero. */
function pitchOf(samples: number[]): number {
  let rises = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1]! < 0 && samples[i]! >= 0) rises++;
  return (rises * RATE) / samples.length;
}

/** Whether a sample is on one of 3-bit audio's levels: a multiple of 1/4. */
function onALevel(sample: number): boolean {
  return Number.isInteger(sample * 4);
}

describe("the example Plugins, built only against the SDK", () => {
  test("they install as an Effect and an Instrument", () => {
    expect(bitcrusher.manifest).toMatchObject({ id: "dev.soundcheck.example.bitcrusher", kind: "effect" });
    expect(bitcrusher.manifest.settings.map((setting) => setting.name)).toEqual(["bits", "hold", "mix"]);
    expect(wavetable.manifest).toMatchObject({ id: "dev.soundcheck.example.wavetable", kind: "instrument" });
    expect(wavetable.manifest.settings.map((setting) => setting.name)).toEqual(["shape", "attack", "release", "level"]);
  });

  test.each([
    [69, 440],
    [57, 220],
    [72, 523.25],
  ])("the wavetable plays note %i at %f Hz through the browser's WebAssembly", (pitch, hz) => {
    const played = play(pitch);
    expect(played.some((sample) => Math.abs(sample) > 0.1)).toBe(true);
    expect(Math.abs(pitchOf(played) - hz)).toBeLessThan(1.5);
  });

  test("the bitcrusher quantises the Master through the browser's WebAssembly", () => {
    const dry = play(69);
    expect(dry.every(onALevel)).toBe(false);
    const crushed = play(69, true);
    expect(crushed.every(onALevel)).toBe(true);
    expect(crushed.some((sample) => Math.abs(sample) >= 0.25)).toBe(true);
    expect(crushed).not.toEqual(dry);
  });
});

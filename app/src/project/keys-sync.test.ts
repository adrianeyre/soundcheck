import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import { applyEngineCommand } from "../audio/apply-engine-command";
import { keysSettingsToFlat } from "../instrument/keys-params";
import { keysPreset } from "../instrument/keys-presets";
import { audioFiles } from "../storage/project-folder";
import { stereoWav } from "../song/test-wav";
import { automatableSettings } from "./automation";
import { applyCommands } from "./commands";
import { EngineSync, type LoadedSample } from "./engine-sync";
import { createKeysTrack, createProject, type InstrumentTrack, type PatternClip, type Project } from "./model";
import { parseProject, serialiseProject } from "./serialise";
import { TICKS_PER_BEAT } from "./time";

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

const BAR = TICKS_PER_BEAT * 4;

/** One Keys Track playing middle C for a bar. */
function keysProject(preset = "Concert Grand"): Project {
  const track = createKeysTrack("Piano", "t1", { name: preset, settings: keysPreset(preset)!.settings });
  const clip: PatternClip = { id: "c1", kind: "pattern", start: 0, length: BAR, notes: [{ start: 0, length: TICKS_PER_BEAT, pitch: 60, velocity: 0.9 }] };
  return { ...createProject("Demo"), tracks: [{ ...track, clips: [clip] }] };
}

function peakOf(project: Project, samples: ReadonlyMap<string, LoadedSample> = new Map()): number {
  const engine = new Engine(48_000);
  try {
    for (const command of new EngineSync().update(project, samples)) applyEngineCommand(engine, command);
    return engine.render_range(0, BAR).reduce((loudest: number, value: number) => Math.max(loudest, Math.abs(value)), 0);
  } finally {
    engine.free();
  }
}

test("a Keys Track tells the engine its Instrument and settings, and the engine plays them", () => {
  const project = keysProject("Honky-Tonk");
  const commands = new EngineSync().update(project, new Map());
  expect(commands).toContainEqual({ type: "setTrackInstrument", track: 0, instrument: "keys", pads: null });
  expect(commands).toContainEqual({ type: "setKeysSettings", track: 0, settings: keysSettingsToFlat(keysPreset("Honky-Tonk")!.settings) });
  expect(peakOf(project)).toBeGreaterThan(0.05);
});

test("the Keys' sample is sent once, played, and cleared when it comes off", () => {
  const tone = Array.from({ length: 24_000 }, (_, frame) => 0.5 * Math.sin((2 * Math.PI * 220 * frame) / 48_000));
  const sample: LoadedSample = { name: "tone.wav", bytes: stereoWav(tone, tone, 48_000) };
  const samples = new Map([["audio/tone.wav", sample]]);
  const result = applyCommands(keysProject(), [{ type: "setKeysSample", trackId: "t1", sample: "audio/tone.wav", rootNote: 57 }]);
  if (!result.ok) throw new Error(result.error);
  const withSample = result.project;

  const sync = new EngineSync();
  sync.update(keysProject(), samples);
  const sent = sync.update(withSample, samples);
  expect(sent).toContainEqual({ type: "setKeysSample", track: 0, wav: sample.bytes });
  expect(sync.update(withSample, samples).filter((command) => command.type === "setKeysSample")).toEqual([]);
  expect(peakOf(withSample, samples)).toBeGreaterThan(0.1);

  const off = applyCommands(withSample, [{ type: "setKeysSample", trackId: "t1", sample: null }]);
  if (!off.ok) throw new Error(off.error);
  expect(sync.update(off.project, samples)).toContainEqual({ type: "clearKeysSample", track: 0 });
  // The Project folder keeps the sample the Keys play, as it keeps a pad's.
  expect(audioFiles(withSample)).toEqual(["audio/tone.wav"]);
});

test("a Keys Project saves and opens again, and only its continuous settings are automatable", () => {
  const project = keysProject("Tine EP");
  expect(parseProject(serialiseProject(project))).toEqual({ ok: true, project });
  const names = automatableSettings(project, project.tracks[0] as InstrumentTrack).map((setting) => setting.setting);
  expect(names).toContain("instrument:brightness");
  expect(names).toContain("instrument:level");
  expect(names).not.toContain("instrument:source");
  expect(names).not.toContain("instrument:voices");
});

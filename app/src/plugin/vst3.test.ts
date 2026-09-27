import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { applyEngineCommand } from "../audio/apply-engine-command";
import type { EngineCommand } from "../audio/audio-output";
import { createPluginEffect, effectName, effectTable, isMissingPlugin } from "../effect/effect-table";
import { createPluginInstrument, instrumentName, isMissingInstrument } from "../instrument/instrument-table";
import { applyCommands, type Command } from "../project/commands";
import { EngineSync } from "../project/engine-sync";
import { createInstrumentTrack, createProject, type Project } from "../project/model";
import { TICKS_PER_BEAT } from "../project/time";
import { KEYS, TILT, TILT_SETTINGS, tiltManifest } from "./fake-vst3-host";
import {
  resetVst3,
  setVst3Instance,
  setVst3Scanned,
  type Vst3Class,
  vst3ClassOf,
  vst3Generation,
  vst3InstrumentKey,
  vst3Manifest,
  vst3PluginId,
} from "./vst3";

const BAR = TICKS_PER_BEAT * 4;

function ready(key: string, vst3Class: Vst3Class, generation: number, kind: "effect" | "instrument" = "effect") {
  const settings = vst3Class === TILT ? TILT_SETTINGS : [];
  setVst3Instance(key, {
    status: "ready",
    pluginId: vst3PluginId(vst3Class.cid),
    generation,
    manifest: vst3Manifest(vst3Class, { kind, settings }),
    editor: null,
    open: false,
  });
}

function edited(from: Project, ...commands: Command[]): Project {
  const result = applyCommands(from, commands);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

/** One Synth Track holding a chord for a bar, with the Tilt, at its settings, in its Insert Chain. */
function withTilt(): Project {
  const track = createInstrumentTrack("Keys", "keys");
  const notes = [48, 55, 64].map((pitch) => ({ pitch, start: 0, length: BAR, velocity: 0.8 }));
  track.clips.push({ id: "chord", kind: "pattern", start: 0, length: BAR, notes });
  const project = createProject("VST3");
  project.tracks.push(track);
  const effect = { ...createPluginEffect(tiltManifest(), "fx"), settings: { p0: 0.25, p7: 1 } };
  return edited(project, { type: "addEffect", target: { trackId: "keys" }, effect });
}

afterEach(resetVst3);

describe("a VST3 Plugin as the rest of the UI sees it", () => {
  test("a new one carries its name, vendor and no state, and its settings are its exposed ones, normalised", () => {
    const effect = createPluginEffect(tiltManifest(), "fx");
    expect(effect).toEqual({
      id: "fx",
      type: "plugin",
      bypassed: false,
      plugin: { id: "vst3.0123456789abcdef0123456789abcdef", version: "1.0.2" },
      settings: { p0: 0.5, p7: 0 },
      vst3: { name: "Tilt", vendor: "Tilters", state: { component: "", controller: "" } },
    });
    expect(tiltManifest().settings[1]).toMatchObject({ label: "Mode", min: 0, max: 1, step: 0.5 });
  });

  test("until an instance of it has loaded it is missing, called by its saved name, and declares nothing", () => {
    const effect = withTilt().tracks[0]!.insertChain[0]!;
    expect(isMissingPlugin(effect)).toBe(true);
    expect(effectName(effect)).toBe("Tilt");
    expect(effectTable(effect)).toEqual([]);

    ready("fx", TILT, 1);
    expect(isMissingPlugin(effect)).toBe(false);
    expect(effectTable(effect).map((param) => param.label)).toEqual(["Tilt", "Mode"]);
  });

  test("an Instrument is missing until its Track's instance has loaded", () => {
    const instrument = { ...createPluginInstrument(vst3Manifest(KEYS, { kind: "instrument", settings: [] })) };
    expect(isMissingInstrument(instrument)).toBe(true);
    expect(instrumentName(instrument)).toBe("Keys");
    ready(vst3InstrumentKey("keys"), KEYS, 3, "instrument");
    expect(isMissingInstrument(instrument)).toBe(false);
  });

  test("the scan finds a class by the id a Project has for it, whatever its case", () => {
    setVst3Scanned([
      { bundle: "/vst3/Tilt.vst3", classes: [{ ...TILT, cid: TILT.cid.toLowerCase() }], error: null, source: "moduleInfo" },
    ]);
    expect(vst3ClassOf(vst3PluginId(TILT.cid))?.bundle).toBe("/vst3/Tilt.vst3");
    expect(vst3ClassOf(vst3PluginId(KEYS.cid))).toBeUndefined();
  });

  test("the engine's slot takes an instance's generation only for the Plugin it is an instance of", () => {
    ready("fx", TILT, 4);
    expect(vst3Generation("fx", vst3PluginId(TILT.cid))).toBe(4);
    expect(vst3Generation("fx", vst3PluginId(KEYS.cid))).toBeUndefined();
    setVst3Instance("fx", { status: "loading", pluginId: vst3PluginId(TILT.cid) });
    expect(vst3Generation("fx", vst3PluginId(TILT.cid))).toBeUndefined();
  });
});

describe("EngineSync and a VST3 Plugin", () => {
  test("an Effect holds a missing Plugin's place until it loads, then the slot hosts that load, and is rebuilt on a Reload", () => {
    const sync = new EngineSync();
    const project = withTilt();
    const first = sync.update(project);
    expect(first).toContainEqual({ type: "insertPlugin", chain: 0, index: 0, plugin: "vst3.0123456789abcdef0123456789abcdef" });

    ready("fx", TILT, 1);
    const loaded = sync.update(project);
    expect(loaded).toEqual([
      { type: "removeEffect", chain: 0, index: 0 },
      { type: "insertVst3", chain: 0, index: 0, instance: "fx", generation: 1 },
      { type: "setEffectSettings", chain: 0, index: 0, settings: [0.25, 1] },
    ]);
    expect(sync.update(project)).toEqual([]);

    // Crashed, it keeps its slot: the engine already bypasses it.
    setVst3Instance("fx", {
      status: "crashed",
      pluginId: vst3PluginId(TILT.cid),
      generation: 1,
      manifest: tiltManifest(),
      editor: null,
      open: false,
    });
    expect(sync.update(project)).toEqual([]);

    ready("fx", TILT, 2);
    expect(sync.update(project).slice(0, 2)).toEqual([
      { type: "removeEffect", chain: 0, index: 0 },
      { type: "insertVst3", chain: 0, index: 0, instance: "fx", generation: 2 },
    ]);
  });

  test("an Instrument goes to its Track's instance once loaded, with its settings", () => {
    const manifest = vst3Manifest(KEYS, {
      kind: "instrument",
      settings: [{ id: 3, name: "p3", label: "Bright", unit: "", default: 0.2, steps: 0, value: 0.2 }],
    });
    const project = edited(withTilt(), { type: "setInstrument", trackId: "keys", instrument: createPluginInstrument(manifest) });
    const sync = new EngineSync();
    expect(sync.update(project)).toContainEqual({ type: "setTrackPlugin", track: 0, plugin: vst3PluginId(KEYS.cid) });

    setVst3Instance(vst3InstrumentKey("keys"), {
      status: "ready",
      pluginId: vst3PluginId(KEYS.cid),
      generation: 5,
      manifest,
      editor: null,
      open: false,
    });
    const loaded = sync.update(project);
    expect(loaded).toContainEqual({ type: "setTrackVst3", track: 0, instance: "instrument:keys", generation: 5 });
    expect(loaded).toContainEqual({ type: "setInstrumentSettings", track: 0, settings: [0.2] });
  });
});

describe("the Browser Version and a VST3 Plugin", () => {
  beforeAll(() => {
    initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
  }, 300_000);

  test("hosts none: its slot passes the audio through and its Instrument is silent", () => {
    const render = (commands: EngineCommand[]) => {
      const engine = new Engine(48_000);
      for (const command of commands) applyEngineCommand(engine, command);
      return engine.render_range(0, BAR);
    };
    const project = withTilt();
    const dry = render(new EngineSync().update({ ...project, tracks: [{ ...project.tracks[0]!, insertChain: [] }] }));
    ready("fx", TILT, 1);
    const commands = new EngineSync().update(project);
    expect(commands).toContainEqual({ type: "insertVst3", chain: 0, index: 0, instance: "fx", generation: 1 });
    expect(dry.some((sample) => sample !== 0)).toBe(true);
    expect(render(commands)).toEqual(dry);

    const silent = render([
      { type: "setTrackCount", count: 1 },
      { type: "setTrackVst3", track: 0, instance: "instrument:keys", generation: 1 },
      { type: "setTrackNotes", track: 0, notes: [0, BAR, 60, 0.8] },
    ]);
    expect(silent.every((sample) => sample === 0)).toBe(true);
  });
});

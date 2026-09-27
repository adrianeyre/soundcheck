import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { applyEngineCommand } from "../audio/apply-engine-command";
import type { EngineCommand } from "../audio/audio-output";
import { createPluginEffect } from "../effect/effect-table";
import { memoryLibraryStorage } from "../preset/library-storage";
import { PresetLibrary, presetTargetOf } from "../preset/preset-library";
import { automatableSettings } from "../project/automation";
import { applyCommands, type Command } from "../project/commands";
import { EngineSync } from "../project/engine-sync";
import { createInstrumentTrack, createProject, type PluginEffect, type Project } from "../project/model";
import { parseProject, serialiseProject } from "../project/serialise";
import { TICKS_PER_BEAT } from "../project/time";
import { installedPlugins, setInstalledPlugins, type InstalledPlugin } from "./plugins";
import { installedTestPlugin } from "./test-plugin";
import { WasmPluginHost } from "./wasm-plugin-runtime";

const BAR = TICKS_PER_BEAT * 4;
/** 120 BPM at 48 kHz. */
const FRAMES_PER_BAR = 96_000;

let testPlugin: InstalledPlugin;

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
  testPlugin = installedTestPlugin();
}, 300_000);

afterEach(() => setInstalledPlugins([]));

function edited(from: Project, ...commands: Command[]): Project {
  const result = applyCommands(from, commands);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

/** One Synth Track holding a chord for two bars, with nothing in its Insert Chain. */
function dry(): Project {
  const track = createInstrumentTrack("Keys", "keys");
  const notes = [48, 55, 64].map((pitch) => ({ pitch, start: 0, length: 2 * BAR, velocity: 0.8 }));
  track.clips.push({ id: "chord", kind: "pattern", start: 0, length: 2 * BAR, notes });
  const project = createProject("Plugins");
  project.tracks.push(track);
  return project;
}

/**
 * `dry` with the test Plugin on its Track, halving it: no smoothing and a
 * width of 1 leave each side as it was, times the gain.
 */
function withPlugin(): Project {
  const before = installedPlugins();
  setInstalledPlugins([testPlugin]);
  const effect = { ...createPluginEffect(testPlugin.manifest, "fx"), settings: { gain: 0.5, smooth: 0, width: 1 } };
  const project = edited(dry(), { type: "addEffect", target: { trackId: "keys" }, effect });
  setInstalledPlugins(before);
  return project;
}

/** An engine, as the worklet has it: its own Plugin host beside it. */
function played() {
  const engine = new Engine(48_000);
  const host = new WasmPluginHost(48_000);
  const sync = new EngineSync();
  return {
    engine,
    update(project: Project) {
      for (const command of sync.update(project) as EngineCommand[]) applyEngineCommand(engine, command, host);
    },
    left(end = 2 * BAR): Float32Array {
      return engine.render_range(0, end).filter((_: number, index: number) => index % 2 === 0);
    },
  };
}

function renderLeft(project: Project): Float32Array {
  const player = played();
  player.update(project);
  const left = player.left();
  player.engine.free();
  return left;
}

describe("a Plugin Effect in a Project", () => {
  test("a Project whose Plugin is missing opens, passes the audio through untouched and keeps its settings; installed, it sounds right", () => {
    const saved = serialiseProject(
      edited(withPlugin(), {
        type: "setAutomation",
        target: { trackId: "keys" },
        setting: "effect:fx:width",
        breakpoints: [{ tick: 0, value: 1, hold: true }],
      }),
    );

    // Opened on a machine without the Plugin.
    const opened = parseProject(saved);
    if (!opened.ok) throw new Error(opened.error);
    expect(serialiseProject(opened.project)).toBe(saved);
    const effect = opened.project.tracks[0]!.insertChain[0] as PluginEffect;
    expect(effect.plugin).toEqual({ id: "dev.soundcheck.test.effect", version: testPlugin.manifest.version });
    expect(effect.settings).toEqual({ gain: 0.5, smooth: 0, width: 1 });

    const player = played();
    player.update(opened.project);
    expect(player.engine.chain_effects(0)).toBe("missing:dev.soundcheck.test.effect");
    const unprocessed = renderLeft(dry());
    expect(player.left()).toEqual(unprocessed);
    expect(unprocessed.some((sample) => sample !== 0)).toBe(true);

    // An edit elsewhere keeps its settings and Automation exactly.
    const renamed = edited(opened.project, { type: "renameTrack", trackId: "keys", name: "Chords" });
    expect(renamed.tracks[0]!.insertChain[0]).toEqual(effect);
    expect(renamed.tracks[0]!.automation).toEqual(opened.project.tracks[0]!.automation);

    // Installed, the same Project and engine bring it in.
    setInstalledPlugins([testPlugin]);
    player.update(opened.project);
    expect(player.engine.chain_effects(0)).toBe("plugin:dev.soundcheck.test.effect");
    // A second render starts with the first's tail still ringing, so the
    // dry Project is rendered twice to match.
    const again = played();
    again.update(dry());
    again.left();
    const expected = again.left();
    again.engine.free();
    const processed = player.left();
    for (let frame = 0; frame < processed.length; frame++) {
      expect(processed[frame]).toBeCloseTo(expected[frame]! * 0.5, 6);
    }
    const fresh = renderLeft(opened.project);
    for (let frame = 0; frame < fresh.length; frame++) {
      expect(fresh[frame]).toBeCloseTo(unprocessed[frame]! * 0.5, 6);
    }
    player.engine.free();
  }, 20_000);

  test("a Plugin's setting is automated as a built-in's is", () => {
    setInstalledPlugins([testPlugin]);
    const project = edited(withPlugin(), {
      type: "setAutomation",
      target: { trackId: "keys" },
      setting: "effect:fx:gain",
      breakpoints: [
        { tick: 0, value: 0.25, hold: true },
        { tick: BAR, value: 1, hold: true },
      ],
    });
    const lane = automatableSettings(project, project.tracks[0]!).find((setting) => setting.setting === "effect:fx:gain");
    expect(lane).toMatchObject({ min: 0, max: 2 });

    const unprocessed = renderLeft(dry());
    const automated = renderLeft(project);
    // Well inside each bar, clear of where the step lands.
    for (const [from, gain] of [
      [1_000, 0.25],
      [FRAMES_PER_BAR + 1_000, 1],
    ] as const) {
      for (let frame = from; frame < from + 4_000; frame++) {
        expect(automated[frame]).toBeCloseTo(unprocessed[frame]! * gain, 6);
      }
    }
  });

  test("a Plugin's settings saved as a User Preset load back into it", async () => {
    setInstalledPlugins([testPlugin]);
    const storage = memoryLibraryStorage();
    const effect = withPlugin().tracks[0]!.insertChain[0]!;
    const target = presetTargetOf(effect);
    expect(target).toBe("plugin:dev.soundcheck.test.effect");
    await new PresetLibrary(storage).save(target, "Half", effect.settings);

    const loaded = await new PresetLibrary(storage).load();
    expect(loaded).toEqual([expect.objectContaining({ name: "Half", target, settings: { gain: 0.5, smooth: 0, width: 1 } })]);

    const fresh = edited(dry(), {
      type: "addEffect",
      target: { trackId: "keys" },
      effect: createPluginEffect(testPlugin.manifest, "fx"),
    });
    const preset = edited(fresh, { type: "setEffectSettings", effectId: "fx", settings: { ...loaded[0]!.settings } });
    expect(preset.tracks[0]!.insertChain[0]!.settings).toEqual(effect.settings);

    // Out of range for the Plugin's manifest: refused, as a built-in's would be.
    await expect(new PresetLibrary(storage).save(target, "Loud", { gain: 3, smooth: 0, width: 1 })).rejects.toThrow(/gain/);
  });
});

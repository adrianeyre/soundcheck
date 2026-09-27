import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { applyEngineCommand } from "../audio/apply-engine-command";
import type { EngineCommand } from "../audio/audio-output";
import { createPluginInstrument } from "../instrument/instrument-table";
import { automatableSettings } from "../project/automation";
import { applyCommands, type Command } from "../project/commands";
import { EngineSync } from "../project/engine-sync";
import { createInstrumentTrack, createProject, type PluginInstrument, type Project } from "../project/model";
import { parseProject, serialiseProject } from "../project/serialise";
import { setInstalledPlugins, type InstalledPlugin } from "./plugins";
import { INSTRUMENT_EXPECTED_OUTPUT as EXPECTED, installedTestInstrument } from "./test-plugin";
import { WasmPluginHost } from "./wasm-plugin-runtime";

const ID = "dev.soundcheck.test.instrument";

let testInstrument: InstalledPlugin;

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
  testInstrument = installedTestInstrument();
}, 300_000);

afterEach(() => setInstalledPlugins([]));

function edited(from: Project, ...commands: Command[]): Project {
  const result = applyCommands(from, commands);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

/** The recipe's song: one Instrument Track playing the test Instrument, with the recipe's Clip and settings. */
function recipeProject(): Project {
  const track = createInstrumentTrack("Keys", "keys");
  track.instrument = { ...createPluginInstrument(testInstrument.manifest), settings: { ...EXPECTED.settings } };
  track.clips.push({ id: "clip", kind: "pattern", ...EXPECTED.clip, notes: EXPECTED.clip.notes.map((note) => ({ ...note })) });
  const project = createProject("Plugin Instrument");
  project.tempo = EXPECTED.tempo;
  project.tracks.push(track);
  return project;
}

/** An engine, as the worklet has it: its own Plugin host beside it. */
function played() {
  const engine = new Engine(EXPECTED.sampleRate);
  const host = new WasmPluginHost(EXPECTED.sampleRate);
  const sync = new EngineSync();
  return {
    engine,
    update(project: Project) {
      for (const command of sync.update(project) as EngineCommand[]) applyEngineCommand(engine, command, host);
    },
    /** Interleaved, as `render_range` gives it. */
    render(end = EXPECTED.ticks): Float32Array {
      return engine.render_range(0, end);
    },
  };
}

function sides(interleaved: Float32Array): [number[], number[]] {
  const left = [...interleaved].filter((_, index) => index % 2 === 0);
  const right = [...interleaved].filter((_, index) => index % 2 === 1);
  return [left, right];
}

describe("a Plugin Instrument in a Project", () => {
  test("the test Instrument plays its Pattern Clip through the browser's WebAssembly sample for sample as expected-output.json has it", () => {
    setInstalledPlugins([testInstrument]);
    const player = played();
    player.update(recipeProject());
    expect(player.engine.track_instrument(0)).toBe(`plugin:${ID}`);
    const [left, right] = sides(player.render());
    player.engine.free();
    expect(left.length).toBe(EXPECTED.left.length);
    // Bit for bit: the JSON holds each f32 as the f64 it widens to exactly.
    expect(left).toEqual(EXPECTED.left);
    expect(right).toEqual(EXPECTED.right);
  });

  test("a Project whose Instrument Plugin is missing opens, is silent and keeps its settings; installed, it sounds right", () => {
    setInstalledPlugins([testInstrument]);
    const saved = serialiseProject(
      edited(recipeProject(), {
        type: "setAutomation",
        target: { trackId: "keys" },
        setting: "instrument:level",
        breakpoints: [
          { tick: 0, value: 0.2, hold: false },
          { tick: 120, value: 1, hold: false },
        ],
      }),
    );
    setInstalledPlugins([]);

    // Opened on a machine without the Plugin.
    const opened = parseProject(saved);
    if (!opened.ok) throw new Error(opened.error);
    expect(serialiseProject(opened.project)).toBe(saved);
    const instrument = opened.project.tracks[0]!.kind === "instrument" && (opened.project.tracks[0]!.instrument as PluginInstrument);
    expect(instrument).toEqual({ type: "plugin", plugin: { id: ID, version: testInstrument.manifest.version }, settings: EXPECTED.settings });
    // Its Automation lane is still there, spanning what it already spans.
    const lane = automatableSettings(opened.project, opened.project.tracks[0]!).find((setting) => setting.setting === "instrument:level");
    expect(lane).toMatchObject({ label: `${ID} (missing): level`, min: 0.2, max: 1 });

    const player = played();
    player.update(opened.project);
    expect(player.engine.track_instrument(0)).toBe(`missing:${ID}`);
    expect(player.render().every((sample) => sample === 0)).toBe(true);

    // An edit elsewhere keeps its settings and Automation exactly.
    const renamed = edited(opened.project, { type: "renameTrack", trackId: "keys", name: "Lead" });
    expect(serialiseProject(renamed)).toBe(serialiseProject({ ...opened.project, tracks: [{ ...opened.project.tracks[0]!, name: "Lead" }] }));

    // Installed, the same Project and engine bring it in, with its settings and Automation.
    setInstalledPlugins([testInstrument]);
    player.update(renamed);
    expect(player.engine.track_instrument(0)).toBe(`plugin:${ID}`);
    const installed = player.render();
    const fresh = played();
    fresh.update(renamed);
    const expected = fresh.render();
    fresh.engine.free();
    player.engine.free();
    expect(installed).toEqual(expected);
    expect(installed.some((sample) => sample !== 0)).toBe(true);
    // The Automation reached it: it isn't the unautomated recipe.
    expect(sides(installed)[0]).not.toEqual(EXPECTED.left);
  });

  test("the Instrument's settings reach it, and swapping it for the Synth takes its Automation with it", () => {
    setInstalledPlugins([testInstrument]);
    const player = played();
    const project = edited(recipeProject(), {
      type: "setAutomation",
      target: { trackId: "keys" },
      setting: "instrument:level",
      breakpoints: [{ tick: 0, value: 1, hold: true }],
    });
    player.update(project);
    const loud = player.render();
    player.update(edited(project, { type: "setInstrumentSettings", trackId: "keys", settings: { width: 0 } }));
    expect([...player.engine.track_instrument_settings(0)]).toEqual([0.75, 2, 20, 0]);
    const [left, right] = sides(player.render());
    // A width of 0 leaves both sides alike.
    expect(left).toEqual(right);
    expect(sides(loud)[0]).not.toEqual(EXPECTED.left);

    const synth = edited(project, { type: "setInstrument", trackId: "keys", instrument: createInstrumentTrack("x").instrument });
    expect(synth.tracks[0]!.automation).toEqual([]);
    player.update(synth);
    expect(player.engine.track_instrument(0)).toBe("synth");
    player.engine.free();
  });
});

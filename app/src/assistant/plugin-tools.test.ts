import { afterEach, expect, test } from "vitest";

import { applyCommands } from "../project/commands";
import { sampleProject } from "../project/fixtures";
import type { PluginEffect, PluginInstrument, Project } from "../project/model";
import { setInstalledPlugins, type InstalledPlugin } from "../plugin/plugins";
import type { UserPreset } from "../preset/preset-library";
import { requestMessage } from "./context";
import { channelDetail, projectSummary } from "./read";
import { planToolCall } from "./tools";

afterEach(() => setInstalledPlugins([]));

const DRIVE: InstalledPlugin = {
  manifest: {
    id: "dev.example.drive",
    version: "1.0.0",
    kind: "effect",
    name: "Drive",
    settings: [
      { name: "amount", label: "Amount", unit: "", min: 0, max: 1, default: 0.25, step: 0, choices: [] },
      { name: "tone", label: "Tone", unit: "Hz", min: 200, max: 8000, default: 2000, step: 0, choices: [] },
    ],
  },
  wasm: new Uint8Array(),
};

const DRIVE_EFFECT: PluginEffect = {
  id: "drive",
  type: "plugin",
  bypassed: false,
  plugin: { id: "dev.example.drive", version: "1.0.0" },
  settings: { amount: 0.6, tone: 3000 },
};

function plan(name: string, input: unknown, project: Project, userPresets: readonly UserPreset[] = []) {
  return planToolCall({ id: "call-1", name, input }, project, { userPresets, savedKits: [], sampleFolders: null, audioFiles: [] });
}

function planned(name: string, input: unknown, project: Project, userPresets: readonly UserPreset[] = []) {
  const result = applyCommands(project, plan(name, input, project, userPresets).commands);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

function withDrive(): Project {
  const project = sampleProject();
  project.master.insertChain = [DRIVE_EFFECT];
  return project;
}

test("the Assistant adds an installed Plugin Effect and changes its settings, within the ranges its manifest declares", () => {
  setInstalledPlugins([DRIVE]);
  const added = planned("add_effect", { channel: "master", effect: "plugin:dev.example.drive", settings: { tone: 500 } }, sampleProject());
  const effect = added.master.insertChain.at(-1)!;
  expect(effect).toMatchObject({ type: "plugin", plugin: { id: "dev.example.drive", version: "1.0.0" }, settings: { amount: 0.25, tone: 500 } });
  expect(plan("add_effect", { channel: "master", effect: "plugin:dev.example.drive" }, sampleProject()).change).toBe(
    "Added a Drive to the Master",
  );

  const changed = planned("set_effect_settings", { effectId: "drive", settings: { amount: 0.9 } }, withDrive());
  expect(changed.master.insertChain[0]!.settings).toEqual({ amount: 0.9, tone: 3000 });
  expect(() => plan("set_effect_settings", { effectId: "drive", settings: { amount: 2 } }, withDrive())).toThrow(
    "The Drive's amount must be a number from 0 to 1",
  );
  expect(() => plan("set_effect_settings", { effectId: "drive", settings: { fuzz: 1 } }, withDrive())).toThrow(
    "The Drive has no setting called fuzz. Its settings are: amount, tone.",
  );
  expect(() => plan("add_effect", { channel: "master", effect: "plugin:dev.example.fuzz" }, sampleProject())).toThrow(
    "There is no installed Plugin dev.example.fuzz",
  );
});

test("the Assistant loads a User Preset into a Plugin Effect", () => {
  setInstalledPlugins([DRIVE]);
  const preset: UserPreset = { id: "p", name: "Crunch", target: "plugin:dev.example.drive", settings: { amount: 1, tone: 800 } };
  const loaded = planned("load_preset", { effectId: "drive", preset: "Crunch" }, withDrive(), [preset]);
  expect(loaded.master.insertChain[0]!.settings).toEqual({ amount: 1, tone: 800 });
});

test("the Assistant is told a Plugin is missing, and can't change its settings", () => {
  const project = withDrive();
  expect(projectSummary(project).master.insertChain).toEqual([{ effectId: "drive", effect: "plugin", name: "dev.example.drive", missing: true }]);
  expect(channelDetail(project, "master").insertChain).toEqual([
    {
      effectId: "drive",
      effect: "plugin",
      name: "dev.example.drive",
      plugin: "dev.example.drive",
      version: "1.0.0",
      missing: true,
      bypassed: false,
      settings: { amount: 0.6, tone: 3000 },
    },
  ]);
  expect(() => plan("set_effect_settings", { effectId: "drive", settings: { amount: 0.9 } }, project)).toThrow(
    "Effect drive is the Plugin dev.example.drive 1.0.0, which isn't installed",
  );
  // It can still be moved, bypassed or taken out.
  expect(planned("remove_effect", { effectId: "drive" }, project).master.insertChain).toEqual([]);

  setInstalledPlugins([DRIVE]);
  expect(projectSummary(project).master.insertChain[0]).not.toHaveProperty("missing");
  expect(projectSummary(project).master.insertChain[0]).toMatchObject({ name: "Drive" });
  expect(channelDetail(project, "master").insertChain[0]).toMatchObject({ name: "Drive", plugin: "dev.example.drive" });
  const message = requestMessage("Add some drive", project);
  expect(message).toContain("The installed Plugins, which add_effect adds by effect and set_instrument sets by instrument:");
  expect(message).toContain('"effect":"plugin:dev.example.drive"');
});

const KEYS: InstalledPlugin = {
  manifest: {
    id: "dev.example.keys",
    version: "0.2.0",
    kind: "instrument",
    name: "Keys",
    settings: [
      { name: "level", label: "Level", unit: "", min: 0, max: 1, default: 0.5, step: 0, choices: [] },
      { name: "attack", label: "Attack", unit: "ms", min: 0, max: 100, default: 5, step: 0, choices: [] },
    ],
  },
  wasm: new Uint8Array(),
};

const KEYS_INSTRUMENT: PluginInstrument = { type: "plugin", plugin: { id: "dev.example.keys", version: "0.2.0" }, settings: { level: 0.7, attack: 20 } };

function withKeys(): Project {
  const project = sampleProject();
  const track = project.tracks[0]!;
  if (track.kind !== "instrument") throw new Error("the sample's first Track plays an Instrument");
  track.instrument = structuredClone(KEYS_INSTRUMENT);
  return project;
}

test("the Assistant sets an installed Plugin Instrument and changes its settings, within the ranges its manifest declares", () => {
  setInstalledPlugins([DRIVE, KEYS]);
  const set = planned("set_instrument", { trackId: "keys", instrument: "plugin:dev.example.keys", settings: { attack: 40 } }, sampleProject());
  expect(set.tracks[0]).toMatchObject({ instrument: { type: "plugin", plugin: { id: "dev.example.keys", version: "0.2.0" }, settings: { level: 0.5, attack: 40 } } });
  expect(plan("set_instrument", { trackId: "keys", instrument: "plugin:dev.example.keys" }, sampleProject()).change).toBe("“Keys” plays the Keys");

  const changed = planned("set_instrument_settings", { trackId: "keys", settings: { level: 0.9 } }, withKeys());
  expect(changed.tracks[0]).toMatchObject({ instrument: { settings: { level: 0.9, attack: 20 } } });
  expect(() => plan("set_instrument_settings", { trackId: "keys", settings: { level: 2 } }, withKeys())).toThrow(
    "The Keys's level must be a number from 0 to 1",
  );
  expect(() => plan("set_instrument_settings", { trackId: "keys", settings: { level: 0.5 } }, sampleProject())).toThrow(
    "not a Plugin Instrument",
  );
  // An Effect Plugin isn't an Instrument, and a missing one can't be set.
  expect(() => plan("set_instrument", { trackId: "keys", instrument: "plugin:dev.example.drive" }, sampleProject())).toThrow(
    "There is no installed Plugin Instrument dev.example.drive",
  );
  expect(() => plan("add_effect", { channel: "master", effect: "plugin:dev.example.keys" }, sampleProject())).toThrow(
    "There is no installed Plugin dev.example.keys",
  );

  const message = requestMessage("Play it on the keys", sampleProject());
  expect(message).toContain('"instrument":"plugin:dev.example.keys"');
});

test("the Assistant is told a Plugin Instrument is missing, and can't change its settings", () => {
  const project = withKeys();
  expect(projectSummary(project).tracks[0]).toMatchObject({ instrument: "plugin", name: "dev.example.keys", plugin: "dev.example.keys", missing: true });
  expect(projectSummary(project).tracks[0]).not.toHaveProperty("settings");
  expect(channelDetail(project, project.tracks[0]!)).toMatchObject({
    instrument: "plugin",
    name: "dev.example.keys",
    plugin: "dev.example.keys",
    version: "0.2.0",
    missing: true,
    settings: { level: 0.7, attack: 20 },
  });
  expect(() => plan("set_instrument_settings", { trackId: "keys", settings: { level: 0.9 } }, project)).toThrow(
    "Track keys plays the Plugin dev.example.keys 0.2.0, which isn't installed: it is silent",
  );
  // It can still be swapped for another Instrument.
  expect(planned("set_instrument", { trackId: "keys", instrument: "synth" }, project).tracks[0]).toMatchObject({ instrument: { type: "synth" } });

  setInstalledPlugins([KEYS]);
  expect(projectSummary(project).tracks[0]).not.toHaveProperty("missing");
  expect(projectSummary(project).tracks[0]).toMatchObject({ name: "Keys" });
});

const SOFT: UserPreset = { id: "p", name: "Soft", target: "plugin:dev.example.keys", settings: { level: 0.3, attack: 80 } };

test("the Assistant saves a Plugin Instrument's settings as a User Preset", () => {
  setInstalledPlugins([KEYS]);
  const saved = plan("save_preset", { source: "keys", name: "Bright" }, withKeys());
  expect(saved.commands).toEqual([]);
  expect(saved.save).toEqual({ preset: { target: "plugin:dev.example.keys", name: "Bright", settings: { level: 0.7, attack: 20 } } });
  expect(saved.report).toContain("the Keys User Preset “Bright”");
  expect(saved.report).toContain("load_preset and set_instrument load it");

  // One whose Plugin is missing keeps its settings, and they can't be saved.
  setInstalledPlugins([]);
  expect(() => plan("save_preset", { source: "keys", name: "Bright" }, withKeys())).toThrow("which isn't installed");
});

test("the Assistant loads a User Preset into a Plugin Instrument, and sets one from it", () => {
  setInstalledPlugins([KEYS]);
  const loaded = plan("load_preset", { trackId: "keys", preset: "soft" }, withKeys(), [SOFT]);
  expect(loaded.commands).toEqual([{ type: "setInstrumentSettings", trackId: "keys", settings: { level: 0.3, attack: 80 } }]);
  expect(loaded.change).toBe("Loaded the “Soft” User Preset into the Keys on “Keys”");
  expect(() => plan("load_preset", { trackId: "keys", preset: "Loud" }, withKeys(), [SOFT])).toThrow(
    'The Keys has no preset called "Loud". Its presets are: Soft.',
  );

  const set = planned("set_instrument", { trackId: "keys", instrument: "plugin:dev.example.keys", preset: "Soft", settings: { level: 0.4 } }, sampleProject(), [SOFT]);
  expect(set.tracks[0]).toMatchObject({ instrument: { type: "plugin", settings: { level: 0.4, attack: 80 } } });

  const message = requestMessage("Load my soft keys", withKeys(), { userPresets: [SOFT], savedKits: [], sampleFolders: null, audioFiles: [] });
  expect(message).toContain('{"name":"Soft","for":"plugin:dev.example.keys"}');

  setInstalledPlugins([]);
  expect(() => plan("load_preset", { trackId: "keys", preset: "Soft" }, withKeys(), [SOFT])).toThrow("which isn't installed");
});

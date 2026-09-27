import { afterEach, expect, test } from "vitest";

import { createPluginEffect } from "../effect/effect-table";
import { createPluginInstrument } from "../instrument/instrument-table";
import { KEYS, TILT, tiltManifest } from "../plugin/fake-vst3-host";
import { resetVst3, setVst3Instance, vst3InstrumentKey, vst3Manifest, vst3PluginId } from "../plugin/vst3";
import { applyCommands } from "../project/commands";
import { sampleProject } from "../project/fixtures";
import type { InstrumentTrack, PluginEffect, Project } from "../project/model";
import { SYSTEM_PROMPT } from "./context";
import { channelDetail } from "./read";
import { planToolCall } from "./tools";

afterEach(resetVst3);

function plan(name: string, input: unknown, project: Project) {
  return planToolCall({ id: "call-1", name, input }, project, { userPresets: [], savedKits: [], sampleFolders: null, audioFiles: [] });
}

function planned(name: string, input: unknown, project: Project) {
  const result = applyCommands(project, plan(name, input, project).commands);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

/** The sample Project with a Tilt on the Master, saved with its state. */
function withTilt(): Project {
  const project = sampleProject();
  const tilt = createPluginEffect(tiltManifest(), "tilt") as PluginEffect;
  project.master.insertChain = [{ ...tilt, settings: { p0: 0.25, p7: 1 }, vst3: { ...tilt.vst3!, state: { component: "c3RhdGU=", controller: "" } } }];
  return project;
}

function running() {
  setVst3Instance("tilt", {
    status: "ready",
    pluginId: vst3PluginId(TILT.cid),
    generation: 1,
    manifest: tiltManifest(),
    editor: null,
    open: false,
  });
}

test("read_channel gives a running VST3 Effect's exposed settings, by label, unit and step", () => {
  running();
  const [effect] = channelDetail(withTilt(), "master").insertChain as unknown as Record<string, unknown>[];
  expect(effect).toMatchObject({
    name: "Tilt",
    plugin: "vst3.0123456789abcdef0123456789abcdef",
    vendor: "Tilters",
    exposed: [
      { name: "p0", label: "Tilt", unit: "dB" },
      { name: "p7", label: "Mode", step: 0.5 },
    ],
    settings: { p0: 0.25, p7: 1 },
  });
  // Its state is the Plugin's own, not the Assistant's to read.
  expect(JSON.stringify(effect)).not.toContain("c3RhdGU=");
});

test("the Assistant changes and automates only the settings a VST3 Plugin exposes, from 0 to 1, and keeps its state", () => {
  running();
  const changed = planned("set_effect_settings", { effectId: "tilt", settings: { p0: 0.75 } }, withTilt());
  const effect = changed.master.insertChain[0] as PluginEffect;
  expect(effect.settings).toEqual({ p0: 0.75, p7: 1 });
  expect(effect.vst3?.state).toEqual({ component: "c3RhdGU=", controller: "" });
  expect(() => plan("set_effect_settings", { effectId: "tilt", settings: { p0: 1.5 } }, withTilt())).toThrow(
    "The Tilt's p0 must be a number from 0 to 1",
  );
  expect(() => plan("set_effect_settings", { effectId: "tilt", settings: { p7: 0.25 } }, withTilt())).toThrow("The Tilt's p7 must be");
  expect(() => plan("set_effect_settings", { effectId: "tilt", settings: { p3: 0.5 } }, withTilt())).toThrow(
    "The Tilt has no setting called p3. Its settings are: p0, p7.",
  );
});

test("one that isn't running is missing: its settings can't be changed until it is, and the Assistant is told why", () => {
  expect(channelDetail(withTilt(), "master").insertChain[0]).toMatchObject({ missing: true });
  expect(() => plan("set_effect_settings", { effectId: "tilt", settings: { p0: 0.75 } }, withTilt())).toThrow(
    "Effect tilt is the VST3 Plugin Tilt (Tilters), which isn't running here",
  );
});

test("a VST3 Instrument's exposed settings are changed as a Plugin Instrument's are", () => {
  const settings = [{ id: 3, name: "p3", label: "Bright", unit: "", default: 0.2, steps: 0, value: 0.2 }];
  const manifest = vst3Manifest(KEYS, { kind: "instrument", settings });
  const project = sampleProject();
  const track = project.tracks.find((candidate): candidate is InstrumentTrack => candidate.kind === "instrument")!;
  track.instrument = createPluginInstrument(manifest);
  expect(() => plan("set_instrument_settings", { trackId: track.id, settings: { p3: 0.5 } }, project)).toThrow(
    `Track ${track.id} plays the VST3 Plugin Keys (Keymakers), which isn't running here`,
  );
  setVst3Instance(vst3InstrumentKey(track.id), {
    status: "ready",
    pluginId: vst3PluginId(KEYS.cid),
    generation: 1,
    manifest,
    editor: null,
    open: false,
  });
  const changed = planned("set_instrument_settings", { trackId: track.id, settings: { p3: 0.5 } }, project);
  const instrument = (changed.tracks.find((candidate) => candidate.id === track.id) as InstrumentTrack).instrument;
  expect(instrument.type === "plugin" && instrument.settings).toEqual({ p3: 0.5 });
});

test("only the musician adds a VST3 Plugin, and the Assistant is told so", () => {
  running();
  const tilt = `plugin:${vst3PluginId(TILT.cid)}`;
  expect(() => plan("add_effect", { channel: "master", effect: tilt }, sampleProject())).toThrow(
    "A VST3 Plugin is added by the musician",
  );
  const track = sampleProject().tracks.find((candidate) => candidate.kind === "instrument")!;
  expect(() => plan("set_instrument", { trackId: track.id, instrument: `plugin:${vst3PluginId(KEYS.cid)}` }, sampleProject())).toThrow(
    "A VST3 Plugin is added by the musician",
  );
  expect(SYSTEM_PROMPT).toMatch(/VST3 Plugin.*exposes/);
});

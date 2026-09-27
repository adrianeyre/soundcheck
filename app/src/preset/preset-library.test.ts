import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";

import type { Invoke } from "../audio/desktop-audio-output";
import { defaultEffectSettings } from "../effect/effect-params";
import { applyCommand, applyCommands } from "../project/commands";
import { createEffect, createInstrumentTrack, createProject, DEFAULT_SYNTH, type Project } from "../project/model";
import { browserLibraryStorage } from "./browser-library-storage";
import { desktopLibraryStorage } from "./desktop-library-storage";
import { filesUnder, memoryLibraryStorage, type LibraryStorage } from "./library-storage";
import { findPreset, PresetLibrary, PresetRefused, presetsFor, synthPresetCommand } from "./preset-library";

/**
 * The desktop's library as the Tauri shell keeps it (`desktop/src/library.rs`),
 * a folder of files, stood in for by a map behind the same commands.
 */
function desktopStorage(): LibraryStorage {
  const files = new Map<string, string>();
  const invoke = (async (command: string, args: Record<string, unknown> = {}) => {
    const path = args.path as string;
    if (command === "library_list_files") return filesUnder(files.keys(), path);
    if (command === "library_read_text") {
      if (!files.has(path)) throw new Error(`${path} could not be read`);
      return files.get(path);
    }
    if (command === "library_write_text") return void files.set(path, args.text as string);
    if (command === "library_delete_file") return void files.delete(path);
    throw new Error(`no command ${command}`);
  }) as Invoke;
  return desktopLibraryStorage(invoke);
}

const STORAGES: [string, () => LibraryStorage][] = [
  ["desktop", desktopStorage],
  ["browser dev host", () => browserLibraryStorage(new IDBFactory())],
  ["memory", () => memoryLibraryStorage()],
];

/** A Project with one Synth Track, `keys`, and a Reverb on it, `verb`. */
function projectWithSynth(name: string): Project {
  const project = createProject(name);
  const track = createInstrumentTrack("Keys", "keys");
  const result = applyCommands(project, [
    { type: "addTrack", track },
    { type: "addEffect", target: { trackId: "keys" }, effect: { ...createEffect("reverb"), id: "verb" } },
  ]);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

function synthOf(project: Project) {
  const track = project.tracks[0]!;
  if (track.kind !== "instrument" || track.instrument.type !== "synth") throw new Error("no Synth");
  return track.instrument;
}

describe.each(STORAGES)("on the %s", (_, storage) => {
  test("a User Preset saved in one Project loads into another", async () => {
    const at = storage();
    // Tweak a Synth and a Reverb in the first Project, and save both.
    const first = applyCommands(projectWithSynth("First"), [
      { type: "setSynthSettings", trackId: "keys", settings: { cutoffHz: 1234, osc1Wave: "square" } },
      { type: "setEffectSettings", effectId: "verb", settings: { size: 0.9, mix: 0.5 } },
    ]);
    if (!first.ok) throw new Error(first.error);
    const saving = new PresetLibrary(at);
    await saving.load();
    await saving.save("synth", "My Square", synthOf(first.project).settings);
    const reverb = first.project.tracks[0]!.insertChain[0]!;
    await saving.save("reverb", "Big Room", reverb.settings);

    // Another session of the app, with another Project, reads the library afresh.
    const loading = new PresetLibrary(at);
    const presets = await loading.load();
    expect(presets.map((preset) => preset.name).toSorted()).toEqual(["Big Room", "My Square"]);

    const second = projectWithSynth("Second");
    const synthPreset = findPreset("synth", "My Square", presets)!;
    const reverbPreset = findPreset("reverb", "Big Room", presets)!;
    const loaded = applyCommands(second, [
      synthPresetCommand("keys", synthPreset),
      { type: "setEffectSettings", effectId: "verb", settings: { ...reverbPreset.settings } },
    ]);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(synthOf(loaded.project)).toEqual({ ...synthOf(first.project), preset: "My Square" });
    expect(loaded.project.tracks[0]!.insertChain[0]!.settings).toEqual(reverb.settings);
  });

  test("a User Preset is renamed and deleted, and stays that way", async () => {
    const at = storage();
    const library = new PresetLibrary(at);
    await library.load();
    await library.save("delay", "Tape", { ...defaultEffectSettings("delay"), feedback: 0.6 });
    await library.rename("delay", "Tape", "Old Tape");
    expect((await new PresetLibrary(at).load()).map((preset) => preset.name)).toEqual(["Old Tape"]);
    await library.delete("delay", "Old Tape");
    expect(library.userPresets).toEqual([]);
    expect(await new PresetLibrary(at).load()).toEqual([]);
  });
});

test("Factory Presets can't be renamed, deleted or saved over", async () => {
  const library = new PresetLibrary(memoryLibraryStorage());
  await library.load();
  await expect(library.rename("synth", "Sub Bass", "Mine")).rejects.toThrow("Factory Preset");
  await expect(library.delete("delay", "Slapback")).rejects.toThrow("Factory Preset");
  await expect(library.save("delay", "slapback", defaultEffectSettings("delay"))).rejects.toThrow(PresetRefused);
  expect(presetsFor("delay", []).map((preset) => preset.name)).toEqual([
    "Slapback",
    "Quarter echo",
    "Dotted-eighth ping-pong",
  ]);
});

test("a name is unique among a Synth's or an Effect's Presets, and must not be blank", async () => {
  const library = new PresetLibrary(memoryLibraryStorage());
  await library.save("synth", "  Glassy  ", DEFAULT_SYNTH);
  expect(library.userPresets[0]!.name).toBe("Glassy");
  await expect(library.save("synth", "glassy", DEFAULT_SYNTH)).rejects.toThrow("already has a Preset");
  await expect(library.save("synth", "   ", DEFAULT_SYNTH)).rejects.toThrow("1 to 200 characters");
  await library.save("synth", "Other", DEFAULT_SYNTH);
  await expect(library.rename("synth", "Other", "GLASSY")).rejects.toThrow("already has a Preset");
  // Another Effect may use the same name.
  await library.save("eq", "Glassy", defaultEffectSettings("eq"));
  expect(library.userPresets).toHaveLength(3);
});

test("settings that break the rules are not saved", async () => {
  const library = new PresetLibrary(memoryLibraryStorage());
  await expect(library.save("synth", "Broken", { ...DEFAULT_SYNTH, cutoffHz: -1 })).rejects.toThrow("cutoffHz");
  expect(library.userPresets).toEqual([]);
});

test("Factory and User Presets are listed together, marked, the User ones by name", async () => {
  const library = new PresetLibrary(memoryLibraryStorage());
  await library.save("delay", "Zed", defaultEffectSettings("delay"));
  await library.save("delay", "Alpha", defaultEffectSettings("delay"));
  await library.save("synth", "Not a Delay", DEFAULT_SYNTH);
  const listed = presetsFor("delay", library.userPresets);
  expect(listed.map((preset) => `${preset.source}:${preset.name}`)).toEqual([
    "factory:Slapback",
    "factory:Quarter echo",
    "factory:Dotted-eighth ping-pong",
    "user:Alpha",
    "user:Zed",
  ]);
  expect(findPreset("delay", "alpha", library.userPresets)?.name).toBe("Alpha");
});

test("a damaged file is left out, and an older Preset takes defaults for settings it lacks", async () => {
  const files = new Map([
    ["presets/bad.json", "{ not json"],
    ["presets/wrong.json", JSON.stringify({ version: 1, name: "Loud", target: "eq", settings: { lowShelfGainDb: 99 } })],
    ["presets/old.json", JSON.stringify({ version: 1, name: "Old", target: "reverb", settings: { mix: 0.7, gone: 1 } })],
  ]);
  const presets = await new PresetLibrary(memoryLibraryStorage(files)).load();
  expect(presets).toEqual([
    { id: "old", name: "Old", target: "reverb", settings: { ...defaultEffectSettings("reverb"), mix: 0.7 } },
  ]);
});

test("loading a User Preset is one undo step that a Project refuses if its settings are broken", () => {
  const project = projectWithSynth("Song");
  const broken = synthPresetCommand("keys", {
    name: "Broken",
    source: "user",
    settings: { ...DEFAULT_SYNTH, level: 9 },
  });
  expect(applyCommand(project, broken).ok).toBe(false);
});

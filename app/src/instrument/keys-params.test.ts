import { readFileSync } from "node:fs";

import { initSync, keys_parameters, keys_presets } from "@engine";
import { beforeAll, expect, test } from "vitest";

import { defaultKeysSettings, KEYS_PARAMS, keysSettingsFromFlat, keysSettingsToFlat, noteName } from "./keys-params";
import { KEYS_CATEGORIES, KEYS_PRESETS, keysPreset, keysPresetNames } from "./keys-presets";

// The real WASM build: these tables mirror the engine's, and this proves they still match.
beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

test("the settings table is the engine's, setting for setting", () => {
  expect(JSON.parse(keys_parameters())).toEqual(KEYS_PARAMS.map((param) => ({ ...param, choices: [...param.choices] })));
});

test("the defaults round-trip through the flat form, the source named", () => {
  const settings = defaultKeysSettings();
  expect(settings.source).toBe("piano");
  expect(keysSettingsToFlat(settings)).toEqual(KEYS_PARAMS.map((param) => param.default));
  expect(keysSettingsFromFlat([1]).source).toBe("sample");
  expect(keysSettingsFromFlat([0, 9]).brightness).toBe(1);
});

test("there are at least 30 factory presets, the engine's, in four categories", () => {
  const fromEngine = JSON.parse(keys_presets()) as { name: string; category: string; description: string; settings: Record<string, number> }[];
  expect(KEYS_PRESETS.length).toBeGreaterThanOrEqual(30);
  expect(fromEngine.map((each) => each.name)).toEqual(keysPresetNames());
  for (const each of fromEngine) {
    const mine = keysPreset(each.name)!;
    expect(mine.category).toBe(each.category);
    expect(mine.description).toBe(each.description);
    const flat = keysSettingsToFlat(mine.settings);
    KEYS_PARAMS.forEach((param, index) => expect(flat[index]).toBeCloseTo(each.settings[param.name]!, 4));
  }
  expect(new Set(KEYS_PRESETS.map((each) => each.category))).toEqual(new Set(KEYS_CATEGORIES.map((each) => each.id)));
});

test("notes are named as the root note picker shows them", () => {
  expect(noteName(60)).toBe("C4");
  expect(noteName(61)).toBe("C#4");
  expect(noteName(21)).toBe("A0");
});

import { readFileSync } from "node:fs";

import { initSync, synth_parameters, synth_presets } from "@engine";
import { beforeAll, describe, expect, test } from "vitest";

import {
  clampSynthValue,
  defaultSynthSettings,
  SYNTH_PARAMS,
  synthParam,
  synthSettingsFromFlat,
  synthSettingsToFlat,
} from "./synth-params";
import { SYNTH_PRESETS, synthPreset, synthPresetNames } from "./synth-presets";

// The real WASM build: these tables are a mirror of the engine's, and this is
// what proves they still match it.
beforeAll(() => {
  initSync({
    module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)),
  });
});

describe("the settings table", () => {
  test("is the engine's, setting for setting", () => {
    expect(JSON.parse(synth_parameters())).toEqual(
      SYNTH_PARAMS.map((param) => ({ ...param, choices: [...param.choices] })),
    );
  });

  test("declares every setting once, with a default in range", () => {
    const names = SYNTH_PARAMS.map((param) => param.name);
    expect(new Set(names).size).toBe(names.length);
    for (const param of SYNTH_PARAMS) {
      expect(param.default).toBeGreaterThanOrEqual(param.min);
      expect(param.default).toBeLessThanOrEqual(param.max);
      expect(param.label.length).toBeGreaterThan(0);
    }
    expect(synthParam("cutoffHz")?.unit).toBe("Hz");
    expect(synthParam("nonsense")).toBeUndefined();
  });

  test("names the choices a setting offers", () => {
    expect(synthParam("osc1Wave")?.choices).toEqual(["saw", "square", "triangle", "sine"]);
    expect(synthParam("filterType")?.choices).toEqual(["lowPass", "highPass", "bandPass"]);
    expect(synthParam("lfoTarget")?.choices).toEqual(["off", "pitch", "filter", "amp"]);
  });
});

describe("settings", () => {
  test("the defaults are the table's defaults, named where they are choices", () => {
    const settings = defaultSynthSettings();
    expect(settings.osc1Wave).toBe("saw");
    expect(settings.filterType).toBe("lowPass");
    expect(settings.lfoTarget).toBe("off");
    expect(settings.cutoffHz).toBe(2400);
    expect(synthSettingsToFlat(settings)).toEqual(SYNTH_PARAMS.map((param) => param.default));
  });

  test("round-trip through the engine's flat form", () => {
    const settings = { ...defaultSynthSettings(), osc2Wave: "sine" as const, cutoffHz: 880 };
    expect(synthSettingsFromFlat(synthSettingsToFlat(settings))).toEqual(settings);
  });

  test("values out of range, off the step or missing take what the table allows", () => {
    const cutoff = synthParam("cutoffHz")!;
    expect(clampSynthValue(cutoff, 40_000)).toBe(20_000);
    expect(clampSynthValue(cutoff, 1)).toBe(20);
    expect(clampSynthValue(cutoff, Number.NaN)).toBe(cutoff.default);
    expect(clampSynthValue(synthParam("voices")!, 4.4)).toBe(4);
    expect(synthSettingsFromFlat([])).toEqual(defaultSynthSettings());
  });
});

describe("the factory presets", () => {
  test("are the engine's, preset for preset", () => {
    const fromEngine = JSON.parse(synth_presets()) as {
      name: string;
      category: string;
      description: string;
      settings: Record<string, number>;
    }[];
    expect(fromEngine.map((preset) => preset.name)).toEqual(synthPresetNames());
    for (const preset of fromEngine) {
      const mine = synthPreset(preset.name)!;
      expect(mine.category).toBe(preset.category);
      expect(mine.description).toBe(preset.description);
      expect(synthSettingsToFlat(mine.settings)).toEqual(
        SYNTH_PARAMS.map((param) => preset.settings[param.name]),
      );
    }
  });

  test("cover bass, lead, pad, pluck and keys, about ten of them", () => {
    expect(SYNTH_PRESETS.length).toBeGreaterThanOrEqual(10);
    const categories = new Set(SYNTH_PRESETS.map((preset) => preset.category));
    expect([...categories].toSorted()).toEqual(["bass", "keys", "lead", "pad", "pluck"]);
    expect(new Set(synthPresetNames()).size).toBe(SYNTH_PRESETS.length);
    expect(synthPreset("Nothing like this")).toBeUndefined();
  });
});

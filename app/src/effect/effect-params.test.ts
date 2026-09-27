import { readFileSync } from "node:fs";

import { effect_parameters, eq_response, initSync } from "@engine";
import { beforeAll, describe, expect, test } from "vitest";

import {
  clampEffectValue,
  defaultEffectSettings,
  EFFECT_PARAMS,
  EFFECT_TYPES,
  effectParam,
  effectParams,
  effectSettingsFromFlat,
  effectSettingsToFlat,
  eqResponseDb,
  type EqSettings,
} from "./effect-params";

// The real WASM build: these tables are a mirror of the engine's, and this is
// what proves they still match it.
beforeAll(() => {
  initSync({
    module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)),
  });
});

describe("the settings tables", () => {
  test("are the engine's, Effect for Effect and setting for setting", () => {
    const mine = Object.fromEntries(
      EFFECT_TYPES.map((type) => [type, effectParams(type).map((param) => ({ ...param, choices: [...param.choices] }))]),
    );
    expect(JSON.parse(effect_parameters())).toEqual(mine);
    expect(Object.keys(EFFECT_PARAMS).toSorted()).toEqual([...EFFECT_TYPES].toSorted());
  });

  test("declare every setting once, with a default in range", () => {
    for (const type of EFFECT_TYPES) {
      const names = effectParams(type).map((param) => param.name);
      expect(new Set(names).size).toBe(names.length);
      for (const param of effectParams(type)) {
        expect(param.default).toBeGreaterThanOrEqual(param.min);
        expect(param.default).toBeLessThanOrEqual(param.max);
        expect(param.label.length).toBeGreaterThan(0);
      }
    }
    expect(effectParam("eq", "band3Q")?.unit).toBe("Q");
    expect(effectParam("eq", "nonsense")).toBeUndefined();
  });
});

describe("settings", () => {
  test("the defaults are the table's, and a new EQ changes nothing", () => {
    const eq = defaultEffectSettings("eq");
    expect(eq.lowCut).toBe("off");
    expect(eq.band2Hz).toBe(1000);
    expect(effectSettingsToFlat("eq", eq)).toEqual(effectParams("eq").map((param) => param.default));
    expect(defaultEffectSettings("compressor").ratio).toBe(4);
    expect(defaultEffectSettings("reverb").mix).toBe(0.25);
    for (const frequency of [20, 100, 1000, 10_000, 20_000]) {
      expect(Math.abs(eqResponseDb(eq, frequency))).toBeLessThan(1e-9);
    }
  });

  test("round-trip through the engine's flat form", () => {
    const eq: EqSettings = { ...defaultEffectSettings("eq"), highCut: "on", band1GainDb: -6 };
    expect(effectSettingsFromFlat("eq", effectSettingsToFlat("eq", eq))).toEqual(eq);
  });

  test("values out of range, off the step or missing take what the table allows", () => {
    const ratio = effectParam("compressor", "ratio")!;
    expect(clampEffectValue(ratio, 99)).toBe(20);
    expect(clampEffectValue(ratio, 0)).toBe(1);
    expect(clampEffectValue(ratio, Number.NaN)).toBe(4);
    expect(clampEffectValue(effectParam("eq", "lowCut")!, 0.7)).toBe(1);
    expect(effectSettingsFromFlat("reverb", [])).toEqual(defaultEffectSettings("reverb"));
  });
});

describe("the EQ's curve", () => {
  test("is the engine's, for every band at once", () => {
    const eq: EqSettings = {
      lowCut: "on",
      lowCutHz: 40,
      lowShelfHz: 120,
      lowShelfGainDb: 4,
      band1Hz: 300,
      band1Q: 2,
      band1GainDb: -6,
      band2Hz: 1200,
      band2Q: 0.7,
      band2GainDb: 3,
      band3Hz: 3500,
      band3Q: 8,
      band3GainDb: 9,
      highShelfHz: 9000,
      highShelfGainDb: -5,
      highCut: "on",
      highCutHz: 15_000,
    };
    const frequencies = Array.from({ length: 60 }, (_, index) => 20 * 2 ** (index / 6));
    const engine = eq_response(new Float32Array(effectSettingsToFlat("eq", eq)), new Float32Array(frequencies), 48_000);
    frequencies.forEach((frequency, index) => {
      expect(eqResponseDb(eq, frequency, 48_000)).toBeCloseTo(engine[index]!, 1);
    });
  });

  test("a bell boosts by its gain at its frequency", () => {
    const eq = { ...defaultEffectSettings("eq"), band2GainDb: 6 };
    expect(eqResponseDb(eq, 1000)).toBeCloseTo(6, 3);
    expect(Math.abs(eqResponseDb(eq, 20))).toBeLessThan(0.1);
  });
});

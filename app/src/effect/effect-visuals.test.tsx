// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { createEffect, type EffectType } from "../project/model";
import { defaultEffectSettings, EFFECT_TYPES } from "./effect-params";
import {
  compressorOutputDb,
  crushed,
  EffectVisual,
  filterResponseDb,
  gateOutputDb,
  limiterOutputDb,
  saturate,
  saturatorTransfer,
  utilityMatrix,
} from "./effect-visuals";

afterEach(cleanup);

test("the Compressor's curve follows its ratio above the knee, plus makeup", () => {
  const settings = { thresholdDb: -20, ratio: 4, attack: 5, release: 100, makeupDb: 3, kneeDb: 0 };
  expect(compressorOutputDb(settings, -30)).toBe(-27);
  expect(compressorOutputDb(settings, -8)).toBeCloseTo(-20 + 12 / 4 + 3, 6);
  // A soft knee eases in: at the threshold it already takes a little.
  const soft = compressorOutputDb({ ...settings, kneeDb: 12 }, -20);
  expect(soft).toBeLessThan(-17);
  expect(soft).toBeGreaterThan(-20);
});

test("the Gate and Limiter curves", () => {
  const gate = { thresholdDb: -40, rangeDb: -20, attack: 1, hold: 10, release: 100 };
  expect(gateOutputDb(gate, -30)).toBe(-30);
  expect(gateOutputDb(gate, -50)).toBe(-70);
  expect(gateOutputDb({ ...gate, rangeDb: -80 }, -50)).toBe(-Infinity);
  const limiter = { inputGainDb: 6, ceilingDb: -1, release: 50, lookahead: 3 };
  expect(limiterOutputDb(limiter, -20)).toBe(-14);
  expect(limiterOutputDb(limiter, 0)).toBe(-1);
});

test("the Saturator's shapes keep within full scale, as the engine's do", () => {
  for (const shape of ["soft", "hard", "tube", "fold"] as const) {
    for (let x = -5; x <= 5; x += 0.25) expect(Math.abs(saturate(shape, x))).toBeLessThanOrEqual(1);
  }
  expect(saturate("hard", 3)).toBe(1);
  expect(saturate("fold", 1.5)).toBe(0.5);
  const dry = { driveDb: 12, shape: "soft" as const, toneHz: 12000, outputDb: 0, mix: 0 };
  expect(saturatorTransfer(dry, 0.3)).toBeCloseTo(0.3, 9);
});

test("the Auto Filter's response passes or stops where its mode says", () => {
  expect(filterResponseDb("low-pass", 1000, 0.7, 100)).toBeCloseTo(0, 0);
  expect(filterResponseDb("low-pass", 1000, 0.7, 10_000)).toBeLessThan(-30);
  expect(filterResponseDb("high-pass", 1000, 0.7, 100)).toBeLessThan(-30);
  expect(filterResponseDb("band-pass", 1000, 2, 1000)).toBeCloseTo(0, 1);
  expect(filterResponseDb("notch", 1000, 2, 1000)).toBeLessThan(-60);
});

test("the Bitcrusher's steps and the Utility's field", () => {
  const steps = crushed({ bits: 2, downsample: 1, mix: 1 }, 64);
  expect(new Set(steps).size).toBeLessThanOrEqual(5);
  const held = crushed({ bits: 24, downsample: 8, mix: 1 }, 64);
  expect(held[1]).toBe(held[0]);
  const mono = utilityMatrix({ ...defaultEffectSettings("utility"), mono: "on" });
  expect(mono.left).toEqual([0.5, 0.5]);
  const wide = utilityMatrix(defaultEffectSettings("utility"));
  expect(wide.left).toEqual([1, 0]);
});

test("every built-in Effect but the EQ draws a picture of its settings", () => {
  for (const type of EFFECT_TYPES.filter((t) => t !== "eq")) {
    render(<EffectVisual effect={createEffect(type as EffectType, type)} label={type} />);
    expect(screen.getByRole("img", { name: new RegExp(`^${type} `) })).toBeInTheDocument();
    cleanup();
  }
});

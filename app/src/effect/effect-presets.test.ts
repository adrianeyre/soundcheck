import { expect, test } from "vitest";

import { createEffect, createProject, type Effect } from "../project/model";
import { validateProject } from "../project/validate";
import { clampEffectValue, EFFECT_TYPES, effectParams, effectSettingsFromFlat, effectSettingsToFlat } from "./effect-params";
import { EFFECT_PRESETS, effectPresets } from "./effect-presets";

test("the Delay ships the three factory presets the PRD names", () => {
  expect(EFFECT_PRESETS.delay.map((preset) => preset.name)).toEqual([
    "Slapback",
    "Quarter echo",
    "Dotted-eighth ping-pong",
  ]);
  const [slapback, quarter, dotted] = EFFECT_PRESETS.delay;
  expect(slapback!.settings).toMatchObject({ sync: "off", pingPong: "off" });
  expect(slapback!.settings.timeMs).toBeLessThan(150);
  expect(quarter!.settings).toMatchObject({ sync: "on", note: "1/4", pingPong: "off" });
  expect(dotted!.settings).toMatchObject({ sync: "on", note: "1/8 dotted", pingPong: "on" });
});

test("every preset is a whole set of settings, each already in range", () => {
  for (const type of EFFECT_TYPES) {
    for (const preset of effectPresets(type)) {
      const flat = effectSettingsToFlat(type, preset.settings);
      expect(effectSettingsFromFlat(type, flat)).toEqual(preset.settings);
      effectParams(type).forEach((param, index) => expect(clampEffectValue(param, flat[index]!)).toBe(flat[index]));

      const project = createProject("Presets");
      project.master.insertChain.push({ ...createEffect(type), settings: { ...preset.settings } } as Effect);
      expect(validateProject(project)).toBeNull();
    }
  }
});

test("every built-in Effect ships factory presets, each named once", () => {
  for (const type of EFFECT_TYPES) {
    const names = effectPresets(type).map((preset) => preset.name);
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(new Set(names).size).toBe(names.length);
    for (const preset of effectPresets(type)) expect(preset.description.length).toBeGreaterThan(0);
  }
});

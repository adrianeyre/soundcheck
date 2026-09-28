// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { Command } from "../project/commands";
import { createEffect, createInstrumentTrack, createProject, type Project } from "../project/model";
import { dbToY, EQ_BANDS, EqEditor, hzToX, soloBand, xToHz, yToDb } from "./EqEditor";
import { defaultEffectSettings, eqResponseDb } from "./effect-params";

afterEach(cleanup);

function project(withEq: boolean): Project {
  const keys = createInstrumentTrack("Keys", "keys");
  if (withEq) keys.insertChain.push(createEffect("eq", "keys-eq"));
  return { ...createProject(), tracks: [keys] };
}

test("the display's scales go both ways", () => {
  expect(xToHz(hzToX(1000))).toBeCloseTo(1000, 6);
  expect(hzToX(20)).toBe(0);
  expect(yToDb(dbToY(-6))).toBeCloseTo(-6, 6);
  expect(dbToY(0)).toBe(130);
});

test("one band alone draws only its own curve", () => {
  const settings = { ...defaultEffectSettings("eq"), band2GainDb: 6, lowShelfGainDb: -6 };
  const band2 = soloBand(settings, EQ_BANDS.find((band) => band.id === "band2")!);
  expect(eqResponseDb(band2, 1000)).toBeCloseTo(6, 1);
  expect(eqResponseDb(band2, 30)).toBeCloseTo(0, 1);
});

test("a channel with no EQ offers to add one", () => {
  const onCommand = vi.fn<(command: Command, label?: string) => void>();
  render(<EqEditor project={project(false)} preferTrackId="keys" onCommand={onCommand} />);
  fireEvent.click(screen.getByRole("button", { name: "Add an EQ to Keys" }));
  expect(onCommand).toHaveBeenCalledWith(
    expect.objectContaining({ type: "addEffect", target: { trackId: "keys" }, index: 0 }),
    "Add EQ",
  );
});

test("the band sliders change the EQ, one command each", () => {
  const onCommand = vi.fn<(command: Command, label?: string) => void>();
  render(<EqEditor project={project(true)} preferTrackId="keys" onCommand={onCommand} />);
  expect(screen.getByRole("img", { name: "Keys EQ frequency response" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("slider", { name: "Band 2 gain" }), { target: { value: "4.5" } });
  expect(onCommand).toHaveBeenLastCalledWith(
    { type: "setEffectSettings", effectId: "keys-eq", settings: { band2GainDb: 4.5 } },
    "Change EQ",
  );
  fireEvent.click(screen.getAllByRole("checkbox", { name: "On" })[0]!);
  expect(onCommand).toHaveBeenLastCalledWith(
    { type: "setEffectSettings", effectId: "keys-eq", settings: { lowCut: "on" } },
    "Switch Low cut",
  );
  fireEvent.click(screen.getByRole("button", { name: "Bypass Keys EQ" }));
  expect(onCommand).toHaveBeenLastCalledWith({ type: "setEffectBypassed", effectId: "keys-eq", bypassed: true });
});

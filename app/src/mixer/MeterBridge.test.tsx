// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { createInstrumentTrack, createProject } from "../project/model";
import { SongOverview } from "../song/SongOverview";
import { holdPeak, MeterBridge } from "./MeterBridge";

afterEach(cleanup);

test("a peak is held, then falls", () => {
  let held = holdPeak({ db: -Infinity, age: 0 }, -6);
  expect(held).toEqual({ db: -6, age: 0 });
  for (let reading = 0; reading < 30; reading++) held = holdPeak(held, -40);
  expect(held.db).toBe(-6);
  held = holdPeak(held, -40);
  expect(held.db).toBeCloseTo(-6.6, 6);
  expect(holdPeak(held, -1)).toEqual({ db: -1, age: 0 });
});

test("the bridge shows the Master and each channel as the engine measured them", () => {
  const project = { ...createProject(), tracks: [createInstrumentTrack("Keys", "keys")] };
  const { rerender } = render(<MeterBridge project={project} meters={null} />);
  expect(screen.getByText("Start audio to see the levels.")).toBeInTheDocument();
  rerender(<MeterBridge project={project} meters={{ master: 1.2, tracks: [0.5] }} />);
  expect(screen.getByRole("meter", { name: "Master level, large meter" })).toHaveAttribute("aria-valuetext", "+1.6 dB, clipping");
  expect(screen.getByRole("meter", { name: "Keys activity" })).toHaveAttribute("aria-valuetext", "-6.0 dB");
  expect(screen.getByRole("button", { name: "Clipped 1 times: reset" })).toBeInTheDocument();
});

test("the overview draws every Clip and the Sections", () => {
  const keys = createInstrumentTrack("Keys", "keys");
  keys.clips.push({ id: "c", kind: "pattern", start: 0, length: 3840, notes: [] });
  const project = { ...createProject(), tracks: [keys], sections: [{ id: "s", name: "Verse", startBar: 1, bars: 4 }] };
  render(<SongOverview project={project} position={1920} />);
  expect(screen.getByRole("img", { name: "The song: 1 Tracks over 8 bars, in Verse" })).toBeInTheDocument();
  expect(screen.getByText("Verse")).toBeInTheDocument();
});

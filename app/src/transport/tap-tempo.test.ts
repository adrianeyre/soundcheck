import { expect, test } from "vitest";

import { addTap, tappedTempo } from "./tap-tempo";

test("taps half a second apart are 120 BPM", () => {
  let taps: number[] = [];
  for (const at of [0, 500, 1000, 1500]) taps = addTap(taps, at);
  expect(tappedTempo(taps)).toBe(120);
});

test("one tap is no tempo, and a long pause starts again", () => {
  expect(tappedTempo(addTap([], 0))).toBeNull();
  expect(addTap([0, 500], 5000)).toEqual([5000]);
});

test("only the last eight taps count", () => {
  let taps: number[] = [];
  for (let tap = 0; tap < 12; tap++) taps = addTap(taps, tap * 400);
  expect(taps).toHaveLength(8);
  expect(tappedTempo(taps)).toBe(150);
});

import { expect, test } from "vitest";

import { type Anchor, predictPosition, reanchor, SNAP_SECONDS } from "./smooth-position";

const anchor = (changes: Partial<Anchor> = {}): Anchor => ({ position: 10, time: 1000, speed: 1, duration: 100, loop: null, ...changes });

test("between reports the playhead carries on at the Deck's speed", () => {
  expect(predictPosition(anchor(), 1020)).toBeCloseTo(10.02, 9);
  expect(predictPosition(anchor({ speed: 1.08 }), 1500)).toBeCloseTo(10.27, 9);
  expect(predictPosition(anchor({ speed: -1 }), 1100)).toBeCloseTo(9.9, 9);
  expect(predictPosition(anchor({ speed: 0 }), 5000)).toBe(10);
});

test("it never runs far past a report, or out of the track", () => {
  expect(predictPosition(anchor(), 60_000)).toBeCloseTo(10.25, 9);
  expect(predictPosition(anchor({ position: 99.9 }), 1200)).toBe(100);
  expect(predictPosition(anchor({ position: 0.05, speed: -1 }), 1200)).toBe(0);
});

test("inside a loop it goes round, either way", () => {
  const loop = { start: 8, end: 10.1 };
  expect(predictPosition(anchor({ loop }), 1200)).toBeCloseTo(8.1, 9);
  expect(predictPosition(anchor({ position: 8.05, speed: -1, loop }), 1100)).toBeCloseTo(10.05, 9);
});

test("a report pulls a drifted playhead back gently, and a far one snaps it", () => {
  const report = { position: 10.1, speed: 1, duration: 100, loop: null };
  expect(reanchor(10, report, 2000).position).toBeCloseTo(10.035, 9);
  expect(reanchor(10, { ...report, position: 10 + SNAP_SECONDS + 0.1 }, 2000).position).toBeCloseTo(10.35, 9);
  expect(reanchor(null, report, 2000)).toEqual({ position: 10.1, time: 2000, speed: 1, duration: 100, loop: null });
});

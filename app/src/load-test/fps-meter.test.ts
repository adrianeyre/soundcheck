import { expect, test } from "vitest";

import { FpsMeter } from "./fps-meter";

function run(meter: FpsMeter, from: number, frames: number, interval: number) {
  for (let n = 0; n < frames; n++) meter.frame(from + n * interval);
}

test("reports 60 fps for frames every 16.7 ms, with no long frames", () => {
  const meter = new FpsMeter();
  run(meter, 0, 120, 1000 / 60);
  expect(meter.fps).toBeCloseTo(60, 0);
  expect(meter.longFrames).toBe(0);
});

test("counts every missed refresh, and only looks at the last second for fps", () => {
  const meter = new FpsMeter();
  run(meter, 0, 60, 1000 / 60);
  meter.frame(1050); // a 67 ms stall
  run(meter, 1100, 60, 1000 / 30);
  expect(meter.longFrames).toBe(61);
  expect(meter.fps).toBeCloseTo(30, 0);

  meter.reset();
  expect(meter.longFrames).toBe(0);
});

test("reports 0 before there are two frames", () => {
  const meter = new FpsMeter();
  expect(meter.fps).toBe(0);
  meter.frame(5);
  expect(meter.fps).toBe(0);
});

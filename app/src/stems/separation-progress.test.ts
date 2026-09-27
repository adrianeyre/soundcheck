import { expect, test } from "vitest";

import { percentText, stageText, timeLeft, timeLeftText } from "./separation-progress";

test("each stage says what it's doing", () => {
  expect(stageText("reading")).toBe("Reading the audio…");
  expect(stageText("loadingModel")).toBe("Loading the model (about 300 MB)…");
  expect(stageText("separating")).toBe("Separating the drums, bass, other and vocals…");
  expect(stageText("finishing")).toBe("Making the four Stems…");
});

test("how far is a whole percentage, and 100% only when done", () => {
  expect(percentText(0)).toBe("0%");
  expect(percentText(0.426)).toBe("42%");
  expect(percentText(0.999)).toBe("99%");
  expect(percentText(1)).toBe("100%");
});

test("the time left goes at the rate since separating started, not since the model loaded", () => {
  // A tenth done in 10 s from a quarter: 65% more at the same rate.
  expect(timeLeft(0.35, { at: 0, progress: 0.25 }, 10_000)).toBeCloseTo(65_000);
  expect(timeLeft(1, { at: 0, progress: 0 }, 10_000)).toBe(0);
});

test("there's no time left to say until there's enough to go on", () => {
  expect(timeLeft(0.5, null, 10_000)).toBeNull();
  expect(timeLeft(0.01, { at: 0, progress: 0 }, 10_000)).toBeNull();
  expect(timeLeft(0.5, { at: 0, progress: 0 }, 2_000)).toBeNull();
});

test("the time left is said roughly", () => {
  expect(timeLeftText(400)).toBe("about 1 s left");
  expect(timeLeftText(42_000)).toBe("about 42 s left");
  expect(timeLeftText(60_000)).toBe("about 1 min left");
  expect(timeLeftText(132_000)).toBe("about 2 min 10 s left");
  expect(timeLeftText(178_000)).toBe("about 3 min left");
});

import { expect, test } from "vitest";

import type { Note } from "../project/model";
import {
  arpeggiate,
  chop,
  double,
  fitToKey,
  humanise,
  legato,
  mirror,
  removeQuiet,
  reverse,
  seededRandom,
  staccato,
  stretch,
  strum,
  swing,
  tidy,
  transpose,
  velocityContrast,
  velocityRamp,
} from "./note-tools";

const note = (pitch: number, start: number, length = 240, velocity = 0.8): Note => ({ pitch, start, length, velocity });
const BAR = 3840;
const C_CHORD = [note(60, 0, 1920), note(64, 0, 1920), note(67, 0, 1920)];

test("tidy keeps notes valid for the Clip", () => {
  expect(tidy([note(60, -1), note(60, BAR), note(130, 0), note(60, 10.4, 0, 2), note(60, 10)], BAR)).toEqual([
    note(60, 10, 240, 0.8),
  ]);
});

test("the random numbers are the same for the same seed", () => {
  const a = seededRandom(7);
  const b = seededRandom(7);
  const first = [a(), a(), a()];
  expect([b(), b(), b()]).toEqual(first);
  expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
});

test("transpose moves every note, unless one would leave MIDI's range", () => {
  expect(transpose(C_CHORD, 12, BAR).map((n) => n.pitch)).toEqual([72, 76, 79]);
  expect(transpose([note(120, 0)], 12, BAR)).toEqual([note(120, 0)]);
});

test("fit to key moves notes onto the scale", () => {
  expect(fitToKey([note(61, 0), note(66, 240)], { root: 0, scale: "major" }, BAR).map((n) => n.pitch)).toEqual([
    60, 65,
  ]);
});

test("humanise moves notes by no more than it is told", () => {
  const notes = Array.from({ length: 16 }, (_, step) => note(60, 240 * step + 240));
  const moved = humanise(notes, { timingTicks: 20, velocity: 0.1, seed: 3 }, BAR * 2);
  expect(moved).toHaveLength(16);
  moved.forEach((after, index) => {
    expect(Math.abs(after.start - notes[index]!.start)).toBeLessThanOrEqual(20);
    expect(Math.abs(after.velocity - 0.8)).toBeLessThanOrEqual(0.1 + 1e-9);
  });
  expect(moved).toEqual(humanise(notes, { timingTicks: 20, velocity: 0.1, seed: 3 }, BAR * 2));
});

test("legato fills each gap to the next note, and staccato shortens", () => {
  const notes = [note(60, 0, 100), note(62, 480, 100), note(64, 960, 100)];
  expect(legato(notes, BAR).map((n) => n.length)).toEqual([480, 480, BAR - 960]);
  expect(staccato([note(60, 0, 960)], 120, BAR)[0]!.length).toBe(120);
});

test("strum spreads a chord and keeps its end", () => {
  const up = strum(C_CHORD, 30, false, BAR);
  expect(up.map((n) => [n.pitch, n.start, n.start + n.length])).toEqual([
    [60, 0, 1920],
    [64, 30, 1920],
    [67, 60, 1920],
  ]);
  const down = strum(C_CHORD, 30, true, BAR);
  expect(down.find((n) => n.pitch === 67)!.start).toBe(0);
});

test("arpeggiate plays a chord one note at a time", () => {
  const up = arpeggiate(C_CHORD, 240, "up", 1, BAR);
  expect(up.map((n) => n.pitch)).toEqual([60, 64, 67, 60, 64, 67, 60, 64]);
  expect(up.every((n) => n.length === 240)).toBe(true);
  const twoOctaves = arpeggiate(C_CHORD, 240, "upDown", 2, BAR);
  expect(twoOctaves.map((n) => n.pitch).slice(0, 8)).toEqual([60, 64, 67, 72, 76, 79, 76, 72]);
  expect(arpeggiate([note(60, 0)], 120, "up", 1, BAR)).toEqual([note(60, 0)]);
});

test("chop cuts notes into pieces", () => {
  expect(chop([note(60, 0, 1000)], 240, BAR).map((n) => [n.start, n.length])).toEqual([
    [0, 240],
    [240, 240],
    [480, 240],
    [720, 240],
    [960, 40],
  ]);
});

test("reverse and mirror", () => {
  expect(reverse([note(60, 0, 240), note(62, 960, 480)], BAR).map((n) => [n.pitch, n.start])).toEqual([
    [62, 2400],
    [60, 3600],
  ]);
  expect(mirror([note(60, 0), note(64, 240), note(67, 480)], BAR).map((n) => n.pitch)).toEqual([67, 63, 60]);
});

test("velocity ramps and contrast", () => {
  const notes = [note(60, 0), note(60, BAR - 1)];
  expect(velocityRamp(notes, 0.2, 1, BAR).map((n) => n.velocity)).toEqual([0.2, 1]);
  const contrast = velocityContrast([note(60, 0, 240, 0.4), note(62, 0, 240, 0.8)], 2, BAR);
  expect(contrast.map((n) => Number(n.velocity.toFixed(2)))).toEqual([0.2, 1]);
  expect(removeQuiet([note(60, 0, 240, 0.1), note(62, 0, 240, 0.9)], 0.2, BAR)).toEqual([note(62, 0, 240, 0.9)]);
});

test("stretch, double and swing", () => {
  expect(stretch([note(60, 480, 240)], 2, BAR)).toEqual([note(60, 960, 480)]);
  expect(stretch([note(60, 480, 240)], 0.5, BAR)).toEqual([note(60, 240, 120)]);
  expect(double([note(60, 0)], 12, BAR).map((n) => n.pitch)).toEqual([60, 72]);
  expect(swing([note(60, 0), note(60, 240), note(60, 480)], 240, 1, BAR).map((n) => n.start)).toEqual([0, 360, 480]);
});

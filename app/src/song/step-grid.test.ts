import { expect, test } from "vitest";

import { createDrumTrack, createInstrumentTrack, type PatternClip } from "../project/model";
import { gridPitches, gridRows, isStepOn, pitchName, stepCount, toggleStep } from "./step-grid";

const SIXTEENTH = 240;

test("a step toggles a one-step note on and off", () => {
  const on = toggleStep([], 60, 3, SIXTEENTH);
  expect(on).toEqual([{ pitch: 60, start: 720, length: SIXTEENTH, velocity: 0.8 }]);
  expect(isStepOn(on, 60, 3, SIXTEENTH)).toBe(true);
  expect(isStepOn(on, 61, 3, SIXTEENTH)).toBe(false);
  expect(toggleStep(on, 60, 3, SIXTEENTH)).toEqual([]);
});

test("a coarser step shows and clears notes that start anywhere in it", () => {
  const notes = toggleStep([], 60, 3, SIXTEENTH);
  expect(isStepOn(notes, 60, 1, SIXTEENTH * 2)).toBe(true);
  expect(toggleStep(notes, 60, 1, SIXTEENTH * 2)).toEqual([]);
});

test("the grid has a step for every whole step in the Clip", () => {
  const clip: PatternClip = { id: "c", kind: "pattern", start: 0, length: 4 * 3840, notes: [] };
  expect(stepCount(clip, SIXTEENTH)).toBe(64);
  expect(stepCount(clip, 960)).toBe(16);
});

test("pitches are named with middle C as C4 and shown highest first", () => {
  expect(pitchName(60)).toBe("C4");
  expect(pitchName(61)).toBe("C♯4");
  const pitches = gridPitches(3);
  expect(pitches).toHaveLength(24);
  expect(pitches[0]).toBe(71);
  expect(pitches.at(-1)).toBe(48);
});

test("the Synth's rows are pitches and the Drum Sampler's are its pads", () => {
  const synth = gridRows(createInstrumentTrack("Keys").instrument, 3);
  expect(synth).toHaveLength(24);
  expect(synth[0]).toEqual({ pitch: 71, label: "B4", shaded: false });
  expect(synth.find((row) => row.pitch === 61)).toEqual({ pitch: 61, label: "C\u266f4", shaded: true });

  const drums = gridRows(createDrumTrack("Drums").instrument, 3);
  expect(drums.map((row) => row.label)).toEqual([
    "Kick",
    "Snare",
    "Clap",
    "Closed Hat",
    "Open Hat",
    "Low Tom",
    "High Tom",
    "Cowbell",
    "Hard Kick",
    "Rimshot",
    "Electric Snare",
    "Low Floor Tom",
    "Pedal Hat",
    "Mid Tom",
    "Crash",
    "Ride",
    "Tambourine",
    "Splash",
    "Hi Conga",
    "Low Conga",
    "Maracas",
    "Claves",
  ]);
  // A pad's steps are notes of its own note, so the grid edits the same Clip.
  expect(drums[0]!.pitch).toBe(36);
});

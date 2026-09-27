import { expect, test } from "vitest";

import { createInstrumentTrack, type Instrument, type Note, STARTER_KIT } from "../project/model";
import {
  copyNotes,
  deleteNotes,
  drawLength,
  drawNote,
  moveNotes,
  noteKey,
  PIANO_SNAPS,
  pasteNotes,
  pianoRows,
  quantiseNotes,
  resizeNotes,
  setVelocity,
  snapTicksOf,
} from "./piano-roll";

const note = (pitch: number, start: number, length = 240, velocity = 0.8): Note => ({ pitch, start, length, velocity });
const keys = (...notes: Note[]) => new Set(notes.map(noteKey));
const CHROMATIC = Array.from({ length: 128 }, (_, index) => 127 - index);
const BAR = 3840;
const DRUMS: Instrument = { type: "drumSampler", preset: null, pads: [...STARTER_KIT] };

test("the snap grid offers off, 1/4 to 1/32 and their triplets", () => {
  expect(PIANO_SNAPS.map((snap) => snap.id)).toEqual([
    "off",
    "1/4",
    "1/8",
    "1/16",
    "1/32",
    "1/4T",
    "1/8T",
    "1/16T",
    "1/32T",
  ]);
  expect(snapTicksOf("off")).toBe(1);
  expect(snapTicksOf("1/16")).toBe(240);
  expect(snapTicksOf("1/8T")).toBe(320);
  expect(snapTicksOf("1/32T")).toBe(80);
  // Every grid is a whole number of ticks.
  for (const snap of PIANO_SNAPS) expect(Number.isInteger(snap.ticks)).toBe(true);
  expect(drawLength(1)).toBe(240);
  expect(drawLength(320)).toBe(320);
});

test("drawing snaps down to the grid, and a note drawn on another replaces it", () => {
  const drawn = drawNote([], 60, 250, 240, 240, BAR);
  expect(drawn.notes).toEqual([note(60, 240)]);
  expect([...drawn.selection]).toEqual(["60:240"]);

  // Snapping off puts it on the tick.
  expect(drawNote([], 61, 251, 100, 1, BAR).notes).toEqual([note(61, 251, 100)]);

  const again = drawNote([note(60, 240, 960, 0.3)], 60, 300, 240, 240, BAR);
  expect(again.notes).toEqual([note(60, 240)]);
});

test("deleting removes only the selected notes", () => {
  const notes = [note(60, 0), note(62, 0), note(60, 480)];
  expect(deleteNotes(notes, keys(notes[0]!, notes[2]!))).toEqual([note(62, 0)]);
});

test("moving takes the selection together, snapped by the grabbed note, and stays in the Clip", () => {
  const a = note(60, 240);
  const b = note(64, 720);
  const other = note(50, 0);
  const moved = moveNotes([a, b, other], keys(a, b), a, 500, -2, CHROMATIC, 240, BAR);
  // 240 + 500 = 740, nearest 1/16 is 720: 480 later. Two rows up is two semitones up.
  expect(moved.notes).toEqual([other, note(62, 720), note(66, 1200)]);
  expect(moved.selection).toEqual(keys(note(62, 720), note(66, 1200)));

  // Too far left stops at the Clip's start, too far up at the top row.
  const left = moveNotes([a, b], keys(a, b), b, -5000, -500, CHROMATIC, 240, BAR);
  expect(left.notes).toEqual([note(123, 0), note(127, 480)]);
  // Too far right stops with the latest start still inside.
  const right = moveNotes([a, b], keys(a, b), a, 99999, 0, CHROMATIC, 1, BAR);
  expect(right.notes.map((n) => n.start)).toEqual([BAR - 1 - 480, BAR - 1]);

  // A note moved onto an unselected one replaces it.
  const onto = moveNotes([a, note(60, 480)], keys(a), a, 240, 0, CHROMATIC, 240, BAR);
  expect(onto.notes).toEqual([note(60, 480)]);
});

test("moving a drum note a row down goes to the next Pad", () => {
  const rows = pianoRows(DRUMS, []).map((row) => row.pitch);
  const kick = note(rows[0]!, 0);
  const moved = moveNotes([kick], keys(kick), kick, 0, 1, rows, 240, BAR);
  expect(moved.notes).toEqual([note(rows[1]!, 0)]);
});

test("resizing lengthens and shortens the selection by the grabbed note's snapped end", () => {
  const a = note(60, 0, 240);
  const b = note(62, 0, 480);
  const other = note(64, 0, 240);
  expect(resizeNotes([a, b, other], keys(a, b), a, 250, 240)).toEqual([note(60, 0, 480), note(62, 0, 720), other]);
  // Never shorter than a grid step.
  expect(resizeNotes([a], keys(a), a, -1000, 240)).toEqual([note(60, 0, 240)]);
  // With snapping off, any length, to a least of a 1/16.
  expect(resizeNotes([a], keys(a), a, 17, 1)).toEqual([note(60, 0, 257)]);
});

test("velocity is set on the selection and kept between 0 and 1", () => {
  const a = note(60, 0);
  const b = note(62, 0);
  expect(setVelocity([a, b], keys(a), 0.25)).toEqual([note(60, 0, 240, 0.25), b]);
  expect(setVelocity([a], keys(a), 3)[0]!.velocity).toBe(1);
  expect(setVelocity([a], keys(a), -1)[0]!.velocity).toBe(0);
});

test("quantising snaps only the selected starts to the nearest grid step", () => {
  const a = note(60, 130, 100);
  const b = note(62, 350);
  const c = note(64, 10);
  const edit = quantiseNotes([a, b, c], keys(a, b), 240, BAR);
  expect(edit.notes).toEqual([c, note(60, 240, 100), note(62, 240)]);
  // A triplet grid, and a note near the end stays inside the Clip.
  expect(quantiseNotes([note(60, BAR - 5)], keys(note(60, BAR - 5)), 320, BAR).notes).toEqual([note(60, BAR - 320)]);
});

test("quantising at a strength moves each selected start that part of the way to its grid step", () => {
  const a = note(60, 130);
  const b = note(62, 350);
  const c = note(64, 200);
  // At 50%, 130 goes halfway to 240 and 350 halfway to 240.
  expect(quantiseNotes([a, b, c], keys(a, b, c), 240, BAR, 0.5).notes).toEqual([
    note(60, 185),
    note(62, 295),
    note(64, 220),
  ]);
  expect(quantiseNotes([a], keys(a), 240, BAR, 0).notes).toEqual([a]);
  expect(quantiseNotes([a], keys(a), 240, BAR, 1).notes).toEqual([note(60, 240)]);
});

test("copied notes paste at a position, keeping their spacing; ones past the Clip's end are dropped", () => {
  const a = note(60, 480, 240);
  const b = note(64, 960, 120);
  const clipboard = copyNotes([a, b, note(50, 0)], keys(a, b), 240)!;
  expect(clipboard.notes).toEqual([note(60, 0, 240), note(64, 480, 120)]);
  expect(clipboard.span).toBe(720);
  expect(copyNotes([a], new Set(), 240)).toBeNull();

  const pasted = pasteNotes([a, b], clipboard, 1200, BAR);
  expect(pasted.notes).toEqual([a, b, note(60, 1200, 240), note(64, 1680, 120)]);
  expect(pasted.selection).toEqual(keys(note(60, 1200), note(64, 1680)));

  expect(pasteNotes([], clipboard, BAR - 100, BAR).notes).toEqual([note(60, BAR - 100, 240)]);
});

test("a drum Clip's rows are its Pads by name, then any stray pitch", () => {
  const pads = STARTER_KIT;
  const rows = pianoRows(DRUMS, [note(pads[0]!.note, 0), note(20, 0)]);
  expect(rows.map((row) => row.label)).toEqual([...pads.map((pad) => pad.name), "G♯0"]);

  const synth = createInstrumentTrack("Keys");
  const all = pianoRows(synth.instrument, []);
  expect(all).toHaveLength(128);
  expect(all[0]).toEqual({ pitch: 127, label: "G9", shaded: false });
  expect(all.find((row) => row.pitch === 61)).toEqual({ pitch: 61, label: "C♯4", shaded: true });
});

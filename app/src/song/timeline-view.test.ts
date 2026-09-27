import { expect, test } from "vitest";

import type { AudioClip, PatternClip } from "../project/model";
import { createAudioTrack, createInstrumentTrack } from "../project/model";
import { barTicks, TICKS_PER_BEAT, type TimeSignature, tempoMapOf } from "../project/time";
import {
  accepts,
  copyOf,
  dragged,
  fixedGrid,
  gridTicks,
  loopRegion,
  mapGrid,
  newPatternClip,
  pxToTicks,
  snapTicks,
  spanOf,
  ticksToPx,
  timelineEnd,
  ZOOM_LEVELS,
  zoomedBy,
} from "./timeline-view";

const FOUR_FOUR: TimeSignature = { beatsPerBar: 4, beatUnit: 4 };
const BAR = barTicks(FOUR_FOUR);
const BEAT = TICKS_PER_BEAT;

const pattern = (start: number, length: number): PatternClip => newPatternClip(start, length, "clip");

test("the grid is bars, beats and subdivisions of the Project's time signature", () => {
  expect(gridTicks("bar", FOUR_FOUR)).toBe(3840);
  expect(gridTicks("beat", FOUR_FOUR)).toBe(960);
  expect(gridTicks("half", FOUR_FOUR)).toBe(480);
  expect(gridTicks("quarter", FOUR_FOUR)).toBe(240);
  expect(gridTicks("eighth", FOUR_FOUR)).toBe(120);
  // Snapping off still means whole ticks.
  expect(gridTicks("off", FOUR_FOUR)).toBe(1);

  const sixEight: TimeSignature = { beatsPerBar: 6, beatUnit: 8 };
  expect(gridTicks("beat", sixEight)).toBe(480);
  expect(gridTicks("bar", sixEight)).toBe(2880);
});

test("snapping gives an exact grid position, never below zero", () => {
  expect(snapTicks(BAR + 100, BAR)).toBe(BAR);
  expect(snapTicks(BAR * 2 - 100, BAR)).toBe(BAR * 2);
  expect(snapTicks(BEAT + 479, BEAT)).toBe(BEAT);
  expect(snapTicks(BEAT + 481, BEAT)).toBe(BEAT * 2);
  expect(snapTicks(-5000, BAR)).toBe(0);
  // Off the grid, the position is whatever the pointer says, in whole ticks.
  expect(snapTicks(1234.6, 1)).toBe(1235);
});

test("pixels and ticks convert both ways at any zoom", () => {
  expect(ticksToPx(BAR, 96, BAR)).toBe(96);
  expect(ticksToPx(BAR / 2, 48, BAR)).toBe(24);
  expect(pxToTicks(96, 96, BAR)).toBe(BAR);
  expect(pxToTicks(24, 48, BAR)).toBe(BAR / 2);
  // A pointer movement is rounded to whole ticks before it is snapped.
  expect(Number.isInteger(pxToTicks(7, 96, BAR))).toBe(true);
});

test("zoom steps through its levels and stops at the ends", () => {
  expect(zoomedBy(96, 1)).toBe(192);
  expect(zoomedBy(96, -1)).toBe(48);
  expect(zoomedBy(ZOOM_LEVELS[0]!, -1)).toBe(ZOOM_LEVELS[0]);
  expect(zoomedBy(ZOOM_LEVELS.at(-1)!, 1)).toBe(ZOOM_LEVELS.at(-1));
});

test("moving snaps the Clip's new start, not the distance dragged", () => {
  // A Clip that is off the grid lands on it.
  expect(dragged({ start: 100, length: BAR }, "move", BAR - 30, fixedGrid(BAR))).toEqual({
    start: BAR,
    length: BAR,
  });
  expect(dragged({ start: BAR, length: BAR }, "move", 40, fixedGrid(BAR))).toEqual({ start: BAR, length: BAR });
  // Dragged left past the start of the song, it stops there.
  expect(dragged({ start: BAR, length: BAR }, "move", -BAR * 4, fixedGrid(BAR))).toEqual({ start: 0, length: BAR });
  // With snapping off it goes exactly where it was dragged.
  expect(dragged({ start: 0, length: BAR }, "move", 137, fixedGrid(1))).toEqual({ start: 137, length: BAR });
});

test("trimming the start moves it without moving the end", () => {
  expect(dragged({ start: 0, length: BAR * 2 }, "trimStart", BAR - 50, fixedGrid(BAR))).toEqual({
    start: BAR,
    length: BAR,
  });
  // It can't be dragged past its own end: one grid step is the shortest Clip.
  expect(dragged({ start: 0, length: BAR * 2 }, "trimStart", BAR * 9, fixedGrid(BAR))).toEqual({
    start: BAR,
    length: BAR,
  });
  expect(dragged({ start: BAR, length: BAR }, "trimStart", -BAR * 3, fixedGrid(BAR))).toEqual({
    start: 0,
    length: BAR * 2,
  });
});

test("trimming the end moves it without moving the start", () => {
  expect(dragged({ start: BAR, length: BAR * 2 }, "trimEnd", -BAR + 20, fixedGrid(BAR))).toEqual({
    start: BAR,
    length: BAR,
  });
  expect(dragged({ start: BAR, length: BAR * 2 }, "trimEnd", BAR, fixedGrid(BAR))).toEqual({
    start: BAR,
    length: BAR * 3,
  });
  // Never shorter than one grid step, however far left it is dragged.
  expect(dragged({ start: BAR, length: BAR * 2 }, "trimEnd", -BAR * 5, fixedGrid(BAR))).toEqual({
    start: BAR,
    length: BAR,
  });
});

test("a copy is the same Clip somewhere else, under its own id", () => {
  const clip = pattern(0, BAR);
  clip.notes.push({ pitch: 60, start: 0, length: 240, velocity: 0.8 });
  const copy = copyOf(clip, BAR * 2, "copy-1");
  expect(copy).toEqual({ ...clip, id: "copy-1", start: BAR * 2 });
  // Deeply copied: editing one Clip's notes leaves the other alone.
  (copy as PatternClip).notes[0]!.pitch = 72;
  expect(clip.notes[0]!.pitch).toBe(60);
});

test("a Pattern Clip can only go on an Instrument Track, an Audio Clip on an Audio Track", () => {
  const instrument = createInstrumentTrack("Keys", "keys");
  const audio = createAudioTrack("Vocals", "vocals");
  const patternClip = pattern(0, BAR);
  const audioClip: AudioClip = { id: "a", kind: "audio", start: 0, duration: 2, file: "a.wav", fileOffset: 0 };

  expect(accepts(instrument, patternClip)).toBe(true);
  expect(accepts(audio, patternClip)).toBe(false);
  expect(accepts(audio, audioClip)).toBe(true);
  expect(accepts(instrument, audioClip)).toBe(false);
});

test("a loop region drag is snapped, in order, and never empty", () => {
  expect(loopRegion(BAR + 100, BAR * 3 - 100, fixedGrid(BAR))).toEqual({ start: BAR, end: BAR * 3 });
  // Dragged right to left.
  expect(loopRegion(BAR * 3, BAR, fixedGrid(BAR))).toEqual({ start: BAR, end: BAR * 3 });
  // A click, or a drag shorter than the grid, still leaves a bar to loop.
  expect(loopRegion(BAR, BAR + 10, fixedGrid(BAR))).toEqual({ start: BAR, end: BAR * 2 });
});

test("the timeline is long enough for the last Clip and at least the minimum", () => {
  const track = createInstrumentTrack("Keys", "keys");
  const map = tempoMapOf({ tempo: 120, timeSignature: FOUR_FOUR, tempoChanges: [] });
  expect(timelineEnd([track], map, 8)).toBe(BAR * 8);
  track.clips.push(pattern(BAR * 9, BAR * 2));
  expect(timelineEnd([track], map, 8)).toBe(BAR * 12);
});

test("the timeline runs past a Tempo Change, to a bar line of its time signature", () => {
  const track = createInstrumentTrack("Keys", "keys");
  const threeFour = { beatsPerBar: 3, beatUnit: 4 };
  const map = tempoMapOf({
    tempo: 120,
    timeSignature: FOUR_FOUR,
    tempoChanges: [{ tick: BAR * 10, tempo: null, timeSignature: threeFour }],
  });
  // Bar 11 is the first in 3/4, and the timeline runs to its end.
  expect(timelineEnd([track], map, 8)).toBe(BAR * 10 + 3 * BEAT);
});

test("an Audio Clip's span follows the tempo map, ending where its seconds do", () => {
  const map = tempoMapOf({ tempo: 120, timeSignature: FOUR_FOUR, tempoChanges: [{ tick: BAR, tempo: 60, timeSignature: null }] });
  const clip: AudioClip = { id: "a", kind: "audio", start: 0, duration: 3, file: "a.wav", fileOffset: 0 };
  // 2 s at 120 is the first bar; the last second, at 60, is one beat.
  expect(spanOf(clip, map)).toEqual({ start: 0, length: BAR + BEAT });
  expect(spanOf({ ...clip, start: BAR }, map)).toEqual({ start: BAR, length: 3 * BEAT });
});

test("the song's grid snaps within each time signature, and to where a new one starts", () => {
  const threeFour = { beatsPerBar: 3, beatUnit: 4 };
  // One bar of 4/4, then 3/4.
  const map = tempoMapOf({ tempo: 120, timeSignature: FOUR_FOUR, tempoChanges: [{ tick: BAR, tempo: null, timeSignature: threeFour }] });
  const bars = mapGrid(map, "bar");
  expect(bars.snap(BAR - 100)).toBe(BAR);
  expect(bars.snap(BAR + 3 * BEAT - 100)).toBe(BAR + 3 * BEAT);
  expect(bars.snap(BAR + 4 * BEAT + 100)).toBe(BAR + 3 * BEAT);
  // Half way through the 4/4 bar is nearer its start than 4/4's next bar would be.
  expect(bars.snap(BAR / 2 - 1)).toBe(0);
  expect(bars.snap(BAR / 2 + 1)).toBe(BAR);
  expect(mapGrid(map, "beat").snap(BAR + BEAT + 10)).toBe(BAR + BEAT);
  expect(mapGrid(map, "off").snap(1234)).toBe(1234);
});

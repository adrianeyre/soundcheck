import { expect, test } from "vitest";

import { applyCommands } from "../project/commands";
import { createAudioTrack, createProject, type AudioClip } from "../project/model";
import { constantTempoMap, secondsAt, tempoMapOf, tickAfter } from "../project/time";
import {
  cutAt,
  cutRange,
  cutsOf,
  equalCuts,
  formatSeconds,
  gridCuts,
  MIN_SLICE_SECONDS,
  moveCut,
  removeCut,
  rulerStep,
  safeFileName,
  sliceAt,
  sliceClip,
  sliceEnd,
  sliceExportRequest,
  sliceNames,
  slicesAt,
  snapTo,
  splitCommands,
  wholeClip,
} from "./audio-editor";

// 120 BPM in 4/4: a beat is half a second, a bar two.
const map = constantTempoMap(120, { beatsPerBar: 4, beatUnit: 4 });
const clip: AudioClip = { id: "c", kind: "audio", start: 960, duration: 4, file: "audio/Break.wav", fileOffset: 1 };

test("a cut splits the Slice it falls in, and the second half keeps its inclusion", () => {
  const one = cutAt(wholeClip(), 1, 4)!;
  expect(one).toEqual([
    { start: 0, name: "", included: true },
    { start: 1, name: "", included: true },
  ]);
  const excluded = cutAt([one[0]!, { ...one[1]!, included: false, name: "Hit" }], 3, 4)!;
  expect(excluded.map(({ start, included, name }) => [start, included, name])).toEqual([
    [0, true, ""],
    [1, false, "Hit"],
    [3, false, ""],
  ]);
  expect(sliceAt(excluded, 2.5)).toBe(1);
  expect(sliceEnd(excluded, 1, 4)).toBe(3);
  expect(sliceEnd(excluded, 2, 4)).toBe(4);
});

test("no cut leaves a Slice shorter than the least there can be", () => {
  expect(cutAt(wholeClip(), MIN_SLICE_SECONDS / 2, 4)).toBeNull();
  expect(cutAt(wholeClip(), 4 - MIN_SLICE_SECONDS / 2, 4)).toBeNull();
  const two = cutAt(wholeClip(), 1, 4)!;
  expect(cutAt(two, 1.001, 4)).toBeNull();
  // Auto-slicing drops the cuts too close together, and keeps the rest in order.
  expect(cutsOf(slicesAt([3, 1, 1.001, 0, 4], 4))).toEqual([1, 3]);
});

test("a cut moves between its neighbours, and one taken away joins its Slice to the one before", () => {
  const slices = slicesAt([1, 2, 3], 4);
  expect(cutRange(slices, 2, 4)).toEqual({ min: 1 + MIN_SLICE_SECONDS, max: 3 - MIN_SLICE_SECONDS });
  expect(cutsOf(moveCut(slices, 2, 2.5, 4))).toEqual([1, 2.5, 3]);
  expect(cutsOf(moveCut(slices, 2, 10, 4))).toEqual([1, 3 - MIN_SLICE_SECONDS, 3]);
  expect(cutsOf(moveCut(slices, 2, -1, 4))).toEqual([1, 1 + MIN_SLICE_SECONDS, 3]);
  const named = slices.map((slice, i) => ({ ...slice, name: `S${i}` }));
  expect(removeCut(named, 2).map(({ name }) => name)).toEqual(["S0", "S1", "S3"]);
  // The first Slice's start isn't a cut.
  expect(removeCut(named, 0)).toEqual(named);
});

test("equal parts, and every beat or bar of the song the Clip spans", () => {
  expect(equalCuts(4, 4)).toEqual([1, 2, 3]);
  expect(equalCuts(4, 1)).toEqual([]);
  // At tick 960 (half a second in) for 4 s: beats at 0.5 s steps from the Clip's start, bars on the song's bar lines.
  expect(gridCuts(clip, map, "beat")).toEqual([0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
  expect(gridCuts(clip, map, "bar")).toEqual([1.5, 3.5]);
  expect(snapTo(1.3, [0, 1, 1.5])).toBe(1.5);
  expect(snapTo(1.3, [])).toBe(1.3);
});

test("Slices are named after the Clip and numbered, or as the musician named them, and never the same twice", () => {
  const slices = slicesAt([1, 2, 3], 4).map((slice, i) => (i === 2 ? { ...slice, name: "Snare: open?" } : i === 3 ? { ...slice, name: "break – 01" } : slice));
  expect(sliceNames(clip, slices)).toEqual(["Break – 01", "Break – 02", "Snare- open-", "break – 01 (2)"]);
  expect(safeFileName("  ..  ")).toBe("Slice");
  expect(sliceNames(clip, slicesAt(equalCuts(4, 120), 4)).at(-1)).toBe("Break – 120");
});

test("a Slice exports its own stretch of the Clip's file", () => {
  const slices = slicesAt([1.25], 4);
  expect(sliceClip(clip, slices, 1)).toMatchObject({ fileOffset: 2.25, duration: 2.75 });
  const samples = new Map([["audio/Break.wav", { name: "Break.wav", bytes: [1, 2, 3] }]]);
  const format = { sampleRate: 48_000 as const, encoding: { kind: "wav" as const, bits: 24 as const } };
  expect(sliceExportRequest(clip, slices, 0, samples, format)).toEqual({
    audio: new Uint8Array([1, 2, 3]),
    fileOffset: 1,
    duration: 1.25,
    ...format,
  });
  expect(sliceExportRequest(clip, slices, 0, new Map(), format)).toBeNull();
});

test("splitting puts each included Slice where it played, meeting the next on a whole tick with no gap", () => {
  const track = { ...createAudioTrack("Drums", "t"), clips: [clip] };
  const project = { ...createProject(), tracks: [track] };
  const songMap = tempoMapOf(project);
  // 1.2345 s in isn't on a tick; 3 s is.
  const slices = slicesAt([1.2345, 3], 4).map((slice, i) => (i === 1 ? { ...slice, included: false } : slice));
  let n = 0;
  const { commands, kept } = splitCommands("t", clip, slices, songMap, () => `new-${++n}`);
  expect(kept).toEqual(["c", "new-1"]);

  const result = applyCommands(project, commands);
  if (!result.ok) throw new Error(result.error);
  const clips = result.project.tracks[0]!.clips as AudioClip[];
  expect(clips.map(({ id }) => id)).toEqual(["c", "new-1"]);
  const [first, last] = clips as [AudioClip, AudioClip];
  expect(first.start).toBe(960);
  expect(first.fileOffset).toBe(1);
  // The cut moved to the nearest tick, and the first Slice ends there.
  const cutTick = Math.round(tickAfter(songMap, 960, 1.2345));
  expect(first.duration).toBeCloseTo(secondsAt(songMap, cutTick) - secondsAt(songMap, 960), 12);
  expect(Math.abs(first.duration - 1.2345)).toBeLessThan(0.0003);
  // The last plays from 3 s into the Clip to its end, where it did.
  expect(last.start).toBe(tickAfter(songMap, 960, 3));
  expect(last.fileOffset).toBeCloseTo(4, 12);
  expect(last.duration).toBeCloseTo(1, 12);
});

test("splitting with every Slice left out deletes the Clip", () => {
  const { commands, kept } = splitCommands("t", clip, [{ start: 0, name: "", included: false }], map);
  expect(kept).toEqual([]);
  expect(commands).toEqual([{ type: "deleteClip", clipId: "c" }]);
});

test("times read as minutes, seconds and milliseconds, and the ruler's labels stay apart", () => {
  expect(formatSeconds(65.25)).toBe("1:05.250");
  expect(formatSeconds(0.0004)).toBe("0:00.000");
  expect(rulerStep(100)).toBe(1);
  expect(rulerStep(100_000)).toBe(0.001);
  expect(rulerStep(0.01)).toBe(300);
});

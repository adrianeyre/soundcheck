/**
 * The Audio Editor's model: where an Audio Clip is cut, and the Slices those
 * cuts make of it. Pure, so cutting, moving and auto-slicing are tested
 * without a browser.
 *
 * The cuts are the editor's, not the Project's: a Clip is only changed when
 * the musician splits it into its Slices, as one undo step, and a Slice is
 * only written when it is exported. Every time here is in seconds from the
 * Clip's start, as its audio plays.
 */
import type { Command } from "../project/commands";
import type { LoadedSamples } from "../project/engine-sync";
import { type AudioClip, newId } from "../project/model";
import { barLines, beatLines, secondsBetween, tickAfter, type TempoMap } from "../project/time";
import { clipExportRequest, clipFileName, type ClipExportRequest, type Encoding, type ExportSampleRate } from "../export/mix-exporter";

/** No Slice is shorter than this: about a quarter of a 44.1 kHz cycle of 20 Hz. */
export const MIN_SLICE_SECONDS = 0.005;

/** One stretch of the Clip, from its start to the next Slice's (or the Clip's end). */
export interface Slice {
  start: number;
  /** What the musician called it; empty for the name it is numbered with. */
  name: string;
  /** Exported, and kept when the Clip is split. */
  included: boolean;
}

/** The Clip in one Slice: no cuts. */
export function wholeClip(): Slice[] {
  return [{ start: 0, name: "", included: true }];
}

/** Where Slice `index` ends. */
export function sliceEnd(slices: readonly Slice[], index: number, duration: number): number {
  return slices[index + 1]?.start ?? duration;
}

/** Which Slice `at` is in. */
export function sliceAt(slices: readonly Slice[], at: number): number {
  let found = 0;
  slices.forEach((slice, index) => {
    if (slice.start <= at) found = index;
  });
  return found;
}

/** The cuts: where each Slice after the first starts. */
export function cutsOf(slices: readonly Slice[]): number[] {
  return slices.slice(1).map((slice) => slice.start);
}

/**
 * A cut at `at`, splitting the Slice it falls in: both halves keep its
 * inclusion, and the second is unnamed. Null where it would leave a Slice
 * shorter than `MIN_SLICE_SECONDS`.
 */
export function cutAt(slices: readonly Slice[], at: number, duration: number): Slice[] | null {
  const index = sliceAt(slices, at);
  const from = slices[index]!;
  if (at - from.start < MIN_SLICE_SECONDS || sliceEnd(slices, index, duration) - at < MIN_SLICE_SECONDS) return null;
  return [...slices.slice(0, index + 1), { start: at, name: "", included: from.included }, ...slices.slice(index + 1)];
}

/** Where cut `index` (Slice `index`'s start, from 1) can go: between its neighbours, a Slice's width short of each. */
export function cutRange(slices: readonly Slice[], index: number, duration: number): { min: number; max: number } {
  return { min: slices[index - 1]!.start + MIN_SLICE_SECONDS, max: sliceEnd(slices, index, duration) - MIN_SLICE_SECONDS };
}

/** Cut `index` moved to `to`, kept between its neighbours. */
export function moveCut(slices: readonly Slice[], index: number, to: number, duration: number): Slice[] {
  if (index < 1 || index >= slices.length) return [...slices];
  const { min, max } = cutRange(slices, index, duration);
  return slices.map((slice, i) => (i === index ? { ...slice, start: Math.min(max, Math.max(min, to)) } : slice));
}

/** Cut `index` taken away: Slice `index` joins the one before it, which keeps its name. */
export function removeCut(slices: readonly Slice[], index: number): Slice[] {
  if (index < 1 || index >= slices.length) return [...slices];
  return slices.filter((_, i) => i !== index);
}

/**
 * Slices cut at every one of `cuts` that leaves none too short, all
 * included and numbered: what an auto-slice makes.
 */
export function slicesAt(cuts: readonly number[], duration: number): Slice[] {
  let slices = wholeClip();
  for (const at of cuts.toSorted((a, b) => a - b)) slices = cutAt(slices, at, duration) ?? slices;
  return slices;
}

/** Cuts making `parts` Slices of equal length. */
export function equalCuts(duration: number, parts: number): number[] {
  const count = Math.max(1, Math.round(parts));
  return Array.from({ length: count - 1 }, (_, i) => (duration * (i + 1)) / count);
}

export type GridUnit = "beat" | "bar";

/**
 * Cuts on the song's every beat or bar line the Clip spans, from its
 * position on the Track: the Slices of a loop in time with the song.
 */
export function gridCuts(clip: AudioClip, map: TempoMap, unit: GridUnit): number[] {
  const end = tickAfter(map, clip.start, clip.duration);
  const ticks = unit === "bar" ? barLines(map, clip.start, end).map(({ tick }) => tick) : beatLines(map, clip.start, end);
  return ticks.filter((tick) => tick > clip.start && tick < end).map((tick) => secondsBetween(map, clip.start, tick));
}

/** The song's beat (or bar) lines the Clip spans, as times into the Clip: what the grid snaps to. */
export function gridLines(clip: AudioClip, map: TempoMap, unit: GridUnit): number[] {
  return [0, ...gridCuts(clip, map, unit)];
}

/** `at` moved onto the nearest of `lines`, or left where it is with none. */
export function snapTo(at: number, lines: readonly number[]): number {
  let best = at;
  let distance = Infinity;
  for (const line of lines) {
    if (Math.abs(line - at) < distance) {
      distance = Math.abs(line - at);
      best = line;
    }
  }
  return best;
}

/** Characters no file name can hold on Windows, macOS or Linux. */
// oxlint-disable-next-line no-control-regex
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;

/** `name` as a file name every platform takes. */
export function safeFileName(name: string): string {
  return name.replace(UNSAFE, "-").replace(/[. ]+$/, "").trim() || "Slice";
}

/**
 * Each Slice's name: its own, or the Clip's file name and its number, as
 * "Break – 03". Two the same are told apart, so no export overwrites
 * another.
 */
export function sliceNames(clip: AudioClip, slices: readonly Slice[]): string[] {
  const base = clipFileName(clip);
  const digits = Math.max(2, String(slices.length).length);
  const seen = new Map<string, number>();
  return slices.map((slice, index) => {
    const name = safeFileName(slice.name.trim() || `${base} – ${String(index + 1).padStart(digits, "0")}`);
    const key = name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? name : `${name} (${count})`;
  });
}

/** Slice `index` of `clip` as an Audio Clip of its own, where it plays in the file. */
export function sliceClip(clip: AudioClip, slices: readonly Slice[], index: number): AudioClip {
  const start = slices[index]!.start;
  return { ...clip, fileOffset: clip.fileOffset + start, duration: sliceEnd(slices, index, clip.duration) - start };
}

/** What exports Slice `index`: its stretch of the Clip's file, raw. Null while the file isn't loaded. */
export function sliceExportRequest(
  clip: AudioClip,
  slices: readonly Slice[],
  index: number,
  samples: LoadedSamples,
  format: { sampleRate: ExportSampleRate; encoding: Encoding },
): ClipExportRequest | null {
  return clipExportRequest(sliceClip(clip, slices, index), samples, format);
}

/**
 * Split `clip` on `trackId` into one Clip per included Slice, each where it
 * played, so the song sounds the same but for any Slice left out. A Clip
 * starts on a whole tick, so each cut moves to the nearest one (at most
 * half a tick, a quarter of a millisecond at 120 BPM) and every Slice's
 * audio moves with it: they meet with no gap and no overlap. The first
 * Slice kept keeps the Clip's id, so it stays selected.
 */
export function splitCommands(
  trackId: string,
  clip: AudioClip,
  slices: readonly Slice[],
  map: TempoMap,
  makeId: () => string = newId,
): { commands: Command[]; kept: string[] } {
  const bounds = slices.map((slice, index) =>
    index === 0 ? clip.start : Math.max(clip.start, Math.round(tickAfter(map, clip.start, slice.start))),
  );
  const commands: Command[] = [{ type: "deleteClip", clipId: clip.id }];
  const kept: string[] = [];
  slices.forEach((slice, index) => {
    if (!slice.included) return;
    const start = bounds[index]!;
    const into = secondsBetween(map, clip.start, start);
    const until = index + 1 < slices.length ? secondsBetween(map, clip.start, bounds[index + 1]!) : clip.duration;
    if (until - into <= 0) return;
    const id = kept.length === 0 ? clip.id : makeId();
    kept.push(id);
    commands.push({
      type: "addClip",
      trackId,
      clip: { id, kind: "audio", start, file: clip.file, fileOffset: clip.fileOffset + into, duration: until - into },
    });
  });
  return { commands, kept };
}

/** `seconds` as minutes, seconds and milliseconds: "1:05.250". */
export function formatSeconds(seconds: number): string {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, "0")}`;
}

/** Ruler steps, in seconds, from a sample-level zoom out to minutes. */
const RULER_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

/** The ruler's step at `pixelsPerSecond`: the smallest that keeps its labels `minPx` apart. */
export function rulerStep(pixelsPerSecond: number, minPx = 80): number {
  return RULER_STEPS.find((step) => step * pixelsPerSecond >= minPx) ?? RULER_STEPS.at(-1)!;
}

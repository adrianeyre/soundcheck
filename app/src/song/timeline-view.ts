/**
 * The arrangement timeline's view of the Project: pixels to ticks, the snap
 * grid, and what a drag on a Clip means.
 *
 * Nothing here changes a Project. Every result is turned into a command
 * (`commands.ts`) by `Timeline.tsx`, so every edit undoes. Snapping happens
 * here, on the finished position rather than on the movement, so a snapped
 * Clip sits on an exact grid position in the Project data.
 *
 * The timeline is drawn in ticks, so a bar of the song's starting time
 * signature is always as wide; Tempo Changes move no Pattern Clip, only the
 * grid (a new time signature) and how many ticks an Audio Clip spans.
 */
import { type Clip, clipEnd, type PatternClip, type Section, type Track } from "../project/model";
import { sectionTicks } from "../project/sections";
import {
  barBeatTick,
  barStart,
  barTicks,
  beatTicks,
  segmentAt,
  type TempoMap,
  type TimeSignature,
} from "../project/time";

/** The grids a Clip can snap to: bars, beats and subdivisions of a beat. */
export const SNAP_CHOICES = [
  { id: "bar", label: "Bar" },
  { id: "beat", label: "Beat" },
  { id: "half", label: "½ beat" },
  { id: "quarter", label: "¼ beat" },
  { id: "eighth", label: "⅛ beat" },
  { id: "off", label: "Off" },
] as const;

export type SnapId = (typeof SNAP_CHOICES)[number]["id"];

export const DEFAULT_SNAP: SnapId = "bar";

/**
 * How many ticks one grid step is. Snapping off is a grid of one tick:
 * positions are still whole ticks, they are just not rounded to a beat.
 */
export function gridTicks(snap: SnapId, signature: TimeSignature): number {
  switch (snap) {
    case "bar":
      return barTicks(signature);
    case "beat":
      return beatTicks(signature);
    case "half":
      return beatTicks(signature) / 2;
    case "quarter":
      return beatTicks(signature) / 4;
    case "eighth":
      return beatTicks(signature) / 8;
    case "off":
      return 1;
  }
}

/** The nearest grid position at or after 0. */
export function snapTicks(ticks: number, grid: number): number {
  return Math.max(0, Math.round(ticks / grid) * grid);
}

/** Where positions snap to, and the shortest a trim can leave a Clip. */
export interface Grid {
  snap: (ticks: number) => number;
  step: number;
}

/** A grid of `step` ticks from the song's start. */
export function fixedGrid(step: number): Grid {
  return { snap: (ticks) => snapTicks(ticks, step), step };
}

/**
 * The song's own grid for `snap`: each time signature's bars and beats,
 * counted from where it starts, so a position snaps to the nearest bar or
 * beat of the grid it is in, or to the start of the next.
 */
export function mapGrid(map: TempoMap, snap: SnapId): Grid {
  const first = map.segments[0]!.timeSignature;
  if (snap === "off") return fixedGrid(1);
  return {
    step: gridTicks(snap, first),
    snap: (ticks) => {
      const at = Math.max(0, ticks);
      const segment = segmentAt(map, at);
      const step = gridTicks(snap, segment.timeSignature);
      const snapped = segment.gridTick + Math.round((at - segment.gridTick) / step) * step;
      const next = map.segments.find((s) => s.tick > at && s.gridTick === s.tick);
      return next && (snapped > next.tick || next.tick - at < Math.abs(snapped - at)) ? next.tick : snapped;
    },
  };
}

/** Zoom is how many pixels one bar is drawn as. */
export const ZOOM_LEVELS = [12, 24, 48, 96, 192, 384, 768] as const;
export const DEFAULT_ZOOM = 96;

/** One zoom step in or out (`steps` of -1 or 1), stopping at the ends. */
export function zoomedBy(pxPerBar: number, steps: number): number {
  const from = Math.max(0, ZOOM_LEVELS.indexOf(pxPerBar as (typeof ZOOM_LEVELS)[number]));
  return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, from + steps))]!;
}

/** Pixels across the timeline for a length in ticks. */
export function ticksToPx(ticks: number, pxPerBar: number, bar: number): number {
  return (ticks / bar) * pxPerBar;
}

/** A distance in pixels as a whole number of ticks. */
export function pxToTicks(px: number, pxPerBar: number, bar: number): number {
  return Math.round((px / pxPerBar) * bar);
}

/** Whether `track` can hold `clip`: Pattern Clips and Audio Clips don't mix. */
export function accepts(track: Track, clip: Clip): boolean {
  return track.kind === "audio" ? clip.kind === "audio" : clip.kind === "pattern";
}

/** What a drag on a Clip is doing: moving it, or trimming one of its ends. */
export type DragMode = "move" | "trimStart" | "trimEnd";

export interface Span {
  start: number;
  length: number;
}

/** Where a Clip is on the timeline, in ticks: fractional for an Audio Clip's end. */
export function spanOf(clip: Clip, map: TempoMap): Span {
  return { start: clip.start, length: clipEnd(clip, map) - clip.start };
}

/**
 * Where a Clip ends up after dragging `deltaTicks` in `mode`, snapped to
 * `grid`. A Clip never starts before 0 and never becomes shorter than one
 * grid step, so a trim can't turn it inside out. A move keeps the length in
 * ticks; an Audio Clip's is worked out again from its seconds where it lands.
 */
export function dragged(clip: Span, mode: DragMode, deltaTicks: number, grid: Grid): Span {
  const end = clip.start + clip.length;
  switch (mode) {
    case "move":
      return { start: grid.snap(clip.start + deltaTicks), length: clip.length };
    case "trimStart": {
      const start = Math.min(grid.snap(clip.start + deltaTicks), end - grid.step);
      return { start: Math.max(0, start), length: end - Math.max(0, start) };
    }
    case "trimEnd": {
      const trimmed = Math.max(grid.snap(end + deltaTicks), clip.start + grid.step);
      return { start: clip.start, length: trimmed - clip.start };
    }
  }
}

/** A copy of `clip` at `start`, under a new id. */
export function copyOf(clip: Clip, start: number, id: string): Clip {
  return { ...structuredClone(clip), id, start };
}

/** A new, empty Pattern Clip of `length` ticks at `start`. */
export function newPatternClip(start: number, length: number, id: string): PatternClip {
  return { id, kind: "pattern", start, length, notes: [] };
}

/**
 * The loop region a drag from `from` to `to` on the ruler sets: snapped, in
 * order, and never empty however short the drag was.
 */
export function loopRegion(from: number, to: number, grid: Grid): { start: number; end: number } {
  const [low, high] = from <= to ? [from, to] : [to, from];
  const start = grid.snap(low);
  return { start, end: Math.max(grid.snap(high), start + grid.step) };
}

/**
 * How far the timeline runs, in ticks: to a bar line a bar past the last
 * Clip, Tempo Change or Section, and at least `least` bars.
 */
export function timelineEnd(
  tracks: readonly Track[],
  map: TempoMap,
  least: number,
  sections: readonly Section[] = [],
): number {
  const ends = [
    ...tracks.flatMap((track) => (track.clips as Clip[]).map((clip) => clipEnd(clip, map))),
    ...sections.map((section) => sectionTicks(section, map).end),
  ];
  const end = Math.max(0, map.segments.at(-1)!.tick, ...ends);
  const { bar, beat, tick } = barBeatTick(map, end);
  const lastBar = beat === 1 && tick === 0 && Number.isInteger(end) ? bar - 1 : bar;
  return barStart(map, Math.max(least, lastBar + 1) + 1);
}

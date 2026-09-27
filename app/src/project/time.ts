/**
 * Musical time. Positions and lengths are integer ticks, `TICKS_PER_BEAT` to
 * a quarter note, the same unit the Audio Engine schedules in.
 */

/** Must match the engine's `TICKS_PER_BEAT`. */
export const TICKS_PER_BEAT = 960;

export interface TimeSignature {
  beatsPerBar: number;
  /** The note value of one beat: 4 for quarter notes, 8 for eighths. */
  beatUnit: number;
}

export const BEAT_UNITS = [1, 2, 4, 8, 16, 32] as const;

export function beatTicks(signature: TimeSignature): number {
  return (TICKS_PER_BEAT * 4) / signature.beatUnit;
}

export function barTicks(signature: TimeSignature): number {
  return beatTicks(signature) * signature.beatsPerBar;
}

export function sameSignature(a: TimeSignature, b: TimeSignature): boolean {
  return a.beatsPerBar === b.beatsPerBar && a.beatUnit === b.beatUnit;
}

/**
 * What a tempo map is made from: a Project's starting tempo and time
 * signature and its Tempo Changes. A change's `null` keeps what came before.
 */
export interface TempoMapSource {
  tempo: number;
  timeSignature: TimeSignature;
  tempoChanges: readonly { tick: number; tempo: number | null; timeSignature: TimeSignature | null }[];
}

/** From the song's start, or a Tempo Change, to the next. */
export interface TempoSegment {
  tick: number;
  tempo: number;
  timeSignature: TimeSignature;
  /** Seconds from the song's start to `tick`. */
  seconds: number;
  /** Where this segment's bar grid starts: its last change of time signature. */
  gridTick: number;
  /** Bars before `gridTick`, counting from 0. */
  gridBar: number;
}

/**
 * The song's tempo and time signature over time: the one place ticks become
 * seconds. Tempo is in quarter notes per minute, so only the tempo moves
 * ticks in time; a time signature moves the bar grid, which counts from the
 * change that set it. It mirrors the Audio Engine's `TempoMap`.
 */
export interface TempoMap {
  /** In order; the first is at tick 0. */
  segments: readonly TempoSegment[];
}

const maps = new WeakMap<TempoMapSource, TempoMap>();

/** The tempo map of a Project (or anything shaped like one). */
export function tempoMapOf(source: TempoMapSource): TempoMap {
  let map = maps.get(source);
  if (!map) {
    map = buildTempoMap(source);
    maps.set(source, map);
  }
  return map;
}

function buildTempoMap(source: TempoMapSource): TempoMap {
  let previous: TempoSegment = {
    tick: 0,
    tempo: source.tempo,
    timeSignature: source.timeSignature,
    seconds: 0,
    gridTick: 0,
    gridBar: 0,
  };
  const segments = [previous];
  for (const change of source.tempoChanges.toSorted((a, b) => a.tick - b.tick)) {
    if (change.tick <= previous.tick) continue;
    const timeSignature = change.timeSignature ?? previous.timeSignature;
    const newGrid = !sameSignature(timeSignature, previous.timeSignature);
    const segment: TempoSegment = {
      tick: change.tick,
      tempo: change.tempo ?? previous.tempo,
      timeSignature,
      seconds: previous.seconds + ticksToSeconds(change.tick - previous.tick, previous.tempo),
      gridTick: newGrid ? change.tick : previous.gridTick,
      gridBar: newGrid
        ? previous.gridBar + Math.ceil((change.tick - previous.gridTick) / barTicks(previous.timeSignature))
        : previous.gridBar,
    };
    segments.push(segment);
    previous = segment;
  }
  return { segments };
}

/** Seconds for `ticks` at one tempo. */
export function ticksToSeconds(ticks: number, tempo: number): number {
  return (ticks * 60) / (tempo * TICKS_PER_BEAT);
}

/** The segment `tick` is in. */
export function segmentAt(map: TempoMap, tick: number): TempoSegment {
  const { segments } = map;
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (segments[middle]!.tick <= tick) low = middle;
    else high = middle - 1;
  }
  return segments[low]!;
}

export function tempoAt(map: TempoMap, tick: number): number {
  return segmentAt(map, tick).tempo;
}

export function signatureAt(map: TempoMap, tick: number): TimeSignature {
  return segmentAt(map, tick).timeSignature;
}

/** Seconds from the song's start to `tick`. */
export function secondsAt(map: TempoMap, tick: number): number {
  const segment = segmentAt(map, Math.max(0, tick));
  return segment.seconds + ticksToSeconds(Math.max(0, tick) - segment.tick, segment.tempo);
}

/** The tick `seconds` from the song's start falls on, fractional between ticks. */
export function tickAt(map: TempoMap, seconds: number): number {
  const at = Math.max(0, seconds);
  const segment = map.segments.findLast((s) => s.seconds <= at) ?? map.segments[0]!;
  return segment.tick + ((at - segment.seconds) * segment.tempo * TICKS_PER_BEAT) / 60;
}

/** Seconds to the millisecond, for reading rather than for playing. */
export function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** Seconds from `start` to `end` ticks. */
export function secondsBetween(map: TempoMap, start: number, end: number): number {
  return secondsAt(map, end) - secondsAt(map, start);
}

/** The tick `seconds` after `start`: where audio starting there ends. */
export function tickAfter(map: TempoMap, start: number, seconds: number): number {
  return tickAt(map, secondsAt(map, start) + seconds);
}

/** The bar (from 1), beat (from 1) and tick into the beat that `ticks` falls on. */
export function barBeatTick(map: TempoMap, ticks: number): { bar: number; beat: number; tick: number } {
  const whole = Math.max(0, Math.floor(ticks));
  const segment = segmentAt(map, whole);
  const into = whole - segment.gridTick;
  const bar = barTicks(segment.timeSignature);
  const beat = beatTicks(segment.timeSignature);
  return {
    bar: segment.gridBar + Math.floor(into / bar) + 1,
    beat: Math.floor((into % bar) / beat) + 1,
    tick: into % beat,
  };
}

/** Where bar `bar` (counting from 1) starts. */
export function barStart(map: TempoMap, bar: number): number {
  const segment = map.segments.findLast((s) => s.gridBar + 1 <= bar) ?? map.segments[0]!;
  // A later segment in the same grid (a tempo alone) doesn't move bar lines.
  const grid = map.segments.find((s) => s.gridTick === segment.gridTick)!;
  return grid.gridTick + (bar - 1 - grid.gridBar) * barTicks(grid.timeSignature);
}

/** Whether a bar starts on `tick`. */
export function isBarLine(map: TempoMap, tick: number): boolean {
  const segment = segmentAt(map, tick);
  return Number.isInteger(tick) && (tick - segment.gridTick) % barTicks(segment.timeSignature) === 0;
}

/** Every bar line from `from` to `to` ticks, both included, with its bar number. */
export function barLines(map: TempoMap, from: number, to: number): { tick: number; bar: number }[] {
  const lines = [];
  let bar = barBeatTick(map, Math.max(0, from)).bar;
  for (let tick = barStart(map, bar); tick <= to; tick = barStart(map, ++bar)) {
    if (tick >= from) lines.push({ tick, bar });
  }
  return lines;
}

/** Every beat from `from` to `to` ticks, both included. */
export function beatLines(map: TempoMap, from: number, to: number): number[] {
  const lines: number[] = [];
  let bar = barBeatTick(map, Math.max(0, from)).bar;
  for (let start = barStart(map, bar); start <= to; start = barStart(map, ++bar)) {
    const beat = beatTicks(signatureAt(map, start));
    const end = barStart(map, bar + 1);
    for (let tick = start; tick < end && tick <= to; tick += beat) if (tick >= from) lines.push(tick);
  }
  return lines;
}

/** Where `tick` is in bars, counting from 1: 2.5 is half way through bar 2. */
export function barsAt(map: TempoMap, tick: number): number {
  const { bar } = barBeatTick(map, tick);
  const start = barStart(map, bar);
  return bar + (Math.max(0, tick) - start) / (barStart(map, bar + 1) - start);
}

/** The tick `bars` falls on, counting from 1: the inverse of `barsAt`. */
export function tickAtBars(map: TempoMap, bars: number): number {
  const bar = Math.max(1, Math.floor(bars));
  const start = barStart(map, bar);
  return start + (Math.max(1, bars) - bar) * (barStart(map, bar + 1) - start);
}

/** A position as bar.beat.tick, counting bars and beats from 1. */
export function formatPosition(ticks: number, map: TempoMap): string {
  const { bar, beat, tick } = barBeatTick(map, ticks);
  return `${bar}.${beat}.${String(tick).padStart(3, "0")}`;
}

/** A map with one tempo and time signature throughout. */
export function constantTempoMap(tempo: number, timeSignature: TimeSignature): TempoMap {
  return tempoMapOf({ tempo, timeSignature, tempoChanges: [] });
}

import type { EngineCommand } from "../audio/audio-output";
import { barTicks, barStart, barBeatTick, type TempoMap, type TimeSignature } from "../project/time";

/** What the transport bar controls, apart from play and stop. */
export interface TransportSettings {
  /** Quarter notes per minute. */
  tempo: number;
  timeSignature: TimeSignature;
  loop: boolean;
  /**
   * The region dragged on the timeline's ruler or typed in the loop fields,
   * in ticks. Only while `loopRegionSet`: until then, and after "Whole
   * song", what plays is the whole song, or the selected Section.
   */
  loopStart: number;
  loopEnd: number;
  loopRegionSet: boolean;
  metronome: boolean;
}

export const MIN_TEMPO = 20;
export const MAX_TEMPO = 999;

export const DEFAULT_TRANSPORT: TransportSettings = {
  tempo: 120,
  timeSignature: { beatsPerBar: 4, beatUnit: 4 },
  loop: false,
  loopStart: 0,
  loopEnd: barTicks({ beatsPerBar: 4, beatUnit: 4 }),
  loopRegionSet: false,
  metronome: false,
};

/** What Play plays: the stretch it loops, with Loop on, or stops at the end of, with it off. */
export interface PlayRange {
  start: number;
  end: number;
  /** What it is, as the transport bar says: "Whole song", a Section's name, or "Loop region". */
  label: string;
}

/**
 * What Play plays: the Section selected on the timeline, else the region
 * dragged on the ruler, else the whole song, from its start to the bar
 * line after the last Clip ends, so a looped song comes round in time. A
 * song with nothing in it plays its first bar: Play stops at its end, or
 * loops it with Loop on, rather than running on for ever over nothing.
 */
export function playRange(
  settings: Pick<TransportSettings, "loopStart" | "loopEnd" | "loopRegionSet">,
  map: TempoMap,
  songEnd: number,
  section: { name: string; start: number; end: number } | null,
): PlayRange {
  if (section) return { start: section.start, end: section.end, label: section.name };
  if (settings.loopRegionSet) return { start: settings.loopStart, end: settings.loopEnd, label: "Loop region" };
  if (songEnd <= 0) return { start: 0, end: barStart(map, 2), label: "Whole song" };
  const { bar, beat, tick } = barBeatTick(map, songEnd);
  const end = beat === 1 && tick === 0 ? songEnd : barStart(map, bar + 1);
  return { start: 0, end, label: "Whole song" };
}

/**
 * The commands that put the engine's transport into `settings`, playing
 * `range`: looping it with Loop on, and stopping at its end, back at its
 * start, with Loop off, except while `recording`, when it plays on.
 */
export function transportCommands(
  settings: TransportSettings,
  range: Pick<PlayRange, "start" | "end">,
  { recording = false }: { recording?: boolean } = {},
): EngineCommand[] {
  const { tempo, timeSignature, loop, metronome } = settings;
  // While a take is recorded, playback runs on past the end, so the take is never cut off.
  const stopAt = recording ? range.start : range.end;
  return [
    { type: "setTempo", bpm: tempo },
    { type: "setTimeSignature", ...timeSignature },
    { type: "setLoop", startTick: range.start, endTick: range.end, enabled: loop },
    { type: "setPlayRange", startTick: range.start, endTick: stopAt },
    { type: "setMetronome", on: metronome },
  ];
}

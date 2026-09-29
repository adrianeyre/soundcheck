/**
 * Where "Add to song" puts a recording from the Mixer or Pads page: at the
 * Editor's playhead, the start of the bar it is in, or the song's start; on a
 * new Audio Track, or on the selected one where it has room. And, the take
 * being audio that isn't stretched, whether the mix's tempo was the song's
 * there.
 */
import type { Command } from "../project/commands";
import { type AudioTrack, clipEnd, type Project } from "../project/model";
import { barBeatTick, barStart, formatPosition, tempoAt, tempoMapOf, tickAfter } from "../project/time";

/** Where the take starts. */
export type TakePlace = "playhead" | "bar" | "start";
/** Which Audio Track it goes on. */
export type TakeTrack = "new" | "selected";

export interface TakePlacement {
  /** The tick the take starts at. */
  at: number;
  /** The Audio Track it goes on; null for a new one. */
  track: AudioTrack | null;
  /** Why it isn't on the selected Audio Track, where that was asked for. */
  fallback: string | null;
}

export function placeTake(
  project: Project,
  options: { playhead: number; seconds: number; place: TakePlace; track: TakeTrack; selectedTrackId: string | null },
): TakePlacement {
  const map = tempoMapOf(project);
  const playhead = Math.max(0, Math.round(options.playhead));
  const at = options.place === "start" ? 0 : options.place === "bar" ? barStart(map, barBeatTick(map, playhead).bar) : playhead;
  if (options.track === "new") return { at, track: null, fallback: null };
  const chosen = project.tracks.find((track) => track.id === options.selectedTrackId);
  if (!chosen) return { at, track: null, fallback: "no Track is selected in the Editor" };
  if (chosen.kind !== "audio") return { at, track: null, fallback: `${chosen.name} isn't an Audio Track` };
  const end = tickAfter(map, at, options.seconds);
  if (chosen.clips.some((clip) => clip.start < end && clipEnd(clip, map) > at)) {
    return { at, track: null, fallback: `${chosen.name} already has a Clip there` };
  }
  return { at, track: chosen, fallback: null };
}

/** Where `tick` is, as the musician reads it: "bar 5", or "5.2.480" off a bar line. */
export function describeTick(project: Project, tick: number): string {
  const map = tempoMapOf(project);
  const { bar, beat, tick: into } = barBeatTick(map, tick);
  return beat === 1 && into === 0 ? `bar ${bar}` : formatPosition(tick, map);
}

/** A BPM as it is said: to two decimal places at most. */
export function roundBpm(bpm: number): number {
  return Math.round(bpm * 100) / 100;
}

/** The song's tempo at `tick`, where the mix's `bpm` differs from it; null where they agree (or the mix had none). */
export function tempoMismatch(project: Project, tick: number, bpm: number | null): number | null {
  if (bpm === null || !(bpm > 0)) return null;
  const song = tempoAt(tempoMapOf(project), tick);
  return Math.abs(roundBpm(bpm) - song) < 0.01 ? null : song;
}

/**
 * The song's tempo at `tick` set to `bpm`: the Tempo Change in force there,
 * if one sets a tempo, or else the song's own tempo.
 */
export function setTempoAt(project: Project, tick: number, bpm: number): Command {
  const tempo = roundBpm(bpm);
  const change = project.tempoChanges
    .filter((c) => c.tick > 0 && c.tick <= tick && c.tempo !== null)
    .toSorted((a, b) => a.tick - b.tick)
    .at(-1);
  return change ? { type: "setTempoChange", tempoChangeId: change.id, tempo } : { type: "setTempo", tempo };
}

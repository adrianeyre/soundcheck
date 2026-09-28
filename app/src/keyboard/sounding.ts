/**
 * Which notes are sounding at a tick of the song: what a piano drawn beside
 * the sequencer lights up while the song plays. Worked out from the
 * Project's notes and the engine's reported position, never from audio.
 */
import type { PatternClip, Track } from "../project/model";

/** The pitches of `clip` sounding at `tick` of the song. */
export function soundingInClip(clip: PatternClip, tick: number): Set<number> {
  const at = tick - clip.start;
  const pitches = new Set<number>();
  if (at < 0 || at >= clip.length) return pitches;
  for (const note of clip.notes) if (note.start <= at && at < note.start + note.length) pitches.add(note.pitch);
  return pitches;
}

/** The pitches every Pattern Clip of `track` is sounding at `tick`; none for an Audio Track or a muted one. */
export function soundingOnTrack(track: Track, tick: number): Set<number> {
  const pitches = new Set<number>();
  if (track.kind !== "instrument" || track.mixer.mute) return pitches;
  for (const clip of track.clips) for (const pitch of soundingInClip(clip, tick)) pitches.add(pitch);
  return pitches;
}

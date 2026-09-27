/**
 * Turning the live notes the Audio Engine recorded into a Pattern Clip.
 *
 * The engine logs a note where it arrives, as a transport position in ticks
 * (`RecordedNoteEvent`). Everything here is pure: pairing note-ons with
 * note-offs, closing whatever is still held when recording stops, optionally
 * snapping starts to the Step Sequencer's step size, and building the Project
 * commands that put the result in a Clip. That keeps the decisions testable
 * without an audio device or a clock.
 */
import type { RecordedNoteEvent } from "../audio/audio-output";
import type { Command } from "../project/commands";
import type { InstrumentTrack, Note, PatternClip } from "../project/model";

/** The shortest note a key press can leave behind: one tick. */
const MIN_LENGTH = 1;

export interface RecordingOptions {
  /** The Track being recorded onto. */
  track: InstrumentTrack;
  /** The Clip to record into, or null to make a new one. */
  clip: PatternClip | null;
  /** Where recording started, in song ticks. A new Clip starts here. */
  startTick: number;
  /** Where recording stopped. A note still held down ends here. */
  stopTick: number;
  /** A new Clip's length, in ticks. */
  newClipLength: number;
  /** Snap note starts to a multiple of this, or null to leave them alone. */
  quantiseTicks: number | null;
  /** The id a new Clip gets. */
  newClipId: () => string;
}

/**
 * Pair note-ons with note-offs, in song ticks. Playing the same pitch again
 * before releasing it ends the first note there; anything still held when
 * recording stops ends at `stopTick`.
 */
export function pairRecordedNotes(events: readonly RecordedNoteEvent[], stopTick: number): Note[] {
  const notes: Note[] = [];
  const held = new Map<number, { start: number; velocity: number }>();

  const close = (pitch: number, end: number) => {
    const start = held.get(pitch);
    if (!start) return;
    held.delete(pitch);
    notes.push({
      pitch,
      start: start.start,
      length: Math.max(MIN_LENGTH, Math.round(end - start.start)),
      velocity: start.velocity,
    });
  };

  for (const event of events) {
    if (event.on) {
      close(event.pitch, event.tick);
      held.set(event.pitch, { start: Math.round(event.tick), velocity: event.velocity });
    } else {
      close(event.pitch, event.tick);
    }
  }
  // Deleting the current key while walking a Map is safe.
  for (const pitch of held.keys()) close(pitch, stopTick);

  return notes.toSorted((a, b) => a.start - b.start || a.pitch - b.pitch);
}

/** Snap each note's start to the nearest multiple of `ticks`; lengths stay. */
export function quantiseStarts(notes: readonly Note[], ticks: number): Note[] {
  if (ticks <= 0) return [...notes];
  return notes.map((note) => ({ ...note, start: Math.round(note.start / ticks) * ticks }));
}

/**
 * The commands that put `events` in a Clip, as one undo step. Empty when
 * nothing playable was recorded, so pressing record and playing nothing
 * leaves the Project alone.
 *
 * Notes are placed relative to the Clip, and recording appends: what was
 * already in the Clip stays.
 */
export function recordingCommands(events: readonly RecordedNoteEvent[], options: RecordingOptions): Command[] {
  const { clip, startTick, stopTick, newClipLength, quantiseTicks } = options;
  // A Clip starts on a tick, and the transport position is a fraction of one.
  const clipStart = clip ? clip.start : Math.max(0, Math.round(startTick));
  const clipLength = clip ? clip.length : newClipLength;

  let notes = pairRecordedNotes(events, stopTick);
  if (quantiseTicks !== null) notes = quantiseStarts(notes, quantiseTicks);

  const recorded = notes
    .map((note) => ({ ...note, start: note.start - clipStart }))
    // A Clip is a window: a note outside it has nowhere to go.
    .filter((note) => note.start >= 0 && note.start < clipLength)
    .map((note) => ({ ...note, length: Math.min(note.length, clipLength - note.start) }));
  if (recorded.length === 0) return [];

  if (clip) {
    return [{ type: "setPatternNotes", clipId: clip.id, notes: [...clip.notes, ...recorded] }];
  }
  const created: PatternClip = {
    id: options.newClipId(),
    kind: "pattern",
    start: clipStart,
    length: clipLength,
    notes: recorded,
  };
  return [{ type: "addClip", trackId: options.track.id, clip: created }];
}

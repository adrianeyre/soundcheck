/**
 * The Note Tools: whole-Clip transformations of a Pattern Clip's notes, as
 * FL Studio's piano roll tools and Cubase's MIDI functions offer them:
 * transpose, fit to a key, humanise, legato, strum, arpeggiate, chop,
 * reverse, mirror, velocity ramps, and doubling or halving the speed.
 *
 * As `piano-roll.ts` does, each takes notes and returns new ones, which the
 * Widget makes one `setPatternNotes` command, so each is one undo step. Every
 * result is valid for the Clip: notes start inside it, have a length of at
 * least one tick, keep to MIDI's pitches, and no two share a pitch and a
 * start (the later one wins, as a Piano Roll edit does).
 */
import type { Note } from "../project/model";
import { type MusicalKey, snapToKey } from "../theory/theory";

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Notes brought inside the Clip and MIDI's range, with no two on one pitch and start. */
export function tidy(notes: readonly Note[], clipLength: number): Note[] {
  const byKey = new Map<string, Note>();
  for (const note of notes) {
    const start = Math.round(note.start);
    if (start < 0 || start >= clipLength || note.pitch < 0 || note.pitch > 127) continue;
    const tidied: Note = {
      pitch: Math.round(note.pitch),
      start,
      length: Math.max(1, Math.round(note.length)),
      velocity: clamp(note.velocity, 0, 1),
    };
    byKey.set(`${tidied.pitch}:${tidied.start}`, tidied);
  }
  return [...byKey.values()].toSorted((a, b) => a.start - b.start || a.pitch - b.pitch);
}

/**
 * A small, seeded random number generator (mulberry32), so a humanise can
 * be tested, and is the same each time it is given the same seed.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Every note `semitones` higher (or lower); any that would leave MIDI's range stay where they are. */
export function transpose(notes: readonly Note[], semitones: number, clipLength: number): Note[] {
  const fits = notes.every((note) => note.pitch + semitones >= 0 && note.pitch + semitones <= 127);
  return tidy(fits ? notes.map((note) => ({ ...note, pitch: note.pitch + semitones })) : notes, clipLength);
}

/** Every note moved to the nearest pitch of `key`. */
export function fitToKey(notes: readonly Note[], key: MusicalKey, clipLength: number): Note[] {
  return tidy(
    notes.map((note) => ({ ...note, pitch: snapToKey(note.pitch, key) })),
    clipLength,
  );
}

export interface HumaniseOptions {
  /** The most a start moves either way, in ticks. */
  timingTicks: number;
  /** The most a velocity moves either way, 0 to 1. */
  velocity: number;
  seed: number;
}

/** Nudge every note's start and velocity by a little at random, as a player would. */
export function humanise(notes: readonly Note[], options: HumaniseOptions, clipLength: number): Note[] {
  const random = seededRandom(options.seed);
  const spread = () => random() * 2 - 1;
  return tidy(
    notes.map((note) => ({
      ...note,
      start: clamp(note.start + Math.round(spread() * options.timingTicks), 0, clipLength - 1),
      velocity: clamp(note.velocity + spread() * options.velocity, 0.05, 1),
    })),
    clipLength,
  );
}

/** Every note lengthened, or shortened, to reach the next start after its own; the last to the Clip's end. */
export function legato(notes: readonly Note[], clipLength: number): Note[] {
  const starts = [...new Set(notes.map((note) => note.start))].toSorted((a, b) => a - b);
  return tidy(
    notes.map((note) => {
      const next = starts.find((start) => start > note.start) ?? clipLength;
      return { ...note, length: next - note.start };
    }),
    clipLength,
  );
}

/** Every note at most `ticks` long, as a staccato. */
export function staccato(notes: readonly Note[], ticks: number, clipLength: number): Note[] {
  return tidy(
    notes.map((note) => ({ ...note, length: Math.min(note.length, ticks) })),
    clipLength,
  );
}

/**
 * The notes of each chord (those starting together) spread out, lowest
 * first or highest first, each `ticks` after the one before, as a guitarist
 * strums. Each keeps its end.
 */
export function strum(notes: readonly Note[], ticks: number, downward: boolean, clipLength: number): Note[] {
  const chords = Map.groupBy(notes, (note) => note.start);
  const strummed = [...chords.values()].flatMap((chord) =>
    chord
      .toSorted((a, b) => (downward ? b.pitch - a.pitch : a.pitch - b.pitch))
      .map((note, index) => {
        const delay = Math.min(index * ticks, note.length - 1);
        return { ...note, start: note.start + delay, length: note.length - delay };
      }),
  );
  return tidy(strummed, clipLength);
}

export type ArpeggioDirection = "up" | "down" | "upDown" | "random";

/**
 * Each chord (the notes starting together) played one note at a time for
 * as long as it lasts, a step of `stepTicks` each, going `direction`, over
 * `octaves` octaves. Single notes are left as they are.
 */
export function arpeggiate(
  notes: readonly Note[],
  stepTicks: number,
  direction: ArpeggioDirection,
  octaves: number,
  clipLength: number,
  seed = 1,
): Note[] {
  const random = seededRandom(seed);
  const chords = Map.groupBy(notes, (note) => note.start);
  const played = [...chords.values()].flatMap((chord) => {
    if (chord.length < 2) return chord;
    const length = Math.max(...chord.map((note) => note.length));
    const velocity = Math.max(...chord.map((note) => note.velocity));
    const start = chord[0]!.start;
    const up = Array.from({ length: Math.max(1, octaves) }, (_, octave) =>
      chord.map((note) => note.pitch + 12 * octave).toSorted((a, b) => a - b),
    ).flat();
    const order =
      direction === "up" ? up : direction === "down" ? up.toReversed() : [...up, ...up.slice(1, -1).toReversed()];
    const steps = Math.max(1, Math.floor(length / stepTicks));
    return Array.from({ length: steps }, (_, step) => ({
      pitch: direction === "random" ? up[Math.floor(random() * up.length)]! : order[step % order.length]!,
      start: start + step * stepTicks,
      length: stepTicks,
      velocity,
    }));
  });
  return tidy(played, clipLength);
}

/** Every note cut into pieces `ticks` long, as FL Studio's chop does. */
export function chop(notes: readonly Note[], ticks: number, clipLength: number): Note[] {
  const pieces = notes.flatMap((note) =>
    Array.from({ length: Math.max(1, Math.ceil(note.length / ticks)) }, (_, index) => ({
      ...note,
      start: note.start + index * ticks,
      length: Math.min(ticks, note.length - index * ticks),
    })),
  );
  return tidy(pieces, clipLength);
}

/** The notes played backwards: each ends where the one mirrored across the Clip started. */
export function reverse(notes: readonly Note[], clipLength: number): Note[] {
  return tidy(
    notes.map((note) => ({ ...note, start: Math.max(0, clipLength - note.start - note.length) })),
    clipLength,
  );
}

/** The notes turned upside down around the middle of their range: highest becomes lowest. */
export function mirror(notes: readonly Note[], clipLength: number): Note[] {
  if (notes.length === 0) return [];
  const pitches = notes.map((note) => note.pitch);
  const axis = Math.min(...pitches) + Math.max(...pitches);
  return tidy(
    notes.map((note) => ({ ...note, pitch: axis - note.pitch })),
    clipLength,
  );
}

/** Velocities ramped in a straight line from `from` at the Clip's start to `to` at its end: a crescendo or fade. */
export function velocityRamp(notes: readonly Note[], from: number, to: number, clipLength: number): Note[] {
  return tidy(
    notes.map((note) => ({ ...note, velocity: from + ((to - from) * note.start) / Math.max(1, clipLength - 1) })),
    clipLength,
  );
}

/** Every velocity scaled towards (below 1) or away from (above 1) their average. */
export function velocityContrast(notes: readonly Note[], amount: number, clipLength: number): Note[] {
  if (notes.length === 0) return [];
  const average = notes.reduce((sum, note) => sum + note.velocity, 0) / notes.length;
  return tidy(
    notes.map((note) => ({ ...note, velocity: average + (note.velocity - average) * amount })),
    clipLength,
  );
}

/** Every note's start and length multiplied by `factor`: 2 plays at half speed, 0.5 at double. */
export function stretch(notes: readonly Note[], factor: number, clipLength: number): Note[] {
  return tidy(
    notes.map((note) => ({ ...note, start: note.start * factor, length: note.length * factor })),
    clipLength,
  );
}

/** Each note joined by the same note `semitones` away, as a doubling in octaves, fifths or thirds. */
export function double(notes: readonly Note[], semitones: number, clipLength: number): Note[] {
  return tidy(
    [...notes, ...notes.map((note) => ({ ...note, pitch: note.pitch + semitones }))],
    clipLength,
  );
}

/**
 * Swing: every note on the second of each pair of `gridTicks` steps pushed
 * later by `amount` (0 to 1) of a step, as an MPC's swing does.
 */
export function swing(notes: readonly Note[], gridTicks: number, amount: number, clipLength: number): Note[] {
  return tidy(
    notes.map((note) => {
      const step = Math.round(note.start / gridTicks);
      const onGrid = Math.abs(note.start - step * gridTicks) < gridTicks / 4;
      return onGrid && step % 2 === 1 ? { ...note, start: note.start + Math.round(amount * gridTicks * 0.5) } : note;
    }),
    clipLength,
  );
}

/** Take out notes whose velocity is below `threshold`: ghost notes gone. */
export function removeQuiet(notes: readonly Note[], threshold: number, clipLength: number): Note[] {
  return tidy(
    notes.filter((note) => note.velocity >= threshold),
    clipLength,
  );
}

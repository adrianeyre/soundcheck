/**
 * The Piano Roll's view of a Pattern Clip: notes at any pitch, start, length
 * and velocity, on a snap grid. Like the Step Sequencer it is a way of
 * editing the Clip's notes, nothing more; both read and write the same list.
 *
 * Nothing here changes a Project. Every function takes notes and returns new
 * ones, which `PianoRoll.tsx` turns into one `setPatternNotes` command, so
 * every edit is one undo step.
 *
 * Notes have no ids, so a selection is a set of keys: a note is its pitch and
 * start. Two notes of one pitch starting together would sound as one, so an
 * edit that lands a note on another's key replaces the one it lands on, and
 * keys stay unique.
 */
import type { Instrument, Note } from "../project/model";
import { TICKS_PER_BEAT } from "../project/time";
import { gridRows, type GridRow, pitchName, STEP_VELOCITY } from "./step-grid";

/** Snap grids on offer, as note values; triplets fit three in the space of two. */
export const PIANO_SNAPS = [
  { id: "off", label: "Off", ticks: 1 },
  { id: "1/4", label: "1/4", ticks: TICKS_PER_BEAT },
  { id: "1/8", label: "1/8", ticks: TICKS_PER_BEAT / 2 },
  { id: "1/16", label: "1/16", ticks: TICKS_PER_BEAT / 4 },
  { id: "1/32", label: "1/32", ticks: TICKS_PER_BEAT / 8 },
  { id: "1/4T", label: "1/4 triplet", ticks: (TICKS_PER_BEAT * 2) / 3 },
  { id: "1/8T", label: "1/8 triplet", ticks: TICKS_PER_BEAT / 3 },
  { id: "1/16T", label: "1/16 triplet", ticks: TICKS_PER_BEAT / 6 },
  { id: "1/32T", label: "1/32 triplet", ticks: TICKS_PER_BEAT / 12 },
] as const;

export type PianoSnapId = (typeof PIANO_SNAPS)[number]["id"];

export const DEFAULT_PIANO_SNAP: PianoSnapId = "1/16";

/** A grid step in ticks. Snapping off is a grid of one tick. */
export function snapTicksOf(snap: PianoSnapId): number {
  return PIANO_SNAPS.find((choice) => choice.id === snap)!.ticks;
}

/** How long a drawn note is: one grid step, or a 1/16 with snapping off. */
export function drawLength(grid: number): number {
  return grid > 1 ? grid : TICKS_PER_BEAT / 4;
}

/** Which note a key names. */
export function noteKey(note: Pick<Note, "pitch" | "start">): string {
  return `${note.pitch}:${note.start}`;
}

/** The result of an edit: the Clip's new notes and what is selected after it. */
export interface Edit {
  notes: Note[];
  selection: ReadonlySet<string>;
}

function isSelected(selection: ReadonlySet<string>, note: Note): boolean {
  return selection.has(noteKey(note));
}

/**
 * `kept` plus `edited`, with any kept note that an edited one lands on
 * removed, and the edited notes selected. The Assistant's note tools merge
 * their edits the same way.
 */
export function merged(kept: readonly Note[], edited: readonly Note[]): Edit {
  const selection = new Set(edited.map(noteKey));
  return { notes: [...kept.filter((note) => !selection.has(noteKey(note))), ...edited], selection };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** A new note, snapped down to the grid, at the Step Sequencer's velocity so both editors draw alike. */
export function drawNote(
  notes: readonly Note[],
  pitch: number,
  at: number,
  length: number,
  grid: number,
  clipLength: number,
): Edit {
  const start = clamp(Math.floor(at / grid) * grid, 0, clipLength - 1);
  const note = { pitch, start: Math.round(start), length: Math.max(1, Math.round(length)), velocity: STEP_VELOCITY };
  return merged(notes, [note]);
}

/** Every note but the selected ones. */
export function deleteNotes(notes: readonly Note[], selection: ReadonlySet<string>): Note[] {
  return notes.filter((note) => !isSelected(selection, note));
}

/**
 * Move the selected notes together by `deltaTicks` and `deltaRows`. The
 * note grabbed (`anchor`) lands on the grid and the rest keep their
 * distance from it. None leaves the Clip or the rows: a move that would take
 * one out goes only as far as it can.
 *
 * `rows` are the pitches shown, top to bottom, so a row down is the next
 * pitch in the list: a semitone down on the Synth, the next Pad on drums.
 * A note on a pitch that has no row stays on its pitch.
 */
export function moveNotes(
  notes: readonly Note[],
  selection: ReadonlySet<string>,
  anchor: Note,
  deltaTicks: number,
  deltaRows: number,
  rows: readonly number[],
  grid: number,
  clipLength: number,
): Edit {
  const chosen = notes.filter((note) => isSelected(selection, note));
  if (chosen.length === 0) return { notes: [...notes], selection: new Set(selection) };
  const earliest = Math.min(...chosen.map((note) => note.start));
  const latest = Math.max(...chosen.map((note) => note.start));
  const target = Math.round(anchor.start + deltaTicks);
  const snapped = grid > 1 ? Math.round(target / grid) * grid : target;
  const ticks = clamp(Math.round(snapped - anchor.start), -earliest, clipLength - 1 - latest);

  const indices = chosen.map((note) => rows.indexOf(note.pitch)).filter((index) => index >= 0);
  const rowDelta =
    indices.length === 0 ? 0 : clamp(deltaRows, -Math.min(...indices), rows.length - 1 - Math.max(...indices));

  const moved = chosen.map((note) => {
    const index = rows.indexOf(note.pitch);
    return {
      ...note,
      start: note.start + ticks,
      pitch: index >= 0 ? rows[index + rowDelta]! : note.pitch,
    };
  });
  return merged(
    notes.filter((note) => !isSelected(selection, note)),
    moved,
  );
}

/**
 * Lengthen or shorten the selected notes together by `deltaTicks`. The
 * grabbed note's end lands on the grid; none gets shorter than one grid step.
 */
export function resizeNotes(
  notes: readonly Note[],
  selection: ReadonlySet<string>,
  anchor: Note,
  deltaTicks: number,
  grid: number,
): Note[] {
  const end = anchor.start + anchor.length + deltaTicks;
  const snapped = grid > 1 ? Math.round(end / grid) * grid : end;
  const ticks = Math.round(snapped - anchor.start - anchor.length);
  const least = Math.round(Math.min(grid, TICKS_PER_BEAT / 4));
  return notes.map((note) =>
    isSelected(selection, note) ? { ...note, length: Math.max(least, note.length + ticks) } : note,
  );
}

/** Set the selected notes' velocity, 0 to 1. */
export function setVelocity(notes: readonly Note[], selection: ReadonlySet<string>, velocity: number): Note[] {
  const value = clamp(velocity, 0, 1);
  return notes.map((note) => (isSelected(selection, note) ? { ...note, velocity: value } : note));
}

/**
 * Snap each selected note's start to the nearest grid step inside the Clip;
 * lengths stay. `strength`, 0 to 1, moves each only that part of the way,
 * to the nearest tick: at 0.5 a note goes halfway to its grid step.
 */
export function quantiseNotes(
  notes: readonly Note[],
  selection: ReadonlySet<string>,
  grid: number,
  clipLength: number,
  strength = 1,
): Edit {
  const chosen = notes.filter((note) => isSelected(selection, note));
  const lastStep = Math.floor((clipLength - 1) / grid) * grid;
  const quantised = chosen.map((note) => {
    const step = clamp(Math.round(note.start / grid) * grid, 0, lastStep);
    return { ...note, start: Math.round(note.start + (step - note.start) * clamp(strength, 0, 1)) };
  });
  return merged(
    notes.filter((note) => !isSelected(selection, note)),
    quantised,
  );
}

/** Copied notes, with starts from the earliest of them, and how far apart pastes go. */
export interface Clipboard {
  notes: Note[];
  /** From the earliest start to the latest end, rounded up to the grid. */
  span: number;
}

export function copyNotes(notes: readonly Note[], selection: ReadonlySet<string>, grid: number): Clipboard | null {
  const chosen = notes.filter((note) => isSelected(selection, note));
  if (chosen.length === 0) return null;
  const earliest = Math.min(...chosen.map((note) => note.start));
  const latest = Math.max(...chosen.map((note) => note.start + note.length));
  return {
    notes: chosen.map((note) => ({ ...note, start: note.start - earliest })),
    span: Math.max(1, Math.round(Math.ceil((latest - earliest) / grid) * grid)),
  };
}

/** The copied notes starting `at`; any that would start past the Clip's end are left out. */
export function pasteNotes(notes: readonly Note[], clipboard: Clipboard, at: number, clipLength: number): Edit {
  const pasted = clipboard.notes
    .map((note) => ({ ...note, start: note.start + at }))
    .filter((note) => note.start >= 0 && note.start < clipLength);
  return merged(notes, pasted);
}

/**
 * The rows to show, top to bottom. On the Drum Sampler they are its Pads by
 * name, then any other pitch a note is on, so no note is hidden. Otherwise
 * every MIDI note, highest first.
 */
export function pianoRows(instrument: Instrument, notes: readonly Note[]): GridRow[] {
  if (instrument.type !== "drumSampler") {
    return Array.from({ length: 128 }, (_, index) => {
      const pitch = 127 - index;
      const label = pitchName(pitch);
      return { pitch, label, shaded: label.includes("♯") };
    });
  }
  const rows = gridRows(instrument, 0);
  const onPads = new Set(rows.map((row) => row.pitch));
  const others = [...new Set(notes.map((note) => note.pitch))]
    .filter((pitch) => !onPads.has(pitch))
    .toSorted((a, b) => b - a);
  return [
    ...rows,
    ...others.map((pitch, index) => ({
      pitch,
      label: pitchName(pitch),
      shaded: (rows.length + index) % 2 === 1,
    })),
  ];
}

/**
 * The Step Sequencer's view of a Pattern Clip: a grid of steps (time) by
 * rows. A row is a pitch under the Synth and a pad under the Drum Sampler,
 * which is only a matter of what it is called: either way its steps are
 * notes of one pitch. The grid is a way of editing, nothing more, so a step
 * size is a view setting and changing it loses nothing.
 */
import type { Instrument, Note, PatternClip } from "../project/model";
import { TICKS_PER_BEAT } from "../project/time";

/** Step sizes on offer, as fractions of a whole note. */
export const STEP_SIZES = [
  { label: "1/4", ticks: TICKS_PER_BEAT },
  { label: "1/8", ticks: TICKS_PER_BEAT / 2 },
  { label: "1/16", ticks: TICKS_PER_BEAT / 4 },
  { label: "1/32", ticks: TICKS_PER_BEAT / 8 },
] as const;

export const DEFAULT_STEP_TICKS = TICKS_PER_BEAT / 4;
export const STEP_VELOCITY = 0.8;

/** How many whole steps fit in the Clip. */
export function stepCount(clip: PatternClip, stepTicks: number): number {
  return Math.max(1, Math.floor(clip.length / stepTicks));
}

function inStep(note: Note, pitch: number, step: number, stepTicks: number): boolean {
  const start = step * stepTicks;
  return note.pitch === pitch && note.start >= start && note.start < start + stepTicks;
}

/** Whether a note of `pitch` starts somewhere in `step`. */
export function isStepOn(notes: readonly Note[], pitch: number, step: number, stepTicks: number): boolean {
  return notes.some((note) => inStep(note, pitch, step, stepTicks));
}

/**
 * Turn a step on (a note one step long) or off (every note of that pitch
 * starting in the step). Returns new notes; `notes` is left alone.
 */
export function toggleStep(notes: readonly Note[], pitch: number, step: number, stepTicks: number): Note[] {
  if (isStepOn(notes, pitch, step, stepTicks)) {
    return notes.filter((note) => !inStep(note, pitch, step, stepTicks));
  }
  return [...notes, { pitch, start: step * stepTicks, length: stepTicks, velocity: STEP_VELOCITY }];
}

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

/** C4 is middle C (60). */
export function pitchName(pitch: number): string {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

/** The pitches shown, highest first: two octaves from C of `octave`. */
export function gridPitches(octave: number): number[] {
  const lowest = (octave + 1) * 12;
  return Array.from({ length: 24 }, (_, index) => lowest + 23 - index).filter((p) => p >= 0 && p <= 127);
}

/** One row of the grid: the note its steps play, and what it is called. */
export interface GridRow {
  pitch: number;
  label: string;
  /** Shown darker, so the rows are easy to count: black keys, or alternate pads. */
  shaded: boolean;
}

/**
 * The rows to show for an Instrument, top to bottom: the Drum Sampler's pads
 * by name, in pad order, or two octaves of pitches from C of `octave`.
 */
export function gridRows(instrument: Instrument, octave: number): GridRow[] {
  if (instrument.type === "drumSampler") {
    return instrument.pads.map((pad, index) => ({
      pitch: pad.note,
      label: pad.name,
      shaded: index % 2 === 1,
    }));
  }
  return gridPitches(octave).map((pitch) => {
    const label = pitchName(pitch);
    return { pitch, label, shaded: label.includes("\u266f") };
  });
}

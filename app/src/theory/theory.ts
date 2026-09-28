/**
 * Keys, scales and chords: the music theory the Keyboard, Chords and Note
 * Tools Widgets share, as plain functions of pitches.
 *
 * A key is a root pitch class (0 is C) and a scale. Nothing here knows about
 * a Project; `chordProgressionNotes` turns chords into the Notes a Pattern
 * Clip holds, and the caller makes that one command.
 */
import type { Note } from "../project/model";

/** The names of the twelve pitch classes, from C, with sharps. */
export const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export interface Scale {
  id: string;
  name: string;
  /** Semitones above the root, ascending, starting with 0. */
  intervals: readonly number[];
}

/** Every scale on offer: the modes, the common minors, and the pentatonics and blues. */
export const SCALES: readonly Scale[] = [
  { id: "major", name: "Major (Ionian)", intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: "minor", name: "Natural minor (Aeolian)", intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: "harmonicMinor", name: "Harmonic minor", intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: "melodicMinor", name: "Melodic minor", intervals: [0, 2, 3, 5, 7, 9, 11] },
  { id: "dorian", name: "Dorian", intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: "phrygian", name: "Phrygian", intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: "lydian", name: "Lydian", intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: "mixolydian", name: "Mixolydian", intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: "locrian", name: "Locrian", intervals: [0, 1, 3, 5, 6, 8, 10] },
  { id: "majorPentatonic", name: "Major pentatonic", intervals: [0, 2, 4, 7, 9] },
  { id: "minorPentatonic", name: "Minor pentatonic", intervals: [0, 3, 5, 7, 10] },
  { id: "blues", name: "Blues", intervals: [0, 3, 5, 6, 7, 10] },
  { id: "chromatic", name: "Chromatic", intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

export type ScaleId = (typeof SCALES)[number]["id"];

export function scaleOf(id: string): Scale {
  return SCALES.find((scale) => scale.id === id) ?? SCALES[0]!;
}

/** A key: its root pitch class, 0 (C) to 11 (B), and its scale. */
export interface MusicalKey {
  root: number;
  scale: string;
}

export const DEFAULT_KEY: MusicalKey = { root: 0, scale: "major" };

const mod12 = (value: number) => ((value % 12) + 12) % 12;

/** "C major", "F# Dorian". */
export function keyName(key: MusicalKey): string {
  const scale = scaleOf(key.scale);
  return `${PITCH_CLASSES[mod12(key.root)]} ${scale.name.replace(/ \(.*\)$/, "")}`;
}

/** Whether `pitch` is one of the key's notes. */
export function inKey(pitch: number, key: MusicalKey): boolean {
  return scaleOf(key.scale).intervals.includes(mod12(pitch - key.root));
}

/** The pitch of the key nearest to `pitch`, the lower one on a tie. */
export function snapToKey(pitch: number, key: MusicalKey): number {
  for (let distance = 0; distance < 12; distance++) {
    if (inKey(pitch - distance, key)) return pitch - distance;
    if (inKey(pitch + distance, key)) return pitch + distance;
  }
  return pitch;
}

/** The chord qualities a pad offers, by the intervals above their root. */
export const CHORD_QUALITIES = {
  maj: { symbol: "", name: "major", intervals: [0, 4, 7] },
  min: { symbol: "m", name: "minor", intervals: [0, 3, 7] },
  dim: { symbol: "°", name: "diminished", intervals: [0, 3, 6] },
  aug: { symbol: "+", name: "augmented", intervals: [0, 4, 8] },
  sus2: { symbol: "sus2", name: "suspended second", intervals: [0, 2, 7] },
  sus4: { symbol: "sus4", name: "suspended fourth", intervals: [0, 5, 7] },
  maj7: { symbol: "maj7", name: "major seventh", intervals: [0, 4, 7, 11] },
  min7: { symbol: "m7", name: "minor seventh", intervals: [0, 3, 7, 10] },
  dom7: { symbol: "7", name: "dominant seventh", intervals: [0, 4, 7, 10] },
  m7b5: { symbol: "ø7", name: "half-diminished seventh", intervals: [0, 3, 6, 10] },
  dim7: { symbol: "°7", name: "diminished seventh", intervals: [0, 3, 6, 9] },
  minMaj7: { symbol: "m(maj7)", name: "minor major seventh", intervals: [0, 3, 7, 11] },
  aug7: { symbol: "+7", name: "augmented seventh", intervals: [0, 4, 8, 10] },
  augMaj7: { symbol: "+maj7", name: "augmented major seventh", intervals: [0, 4, 8, 11] },
} as const;

export type ChordQuality = keyof typeof CHORD_QUALITIES;

/** Where a chord's harmony tends to lead, for colouring its pad. */
export type ChordFunction = "tonic" | "subdominant" | "dominant";

export interface Chord {
  /** Pitch class of the root, 0 to 11. */
  root: number;
  quality: ChordQuality;
  /** Its scale degree as a Roman numeral, upper case for major, e.g. "vi" or "V7". */
  numeral: string;
  function: ChordFunction;
}

/** The chord's name as a lead sheet writes it: "Am7", "F#°". */
export function chordName(chord: Pick<Chord, "root" | "quality">): string {
  return `${PITCH_CLASSES[mod12(chord.root)]}${CHORD_QUALITIES[chord.quality].symbol}`;
}

const NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII"];
const FUNCTIONS: readonly ChordFunction[] = ["tonic", "subdominant", "tonic", "subdominant", "dominant", "tonic", "dominant"];

/** The quality whose intervals are exactly `intervals`, if there is one. */
function qualityOf(intervals: readonly number[]): ChordQuality | null {
  const found = (Object.keys(CHORD_QUALITIES) as ChordQuality[]).find((quality) => {
    const want = CHORD_QUALITIES[quality].intervals;
    return want.length === intervals.length && want.every((interval, index) => interval === intervals[index]);
  });
  return found ?? null;
}

/**
 * The chords built on each degree of a seven-note scale by stacking its own
 * thirds: triads, or sevenths with `sevenths`. A scale without seven notes
 * (a pentatonic, the blues, chromatic) borrows the chords of its parent: the
 * major scale for a major-sounding one, the natural minor for the rest.
 */
export function diatonicChords(key: MusicalKey, sevenths = false): Chord[] {
  let intervals = scaleOf(key.scale).intervals;
  if (intervals.length !== 7) intervals = scaleOf(intervals.includes(4) ? "major" : "minor").intervals;
  return intervals.map((_, degree) => {
    const stack = [0, 2, 4, ...(sevenths ? [6] : [])].map((step) => {
      const index = degree + step;
      return intervals[index % 7]! + 12 * Math.floor(index / 7) - intervals[degree]!;
    });
    const quality = qualityOf(stack) ?? (sevenths ? "dom7" : "maj");
    const minorish = CHORD_QUALITIES[quality].intervals[1] === 3;
    const base = NUMERALS[degree]!;
    const numeral = `${minorish ? base.toLowerCase() : base}${CHORD_QUALITIES[quality].symbol.replace(/^m(?!aj)/, "")}`;
    return { root: mod12(key.root + intervals[degree]!), quality, numeral, function: FUNCTIONS[degree]! };
  });
}

/**
 * The MIDI pitches of a chord, its root in the octave that holds `nearPitch`
 * or just above it, in its `inversion`: each inversion moves the lowest note
 * up an octave.
 */
export function chordPitches(chord: Pick<Chord, "root" | "quality">, nearPitch = 60, inversion = 0): number[] {
  const root = nearPitch - mod12(nearPitch) + mod12(chord.root);
  const pitches = CHORD_QUALITIES[chord.quality].intervals.map((interval) => root + interval);
  for (let turn = 0; turn < inversion % pitches.length; turn++) pitches.push(pitches.shift()! + 12);
  return pitches.filter((pitch) => pitch >= 0 && pitch <= 127);
}

/**
 * The inversion of `chord` whose notes move least from `previous`: voice
 * leading, as a keyboard player keeps their hand in one place.
 */
export function voiceLed(chord: Pick<Chord, "root" | "quality">, previous: readonly number[], nearPitch = 60): number[] {
  if (previous.length === 0) return chordPitches(chord, nearPitch);
  const centre = previous.reduce((sum, pitch) => sum + pitch, 0) / previous.length;
  const size = CHORD_QUALITIES[chord.quality].intervals.length;
  const options = [-12, 0].flatMap((shift) =>
    Array.from({ length: size }, (_, inversion) => chordPitches(chord, nearPitch + shift, inversion)),
  );
  const distance = (pitches: number[]) =>
    Math.abs(pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length - centre);
  return options.toSorted((a, b) => distance(a) - distance(b))[0]!;
}

/** A named progression, as scale degrees counted from 1. */
export interface Progression {
  name: string;
  degrees: readonly number[];
}

/** Progressions that songs have leaned on for decades. */
export const PROGRESSIONS: readonly Progression[] = [
  { name: "Pop (I–V–vi–IV)", degrees: [1, 5, 6, 4] },
  { name: "Sensitive (vi–IV–I–V)", degrees: [6, 4, 1, 5] },
  { name: "Fifties (I–vi–IV–V)", degrees: [1, 6, 4, 5] },
  { name: "Jazz turnaround (ii–V–I)", degrees: [2, 5, 1, 1] },
  { name: "Canon (I–V–vi–iii–IV–I–IV–V)", degrees: [1, 5, 6, 3, 4, 1, 4, 5] },
  { name: "Andalusian (i–VII–VI–V)", degrees: [1, 7, 6, 5] },
  { name: "Epic minor (i–VI–III–VII)", degrees: [1, 6, 3, 7] },
  { name: "Twelve-bar blues", degrees: [1, 1, 1, 1, 4, 4, 1, 1, 5, 4, 1, 5] },
];

/** How the notes of each chord are laid out in time. */
export const CHORD_RHYTHMS = [
  { id: "block", name: "Block chords" },
  { id: "stabs", name: "Stabs on the beat" },
  { id: "offbeat", name: "Off-beat stabs" },
  { id: "arpUp", name: "Arpeggio up" },
  { id: "arpDown", name: "Arpeggio down" },
  { id: "arpUpDown", name: "Arpeggio up and down" },
  { id: "broken", name: "Broken (root, then the rest)" },
] as const;

export type ChordRhythm = (typeof CHORD_RHYTHMS)[number]["id"];

export interface ProgressionOptions {
  /** Ticks each chord lasts. */
  chordTicks: number;
  /** Ticks of one beat, for stabs, and of one arpeggio step. */
  stepTicks: number;
  rhythm: ChordRhythm;
  /** 0 to 1. */
  velocity: number;
  /** Where the chords sit: the root's octave holds this pitch. */
  nearPitch: number;
  /** Move each chord as little as it can from the one before. */
  voiceLeading: boolean;
  /** Double each chord's root an octave below. */
  bass: boolean;
}

/**
 * The notes of `chords` one after another from tick 0, each `chordTicks`
 * long, laid out by `rhythm`, trimmed to `clipLength`.
 */
export function chordProgressionNotes(
  chords: readonly Pick<Chord, "root" | "quality">[],
  options: ProgressionOptions,
  clipLength: number,
): Note[] {
  const { chordTicks, stepTicks, rhythm, velocity, nearPitch, voiceLeading, bass } = options;
  const notes: Note[] = [];
  let previous: number[] = [];
  chords.forEach((chord, index) => {
    const start = index * chordTicks;
    if (start >= clipLength) return;
    const length = Math.min(chordTicks, clipLength - start);
    const pitches = voiceLeading ? voiceLed(chord, previous, nearPitch) : chordPitches(chord, nearPitch);
    previous = pitches;
    const add = (pitch: number, at: number, ticks: number, level = velocity) => {
      if (at >= start + length || pitch < 0 || pitch > 127) return;
      notes.push({ pitch, start: at, length: Math.max(1, Math.min(ticks, start + length - at)), velocity: level });
    };
    // The root below the chord's lowest note, an octave down again.
    if (bass) add(pitches[0]! - mod12(pitches[0]! - chord.root) - 12, start, length);
    const steps = Math.max(1, Math.floor(length / stepTicks));
    switch (rhythm) {
      case "block":
        for (const pitch of pitches) add(pitch, start, length);
        break;
      case "stabs":
      case "offbeat": {
        const offset = rhythm === "offbeat" ? stepTicks / 2 : 0;
        for (let step = 0; step < steps; step++)
          for (const pitch of pitches) add(pitch, start + step * stepTicks + offset, stepTicks / 2);
        break;
      }
      case "arpUp":
      case "arpDown":
      case "arpUpDown": {
        const up = pitches;
        const order =
          rhythm === "arpUp" ? up : rhythm === "arpDown" ? up.toReversed() : [...up, ...up.slice(1, -1).toReversed()];
        for (let step = 0; step < steps; step++) add(order[step % order.length]!, start + step * stepTicks, stepTicks);
        break;
      }
      case "broken": {
        add(pitches[0]!, start, stepTicks);
        for (const pitch of pitches.slice(1)) add(pitch, start + stepTicks, length - stepTicks);
        break;
      }
    }
  });
  return notes.toSorted((a, b) => a.start - b.start || a.pitch - b.pitch);
}

/**
 * The chord that the pitches in `pitches` spell, by its lowest possible root,
 * or null: what the Keyboard shows while notes are held.
 */
export function detectChord(pitches: readonly number[]): Pick<Chord, "root" | "quality"> | null {
  const classes = [...new Set(pitches.map(mod12))].toSorted((a, b) => a - b);
  if (classes.length < 3) return null;
  for (const root of classes) {
    const intervals = classes.map((pitch) => mod12(pitch - root)).toSorted((a, b) => a - b);
    const quality = qualityOf(intervals);
    if (quality) return { root, quality };
  }
  return null;
}

/** Whether a pitch is a black key on a piano. */
export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(mod12(pitch));
}

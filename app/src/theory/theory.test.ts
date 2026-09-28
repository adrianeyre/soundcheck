import { expect, test } from "vitest";

import {
  chordName,
  chordPitches,
  chordProgressionNotes,
  detectChord,
  diatonicChords,
  inKey,
  isBlackKey,
  keyName,
  PROGRESSIONS,
  SCALES,
  snapToKey,
  voiceLed,
} from "./theory";

const C_MAJOR = { root: 0, scale: "major" };
const A_MINOR = { root: 9, scale: "minor" };

test("every scale starts on its root and climbs within an octave", () => {
  for (const scale of SCALES) {
    expect(scale.intervals[0]).toBe(0);
    expect(scale.intervals.every((interval, index) => index === 0 || interval > scale.intervals[index - 1]!)).toBe(true);
    expect(Math.max(...scale.intervals)).toBeLessThan(12);
  }
});

test("a key knows its notes, and snaps others to the nearest", () => {
  expect([60, 62, 64, 65, 67, 69, 71].every((pitch) => inKey(pitch, C_MAJOR))).toBe(true);
  expect(inKey(61, C_MAJOR)).toBe(false);
  expect(snapToKey(61, C_MAJOR)).toBe(60);
  expect(snapToKey(66, C_MAJOR)).toBe(65);
  expect(snapToKey(70, A_MINOR)).toBe(69);
  expect(keyName({ root: 6, scale: "dorian" })).toBe("F# Dorian");
  expect(keyName(C_MAJOR)).toBe("C Major");
});

test("the diatonic triads of C major are C Dm Em F G Am B°", () => {
  const chords = diatonicChords(C_MAJOR);
  expect(chords.map(chordName)).toEqual(["C", "Dm", "Em", "F", "G", "Am", "B°"]);
  expect(chords.map((chord) => chord.numeral)).toEqual(["I", "ii", "iii", "IV", "V", "vi", "vii°"]);
  expect(chords.map((chord) => chord.function)).toEqual([
    "tonic",
    "subdominant",
    "tonic",
    "subdominant",
    "dominant",
    "tonic",
    "dominant",
  ]);
});

test("sevenths stack one more third", () => {
  expect(diatonicChords(C_MAJOR, true).map(chordName)).toEqual(["Cmaj7", "Dm7", "Em7", "Fmaj7", "G7", "Am7", "Bø7"]);
  expect(diatonicChords(C_MAJOR, true).map((chord) => chord.numeral)).toEqual([
    "Imaj7",
    "ii7",
    "iii7",
    "IVmaj7",
    "V7",
    "vi7",
    "viiø7",
  ]);
});

test("the harmonic minor has its raised seventh's chords", () => {
  expect(diatonicChords(A_MINOR).map(chordName)).toEqual(["Am", "B°", "C", "Dm", "Em", "F", "G"]);
  expect(diatonicChords({ root: 9, scale: "harmonicMinor" }).map(chordName)).toEqual([
    "Am",
    "B°",
    "C+",
    "Dm",
    "E",
    "F",
    "G#°",
  ]);
});

test("a pentatonic scale borrows its parent's chords", () => {
  expect(diatonicChords({ root: 0, scale: "majorPentatonic" }).map(chordName)[0]).toBe("C");
  expect(diatonicChords({ root: 9, scale: "minorPentatonic" }).map(chordName)[0]).toBe("Am");
});

test("chords are voiced near a pitch and can be inverted", () => {
  expect(chordPitches({ root: 0, quality: "maj" }, 60)).toEqual([60, 64, 67]);
  expect(chordPitches({ root: 0, quality: "maj" }, 60, 1)).toEqual([64, 67, 72]);
  expect(chordPitches({ root: 9, quality: "min7" }, 60)).toEqual([69, 72, 76, 79]);
});

test("voice leading keeps the hand in one place", () => {
  const c = chordPitches({ root: 0, quality: "maj" }, 60);
  const f = voiceLed({ root: 5, quality: "maj" }, c, 60);
  // F in second inversion, C–F–A, shares the C and moves least.
  expect(f).toEqual([60, 65, 69]);
});

test("a progression becomes the notes of a Clip", () => {
  const chords = PROGRESSIONS[0]!.degrees.map((degree) => diatonicChords(C_MAJOR)[degree - 1]!);
  const notes = chordProgressionNotes(
    chords,
    { chordTicks: 3840, stepTicks: 960, rhythm: "block", velocity: 0.7, nearPitch: 60, voiceLeading: false, bass: true },
    4 * 3840,
  );
  expect(notes).toHaveLength(16);
  expect(notes.filter((note) => note.start === 0).map((note) => note.pitch)).toEqual([48, 60, 64, 67]);
  expect(notes.every((note) => note.length === 3840 && note.velocity === 0.7)).toBe(true);

  const arpeggio = chordProgressionNotes(
    chords.slice(0, 1),
    { chordTicks: 3840, stepTicks: 480, rhythm: "arpUp", velocity: 0.7, nearPitch: 60, voiceLeading: false, bass: false },
    3840,
  );
  expect(arpeggio.map((note) => note.pitch)).toEqual([60, 64, 67, 60, 64, 67, 60, 64]);
  expect(arpeggio.map((note) => note.start)).toEqual([0, 480, 960, 1440, 1920, 2400, 2880, 3360]);
});

test("a progression is trimmed to the Clip", () => {
  const chords = diatonicChords(C_MAJOR).slice(0, 4);
  const notes = chordProgressionNotes(
    chords,
    { chordTicks: 3840, stepTicks: 960, rhythm: "block", velocity: 0.7, nearPitch: 60, voiceLeading: false, bass: false },
    3840 + 1920,
  );
  expect(Math.max(...notes.map((note) => note.start))).toBe(3840);
  expect(notes.filter((note) => note.start === 3840).every((note) => note.length === 1920)).toBe(true);
});

test("held notes are named as a chord", () => {
  expect(detectChord([60, 64, 67])).toEqual({ root: 0, quality: "maj" });
  expect(detectChord([64, 67, 72])).toEqual({ root: 0, quality: "maj" });
  expect(detectChord([57, 60, 64, 67])).toEqual({ root: 9, quality: "min7" });
  expect(detectChord([60, 62])).toBeNull();
  expect(isBlackKey(61)).toBe(true);
  expect(isBlackKey(60)).toBe(false);
});

import { Piano } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { pitchName } from "../song/step-grid";
import { KeySelect } from "../theory/KeySelect";
import {
  chordName,
  chordPitches,
  detectChord,
  diatonicChords,
  inKey,
  isBlackKey,
  type MusicalKey,
  snapToKey,
} from "../theory/theory";

/** How hard a key is played: louder the lower on it the pointer is, as a real key is heavier at its tip. */
function velocityAt(event: React.PointerEvent<HTMLElement>): number {
  const box = event.currentTarget.getBoundingClientRect();
  const depth = box.height > 0 ? (event.clientY - box.top) / box.height : 0.8;
  return Math.min(1, Math.max(0.15, 0.25 + depth * 0.75));
}

/** What one key press plays. */
export type KeyboardMode = "note" | "triad" | "seventh";

const MODES: { id: KeyboardMode; label: string }[] = [
  { id: "note", label: "Single notes" },
  { id: "triad", label: "Chords of the key (triads)" },
  { id: "seventh", label: "Chords of the key (sevenths)" },
];

const LOWEST_OCTAVE = 0;
const HIGHEST_OCTAVE = 7;

export interface PianoKeyboardProps {
  /** The Track the keys play, or null when there is no Instrument Track. */
  trackName: string | null;
  /** Whether audio is running, so a key can sound. */
  canPlay: boolean;
  songKey: MusicalKey;
  onSongKey: (key: MusicalKey) => void;
  /** Notes held right now, from here, the computer keyboard or MIDI. */
  held: ReadonlySet<number>;
  /** Notes the song is playing on the Track right now. */
  playing?: ReadonlySet<number>;
  noteOn: (note: number, velocity: number) => void;
  noteOff: (note: number) => void;
}

/**
 * An on-screen piano, as every DAW has one: click or drag across the keys to
 * play the Track notes are recorded onto, louder the lower on a key it is
 * pressed. The song's key is marked on it, a key press can play the chord of
 * the key built on that note, and whatever is held, from here, the computer
 * keyboard or a MIDI keyboard, lights up and is named as a chord.
 */
export function PianoKeyboard({
  trackName,
  canPlay,
  songKey,
  onSongKey,
  held,
  playing = new Set(),
  noteOn,
  noteOff,
}: PianoKeyboardProps) {
  const [octave, setOctave] = useState(3);
  const [octaves, setOctaves] = useState(3);
  const [mode, setMode] = useState<KeyboardMode>("note");
  const [showKey, setShowKey] = useState(true);
  const [snap, setSnap] = useState(false);
  // What each pointer is holding down, so a drag moves the notes it holds.
  const pressed = useRef(new Map<number, number[]>());

  const lowest = (octave + 1) * 12;
  const pitches = Array.from({ length: octaves * 12 + 1 }, (_, index) => lowest + index);
  const whites = pitches.filter((pitch) => !isBlackKey(pitch));
  const chord = detectChord([...(held.size > 0 ? held : playing)]);

  const notesFor = (pitch: number): number[] => {
    const root = snap ? snapToKey(pitch, songKey) : pitch;
    if (mode === "note") return [root];
    const degree = diatonicChords(songKey, mode === "seventh").find((candidate) => candidate.root === ((root % 12) + 12) % 12);
    return degree ? chordPitches(degree, root) : [root];
  };

  const release = (pointer: number) => {
    for (const pitch of pressed.current.get(pointer) ?? []) noteOff(pitch);
    pressed.current.delete(pointer);
  };
  const press = (pointer: number, pitch: number, velocity: number) => {
    const notes = notesFor(pitch);
    const before = pressed.current.get(pointer);
    if (before && before.length === notes.length && before.every((note, index) => note === notes[index])) return;
    release(pointer);
    pressed.current.set(pointer, notes);
    for (const note of notes) noteOn(note, velocity);
  };

  // Whatever is still held is let go when the Widget goes.
  useEffect(() => {
    const holding = pressed.current;
    return () => {
      for (const notes of holding.values()) for (const pitch of notes) noteOff(pitch);
      holding.clear();
    };
    // Only letting go needs to run, and only when it goes or what lets go changes; the ref is the Widget's own.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [noteOff]);

  const keyProps = (pitch: number) => ({
    "data-pitch": pitch,
    "data-in-key": showKey && inKey(pitch, songKey) ? "true" : undefined,
    "data-root": showKey && ((pitch - songKey.root) % 12 + 12) % 12 === 0 ? "true" : undefined,
    "data-held": held.has(pitch) ? "true" : undefined,
    "data-playing": playing.has(pitch) && !held.has(pitch) ? "true" : undefined,
    title: pitchName(pitch),
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (!canPlay) return;
      event.preventDefault();
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      press(event.pointerId, pitch, velocityAt(event));
    },
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      if (canPlay && event.buttons & 1 && pressed.current.has(event.pointerId)) press(event.pointerId, pitch, velocityAt(event));
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => release(event.pointerId),
  });

  return (
    <section aria-label="Keyboard" className="panel">
      <div className="panel-head">
        <h2>
          <Piano size={18} aria-hidden />
          Keyboard{trackName ? `: ${trackName}` : ""}
        </h2>
        <div className="row">
          <span className="chord-readout num" role="status" aria-label="Chord held">
            {chord ? chordName(chord) : held.size > 0 ? [...held].toSorted((a, b) => a - b).map(pitchName).join(" ") : "—"}
          </span>
        </div>
      </div>
      <div className="row hint">
        <KeySelect value={songKey} onChange={onSongKey} />
        <label className="field-inline">
          Play
          <select aria-label="Keyboard plays" value={mode} onChange={(event) => setMode(event.target.value as KeyboardMode)}>
            {MODES.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline">
          <input type="checkbox" checked={showKey} onChange={(event) => setShowKey(event.target.checked)} />
          Mark the key
        </label>
        <label className="field-inline">
          <input type="checkbox" checked={snap} onChange={(event) => setSnap(event.target.checked)} />
          Only the key&apos;s notes
        </label>
        <span className="field-inline" role="group" aria-label="Keyboard range">
          <button
            type="button"
            className="btn-sm"
            aria-label="Octave down"
            disabled={octave <= LOWEST_OCTAVE}
            onClick={() => setOctave(octave - 1)}
          >
            −
          </button>
          <span className="num">
            {pitchName(lowest)}–{pitchName(lowest + octaves * 12)}
          </span>
          <button
            type="button"
            className="btn-sm"
            aria-label="Octave up"
            disabled={octave + octaves > HIGHEST_OCTAVE + 1}
            onClick={() => setOctave(octave + 1)}
          >
            +
          </button>
          <select aria-label="Octaves shown" value={octaves} onChange={(event) => setOctaves(Number(event.target.value))}>
            {[1, 2, 3, 4, 5].map((count) => (
              <option key={count} value={count}>
                {count} octave{count > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </span>
      </div>
      <div
        className="piano"
        role="group"
        aria-label={`Piano keys, ${pitchName(lowest)} to ${pitchName(lowest + octaves * 12)}`}
        aria-disabled={!canPlay}
        onPointerLeave={(event) => release(event.pointerId)}
      >
        {whites.map((pitch) => (
          <div key={pitch} className="piano-white" {...keyProps(pitch)}>
            {pitch % 12 === 0 && <span className="piano-label">{pitchName(pitch)}</span>}
          </div>
        ))}
        {pitches.filter(isBlackKey).map((pitch) => {
          const whitesBefore = whites.filter((white) => white < pitch).length;
          return (
            <div
              key={pitch}
              className="piano-black"
              style={{ left: `calc(${(whitesBefore / whites.length) * 100}% - ${(0.3 / whites.length) * 100}%)`, width: `${(0.6 / whites.length) * 100}%` }}
              {...keyProps(pitch)}
            />
          );
        })}
      </div>
      <p className="hint">
        {canPlay
          ? "Click or drag across the keys; lower on a key plays louder. The computer keyboard plays too: A to ; are the white keys, W E T Y U O P the black, Z and X change octave."
          : "Start audio to play the keys."}
      </p>
    </section>
  );
}

import { Music4, Plus, Replace, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Note } from "../project/model";
import { KeySelect } from "./KeySelect";
import type { NextChord } from "./next-chord";
import {
  type Chord,
  CHORD_RHYTHMS,
  chordName,
  chordPitches,
  chordProgressionNotes,
  type ChordRhythm,
  diatonicChords,
  keyName,
  type MusicalKey,
  PROGRESSIONS,
  scaleOf,
} from "./theory";

/** The Pattern Clip the progression is written into. */
export interface ChordTarget {
  trackName: string;
  clipLength: number;
  notes: readonly Note[];
  /** Ticks of one beat and one bar where the Clip starts. */
  beatTicks: number;
  barTicks: number;
}

export interface ChordPadsProps {
  songKey: MusicalKey;
  onSongKey: (key: MusicalKey) => void;
  canPlay: boolean;
  noteOn: (note: number, velocity: number) => void;
  noteOff: (note: number) => void;
  /** The selected Pattern Clip, or null when none is. */
  target: ChordTarget | null;
  onNotes: (notes: Note[], label: string) => void;
  /** Asks Jev for the next chord of the progression; only where Jev is set up. */
  nextChord?: NextChord;
}

const CHORD_LENGTHS = [
  { bars: 0.5, label: "½ bar" },
  { bars: 1, label: "1 bar" },
  { bars: 2, label: "2 bars" },
  { bars: 4, label: "4 bars" },
];

const OCTAVES = [
  { pitch: 48, label: "Low (C3)" },
  { pitch: 60, label: "Middle (C4)" },
  { pitch: 72, label: "High (C5)" },
];

/** The same root's parallel key: major for a minor-sounding scale, natural minor for a major one. */
export function parallelKey(key: MusicalKey): MusicalKey {
  return { root: key.root, scale: scaleOf(key.scale).intervals.includes(4) ? "minor" : "major" };
}

/**
 * Chord pads, as Logic's Chord Trigger, Cubase's Chord Pads and Scaler offer
 * them: the chords of the song's key, coloured by what they do (home, away,
 * tension), and the ones borrowed from its parallel key. Holding a pad plays
 * it; with a Pattern Clip selected, the pads build a progression, or a
 * well-worn one is picked, and it is written into the Clip as block chords,
 * stabs or an arpeggio, as one undo step. With Jev set up, it can pick the
 * next chord of the progression from the pads.
 */
export function ChordPads({ songKey, onSongKey, canPlay, noteOn, noteOff, target, onNotes, nextChord }: ChordPadsProps) {
  const [sevenths, setSevenths] = useState(false);
  const [nearPitch, setNearPitch] = useState(60);
  const [progression, setProgression] = useState<Chord[]>([]);
  const [rhythm, setRhythm] = useState<ChordRhythm>("block");
  const [bars, setBars] = useState(1);
  const [bass, setBass] = useState(true);
  const [voiceLeading, setVoiceLeading] = useState(true);
  const [velocity, setVelocity] = useState(0.75);
  // What Jev last said: its pick and how sure it was, or why it couldn't pick; and whether it is being asked.
  const [asking, setAsking] = useState(false);
  const [jevSaid, setJevSaid] = useState<{ text: string; failed: boolean } | null>(null);
  // The pitches the pad being held is sounding: one Set, cleared and refilled, so letting go always finds them.
  const sounding = useRef(new Set<number>());

  const chords = diatonicChords(songKey, sevenths);
  const borrowedKey = parallelKey(songKey);
  const borrowed = diatonicChords(borrowedKey, sevenths).filter(
    (chord) => !chords.some((own) => own.root === chord.root && own.quality === chord.quality),
  );

  const askJev = async () => {
    if (!nextChord) return;
    setAsking(true);
    setJevSaid(null);
    try {
      const candidates = [...chords.map((chord) => ({ chord, borrowed: false })), ...borrowed.map((chord) => ({ chord, borrowed: true }))];
      const { chord, confidence } = await nextChord(songKey, progression, candidates);
      setProgression((list) => [...list, chord]);
      setJevSaid({ text: `Jev picked ${chordName(chord)}, ${Math.round(confidence * 100)}% confident.`, failed: false });
    } catch (reason) {
      setJevSaid({ text: reason instanceof Error ? reason.message : String(reason), failed: true });
    }
    setAsking(false);
  };

  const stop = () => {
    for (const pitch of sounding.current) noteOff(pitch);
    sounding.current.clear();
  };
  const play = (chord: Chord) => {
    stop();
    if (!canPlay) return;
    for (const pitch of chordPitches(chord, nearPitch)) {
      sounding.current.add(pitch);
      noteOn(pitch, velocity);
    }
  };
  // A pad still held when the Widget goes is let go.
  useEffect(() => {
    const held = sounding.current;
    return () => {
      for (const pitch of held) noteOff(pitch);
      held.clear();
    };
    // Only letting go needs to run, and only when it goes or what lets go changes; the ref is the Widget's own.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [noteOff]);

  const options = target && {
    chordTicks: Math.max(1, Math.round(bars * target.barTicks)),
    stepTicks: rhythm.startsWith("arp") ? target.beatTicks / 2 : target.beatTicks,
    rhythm,
    velocity,
    nearPitch,
    voiceLeading,
    bass,
  };
  const preview = target && options ? chordProgressionNotes(progression, options, target.clipLength) : [];

  const pad = (chord: Chord, from: string) => (
    <button
      key={`${from}:${chord.root}:${chord.quality}`}
      type="button"
      className="chord-pad"
      data-function={from === "borrowed" ? "borrowed" : chord.function}
      aria-label={`${chordName(chord)}, ${chord.numeral}${from === "borrowed" ? `, borrowed from ${keyName(borrowedKey)}` : ""}`}
      onPointerDown={() => play(chord)}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) play(chord);
      }}
      onKeyUp={stop}
      onClick={() => target && setProgression((list) => [...list, chord])}
    >
      <span className="chord-pad-name">{chordName(chord)}</span>
      <span className="chord-pad-numeral">{chord.numeral}</span>
    </button>
  );

  return (
    <section aria-label="Chords" className="panel">
      <div className="panel-head">
        <h2>
          <Music4 size={18} aria-hidden />
          Chords: {keyName(songKey)}
        </h2>
      </div>
      <div className="row hint">
        <KeySelect value={songKey} onChange={onSongKey} />
        <label className="field-inline">
          <input type="checkbox" checked={sevenths} onChange={(event) => setSevenths(event.target.checked)} />
          Sevenths
        </label>
        <label className="field-inline">
          Voicing
          <select aria-label="Voicing octave" value={nearPitch} onChange={(event) => setNearPitch(Number(event.target.value))}>
            {OCTAVES.map(({ pitch, label }) => (
              <option key={pitch} value={pitch}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline">
          Velocity
          <input
            type="range"
            aria-label="Chord velocity"
            min={0.1}
            max={1}
            step={0.05}
            value={velocity}
            onChange={(event) => setVelocity(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="chord-legend hint" aria-hidden>
        <span data-function="tonic">Home</span>
        <span data-function="subdominant">Away</span>
        <span data-function="dominant">Tension</span>
        <span data-function="borrowed">Borrowed</span>
      </div>
      <div className="chord-pads" role="group" aria-label={`Chords of ${keyName(songKey)}`}>
        {chords.map((chord) => pad(chord, "key"))}
      </div>
      {borrowed.length > 0 && (
        <div className="chord-pads mt-3" role="group" aria-label={`Chords borrowed from ${keyName(borrowedKey)}`}>
          {borrowed.map((chord) => pad(chord, "borrowed"))}
        </div>
      )}
      <p className="hint">
        {canPlay ? "Hold a pad to hear it." : "Start audio to hear the pads."}{" "}
        {target
          ? `Click pads to build a progression for ${target.trackName}'s Clip, or pick one below.`
          : "Select a Pattern Clip to write a progression into it."}
      </p>
      {target && options && (
        <div className="stack mt-3">
          <div className="row">
            <label className="field-inline">
              Progression
              <select
                aria-label="Progression"
                value=""
                onChange={(event) => {
                  const picked = PROGRESSIONS.find((p) => p.name === event.target.value);
                  if (picked) setProgression(picked.degrees.map((degree) => chords[(degree - 1) % chords.length]!));
                }}
              >
                <option value="">Pick a progression…</option>
                {PROGRESSIONS.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {nextChord && (
              <button type="button" className="btn-sm" disabled={asking} aria-busy={asking} onClick={() => void askJev()}>
                <Sparkles size={14} aria-hidden />
                {asking ? "Asking Jev…" : "Next chord from Jev"}
              </button>
            )}
            <label className="field-inline">
              Rhythm
              <select aria-label="Rhythm" value={rhythm} onChange={(event) => setRhythm(event.target.value as ChordRhythm)}>
                {CHORD_RHYTHMS.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-inline">
              Each chord
              <select aria-label="Chord length" value={bars} onChange={(event) => setBars(Number(event.target.value))}>
                {CHORD_LENGTHS.map((length) => (
                  <option key={length.bars} value={length.bars}>
                    {length.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-inline">
              <input type="checkbox" checked={bass} onChange={(event) => setBass(event.target.checked)} />
              Bass note
            </label>
            <label className="field-inline">
              <input type="checkbox" checked={voiceLeading} onChange={(event) => setVoiceLeading(event.target.checked)} />
              Voice leading
            </label>
          </div>
          {jevSaid && (
            <p role={jevSaid.failed ? "alert" : "status"} className={jevSaid.failed ? "alert" : "hint"}>
              {jevSaid.text}
            </p>
          )}
          <ol className="progression" aria-label="Progression chords">
            {progression.length === 0 && <li className="hint">No chords yet.</li>}
            {progression.map((chord, index) => (
              <li key={index} data-function={chord.function} style={{ flexGrow: bars }}>
                <span>{chordName(chord)}</span>
                <button
                  type="button"
                  className="btn-sm btn-icon"
                  aria-label={`Remove chord ${index + 1}, ${chordName(chord)}`}
                  onClick={() => setProgression((list) => list.filter((_, at) => at !== index))}
                >
                  <X size={12} aria-hidden />
                </button>
              </li>
            ))}
          </ol>
          <NotePreview notes={preview} length={target.clipLength} barTicks={target.barTicks} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={progression.length === 0}
              onClick={() => onNotes(preview, "Write chords")}
            >
              <Replace size={16} aria-hidden />
              Replace the Clip&apos;s notes
            </button>
            <button
              type="button"
              disabled={progression.length === 0}
              onClick={() => {
                const taken = new Set(preview.map((note) => `${note.pitch}:${note.start}`));
                onNotes([...target.notes.filter((note) => !taken.has(`${note.pitch}:${note.start}`)), ...preview], "Add chords");
              }}
            >
              <Plus size={16} aria-hidden />
              Add to the Clip&apos;s notes
            </button>
            <button type="button" disabled={progression.length === 0} onClick={() => setProgression([])}>
              <Trash2 size={16} aria-hidden />
              Clear
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const PREVIEW_HEIGHT = 72;

/** The notes about to be written, drawn small, bar lines and all. */
export function NotePreview({ notes, length, barTicks }: { notes: readonly Note[]; length: number; barTicks: number }) {
  const width = 600;
  const pitches = notes.map((note) => note.pitch);
  const [low, high] = pitches.length ? [Math.min(...pitches) - 1, Math.max(...pitches) + 1] : [59, 72];
  const row = PREVIEW_HEIGHT / (high - low + 1);
  const x = (tick: number) => (tick / Math.max(1, length)) * width;
  return (
    <svg
      role="img"
      aria-label={`${notes.length} notes to write`}
      className="note-preview"
      viewBox={`0 0 ${width} ${PREVIEW_HEIGHT}`}
      preserveAspectRatio="none"
    >
      {Array.from({ length: Math.ceil(length / barTicks) }, (_, bar) => (
        <line key={bar} x1={x(bar * barTicks)} x2={x(bar * barTicks)} y1={0} y2={PREVIEW_HEIGHT} stroke="var(--lane-bar)" />
      ))}
      {notes.map((note) => (
        <rect
          key={`${note.pitch}:${note.start}`}
          x={x(note.start)}
          y={(high - note.pitch) * row}
          width={Math.max(1, x(note.length) - 1)}
          height={Math.max(1, row - 1)}
          rx={1}
          fill="var(--clip-pattern)"
          opacity={0.4 + note.velocity * 0.6}
        />
      ))}
    </svg>
  );
}

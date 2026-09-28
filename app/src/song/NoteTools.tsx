import { Wand2 } from "lucide-react";
import { useState } from "react";

import type { Note, PatternClip } from "../project/model";
import { NotePreview } from "../theory/ChordPads";
import { KeySelect } from "../theory/KeySelect";
import { keyName, type MusicalKey } from "../theory/theory";
import {
  arpeggiate,
  type ArpeggioDirection,
  chop,
  double,
  fitToKey,
  humanise,
  legato,
  mirror,
  removeQuiet,
  reverse,
  staccato,
  stretch,
  strum,
  swing,
  tidy,
  transpose,
  velocityContrast,
  velocityRamp,
} from "./note-tools";
import { PIANO_SNAPS, type PianoSnapId, quantiseNotes, snapTicksOf } from "./piano-roll";
import { pitchName } from "./step-grid";

export interface NoteToolsProps {
  clip: PatternClip;
  trackName: string;
  songKey: MusicalKey;
  onSongKey: (key: MusicalKey) => void;
  /** Ticks of one bar where the Clip starts, for the preview's bar lines. */
  barTicks: number;
  /** One undo step, named by `label`. */
  onNotes: (notes: Note[], label: string) => void;
}

const GRIDS = PIANO_SNAPS.filter((snap) => snap.id !== "off");

/**
 * Whole-Clip note tools, each one undo step: pitch (transpose, fit to the
 * key, mirror, doubling), timing (quantise, humanise, swing, legato,
 * staccato, strum, reverse, speed, chop), arpeggiate, and velocity. The Clip
 * is drawn small above them, with what it holds.
 */
export function NoteTools({ clip, trackName, songKey, onSongKey, barTicks, onNotes }: NoteToolsProps) {
  const [grid, setGrid] = useState<PianoSnapId>("1/16");
  const [strength, setStrength] = useState(1);
  const [timing, setTiming] = useState(20);
  const [loosen, setLoosen] = useState(0.1);
  const [swingAmount, setSwingAmount] = useState(0.5);
  const [direction, setDirection] = useState<ArpeggioDirection>("up");
  const [octaves, setOctaves] = useState(1);
  const [seed, setSeed] = useState(1);
  const { notes, length } = clip;
  const step = snapTicksOf(grid);
  const empty = notes.length === 0;
  const apply = (label: string, next: Note[]) => onNotes(tidy(next, length), label);

  const pitches = notes.map((note) => note.pitch);
  const average = empty ? 0 : notes.reduce((sum, note) => sum + note.velocity, 0) / notes.length;

  const tool = (label: string, run: () => Note[], title?: string) => (
    <button type="button" className="btn-sm" disabled={empty} title={title} onClick={() => apply(label, run())}>
      {label}
    </button>
  );

  return (
    <section aria-label="Note Tools" className="panel">
      <div className="panel-head">
        <h2>
          <Wand2 size={18} aria-hidden />
          Note Tools: {trackName}
        </h2>
        <span className="hint num" role="status" aria-label="Clip notes">
          {empty
            ? "No notes"
            : `${notes.length} notes · ${pitchName(Math.min(...pitches))}–${pitchName(Math.max(...pitches))} · velocity ${Math.round(average * 127)}`}
        </span>
      </div>
      <NotePreview notes={notes} length={length} barTicks={barTicks} />
      <div className="tool-groups mt-3">
        <fieldset className="tool-group">
          <legend>Pitch</legend>
          <div className="row">
            {tool("Octave down", () => transpose(notes, -12, length))}
            {tool("Semitone down", () => transpose(notes, -1, length))}
            {tool("Semitone up", () => transpose(notes, 1, length))}
            {tool("Octave up", () => transpose(notes, 12, length))}
          </div>
          <div className="row">
            <KeySelect value={songKey} onChange={onSongKey} />
            {tool(`Fit to ${keyName(songKey)}`, () => fitToKey(notes, songKey, length))}
          </div>
          <div className="row">
            {tool("Mirror", () => mirror(notes, length), "Turn the melody upside down")}
            {tool("Add octave above", () => double(notes, 12, length))}
            {tool("Add octave below", () => double(notes, -12, length))}
            {tool("Add fifth", () => double(notes, 7, length))}
          </div>
        </fieldset>
        <fieldset className="tool-group">
          <legend>Timing</legend>
          <div className="row">
            <label className="field-inline">
              Grid
              <select aria-label="Tools grid" value={grid} onChange={(event) => setGrid(event.target.value as PianoSnapId)}>
                {GRIDS.map((snap) => (
                  <option key={snap.id} value={snap.id}>
                    {snap.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-inline">
              Strength <span className="num">{Math.round(strength * 100)}%</span>
              <input
                type="range"
                aria-label="Quantise strength"
                min={0.1}
                max={1}
                step={0.05}
                value={strength}
                onChange={(event) => setStrength(Number(event.target.value))}
              />
            </label>
            {tool("Quantise", () => quantiseNotes(notes, new Set(notes.map((n) => `${n.pitch}:${n.start}`)), step, length, strength).notes)}
          </div>
          <div className="row">
            <label className="field-inline">
              Timing <span className="num">±{timing}</span>
              <input
                type="range"
                aria-label="Humanise timing, in ticks"
                min={0}
                max={120}
                step={1}
                value={timing}
                onChange={(event) => setTiming(Number(event.target.value))}
              />
            </label>
            <label className="field-inline">
              Velocity <span className="num">±{Math.round(loosen * 127)}</span>
              <input
                type="range"
                aria-label="Humanise velocity"
                min={0}
                max={0.5}
                step={0.01}
                value={loosen}
                onChange={(event) => setLoosen(Number(event.target.value))}
              />
            </label>
            {tool("Humanise", () => {
              setSeed(seed + 1);
              return humanise(notes, { timingTicks: timing, velocity: loosen, seed }, length);
            })}
          </div>
          <div className="row">
            <label className="field-inline">
              Swing <span className="num">{Math.round(swingAmount * 100)}%</span>
              <input
                type="range"
                aria-label="Swing amount"
                min={0}
                max={1}
                step={0.05}
                value={swingAmount}
                onChange={(event) => setSwingAmount(Number(event.target.value))}
              />
            </label>
            {tool("Swing", () => swing(notes, step, swingAmount, length))}
          </div>
          <div className="row">
            {tool("Legato", () => legato(notes, length), "Stretch each note to the next")}
            {tool("Staccato", () => staccato(notes, Math.max(1, Math.round(step / 2)), length))}
            {tool("Strum up", () => strum(notes, Math.round(step / 8), false, length))}
            {tool("Strum down", () => strum(notes, Math.round(step / 8), true, length))}
            {tool("Chop", () => chop(notes, step, length), "Cut every note into grid steps")}
          </div>
          <div className="row">
            {tool("Reverse", () => reverse(notes, length))}
            {tool("Double speed", () => stretch(notes, 0.5, length))}
            {tool("Half speed", () => stretch(notes, 2, length))}
          </div>
        </fieldset>
        <fieldset className="tool-group">
          <legend>Arpeggiate</legend>
          <div className="row">
            <label className="field-inline">
              Direction
              <select
                aria-label="Arpeggio direction"
                value={direction}
                onChange={(event) => setDirection(event.target.value as ArpeggioDirection)}
              >
                <option value="up">Up</option>
                <option value="down">Down</option>
                <option value="upDown">Up and down</option>
                <option value="random">Random</option>
              </select>
            </label>
            <label className="field-inline">
              Octaves
              <select aria-label="Arpeggio octaves" value={octaves} onChange={(event) => setOctaves(Number(event.target.value))}>
                {[1, 2, 3].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            {tool("Arpeggiate", () => arpeggiate(notes, step, direction, octaves, length, seed), "Play each chord one note at a time, a grid step each")}
          </div>
        </fieldset>
        <fieldset className="tool-group">
          <legend>Velocity</legend>
          <div className="row">
            {tool("Crescendo", () => velocityRamp(notes, 0.35, 1, length))}
            {tool("Fade", () => velocityRamp(notes, 1, 0.35, length))}
            {tool("More contrast", () => velocityContrast(notes, 1.5, length))}
            {tool("Less contrast", () => velocityContrast(notes, 0.5, length))}
            {tool("Remove ghost notes", () => removeQuiet(notes, 0.25, length), "Take out notes quieter than 32")}
          </div>
          <VelocityBars notes={notes} length={length} />
        </fieldset>
      </div>
    </section>
  );
}

/** Each note's velocity as a bar where it starts, as a Piano Roll's velocity lane draws it. */
function VelocityBars({ notes, length }: { notes: readonly Note[]; length: number }) {
  const width = 600;
  const height = 40;
  return (
    <svg role="img" aria-label="Velocities" className="note-preview" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {notes.map((note) => {
        const x = (note.start / Math.max(1, length)) * width;
        return (
          <line
            key={`${note.pitch}:${note.start}`}
            x1={x}
            x2={x}
            y1={height}
            y2={height - note.velocity * height}
            stroke="var(--primary)"
            strokeWidth={2}
          />
        );
      })}
    </svg>
  );
}

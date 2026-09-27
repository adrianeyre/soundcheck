import { Grid3x3, Trash2 } from "lucide-react";
import { useState } from "react";

import type { Instrument, Note, PatternClip } from "../project/model";
import { barTicks, type TimeSignature } from "../project/time";
import { STEP_SIZES, gridRows, isStepOn, stepCount, toggleStep } from "./step-grid";

const DEFAULT_OCTAVE = 3;

export interface StepSequencerProps {
  clip: PatternClip;
  trackName: string;
  /** Whose notes these are: it names the rows. */
  instrument: Instrument;
  timeSignature: TimeSignature;
  /** The grid's step size, in ticks. Recording quantises to it too, so the
   *  Song page owns it. */
  stepTicks: number;
  onStepTicks: (ticks: number) => void;
  onNotes: (notes: Note[]) => void;
  /** A new length in ticks. */
  onLength: (length: number) => void;
  onDelete: () => void;
}

/**
 * A grid of steps × rows for one Pattern Clip. A cell is a note. The rows
 * are pitches under the Synth and the kit's pads under the Drum Sampler.
 */
export function StepSequencer(props: StepSequencerProps) {
  const { clip, trackName, instrument, timeSignature, stepTicks, onNotes, onLength, onDelete } = props;
  const [octave, setOctave] = useState(DEFAULT_OCTAVE);
  const bar = barTicks(timeSignature);
  const steps = stepCount(clip, stepTicks);
  const rows = gridRows(instrument, octave);
  const bars = clip.length / bar;

  return (
    <section aria-label="Step Sequencer" className="panel">
      <div className="panel-head">
        <h2 className="kind-stripe" data-track-kind={instrument.type === "drumSampler" ? "drum" : "instrument"}>
          <Grid3x3 size={18} aria-hidden />
          Step Sequencer: {trackName}
        </h2>
        <label className="field-inline">
          Length (bars)
          <input
            type="number"
            min={1}
            max={64}
            value={Number.isInteger(bars) ? bars : bars.toFixed(2)}
            style={{ width: "4.5em" }}
            onChange={(event) => {
              const next = Math.round(Number(event.target.value));
              if (next >= 1 && next <= 64) onLength(next * bar);
            }}
          />
        </label>
        <label className="field-inline">
          Step size
          <select value={stepTicks} onChange={(event) => props.onStepTicks(Number(event.target.value))}>
            {STEP_SIZES.map((size) => (
              <option key={size.label} value={size.ticks}>
                {size.label}
              </option>
            ))}
          </select>
        </label>
        {/* The Drum Sampler's rows are its pads, which no octave moves. */}
        {instrument.type !== "drumSampler" && (
          <label className="field-inline">
            Octaves from C
            <select value={octave} onChange={(event) => setOctave(Number(event.target.value))}>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="btn-sm" onClick={onDelete}>
          <Trash2 size={14} aria-hidden />
          Delete Clip
        </button>
      </div>
      <div className="grid-scroll">
        {/* A table of toggle buttons: each is its own tab stop, labelled with its row and step. */}
        <table className="step-grid" aria-label={`Steps of ${trackName}`}>
          <tbody>
            {rows.map((row) => (
              <tr key={row.pitch}>
                <th scope="row">{row.label}</th>
                {Array.from({ length: steps }, (_, step) => {
                  const on = isStepOn(clip.notes, row.pitch, step, stepTicks);
                  const barStart = step > 0 && (step * stepTicks) % bar === 0;
                  return (
                    <td key={step}>
                      <button
                        type="button"
                        className="step"
                        data-shaded={row.shaded}
                        data-bar={barStart}
                        aria-label={`${row.label} step ${step + 1}`}
                        aria-pressed={on}
                        onClick={() => onNotes(toggleStep(clip.notes, row.pitch, step, stepTicks))}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

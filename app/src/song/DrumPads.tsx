import { Drum } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { DrumPad } from "../project/model";
import { isSampleDrag } from "../samples/sample-drag";
import { LIMITS } from "../project/validate";

export interface DrumPadsProps {
  trackName: string;
  pads: readonly DrumPad[];
  /** The file loaded onto each pad, by pad, where one has been. */
  sampleNames: readonly (string | undefined)[];
  /** Change one pad: only the fields given. */
  onPad: (pad: number, settings: Partial<DrumPad>) => void;
  onLoad: (pad: number, file: File) => void;
  /** A sample from the sample browser dropped on a pad. Without it, pads take none. */
  onDropSample?: (pad: number, transfer: DataTransfer) => void;
  /** Controls for the whole Kit, beside the heading: loading and saving one. */
  kitControls?: ReactNode;
}

/**
 * The Drum Sampler's pads: what each one plays and how. A pad starts on the
 * bundled kit's own sample and keeps it until a WAV is loaded over it.
 */
export function DrumPads({ trackName, pads, sampleNames, onPad, onLoad, onDropSample, kitControls }: DrumPadsProps) {
  // The pad a sample is being dragged over, to show it will land there.
  const [sampleOver, setSampleOver] = useState<number | null>(null);
  return (
    <section aria-label="Pads" className="panel">
      <div className="panel-head">
        <h2 className="kind-stripe" data-track-kind="drum">
          <Drum size={18} aria-hidden />
          Pads: {trackName}
        </h2>
        {kitControls}
      </div>
      <div className="grid-scroll">
      <table className="pad-table">
        <thead>
          <tr>
            <th scope="col">Pad</th>
            <th scope="col">Note</th>
            <th scope="col">Volume</th>
            <th scope="col">Pan</th>
            <th scope="col">Pitch</th>
            <th scope="col">Choke</th>
            <th scope="col">Sample</th>
          </tr>
        </thead>
        <tbody>
          {pads.map((pad, index) => (
            <tr
              key={pad.name}
              className={sampleOver === index ? "drop-target" : undefined}
              onDragOver={(event) => {
                if (!onDropSample || !isSampleDrag(event.dataTransfer)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setSampleOver(index);
              }}
              onDragLeave={() => setSampleOver(null)}
              onDrop={(event) => {
                setSampleOver(null);
                if (!onDropSample || !isSampleDrag(event.dataTransfer)) return;
                event.preventDefault();
                onDropSample(index, event.dataTransfer);
              }}
            >
              <th scope="row">
                {pad.name}
              </th>
              <td className="num">{pad.note}</td>
              <td>
                <input
                  type="range"
                  aria-label={`${pad.name} volume`}
                  min={LIMITS.volume[0]}
                  max={LIMITS.volume[1]}
                  step={0.01}
                  value={pad.volume}
                  onChange={(event) => onPad(index, { volume: Number(event.target.value) })}
                />
              </td>
              <td>
                <input
                  type="range"
                  aria-label={`${pad.name} pan`}
                  min={LIMITS.pan[0]}
                  max={LIMITS.pan[1]}
                  step={0.01}
                  value={pad.pan}
                  onChange={(event) => onPad(index, { pan: Number(event.target.value) })}
                />
              </td>
              <td>
                <input
                  type="number"
                  aria-label={`${pad.name} pitch`}
                  min={LIMITS.padPitch[0]}
                  max={LIMITS.padPitch[1]}
                  step={1}
                  value={pad.pitch}
                  onChange={(event) => onPad(index, { pitch: Number(event.target.value) })}
                />
              </td>
              <td>
                <input
                  type="number"
                  aria-label={`${pad.name} choke group`}
                  min={LIMITS.chokeGroup[0]}
                  max={LIMITS.chokeGroup[1]}
                  step={1}
                  value={pad.chokeGroup}
                  onChange={(event) => onPad(index, { chokeGroup: Number(event.target.value) })}
                />
              </td>
              <td>
                <input
                  type="file"
                  accept=".wav,audio/wav,audio/x-wav"
                  aria-label={`${pad.name} sample`}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) onLoad(index, file);
                  }}
                />{" "}
                <span className="hint">{sampleNames[index] ?? "Starter Kit"}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}

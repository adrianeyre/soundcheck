import { RotateCw } from "lucide-react";
import { useId, useState } from "react";

import { DECK_MODES, type DeckMode, type DeckReport } from "./dj-report";
import { pairName, TIMECODE_FORMATS, type TimecodeControls } from "./timecode-input";

const MODE_NAMES: Record<DeckMode, string> = {
  int: "INT: the Deck plays the file itself",
  rel: "REL: the timecode vinyl's speed and direction move it",
  abs: "ABS: the timecode vinyl's position places it",
};

/** The record's speed, as a turntable's pitch reads: +1.000× forwards at 33⅓. */
export function formatSpeed(speed: number): string {
  return `${speed >= 0 ? "+" : "−"}${Math.abs(speed).toFixed(3)}×`;
}

export interface TimecodePanelProps {
  deck: number;
  report: DeckReport;
  /** The Decks' timecode setup, or null where the page has none. */
  timecode: TimecodeControls | null;
}

/**
 * A Deck's timecode vinyl (a DVS): INT, REL or ABS, a light for the
 * record's signal and its speed, and under INPUT the input pair and the
 * record it reads.
 */
export function TimecodePanel({ deck, report, timecode }: TimecodePanelProps) {
  const [open, setOpen] = useState(false);
  const name = `Deck ${deck + 1}`;
  const available = timecode?.available ?? false;
  const signal = report.timecode.signal;
  const one = timecode?.setup[deck];
  return (
    <div className="dj-hw-section dj-timecode" role="group" aria-label={`${name} timecode vinyl`}>
      <span className="dj-hw-caption">TIMECODE</span>
      <div className="dj-timecode-row">
        <div className="dj-switch" role="radiogroup" aria-label={`${name} control mode`}>
          {DECK_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              className="dj-switch-position"
              aria-checked={report.mode === mode}
              aria-label={`${name} ${MODE_NAMES[mode]}`}
              disabled={mode !== "int" && !available}
              onClick={() => timecode?.setMode(deck, mode)}
            >
              {mode.toUpperCase()}
            </button>
          ))}
        </div>
        <span
          className="dj-timecode-light"
          data-light={signal ? "on" : undefined}
          role="img"
          aria-label={signal ? `${name}: a timecode signal` : `${name}: no timecode signal`}
        />
        <span className="num dj-hw-value" aria-label={`${name} record speed`}>
          {signal ? formatSpeed(report.timecode.speed) : "—"}
        </span>
        {available && (
          <button
            type="button"
            className="dj-hw-button"
            aria-expanded={open}
            aria-label={`${name} timecode input and record`}
            onClick={() => {
              if (!open) timecode?.refresh();
              setOpen(!open);
            }}
          >
            INPUT
          </button>
        )}
      </div>
      {!available && <p className="dj-hw-note">Timecode vinyl comes in through an audio input, which needs the Desktop App.</p>}
      {available && report.mode !== "int" && !one?.device && (
        <p className="dj-hw-note">Choose {name}'s input under INPUT: until then it hears no record, so it stays still.</p>
      )}
      {report.mode === "abs" && !report.timecode.absReady && (
        <p className="dj-hw-note">ABS reads the record's position: choose which record under INPUT (Auto finds only its speed).</p>
      )}
      {open && timecode && one && <TimecodePicker deck={deck} timecode={timecode} />}
    </div>
  );
}

/** Where a Deck's record comes in, and which record it is. */
export function TimecodePicker({ deck, timecode }: { deck: number; timecode: TimecodeControls }) {
  const id = useId();
  const name = `Deck ${deck + 1}`;
  const one = timecode.setup[deck]!;
  const found = timecode.devices.find((device) => device.name === one.device);
  const listed =
    one.device && !found ? [...timecode.devices, { name: one.device, channels: 0 }] : timecode.devices;
  // Pairs the device has: 1-2, 3-4, …; the one kept stays listed even if the device isn't here.
  const channels = Math.max(found?.channels ?? 2, one.left + 2);
  const pairs = Array.from({ length: Math.floor(channels / 2) }, (_, index) => index * 2);
  const status = timecode.status;
  const running = one.device !== null && (status?.running.includes(one.device) ?? false);
  return (
    <div className="dj-timecode-picker">
      <label className="dj-phones-label">
        <span className="dj-hw-caption">DEVICE</span>
        <select
          aria-label={`${name} timecode input device`}
          value={one.device ?? ""}
          onChange={(event) => timecode.change(deck, { device: event.target.value || null })}
        >
          <option value="">None</option>
          {listed.map((device) => (
            <option key={device.name} value={device.name}>
              {found || device.name !== one.device ? device.name : `${device.name} (not found)`}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="dj-hw-button" aria-label="List the input devices again" onClick={timecode.refresh}>
        <RotateCw size={12} aria-hidden />
      </button>
      <label className="dj-phones-label">
        <span className="dj-hw-caption">PAIR</span>
        <select
          aria-label={`${name} timecode input pair`}
          value={one.left}
          onChange={(event) => timecode.change(deck, { left: Number(event.target.value) })}
        >
          {pairs.map((left) => (
            <option key={left} value={left}>
              {pairName(left)}
            </option>
          ))}
        </select>
      </label>
      <label className="dj-phones-label">
        <span className="dj-hw-caption">RECORD</span>
        <select
          aria-label={`${name} timecode record`}
          value={one.format}
          onChange={(event) => timecode.change(deck, { format: Number(event.target.value) })}
        >
          <option value={0}>Auto (speed only, for REL)</option>
          {TIMECODE_FORMATS.map((format, index) => (
            <option key={format.id} value={index + 1}>
              {format.label} ({format.carrier / 1000} kHz)
            </option>
          ))}
        </select>
      </label>
      <label className="dj-timecode-check" htmlFor={`${id}-swap`}>
        <input
          id={`${id}-swap`}
          type="checkbox"
          checked={one.swap}
          onChange={(event) => timecode.change(deck, { swap: event.target.checked })}
        />
        <span>Swap left and right</span>
      </label>
      <label className="dj-timecode-check" htmlFor={`${id}-invert`}>
        <input
          id={`${id}-invert`}
          type="checkbox"
          checked={one.invert}
          onChange={(event) => timecode.change(deck, { invert: event.target.checked })}
        />
        <span>Invert the right channel</span>
      </label>
      <p className="dj-hw-note" role="status">
        {status?.failed ??
          (one.device === null
            ? "No input: this Deck hears no record."
            : running
              ? `Reading ${pairName(one.left)} of ${one.device}. If the record plays backwards, swap or invert.`
              : "Chosen: it is read once audio starts.")}
      </p>
    </div>
  );
}

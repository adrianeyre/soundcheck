import { Play, Repeat, SkipBack, Square, Timer } from "lucide-react";
import { useEffect, useState } from "react";

import type { EngineCommand, EngineReport } from "../audio/audio-output";
import { BEAT_UNITS, barBeatTick, barsAt, formatPosition, secondsAt, signatureAt, type TempoMap, tickAtBars } from "../project/time";
import { addTap, tappedTempo } from "./tap-tempo";
import { MAX_TEMPO, MIN_TEMPO, type TransportSettings } from "./transport-settings";

const POSITION_MS = 50;

export interface TransportBarProps {
  settings: TransportSettings;
  /** The song's tempo map, which positions and the loop region are read on. */
  tempoMap: TempoMap;
  onChange: (settings: TransportSettings) => void;
  send: (command: EngineCommand) => void;
  /** The engine's latest report, or null when no audio is running. */
  readReport: () => EngineReport | null;
}

/** A number of bars as the loop fields show it: whole, or to two places. */
function shown(bars: number): number {
  return Number.isInteger(bars) ? bars : Number(bars.toFixed(2));
}

/** Play/stop, tempo, time signature, loop, metronome and the position. */
export function TransportBar({ settings, tempoMap, onChange, send, readReport }: TransportBarProps) {
  const [report, setReport] = useState<EngineReport | null>(null);
  const [tempoText, setTempoText] = useState(String(settings.tempo));
  const [taps, setTaps] = useState<number[]>([]);

  useEffect(() => {
    const timer = setInterval(() => setReport(readReport()), POSITION_MS);
    return () => clearInterval(timer);
  }, [readReport]);

  const update = (changes: Partial<TransportSettings>) => onChange({ ...settings, ...changes });
  const running = report !== null;
  const playing = report?.playing ?? false;

  const position = report?.position ?? 0;
  const { beat } = barBeatTick(tempoMap, position);
  const beatsPerBar = signatureAt(tempoMap, position).beatsPerBar;
  const seconds = secondsAt(tempoMap, Math.max(0, position));
  const clock = `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
  const loopStartBar = barsAt(tempoMap, settings.loopStart);
  const loopBars = barsAt(tempoMap, settings.loopEnd) - loopStartBar;

  return (
    <fieldset className="toolbar-group" aria-label="Transport">
      <legend className="visually-hidden">Transport</legend>
      <button type="button" aria-label="Back to start" title="Back to start" className="btn-icon" disabled={!running} onClick={() => send({ type: "seek", tick: 0 })}>
        <SkipBack size={16} aria-hidden />
      </button>
      <button
        type="button"
        className={playing ? undefined : "btn-play"}
        disabled={!running}
        onClick={() => send({ type: playing ? "stop" : "play" })}
      >
        {playing ? <Square size={16} aria-hidden /> : <Play size={16} aria-hidden />}
        {playing ? "Stop" : "Play"}
      </button>
      {/* Updated twenty times a second, so it is read on request rather than announced. */}
      <div className="transport-lcd">
        <output aria-label="Position" aria-live="off" className="position">
          {formatPosition(position, tempoMap)}
        </output>
        <output aria-label="Time" aria-live="off" className="transport-clock num">
          {clock}
        </output>
        <span className="beat-lights" aria-hidden>
          {Array.from({ length: Math.min(16, beatsPerBar) }, (_, index) => (
            <span key={index} data-on={playing && index + 1 === beat} data-downbeat={index === 0} />
          ))}
        </span>
      </div>
      <span className="divider" aria-hidden />
      <label className="field">
        Tempo
        <input
          type="number"
          min={MIN_TEMPO}
          max={MAX_TEMPO}
          step="any"
          value={tempoText}
          style={{ width: "5.5em" }}
          onChange={(event) => {
            setTempoText(event.target.value);
            const tempo = Number(event.target.value);
            if (event.target.value !== "" && tempo >= MIN_TEMPO && tempo <= MAX_TEMPO) {
              update({ tempo });
            }
          }}
        />
      </label>
      <button
        type="button"
        className="btn-sm"
        title="Tap along with the beat to set the tempo"
        onClick={() => {
          const next = addTap(taps, performance.now());
          setTaps(next);
          const tempo = tappedTempo(next);
          if (tempo !== null && tempo >= MIN_TEMPO && tempo <= MAX_TEMPO) {
            setTempoText(String(tempo));
            update({ tempo });
          }
        }}
      >
        Tap
      </button>
      <label className="field">
        Beats per bar
        <input
          type="number"
          min={1}
          max={32}
          value={settings.timeSignature.beatsPerBar}
          style={{ width: "4.5em" }}
          onChange={(event) => {
            const beatsPerBar = Math.round(Number(event.target.value));
            if (beatsPerBar >= 1 && beatsPerBar <= 32) {
              update({ timeSignature: { ...settings.timeSignature, beatsPerBar } });
            }
          }}
        />
      </label>
      <label className="field">
        Beat unit
        <select
          value={settings.timeSignature.beatUnit}
          onChange={(event) =>
            update({
              timeSignature: { ...settings.timeSignature, beatUnit: Number(event.target.value) },
            })
          }
        >
          {BEAT_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </select>
      </label>
      <span className="divider" aria-hidden />
      <label className="field-inline">
        <input type="checkbox" checked={settings.loop} onChange={(event) => update({ loop: event.target.checked })} />
        <Repeat size={16} aria-hidden />
        Loop
      </label>
      {/* The loop region can be typed as well as dragged on the ruler. */}
      <label className="field">
        Loop start (bar)
        <input
          type="number"
          min={1}
          step={0.25}
          value={shown(loopStartBar)}
          style={{ width: "5em" }}
          onChange={(event) => {
            const bars = Number(event.target.value);
            if (event.target.value !== "" && bars >= 1) {
              // The loop keeps its length in bars, wherever the bars are.
              const start = Math.round(tickAtBars(tempoMap, bars));
              update({ loopStart: start, loopEnd: Math.round(tickAtBars(tempoMap, bars + loopBars)) });
            }
          }}
        />
      </label>
      <label className="field">
        Loop length (bars)
        <input
          type="number"
          min={0.25}
          step={0.25}
          value={shown(loopBars)}
          style={{ width: "5em" }}
          onChange={(event) => {
            const bars = Number(event.target.value);
            if (event.target.value !== "" && bars > 0) {
              update({ loopEnd: Math.round(tickAtBars(tempoMap, loopStartBar + bars)) });
            }
          }}
        />
      </label>
      <output aria-label="Loop region" className="hint num">
        {formatPosition(settings.loopStart, tempoMap)}–
        {formatPosition(settings.loopEnd, tempoMap)}
      </output>
      <label className="field-inline">
        <input
          type="checkbox"
          checked={settings.metronome}
          onChange={(event) => update({ metronome: event.target.checked })}
        />
        <Timer size={16} aria-hidden />
        Metronome
      </label>
    </fieldset>
  );
}

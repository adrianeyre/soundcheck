import { useMemo } from "react";

import type { DjAnalysis } from "../audio/audio-output";
import { beatSeconds, type HotCue } from "./dj-logic";

/** The lows', mids' and highs' colours, drawn over one another as rekordbox's RGB waveform is. */
const BAND_COLOURS = ["var(--dj-low)", "var(--dj-mid)", "var(--dj-high)"] as const;

/** Each column's peak of each band, and overall, over `columns` columns of `from` to `to` seconds. */
export function columnsOf(analysis: DjAnalysis, from: number, to: number, columns: number): number[][] {
  const { waveform, waveformRate } = analysis;
  const points = waveform.length / 4;
  const out: number[][] = [];
  for (let column = 0; column < columns; column++) {
    const start = Math.floor((from + ((to - from) * column) / columns) * waveformRate);
    const end = Math.max(start + 1, Math.floor((from + ((to - from) * (column + 1)) / columns) * waveformRate));
    const peak = [0, 0, 0, 0];
    for (let point = Math.max(0, start); point < Math.min(points, end); point++) {
      for (let band = 0; band < 4; band++) peak[band] = Math.max(peak[band]!, waveform[point * 4 + band]!);
    }
    out.push(peak);
  }
  return out;
}

/** The outline of one band's column peaks, mirrored about the middle. */
function bandPath(columns: number[][], band: number, width: number, height: number): string {
  if (columns.length === 0) return "";
  const step = width / columns.length;
  const mid = height / 2;
  const top = columns.map((column, i) => `${(i * step).toFixed(1)},${(mid - Math.min(1, column[band]!) * mid).toFixed(1)}`);
  const bottom = columns
    .map((column, i) => `${(i * step).toFixed(1)},${(mid + Math.min(1, column[band]!) * mid).toFixed(1)}`)
    .toReversed();
  return `M${top.join(" L")} L${bottom.join(" L")} Z`;
}

function Bands({ columns, width, height }: { columns: number[][]; width: number; height: number }) {
  return (
    <g className="dj-bands">
      {[0, 1, 2].map((band) => (
        <path key={band} d={bandPath(columns, band, width, height)} fill={BAND_COLOURS[band]} />
      ))}
    </g>
  );
}

export interface OverviewProps {
  deck: number;
  analysis: DjAnalysis;
  position: number;
  cue: number;
  hotCues: readonly (HotCue | null)[];
  loop: { start: number; end: number } | null;
  /** Needle Search: move the playhead to `seconds`. */
  onSeek: (seconds: number) => void;
  /** Its name, when the Deck's own overview already has "Deck N needle search". */
  label?: string;
}

const OVERVIEW_WIDTH = 600;
const OVERVIEW_HEIGHT = 44;

/**
 * The whole track at a glance, coloured by its lows, mids and highs, with
 * the playhead, the cue, the Hot Cues and the loop. What has played is
 * dimmed. Clicking it moves the playhead there (Needle Search); with the
 * keyboard, the arrow keys move it by five seconds.
 */
export function Overview({ deck, analysis, position, cue, hotCues, loop, onSeek, label }: OverviewProps) {
  const columns = useMemo(() => columnsOf(analysis, 0, analysis.seconds, 300), [analysis]);
  const x = (seconds: number) => (seconds / Math.max(0.001, analysis.seconds)) * OVERVIEW_WIDTH;
  return (
    <svg
      role="slider"
      tabIndex={0}
      aria-label={label ?? `Deck ${deck + 1} needle search`}
      aria-valuemin={0}
      aria-valuemax={Math.round(analysis.seconds)}
      aria-valuenow={Math.round(position)}
      aria-valuetext={`${Math.round(position)} of ${Math.round(analysis.seconds)} seconds`}
      className="dj-overview"
      viewBox={`0 0 ${OVERVIEW_WIDTH} ${OVERVIEW_HEIGHT}`}
      preserveAspectRatio="none"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        if (box.width > 0) onSeek(((event.clientX - box.left) / box.width) * analysis.seconds);
      }}
      onKeyDown={(event) => {
        const by = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5 }[event.key];
        if (by === undefined) return;
        event.preventDefault();
        onSeek(Math.min(analysis.seconds, Math.max(0, position + by)));
      }}
    >
      <Bands columns={columns} width={OVERVIEW_WIDTH} height={OVERVIEW_HEIGHT} />
      <rect x={0} y={0} width={x(position)} height={OVERVIEW_HEIGHT} className="dj-played" />
      {loop && <rect x={x(loop.start)} y={0} width={Math.max(1, x(loop.end) - x(loop.start))} height={OVERVIEW_HEIGHT} className="dj-loop" />}
      <line x1={x(cue)} x2={x(cue)} y1={0} y2={OVERVIEW_HEIGHT} className="dj-cue-line" vectorEffect="non-scaling-stroke" />
      {hotCues.map(
        (hot, index) =>
          hot && (
            <rect key={index} x={x(hot.seconds) - 2} y={0} width={4} height={6} fill={hot.colour} />
          ),
      )}
      <line x1={x(position)} x2={x(position)} y1={0} y2={OVERVIEW_HEIGHT} className="dj-playhead" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export interface ZoomProps {
  deck: number;
  analysis: DjAnalysis;
  position: number;
  /** Seconds shown either side of the playhead. */
  span: number;
  bpm: number;
  firstBeat: number;
  cue: number;
  hotCues: readonly (HotCue | null)[];
  loop: { start: number; end: number } | null;
  /** The pixels it is shown at; a stretched 800 by 90 without. */
  size?: { width: number; height: number };
}

const DEFAULT_ZOOM = { width: 800, height: 90 };

/**
 * The waveform close up, scrolling past a playhead fixed in the middle, with
 * the Beat Grid's beats drawn over it, each bar's first beat bold and
 * numbered, and the cue, Hot Cues and loop.
 */
export function Zoom({ deck, analysis, position, span, bpm, firstBeat, cue, hotCues, loop, size = DEFAULT_ZOOM }: ZoomProps) {
  // Drawn at the size it is shown, where that is known, so its numbers aren't stretched.
  const ZOOM_WIDTH = Math.max(1, Math.round(size.width));
  const ZOOM_HEIGHT = Math.max(1, Math.round(size.height));
  const from = position - span;
  const to = position + span;
  // Columns fixed to the file's own time, so the waveform doesn't shimmer as it scrolls.
  const width = (to - from) / 200;
  const snapped = Math.floor(from / width) * width;
  const columns = columnsOf(analysis, snapped, snapped + 202 * width, 202);
  const x = (seconds: number) => ((seconds - from) / (to - from)) * ZOOM_WIDTH;
  const beat = beatSeconds(bpm);
  const beats: { seconds: number; bar: boolean; number: number }[] = [];
  if (beat > 0) {
    const first = Math.ceil((from - firstBeat) / beat);
    for (let n = first; firstBeat + n * beat <= to && beats.length < 400; n++) {
      beats.push({ seconds: firstBeat + n * beat, bar: n % 4 === 0, number: Math.floor(n / 4) + 1 });
    }
  }
  return (
    <svg
      role="img"
      aria-label={`Deck ${deck + 1} waveform around the playhead${beat > 0 ? ", with its Beat Grid" : ""}`}
      className="dj-zoom"
      viewBox={`0 0 ${ZOOM_WIDTH} ${ZOOM_HEIGHT}`}
      preserveAspectRatio="none"
    >
      <g transform={`translate(${x(snapped)} 0)`}>
        <Bands columns={columns} width={(202 * width * ZOOM_WIDTH) / (to - from)} height={ZOOM_HEIGHT} />
      </g>
      {loop && <rect x={x(loop.start)} y={0} width={Math.max(1, x(loop.end) - x(loop.start))} height={ZOOM_HEIGHT} className="dj-loop" />}
      {beats.map((b) => (
        <g key={b.seconds}>
          <line
            x1={x(b.seconds)}
            x2={x(b.seconds)}
            y1={0}
            y2={ZOOM_HEIGHT}
            className={b.bar ? "dj-bar-line" : "dj-beat-line"}
            vectorEffect="non-scaling-stroke"
          />
          {b.bar && (
            <text x={x(b.seconds) + 3} y={10} className="dj-bar-number">
              {b.number}
            </text>
          )}
        </g>
      ))}
      <line x1={x(cue)} x2={x(cue)} y1={0} y2={ZOOM_HEIGHT} className="dj-cue-line" vectorEffect="non-scaling-stroke" />
      {hotCues.map(
        (hot, index) =>
          hot && (
            <line
              key={index}
              x1={x(hot.seconds)}
              x2={x(hot.seconds)}
              y1={0}
              y2={ZOOM_HEIGHT}
              stroke={hot.colour}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          ),
      )}
      <line x1={ZOOM_WIDTH / 2} x2={ZOOM_WIDTH / 2} y1={0} y2={ZOOM_HEIGHT} className="dj-playhead" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

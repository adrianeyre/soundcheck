import { ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DjAnalysis } from "../audio/audio-output";
import { beatSeconds, camelotName, formatBpm, formatTime, type HotCue, keyName, quantize, shiftKey } from "./dj-logic";
import type { DeckReport } from "./dj-report";
import { Overview, Zoom } from "./Waveform";

/** Seconds either side of the playhead the lanes can show. */
export const STACK_ZOOMS = [1, 2, 4, 8, 16, 32] as const;

/** How long a still hand holds a scratched record before it is let go to stop. */
const SETTLE_MS = 80;

export interface StackLane {
  deck: number;
  report: DeckReport;
  analysis: DjAnalysis | null;
  hotCues: readonly (HotCue | null)[];
  title: string | null;
  syncMaster: boolean;
  /** The Deck's jog mode: in vinyl mode, dragging a playing lane scratches. */
  vinyl?: boolean;
}

export interface WaveformStackProps {
  lanes: readonly StackLane[];
  /** Seconds either side of the playhead. */
  span: number;
  onSpan: (span: number) => void;
  /**
   * Tell the engine a Deck's control `name` is now `value`, as the Deck's
   * own `set` does. Without it the lanes only show.
   */
  onDeck?: (deck: number, name: string, value: number) => void;
}

/** A drag in progress on a lane. */
interface Scrub {
  pointer: number;
  x: number;
  time: number;
  /** Where the playhead is being taken, in seconds. */
  position: number;
  scratching: boolean;
  settle: ReturnType<typeof setTimeout> | null;
}

/**
 * Where a lane dragged from `start` by `dx` of its `width` pixels, showing
 * `span` seconds either side of the playhead, puts the playhead: dragging
 * the waveform right brings earlier audio under the playhead, as dragging a
 * record back does.
 */
export function scrubbedTo(start: number, dx: number, width: number, span: number, duration: number): number {
  const seconds = width > 0 ? (dx / width) * span * 2 : 0;
  return Math.min(duration, Math.max(0, start - seconds));
}

/** The size `ref` is shown at, following it as it is resized; null until measured (and where nothing measures). */
function useSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box && box.width > 0 && box.height > 0) setSize({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** One Deck's lane: its facts, its waveform to drag, and its overview to click. */
function Lane({ lane, span, onDeck }: { lane: StackLane; span: number; onDeck?: WaveformStackProps["onDeck"] }) {
  const { deck, report, analysis, hotCues, title, syncMaster, vinyl = false } = lane;
  const scrub = useRef<Scrub | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const size = useSize(area);
  const key = analysis?.key ? shiftKey(analysis.key, report.keyShift) : null;
  const loaded = analysis !== null && report.loaded;
  const set = onDeck && ((name: string, value: number) => onDeck(deck, name, value));
  const beat = beatSeconds(report.bpm);

  const seek = (seconds: number) => set?.("seek", Math.min(report.duration, Math.max(0, seconds)));

  return (
    <div className="dj-stack-lane" data-deck={deck} data-playing={report.playing}>
      <div className="dj-stack-label">
        <span className="dj-deck-number">{deck + 1}</span>
        <div className="dj-stack-facts">
          <span className="dj-stack-title">{title ?? "No track"}</span>
          <span className="num">
            {formatBpm(report.effectiveBpm)} <span className="dj-hw-caption">BPM</span>
            {syncMaster && <span className="dj-badge" data-kind="master">MASTER</span>}
            {report.sync && <span className="dj-badge" data-kind="sync">SYNC</span>}
          </span>
          <span className="num">
            {key ? `${keyName(key)} · ${camelotName(key)}` : "—"}
            {report.loaded && <span className="dj-stack-remain"> −{formatTime(report.duration - report.position)}</span>}
          </span>
        </div>
      </div>
      {loaded ? (
        <div className="dj-stack-wave">
          <div
            ref={area}
            className="dj-stack-scrub"
            role={set ? "slider" : undefined}
            tabIndex={set ? 0 : undefined}
            aria-label={set ? `Deck ${deck + 1} waveform: drag it, or use the arrow keys, to move through the track` : undefined}
            aria-valuemin={set ? 0 : undefined}
            aria-valuemax={set ? Math.round(report.duration) : undefined}
            aria-valuenow={set ? Math.round(report.position) : undefined}
            aria-valuetext={set ? `${formatTime(report.position)} of ${formatTime(report.duration)}` : undefined}
            aria-keyshortcuts={set ? "ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight" : undefined}
            onKeyDown={(event) => {
              if (!set || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
              event.preventDefault();
              // A beat each, a bar with Shift; a second each without a Beat Grid.
              const step = (beat > 0 ? beat : 1) * (event.shiftKey ? 4 : 1);
              const target = report.position + (event.key === "ArrowLeft" ? -step : step);
              seek(report.quantize && beat > 0 ? quantize(target, report.bpm, report.firstBeat) : target);
            }}
            onPointerDown={(event) => {
              if (!set) return;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              const scratching = report.playing && vinyl;
              scrub.current = { pointer: event.pointerId, x: event.clientX, time: event.timeStamp, position: report.position, scratching, settle: null };
              if (scratching) {
                set("touch", 1);
                set("scratch", 0);
              }
            }}
            onPointerMove={(event) => {
              const held = scrub.current;
              if (!set || !held || held.pointer !== event.pointerId) return;
              const width = event.currentTarget.getBoundingClientRect().width;
              const dx = event.clientX - held.x;
              const next = scrubbedTo(held.position, dx, width, span, report.duration);
              const dt = Math.max(0.001, (event.timeStamp - held.time) / 1000);
              if (held.scratching) {
                // The record follows the hand: seconds of it moved per second.
                set("scratch", (next - held.position) / dt);
                if (held.settle) clearTimeout(held.settle);
                held.settle = setTimeout(() => set("scratch", 0), SETTLE_MS);
              } else {
                seek(next);
              }
              scrub.current = { ...held, x: event.clientX, time: event.timeStamp, position: next };
            }}
            onPointerUp={(event) => {
              const held = scrub.current;
              scrub.current = null;
              if (!set || !held || held.pointer !== event.pointerId) return;
              if (held.settle) clearTimeout(held.settle);
              if (held.scratching) set("touch", 0);
              else if (report.quantize && beat > 0) seek(quantize(held.position, report.bpm, report.firstBeat));
            }}
            onPointerCancel={() => {
              const held = scrub.current;
              scrub.current = null;
              if (held?.settle) clearTimeout(held.settle);
              if (held?.scratching) set?.("touch", 0);
            }}
          >
            <Zoom
              deck={deck}
              analysis={analysis}
              position={report.position}
              span={span}
              bpm={report.bpm}
              firstBeat={report.firstBeat}
              cue={report.cue}
              hotCues={hotCues}
              loop={report.loop}
              size={size ?? undefined}
            />
          </div>
          {set && (
            <Overview
              deck={deck}
              label={`Deck ${deck + 1} whole track: click to move there`}
              analysis={analysis}
              position={report.position}
              cue={report.cue}
              hotCues={hotCues}
              loop={report.loop}
              onSeek={(seconds) => seek(report.quantize && beat > 0 ? quantize(seconds, report.bpm, report.firstBeat) : seconds)}
            />
          )}
        </div>
      ) : (
        <div className="dj-stack-empty">Deck {deck + 1} is empty</div>
      )}
    </div>
  );
}

/**
 * The waveforms of every Deck, one lane above the other across the top of
 * the page, as a club player's linked screen or DJ software shows them: each
 * a close-up of its three bands scrolling past a playhead fixed in the
 * middle, with its Beat Grid, so it is plain when two Decks' beats line up.
 * Beside each lane, the Deck's number in its colour, its BPM and its key.
 * Dragging a lane moves its Deck through the track (scratching, if the Deck
 * is playing in vinyl mode), the arrow keys move it a beat (a bar with
 * Shift), and clicking the strip under it jumps there.
 */
export function WaveformStack({ lanes, span, onSpan, onDeck }: WaveformStackProps) {
  const zoom = STACK_ZOOMS.indexOf(span as (typeof STACK_ZOOMS)[number]);
  return (
    <section className="dj-stack dj-hw" aria-label="Waveforms">
      <div className="dj-stack-lanes">
        {lanes.map((lane) => (
          <Lane key={lane.deck} lane={lane} span={span} onDeck={onDeck} />
        ))}
      </div>
      <div className="dj-stack-zoom" role="group" aria-label="Waveform zoom">
        <button
          type="button"
          className="dj-hw-button"
          aria-label="Zoom the waveforms in"
          disabled={zoom <= 0}
          onClick={() => onSpan(STACK_ZOOMS[zoom - 1]!)}
        >
          <ZoomIn size={14} aria-hidden />
        </button>
        <span className="num dj-hw-caption" aria-label={`Showing ${span * 2} seconds`}>
          {span * 2}S
        </span>
        <button
          type="button"
          className="dj-hw-button"
          aria-label="Zoom the waveforms out"
          disabled={zoom >= STACK_ZOOMS.length - 1}
          onClick={() => onSpan(STACK_ZOOMS[zoom + 1]!)}
        >
          <ZoomOut size={14} aria-hidden />
        </button>
      </div>
    </section>
  );
}

/**
 * Where a Deck's playhead is between the engine's reports, so its waveform
 * scrolls every animation frame instead of jumping each time a report comes
 * in. The engine reports the position about 25 times a second; between
 * reports the playhead is carried on at the Deck's speed, and each report
 * pulls it back onto the engine's position. Nothing here makes sound: the
 * engine's position is still the one that plays.
 */
import { useEffect, useRef, useState } from "react";

import type { DeckReport } from "./dj-report";

/** The last position a report gave, and when it was read, in milliseconds. */
export interface Anchor {
  position: number;
  time: number;
  /** Seconds of the track per second, signed: 0 when still. */
  speed: number;
  duration: number;
  loop: { start: number; end: number } | null;
}

/** Past this far from the engine's position, in seconds, the playhead jumps to it: a seek, a Hot Cue, a loop wrapping. */
export const SNAP_SECONDS = 0.25;
/** How much of the way back to the engine's position each report pulls a playhead that drifted, 0 to 1. */
const PULL = 0.35;
/** The longest a playhead is carried on past a report, in milliseconds: a stalled page stops rather than running away. */
const MAX_AHEAD_MS = 250;

/** Where the playhead is at `now`: the anchor carried on at its speed, round its loop and within the track. */
export function predictPosition(anchor: Anchor, now: number): number {
  const ahead = Math.min(MAX_AHEAD_MS, Math.max(0, now - anchor.time)) / 1000;
  let position = anchor.position + anchor.speed * ahead;
  const { loop } = anchor;
  if (loop && loop.end > loop.start) {
    const length = loop.end - loop.start;
    if (anchor.speed > 0 && position >= loop.end) position = loop.start + ((position - loop.start) % length);
    if (anchor.speed < 0 && position < loop.start) position = loop.end - ((loop.end - position) % length);
  }
  return Math.min(anchor.duration, Math.max(0, position));
}

/**
 * The anchor after a report of `report` read at `now`, from the playhead as
 * it was drawn: close to the engine, it eases back onto it, so the scroll
 * never stutters backwards on a late report; far from it, it jumps there.
 */
export function reanchor(drawn: number | null, report: Pick<DeckReport, "position" | "speed" | "duration" | "loop">, now: number): Anchor {
  const near = drawn !== null && Math.abs(drawn - report.position) < SNAP_SECONDS;
  return {
    position: near ? drawn + (report.position - drawn) * PULL : report.position,
    time: now,
    speed: report.speed,
    duration: report.duration,
    loop: report.loop,
  };
}

/**
 * A Deck's playhead as it should be drawn now, moving every animation
 * frame while the Deck moves, and exactly the engine's position while it is
 * still. Where there are no animation frames (tests, a hidden page), it is
 * the engine's position.
 */
export function useSmoothPosition(report: DeckReport): number {
  const [drawn, setDrawn] = useState(report.position);
  const anchor = useRef<Anchor | null>(null);
  const shown = useRef<number | null>(null);
  const moving = report.speed !== 0;

  // Each report re-anchors the playhead where it is drawn.
  useEffect(() => {
    // Still, the playhead is exactly the engine's; set moving again, it starts from there.
    if (!moving) shown.current = null;
    anchor.current = reanchor(moving ? shown.current : null, report, performance.now());
  }, [report, moving]);

  useEffect(() => {
    if (!moving || typeof requestAnimationFrame === "undefined") return;
    let frame = requestAnimationFrame(function step(now) {
      const at = anchor.current;
      if (at) {
        const position = predictPosition(at, now);
        shown.current = position;
        setDrawn(position);
      }
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [moving]);

  return moving ? drawn : report.position;
}

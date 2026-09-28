import { useRef } from "react";

import type { HotCue } from "./dj-logic";

/** A record at 33⅓ RPM turns once every 1.8 seconds. */
export const SECONDS_PER_TURN = 1.8;
/** How far a held nudge key bends the tempo. */
const NUDGE = 0.04;

export interface JogWheelProps {
  deck: number;
  position: number;
  cue: number;
  hotCues: readonly (HotCue | null)[];
  /** Vinyl mode: the top of the platter scratches. Otherwise it bends the pitch. */
  vinyl: boolean;
  playing: boolean;
  /** The hand on (true) or off the platter. */
  onTouch: (on: boolean) => void;
  /** Where a scratch is taking the record, as a speed: 1 is its own. */
  onScratch: (speed: number) => void;
  /** A nudge to the tempo while the edge is turned: 0.04 is 4% faster. */
  onBend: (bend: number) => void;
}

/** The angle, in degrees, of a moment of the track on the turning platter. */
export function platterAngle(seconds: number): number {
  return ((((seconds / SECONDS_PER_TURN) % 1) + 1) % 1) * 360;
}

/**
 * The CDJ's jog wheel: a platter turning with the track, with the cue and
 * Hot Cues marked around its ring. In vinyl mode, dragging its top scratches
 * (the platter's speed follows the hand); in CDJ mode, or on its outer ring,
 * dragging bends the tempo to nudge the beat. With the keyboard, the arrow
 * keys held nudge it slower or faster.
 */
export function JogWheel({ deck, position, cue, hotCues, vinyl, playing, onTouch, onScratch, onBend }: JogWheelProps) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ angle: number; time: number; scratch: boolean } | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const angleAt = (event: React.PointerEvent) => {
    const box = svg.current!.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    return { degrees: (Math.atan2(dy, dx) * 180) / Math.PI, edge: Math.hypot(dx, dy) > box.width * 0.4 };
  };

  const rotation = platterAngle(position);
  // A mark on the platter reaches the top (the needle) as the track reaches it, and turns with it.
  const marker = (seconds: number) => platterAngle(position - seconds);

  return (
    <svg
      ref={svg}
      role="group"
      tabIndex={0}
      aria-label={`Deck ${deck + 1} jog wheel: hold the left or right arrow to nudge the beat ${vinyl ? "; drag the platter to scratch" : ""}`}
      aria-keyshortcuts="ArrowLeft ArrowRight"
      className="dj-jog"
      data-vinyl={vinyl}
      data-playing={playing}
      viewBox="0 0 200 200"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        if (!event.repeat) onBend(event.key === "ArrowLeft" ? -NUDGE : NUDGE);
      }}
      onKeyUp={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") onBend(0);
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const { degrees, edge } = angleAt(event);
        const scratch = vinyl && !edge;
        drag.current = { angle: degrees, time: event.timeStamp, scratch };
        if (scratch) {
          onTouch(true);
          onScratch(0);
        }
      }}
      onPointerMove={(event) => {
        const held = drag.current;
        if (!held) return;
        const { degrees } = angleAt(event);
        const seconds = Math.max(0.001, (event.timeStamp - held.time) / 1000);
        const turned = ((degrees - held.angle + 540) % 360) - 180;
        const speed = turned / 360 / seconds * SECONDS_PER_TURN;
        drag.current = { ...held, angle: degrees, time: event.timeStamp };
        if (held.scratch) onScratch(speed);
        else onBend(Math.max(-0.5, Math.min(0.5, speed * 0.1)));
        // A hand that stops, stops the record (or the bend).
        if (settle.current) clearTimeout(settle.current);
        settle.current = setTimeout(() => (held.scratch ? onScratch(0) : onBend(0)), 80);
      }}
      onPointerUp={() => {
        const held = drag.current;
        drag.current = null;
        if (settle.current) clearTimeout(settle.current);
        if (held?.scratch) onTouch(false);
        else onBend(0);
      }}
    >
      <circle cx={100} cy={100} r={96} className="dj-jog-ring" />
      <circle cx={100} cy={100} r={80} className="dj-jog-platter" />
      <g transform={`rotate(${rotation} 100 100)`}>
        <circle cx={100} cy={100} r={62} className="dj-jog-label" />
        <line x1={100} y1={40} x2={100} y2={66} className="dj-jog-mark" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((groove) => (
          <circle key={groove} cx={100} cy={100} r={66 + groove * 1.6} className="dj-jog-groove" />
        ))}
      </g>
      <g aria-hidden>
        <line
          x1={100}
          y1={4}
          x2={100}
          y2={18}
          transform={`rotate(${marker(cue)} 100 100)`}
          className="dj-jog-cue"
        />
        {hotCues.map(
          (hot, index) =>
            hot && (
              <circle
                key={index}
                cx={100}
                cy={10}
                r={4}
                fill={hot.colour}
                transform={`rotate(${marker(hot.seconds)} 100 100)`}
              />
            ),
        )}
      </g>
      <circle cx={100} cy={100} r={14} className="dj-jog-hub" />
    </svg>
  );
}

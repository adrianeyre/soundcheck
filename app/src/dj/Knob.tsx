import { useRef } from "react";

export interface KnobProps {
  /** Its full name, for assistive technology: "Channel 1 high EQ". */
  label: string;
  /** What is printed under it: "HI". */
  caption?: string;
  value: number;
  min: number;
  max: number;
  /** Where a double-click puts it back, and where its arc starts from. */
  centre?: number;
  /** The keyboard's step; Shift moves ten of them. */
  step: number;
  /** How the value is read out: "−6.0 dB". */
  format: (value: number) => string;
  onChange: (value: number) => void;
  /** A colour for its arc, from the design tokens. */
  tone?: string;
  size?: number;
}

const SWEEP = 270;

/**
 * A rotary knob, as a mixer's: dragged up and down, or turned with the
 * arrow keys (Shift for bigger steps, Home and End for its ends), and put
 * back to its centre with a double-click or Delete. A slider to assistive
 * technology, with its value read out in its own units.
 */
export function Knob({ label, caption, value, min, max, centre = min, step, format, onChange, tone = "var(--primary)", size = 44 }: KnobProps) {
  const drag = useRef<{ y: number; value: number } | null>(null);
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const fraction = (value - min) / (max - min || 1);
  const angle = -SWEEP / 2 + fraction * SWEEP;
  const centreAngle = -SWEEP / 2 + ((centre - min) / (max - min || 1)) * SWEEP;
  const r = 15;
  const point = (degrees: number) => {
    const radians = ((degrees - 90) * Math.PI) / 180;
    return [20 + r * Math.cos(radians), 20 + r * Math.sin(radians)] as const;
  };
  const arc = (from: number, to: number) => {
    const [a, b] = [Math.min(from, to), Math.max(from, to)];
    const [x1, y1] = point(a);
    const [x2, y2] = point(b);
    return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
  };
  const [tipX, tipY] = point(angle);

  return (
    <div className="dj-knob" style={{ width: size + 16 }}>
      <svg
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(value.toFixed(3))}
        aria-valuetext={format(value)}
        aria-keyshortcuts="ArrowUp ArrowDown Home End Delete"
        width={size}
        height={size}
        viewBox="0 0 40 40"
        onKeyDown={(event) => {
          const big = event.shiftKey ? 10 : 1;
          const moves: Record<string, number> = {
            ArrowUp: step * big,
            ArrowRight: step * big,
            ArrowDown: -step * big,
            ArrowLeft: -step * big,
          };
          if (event.key in moves) onChange(clamp(value + moves[event.key]!));
          else if (event.key === "Home") onChange(min);
          else if (event.key === "End") onChange(max);
          else if (event.key === "Delete" || event.key === "Backspace") onChange(centre);
          else return;
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          drag.current = { y: event.clientY, value };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const travel = (drag.current.y - event.clientY) / 150;
          onChange(clamp(drag.current.value + travel * (max - min) * (event.shiftKey ? 0.1 : 1)));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onDoubleClick={() => onChange(centre)}
      >
        <circle cx={20} cy={20} r={17} className="dj-knob-body" />
        <path d={arc(-SWEEP / 2, SWEEP / 2)} className="dj-knob-track" />
        {Math.abs(angle - centreAngle) > 0.5 && <path d={arc(centreAngle, angle)} stroke={tone} className="dj-knob-arc" />}
        <line x1={20} y1={20} x2={tipX} y2={tipY} className="dj-knob-pointer" />
      </svg>
      <span className="dj-knob-label" aria-hidden>
        {caption ?? label}
      </span>
      <span className="dj-knob-value num">{format(value)}</span>
    </div>
  );
}

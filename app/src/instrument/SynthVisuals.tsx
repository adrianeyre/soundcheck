/**
 * Pictures of the Synth's settings, as a hardware synth's screen draws them:
 * its two oscillators' waves mixed, the amp and filter envelopes, the filter's
 * response and the LFO. Each is a function of the settings; none processes
 * audio.
 *
 * Given `onChange`, each picture is also a control, as in Serum or Vital:
 * drag a handle to reshape it (the filter's peak across for its cutoff and
 * up for its resonance, an envelope's corners for its times and sustain, the
 * LFO for its rate and depth, the oscillators up and down for their mix).
 * A drag is drawn as it moves and becomes one change when it is let go, so
 * it undoes in one step. Each handle takes the arrow keys too: left and
 * right for what dragging across changes, up and down for the other.
 */
import { useState } from "react";

import { filterResponseDb } from "../effect/effect-visuals";
import type { SynthSettings } from "./synth-params";

const W = 240;
const H = 90;

/** One of the Synth's waves at `phase` (0 to 1 is one cycle), from -1 to 1. */
export function wave(shape: SynthSettings["osc1Wave"], phase: number): number {
  const t = phase - Math.floor(phase);
  switch (shape) {
    case "square":
      return t < 0.5 ? 1 : -1;
    case "triangle":
      return 1 - 4 * Math.abs(t - 0.5);
    case "sine":
      return Math.sin(2 * Math.PI * t);
    default:
      return 2 * t - 1;
  }
}

export interface EnvelopeShape {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/**
 * The envelope's corners, in seconds and level, for a note held `hold`
 * seconds past its decay: up to 1 over the attack, down to the sustain over
 * the decay, held, then down to 0 over the release.
 */
export function envelopePoints({ attack, decay, sustain, release }: EnvelopeShape, hold: number): [number, number][] {
  const peak = attack;
  const settled = peak + decay;
  const letGo = settled + hold;
  return [
    [0, 0],
    [peak, 1],
    [settled, sustain],
    [letGo, sustain],
    [letGo + release, 0],
  ];
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** A value on a log scale from `low` to `high`, as 0 to 1, and back. */
export function logFraction(value: number, low: number, high: number): number {
  return clamp(Math.log(value / low) / Math.log(high / low), 0, 1);
}

export function fromLogFraction(fraction: number, low: number, high: number): number {
  return low * (high / low) ** clamp(fraction, 0, 1);
}

// The Synth's ranges, as its settings table declares them.
const [MIN_TIME, MAX_TIME] = [0.001, 10];
const [MIN_HZ, MAX_HZ] = [20, 20_000];
const [MIN_Q, MAX_Q] = [0.1, 20];
const [MIN_RATE, MAX_RATE] = [0.01, 20];

/**
 * Where an envelope's corners are drawn, so each can be dragged: the
 * attack, decay and release each have a zone of their own, a quarter-odd of
 * the width, in which their time runs on a log scale from 1 ms to 10 s, and
 * the sustain is held for a fixed stretch. So dragging one corner never
 * moves the scale under another.
 */
const ZONE = W * 0.28;
const HOLD = W * 0.12;

export function envelopeLayout(shape: EnvelopeShape): { attackX: number; decayX: number; holdX: number; releaseX: number } {
  const attackX = ZONE * logFraction(shape.attack, MIN_TIME, MAX_TIME);
  const decayX = attackX + ZONE * logFraction(shape.decay, MIN_TIME, MAX_TIME);
  const holdX = decayX + HOLD;
  const releaseX = holdX + ZONE * logFraction(shape.release, MIN_TIME, MAX_TIME);
  return { attackX, decayX, holdX, releaseX };
}

const TOP = 6;
const BOTTOM = H - 4;
const levelY = (level: number) => BOTTOM - level * (BOTTOM - TOP);
const yLevel = (y: number) => clamp((BOTTOM - y) / (BOTTOM - TOP), 0, 1);

function path(points: readonly [number, number][]): string {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

/** Where a pointer is in the picture's own units. */
function pointIn(svg: SVGSVGElement | null, event: React.PointerEvent): [number, number] | null {
  const box = svg?.getBoundingClientRect();
  if (!box || box.width === 0 || box.height === 0) return null;
  return [((event.clientX - box.left) / box.width) * W, ((event.clientY - box.top) / box.height) * H];
}

interface HandleProps {
  x: number;
  y: number;
  colour: string;
  label: string;
  valueText: string;
  /** Where it has been dragged to, in the picture's units. */
  onDrag: (x: number, y: number) => void;
  onRelease: () => void;
  /** An arrow key: `dx` and `dy` are -1, 0 or 1, up being 1. */
  onStep: (dx: number, dy: number) => void;
}

/**
 * A point to drag in a picture, with a bigger invisible target round it than
 * it looks, and the arrow keys as its keyboard route.
 */
function Handle({ x, y, colour, label, valueText, onDrag, onRelease, onStep }: HandleProps) {
  return (
    <g
      className="synth-handle"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuetext={valueText}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(clamp(x / W, 0, 1).toFixed(3))}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
        const at = pointIn(event.currentTarget.ownerSVGElement, event);
        if (at) onDrag(clamp(at[0], 0, W), clamp(at[1], 0, H));
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        onRelease();
      }}
      onKeyDown={(event) => {
        const steps: Record<string, [number, number]> = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, 1],
          ArrowDown: [0, -1],
        };
        const step = steps[event.key];
        if (!step) return;
        event.preventDefault();
        onStep(...step);
      }}
    >
      <circle cx={x} cy={y} r={12} className="synth-handle-target" />
      <circle cx={x} cy={y} r={7} fill={colour} opacity={0.25} />
      <circle cx={x} cy={y} r={4.5} fill={colour} className="synth-handle-dot" />
    </g>
  );
}

function Picture({
  label,
  title,
  interactive,
  children,
}: {
  label: string;
  title: string;
  interactive: boolean;
  children: React.ReactNode;
}) {
  return (
    <figure className="synth-visual" data-interactive={interactive}>
      <svg role={interactive ? "group" : "img"} aria-label={label} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {children}
      </svg>
      <figcaption>{title}</figcaption>
    </figure>
  );
}

/** How a picture changes the Synth: a drag draws `draft` and settles into one change. */
interface Editing {
  drag: (change: Partial<SynthSettings>) => void;
  release: () => void;
  /** A keyboard step: one change straight away. */
  step: (change: Partial<SynthSettings>) => void;
}

// Each arrow key press moves a log-scaled setting by a twentieth of its range, and a level by 5%.
const LOG_STEP = 1 / 20;
const LEVEL_STEP = 0.05;
/** A level moved by `steps` of `LEVEL_STEP`, kept to whole percent and within 0 to 1. */
const stepLevel = (level: number, steps: number) => clamp(Math.round((level + steps * LEVEL_STEP) * 100) / 100, 0, 1);

function Oscillators({ settings, editing }: { settings: SynthSettings; editing: Editing | null }) {
  // Two cycles of oscillator 1; oscillator 2 runs at its detune's ratio.
  const ratio = 2 ** (settings.osc2Detune / 1200);
  const points = Array.from({ length: 241 }, (_, index): [number, number] => {
    const phase = (index / 240) * 2;
    const mixed = wave(settings.osc1Wave, phase) * (1 - settings.oscMix) + wave(settings.osc2Wave, phase * ratio) * settings.oscMix;
    return [(index / 240) * W, H / 2 - mixed * (H / 2 - 6)];
  });
  const mixText = `${Math.round(settings.oscMix * 100)}% oscillator 2`;
  return (
    <Picture
      label={`Oscillators: ${settings.osc1Wave} and ${settings.osc2Wave}, mixed ${Math.round(settings.oscMix * 100)}%`}
      title="Oscillators"
      interactive={editing !== null}
    >
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
      <path d={path(points)} fill="none" stroke="var(--primary)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {editing && (
        <>
          {/* The mix, as a fader down the right-hand edge: up is all oscillator 2. */}
          <line x1={W - 8} x2={W - 8} y1={TOP} y2={BOTTOM} stroke="var(--lane-bar)" vectorEffect="non-scaling-stroke" />
          <Handle
            x={W - 8}
            y={levelY(settings.oscMix)}
            colour="var(--primary)"
            label="Oscillator mix"
            valueText={mixText}
            onDrag={(_, y) => editing.drag({ oscMix: Math.round(yLevel(y) * 100) / 100 })}
            onRelease={editing.release}
            onStep={(dx, dy) => editing.step({ oscMix: stepLevel(settings.oscMix, dx + dy) })}
          />
        </>
      )}
    </Picture>
  );
}

type EnvelopeKeys = { attack: keyof SynthSettings; decay: keyof SynthSettings; sustain: keyof SynthSettings; release: keyof SynthSettings };

const AMP_KEYS: EnvelopeKeys = { attack: "attack", decay: "decay", sustain: "sustain", release: "release" };
const FILTER_KEYS: EnvelopeKeys = {
  attack: "filterAttack",
  decay: "filterDecay",
  sustain: "filterSustain",
  release: "filterRelease",
};

const seconds = (value: number) => (value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`);
const time = (fraction: number) => Math.round(fromLogFraction(fraction, MIN_TIME, MAX_TIME) * 10_000) / 10_000;
/** A time moved by `steps` of `LOG_STEP` along its log scale. */
const moveTime = (value: number, steps: number) => time(logFraction(value, MIN_TIME, MAX_TIME) + steps * LOG_STEP);

function Envelope({
  label,
  title,
  settings,
  keys,
  colour,
  editing,
}: {
  label: string;
  title: string;
  settings: SynthSettings;
  keys: EnvelopeKeys;
  colour: string;
  editing: Editing | null;
}) {
  const shape: EnvelopeShape = {
    attack: settings[keys.attack] as number,
    decay: settings[keys.decay] as number,
    sustain: settings[keys.sustain] as number,
    release: settings[keys.release] as number,
  };
  const { attackX, decayX, holdX, releaseX } = envelopeLayout(shape);
  const drawn: [number, number][] = [
    [0, levelY(0)],
    [attackX, levelY(1)],
    [decayX, levelY(shape.sustain)],
    [holdX, levelY(shape.sustain)],
    [releaseX, levelY(0)],
  ];
  return (
    <Picture
      label={`${label}: attack ${shape.attack.toFixed(3)} s, decay ${shape.decay.toFixed(3)} s, sustain ${Math.round(shape.sustain * 100)}%, release ${shape.release.toFixed(3)} s`}
      title={title}
      interactive={editing !== null}
    >
      <path d={`${path(drawn)} Z`} fill={colour} opacity={0.18} />
      <path d={path(drawn)} fill="none" stroke={colour} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {editing ? (
        <>
          <Handle
            x={attackX}
            y={levelY(1)}
            colour={colour}
            label={`${label} attack`}
            valueText={seconds(shape.attack)}
            onDrag={(x) => editing.drag({ [keys.attack]: time(x / ZONE) })}
            onRelease={editing.release}
            onStep={(dx, dy) => editing.step({ [keys.attack]: moveTime(shape.attack, dx + dy) })}
          />
          <Handle
            x={decayX}
            y={levelY(shape.sustain)}
            colour={colour}
            label={`${label} decay and sustain`}
            valueText={`decay ${seconds(shape.decay)}, sustain ${Math.round(shape.sustain * 100)}%`}
            onDrag={(x, y) =>
              editing.drag({ [keys.decay]: time((x - attackX) / ZONE), [keys.sustain]: Math.round(yLevel(y) * 100) / 100 })
            }
            onRelease={editing.release}
            onStep={(dx, dy) =>
              editing.step(
                dx !== 0
                  ? { [keys.decay]: moveTime(shape.decay, dx) }
                  : { [keys.sustain]: stepLevel(shape.sustain, dy) },
              )
            }
          />
          <Handle
            x={releaseX}
            y={levelY(0)}
            colour={colour}
            label={`${label} release`}
            valueText={seconds(shape.release)}
            onDrag={(x) => editing.drag({ [keys.release]: time((x - holdX) / ZONE) })}
            onRelease={editing.release}
            onStep={(dx, dy) => editing.step({ [keys.release]: moveTime(shape.release, dx + dy) })}
          />
        </>
      ) : (
        drawn.slice(1, -1).map(([x, y], index) => <circle key={index} cx={x} cy={y} r={2.5} fill={colour} />)
      )}
    </Picture>
  );
}

const FILTER_MODES = { lowPass: "low-pass", highPass: "high-pass", bandPass: "band-pass" } as const;

/** Across the filter's picture, 20 Hz to 20 kHz on a log scale, and up it, -36 to +24 dB. */
const hzX = (hz: number) => logFraction(hz, MIN_HZ, MAX_HZ) * W;
const filterY = (db: number) => H / 2 - 12 - (Math.max(-36, Math.min(24, db)) / 36) * (H / 2 - 12);
/** The resonance handle's height: its Q on a log scale, low at the bottom. */
const qY = (q: number) => levelY(logFraction(q, MIN_Q, MAX_Q));

const hz = (value: number) => Math.round(value);

function FilterResponse({ settings, editing }: { settings: SynthSettings; editing: Editing | null }) {
  const mode = FILTER_MODES[settings.filterType as keyof typeof FILTER_MODES] ?? "low-pass";
  const curve = (cutoff: number) =>
    path(
      Array.from({ length: 161 }, (_, index): [number, number] => [
        (index / 160) * W,
        filterY(filterResponseDb(mode, cutoff, settings.resonance, fromLogFraction(index / 160, MIN_HZ, MAX_HZ))),
      ]),
    );
  // The envelope moves the cutoff by its amount in octaves at its peak.
  const swept = Math.min(MAX_HZ, Math.max(MIN_HZ, settings.cutoffHz * 2 ** settings.filterEnvAmount));
  return (
    <Picture
      label={`Filter: ${mode} at ${Math.round(settings.cutoffHz)} Hz, Q ${settings.resonance.toFixed(2)}`}
      title="Filter"
      interactive={editing !== null}
    >
      <line x1={0} x2={W} y1={filterY(0)} y2={filterY(0)} stroke="var(--lane-bar)" vectorEffect="non-scaling-stroke" />
      {settings.filterEnvAmount !== 0 && (
        <path d={curve(swept)} fill="none" stroke="var(--warning)" strokeWidth={1.2} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
      <path d={curve(settings.cutoffHz)} fill="none" stroke="var(--primary)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {editing && (
        <>
          <line
            x1={hzX(settings.cutoffHz)}
            x2={hzX(settings.cutoffHz)}
            y1={TOP}
            y2={BOTTOM}
            stroke="var(--primary)"
            strokeDasharray="2 3"
            opacity={0.6}
            vectorEffect="non-scaling-stroke"
          />
          <Handle
            x={hzX(settings.cutoffHz)}
            y={qY(settings.resonance)}
            colour="var(--primary)"
            label="Filter cutoff and resonance"
            valueText={`${hz(settings.cutoffHz)} Hz, Q ${settings.resonance.toFixed(2)}`}
            onDrag={(x, y) =>
              editing.drag({
                cutoffHz: hz(fromLogFraction(x / W, MIN_HZ, MAX_HZ)),
                resonance: Math.round(fromLogFraction(yLevel(y), MIN_Q, MAX_Q) * 100) / 100,
              })
            }
            onRelease={editing.release}
            onStep={(dx, dy) =>
              editing.step(
                dx !== 0
                  ? { cutoffHz: hz(fromLogFraction(logFraction(settings.cutoffHz, MIN_HZ, MAX_HZ) + dx * LOG_STEP, MIN_HZ, MAX_HZ)) }
                  : {
                      resonance:
                        Math.round(fromLogFraction(logFraction(settings.resonance, MIN_Q, MAX_Q) + dy * LOG_STEP, MIN_Q, MAX_Q) * 100) / 100,
                    },
              )
            }
          />
        </>
      )}
    </Picture>
  );
}

const rate = (value: number) => Math.round(value * 100) / 100;

function Lfo({ settings, editing }: { settings: SynthSettings; editing: Editing | null }) {
  const on = settings.lfoTarget !== "off" && settings.lfoDepth > 0;
  const points = Array.from({ length: 161 }, (_, index): [number, number] => {
    const t = index / 160;
    return [t * W, H / 2 - (on ? Math.sin(2 * Math.PI * settings.lfoRateHz * t) * settings.lfoDepth : 0) * (H / 2 - 6)];
  });
  // The handle sits on a rate scale across the picture and a depth scale up it.
  return (
    <Picture
      label={on ? `LFO: ${settings.lfoRateHz.toFixed(2)} Hz on ${settings.lfoTarget}` : "LFO: off"}
      title={`LFO → ${settings.lfoTarget}`}
      interactive={editing !== null}
    >
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
      <path d={path(points)} fill="none" stroke={on ? "var(--play)" : "var(--text-muted)"} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {editing && (
        <Handle
          x={logFraction(settings.lfoRateHz, MIN_RATE, MAX_RATE) * W}
          y={levelY(settings.lfoDepth)}
          colour="var(--play)"
          label="LFO rate and depth"
          valueText={`${settings.lfoRateHz.toFixed(2)} Hz, depth ${Math.round(settings.lfoDepth * 100)}%`}
          onDrag={(x, y) =>
            editing.drag({
              lfoRateHz: rate(fromLogFraction(x / W, MIN_RATE, MAX_RATE)),
              lfoDepth: Math.round(yLevel(y) * 100) / 100,
            })
          }
          onRelease={editing.release}
          onStep={(dx, dy) =>
            editing.step(
              dx !== 0
                ? { lfoRateHz: rate(fromLogFraction(logFraction(settings.lfoRateHz, MIN_RATE, MAX_RATE) + dx * LOG_STEP, MIN_RATE, MAX_RATE)) }
                : { lfoDepth: stepLevel(settings.lfoDepth, dy) },
            )
          }
        />
      )}
    </Picture>
  );
}

export interface SynthVisualsProps {
  settings: SynthSettings;
  /** Only the settings given change; without it the pictures are only pictures. */
  onChange?: (settings: Partial<SynthSettings>) => void;
}

/** The Synth's settings as pictures, above its controls, each one draggable where the Synth can be changed. */
export function SynthVisuals({ settings, onChange }: SynthVisualsProps) {
  // What a drag in progress has moved, drawn over the settings until it is let go.
  const [draft, setDraft] = useState<Partial<SynthSettings> | null>(null);
  const shown: SynthSettings = { ...settings, ...draft };
  const editing: Editing | null = onChange
    ? {
        drag: (change) => setDraft((before) => ({ ...before, ...change })),
        release: () => {
          if (draft) {
            const changed = Object.fromEntries(
              Object.entries(draft).filter(([key, value]) => settings[key as keyof SynthSettings] !== value),
            ) as Partial<SynthSettings>;
            if (Object.keys(changed).length > 0) onChange(changed);
          }
          setDraft(null);
        },
        step: (change) => onChange(change),
      }
    : null;
  return (
    <div className="synth-visuals" role="group" aria-label="Synth display">
      <Oscillators settings={shown} editing={editing} />
      <Envelope label="Amp envelope" title="Amp envelope" settings={shown} keys={AMP_KEYS} colour="var(--primary)" editing={editing} />
      <FilterResponse settings={shown} editing={editing} />
      <Envelope
        label="Filter envelope"
        title="Filter envelope"
        settings={shown}
        keys={FILTER_KEYS}
        colour="var(--warning)"
        editing={editing}
      />
      <Lfo settings={shown} editing={editing} />
      {editing && (
        <p className="hint synth-visuals-hint">
          Drag the handles to shape the sound: the filter across for its cutoff and up for its resonance, an envelope&apos;s
          corners for its times and sustain, the LFO for its rate and depth. Arrow keys move a focused handle.
        </p>
      )}
    </div>
  );
}

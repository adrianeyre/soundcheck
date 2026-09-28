/**
 * Pictures of the Synth's settings, as a hardware synth's screen draws them:
 * its two oscillators' waves mixed, the amp and filter envelopes, the filter's
 * response and the LFO. Each is a function of the settings; none processes
 * audio.
 */
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

function path(points: readonly [number, number][]): string {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

function Picture({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
  return (
    <figure className="synth-visual">
      <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {children}
      </svg>
      <figcaption>{title}</figcaption>
    </figure>
  );
}

function Oscillators({ settings }: { settings: SynthSettings }) {
  // Two cycles of oscillator 1; oscillator 2 runs at its detune's ratio.
  const ratio = 2 ** (settings.osc2Detune / 1200);
  const points = Array.from({ length: 241 }, (_, index): [number, number] => {
    const phase = (index / 240) * 2;
    const mixed = wave(settings.osc1Wave, phase) * (1 - settings.oscMix) + wave(settings.osc2Wave, phase * ratio) * settings.oscMix;
    return [(index / 240) * W, H / 2 - mixed * (H / 2 - 6)];
  });
  return (
    <Picture label={`Oscillators: ${settings.osc1Wave} and ${settings.osc2Wave}, mixed ${Math.round(settings.oscMix * 100)}%`} title="Oscillators">
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
      <path d={path(points)} fill="none" stroke="var(--primary)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </Picture>
  );
}

function Envelope({ label, title, shape, colour }: { label: string; title: string; shape: EnvelopeShape; colour: string }) {
  const hold = 0.25 * Math.max(0.2, shape.attack + shape.decay + shape.release);
  const points = envelopePoints(shape, hold);
  const span = points.at(-1)![0] || 1;
  const drawn = points.map(([t, level]): [number, number] => [(t / span) * W, H - 4 - level * (H - 10)]);
  return (
    <Picture
      label={`${label}: attack ${shape.attack.toFixed(3)} s, decay ${shape.decay.toFixed(3)} s, sustain ${Math.round(shape.sustain * 100)}%, release ${shape.release.toFixed(3)} s`}
      title={title}
    >
      <path d={`${path(drawn)} Z`} fill={colour} opacity={0.18} />
      <path d={path(drawn)} fill="none" stroke={colour} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {drawn.slice(1, -1).map(([x, y], index) => (
        <circle key={index} cx={x} cy={y} r={2.5} fill={colour} />
      ))}
    </Picture>
  );
}

const FILTER_MODES = { lowPass: "low-pass", highPass: "high-pass", bandPass: "band-pass" } as const;

/** Across the filter's picture, one of its 161 points, and up it, -36 to +24 dB. */
const filterX = (index: number) => (index / 160) * W;
const filterY = (db: number) => H / 2 - 12 - (Math.max(-36, Math.min(24, db)) / 36) * (H / 2 - 12);

function FilterResponse({ settings }: { settings: SynthSettings }) {
  const mode = FILTER_MODES[settings.filterType as keyof typeof FILTER_MODES] ?? "low-pass";
  const curve = (cutoff: number) =>
    path(Array.from({ length: 161 }, (_, index): [number, number] => [filterX(index), filterY(filterResponseDb(mode, cutoff, settings.resonance, 20 * 1000 ** (index / 160)))]));
  // The envelope moves the cutoff by its amount in octaves at its peak.
  const swept = Math.min(20_000, Math.max(20, settings.cutoffHz * 2 ** settings.filterEnvAmount));
  return (
    <Picture label={`Filter: ${mode} at ${Math.round(settings.cutoffHz)} Hz, Q ${settings.resonance.toFixed(2)}`} title="Filter">
      <line x1={0} x2={W} y1={filterY(0)} y2={filterY(0)} stroke="var(--lane-bar)" vectorEffect="non-scaling-stroke" />
      {settings.filterEnvAmount !== 0 && (
        <path d={curve(swept)} fill="none" stroke="var(--warning)" strokeWidth={1.2} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
      <path d={curve(settings.cutoffHz)} fill="none" stroke="var(--primary)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </Picture>
  );
}

function Lfo({ settings }: { settings: SynthSettings }) {
  const on = settings.lfoTarget !== "off" && settings.lfoDepth > 0;
  const points = Array.from({ length: 161 }, (_, index): [number, number] => {
    const t = index / 160;
    return [t * W, H / 2 - (on ? Math.sin(2 * Math.PI * settings.lfoRateHz * t) * settings.lfoDepth : 0) * (H / 2 - 6)];
  });
  return (
    <Picture label={on ? `LFO: ${settings.lfoRateHz.toFixed(2)} Hz on ${settings.lfoTarget}` : "LFO: off"} title={`LFO → ${settings.lfoTarget}`}>
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
      <path d={path(points)} fill="none" stroke={on ? "var(--play)" : "var(--text-muted)"} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </Picture>
  );
}

/** The Synth's settings as pictures, above its controls. */
export function SynthVisuals({ settings }: { settings: SynthSettings }) {
  return (
    <div className="synth-visuals" role="group" aria-label="Synth display">
      <Oscillators settings={settings} />
      <Envelope label="Amp envelope" title="Amp envelope" shape={settings} colour="var(--primary)" />
      <FilterResponse settings={settings} />
      <Envelope
        label="Filter envelope"
        title="Filter envelope"
        shape={{
          attack: settings.filterAttack,
          decay: settings.filterDecay,
          sustain: settings.filterSustain,
          release: settings.filterRelease,
        }}
        colour="var(--warning)"
      />
      <Lfo settings={settings} />
    </div>
  );
}

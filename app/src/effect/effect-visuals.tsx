/**
 * A picture for each built-in Effect, drawn from its settings the way the
 * engine works them out (`engine/src/effect/`): the Compressor's, Gate's
 * and Limiter's level curves, the Saturator's transfer curve, the Auto
 * Filter's response and the range its LFO sweeps, the Reverb's tail, the
 * Delay's repeats, the Chorus's and Phaser's LFOs, the Bitcrusher's steps,
 * the Utility's stereo field, and for the Effects added since, their LFOs,
 * level shapes, gate steps and the frequencies they work at. None of them processes audio: each draws
 * a function of the settings, which is what the curves below are.
 */
import {
  type BitcrusherSettings,
  type ChorusSettings,
  type CompressorSettings,
  type DelaySettings,
  type FilterSettings,
  type GateSettings,
  type LimiterSettings,
  type PhaserSettings,
  type ReverbSettings,
  type SaturatorSettings,
  type ClipperSettings,
  type PumpSettings,
  type ResonatorSettings,
  TRANCE_GATE_PATTERNS,
  type TranceGateSettings,
  type UtilitySettings,
} from "./effect-params";
import type { Effect } from "../project/model";

const W = 320;
const H = 120;

// ---- The curves, as plain functions, so they can be tested. ----

/**
 * The Compressor's output level for a steady input level, in dB: its knee
 * as the engine's `wanted_reduction_db` has it, then the makeup gain.
 */
export function compressorOutputDb(settings: CompressorSettings, inputDb: number): number {
  const slope = 1 - 1 / Math.max(1, settings.ratio);
  const over = inputDb - settings.thresholdDb;
  const knee = Math.max(0, settings.kneeDb);
  let reduction: number;
  if (2 * over <= -knee) reduction = 0;
  else if (2 * over < knee) {
    const into = over + knee / 2;
    reduction = (slope * into * into) / (2 * knee);
  } else reduction = slope * over;
  return inputDb - reduction + settings.makeupDb;
}

/** A closed Gate turns a level below the threshold down by its range; -80 dB is silence. */
export function gateOutputDb(settings: GateSettings, inputDb: number): number {
  if (inputDb >= settings.thresholdDb) return inputDb;
  return settings.rangeDb <= -80 ? -Infinity : inputDb + settings.rangeDb;
}

/** The Limiter's steady output level: the input gain, held at the ceiling. */
export function limiterOutputDb(settings: LimiterSettings, inputDb: number): number {
  return Math.min(settings.ceilingDb, inputDb + settings.inputGainDb);
}

const SHAPES = ["soft", "hard", "tube", "fold"] as const;

/** The engine's `saturate`: every shape keeps its output within -1 to 1. */
export function saturate(shape: SaturatorSettings["shape"], x: number): number {
  switch (SHAPES.indexOf(shape)) {
    case 1:
      return Math.max(-1, Math.min(1, x));
    case 2:
      return x >= 0 ? Math.tanh(x) : 0.8 * Math.tanh(1.25 * x);
    case 3: {
      const t = (((x + 1) % 4) + 4) % 4;
      return t < 2 ? t - 1 : 3 - t;
    }
    default:
      return Math.tanh(x);
  }
}

/** A sample through the Saturator, tone filter aside: drive, shape, output and mix. */
export function saturatorTransfer(settings: SaturatorSettings, x: number): number {
  const drive = 10 ** (settings.driveDb / 20);
  const output = 10 ** (settings.outputDb / 20);
  return x * (1 - settings.mix) + saturate(settings.shape, x * drive) * output * settings.mix;
}

/** How loud a sine at `frequency` comes through an RBJ filter of the Auto Filter's `mode`, in dB. */
export function filterResponseDb(
  mode: FilterSettings["mode"],
  cutoffHz: number,
  q: number,
  frequency: number,
  sampleRate = 48_000,
): number {
  const w0 = (2 * Math.PI * Math.min(sampleRate * 0.49, Math.max(10, cutoffHz))) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b: [number, number, number];
  switch (mode) {
    case "high-pass":
      b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
      break;
    case "band-pass":
      b = [alpha, 0, -alpha];
      break;
    case "notch":
      b = [1, -2 * cos, 1];
      break;
    default:
      b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  }
  const a: [number, number, number] = [1 + alpha, -2 * cos, 1 - alpha];
  const w = (2 * Math.PI * frequency) / sampleRate;
  const re = (c: [number, number, number]) => c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w);
  const im = (c: [number, number, number]) => c[1] * Math.sin(w) + c[2] * Math.sin(2 * w);
  const scale = Math.hypot(re(b), im(b)) / Math.hypot(re(a), im(a));
  return 20 * Math.log10(Math.max(scale, 1e-10));
}

/** A sine through the Bitcrusher, one of its held steps per `downsample` samples. */
export function crushed(settings: BitcrusherSettings, samples: number): number[] {
  const levels = 2 ** (settings.bits - 1);
  const hold = Math.max(1, Math.round(settings.downsample));
  const out: number[] = [];
  let held = 0;
  for (let index = 0; index < samples; index++) {
    const dry = Math.sin((2 * Math.PI * index) / samples);
    if (index % hold === 0) held = Math.round(dry * levels) / levels;
    out.push(dry * (1 - settings.mix) + held * settings.mix);
  }
  return out;
}

/** Where a signal that is only left, or only right, lands through the Utility: (left gain, right gain) for each. */
export function utilityMatrix(settings: UtilitySettings): { left: [number, number]; right: [number, number] } {
  const gain = 10 ** (settings.gainDb / 20);
  const width = settings.mono === "on" ? 0 : settings.width;
  const leftGain = gain * Math.min(1, 1 - settings.pan) * (settings.invertLeft === "on" ? -1 : 1);
  const rightGain = gain * Math.min(1, 1 + settings.pan) * (settings.invertRight === "on" ? -1 : 1);
  const through = (l: number, r: number): [number, number] => {
    const mid = 0.5 * (l + r);
    const side = 0.5 * (l - r) * width;
    return [(mid + side) * leftGain, (mid - side) * rightGain];
  };
  return { left: through(1, 0), right: through(0, 1) };
}

// ---- Drawing. ----

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <svg role="img" aria-label={label} className="effect-visual" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {children}
    </svg>
  );
}

function path(points: readonly [number, number][]): string {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

/** Input against output level, -60 to +12 dB both ways, with the unity line. */
function LevelCurve({ label, curve, marks }: { label: string; curve: (db: number) => number; marks: number[] }) {
  const [low, high] = [-60, 12];
  const x = (db: number) => ((db - low) / (high - low)) * W;
  const y = (db: number) => H - ((Math.max(low, Math.min(high, db)) - low) / (high - low)) * H;
  const points = Array.from({ length: 145 }, (_, index): [number, number] => {
    const db = low + (index / 144) * (high - low);
    return [x(db), y(curve(db))];
  });
  return (
    <Frame label={label}>
      {[-48, -36, -24, -12, 0].map((db) => (
        <g key={db}>
          <line x1={x(db)} x2={x(db)} y1={0} y2={H} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={W} y1={y(db)} y2={y(db)} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
        </g>
      ))}
      <line x1={x(low)} y1={y(low)} x2={x(high)} y2={y(high)} stroke="var(--lane-bar)" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      {marks.map((db) => (
        <line key={db} x1={x(db)} x2={x(db)} y1={0} y2={H} stroke="var(--warning)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      ))}
      <path d={path(points)} fill="none" stroke="var(--primary)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
    </Frame>
  );
}

function SaturatorCurve({ label, settings }: { label: string; settings: SaturatorSettings }) {
  const points = Array.from({ length: 161 }, (_, index): [number, number] => {
    const input = -1.5 + (index / 160) * 3;
    return [(index / 160) * W, H / 2 - (Math.max(-1.5, Math.min(1.5, saturatorTransfer(settings, input))) / 1.5) * (H / 2)];
  });
  const wave = Array.from({ length: 161 }, (_, index): [number, number] => {
    const input = Math.sin((index / 160) * 2 * Math.PI);
    return [(index / 160) * W, H / 2 - (saturatorTransfer(settings, input) / 1.5) * (H / 2)];
  });
  return (
    <Frame label={label}>
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
      <line x1={W / 2} x2={W / 2} y1={0} y2={H} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
      <path d={path(wave)} fill="none" stroke="var(--warning)" strokeWidth={1.5} opacity={0.8} vectorEffect="non-scaling-stroke" />
      <path d={path(points)} fill="none" stroke="var(--primary)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
    </Frame>
  );
}

const [LOW_HZ, HIGH_HZ] = [20, 20_000];
const hzX = (hz: number) => (Math.log10(hz / LOW_HZ) / Math.log10(HIGH_HZ / LOW_HZ)) * W;

function FilterCurve({ label, settings }: { label: string; settings: FilterSettings }) {
  const db = (value: number) => H / 2 - (Math.max(-36, Math.min(24, value)) / 36) * (H / 2) - 10;
  const curveAt = (cutoff: number) =>
    path(
      Array.from({ length: 161 }, (_, index): [number, number] => {
        const hz = LOW_HZ * (HIGH_HZ / LOW_HZ) ** (index / 160);
        const filtered = filterResponseDb(settings.mode, cutoff, settings.resonance, hz);
        const mixed = 20 * Math.log10(Math.max(1e-10, settings.mix * 10 ** (filtered / 20) + (1 - settings.mix)));
        return [(index / 160) * W, db(mixed)];
      }),
    );
  const low = Math.max(LOW_HZ, settings.cutoffHz / 2 ** settings.lfoDepth);
  const high = Math.min(HIGH_HZ, settings.cutoffHz * 2 ** settings.lfoDepth);
  return (
    <Frame label={label}>
      {[100, 1000, 10_000].map((hz) => (
        <line key={hz} x1={hzX(hz)} x2={hzX(hz)} y1={0} y2={H} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
      ))}
      {settings.lfoDepth > 0 && (
        <>
          <rect x={hzX(low)} y={0} width={hzX(high) - hzX(low)} height={H} fill="var(--primary-soft)" opacity={0.6} />
          <path d={curveAt(low)} fill="none" stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <path d={curveAt(high)} fill="none" stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        </>
      )}
      <line x1={0} x2={W} y1={db(0)} y2={db(0)} stroke="var(--lane-bar)" vectorEffect="non-scaling-stroke" />
      <path d={curveAt(settings.cutoffHz)} fill="none" stroke="var(--primary)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
    </Frame>
  );
}

function ReverbTail({ label, settings }: { label: string; settings: ReverbSettings }) {
  // Four seconds across, or the decay and pre-delay if longer; the tail falls 60 dB over the decay.
  const span = Math.max(1, settings.decay * 1.2 + settings.preDelay / 1000);
  const x = (seconds: number) => (seconds / span) * W;
  const start = settings.preDelay / 1000;
  const bars = Array.from({ length: 96 }, (_, index) => {
    const t = start + (index / 96) * (span - start);
    const level = 10 ** ((-60 * (t - start)) / Math.max(0.05, settings.decay) / 20);
    // Echoes spaced out by the room's size, as the pattern of a tail.
    const jitter = 0.55 + 0.45 * Math.abs(Math.sin(index * (1.7 + settings.size * 3.1)));
    return { t, h: level * jitter * settings.mix * (H - 12) };
  });
  return (
    <Frame label={label}>
      <line x1={0} x2={0} y1={H} y2={12} stroke="var(--primary)" strokeWidth={3} vectorEffect="non-scaling-stroke" />
      {bars.map(({ t, h }) => (
        <line key={t} x1={x(t)} x2={x(t)} y1={H} y2={H - h} stroke="var(--primary)" opacity={0.35 + (1 - settings.damping) * 0.5} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      ))}
      <text x={W - 4} y={14} textAnchor="end" className="effect-visual-label">
        RT60 {settings.decay.toFixed(1)} s
      </text>
    </Frame>
  );
}

function DelayTaps({ label, settings }: { label: string; settings: DelaySettings }) {
  const repeats = Array.from({ length: 12 }, (_, index) => settings.feedback ** index).filter((level) => level > 0.02);
  const spacing = (W - 20) / 12;
  return (
    <Frame label={label}>
      <line x1={10} x2={10} y1={H} y2={10} stroke="var(--text-muted)" strokeWidth={3} vectorEffect="non-scaling-stroke" />
      {repeats.map((level, index) => {
        const left = settings.pingPong !== "on" || index % 2 === 0;
        const x = 10 + (index + 1) * spacing;
        const h = level * settings.mix * (H - 20) + 2;
        return (
          <g key={index}>
            <line x1={x} x2={x} y1={H} y2={H - h} stroke={left ? "var(--primary)" : "var(--play)"} strokeWidth={4} vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
      <text x={W - 4} y={14} textAnchor="end" className="effect-visual-label">
        {settings.sync === "on" ? settings.note : `${Math.round(settings.timeMs)} ms`}
        {settings.pingPong === "on" ? " · ping-pong" : ""}
      </text>
    </Frame>
  );
}

/** One or two LFOs over two seconds: left, and right `offset` of a cycle later. */
function LfoCurve({ label, rateHz, offset, depth }: { label: string; rateHz: number; offset: number; depth: number }) {
  const wave = (shift: number) =>
    path(
      Array.from({ length: 161 }, (_, index): [number, number] => {
        const t = (index / 160) * 2;
        return [(index / 160) * W, H / 2 - Math.sin(2 * Math.PI * (rateHz * t + shift)) * depth * (H / 2 - 8)];
      }),
    );
  return (
    <Frame label={label}>
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
      <path d={wave(0)} fill="none" stroke="var(--primary)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {offset > 0 && <path d={wave(offset)} fill="none" stroke="var(--play)" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
      <text x={W - 4} y={14} textAnchor="end" className="effect-visual-label">
        {rateHz.toFixed(2)} Hz{offset > 0 ? " · L / R" : ""}
      </text>
    </Frame>
  );
}

/** A sample value, -1 to 1, as a height in the Bitcrusher's picture. */
const stepY = (value: number) => H / 2 - value * (H / 2 - 6);

function BitcrusherSteps({ label, settings }: { label: string; settings: BitcrusherSettings }) {
  const samples = 240;
  const out = crushed(settings, samples);
  const smooth = Array.from({ length: samples }, (_, index): [number, number] => [(index / samples) * W, stepY(Math.sin((2 * Math.PI * index) / samples))]);
  const stepped = out.map((value, index): [number, number] => [(index / samples) * W, stepY(value)]);
  return (
    <Frame label={label}>
      <path d={path(smooth)} fill="none" stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <path d={path(stepped)} fill="none" stroke="var(--primary)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      <text x={W - 4} y={14} textAnchor="end" className="effect-visual-label">
        {settings.bits} bit · ÷{Math.round(settings.downsample)}
      </text>
    </Frame>
  );
}

/** Where a left-only and a right-only signal end up, as a vectorscope draws them. */
function StereoField({ label, settings }: { label: string; settings: UtilitySettings }) {
  const { left, right } = utilityMatrix(settings);
  const cx = W / 2;
  const cy = H - 8;
  const r = H - 20;
  // On a vectorscope, left-only leans 45° left, mono is straight up and right-only 45° right.
  const toPoint = ([l, rr]: [number, number]): [number, number] => {
    const mid = (l + rr) / Math.SQRT2;
    const side = (rr - l) / Math.SQRT2;
    return [cx + side * r * 0.7, cy - Math.abs(mid) * r * 0.7];
  };
  const [lx, ly] = toPoint(left);
  const [rx, ry] = toPoint(right);
  return (
    <Frame label={label}>
      <path d={`M${cx - r},${cy} A${r},${r} 0 0 1 ${cx + r},${cy}`} fill="none" stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
      <line x1={cx} x2={cx} y1={cy} y2={cy - r} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
      <polygon points={`${cx},${cy} ${lx},${ly} ${rx},${ry}`} fill="var(--primary-soft)" opacity={0.8} />
      <line x1={cx} y1={cy} x2={lx} y2={ly} stroke="var(--primary)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
      <line x1={cx} y1={cy} x2={rx} y2={ry} stroke="var(--play)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
      <text x={6} y={14} className="effect-visual-label">
        L
      </text>
      <text x={W - 6} y={14} textAnchor="end" className="effect-visual-label">
        R
      </text>
      <text x={cx} y={14} textAnchor="middle" className="effect-visual-label">
        {settings.mono === "on" ? "Mono" : `Width ${Math.round(settings.width * 100)}%`}
      </text>
    </Frame>
  );
}

// ---- The twenty Effects added with schema 20. ----

/**
 * The Trance Gate's patterns, step by step (`x` open): the engine's
 * `trance_gate.rs` holds the same, in the same order as its choices.
 */
const TRANCE_GATE_STEP_PATTERNS: { readonly [P in TranceGateSettings["pattern"]]: string } = Object.fromEntries(
  TRANCE_GATE_PATTERNS.map((name, index) => [
    name,
    ["xxxxxxxxxxxxxxxx", "x.x.x.x.x.x.x.x.", "..x...x...x...x.", "x.xxx.xxx.xxx.xx", "xx.xxx.xxx.xxx.x", "x..x..x.x..x..x.", "x.xx.xx.x.xx.xx.", "x...x...x.x.xxxx"][index]!,
  ]),
) as { readonly [P in TranceGateSettings["pattern"]]: string };

/** Which of the Trance Gate's 16 steps are open. */
export function tranceGateSteps(settings: TranceGateSettings): boolean[] {
  return [...TRANCE_GATE_STEP_PATTERNS[settings.pattern]].map((step) => step === "x");
}

/** The Pump's level across one note, 0 to 1 of the way through it, as `pump.rs` shapes it. */
export function pumpGain(settings: PumpSettings, at: number): number {
  const into = (((at - settings.phase) % 1) + 1) % 1;
  const back = Math.min(1, into / Math.max(0.05, settings.release));
  const shaped = back ** 4 ** (2 * settings.curve - 1);
  return 1 - settings.depth * settings.mix * (1 - shaped);
}

/** A sample's level through the Clipper, as `clipper.rs` works it out, before its output gain. */
export function clipperOutput(settings: ClipperSettings, x: number): number {
  const input = x * 10 ** (settings.inputDb / 20);
  const ceiling = 10 ** (settings.ceilingDb / 20);
  const knee = ceiling * (1 - settings.softness);
  const size = Math.abs(input);
  const room = ceiling - knee;
  const clipped = size <= knee ? size : room <= 0 ? ceiling : knee + room * Math.tanh((size - knee) / room);
  return settings.mix * Math.sign(input) * Math.min(ceiling, clipped) + (1 - settings.mix) * input;
}

/** Lines of `points` values, 0 (bottom) to 1 (top), spread across the picture, and a caption. */
function Plot({ label, lines, caption }: { label: string; lines: { points: readonly number[]; muted?: boolean }[]; caption: string }) {
  const at = (points: readonly number[]) =>
    path(points.map((value, index): [number, number] => [(index / Math.max(1, points.length - 1)) * W, H - 6 - Math.max(0, Math.min(1, value)) * (H - 20)]));
  return (
    <Frame label={label}>
      <line x1={0} x2={W} y1={H - 6} y2={H - 6} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
      {lines.map(({ points, muted }, index) => (
        <path
          key={index}
          d={at(points)}
          fill="none"
          stroke={muted ? "var(--text-muted)" : "var(--primary)"}
          strokeWidth={muted ? 1 : 2.5}
          strokeDasharray={muted ? "3 3" : undefined}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <text x={W - 4} y={14} textAnchor="end" className="effect-visual-label">
        {caption}
      </text>
    </Frame>
  );
}

/** Where `hz` is across the picture, kept on the 20 Hz to 20 kHz axis. */
const markX = (hz: number) => hzX(Math.max(LOW_HZ, Math.min(HIGH_HZ, hz)));

/** A 20 Hz to 20 kHz axis with the frequencies an Effect works at marked, and the band it works on shaded. */
function FrequencyMarks({ label, marks, band, caption }: { label: string; marks: number[]; band?: [number, number]; caption: string }) {
  const x = markX;
  return (
    <Frame label={label}>
      {[100, 1000, 10_000].map((hz) => (
        <line key={hz} x1={x(hz)} x2={x(hz)} y1={0} y2={H} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
      ))}
      {band && <rect x={x(band[0])} y={0} width={Math.max(2, x(band[1]) - x(band[0]))} height={H} fill="var(--primary-soft)" opacity={0.7} />}
      {marks.map((hz, index) => (
        <line key={index} x1={x(hz)} x2={x(hz)} y1={20} y2={H} stroke="var(--primary)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
      ))}
      <text x={W - 4} y={14} textAnchor="end" className="effect-visual-label">
        {caption}
      </text>
    </Frame>
  );
}

const range = (count: number, at: (t: number) => number) => Array.from({ length: count }, (_, index) => at(index / (count - 1)));
const hz = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`);
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CHORD_STEPS: { readonly [C in ResonatorSettings["chord"]]: number[] } = { unison: [0], fifth: [0, 7], octave: [0, 12], major: [0, 4, 7], minor: [0, 3, 7] };

/** The pitch the Resonator is tuned to, in Hz: C4 is middle C. */
export function resonatorHz(settings: ResonatorSettings): number {
  if (settings.tuneBy === "frequency") return settings.frequencyHz;
  const midi = 12 * (settings.octave + 1) + NOTE_NAMES.indexOf(settings.note);
  return 440 * 2 ** ((midi - 69) / 12);
}

/** A drum hit's level at `t` (0 to 1 across the picture), its start raised by `attack`% and its tail by `sustain`%. */
const hit = (t: number, attack: number, sustain: number) =>
  Math.min(1, (t < 0.05 ? t / 0.05 : Math.exp(-(t - 0.05) * 6)) * (t < 0.15 ? 1 + attack / 200 : 1 + sustain / 200) * 0.8);

/** The picture for one of the twenty Effects added with schema 20, or null for any other. */
function NewerVisual({ effect, label }: { effect: Effect; label: string }) {
  switch (effect.type) {
    case "flanger":
      return <LfoCurve label={`${label} sweep`} rateHz={effect.settings.rateHz} offset={effect.settings.stereoPhase / 360} depth={Math.min(1, effect.settings.depthMs / 10 + 0.1)} />;
    case "tremolo":
      return (
        <Plot
          label={`${label} level`}
          lines={[{ points: range(161, (t) => 1 - effect.settings.depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t))) }]}
          caption={effect.settings.sync === "on" ? `${effect.settings.note} · ${effect.settings.shape}` : `${effect.settings.rateHz.toFixed(2)} Hz · ${effect.settings.shape}`}
        />
      );
    case "autopan":
      return (
        <LfoCurve label={`${label} pan`} rateHz={effect.settings.sync === "on" ? 1 : effect.settings.rateHz} offset={0} depth={effect.settings.depth} />
      );
    case "ringmod":
      return (
        <Plot
          label={`${label} carrier`}
          lines={[{ points: range(241, (t) => 0.5 + 0.5 * Math.sin(2 * Math.PI * 8 * t)) }]}
          caption={`${hz(effect.settings.frequencyHz)}${effect.settings.driftDepth > 0 ? ` ± ${effect.settings.driftDepth.toFixed(1)} st` : ""}`}
        />
      );
    case "vibrato":
      return <LfoCurve label={`${label} pitch`} rateHz={effect.settings.rateHz} offset={effect.settings.stereoPhase / 360} depth={Math.min(1, effect.settings.depthCents / 100 + 0.05)} />;
    case "transient": {
      const { attack, sustain } = effect.settings;
      return (
        <Plot
          label={`${label} envelope`}
          lines={[{ points: range(161, (t) => hit(t, 0, 0)), muted: true }, { points: range(161, (t) => hit(t, attack, sustain)) }]}
          caption={`attack ${Math.round(attack)}% · sustain ${Math.round(sustain)}%`}
        />
      );
    }
    case "deesser":
      return (
        <FrequencyMarks
          label={`${label} band`}
          marks={[effect.settings.frequencyHz]}
          band={[effect.settings.frequencyHz / 1.5, effect.settings.frequencyHz * 1.5]}
          caption={`${hz(effect.settings.frequencyHz)} · −${effect.settings.rangeDb.toFixed(0)} dB most`}
        />
      );
    case "exciter":
      return (
        <FrequencyMarks
          label={`${label} band`}
          marks={[effect.settings.frequencyHz]}
          band={[effect.settings.frequencyHz, HIGH_HZ]}
          caption={`from ${hz(effect.settings.frequencyHz)} · ${Math.round(effect.settings.amount * 100)}%`}
        />
      );
    case "multiband":
      return (
        <FrequencyMarks
          label={`${label} bands`}
          marks={[effect.settings.lowCrossoverHz, effect.settings.highCrossoverHz]}
          caption={`${effect.settings.lowRatio.toFixed(1)} · ${effect.settings.midRatio.toFixed(1)} · ${effect.settings.highRatio.toFixed(1)} : 1`}
        />
      );
    case "clipper":
      return (
        <Plot
          label={`${label} transfer curve`}
          lines={[
            { points: range(161, (t) => 0.5 + (2 * t - 1) / 3), muted: true },
            { points: range(161, (t) => 0.5 + clipperOutput(effect.settings, (2 * t - 1) * 1.5) / 3) },
          ]}
          caption={`ceiling ${effect.settings.ceilingDb.toFixed(1)} dB`}
        />
      );
    case "freqshift":
      return (
        <FrequencyMarks
          label={`${label} shift`}
          marks={[1000, Math.max(LOW_HZ, 1000 + effect.settings.shiftHz)]}
          caption={`${effect.settings.shiftHz >= 0 ? "+" : "−"}${Math.abs(Math.round(effect.settings.shiftHz))} Hz`}
        />
      );
    case "autowah":
      return (
        <FrequencyMarks
          label={`${label} sweep`}
          marks={[]}
          band={[effect.settings.lowHz, effect.settings.highHz]}
          caption={`${hz(effect.settings.lowHz)} – ${hz(effect.settings.highHz)}`}
        />
      );
    case "haas": {
      const delayed = effect.settings.side;
      const at = 0.1 + (effect.settings.delayMs / 50) * 0.8;
      const pulse = (where: number, level: number) => range(161, (t) => (Math.abs(t - where) < 0.01 ? level : 0));
      return (
        <Plot
          label={`${label} arrival`}
          lines={[{ points: pulse(0.1, 0.9), muted: true }, { points: pulse(at, 0.9 * 10 ** (effect.settings.levelDb / 20)) }]}
          caption={`${delayed} ${effect.settings.delayMs.toFixed(1)} ms later`}
        />
      );
    }
    case "resonator": {
      const root = resonatorHz(effect.settings);
      const pitches = CHORD_STEPS[effect.settings.chord].map((step) => root * 2 ** (step / 12));
      return (
        <FrequencyMarks
          label={`${label} tuning`}
          marks={pitches.flatMap((pitch) => [pitch, pitch * 2, pitch * 3])}
          caption={effect.settings.tuneBy === "note" ? `${effect.settings.note}${effect.settings.octave} ${effect.settings.chord}` : `${hz(root)} ${effect.settings.chord}`}
        />
      );
    }
    case "vowel":
      return <LfoCurve label={`${label} morph`} rateHz={effect.settings.lfoRateHz} offset={0} depth={Math.min(1, effect.settings.lfoDepth / 2)} />;
    case "pump":
      return (
        <Plot
          label={`${label} level`}
          lines={[{ points: range(161, (t) => pumpGain(effect.settings, (t * 4) % 1)) }]}
          caption={`${effect.settings.note} · ${Math.round(effect.settings.depth * 100)}%`}
        />
      );
    case "trancegate": {
      const steps = tranceGateSteps(effect.settings);
      const closed = 1 - effect.settings.depth * effect.settings.mix;
      return (
        <Plot
          label={`${label} steps`}
          lines={[{ points: range(161, (t) => (steps[Math.min(15, Math.floor(t * 16))] && (t * 16) % 1 < 0.8 ? 1 : closed)) }]}
          caption={`${effect.settings.pattern} · ${effect.settings.step}`}
        />
      );
    }
    case "pitchshift": {
      const shift = effect.settings.semitones + effect.settings.cents / 100;
      return (
        <Plot
          label={`${label} interval`}
          lines={[{ points: range(2, () => 0.5), muted: true }, { points: range(2, () => 0.5 + shift / 26) }]}
          caption={`${shift >= 0 ? "+" : "−"}${Math.abs(shift).toFixed(2)} st`}
        />
      );
    }
    case "lofi":
      return (
        <Plot
          label={`${label} wobble`}
          lines={[
            {
              points: range(241, (t) => 0.5 + 0.4 * effect.settings.wow * Math.sin(2 * Math.PI * 1.1 * t) + 0.15 * effect.settings.flutter * Math.sin(2 * Math.PI * 14.6 * t)),
            },
          ]}
          caption={`tone ${hz(effect.settings.toneHz)}`}
        />
      );
    case "beatrepeat": {
      const decay = effect.settings.decay;
      return (
        <Plot
          label={`${label} repeats`}
          lines={[{ points: range(161, (t) => ((t * 8) % 1 < 0.7 ? (1 - decay) ** Math.floor(t * 8) * 0.9 : 0)) }]}
          caption={`${effect.settings.slice}${effect.settings.repeat >= 1 ? " · repeating" : " · off"}`}
        />
      );
    }
    default:
      return null;
  }
}

/**
 * The picture for `effect`, or null for one that has none of its own here
 * (the EQ draws its curve itself, and a Plugin's settings are its own).
 */
export function EffectVisual({ effect, label }: { effect: Effect; label: string }) {
  switch (effect.type) {
    case "compressor":
      return (
        <LevelCurve
          label={`${label} level curve`}
          curve={(db) => compressorOutputDb(effect.settings, db)}
          marks={[effect.settings.thresholdDb]}
        />
      );
    case "gate":
      return <LevelCurve label={`${label} level curve`} curve={(db) => gateOutputDb(effect.settings, db)} marks={[effect.settings.thresholdDb]} />;
    case "limiter":
      return <LevelCurve label={`${label} level curve`} curve={(db) => limiterOutputDb(effect.settings, db)} marks={[effect.settings.ceilingDb]} />;
    case "saturator":
      return <SaturatorCurve label={`${label} transfer curve`} settings={effect.settings} />;
    case "filter":
      return <FilterCurve label={`${label} frequency response`} settings={effect.settings} />;
    case "reverb":
      return <ReverbTail label={`${label} tail`} settings={effect.settings} />;
    case "delay":
      return <DelayTaps label={`${label} repeats`} settings={effect.settings} />;
    case "chorus": {
      const settings: ChorusSettings = effect.settings;
      return <LfoCurve label={`${label} modulation`} rateHz={settings.rateHz} offset={0.5 * settings.width} depth={Math.min(1, settings.depthMs / 10 + 0.1)} />;
    }
    case "phaser": {
      const settings: PhaserSettings = effect.settings;
      return <LfoCurve label={`${label} sweep`} rateHz={settings.rateHz} offset={0} depth={settings.depth} />;
    }
    case "bitcrusher":
      return <BitcrusherSteps label={`${label} steps`} settings={effect.settings} />;
    case "utility":
      return <StereoField label={`${label} stereo field`} settings={effect.settings} />;
    default:
      return <NewerVisual effect={effect} label={label} />;
  }
}

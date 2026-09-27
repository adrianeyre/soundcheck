/**
 * Every Effect's settings, as the UI and the Assistant see them.
 *
 * The engine declares each Effect's settings once (`engine/src/effect/`) and
 * publishes the tables as JSON; these are those tables, written out so the UI
 * can draw controls and validate a Project without waiting for the WASM build
 * to load. `effect-params.test.ts` checks the two against each other, so they
 * cannot drift apart.
 *
 * As with the Synth, a setting that picks from a list is named here, not
 * numbered as the engine's flat form has it: a saved Project reads
 * `"lowCut": "on"`. `effectSettingsToFlat` does the conversion.
 */

/** A switch: the EQ's cuts are either in or out. */
export type OnOff = "off" | "on";

export interface EqSettings {
  lowCut: OnOff;
  lowCutHz: number;
  lowShelfHz: number;
  lowShelfGainDb: number;
  band1Hz: number;
  band1Q: number;
  band1GainDb: number;
  band2Hz: number;
  band2Q: number;
  band2GainDb: number;
  band3Hz: number;
  band3Q: number;
  band3GainDb: number;
  highShelfHz: number;
  highShelfGainDb: number;
  highCut: OnOff;
  highCutHz: number;
}

export interface CompressorSettings {
  thresholdDb: number;
  ratio: number;
  /** Milliseconds. */
  attack: number;
  /** Milliseconds. */
  release: number;
  makeupDb: number;
  /** How wide the soft knee is, centred on the threshold: 0 is a hard knee. */
  kneeDb: number;
}

export interface ReverbSettings {
  /** 0..1: how big the room is, which spaces out its echoes. */
  size: number;
  /** Seconds for the tail to fall by 60 dB. */
  decay: number;
  damping: number;
  /** Milliseconds before the tail starts. */
  preDelay: number;
  width: number;
  /** 0..1: 0 is only the dry signal, 1 only the tail. */
  mix: number;
}

/** The note values a synced Delay offers, shortest first, as the engine lists them. */
export const NOTE_VALUES = [
  "1/16 triplet",
  "1/16",
  "1/8 triplet",
  "1/16 dotted",
  "1/8",
  "1/4 triplet",
  "1/8 dotted",
  "1/4",
  "1/2 triplet",
  "1/4 dotted",
  "1/2",
  "1/1 triplet",
  "1/2 dotted",
  "1/1",
  "1/1 dotted",
] as const;

export type NoteValue = (typeof NOTE_VALUES)[number];

export interface DelaySettings {
  /** On, the time is `note`, which follows the tempo; off, it is `timeMs`. */
  sync: OnOff;
  note: NoteValue;
  /** Milliseconds, when not synced. */
  timeMs: number;
  /** 0..0.95: how loud each repeat is against the one before. */
  feedback: number;
  /** The high-cut each repeat passes through. */
  highCutHz: number;
  /** On, the repeats alternate left and right. */
  pingPong: OnOff;
  /** 0..1: 0 is only the dry signal, 1 only the repeats. */
  mix: number;
}

/** Each kind of Effect, with the settings it keeps. */
export interface EffectSettingsByType {
  eq: EqSettings;
  compressor: CompressorSettings;
  reverb: ReverbSettings;
  delay: DelaySettings;
}

export type EffectType = keyof EffectSettingsByType;

export type EffectSettings = EffectSettingsByType[EffectType];

/** One setting: what it is called, what it may be, and what it is by default. */
export interface EffectParam<S = EffectSettings> {
  name: keyof S & string;
  label: string;
  /** Shown after the value, or "" when the setting has no unit. */
  unit: string;
  min: number;
  max: number;
  /** The default: for a setting that picks from a list, the choice's index. */
  default: number;
  /** The gap between values a control should offer, or 0 for continuous. */
  step: number;
  /** The choices, lowest value first, or empty for a number. */
  choices: readonly string[];
}

function hz<S>(name: keyof S & string, label: string, value: number): EffectParam<S> {
  return { name, label, unit: "Hz", min: 20, max: 20000, default: value, step: 0, choices: [] };
}

function gain<S>(name: keyof S & string, label: string): EffectParam<S> {
  return { name, label, unit: "dB", min: -24, max: 24, default: 0, step: 0, choices: [] };
}

function q<S>(name: keyof S & string, label: string): EffectParam<S> {
  return { name, label, unit: "Q", min: 0.1, max: 18, default: 1, step: 0, choices: [] };
}

function onOff<S>(name: keyof S & string, label: string): EffectParam<S> {
  return { name, label, unit: "", min: 0, max: 1, default: 0, step: 1, choices: ["off", "on"] };
}

function amount<S>(name: keyof S & string, label: string, value: number): EffectParam<S> {
  return { name, label, unit: "", min: 0, max: 1, default: value, step: 0, choices: [] };
}

/** Every setting of each Effect, in the order the engine sends them. */
export const EFFECT_PARAMS: { readonly [T in EffectType]: readonly EffectParam<EffectSettingsByType[T]>[] } = {
  eq: [
    onOff("lowCut", "Low cut"),
    hz("lowCutHz", "Low cut frequency", 30),
    hz("lowShelfHz", "Low shelf frequency", 100),
    gain("lowShelfGainDb", "Low shelf gain"),
    hz("band1Hz", "Band 1 frequency", 250),
    q("band1Q", "Band 1 Q"),
    gain("band1GainDb", "Band 1 gain"),
    hz("band2Hz", "Band 2 frequency", 1000),
    q("band2Q", "Band 2 Q"),
    gain("band2GainDb", "Band 2 gain"),
    hz("band3Hz", "Band 3 frequency", 4000),
    q("band3Q", "Band 3 Q"),
    gain("band3GainDb", "Band 3 gain"),
    hz("highShelfHz", "High shelf frequency", 8000),
    gain("highShelfGainDb", "High shelf gain"),
    onOff("highCut", "High cut"),
    hz("highCutHz", "High cut frequency", 18000),
  ],
  compressor: [
    { name: "thresholdDb", label: "Threshold", unit: "dB", min: -60, max: 0, default: -18, step: 0, choices: [] },
    { name: "ratio", label: "Ratio", unit: ":1", min: 1, max: 20, default: 4, step: 0, choices: [] },
    { name: "attack", label: "Attack", unit: "ms", min: 0.1, max: 200, default: 5, step: 0, choices: [] },
    { name: "release", label: "Release", unit: "ms", min: 10, max: 2000, default: 120, step: 0, choices: [] },
    { name: "makeupDb", label: "Makeup gain", unit: "dB", min: 0, max: 24, default: 3, step: 0, choices: [] },
    { name: "kneeDb", label: "Knee", unit: "dB", min: 0, max: 24, default: 6, step: 0, choices: [] },
  ],
  reverb: [
    amount("size", "Size", 0.5),
    { name: "decay", label: "Decay", unit: "s", min: 0.1, max: 10, default: 2, step: 0, choices: [] },
    amount("damping", "Damping", 0.5),
    { name: "preDelay", label: "Pre-delay", unit: "ms", min: 0, max: 200, default: 0, step: 0, choices: [] },
    amount("width", "Width", 1),
    amount("mix", "Mix", 0.25),
  ],
  delay: [
    { ...onOff("sync", "Sync to tempo"), default: 1 },
    {
      name: "note",
      label: "Note value",
      unit: "",
      min: 0,
      max: NOTE_VALUES.length - 1,
      default: NOTE_VALUES.indexOf("1/4"),
      step: 1,
      choices: NOTE_VALUES,
    },
    { name: "timeMs", label: "Time", unit: "ms", min: 1, max: 2000, default: 250, step: 0, choices: [] },
    { name: "feedback", label: "Feedback", unit: "", min: 0, max: 0.95, default: 0.35, step: 0, choices: [] },
    { name: "highCutHz", label: "High cut", unit: "Hz", min: 200, max: 20000, default: 8000, step: 0, choices: [] },
    onOff("pingPong", "Ping-pong"),
    amount("mix", "Mix", 0.3),
  ],
};

/** Every kind of Effect, in the order the UI offers them. */
export const EFFECT_TYPES: readonly EffectType[] = ["eq", "compressor", "reverb", "delay"];

/** What the UI calls each kind of Effect. */
export const EFFECT_NAMES: { readonly [T in EffectType]: string } = {
  eq: "EQ",
  compressor: "Compressor",
  reverb: "Reverb",
  delay: "Delay",
};

/** Each setting of `type`'s table, looked at without its settings' type. */
export function effectParams(type: EffectType): readonly EffectParam[] {
  return EFFECT_PARAMS[type] as readonly EffectParam[];
}

/** The setting of `type` called `name`, or undefined if there is no such setting. */
export function effectParam(type: EffectType, name: string): EffectParam | undefined {
  return effectParams(type).find((param) => param.name === name);
}

/** The defaults, from the table so there is only one of each. */
export function defaultEffectSettings<T extends EffectType>(type: T): EffectSettingsByType[T] {
  return effectSettingsFromFlat(type, []);
}

/** The engine's flat form: one number per setting, in the table's order. */
export function effectSettingsToFlat(type: EffectType, settings: EffectSettings): number[] {
  const values = settings as unknown as Record<string, string | number>;
  return effectParams(type).map((param) => {
    const value = values[param.name];
    return typeof value === "number" ? value : Math.max(0, param.choices.indexOf(value ?? ""));
  });
}

/** Read the engine's flat form back, taking the default for anything missing. */
export function effectSettingsFromFlat<T extends EffectType>(
  type: T,
  flat: readonly number[],
): EffectSettingsByType[T] {
  const settings: Record<string, string | number> = {};
  effectParams(type).forEach((param, index) => {
    const value = clampEffectValue(param, flat[index] ?? param.default);
    settings[param.name] = param.choices.length > 0 ? (param.choices[value] ?? param.choices[0]!) : value;
  });
  // The table's names are the interface's fields and its choices their types,
  // so what has just been built is exactly the settings of `type`.
  return settings as unknown as EffectSettingsByType[T];
}

/** `value` brought into the setting's range and onto its step. */
export function clampEffectValue(param: EffectParam, value: number): number {
  if (!Number.isFinite(value)) return param.default;
  const clamped = Math.min(param.max, Math.max(param.min, value));
  return param.step > 0 ? Math.round(clamped / param.step) * param.step : clamped;
}

/** The coefficients of one second-order filter, normalised so a0 is 1. */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

const BUTTERWORTH_Q = Math.SQRT1_2;

/**
 * How much an EQ with `settings` scales a sine at `frequency`, in dB: the
 * curve the frequency-response display draws. It designs the same filters as
 * the engine's EQ (`engine/src/effect/eq.rs`), skips the ones that do
 * nothing just as it does, and evaluates each at the frequency; the test
 * checks it against the engine's own `eq_response`.
 */
export function eqResponseDb(settings: EqSettings, frequency: number, sampleRate = 48_000): number {
  const bell = (frequencyHz: number, bandQ: number, gainDb: number): [Biquad, boolean] => [
    peaking(sampleRate, frequencyHz, bandQ, gainDb),
    gainDb !== 0,
  ];
  const filters: [Biquad, boolean][] = [
    [highPass(sampleRate, settings.lowCutHz, BUTTERWORTH_Q), settings.lowCut === "on"],
    [shelf(sampleRate, settings.lowShelfHz, settings.lowShelfGainDb, 1), settings.lowShelfGainDb !== 0],
    bell(settings.band1Hz, settings.band1Q, settings.band1GainDb),
    bell(settings.band2Hz, settings.band2Q, settings.band2GainDb),
    bell(settings.band3Hz, settings.band3Q, settings.band3GainDb),
    [shelf(sampleRate, settings.highShelfHz, settings.highShelfGainDb, -1), settings.highShelfGainDb !== 0],
    [lowPass(sampleRate, settings.highCutHz, BUTTERWORTH_Q), settings.highCut === "on"],
  ];
  const scale = filters
    .filter(([, active]) => active)
    .reduce((product, [filter]) => product * magnitude(filter, sampleRate, frequency), 1);
  return 20 * Math.log10(Math.max(scale, 1e-10));
}

function angles(sampleRate: number, frequency: number, filterQ: number): [number, number] {
  const clamped = Math.min(sampleRate * 0.49, Math.max(10, frequency));
  const w0 = (2 * Math.PI * clamped) / sampleRate;
  return [Math.cos(w0), Math.sin(w0) / (2 * filterQ)];
}

function normalised(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function lowPass(sampleRate: number, frequency: number, filterQ: number): Biquad {
  const [cos, alpha] = angles(sampleRate, frequency, filterQ);
  const b1 = 1 - cos;
  return normalised(b1 / 2, b1, b1 / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

function highPass(sampleRate: number, frequency: number, filterQ: number): Biquad {
  const [cos, alpha] = angles(sampleRate, frequency, filterQ);
  const b0 = (1 + cos) / 2;
  return normalised(b0, -(1 + cos), b0, 1 + alpha, -2 * cos, 1 - alpha);
}

function peaking(sampleRate: number, frequency: number, filterQ: number, gainDb: number): Biquad {
  const [cos, alpha] = angles(sampleRate, frequency, filterQ);
  const a = 10 ** (gainDb / 40);
  return normalised(1 + alpha * a, -2 * cos, 1 - alpha * a, 1 + alpha / a, -2 * cos, 1 - alpha / a);
}

/** A low shelf when `side` is 1, a high shelf when it is -1. */
function shelf(sampleRate: number, frequency: number, gainDb: number, side: 1 | -1): Biquad {
  const [cos, alpha] = angles(sampleRate, frequency, BUTTERWORTH_Q);
  const a = 10 ** (gainDb / 40);
  const k = 2 * Math.sqrt(a) * alpha;
  const c = side * cos;
  return normalised(
    a * (a + 1 - (a - 1) * c + k),
    side * 2 * a * (a - 1 - (a + 1) * c),
    a * (a + 1 - (a - 1) * c - k),
    a + 1 + (a - 1) * c + k,
    side * -2 * (a - 1 + (a + 1) * c),
    a + 1 + (a - 1) * c - k,
  );
}

function magnitude(filter: Biquad, sampleRate: number, frequency: number): number {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const [cos1, sin1, cos2, sin2] = [Math.cos(w), Math.sin(w), Math.cos(2 * w), Math.sin(2 * w)];
  // H(z) at z = e^jw, with z^-1 = cos w - j sin w.
  const numerator = Math.hypot(filter.b0 + filter.b1 * cos1 + filter.b2 * cos2, filter.b1 * sin1 + filter.b2 * sin2);
  const denominator = Math.hypot(1 + filter.a1 * cos1 + filter.a2 * cos2, filter.a1 * sin1 + filter.a2 * sin2);
  return numerator / denominator;
}

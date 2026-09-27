/**
 * The Synth's settings, as the UI and the Assistant see them.
 *
 * The engine declares every setting once (`engine/src/instrument/synth/
 * params.rs`) and publishes the table as JSON; this is that table, written
 * out so the UI can draw controls and validate a Project without waiting for
 * the WASM build to load. `synth-params.test.ts` checks the two against each
 * other, so they cannot drift apart.
 *
 * Settings that pick from a list are named here, not numbered as the engine's
 * flat form has them: a saved Project reads `"osc1Wave": "saw"`, and the
 * Assistant can set it by name. `synthSettingsToFlat` does the conversion.
 */

/** The shape an oscillator makes. */
export type Waveform = "saw" | "square" | "triangle" | "sine";

/** Which side of the cutoff the filter keeps. */
export type FilterType = "lowPass" | "highPass" | "bandPass";

/** What the LFO moves, if anything. */
export type LfoTarget = "off" | "pitch" | "filter" | "amp";

/** One setting: what it is called, what it may be, and what it is by default. */
export interface SynthParam {
  name: keyof SynthSettings;
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

/** The Synth's sound: one value for each of `SYNTH_PARAMS`. */
export interface SynthSettings {
  osc1Wave: Waveform;
  osc2Wave: Waveform;
  osc2Detune: number;
  oscMix: number;
  filterType: FilterType;
  cutoffHz: number;
  resonance: number;
  filterEnvAmount: number;
  filterAttack: number;
  filterDecay: number;
  filterSustain: number;
  filterRelease: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  lfoTarget: LfoTarget;
  lfoRateHz: number;
  lfoDepth: number;
  glide: number;
  voices: number;
  level: number;
}

/** Every setting of the Synth, in the order the engine sends them. */
export const SYNTH_PARAMS: readonly SynthParam[] = [
  { name: "osc1Wave", label: "Oscillator 1 wave", unit: "", min: 0, max: 3, default: 0, step: 1, choices: ["saw", "square", "triangle", "sine"] },
  { name: "osc2Wave", label: "Oscillator 2 wave", unit: "", min: 0, max: 3, default: 0, step: 1, choices: ["saw", "square", "triangle", "sine"] },
  { name: "osc2Detune", label: "Oscillator 2 detune", unit: "cents", min: -2400, max: 2400, default: 7, step: 0, choices: [] },
  { name: "oscMix", label: "Oscillator mix", unit: "", min: 0, max: 1, default: 0, step: 0, choices: [] },
  { name: "filterType", label: "Filter type", unit: "", min: 0, max: 2, default: 0, step: 1, choices: ["lowPass", "highPass", "bandPass"] },
  { name: "cutoffHz", label: "Cutoff", unit: "Hz", min: 20, max: 20000, default: 2400, step: 0, choices: [] },
  { name: "resonance", label: "Resonance", unit: "Q", min: 0.1, max: 20, default: 1.2, step: 0, choices: [] },
  { name: "filterEnvAmount", label: "Filter envelope amount", unit: "octaves", min: -8, max: 8, default: 0, step: 0, choices: [] },
  { name: "filterAttack", label: "Filter attack", unit: "s", min: 0.001, max: 10, default: 0.001, step: 0, choices: [] },
  { name: "filterDecay", label: "Filter decay", unit: "s", min: 0.001, max: 10, default: 0.2, step: 0, choices: [] },
  { name: "filterSustain", label: "Filter sustain", unit: "", min: 0, max: 1, default: 1, step: 0, choices: [] },
  { name: "filterRelease", label: "Filter release", unit: "s", min: 0.001, max: 10, default: 0.3, step: 0, choices: [] },
  { name: "attack", label: "Attack", unit: "s", min: 0.001, max: 10, default: 0.005, step: 0, choices: [] },
  { name: "decay", label: "Decay", unit: "s", min: 0.001, max: 10, default: 0.2, step: 0, choices: [] },
  { name: "sustain", label: "Sustain", unit: "", min: 0, max: 1, default: 0.6, step: 0, choices: [] },
  { name: "release", label: "Release", unit: "s", min: 0.001, max: 10, default: 0.3, step: 0, choices: [] },
  { name: "lfoTarget", label: "LFO target", unit: "", min: 0, max: 3, default: 0, step: 1, choices: ["off", "pitch", "filter", "amp"] },
  { name: "lfoRateHz", label: "LFO rate", unit: "Hz", min: 0.01, max: 20, default: 5, step: 0, choices: [] },
  { name: "lfoDepth", label: "LFO depth", unit: "", min: 0, max: 1, default: 0, step: 0, choices: [] },
  { name: "glide", label: "Glide", unit: "s", min: 0, max: 5, default: 0, step: 0, choices: [] },
  { name: "voices", label: "Voices", unit: "", min: 1, max: 16, default: 8, step: 1, choices: [] },
  { name: "level", label: "Level", unit: "", min: 0, max: 1, default: 1, step: 0, choices: [] },
];

const PARAM_BY_NAME = new Map(SYNTH_PARAMS.map((param) => [param.name, param]));

/** The setting called `name`, or undefined if there is no such setting. */
export function synthParam(name: string): SynthParam | undefined {
  return PARAM_BY_NAME.get(name as keyof SynthSettings);
}

/** A setting's value as the table says it should be: named, or a number. */
function valueOf(param: SynthParam, value: number): string | number {
  return param.choices.length > 0 ? (param.choices[value] ?? param.choices[0]!) : value;
}

/** The defaults, from the table so there is only one of each. */
export function defaultSynthSettings(): SynthSettings {
  return synthSettingsFromFlat(SYNTH_PARAMS.map((param) => param.default));
}

/** The engine's flat form: one number per setting, in the table's order. */
export function synthSettingsToFlat(settings: SynthSettings): number[] {
  return SYNTH_PARAMS.map((param) => {
    const value = settings[param.name];
    return typeof value === "number" ? value : Math.max(0, param.choices.indexOf(value));
  });
}

/** Read the engine's flat form back, taking the default for anything missing. */
export function synthSettingsFromFlat(flat: readonly number[]): SynthSettings {
  const settings: Record<string, string | number> = {};
  SYNTH_PARAMS.forEach((param, index) => {
    settings[param.name] = valueOf(param, clampSynthValue(param, flat[index] ?? param.default));
  });
  // The table's names are the interface's fields and its choices their types,
  // so what has just been built is exactly a `SynthSettings`.
  return settings as unknown as SynthSettings;
}

/** `value` brought into the setting's range and onto its step. */
export function clampSynthValue(param: SynthParam, value: number): number {
  if (!Number.isFinite(value)) return param.default;
  const clamped = Math.min(param.max, Math.max(param.min, value));
  return param.step > 0 ? Math.round(clamped / param.step) * param.step : clamped;
}

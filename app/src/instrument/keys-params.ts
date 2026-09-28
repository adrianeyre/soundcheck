/**
 * The Keys' settings, as the UI and the Assistant see them: a mirror of the
 * engine's table (`engine/src/instrument/keys/params.rs`), written out so
 * the UI can draw controls and check a Project before the WASM build loads.
 * `keys-params.test.ts` checks the two against each other.
 *
 * The one setting that picks from a list, `source`, is named here
 * (`"piano"` or `"sample"`), as the Synth's choices are.
 */

/** Where the Keys' sound comes from: the modelled piano, or a sample played at each key's pitch. */
export type KeysSource = "piano" | "sample";

/** One setting: what it is called, what it may be, and what it is by default. */
export interface KeysParam {
  name: keyof KeysSettings;
  label: string;
  unit: string;
  min: number;
  max: number;
  /** The default: for a setting that picks from a list, the choice's index. */
  default: number;
  /** The gap between values a control should offer, or 0 for continuous. */
  step: number;
  choices: readonly string[];
}

/** The Keys' sound: one value for each of `KEYS_PARAMS`. */
export interface KeysSettings {
  source: KeysSource;
  brightness: number;
  hammerPosition: number;
  partials: number;
  inharmonicity: number;
  strings: number;
  detune: number;
  decay: number;
  highDamping: number;
  release: number;
  attack: number;
  hammerNoise: number;
  bell: number;
  bellRatio: number;
  bellDecay: number;
  drive: number;
  toneHz: number;
  tremoloRateHz: number;
  tremoloDepth: number;
  tremoloStereo: number;
  width: number;
  velocitySense: number;
  rootNote: number;
  voices: number;
  level: number;
}

const n = (name: keyof KeysSettings, label: string, unit: string, min: number, max: number, value: number, step = 0): KeysParam => ({
  name,
  label,
  unit,
  min,
  max,
  default: value,
  step,
  choices: [],
});

/** Every setting of the Keys, in the order the engine takes them. */
export const KEYS_PARAMS: readonly KeysParam[] = [
  { name: "source", label: "Sound source", unit: "", min: 0, max: 1, default: 0, step: 1, choices: ["piano", "sample"] },
  n("brightness", "Brightness", "", 0, 1, 0.55),
  n("hammerPosition", "Hammer position", "", 0.02, 0.5, 0.12),
  n("partials", "Partials", "", 1, 16, 12, 1),
  n("inharmonicity", "Inharmonicity", "", 0, 1, 0.3),
  n("strings", "Strings per note", "", 1, 3, 2, 1),
  n("detune", "String detune", "cents", 0, 40, 1.5),
  n("decay", "Decay", "s", 0.1, 30, 8),
  n("highDamping", "High damping", "", 0, 1, 0.5),
  n("release", "Release", "s", 0.01, 5, 0.3),
  n("attack", "Attack", "s", 0.001, 2, 0.001),
  n("hammerNoise", "Hammer noise", "", 0, 1, 0.2),
  n("bell", "Bell", "", 0, 1, 0),
  n("bellRatio", "Bell ratio", "", 1, 16, 7),
  n("bellDecay", "Bell decay", "s", 0.02, 5, 0.6),
  n("drive", "Drive", "", 0, 1, 0),
  n("toneHz", "Tone", "Hz", 200, 20000, 20000),
  n("tremoloRateHz", "Tremolo rate", "Hz", 0.1, 12, 5),
  n("tremoloDepth", "Tremolo depth", "", 0, 1, 0),
  n("tremoloStereo", "Tremolo stereo", "", 0, 1, 0),
  n("width", "Stereo width", "", 0, 1, 0.5),
  n("velocitySense", "Velocity sensitivity", "", 0, 1, 0.8),
  n("rootNote", "Sample root note", "", 0, 127, 60, 1),
  n("voices", "Voices", "", 1, 32, 24, 1),
  n("level", "Level", "", 0, 1, 0.8),
];

const BY_NAME = new Map(KEYS_PARAMS.map((param) => [param.name, param]));

export function keysParam(name: string): KeysParam | undefined {
  return BY_NAME.get(name as keyof KeysSettings);
}

/** `value` brought into the setting's range and onto its step. */
export function clampKeysValue(param: KeysParam, value: number): number {
  if (!Number.isFinite(value)) return param.default;
  const clamped = Math.min(param.max, Math.max(param.min, value));
  return param.step > 0 ? Math.round(clamped / param.step) * param.step : clamped;
}

export function defaultKeysSettings(): KeysSettings {
  return keysSettingsFromFlat(KEYS_PARAMS.map((param) => param.default));
}

/** The engine's flat form: one number per setting, in the table's order. */
export function keysSettingsToFlat(settings: KeysSettings): number[] {
  return KEYS_PARAMS.map((param) => {
    const value = settings[param.name];
    return typeof value === "number" ? value : Math.max(0, param.choices.indexOf(value));
  });
}

/** Read the flat form back, taking the default for anything missing. */
export function keysSettingsFromFlat(flat: readonly number[]): KeysSettings {
  const settings: Record<string, string | number> = {};
  KEYS_PARAMS.forEach((param, index) => {
    const value = clampKeysValue(param, flat[index] ?? param.default);
    settings[param.name] = param.choices.length > 0 ? (param.choices[value] ?? param.choices[0]!) : value;
  });
  // The table's names are the interface's fields, so this is exactly a `KeysSettings`.
  return settings as unknown as KeysSettings;
}

/** The default settings with `changes` made: how each factory preset is written. */
export function keysSettingsWith(changes: Partial<Record<keyof KeysSettings, number>>): KeysSettings {
  const flat = KEYS_PARAMS.map((param) => changes[param.name] ?? param.default);
  return keysSettingsFromFlat(flat);
}

/** The Keys' settings Automation can move: the continuous numbers, not the source or a count. */
export function automatableKeysParams(): KeysParam[] {
  return KEYS_PARAMS.filter((param) => param.choices.length === 0 && param.step === 0);
}

/** A MIDI note's name, as the root note picker shows it: 60 is C4. */
export function noteName(note: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
}

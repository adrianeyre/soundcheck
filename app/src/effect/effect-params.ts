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

/** The shapes the Saturator bends the signal with, as the engine lists them. */
export const SATURATOR_SHAPES = ["soft", "hard", "tube", "fold"] as const;

export interface SaturatorSettings {
  driveDb: number;
  /** Soft (tanh), hard (a clipper), tube (lopsided, for even harmonics) or fold (a wavefolder). */
  shape: (typeof SATURATOR_SHAPES)[number];
  /** The high-cut after the shaper. */
  toneHz: number;
  outputDb: number;
  /** 0..1: 0 is only the dry signal, 1 only the saturated one. */
  mix: number;
}

export interface ChorusSettings {
  rateHz: number;
  depthMs: number;
  delayMs: number;
  feedback: number;
  /** 0..1: how far apart the sides swing, up to half a cycle. */
  width: number;
  mix: number;
}

/** How many all-pass stages the Phaser runs, as the engine lists them. */
export const PHASER_STAGES = ["2", "4", "6", "8", "12"] as const;

export interface PhaserSettings {
  rateHz: number;
  depth: number;
  centreHz: number;
  feedback: number;
  stages: (typeof PHASER_STAGES)[number];
  mix: number;
}

/** The Auto Filter's modes, as the engine lists them. */
export const FILTER_MODES = ["low-pass", "high-pass", "band-pass", "notch"] as const;

export interface FilterSettings {
  mode: (typeof FILTER_MODES)[number];
  cutoffHz: number;
  /** The filter's Q. */
  resonance: number;
  lfoRateHz: number;
  /** How far the LFO moves the cutoff either way, in octaves. */
  lfoDepth: number;
  driveDb: number;
  mix: number;
}

export interface GateSettings {
  thresholdDb: number;
  /** How far a closed gate turns the signal down: -80 dB is silence. */
  rangeDb: number;
  /** Milliseconds. */
  attack: number;
  /** Milliseconds the gate stays open after the signal falls below the threshold. */
  hold: number;
  /** Milliseconds. */
  release: number;
}

export interface LimiterSettings {
  inputGainDb: number;
  /** The level nothing leaving the Limiter goes past. */
  ceilingDb: number;
  /** Milliseconds. */
  release: number;
  /** Milliseconds the signal is held back so each peak is seen coming. */
  lookahead: number;
}

export interface BitcrusherSettings {
  /** 1 to 24, whole. */
  bits: number;
  /** How many samples each is held for, 1 to 64, whole. */
  downsample: number;
  mix: number;
}

export interface UtilitySettings {
  gainDb: number;
  /** 0 is mono, 1 as it is, 2 twice as wide. */
  width: number;
  /** A balance, -1 (left) to 1 (right). */
  pan: number;
  invertLeft: OnOff;
  invertRight: OnOff;
  mono: OnOff;
}

/** The shapes the Tremolo's and the Auto Pan's LFO can take, as the engine lists them. */
export const LFO_SHAPES = ["sine", "triangle", "square"] as const;

// (none: `shape` uses LFO_SHAPES, declared with the Tremolo's settings)

/** The Auto Wah's filter modes, as the engine lists them. */
export const AUTO_WAH_MODES = ["band-pass", "low-pass"] as const;

/** The sides the Haas Widener can delay, as the engine lists them. */
export const HAAS_SIDES = ["left", "right"] as const;

/** How the Resonator is tuned, as the engine lists them. */
export const RESONATOR_TUNINGS = ["note", "frequency"] as const;
/** The notes the Resonator can be tuned to, as the engine lists them. */
export const RESONATOR_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
/** The chords the Resonator can ring, as the engine lists them. */
export const RESONATOR_CHORDS = ["unison", "fifth", "octave", "major", "minor"] as const;

/** The Vowel Filter's vowels, in the order Morph moves through them, as the engine lists them. */
export const VOWELS = ["A", "E", "I", "O", "U"] as const;

/** The note values the Pump dips once in, shortest first, as the engine lists them. */
export const PUMP_NOTES = ["1/16", "1/8", "1/4", "1/2", "1/1"] as const;

/** How long each Trance Gate step lasts, shortest first, as the engine lists them. */
export const TRANCE_GATE_STEPS = ["1/32", "1/16", "1/8"] as const;
/** The Trance Gate's patterns, as the engine lists them. */
export const TRANCE_GATE_PATTERNS = [
  "sixteenths",
  "eighths",
  "offbeats",
  "gallop",
  "reverse gallop",
  "tresillo",
  "syncopated",
  "build",
] as const;

/** The Beat Repeat's slice lengths, shortest first, as the engine lists them. */
export const BEAT_REPEAT_SLICES = ["1/32", "1/16", "1/8", "1/4"] as const;

export interface FlangerSettings {
  rateHz: number;
  /** Milliseconds: the shortest the copy is late by. */
  delayMs: number;
  /** Milliseconds: how much later the copy swings to. */
  depthMs: number;
  /** -0.95..0.95: how much of the copy goes back in; negative flips it, for a hollower ring. */
  feedback: number;
  /** 0..180 degrees: how far the right side's sweep runs behind the left's. */
  stereoPhase: number;
  /** 0..1: 0 is only the dry signal, 1 only the copy; half and half cuts the deepest notches. */
  mix: number;
}

export interface TremoloSettings {
  /** On, the rate is `note`, which follows the tempo; off, it is `rateHz`. */
  sync: OnOff;
  /** One pulse per note value, when synced. */
  note: NoteValue;
  /** Pulses a second, when not synced. */
  rateHz: number;
  /** Sine swells smoothly, triangle leans in and out, square chops. */
  shape: (typeof LFO_SHAPES)[number];
  /** 0..1: how far down the level goes, 1 to silence. */
  depth: number;
  /** 0..180 degrees: how far the right side's pulse runs behind the left's. */
  stereoPhase: number;
}

export interface AutoPanSettings {
  /** On, the rate is `note`, which follows the tempo; off, it is `rateHz`. */
  sync: OnOff;
  /** One sweep left and right per note value, when synced. */
  note: NoteValue;
  /** Sweeps a second, when not synced. */
  rateHz: number;
  /** Sine glides, triangle travels at an even speed, square jumps from side to side. */
  shape: (typeof LFO_SHAPES)[number];
  /** 0..1: how far from the centre the sweep goes, 1 to hard left and right. */
  depth: number;
}

export interface RingModSettings {
  /** The carrier the signal is multiplied by: low is a wobble, high a clangorous ring. */
  frequencyHz: number;
  /** How fast the carrier drifts up and down. */
  driftRateHz: number;
  /** How far the carrier drifts either way, in semitones: 0 holds it still. */
  driftDepth: number;
  /** 0..1: 0 is only the dry signal, 1 only the ring. */
  mix: number;
}

export interface VibratoSettings {
  /** Wobbles a second. */
  rateHz: number;
  /** How far the pitch goes either way, in cents: 0 is the signal untouched. */
  depthCents: number;
  /** 0..180 degrees: how far the right side's wobble runs behind the left's. */
  stereoPhase: number;
}

export interface TransientShaperSettings {
  /** -100% to 100%: how far the start of each hit is turned down or up. */
  attack: number;
  /** -100% to 100%: how far each sound's tail is turned down or up. */
  sustain: number;
  outputDb: number;
  /** 0..1: 0 is only the dry signal, 1 only the shaped one. */
  mix: number;
}

export interface DeEsserSettings {
  /** The centre of the band that is listened to and turned down, where the sibilance sits. */
  frequencyHz: number;
  thresholdDb: number;
  /** The most the band is turned down, in dB. */
  rangeDb: number;
  /** On, only the band it hears plays, to find the Frequency. */
  listen: OnOff;
}

export interface ExciterSettings {
  /** Where the band that is excited starts. */
  frequencyHz: number;
  /** How hard the band is pushed into the saturator, and so how many harmonics it makes. */
  driveDb: number;
  /** 0..1: how much of the excited band is added back. */
  amount: number;
  /** 0..1: 0 is only the dry signal, 1 only the excited one. */
  mix: number;
}

export interface MultibandSettings {
  /** Where the lows end and the mids start. */
  lowCrossoverHz: number;
  /** Where the mids end and the highs start. */
  highCrossoverHz: number;
  lowThresholdDb: number;
  lowRatio: number;
  midThresholdDb: number;
  midRatio: number;
  highThresholdDb: number;
  highRatio: number;
  /** Milliseconds, shared by all three bands. */
  attack: number;
  /** Milliseconds, shared by all three bands. */
  release: number;
  outputDb: number;
}

export interface ClipperSettings {
  inputDb: number;
  /** The level nothing leaving the clip goes past. */
  ceilingDb: number;
  /** 0..1: 0 is a hard clip; towards 1 the peaks are rounded off further below the ceiling. */
  softness: number;
  outputDb: number;
  /** 0..1: 0 is only the dry signal, 1 only the clipped one. */
  mix: number;
}

export interface FrequencyShifterSettings {
  /** Hertz every frequency moves by: up when positive, down when negative. */
  shiftHz: number;
  /** 0..0.9: how much of the shifted signal goes round again, shifting further each pass. */
  feedback: number;
  /** 0..1: 0 is only the dry signal, 1 only the shifted one. */
  mix: number;
}

export interface AutoWahSettings {
  /** A band-pass for the classic vocal wah, or a low-pass for a fuller, synth-like one. */
  mode: (typeof AUTO_WAH_MODES)[number];
  /** Where the filter sits when the part is silent. */
  lowHz: number;
  /** Where it reaches when the part is loud enough. */
  highHz: number;
  /** How much the follower's level is turned up: a 0 dBFS level, turned up by this, reaches High. */
  sensitivityDb: number;
  /** Milliseconds. */
  attackMs: number;
  /** Milliseconds. */
  releaseMs: number;
  /** The filter's Q. */
  resonance: number;
  mix: number;
}

export interface HaasSettings {
  /** The side that plays late; the other passes untouched. */
  side: (typeof HAAS_SIDES)[number];
  /** Milliseconds the delayed side waits: up to 40, which the ear still hears as one sound. */
  delayMs: number;
  /** The delayed side's level: turning it down keeps the image centred and sums to mono better. */
  levelDb: number;
  /** 0..1: 0 is only the dry signal, 1 the delayed side fully late. */
  mix: number;
}

export interface ResonatorSettings {
  /** Whether the pitch is `note` in `octave`, or `frequencyHz`. */
  tuneBy: (typeof RESONATOR_TUNINGS)[number];
  note: (typeof RESONATOR_NOTES)[number];
  /** 1..7, where C4 is middle C. */
  octave: number;
  /** The pitch when tuned by frequency. */
  frequencyHz: number;
  /** The notes rung together: the root alone, or with a fifth, an octave, or a major or minor triad. */
  chord: (typeof RESONATOR_CHORDS)[number];
  /** Seconds for the ringing to fall by 60 dB. */
  decay: number;
  /** 0..1: how much of the upper harmonics the ringing keeps; low is woody, high metallic. */
  brightness: number;
  mix: number;
}

export interface VowelSettings {
  vowel: (typeof VOWELS)[number];
  /** 0..1: how far towards the next vowel along (U round to A). */
  morph: number;
  /** The formant bands' Q: higher is narrower and more vocal. */
  resonance: number;
  lfoRateHz: number;
  /** How far the LFO moves the vowel either way, in vowels. */
  lfoDepth: number;
  mix: number;
}

export interface PumpSettings {
  /** How often the level dips: once every this note value, following the tempo. */
  note: (typeof PUMP_NOTES)[number];
  /** 0..1: how far the level falls at each dip; 1 is silence. */
  depth: number;
  /** 0.05..1: how much of the note the level takes to come back. */
  release: number;
  /** 0..1: the shape of the way back. 0.5 rises evenly, towards 0 it stays down and snaps back late, towards 1 it springs back early. */
  curve: number;
  /** 0..1: how far into the note each dip falls, to line it up with the kick. */
  phase: number;
  /** 0..1: 0 is only the dry signal, 1 only the pumped one. */
  mix: number;
}

export interface TranceGateSettings {
  /** How long each of the 16 steps lasts, following the tempo. */
  step: (typeof TRANCE_GATE_STEPS)[number];
  /** Which steps are open. */
  pattern: (typeof TRANCE_GATE_PATTERNS)[number];
  /** Milliseconds each open step fades in over. */
  attackMs: number;
  /** Milliseconds each open step fades out over, before the step ends. */
  releaseMs: number;
  /** 0..1: how far closed steps fall; 1 is silence. */
  depth: number;
  /** 0..1: 0 is only the dry signal, 1 only the gated one. */
  mix: number;
}

export interface PitchShifterSettings {
  /** -12..12 whole semitones. */
  semitones: number;
  /** -100..100 cents on top of the semitones. */
  cents: number;
  /** Milliseconds: longer grains warble less on low notes, shorter ones keep transients tighter. */
  grainMs: number;
  /** 0..1: 0 is only the dry signal, 1 only the shifted one. */
  mix: number;
}

export interface LoFiSettings {
  /** 0..1: the slow pitch sway of a stretched tape. */
  wow: number;
  /** 0..1: the fast pitch waver of an uneven capstan. */
  flutter: number;
  /** The corner of the gentle low-pass that takes the top off. */
  toneHz: number;
  /** 0..1: how hard the tape saturation rounds the signal off. */
  drive: number;
  /** 0..1: how loud the tape hiss under the signal is. */
  hiss: number;
  /** 0..1: 0 is only the dry signal, 1 only the worn one. */
  mix: number;
}

export interface BeatRepeatSettings {
  /** How long a slice is, following the tempo. */
  slice: (typeof BEAT_REPEAT_SLICES)[number];
  /** 0 or 1: 1 records a slice from the moment it turns on, then repeats it until it is 0 again. A number rather than a switch, so Automation can drive it. */
  repeat: number;
  /** 0..1: how much quieter each repeat is than the one before. */
  decay: number;
  /** 0..1, while repeating: 0 is only the dry signal, 1 only the repeats. */
  mix: number;
}

/** Each kind of Effect, with the settings it keeps. */
export interface EffectSettingsByType {
  eq: EqSettings;
  compressor: CompressorSettings;
  reverb: ReverbSettings;
  delay: DelaySettings;
  saturator: SaturatorSettings;
  chorus: ChorusSettings;
  phaser: PhaserSettings;
  filter: FilterSettings;
  gate: GateSettings;
  limiter: LimiterSettings;
  bitcrusher: BitcrusherSettings;
  utility: UtilitySettings;
  flanger: FlangerSettings;
  tremolo: TremoloSettings;
  autopan: AutoPanSettings;
  ringmod: RingModSettings;
  vibrato: VibratoSettings;
  transient: TransientShaperSettings;
  deesser: DeEsserSettings;
  exciter: ExciterSettings;
  multiband: MultibandSettings;
  clipper: ClipperSettings;
  freqshift: FrequencyShifterSettings;
  autowah: AutoWahSettings;
  haas: HaasSettings;
  resonator: ResonatorSettings;
  vowel: VowelSettings;
  pump: PumpSettings;
  trancegate: TranceGateSettings;
  pitchshift: PitchShifterSettings;
  lofi: LoFiSettings;
  beatrepeat: BeatRepeatSettings;
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

function number<S>(
  name: keyof S & string,
  label: string,
  unit: string,
  [min, max, value]: [number, number, number],
  step = 0,
): EffectParam<S> {
  return { name, label, unit, min, max, default: value, step, choices: [] };
}

function pick<S>(name: keyof S & string, label: string, choices: readonly string[], value: number): EffectParam<S> {
  return { name, label, unit: "", min: 0, max: choices.length - 1, default: value, step: 1, choices };
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
  saturator: [
    number("driveDb", "Drive", "dB", [0, 36, 6]),
    pick("shape", "Shape", SATURATOR_SHAPES, 0),
    number("toneHz", "Tone", "Hz", [500, 20000, 12000]),
    number("outputDb", "Output", "dB", [-24, 12, 0]),
    amount("mix", "Mix", 1),
  ],
  chorus: [
    number("rateHz", "Rate", "Hz", [0.05, 8, 0.8]),
    number("depthMs", "Depth", "ms", [0, 10, 3]),
    number("delayMs", "Delay", "ms", [1, 30, 12]),
    number("feedback", "Feedback", "", [0, 0.9, 0]),
    amount("width", "Width", 1),
    amount("mix", "Mix", 0.5),
  ],
  phaser: [
    number("rateHz", "Rate", "Hz", [0.05, 8, 0.5]),
    amount("depth", "Depth", 0.7),
    number("centreHz", "Centre", "Hz", [100, 8000, 800]),
    number("feedback", "Feedback", "", [0, 0.9, 0.5]),
    pick("stages", "Stages", PHASER_STAGES, 1),
    amount("mix", "Mix", 0.5),
  ],
  filter: [
    pick("mode", "Mode", FILTER_MODES, 0),
    number("cutoffHz", "Cutoff", "Hz", [20, 20000, 2000]),
    number("resonance", "Resonance", "Q", [0.5, 18, 0.7]),
    number("lfoRateHz", "LFO rate", "Hz", [0.05, 20, 1]),
    number("lfoDepth", "LFO depth", "oct", [0, 4, 0]),
    number("driveDb", "Drive", "dB", [0, 24, 0]),
    amount("mix", "Mix", 1),
  ],
  gate: [
    number("thresholdDb", "Threshold", "dB", [-80, 0, -40]),
    number("rangeDb", "Range", "dB", [-80, 0, -80]),
    number("attack", "Attack", "ms", [0.1, 50, 1]),
    number("hold", "Hold", "ms", [0, 500, 20]),
    number("release", "Release", "ms", [5, 2000, 100]),
  ],
  limiter: [
    number("inputGainDb", "Input gain", "dB", [0, 24, 0]),
    number("ceilingDb", "Ceiling", "dB", [-12, 0, -0.3]),
    number("release", "Release", "ms", [1, 1000, 50]),
    number("lookahead", "Lookahead", "ms", [0, 10, 3]),
  ],
  bitcrusher: [
    number("bits", "Bits", "bit", [1, 24, 8], 1),
    number("downsample", "Downsample", "x", [1, 64, 1], 1),
    amount("mix", "Mix", 1),
  ],
  utility: [
    number("gainDb", "Gain", "dB", [-36, 36, 0]),
    number("width", "Width", "", [0, 2, 1]),
    number("pan", "Pan", "", [-1, 1, 0]),
    onOff("invertLeft", "Invert left"),
    onOff("invertRight", "Invert right"),
    onOff("mono", "Mono"),
  ],
  flanger: [
    number("rateHz", "Rate", "Hz", [0.05, 10, 0.3]),
    number("delayMs", "Delay", "ms", [0.1, 10, 1]),
    number("depthMs", "Depth", "ms", [0, 10, 3]),
    number("feedback", "Feedback", "", [-0.95, 0.95, 0.5]),
    number("stereoPhase", "Stereo phase", "°", [0, 180, 90]),
    amount("mix", "Mix", 0.5),
  ],
  tremolo: [
    onOff("sync", "Sync to tempo"),
    pick("note", "Note value", NOTE_VALUES, NOTE_VALUES.indexOf("1/8")),
    number("rateHz", "Rate", "Hz", [0.1, 20, 5]),
    pick("shape", "Shape", LFO_SHAPES, 0),
    amount("depth", "Depth", 0.5),
    number("stereoPhase", "Stereo phase", "°", [0, 180, 0]),
  ],
  autopan: [
    onOff("sync", "Sync to tempo"),
    pick("note", "Note value", NOTE_VALUES, NOTE_VALUES.indexOf("1/4")),
    number("rateHz", "Rate", "Hz", [0.05, 20, 0.5]),
    pick("shape", "Shape", LFO_SHAPES, 0),
    amount("depth", "Depth", 1),
  ],
  ringmod: [
    number("frequencyHz", "Frequency", "Hz", [20, 5000, 440]),
    number("driftRateHz", "Drift rate", "Hz", [0.05, 10, 0.5]),
    number("driftDepth", "Drift depth", "st", [0, 12, 0]),
    amount("mix", "Mix", 1),
  ],
  vibrato: [
    number("rateHz", "Rate", "Hz", [0.1, 14, 5]),
    number("depthCents", "Depth", "cents", [0, 100, 20]),
    number("stereoPhase", "Stereo phase", "°", [0, 180, 0]),
  ],
  transient: [
    number("attack", "Attack", "%", [-100, 100, 0]),
    number("sustain", "Sustain", "%", [-100, 100, 0]),
    number("outputDb", "Output", "dB", [-24, 24, 0]),
    amount("mix", "Mix", 1),
  ],
  deesser: [
    number("frequencyHz", "Frequency", "Hz", [2000, 12000, 6000]),
    number("thresholdDb", "Threshold", "dB", [-60, 0, -24]),
    number("rangeDb", "Range", "dB", [0, 24, 12]),
    onOff("listen", "Listen"),
  ],
  exciter: [
    number("frequencyHz", "Frequency", "Hz", [1000, 16000, 3000]),
    number("driveDb", "Drive", "dB", [0, 24, 12]),
    amount("amount", "Amount", 0.3),
    amount("mix", "Mix", 1),
  ],
  multiband: [
    number("lowCrossoverHz", "Low crossover", "Hz", [40, 1000, 200]),
    number("highCrossoverHz", "High crossover", "Hz", [1000, 12000, 3000]),
    number("lowThresholdDb", "Low threshold", "dB", [-60, 0, -20]),
    number("lowRatio", "Low ratio", ":1", [1, 20, 2]),
    number("midThresholdDb", "Mid threshold", "dB", [-60, 0, -20]),
    number("midRatio", "Mid ratio", ":1", [1, 20, 2]),
    number("highThresholdDb", "High threshold", "dB", [-60, 0, -20]),
    number("highRatio", "High ratio", ":1", [1, 20, 2]),
    number("attack", "Attack", "ms", [0.1, 200, 10]),
    number("release", "Release", "ms", [10, 2000, 150]),
    number("outputDb", "Output", "dB", [-24, 24, 0]),
  ],
  clipper: [
    number("inputDb", "Input gain", "dB", [-12, 24, 0]),
    number("ceilingDb", "Ceiling", "dB", [-24, 0, -0.3]),
    amount("softness", "Softness", 0),
    number("outputDb", "Output", "dB", [-24, 12, 0]),
    amount("mix", "Mix", 1),
  ],
  freqshift: [
    number("shiftHz", "Shift", "Hz", [-2000, 2000, 100]),
    number("feedback", "Feedback", "", [0, 0.9, 0]),
    amount("mix", "Mix", 1),
  ],
  autowah: [
    pick("mode", "Mode", AUTO_WAH_MODES, 0),
    number("lowHz", "Low", "Hz", [50, 2000, 300]),
    number("highHz", "High", "Hz", [200, 10000, 2500]),
    number("sensitivityDb", "Sensitivity", "dB", [0, 36, 12]),
    number("attackMs", "Attack", "ms", [0.1, 100, 5]),
    number("releaseMs", "Release", "ms", [5, 1000, 150]),
    number("resonance", "Resonance", "Q", [0.5, 18, 4]),
    amount("mix", "Mix", 1),
  ],
  haas: [
    pick("side", "Delayed side", HAAS_SIDES, 1),
    number("delayMs", "Delay", "ms", [0, 40, 15]),
    number("levelDb", "Delayed level", "dB", [-24, 0, -2]),
    amount("mix", "Mix", 1),
  ],
  resonator: [
    pick("tuneBy", "Tune by", RESONATOR_TUNINGS, 0),
    pick("note", "Note", RESONATOR_NOTES, 0),
    number("octave", "Octave", "", [1, 7, 3], 1),
    number("frequencyHz", "Frequency", "Hz", [20, 2000, 220]),
    pick("chord", "Chord", RESONATOR_CHORDS, 0),
    number("decay", "Decay", "s", [0.05, 10, 1]),
    amount("brightness", "Brightness", 0.5),
    amount("mix", "Mix", 0.5),
  ],
  vowel: [
    pick("vowel", "Vowel", VOWELS, 0),
    amount("morph", "Morph", 0),
    number("resonance", "Resonance", "Q", [1, 20, 6]),
    number("lfoRateHz", "LFO rate", "Hz", [0.05, 10, 1]),
    number("lfoDepth", "LFO depth", "", [0, 2, 0]),
    amount("mix", "Mix", 1),
  ],
  pump: [
    pick("note", "Note value", PUMP_NOTES, 2),
    amount("depth", "Depth", 0.7),
    number("release", "Release", "", [0.05, 1, 0.6]),
    amount("curve", "Curve", 0.4),
    amount("phase", "Phase", 0),
    amount("mix", "Mix", 1),
  ],
  trancegate: [
    pick("step", "Step length", TRANCE_GATE_STEPS, 1),
    pick("pattern", "Pattern", TRANCE_GATE_PATTERNS, 1),
    number("attackMs", "Attack", "ms", [0.5, 50, 2]),
    number("releaseMs", "Release", "ms", [0.5, 200, 20]),
    amount("depth", "Depth", 1),
    amount("mix", "Mix", 1),
  ],
  pitchshift: [
    number("semitones", "Semitones", "st", [-12, 12, 12], 1),
    number("cents", "Fine", "cent", [-100, 100, 0]),
    number("grainMs", "Grain size", "ms", [10, 200, 50]),
    amount("mix", "Mix", 0.5),
  ],
  lofi: [
    amount("wow", "Wow", 0.3),
    amount("flutter", "Flutter", 0.2),
    number("toneHz", "Tone", "Hz", [500, 20000, 6000]),
    amount("drive", "Drive", 0.3),
    amount("hiss", "Hiss", 0.2),
    amount("mix", "Mix", 1),
  ],
  beatrepeat: [
    pick("slice", "Slice", BEAT_REPEAT_SLICES, 1),
    number("repeat", "Repeat", "", [0, 1, 0], 1),
    amount("decay", "Decay", 0),
    amount("mix", "Mix", 1),
  ],
};

/** Every kind of Effect, in the order the UI offers them. */
export const EFFECT_TYPES: readonly EffectType[] = [
  "eq",
  "compressor",
  "reverb",
  "delay",
  "saturator",
  "chorus",
  "phaser",
  "filter",
  "gate",
  "limiter",
  "bitcrusher",
  "utility",
  "flanger",
  "tremolo",
  "autopan",
  "ringmod",
  "vibrato",
  "transient",
  "deesser",
  "exciter",
  "multiband",
  "clipper",
  "freqshift",
  "autowah",
  "haas",
  "resonator",
  "vowel",
  "pump",
  "trancegate",
  "pitchshift",
  "lofi",
  "beatrepeat",
];

/** What the UI calls each kind of Effect. */
export const EFFECT_NAMES: { readonly [T in EffectType]: string } = {
  eq: "EQ",
  compressor: "Compressor",
  reverb: "Reverb",
  delay: "Delay",
  saturator: "Saturator",
  chorus: "Chorus",
  phaser: "Phaser",
  filter: "Auto Filter",
  gate: "Gate",
  limiter: "Limiter",
  bitcrusher: "Bitcrusher",
  utility: "Utility",
  flanger: "Flanger",
  tremolo: "Tremolo",
  autopan: "Auto Pan",
  ringmod: "Ring Modulator",
  vibrato: "Vibrato",
  transient: "Transient Shaper",
  deesser: "De-esser",
  exciter: "Exciter",
  multiband: "Multiband Compressor",
  clipper: "Clipper",
  freqshift: "Frequency Shifter",
  autowah: "Auto Wah",
  haas: "Haas Widener",
  resonator: "Resonator",
  vowel: "Vowel Filter",
  pump: "Pump",
  trancegate: "Trance Gate",
  pitchshift: "Pitch Shifter",
  lofi: "Lo-fi",
  beatrepeat: "Beat Repeat",
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

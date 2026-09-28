/**
 * The Effects' factory Presets: a named starting point for an Effect's
 * settings. Loading one copies all its settings into the Effect, where they
 * can then be changed.
 *
 * Every built-in Effect has a few, as a starting point the musician (or the
 * Assistant) tunes from. They live in the UI, not the engine, because
 * loading one is only a settings change, which the engine already takes.
 */
import { defaultEffectSettings, type EffectSettingsByType, type EffectType } from "./effect-params";

export interface EffectPreset<T extends EffectType = EffectType> {
  name: string;
  /** What it sounds like, for the musician and the Assistant. */
  description: string;
  settings: EffectSettingsByType[T];
}

/** Every factory Preset of each Effect, in the order the picker lists them. */
export const EFFECT_PRESETS: { readonly [T in EffectType]: readonly EffectPreset<T>[] } = {
  eq: [
    {
      name: "Vocal presence",
      description: "Cuts the rumble and mud under a voice and lifts its presence and air",
      settings: {
        ...defaultEffectSettings("eq"),
        lowCut: "on",
        lowCutHz: 90,
        band1Hz: 300,
        band1Q: 1.2,
        band1GainDb: -3,
        band3Hz: 4000,
        band3Q: 1,
        band3GainDb: 3,
        highShelfHz: 10000,
        highShelfGainDb: 2.5,
      },
    },
    {
      name: "Low-end cleanup",
      description: "Takes out the sub rumble and boxiness so a part sits clear of the kick and bass",
      settings: { ...defaultEffectSettings("eq"), lowCut: "on", lowCutHz: 120, band1Hz: 400, band1Q: 1.5, band1GainDb: -4 },
    },
    {
      name: "Kick punch",
      description: "Deepens a kick's thump, scoops its boxiness and brings out the beater's click",
      settings: {
        ...defaultEffectSettings("eq"),
        lowShelfHz: 60,
        lowShelfGainDb: 4,
        band1Hz: 350,
        band1Q: 1.4,
        band1GainDb: -5,
        band3Hz: 3500,
        band3Q: 1.2,
        band3GainDb: 4,
      },
    },
    {
      name: "Telephone",
      description: "Squeezes the sound into a narrow, lo-fi band, as through an old phone",
      settings: {
        ...defaultEffectSettings("eq"),
        lowCut: "on",
        lowCutHz: 400,
        band2Hz: 1500,
        band2Q: 1,
        band2GainDb: 6,
        highCut: "on",
        highCutHz: 3500,
      },
    },
  ],
  compressor: [
    {
      name: "Gentle glue",
      description: "A light, slow squeeze that holds a mix or a Bus together without pumping",
      settings: { thresholdDb: -20, ratio: 2, attack: 30, release: 300, makeupDb: 2, kneeDb: 12 },
    },
    {
      name: "Vocal leveller",
      description: "Evens out a vocal's loud and quiet words so it stays in front",
      settings: { thresholdDb: -24, ratio: 4, attack: 5, release: 120, makeupDb: 6, kneeDb: 6 },
    },
    {
      name: "Drum smash",
      description: "Hard, fast compression for big, aggressive drums; blend it on a Bus",
      settings: { thresholdDb: -30, ratio: 12, attack: 1, release: 60, makeupDb: 10, kneeDb: 0 },
    },
    {
      name: "Bass control",
      description: "Holds a bass line at one steady level, note after note",
      settings: { thresholdDb: -22, ratio: 5, attack: 10, release: 150, makeupDb: 5, kneeDb: 4 },
    },
  ],
  reverb: [
    {
      name: "Small room",
      description: "A short, natural room that puts a sound in a space without washing it out",
      settings: { size: 0.3, decay: 0.6, damping: 0.6, preDelay: 5, width: 0.8, mix: 0.2 },
    },
    {
      name: "Large hall",
      description: "A long, wide concert-hall tail for pads, strings and ballads",
      settings: { size: 0.9, decay: 4.5, damping: 0.4, preDelay: 30, width: 1, mix: 0.3 },
    },
    {
      name: "Plate",
      description: "A bright, dense plate, the classic sheen on vocals and snares",
      settings: { size: 0.6, decay: 2, damping: 0.2, preDelay: 15, width: 1, mix: 0.25 },
    },
    {
      name: "Ambient wash",
      description: "An endless, dark tail to send a part into the distance; fully wet on a Bus",
      settings: { size: 1, decay: 9, damping: 0.7, preDelay: 60, width: 1, mix: 1 },
    },
  ],
  delay: [
    {
      name: "Slapback",
      description: "One quick, bright echo, as on a rockabilly vocal",
      settings: { ...defaultEffectSettings("delay"), sync: "off", timeMs: 110, feedback: 0.1, highCutHz: 6000, mix: 0.3 },
    },
    {
      name: "Quarter echo",
      description: "Repeats a quarter note apart, in time with the song, fading away",
      settings: { ...defaultEffectSettings("delay"), sync: "on", note: "1/4", feedback: 0.35, highCutHz: 8000, mix: 0.3 },
    },
    {
      name: "Dotted-eighth ping-pong",
      description: "Repeats a dotted eighth apart, bouncing between left and right",
      settings: {
        ...defaultEffectSettings("delay"),
        sync: "on",
        note: "1/8 dotted",
        feedback: 0.45,
        highCutHz: 5000,
        pingPong: "on",
        mix: 0.35,
      },
    },
  ],
  saturator: [
    {
      name: "Tape warmth",
      description: "A gentle, tape-like thickening that rounds off harsh edges",
      settings: { driveDb: 6, shape: "soft", toneHz: 9000, outputDb: -2, mix: 1 },
    },
    {
      name: "Tube drive",
      description: "A lopsided valve crunch that adds warm even harmonics",
      settings: { driveDb: 14, shape: "tube", toneHz: 7000, outputDb: -6, mix: 0.8 },
    },
    {
      name: "Hard clip",
      description: "Squares off the peaks for loud, gritty drums and bass",
      settings: { driveDb: 18, shape: "hard", toneHz: 12000, outputDb: -8, mix: 1 },
    },
    {
      name: "Wavefold",
      description: "Folds the peaks back on themselves for metallic, synthy overtones",
      settings: { driveDb: 20, shape: "fold", toneHz: 14000, outputDb: -6, mix: 0.6 },
    },
  ],
  chorus: [
    {
      name: "Classic chorus",
      description: "A lush, slow, wide doubling, as on an 80s clean guitar",
      settings: { rateHz: 0.8, depthMs: 3, delayMs: 12, feedback: 0, width: 1, mix: 0.5 },
    },
    {
      name: "Wide doubler",
      description: "A subtle second voice that widens a part without an obvious wobble",
      settings: { rateHz: 0.3, depthMs: 1.5, delayMs: 20, feedback: 0, width: 1, mix: 0.4 },
    },
    {
      name: "Flanger",
      description: "A short, fed-back sweep for the jet-plane whoosh",
      settings: { rateHz: 0.25, depthMs: 2.5, delayMs: 1.5, feedback: 0.7, width: 0.5, mix: 0.5 },
    },
  ],
  phaser: [
    {
      name: "Slow swirl",
      description: "A slow, deep sweep for pads and electric pianos",
      settings: { rateHz: 0.2, depth: 0.8, centreHz: 700, feedback: 0.4, stages: "4", mix: 0.5 },
    },
    {
      name: "Funky phase",
      description: "A quicker, resonant sweep for clean guitar and clav",
      settings: { rateHz: 1.5, depth: 0.6, centreHz: 1200, feedback: 0.7, stages: "6", mix: 0.5 },
    },
    {
      name: "Deep jet",
      description: "Twelve stages and heavy feedback for a dramatic, vocal sweep",
      settings: { rateHz: 0.1, depth: 1, centreHz: 900, feedback: 0.85, stages: "12", mix: 0.5 },
    },
  ],
  filter: [
    {
      name: "Low-pass sweep",
      description: "A slowly opening and closing low-pass for build-ups and breakdowns",
      settings: { mode: "low-pass", cutoffHz: 1200, resonance: 4, lfoRateHz: 0.1, lfoDepth: 2.5, driveDb: 3, mix: 1 },
    },
    {
      name: "Wobble",
      description: "A fast, resonant low-pass wobble, as on a dubstep bass",
      settings: { mode: "low-pass", cutoffHz: 600, resonance: 8, lfoRateHz: 4, lfoDepth: 2, driveDb: 6, mix: 1 },
    },
    {
      name: "Thin out",
      description: "A static high-pass that takes a part's weight away, for an intro or a breakdown",
      settings: { mode: "high-pass", cutoffHz: 800, resonance: 1, lfoRateHz: 1, lfoDepth: 0, driveDb: 0, mix: 1 },
    },
    {
      name: "Radio",
      description: "A narrow band-pass for a tinny, far-away sound",
      settings: { mode: "band-pass", cutoffHz: 1500, resonance: 2, lfoRateHz: 1, lfoDepth: 0, driveDb: 6, mix: 1 },
    },
  ],
  gate: [
    {
      name: "Tight drums",
      description: "Shuts off the ring and spill between hits",
      settings: { thresholdDb: -30, rangeDb: -80, attack: 0.5, hold: 30, release: 80 },
    },
    {
      name: "Noise cleanup",
      description: "Softly turns down hiss and hum in the gaps of a recording",
      settings: { thresholdDb: -50, rangeDb: -20, attack: 2, hold: 50, release: 250 },
    },
    {
      name: "Chop",
      description: "A hard, fast gate for choppy, stuttering effects",
      settings: { thresholdDb: -20, rangeDb: -80, attack: 0.1, hold: 0, release: 10 },
    },
  ],
  limiter: [
    {
      name: "Master ceiling",
      description: "Catches the peaks at -1 dB so the mix never clips, with nothing else changed",
      settings: { inputGainDb: 0, ceilingDb: -1, release: 80, lookahead: 5 },
    },
    {
      name: "Loud master",
      description: "Pushes the mix up for a loud, finished master",
      settings: { inputGainDb: 6, ceilingDb: -0.3, release: 60, lookahead: 5 },
    },
    {
      name: "Brickwall",
      description: "An instant, hard ceiling for stems and bounces",
      settings: { inputGainDb: 0, ceilingDb: -0.1, release: 20, lookahead: 10 },
    },
  ],
  bitcrusher: [
    {
      name: "8-bit console",
      description: "The crunchy, aliased sound of an old games console",
      settings: { bits: 8, downsample: 4, mix: 1 },
    },
    {
      name: "Lo-fi grit",
      description: "A little noise and grit blended under the clean sound",
      settings: { bits: 10, downsample: 2, mix: 0.4 },
    },
    {
      name: "Destroyed",
      description: "Four bits, heavily downsampled: barely recognisable",
      settings: { bits: 4, downsample: 16, mix: 1 },
    },
  ],
  utility: [
    {
      name: "Mono check",
      description: "Sums the channel to mono, to hear how the mix holds up on one speaker",
      settings: { ...defaultEffectSettings("utility"), mono: "on" },
    },
    {
      name: "Extra wide",
      description: "Widens the stereo image by half again",
      settings: { ...defaultEffectSettings("utility"), width: 1.5 },
    },
    {
      name: "Flip polarity",
      description: "Inverts both sides, to fix a recording that cancels against another",
      settings: { ...defaultEffectSettings("utility"), invertLeft: "on", invertRight: "on" },
    },
  ],
};

/** The factory Presets of `type`, looked at without their settings' type. */
export function effectPresets(type: EffectType): readonly EffectPreset[] {
  return EFFECT_PRESETS[type] as readonly EffectPreset[];
}

/** The factory Preset of `type` called `name`, or undefined if it has none. */
export function effectPreset(type: EffectType, name: string): EffectPreset | undefined {
  return effectPresets(type).find((preset) => preset.name === name);
}

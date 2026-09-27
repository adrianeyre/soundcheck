/**
 * The Effects' factory Presets: a named starting point for an Effect's
 * settings. Loading one copies all its settings into the Effect, where they
 * can then be changed.
 *
 * Only the Delay has Presets so far. They live in the UI, not the engine,
 * because loading one is only a settings change, which the engine already
 * takes.
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
  eq: [],
  compressor: [],
  reverb: [],
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
};

/** The factory Presets of `type`, looked at without their settings' type. */
export function effectPresets(type: EffectType): readonly EffectPreset[] {
  return EFFECT_PRESETS[type] as readonly EffectPreset[];
}

/** The factory Preset of `type` called `name`, or undefined if it has none. */
export function effectPreset(type: EffectType, name: string): EffectPreset | undefined {
  return effectPresets(type).find((preset) => preset.name === name);
}

/**
 * The Keys' factory presets, mirroring the engine's
 * (`engine/src/instrument/keys/presets.rs`) so the picker lists them before
 * the engine loads; `keys-params.test.ts` checks the two against each other.
 * Each is the default settings with a few changes, as the engine writes them.
 */
import { keysSettingsWith, type KeysSettings } from "./keys-params";

export interface KeysPreset {
  name: string;
  /** One of grand, upright, electric or character. */
  category: KeysCategory;
  /** What it sounds like, for the musician and the Assistant. */
  description: string;
  settings: KeysSettings;
}

export type KeysCategory = "grand" | "upright" | "electric" | "character";

/** The categories in the order the browser shows them, with what each is called. */
export const KEYS_CATEGORIES: readonly { id: KeysCategory; name: string }[] = [
  { id: "grand", name: "Grand pianos" },
  { id: "upright", name: "Uprights" },
  { id: "electric", name: "Electric pianos" },
  { id: "character", name: "Character" },
];

const preset = (name: string, category: KeysCategory, description: string, changes: Partial<Record<keyof KeysSettings, number>>): KeysPreset => ({
  name,
  category,
  description,
  settings: keysSettingsWith(changes),
});

/** Every factory preset, in the order the picker lists them. */
export const KEYS_PRESETS: readonly KeysPreset[] = [
  preset("Concert Grand", "grand", "Full, even nine-foot grand with a long singing decay", { brightness: 0.6, strings: 3.0, detune: 1.2, decay: 12.0, inharmonicity: 0.35, width: 0.7 }),
  preset("Bright Grand", "grand", "Hard-hammered grand that cuts through a mix", { brightness: 0.85, strings: 3.0, detune: 1.5, decay: 9.0, highDamping: 0.3, hammerNoise: 0.35, level: 0.7 }),
  preset("Warm Grand", "grand", "Soft-voiced grand, round and mellow", { brightness: 0.35, strings: 3.0, detune: 1.0, decay: 11.0, highDamping: 0.7, toneHz: 7000.0 }),
  preset("Jazz Grand", "grand", "Close, woody grand for comping and ballads", { brightness: 0.5, strings: 2.0, detune: 2.0, decay: 7.0, hammerPosition: 0.14, toneHz: 10000.0 }),
  preset("Studio Grand", "grand", "Tight, polished grand as on a pop record", { brightness: 0.7, strings: 2.0, detune: 1.0, decay: 6.0, release: 0.2, width: 0.6 }),
  preset("Ballad Grand", "grand", "Gentle grand with a slow bloom and a long tail", { brightness: 0.4, strings: 3.0, decay: 16.0, release: 0.8, attack: 0.01, width: 0.8 }),
  preset("Classical Grand", "grand", "Balanced grand with a clear bass and sparkling top", { brightness: 0.6, strings: 3.0, detune: 0.8, decay: 13.0, inharmonicity: 0.4, partials: 14.0 }),
  preset("Rock Piano", "grand", "Bright, driven grand for pounding chords", { brightness: 0.9, strings: 2.0, detune: 3.0, decay: 5.0, drive: 0.35, hammerNoise: 0.4, level: 0.65 }),
  preset("Upright Piano", "upright", "Homely upright, a little boxy and intimate", { brightness: 0.5, strings: 2.0, detune: 3.0, decay: 5.0, inharmonicity: 0.55, toneHz: 9000.0 }),
  preset("Old Upright", "upright", "Tired upright with a dull top and a wobble", { brightness: 0.35, strings: 2.0, detune: 7.0, decay: 4.0, inharmonicity: 0.7, toneHz: 5000.0 }),
  preset("Honky-Tonk", "upright", "Saloon upright with its strings pulled out of tune", { brightness: 0.7, strings: 3.0, detune: 18.0, decay: 4.0, inharmonicity: 0.5, hammerNoise: 0.35 }),
  preset("Saloon Piano", "upright", "Jangly, clattering bar-room piano", { brightness: 0.8, strings: 3.0, detune: 26.0, decay: 3.0, hammerNoise: 0.55, inharmonicity: 0.6 }),
  preset("Felt Piano", "upright", "Felt over the hammers: soft, hushed and close", { brightness: 0.15, strings: 2.0, detune: 2.0, decay: 4.0, toneHz: 2500.0, hammerNoise: 0.45, release: 0.5 }),
  preset("Lullaby Felt", "upright", "The softest felt, for quiet lullabies and film cues", { brightness: 0.1, strings: 1.0, decay: 5.0, toneHz: 1800.0, attack: 0.008, release: 0.9, width: 0.8 }),
  preset("Tack Piano", "upright", "Tacks in the hammers: bright, metallic and ragtime", { brightness: 1.0, strings: 2.0, detune: 9.0, decay: 3.0, hammerNoise: 0.7, hammerPosition: 0.05, bell: 0.15, bellRatio: 11.0, bellDecay: 0.15 }),
  preset("Muted Piano", "upright", "Palm-muted strings, short and percussive", { brightness: 0.45, strings: 2.0, decay: 0.6, release: 0.1, highDamping: 0.9, hammerNoise: 0.3 }),
  preset("Tine EP", "electric", "Classic tine electric piano, bell on top and a warm core", { brightness: 0.2, partials: 4.0, strings: 1.0, inharmonicity: 0.0, decay: 6.0, bell: 0.45, bellRatio: 7.0, bellDecay: 0.5, drive: 0.15, hammerNoise: 0.05 }),
  preset("Suitcase EP", "electric", "Tine piano through a stereo tremolo that swirls side to side", { brightness: 0.2, partials: 4.0, strings: 1.0, inharmonicity: 0.0, decay: 6.0, bell: 0.4, bellRatio: 7.0, tremoloDepth: 0.6, tremoloStereo: 1.0, tremoloRateHz: 4.5, width: 0.9 }),
  preset("Bark EP", "electric", "Tine piano played hard: growling and driven", { brightness: 0.35, partials: 5.0, strings: 1.0, inharmonicity: 0.0, decay: 5.0, bell: 0.55, bellRatio: 7.0, drive: 0.7, velocitySense: 1.0 }),
  preset("Reed EP", "electric", "Reed electric piano, nasal and buzzy, with a little tremolo", { brightness: 0.55, partials: 8.0, strings: 1.0, inharmonicity: 0.05, decay: 3.5, bell: 0.2, bellRatio: 3.0, bellDecay: 0.3, drive: 0.45, tremoloDepth: 0.3, tremoloRateHz: 5.5 }),
  preset("FM EP", "electric", "Glassy digital FM piano, bright bell and clean body", { brightness: 0.25, partials: 3.0, strings: 1.0, inharmonicity: 0.0, decay: 5.0, bell: 0.6, bellRatio: 14.0, bellDecay: 0.35, width: 0.7 }),
  preset("Glass EP", "electric", "Airy, chorused electric piano for pads and ballads", { brightness: 0.2, partials: 4.0, strings: 2.0, detune: 6.0, inharmonicity: 0.0, decay: 8.0, bell: 0.5, bellRatio: 9.0, release: 0.8, width: 1.0 }),
  preset("Dyno EP", "electric", "Punchy, hi-fi tine piano with an emphasised attack", { brightness: 0.45, partials: 5.0, strings: 1.0, inharmonicity: 0.0, decay: 4.0, bell: 0.7, bellRatio: 7.0, bellDecay: 0.2, hammerNoise: 0.15, velocitySense: 0.9 }),
  preset("Stage Piano", "electric", "Electric grand: strings with pickups, bright and compact", { brightness: 0.75, strings: 2.0, detune: 4.0, decay: 4.5, inharmonicity: 0.45, drive: 0.2, toneHz: 8000.0 }),
  preset("Toy Piano", "character", "Struck metal rods: plinky, out of tune and cute", { brightness: 0.5, partials: 3.0, strings: 1.0, inharmonicity: 1.0, decay: 1.2, bell: 0.6, bellRatio: 2.76, bellDecay: 0.5, hammerNoise: 0.4 }),
  preset("Music Box", "character", "Plucked comb teeth, delicate and chiming", { brightness: 0.3, partials: 2.0, strings: 1.0, inharmonicity: 0.0, decay: 2.5, bell: 0.5, bellRatio: 5.4, bellDecay: 0.9, hammerNoise: 0.05, width: 0.9 }),
  preset("Celesta", "character", "Hammers on steel plates: soft sparkling bells", { brightness: 0.2, partials: 3.0, strings: 1.0, inharmonicity: 0.0, decay: 2.0, bell: 0.4, bellRatio: 4.0, bellDecay: 0.8, release: 0.6 }),
  preset("Harpsichord", "character", "Plucked strings: bright, thin and baroque", { brightness: 1.0, hammerPosition: 0.04, partials: 16.0, strings: 2.0, detune: 2.0, decay: 3.0, highDamping: 0.1, release: 0.15, velocitySense: 0.2, hammerNoise: 0.25, level: 0.7 }),
  preset("Clavinet", "character", "Struck, damped strings: funky and snappy", { brightness: 0.95, hammerPosition: 0.06, partials: 14.0, strings: 1.0, decay: 1.2, release: 0.05, drive: 0.5, highDamping: 0.2 }),
  preset("Lo-fi Piano", "character", "Dusty, wobbly piano as off a worn cassette", { brightness: 0.4, strings: 2.0, detune: 10.0, decay: 5.0, toneHz: 3000.0, tremoloDepth: 0.15, tremoloRateHz: 0.8, drive: 0.25, width: 0.3 }),
  preset("Ambient Piano", "character", "Slow-blooming piano that hangs in the air", { brightness: 0.35, strings: 3.0, detune: 3.0, decay: 20.0, attack: 0.25, release: 3.0, toneHz: 6000.0, width: 1.0 }),
  preset("Dream Piano", "character", "Piano with a shimmer of bells over it", { brightness: 0.45, strings: 2.0, detune: 4.0, decay: 12.0, bell: 0.3, bellRatio: 8.0, bellDecay: 1.5, release: 1.5, width: 1.0 }),
  preset("Cinematic Piano", "character", "Dark, huge low piano for film scores", { brightness: 0.3, strings: 3.0, detune: 1.5, decay: 24.0, highDamping: 0.8, toneHz: 4500.0, release: 2.0, width: 1.0, partials: 16.0 }),
];

export function keysPreset(name: string): KeysPreset | undefined {
  return KEYS_PRESETS.find((each) => each.name === name);
}

export function keysPresetNames(): string[] {
  return KEYS_PRESETS.map((each) => each.name);
}

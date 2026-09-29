/**
 * The **Pad Controller**'s arithmetic, kept pure so it can be tested without
 * a page: its eight pad modes, the pages of each, and what every one of the
 * sixteen pads does on each page, as a two-deck pad controller for DJ
 * software lays them out. Nothing here touches audio or the engine.
 */
import { BEAT_FX, beatsLabel, HOT_CUE_COLOURS } from "./dj-logic";

/**
 * The pad modes: each PAD MODE button gives the first, and with SHIFT the
 * second.
 */
export type PadMode = "hotCue" | "keyboard" | "padFx1" | "padFx2" | "beatJump" | "beatLoop" | "sampler" | "keyShift";

export const PAD_MODE_BUTTONS: readonly { plain: PadMode; shifted: PadMode }[] = [
  { plain: "hotCue", shifted: "keyboard" },
  { plain: "padFx1", shifted: "padFx2" },
  { plain: "beatJump", shifted: "beatLoop" },
  { plain: "sampler", shifted: "keyShift" },
];

export const PAD_MODE_NAMES: Readonly<Record<PadMode, string>> = {
  hotCue: "HOT CUE",
  keyboard: "KEYBOARD",
  padFx1: "PAD FX 1",
  padFx2: "PAD FX 2",
  beatJump: "BEAT JUMP",
  beatLoop: "BEAT LOOP",
  sampler: "SAMPLER",
  keyShift: "KEY SHIFT",
};

/** Pads on each half: four rows of four, numbered 0 to 15 from the top left. */
export const PADS = 16;

/** A Pad FX: one of the Beat FX, applied at a beat division and level while its pad is held. */
export interface PadFx {
  /** A, B… AF, as the pad is lettered. */
  letter: string;
  /** Its index in the engine's Beat FX list (`BEAT_FX`). */
  type: number;
  /** Beats per step of the effect. */
  beats: number;
  level: number;
}

const fx = (letter: string, id: (typeof BEAT_FX)[number]["id"], beats: number, level = 0.7): PadFx => ({
  letter,
  type: BEAT_FX.findIndex((effect) => effect.id === id),
  beats,
  level,
});

/**
 * The Pad FX, A to P on PAD FX 1 and Q to AF on PAD FX 2. Each is one of the
 * mixer's Beat FX at a beat division: the Mixer page has one Beat FX unit, so
 * a Pad FX takes it over while its pad is held, on the Deck's own channel,
 * and gives it back as the mixer had it when the pad is let go.
 */
export const PAD_FX: readonly PadFx[] = [
  fx("A", "echo", 1 / 2),
  fx("B", "echo", 3 / 4),
  fx("C", "echo", 1),
  fx("D", "delay", 1 / 4),
  fx("E", "roll", 1 / 4, 1),
  fx("F", "roll", 1 / 8, 1),
  fx("G", "roll", 1 / 16, 1),
  fx("H", "roll", 1 / 32, 1),
  fx("I", "reverb", 1, 0.6),
  fx("J", "filter", 4, 0.8),
  fx("K", "flanger", 4),
  fx("L", "phaser", 4),
  fx("M", "trans", 1 / 4, 1),
  fx("N", "trans", 1 / 8, 1),
  fx("O", "vinylBrake", 1, 1),
  fx("P", "spiral", 1 / 2),
  fx("Q", "pingPong", 1 / 2),
  fx("R", "pingPong", 1 / 4),
  fx("S", "delay", 1 / 2),
  fx("T", "delay", 3 / 4),
  fx("U", "slipRoll", 1 / 4, 1),
  fx("V", "slipRoll", 1 / 8, 1),
  fx("W", "slipRoll", 1 / 16, 1),
  fx("X", "helix", 1),
  fx("Y", "pitch", 1 / 2),
  fx("Z", "pitch", 1),
  fx("AA", "filter", 1, 0.8),
  fx("AB", "reverb", 4, 0.8),
  fx("AC", "vinylBrake", 2, 1),
  fx("AD", "vinylBrake", 1 / 2, 1),
  fx("AE", "spiral", 1 / 4),
  fx("AF", "helix", 2),
];

/** How far the FINE Beat Jump moves: a thirty-second of a beat. */
export const FINE_BEATS = 1 / 32;

/** What one pad does, on one page of one mode. */
export type PadAction =
  | { kind: "none" }
  | { kind: "hotCue"; index: number }
  | { kind: "keyboard"; semitones: number }
  | { kind: "keyShift"; semitones: number }
  | { kind: "keySync" }
  | { kind: "keyReset" }
  | { kind: "keyStep"; by: 1 | -1 }
  | { kind: "padFx"; fx: PadFx }
  | { kind: "beatJump"; beats: number; label: string }
  | { kind: "beatLoop"; beats: number; label: string }
  | { kind: "sampler"; pad: number };

const NONE: PadAction = { kind: "none" };

/** The page of each mode a half opens on: Beat Jump's second (1, 2 … 32 bars), Keyboard's and Key Shift's second (±8). */
export const DEFAULT_PAGE: Readonly<Record<PadMode, number>> = {
  hotCue: 0,
  keyboard: 1,
  padFx1: 0,
  padFx2: 0,
  beatJump: 1,
  beatLoop: 0,
  sampler: 0,
  keyShift: 1,
};

type Size = readonly [beats: number, label: string];

/** Beat Jump's three pages, as the pads are printed: pairs of back and forward, two pairs a row. */
const BEAT_JUMP_PAGES: readonly (readonly Size[])[] = [
  [
    [FINE_BEATS, "FINE"],
    [1 / 8, "1/8 beat"],
    [1 / 4, "1/4 beat"],
    [1 / 2, "1/2 beat"],
    [1, "1 beat"],
    [8, "2 bars"],
    [16, "4 bars"],
    [32, "8 bars"],
  ],
  [
    [1, "1 beat"],
    [2, "2 beats"],
    [4, "4 beats"],
    [8, "8 beats"],
    [16, "16 beats"],
    [32, "8 bars"],
    [64, "16 bars"],
    [128, "32 bars"],
  ],
  [
    [16, "16 beats"],
    [32, "32 beats"],
    [64, "64 beats"],
    [128, "128 beats"],
  ],
];

/** Beat Loop's sizes, 1/64 of a beat to 128 bars, as the pads are printed. */
export const BEAT_LOOP_SIZES: readonly Size[] = [
  [1 / 64, "1/64 beat"],
  [1 / 32, "1/32 beat"],
  [1 / 16, "1/16 beat"],
  [1 / 8, "1/8 beat"],
  [1 / 4, "1/4 beat"],
  [1 / 2, "1/2 beat"],
  [1, "1 beat"],
  [2, "2 beats"],
  [4, "4 beats"],
  [8, "8 beats"],
  [16, "16 beats"],
  [32, "8 bars"],
  [64, "16 bars"],
  [128, "32 bars"],
  [256, "64 bars"],
  [512, "128 bars"],
];

type Row = readonly (number | "sync" | "reset" | "up" | "down" | null)[];
/** The keyboard's and Key Shift's five pages, top row first: semitones, or a key control. */
const KEY_PAGES: readonly (readonly Row[])[] = [
  [
    [12, null, null, null],
    [8, 9, 10, 11],
    [4, 5, 6, 7],
    [0, 1, 2, 3],
  ],
  [
    [4, 5, 6, 7],
    [0, 1, 2, 3],
    [-4, -3, -2, -1],
    [-8, -7, -6, -5],
  ],
  [
    [-4, -3, -2, -1],
    [-8, -7, -6, -5],
    [-12, -11, -10, -9],
    [null, null, null, null],
  ],
  [
    [-12, -11, -10, -9],
    [null, null, null, null],
    ["sync", "up", 7, 12],
    ["reset", "down", -5, -12],
  ],
  [
    ["sync", "up", 7, 12],
    ["reset", "down", -5, -12],
    [null, null, null, null],
    [null, null, null, null],
  ],
];

/** How many pages `mode` has. The Sampler's PARAMETER buttons change its bank instead. */
export function pagesOf(mode: PadMode): number {
  switch (mode) {
    case "keyboard":
    case "keyShift":
      return KEY_PAGES.length;
    case "beatJump":
      return BEAT_JUMP_PAGES.length;
    default:
      return 1;
  }
}

/** What pad `pad` (0 to 15) does in `mode` on `page`. */
export function padAction(mode: PadMode, page: number, pad: number): PadAction {
  if (pad < 0 || pad >= PADS) return NONE;
  switch (mode) {
    case "hotCue":
      return { kind: "hotCue", index: pad };
    case "padFx1":
      return { kind: "padFx", fx: PAD_FX[pad]! };
    case "padFx2":
      return { kind: "padFx", fx: PAD_FX[16 + pad]! };
    case "sampler":
      return { kind: "sampler", pad };
    case "beatLoop": {
      const [beats, label] = BEAT_LOOP_SIZES[pad]!;
      return { kind: "beatLoop", beats, label };
    }
    case "beatJump": {
      const sizes = BEAT_JUMP_PAGES[page] ?? BEAT_JUMP_PAGES[1]!;
      const size = sizes[Math.floor(pad / 2)];
      if (size === undefined) return NONE;
      const [beats, label] = size;
      return { kind: "beatJump", beats: pad % 2 === 0 ? -beats : beats, label };
    }
    case "keyboard":
    case "keyShift": {
      const cell = KEY_PAGES[page]?.[Math.floor(pad / 4)]?.[pad % 4] ?? null;
      if (cell === null) return NONE;
      if (cell === "sync") return { kind: "keySync" };
      if (cell === "reset") return { kind: "keyReset" };
      if (cell === "up") return { kind: "keyStep", by: 1 };
      if (cell === "down") return { kind: "keyStep", by: -1 };
      return mode === "keyboard" ? { kind: "keyboard", semitones: cell } : { kind: "keyShift", semitones: cell };
    }
  }
}

const semitonesLabel = (semitones: number) => (semitones === 0 ? "±0" : semitones > 0 ? `+${semitones}` : `−${-semitones}`);

/** What is printed on a pad, short. */
export function padCaption(action: PadAction): string {
  switch (action.kind) {
    case "none":
      return "";
    case "hotCue":
      return HOT_CUE_LETTERS[action.index]!;
    case "keyboard":
    case "keyShift":
      return semitonesLabel(action.semitones);
    case "keySync":
      return "KEY SYNC";
    case "keyReset":
      return "RESET";
    case "keyStep":
      return action.by > 0 ? "UP" : "DOWN";
    case "padFx":
      return `${action.fx.letter} ${BEAT_FX[action.fx.type]!.label.toUpperCase()} ${beatsLabel(action.fx.beats)}`;
    case "beatJump":
      return `${action.beats < 0 ? "◀" : "▶"} ${action.label}`;
    case "beatLoop":
      return action.label;
    case "sampler":
      return `${action.pad + 1}`;
  }
}

/** The sixteen Hot Cues' letters, A to P. */
export const HOT_CUE_LETTERS: readonly string[] = "ABCDEFGHIJKLMNOP".split("");

/** The colours a pad lights in each mode, as DJ software lights a pad controller. */
export const MODE_COLOURS: Readonly<Record<PadMode, string>> = {
  hotCue: HOT_CUE_COLOURS[0]!,
  keyboard: "#b57bff",
  padFx1: "#ff4d6d",
  padFx2: "#ff8a3d",
  beatJump: "#3ddc97",
  beatLoop: "#ffb020",
  sampler: "#4aa8ff",
  keyShift: "#c86bff",
};

/** A second, dimmer shade of `hex` for a pad that is lit but not playing. */
export function dim(hex: string, amount = 0.35): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.round(((value >> shift) & 0xff) * amount);
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`;
}

/** The three SLIDE FX a half's FX 1, 2 and 3 buttons start with, as Beat FX indices. */
export const SLIDE_FX_START: readonly [number, number, number] = [
  BEAT_FX.findIndex((effect) => effect.id === "filter"),
  BEAT_FX.findIndex((effect) => effect.id === "echo"),
  BEAT_FX.findIndex((effect) => effect.id === "reverb"),
];

/** The Deck a half drives: the left one Deck 1 or 3, the right one 2 or 4. */
export function halfDeck(half: 0 | 1, other: boolean): number {
  return half + (other ? 2 : 0);
}

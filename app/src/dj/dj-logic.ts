/**
 * The Mixer page's arithmetic, kept pure so it can be tested without an
 * engine: keys on the Camelot wheel, Beat Grid maths, loop and Beat FX
 * sizes, tap tempo and the readouts a CDJ shows. None of it touches audio.
 */

/** The pitch-class names, as a CDJ shows a key. */
const NOTES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

export interface MusicalKey {
  /** The tonic's pitch class, 0 (C) to 11 (B). */
  tonic: number;
  minor: boolean;
}

const mod = (value: number, by: number) => ((value % by) + by) % by;

/** "Am", "F♯", as a CDJ writes a key. */
export function keyName(key: MusicalKey): string {
  return `${NOTES[mod(key.tonic, 12)]}${key.minor ? "m" : ""}`;
}

/**
 * A key's place on the Camelot wheel: a number 1 to 12 round the circle of
 * fifths, A for a minor key and B for a major one. C major is 8B, A minor
 * 8A.
 */
export function camelot(key: MusicalKey): { number: number; letter: "A" | "B" } {
  // Round the circle of fifths from 8B (C major) and 8A (A minor).
  const fromC = key.minor ? mod(key.tonic - 9, 12) : mod(key.tonic, 12);
  const fifths = mod(fromC * 7, 12);
  return { number: mod(8 - 1 + fifths, 12) + 1, letter: key.minor ? "A" : "B" };
}

export function camelotName(key: MusicalKey): string {
  const { number, letter } = camelot(key);
  return `${number}${letter}`;
}

/** The key `semitones` higher. */
export function shiftKey(key: MusicalKey, semitones: number): MusicalKey {
  return { tonic: mod(key.tonic + Math.round(semitones), 12), minor: key.minor };
}

/**
 * Whether `a` mixes well with `b`: the same key, a step round the Camelot
 * wheel either way (a fifth), or its relative major or minor.
 */
export function compatible(a: MusicalKey, b: MusicalKey): boolean {
  const x = camelot(a);
  const y = camelot(b);
  if (x.letter === y.letter) {
    const apart = mod(x.number - y.number, 12);
    return apart === 0 || apart === 1 || apart === 11;
  }
  return x.number === y.number;
}

/**
 * **Key Sync**: the Key Shift, from -6 to +6 semitones and nearest 0, that
 * brings `key` to one that mixes with `master`, or 0 if it already does or
 * none does.
 */
export function keySyncShift(key: MusicalKey, master: MusicalKey): number {
  for (const distance of [0, 1, 2, 3, 4, 5, 6]) {
    for (const shift of distance === 0 ? [0] : [distance, -distance]) {
      if (compatible(shiftKey(key, shift), master)) return shift;
    }
  }
  return 0;
}

/** Seconds of one beat at `bpm`. */
export function beatSeconds(bpm: number): number {
  return bpm > 0 ? 60 / bpm : 0;
}

/** Where `seconds` is in the Beat Grid's beats, from its first beat: 2.5 is half way through beat 3. */
export function beatAt(seconds: number, bpm: number, firstBeat: number): number {
  const beat = beatSeconds(bpm);
  return beat > 0 ? (seconds - firstBeat) / beat : 0;
}

/** `seconds` moved to the nearest beat of the grid: what **Quantize** does. */
export function quantize(seconds: number, bpm: number, firstBeat: number): number {
  const beat = beatSeconds(bpm);
  if (beat <= 0) return seconds;
  return firstBeat + Math.round((seconds - firstBeat) / beat) * beat;
}

/** Beats (whole, counting down) from `seconds` to `target`, as a CDJ counts to its next cue. */
export function beatsUntil(seconds: number, target: number, bpm: number): number | null {
  const beat = beatSeconds(bpm);
  if (beat <= 0 || target <= seconds) return null;
  return Math.ceil((target - seconds) / beat - 1e-6);
}

/** Bar and beat, counting both from 1, in four-four: "12.3". */
export function barBeat(seconds: number, bpm: number, firstBeat: number): string {
  if (bpm <= 0) return "—";
  const beats = Math.floor(beatAt(seconds, bpm, firstBeat) + 1e-6);
  return `${Math.floor(beats / 4) + 1}.${mod(beats, 4) + 1}`;
}

/** Loop sizes from 1/32 to 512 beats, as the CDJ-3000 offers them. */
export const LOOP_BEATS: readonly number[] = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

/** Beat Jump sizes, in beats. */
export const BEAT_JUMPS: readonly number[] = [1, 4, 16, 32];

/** Beat FX divisions from 1/16 of a beat to 16 bars, in beats. */
export const BEAT_DIVISIONS: readonly number[] = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8, 16, 32, 64];

/** "1/4", "2", "16 bars": a size in beats as the displays write it. */
export function beatsLabel(beats: number): string {
  if (beats >= 8 && beats % 4 === 0) return `${beats / 4} bars`;
  if (beats >= 1) return `${beats}`;
  if (beats === 3 / 4) return "3/4";
  return `1/${Math.round(1 / beats)}`;
}

/** Tempo fader ranges, as fractions: ±6%, ±10%, ±16% and WIDE (±100%). */
export const TEMPO_RANGES = [
  { id: "6", label: "±6%", range: 0.06 },
  { id: "10", label: "±10%", range: 0.1 },
  { id: "16", label: "±16%", range: 0.16 },
  { id: "wide", label: "WIDE", range: 1 },
] as const;

export type TempoRangeId = (typeof TEMPO_RANGES)[number]["id"];

export function tempoRange(id: TempoRangeId): number {
  return TEMPO_RANGES.find((range) => range.id === id)!.range;
}

/** "+2.35%", as a CDJ's tempo readout, to 0.01%. */
export function formatTempo(tempo: number): string {
  const percent = tempo * 100;
  return `${percent >= 0 ? "+" : "−"}${Math.abs(percent).toFixed(2)}%`;
}

/** "3:07.4": minutes, seconds and tenths. */
export function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** "128.00". */
export function formatBpm(bpm: number): string {
  return bpm > 0 ? bpm.toFixed(2) : "—";
}

/** Whether the remaining time should flash: in the last 30 seconds of a track that is playing. */
export function endWarning(position: number, duration: number): boolean {
  return duration > 0 && duration - position <= 30;
}

/**
 * Tap tempo: the BPM of the taps so far, from the average gap between the
 * last eight, or null until there are two. A gap longer than two seconds
 * starts again.
 */
export class TapTempo {
  #taps: number[] = [];

  tap(atMs: number): number | null {
    const last = this.#taps.at(-1);
    if (last !== undefined && atMs - last > 2_000) this.#taps = [];
    this.#taps.push(atMs);
    this.#taps = this.#taps.slice(-8);
    if (this.#taps.length < 2) return null;
    const gap = (this.#taps.at(-1)! - this.#taps[0]!) / (this.#taps.length - 1);
    return gap > 0 ? Math.round((60_000 / gap) * 100) / 100 : null;
  }
}

/** The eight Hot Cues' colours, A to H, as the CDJ-3000 lights them. */
export const HOT_CUE_COLOURS: readonly string[] = [
  "#3ddc97",
  "#ff5c8a",
  "#ffb020",
  "#4aa8ff",
  "#b57bff",
  "#ff7a3d",
  "#2ee6e6",
  "#f5e642",
];

export const HOT_CUE_NAMES: readonly string[] = ["A", "B", "C", "D", "E", "F", "G", "H"];

/** A Hot Cue the DJ has set: where, in seconds, and what it is called. */
export interface HotCue {
  seconds: number;
  label: string;
  colour: string;
}

/** Channel fader curves, in the order the engine numbers them. */
export const FADER_CURVES = ["Smooth", "Linear", "Sharp"] as const;
/** Crossfader curves, in the order the engine numbers them. */
export const CROSSFADER_CURVES = ["Smooth", "Constant power", "Sharp cut"] as const;
/** Crossfader assigns, in the order the engine numbers them. */
export const ASSIGNS = ["A", "THRU", "B"] as const;

/** The Colour FX, as the engine lists them, with their names on the mixer. */
export const COLOUR_FX = [
  { id: "space", label: "Space" },
  { id: "dubEcho", label: "Dub Echo" },
  { id: "sweep", label: "Sweep" },
  { id: "noise", label: "Noise" },
  { id: "crush", label: "Crush" },
  { id: "filter", label: "Filter" },
] as const;

/** The Beat FX, as the engine lists them, with their names on the mixer. */
export const BEAT_FX = [
  { id: "delay", label: "Delay" },
  { id: "echo", label: "Echo" },
  { id: "pingPong", label: "Ping Pong" },
  { id: "spiral", label: "Spiral" },
  { id: "reverb", label: "Reverb" },
  { id: "trans", label: "Trans" },
  { id: "filter", label: "Filter" },
  { id: "flanger", label: "Flanger" },
  { id: "phaser", label: "Phaser" },
  { id: "pitch", label: "Pitch" },
  { id: "slipRoll", label: "Slip Roll" },
  { id: "roll", label: "Roll" },
  { id: "vinylBrake", label: "Vinyl Brake" },
  { id: "helix", label: "Helix" },
] as const;

/** Where the Beat FX goes, in the order the engine numbers them. */
export const BEAT_FX_TARGETS = ["CH1", "CH2", "CH3", "CH4", "XF-A", "XF-B", "MASTER"] as const;

/** The level a meter shows, 0 to 1, on a scale from -48 dB to 0 dB. */
export function meterFraction(level: number): number {
  if (level <= 0) return 0;
  const db = 20 * Math.log10(level);
  return Math.min(1, Math.max(0, (db + 48) / 48));
}

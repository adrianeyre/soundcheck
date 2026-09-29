/**
 * The DJ Mixer's report, as the engine lays it out (`DjMixer::report` in
 * `engine/src/dj/mod.rs`): `GLOBAL_FIELDS` numbers for the mixer, then
 * `DECK_FIELDS` for each of the `DECKS` Decks, then `SAMPLER_FIELDS` for the
 * Sampler, then `TIMECODE_FIELDS` for each Deck's timecode vinyl. A test
 * checks the lengths against the engine's own.
 */

export const DECKS = 4;
export const GLOBAL_FIELDS = 8;
export const DECK_FIELDS = 26;
/** Sampler Slots in a bank, and banks: 64 slots in all. */
export const SAMPLER_BANK_SLOTS = 16;
export const SAMPLER_BANKS = 4;
export const SAMPLER_SLOTS = SAMPLER_BANK_SLOTS * SAMPLER_BANKS;
export const SAMPLER_FIELDS = 4 + SAMPLER_SLOTS;
/** Each Deck's mode, signal, the record's speed and position, the carrier, the format chosen and whether ABS is ready. */
export const TIMECODE_FIELDS = 7;
export const DJ_REPORT_LEN = GLOBAL_FIELDS + DECKS * DECK_FIELDS + SAMPLER_FIELDS + DECKS * TIMECODE_FIELDS;

/**
 * Who moves a Deck (a DVS's control modes): `int` it plays the file itself;
 * `rel` the timecode vinyl's speed and direction move it; `abs` the vinyl's
 * position places it too.
 */
export type DeckMode = "int" | "rel" | "abs";
export const DECK_MODES: readonly DeckMode[] = ["int", "rel", "abs"];

/** A Deck's timecode vinyl, as its decoder last read it. */
export interface TimecodeReport {
  /** A needle on a turning record. */
  signal: boolean;
  /** 1 is the record's nominal speed (33⅓ rpm); negative is backwards. */
  speed: number;
  /** Seconds into the record, once its position has been read (ABS), or null. */
  position: number | null;
  /** The carrier measured against, in Hz: the format's, or the one Auto found. */
  carrier: number;
  /** The format chosen: 0 Auto, then `TIMECODE_FORMATS` from 1. */
  format: number;
  /** Whether it can read positions, so ABS works. */
  absReady: boolean;
}

/** Where a Sampler Slot is: `SlotState` in `engine/src/dj/sampler.rs`. */
export type SlotState = "empty" | "stopped" | "playing" | "paused";
const SLOT_STATES: readonly SlotState[] = ["empty", "stopped", "playing", "paused"];

export interface SamplerReport {
  /** The Sampler's meter, 1 is full scale. */
  level: number;
  gain: number;
  cue: boolean;
  /** What a recording takes: the whole Master, or the Sampler alone. */
  recordSource: "master" | "sampler";
  slots: SlotState[];
}

/** One Deck, as the engine last reported it. Times are seconds into the file. */
export interface DeckReport {
  loaded: boolean;
  playing: boolean;
  position: number;
  duration: number;
  /** The Beat Grid's BPM at the file's own speed; 0 with none. */
  bpm: number;
  /** BPM as it plays now, after the tempo fader or Sync. */
  effectiveBpm: number;
  /** Its speed: 1 is the file's own. */
  rate: number;
  loop: { start: number; end: number } | null;
  cue: number;
  /** Where Slip will return to, while it is slipping. */
  slipPosition: number | null;
  reverse: boolean;
  slip: boolean;
  masterTempo: boolean;
  keyShift: number;
  sync: boolean;
  firstBeat: number;
  /** The channel's level before its fader, 1 is full scale. */
  level: number;
  /** The platter's speed, signed. */
  speed: number;
  previewing: boolean;
  quantize: boolean;
  /** How far the channel's compressor is pulling it down, in dB. */
  gainReduction: number;
  /** The tempo fader: 0.05 is +5%. */
  tempo: number;
  /** Silent Cue: playing on, muted, until a Hot Cue is called. */
  silent: boolean;
  /** Slip Reverse held (or running out its 8 beats). */
  slipReverse: boolean;
  /** INT, REL or ABS. */
  mode: DeckMode;
  timecode: TimecodeReport;
}

export interface DjReport {
  /** The Master's meter, left and right. */
  master: [number, number];
  /** The Deck the others Sync to, or null. */
  syncMaster: number | null;
  /** The BPM the Beat FX follow. */
  masterBpm: number;
  recordingSeconds: number;
  recording: boolean;
  beatFx: { type: number; on: boolean };
  decks: DeckReport[];
  sampler: SamplerReport;
}

const EMPTY_DECK: DeckReport = {
  loaded: false,
  playing: false,
  position: 0,
  duration: 0,
  bpm: 0,
  effectiveBpm: 0,
  rate: 1,
  loop: null,
  cue: 0,
  slipPosition: null,
  reverse: false,
  slip: false,
  masterTempo: false,
  keyShift: 0,
  sync: false,
  firstBeat: 0,
  level: 0,
  speed: 0,
  previewing: false,
  quantize: true,
  gainReduction: 0,
  tempo: 0,
  silent: false,
  slipReverse: false,
  mode: "int",
  timecode: { signal: false, speed: 0, position: null, carrier: 1000, format: 0, absReady: false },
};

/** What the page shows before the engine has reported. */
export const EMPTY_REPORT: DjReport = {
  master: [0, 0],
  syncMaster: null,
  masterBpm: 120,
  recordingSeconds: 0,
  recording: false,
  beatFx: { type: 0, on: false },
  decks: Array.from({ length: DECKS }, () => EMPTY_DECK),
  sampler: {
    level: 0,
    gain: 1,
    cue: false,
    recordSource: "master",
    slots: Array.from({ length: SAMPLER_SLOTS }, () => "empty"),
  },
};

/** Read the engine's flat report; null (or too short) is the empty one. */
export function readDjReport(flat: readonly number[] | null | undefined): DjReport {
  if (!flat || flat.length < DJ_REPORT_LEN) return EMPTY_REPORT;
  const at = (index: number) => flat[index] ?? 0;
  const flag = (index: number) => at(index) >= 0.5;
  return {
    master: [at(0), at(1)],
    syncMaster: at(2) >= 0 ? at(2) : null,
    masterBpm: at(3),
    recordingSeconds: at(4),
    recording: flag(5),
    beatFx: { type: at(6), on: flag(7) },
    decks: Array.from({ length: DECKS }, (_, deck) => {
      const f = (field: number) => at(GLOBAL_FIELDS + deck * DECK_FIELDS + field);
      const on = (field: number) => f(field) >= 0.5;
      const t = (field: number) => at(GLOBAL_FIELDS + DECKS * DECK_FIELDS + SAMPLER_FIELDS + deck * TIMECODE_FIELDS + field);
      return {
        loaded: on(0),
        playing: on(1),
        position: f(2),
        duration: f(3),
        bpm: f(4),
        effectiveBpm: f(5),
        rate: f(6),
        loop: on(7) ? { start: f(8), end: f(9) } : null,
        cue: f(10),
        slipPosition: f(11) >= 0 ? f(11) : null,
        reverse: on(12),
        slip: on(13),
        masterTempo: on(14),
        keyShift: f(15),
        sync: on(16),
        firstBeat: f(17),
        level: f(18),
        speed: f(19),
        previewing: on(20),
        quantize: on(21),
        gainReduction: f(22),
        tempo: f(23),
        silent: on(24),
        slipReverse: on(25),
        mode: DECK_MODES[Math.round(t(0))] ?? "int",
        timecode: {
          signal: t(1) >= 0.5,
          speed: t(2),
          position: t(3) >= 0 ? t(3) : null,
          carrier: t(4),
          format: Math.round(t(5)),
          absReady: t(6) >= 0.5,
        },
      };
    }),
    sampler: (() => {
      const base = GLOBAL_FIELDS + DECKS * DECK_FIELDS;
      return {
        level: at(base),
        gain: at(base + 1),
        cue: flag(base + 2),
        recordSource: at(base + 3) >= 0.5 ? "sampler" : "master",
        slots: Array.from({ length: SAMPLER_SLOTS }, (_, slot) => SLOT_STATES[Math.round(at(base + 4 + slot))] ?? "empty"),
      };
    })(),
  };
}

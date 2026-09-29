/**
 * Timecode vinyl for the Mixer page's Decks: a DVS (ADR 0013). A Deck in REL
 * or ABS is moved by a turntable playing a control record, whose stereo
 * pilot tone reaches the engine through an audio input, a pair of its
 * channels for each Deck. The engine decodes it (`engine/src/dj/timecode.rs`);
 * this is where the DJ chooses which input and which record, and where the
 * choice is kept. `platform.ts` picks the platform's input:
 *
 * - Desktop: the shell opens a cpal input stream per device and hands each
 *   Deck its pair on the audio thread (`desktop/src/timecode.rs`).
 * - Browser: none yet. getUserMedia into the worklet would be its version, as
 *   for recording; the Settings page lists it as the Desktop App's.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { InputDevice } from "../audio/audio-input";
import type { AudioOutput } from "../audio/audio-output";
import type { Invoke } from "../audio/desktop-audio-output";
import { readLocal, writeLocal } from "../settings/local-settings";
import { DECKS, type DeckMode } from "./dj-report";

/**
 * The records a Deck can read, in the order the engine's `timecodeFormat`
 * numbers them from 1 (0 is Auto). Mirrors `TIMECODE_FORMATS` in
 * `engine/src/dj/timecode.rs`, and a test holds them together.
 */
export const TIMECODE_FORMATS: readonly { id: string; label: string; carrier: number }[] = [
  { id: "serato2a", label: "Serato CV02, side A", carrier: 1000 },
  { id: "serato2b", label: "Serato CV02, side B", carrier: 1000 },
  { id: "seratoCd", label: "Serato control CD", carrier: 1000 },
  { id: "traktorA", label: "Traktor Scratch, side A", carrier: 2000 },
  { id: "traktorB", label: "Traktor Scratch, side B", carrier: 2000 },
  { id: "mixvibesV2", label: "MixVibes V2", carrier: 1300 },
  { id: "mixvibes7", label: 'MixVibes 7"', carrier: 1300 },
  { id: "rekordboxA", label: "rekordbox Control Vinyl, side A", carrier: 1000 },
  { id: "rekordboxB", label: "rekordbox Control Vinyl, side B", carrier: 1000 },
];

export const MODE_VALUE: Record<DeckMode, number> = { int: 0, rel: 1, abs: 2 };

/** Which input a Deck's record comes in on. `TimecodeChoice` in `desktop/src/timecode.rs`. */
export interface TimecodeChoice {
  deck: number;
  device: string;
  /** Input channels, from 0. */
  left: number;
  right: number;
}

/** What the inputs are doing. `TimecodeStatus` in `desktop/src/timecode.rs`. */
export interface TimecodeStatus {
  choices: TimecodeChoice[];
  /** The devices open now. */
  running: string[];
  /** Why a device couldn't be opened, or stopped. */
  failed: string | null;
}

export interface TimecodeInput {
  /** The input devices a record can come in on, with their channel counts. */
  listDevices(): Promise<InputDevice[]>;
  /** Read each Deck's record from the input it names; the rest have none. */
  choose(choices: TimecodeChoice[]): Promise<TimecodeStatus>;
  status(): Promise<TimecodeStatus>;
}

export function desktopTimecodeInput(invoke: Invoke): TimecodeInput {
  return {
    listDevices: () => invoke<InputDevice[]>("timecode_devices"),
    choose: (choices) => invoke<TimecodeStatus>("timecode_choose", { choices }),
    status: () => invoke<TimecodeStatus>("timecode_input_status"),
  };
}

/** One Deck's timecode setup, as it is kept. */
export interface DeckTimecode {
  /** The input device, by name, or null for none. */
  device: string | null;
  /** The first of the pair's two input channels, from 0: 0 is inputs 1 and 2. */
  left: number;
  /** 0 Auto, then `TIMECODE_FORMATS` from 1. */
  format: number;
  /** The input's left and right are the other way round. */
  swap: boolean;
  /** The input's right channel is upside down. */
  invert: boolean;
}

/** Where the choices are remembered on this machine, beside the headphone device's. */
export const TIMECODE_KEY = "soundcheck.dj.timecode";

/** Deck 1 on inputs 1 and 2, Deck 2 on 3 and 4, and on, as a DJ interface numbers them. */
export const defaultTimecode = (deck: number): DeckTimecode => ({ device: null, left: deck * 2, format: 0, swap: false, invert: false });

/** `value` if it is a whole number from 0 to `max`, `otherwise` if not. */
const whole = (value: unknown, max: number, otherwise: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : otherwise;

export function readTimecodeSetup(): DeckTimecode[] {
  let kept: unknown = null;
  try {
    kept = JSON.parse(readLocal(TIMECODE_KEY) || "null");
  } catch {
    kept = null;
  }
  return Array.from({ length: DECKS }, (_, deck) => {
    const fallback = defaultTimecode(deck);
    const one = Array.isArray(kept) ? (kept[deck] as Partial<DeckTimecode> | undefined) : undefined;
    if (!one || typeof one !== "object") return fallback;
    return {
      device: typeof one.device === "string" && one.device !== "" ? one.device : null,
      left: whole(one.left, 62, fallback.left),
      format: whole(one.format, TIMECODE_FORMATS.length, 0),
      swap: one.swap === true,
      invert: one.invert === true,
    };
  });
}

export function writeTimecodeSetup(setup: readonly DeckTimecode[]) {
  writeLocal(TIMECODE_KEY, JSON.stringify(setup));
}

/** The inputs to open: each Deck with a device. */
export function choicesOf(setup: readonly DeckTimecode[]): TimecodeChoice[] {
  return setup.flatMap((one, deck) => (one.device ? [{ deck, device: one.device, left: one.left, right: one.left + 1 }] : []));
}

/** The engine's controls for a Deck's setup. */
export function deckSettings(deck: number, one: DeckTimecode) {
  return [
    { kind: "deck" as const, index: deck, name: "timecodeFormat", value: one.format },
    { kind: "deck" as const, index: deck, name: "timecodeSwap", value: one.swap ? 1 : 0 },
    { kind: "deck" as const, index: deck, name: "timecodeInvert", value: one.invert ? 1 : 0 },
  ];
}

/** The name of a Deck's input pair: "Inputs 3-4". */
export const pairName = (left: number) => `Inputs ${left + 1}-${left + 2}`;

/** What the Decks' timecode vinyl is, and how to change it. */
export interface TimecodeControls {
  /** Whether this platform can take a timecode input at all. */
  available: boolean;
  setup: DeckTimecode[];
  devices: InputDevice[];
  status: TimecodeStatus | null;
  /** List the input devices again. */
  refresh: () => void;
  change: (deck: number, change: Partial<DeckTimecode>) => void;
  /** Turn a Deck to INT, REL or ABS. */
  setMode: (deck: number, mode: DeckMode) => void;
}

export interface UseTimecodeProps {
  output: AudioOutput | null;
  input: TimecodeInput | null;
  /** Each Deck's mode as the engine last reported it, to tell a new engine again. */
  modes: readonly DeckMode[];
}

/**
 * The Decks' timecode setup for the session: the choices kept on this
 * machine, told to each new engine (the record each Deck reads, and the mode
 * each was in) and to the platform's input.
 */
export function useTimecode({ output, input, modes }: UseTimecodeProps): TimecodeControls {
  const [setup, setSetup] = useState<DeckTimecode[]>(readTimecodeSetup);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [status, setStatus] = useState<TimecodeStatus | null>(null);
  const latest = useRef({ setup, modes });
  useEffect(() => {
    latest.current = { setup, modes };
  });

  const refresh = useCallback(() => {
    if (!input) return;
    void input
      .listDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, [input]);

  // A new output is a fresh engine: tell it each Deck's record and mode, and open the inputs again.
  useEffect(() => {
    if (!output) return;
    const { setup: now, modes: were } = latest.current;
    now.forEach((one, deck) => {
      for (const setting of deckSettings(deck, one)) output.send({ type: "djSet", ...setting });
    });
    were.forEach((mode, deck) => {
      if (mode !== "int") output.send({ type: "djSet", kind: "deck", index: deck, name: "mode", value: MODE_VALUE[mode] });
    });
    if (!input) return;
    let live = true;
    refresh();
    void input
      .choose(choicesOf(now))
      .then((next) => live && setStatus(next))
      .catch((reason) => live && setStatus({ choices: [], running: [], failed: String(reason) }));
    return () => {
      live = false;
    };
  }, [output, input, refresh]);

  // A device unplugged is noticed on the next look.
  const chosen = choicesOf(setup).length > 0;
  useEffect(() => {
    if (!input || !output || !chosen) return;
    const timer = setInterval(() => void input.status().then(setStatus), 2_000);
    return () => clearInterval(timer);
  }, [input, output, chosen]);

  const change = (deck: number, changed: Partial<DeckTimecode>) => {
    const before = setup[deck];
    if (!before) return;
    const after = { ...before, ...changed };
    const next = setup.map((one, at) => (at === deck ? after : one));
    setSetup(next);
    writeTimecodeSetup(next);
    const was = deckSettings(deck, before);
    deckSettings(deck, after).forEach((setting, at) => {
      if (was[at]?.value !== setting.value) output?.send({ type: "djSet", ...setting });
    });
    if (input && (before.device !== after.device || before.left !== after.left)) {
      void input
        .choose(choicesOf(next))
        .then(setStatus)
        .catch((reason) => setStatus({ choices: [], running: [], failed: String(reason) }));
    }
  };

  const setMode = (deck: number, mode: DeckMode) =>
    output?.send({ type: "djSet", kind: "deck", index: deck, name: "mode", value: MODE_VALUE[mode] });

  return { available: input !== null, setup, devices, status, refresh, change, setMode };
}

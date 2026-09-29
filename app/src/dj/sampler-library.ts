/**
 * The **Sampler**'s slots, kept between sessions.
 *
 * Unlike the rest of the Mixer page's session (ADR 0013), what the DJ puts in
 * the Sampler Slots is kept: it is their instrument, set up once and played
 * in every set. It lives in the app-level library, outside any Project, as a
 * saved Kit does (`kit-library.ts`): `dj-sampler/sampler.json` holds each
 * slot's name, how it plays and its level, and `dj-sampler/audio/` a copy of
 * every sample the DJ loaded, so nothing depends on the file it came from. A
 * slot playing one of the bundled Starter Kit's sounds keeps only which one:
 * the sound ships with the app.
 *
 * With nothing saved yet, the first bank holds sixteen of the Starter Kit's
 * sounds and the second the other six, so the Sampler plays out of the box.
 */
import type { LibraryStorage } from "../preset/library-storage";
import { SAMPLER_SLOTS } from "./dj-report";

/** How a slot plays, as the engine numbers it (`SlotMode`). */
export type SlotMode = 0 | 1 | 2;
export const SLOT_MODES: readonly { mode: SlotMode; label: string; caption: string }[] = [
  { mode: 0, label: "One-shot: plays once through on each press", caption: "ONE SHOT" },
  { mode: 1, label: "Gate: plays while the pad is held", caption: "GATE" },
  { mode: 2, label: "Loop: plays round until stopped", caption: "LOOP" },
];

/** What one Sampler Slot holds. */
export interface SamplerSlot {
  name: string;
  /** The sample file's bytes: WAV, FLAC or MP3. */
  bytes: Uint8Array;
  mode: SlotMode;
  /** The slot's own level, 1 is unity. */
  gain: number;
  /** Which of the bundled Starter Kit's sounds it is, when it is one. */
  bundled?: number;
}

export interface SamplerSetup {
  slots: (SamplerSlot | null)[];
  /** The Sampler Gain. */
  gain: number;
}

/** A bundled sound's bytes and name by its index in the Starter Kit, or null past its end. */
export type BundledSound = (index: number) => { name: string; bytes: Uint8Array } | null;

const FOLDER = "dj-sampler";
const FILE = `${FOLDER}/sampler.json`;
const FILE_VERSION = 1;

/** Where a loaded slot's sample is kept in the library. */
export const slotAudioPath = (slot: number) => `${FOLDER}/audio/slot-${slot}`;

/** The Sampler as it first opens: the Starter Kit across the first bank and into the second. */
export function defaultSampler(bundled: BundledSound): SamplerSetup {
  const slots = Array.from({ length: SAMPLER_SLOTS }, (_, slot): SamplerSlot | null => {
    const sound = bundled(slot);
    return sound ? { name: sound.name, bytes: sound.bytes, mode: 0, gain: 1, bundled: slot } : null;
  });
  return { slots, gain: 1 };
}

interface SavedSlot {
  slot: number;
  name: string;
  mode: SlotMode;
  gain: number;
  bundled?: number;
}

const isMode = (value: unknown): value is SlotMode => value === 0 || value === 1 || value === 2;
const level = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 1);

/**
 * The Sampler as it was saved, or null if it never was (or can't be read,
 * when it starts afresh). A slot whose sample has gone from the library is
 * left empty rather than stopping the rest.
 */
export async function readSampler(storage: LibraryStorage, bundled: BundledSound): Promise<SamplerSetup | null> {
  let text: string;
  try {
    text = await storage.readText(FILE);
  } catch {
    return null;
  }
  let saved: { version?: unknown; gain?: unknown; slots?: unknown };
  try {
    saved = JSON.parse(text) as typeof saved;
  } catch {
    return null;
  }
  if (saved.version !== FILE_VERSION || !Array.isArray(saved.slots)) return null;
  const slots: (SamplerSlot | null)[] = Array.from({ length: SAMPLER_SLOTS }, () => null);
  await Promise.all(
    (saved.slots as Partial<SavedSlot>[]).map(async (entry) => {
      const slot = entry.slot;
      if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= SAMPLER_SLOTS) return;
      const name = typeof entry.name === "string" && entry.name.trim() ? entry.name : `Slot ${slot + 1}`;
      const mode = isMode(entry.mode) ? entry.mode : 0;
      const gain = level(entry.gain);
      if (typeof entry.bundled === "number") {
        const sound = bundled(entry.bundled);
        if (sound) slots[slot] = { name, bytes: sound.bytes, mode, gain, bundled: entry.bundled };
        return;
      }
      try {
        slots[slot] = { name, bytes: await storage.readBytes(slotAudioPath(slot)), mode, gain };
      } catch {
        slots[slot] = null;
      }
    }),
  );
  return { slots, gain: level(saved.gain) };
}

/**
 * Keep the Sampler as it is now. Only the slots in `changed` have their
 * samples written (or, emptied, deleted), so a change of name, mode or level
 * rewrites only the small file.
 */
export async function writeSampler(storage: LibraryStorage, setup: SamplerSetup, changed: Iterable<number>): Promise<void> {
  for (const slot of changed) {
    const held = setup.slots[slot];
    if (held && held.bundled === undefined) await storage.writeBytes(slotAudioPath(slot), held.bytes);
    else await storage.deleteFile(slotAudioPath(slot));
  }
  const slots: SavedSlot[] = [];
  setup.slots.forEach((held, slot) => {
    if (!held) return;
    slots.push({ slot, name: held.name, mode: held.mode, gain: held.gain, ...(held.bundled !== undefined && { bundled: held.bundled }) });
  });
  await storage.writeText(FILE, JSON.stringify({ version: FILE_VERSION, gain: setup.gain, slots }, null, 2));
}

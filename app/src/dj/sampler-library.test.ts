import { expect, test } from "vitest";

import { memoryLibraryStorage } from "../preset/library-storage";
import { SAMPLER_SLOTS } from "./dj-report";
import { defaultSampler, readSampler, type SamplerSetup, slotAudioPath, writeSampler } from "./sampler-library";

const bundled = (index: number) => (index < 22 ? { name: `Sound ${index + 1}`, bytes: new Uint8Array([index]) } : null);

test("a slot's pitch, sync and BPM are kept and read back", async () => {
  const storage = memoryLibraryStorage();
  const setup: SamplerSetup = defaultSampler(bundled);
  setup.slots[0] = { name: "Loop", bytes: new Uint8Array([7, 7]), mode: 2, gain: 0.8, pitch: -3.25, sync: true, bpm: 124 };
  setup.slots[1] = { ...setup.slots[1]!, pitch: 12, sync: false };
  await writeSampler(storage, setup, [0]);

  const saved = await readSampler(storage, bundled);
  expect(saved?.slots[0]).toEqual({ name: "Loop", bytes: new Uint8Array([7, 7]), mode: 2, gain: 0.8, pitch: -3.25, sync: true, bpm: 124 });
  expect(saved?.slots[1]).toMatchObject({ bundled: 1, pitch: 12, sync: false });
  expect(saved?.slots[1]?.bpm).toBeUndefined();
});

test("slots saved before they had a pitch and sync open at pitch 0, not synced, their BPM to be found", async () => {
  const files = new Map<string, string | Uint8Array>();
  files.set(
    "dj-sampler/sampler.json",
    JSON.stringify({
      version: 1,
      gain: 1.2,
      slots: [
        { slot: 0, name: "Horn", mode: 1, gain: 0.5 },
        { slot: 3, name: "Kick", mode: 0, gain: 1, bundled: 0 },
        // Nonsense from a hand-edited file is put right, not trusted.
        { slot: 4, name: "Odd", mode: 0, gain: 1, pitch: 40, sync: "yes", bpm: -5, bundled: 1 },
      ],
    }),
  );
  files.set(slotAudioPath(0), new Uint8Array([1, 2]));
  const saved = await readSampler(memoryLibraryStorage(files), bundled);
  expect(saved?.slots).toHaveLength(SAMPLER_SLOTS);
  expect(saved?.slots[0]).toEqual({ name: "Horn", bytes: new Uint8Array([1, 2]), mode: 1, gain: 0.5, pitch: 0, sync: false });
  expect(saved?.slots[3]).toMatchObject({ bundled: 0, pitch: 0, sync: false });
  expect(saved?.slots[4]).toMatchObject({ pitch: 12, sync: false });
  expect(saved?.slots[4]?.bpm).toBeUndefined();
  expect(saved?.gain).toBe(1.2);
});

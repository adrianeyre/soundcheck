import { readFileSync } from "node:fs";

import { initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import { readAudioFile, WAVEFORM_POINTS } from "./import-audio";
import { stereoWav } from "./test-wav";

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

/** The engine's own test tone: a quarter of a second, 0.5 at its loudest. */
function fixture(name: string): File {
  const bytes = readFileSync(new URL(`../../../engine/tests/fixtures/${name}`, import.meta.url));
  return new File([bytes], name);
}

test.each(["tone.wav", "tone.flac", "tone.mp3"])("%s imports with its length and waveform", async (name) => {
  const imported = await readAudioFile(fixture(name));
  expect(imported.sample.name).toBe(name);
  expect(imported.sample.bytes.length).toBe(fixture(name).size);
  // An MP3 carries its encoder's delay and padding, so runs a little long.
  expect(imported.waveform.seconds).toBeGreaterThanOrEqual(0.25 - 1e-6);
  expect(imported.waveform.seconds).toBeLessThan(0.35);
  expect(imported.waveform.peaks).toHaveLength(WAVEFORM_POINTS);
  expect(Math.max(...imported.waveform.peaks)).toBeCloseTo(0.5, 1);
});

test("a file the engine can't decode says so, and imports nothing", async () => {
  await expect(readAudioFile(new File(["hello"], "notes.txt"))).rejects.toThrow(/notes\.txt can't be imported/);
});

test("a second of silence then a second of sound draws that way", async () => {
  const left = Array.from({ length: 96_000 }, (_, i) => (i < 48_000 ? 0 : 0.8));
  const imported = await readAudioFile(new File([Uint8Array.from(stereoWav(left, left, 48_000))], "half.wav"));
  expect(imported.waveform.seconds).toBe(2);
  expect(imported.waveform.peaks[0]).toBe(0);
  expect(imported.waveform.peaks.at(-1)).toBeCloseTo(0.8, 3);
});

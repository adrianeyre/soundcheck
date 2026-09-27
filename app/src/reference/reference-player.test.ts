import { readFileSync } from "node:fs";

import { initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import type { Invoke } from "../audio/desktop-audio-output";
import { stereoWav } from "../song/test-wav";
import { desktopReferencePlayer } from "./desktop-reference-player";
import { matchedGain, measureReference } from "./reference-player";

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

const tone = (level: number) => Array.from({ length: 24_000 }, (_, i) => level * Math.sin((2 * Math.PI * 1_000 * i) / 48_000));

test("matching loudness turns a louder reference down to the mix, and never turns one up", () => {
  expect(matchedGain(-14, -8)).toBeCloseTo(10 ** (-6 / 20));
  expect(matchedGain(-8, -14)).toBe(1);
  expect(matchedGain(null, -8)).toBe(1);
  expect(matchedGain(-14, null)).toBe(1);
});

test("the whole reference is measured as a render is, and once", async () => {
  const sample = { name: "finished.wav", bytes: stereoWav(tone(0.5), tone(0.5), 48_000) };
  const measurements = JSON.parse(await measureReference(sample)) as { source: string; loudness: { integrated_lufs: number } };
  expect(measurements.source).toBe("file");
  expect(measurements.loudness.integrated_lufs).toBeCloseTo(-6, 0);
  sample.bytes = [];
  expect(JSON.parse(await measureReference(sample))).toEqual(measurements);
  await expect(measureReference({ name: "notes.txt", bytes: [1, 2, 3] })).rejects.toThrow(/notes.txt can't be measured/);
});

test("on the desktop the shell chooses and reads the file, and auditions it at the gain given", async () => {
  const calls: [string, unknown][] = [];
  const invoke = ((command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    return Promise.resolve(command === "reference_choose_file" ? { name: "finished.wav", bytes: [82, 73] } : null);
  }) as Invoke;
  const player = desktopReferencePlayer(invoke);
  const chosen = await player.chooseFile();
  expect(chosen).toEqual({ name: "finished.wav", bytes: [82, 73] });
  await player.audition(chosen!, 0.5);
  await player.stopAudition();
  expect(calls).toEqual([
    ["reference_choose_file", undefined],
    ["audio_audition_reference", { bytes: [82, 73], gain: 0.5 }],
    ["audio_audition_stop", undefined],
  ]);
});

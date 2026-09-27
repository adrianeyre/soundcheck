import { expect, test } from "vitest";

import { FAKE_REFUSAL, fakeStemSeparator } from "./fake-stem-separator";
import { STEM_NAMES, unavailableStemSeparator } from "./stem-separator";

const audio = new Uint8Array([1, 2, 3]);
const running = () => ({ onProgress: () => {}, signal: new AbortController().signal });

test("the fake installs htdemucs.onnx and refuses any other file with a reason", async () => {
  const separator = fakeStemSeparator({ chosen: "C:/Music/song.wav" });
  expect(await separator.status()).toEqual({ kind: "notInstalled" });
  await expect(separator.installModel((await separator.chooseModelFile())!)).rejects.toThrow(FAKE_REFUSAL);
  await expect(separator.separate(audio, running())).rejects.toThrow("isn't installed");

  await separator.installModel({ label: "C:/Models/htdemucs.onnx" });
  expect(await separator.status()).toEqual({ kind: "installed" });
  expect(separator.installs).toEqual(["C:/Models/htdemucs.onnx"]);
});

test("the fake separates into four Stems, progress rising from 0 to 1", async () => {
  const separator = fakeStemSeparator({ installed: true, stem: (_, name) => new TextEncoder().encode(name) });
  const reports: number[] = [];
  const stems = await separator.separate(audio, { onProgress: (p) => reports.push(p), signal: new AbortController().signal });
  expect(stems?.map(({ name }) => name)).toEqual(STEM_NAMES);
  expect(new TextDecoder().decode(stems?.[3]?.wav)).toBe("vocals");
  expect(reports).toEqual([0, 0.25, 0.5, 0.75, 1]);
  expect(separator.separations).toEqual([audio]);
});

test("the fake runs one separation at a time, and cancelling returns nothing", async () => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const separator = fakeStemSeparator({ installed: true, between: () => held });
  const abort = new AbortController();
  const first = separator.separate(audio, { onProgress: () => {}, signal: abort.signal });
  await expect(separator.separate(audio, running())).rejects.toThrow("already running");
  abort.abort();
  release();
  expect(await first).toBeNull();
  // Once it has stopped, the next may run.
  expect(await separator.separate(audio, running())).toHaveLength(4);
});

test("where there is no separation, it says why and refuses everything", async () => {
  const separator = unavailableStemSeparator("Not in the browser.");
  expect(await separator.status()).toEqual({ kind: "unavailable", reason: "Not in the browser." });
  await expect(separator.chooseModelFile()).rejects.toThrow("Not in the browser.");
  await expect(separator.installModel({ label: "htdemucs.onnx" })).rejects.toThrow("Not in the browser.");
  await expect(separator.separate(audio, running())).rejects.toThrow("Not in the browser.");
});

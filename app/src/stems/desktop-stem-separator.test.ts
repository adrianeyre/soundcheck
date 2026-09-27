import { afterEach, expect, test, vi } from "vitest";

import type { Invoke } from "../audio/desktop-audio-output";
import { desktopStemSeparator, PROGRESS_MS } from "./desktop-stem-separator";
import { STEM_NAMES } from "./stem-separator";

afterEach(() => {
  vi.useRealTimers();
});

const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);

/** The Tauri side, answering as `desktop/src/lib.rs` does. */
function fakeInvoke({
  installed = false,
  chosen = "C:/Models/htdemucs.onnx" as string | null,
  found = null as string | null,
} = {}) {
  const calls: [string, unknown][] = [];
  let finish: ((names: string[] | null) => void) | null = null;
  let progress = 0;
  const invoke = ((command: string, args?: unknown) => {
    calls.push([command, args]);
    switch (command) {
      case "stems_model_installed":
        return Promise.resolve(installed);
      case "stems_choose_model":
        return Promise.resolve(chosen);
      case "stems_find_model":
        return Promise.resolve(found);
      case "stems_install_model":
        return (args as { path: string }).path.endsWith("htdemucs.onnx")
          ? Promise.resolve(null)
          : Promise.reject("This isn't an ONNX model: no graph");
      case "stems_separate":
        return new Promise<string[] | null>((resolve) => (finish = resolve));
      case "stems_progress":
        return Promise.resolve((progress += 0.25));
      case "stems_take": {
        const { index } = args as { index: number };
        return Promise.resolve(new Uint8Array([index, index]).buffer);
      }
      case "stems_cancel":
        finish?.(null);
        return Promise.resolve(null);
      default:
        return Promise.reject(new Error(command));
    }
  }) as Invoke;
  return { invoke, calls, finish: (names: string[] | null) => finish?.(names) };
}

test("the model's status is whether the shell has it installed", async () => {
  expect(await desktopStemSeparator(fakeInvoke().invoke).status()).toEqual({ kind: "notInstalled" });
  expect(await desktopStemSeparator(fakeInvoke({ installed: true }).invoke).status()).toEqual({ kind: "installed" });
});

test("the model is installed from the file the musician chooses", async () => {
  const { invoke, calls } = fakeInvoke();
  const separator = desktopStemSeparator(invoke);
  const file = await separator.chooseModelFile();
  expect(file?.label).toBe("C:/Models/htdemucs.onnx");
  await separator.installModel(file!);
  expect(calls).toContainEqual(["stems_install_model", { path: "C:/Models/htdemucs.onnx" }]);
});

test("closing the chooser chooses nothing", async () => {
  const { invoke } = fakeInvoke({ chosen: null });
  expect(await desktopStemSeparator(invoke).chooseModelFile()).toBeNull();
});

test("a model the shell refuses rejects with its reason", async () => {
  const { invoke } = fakeInvoke({ chosen: "C:/Music/song.wav" });
  const separator = desktopStemSeparator(invoke);
  const file = await separator.chooseModelFile();
  await expect(separator.installModel(file!)).rejects.toThrow("This isn't an ONNX model");
});

test("the shell finds a model exported into the repo's model/, by its path, or says there's none", async () => {
  const found = await desktopStemSeparator(fakeInvoke({ found: "C:/soundcheck/model/htdemucs.onnx" }).invoke).findModel!();
  expect(found?.label).toBe("C:/soundcheck/model/htdemucs.onnx");
  expect(await desktopStemSeparator(fakeInvoke().invoke).findModel!()).toBeNull();
});

test("the shell separates the audio, sent raw, reporting progress, and hands over each Stem", async () => {
  vi.useFakeTimers();
  const fake = fakeInvoke({ installed: true });
  const onProgress = vi.fn<(fraction: number) => void>();
  const stages: string[] = [];
  const done = desktopStemSeparator(fake.invoke).separate(audio, {
    onProgress,
    onStage: (stage) => stages.push(stage),
    signal: new AbortController().signal,
  });
  // The shell loads the model before its first chunk, and says nothing till then.
  expect(stages).toEqual(["loadingModel"]);

  await vi.advanceTimersByTimeAsync(PROGRESS_MS * 2);
  expect(onProgress).toHaveBeenCalledWith(0.25);
  expect(onProgress).toHaveBeenCalledWith(0.5);
  expect(stages).toEqual(["loadingModel", "separating"]);
  fake.finish([...STEM_NAMES]);
  const stems = await done;
  expect(stages).toEqual(["loadingModel", "separating", "finishing"]);
  expect(stems?.map(({ name }) => name)).toEqual(STEM_NAMES);
  expect(stems?.map(({ wav }) => [...wav])).toEqual([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
  expect(onProgress).toHaveBeenLastCalledWith(1);
  expect(fake.calls).toContainEqual(["stems_separate", audio]);

  // Polling stops with the separation.
  const polls = fake.calls.length;
  await vi.advanceTimersByTimeAsync(PROGRESS_MS * 5);
  expect(fake.calls.length).toBe(polls);
});

test("aborting cancels the separation in the shell, and nothing comes back", async () => {
  const fake = fakeInvoke({ installed: true });
  const abort = new AbortController();
  const done = desktopStemSeparator(fake.invoke).separate(audio, { onProgress: () => {}, signal: abort.signal });
  abort.abort();
  expect(await done).toBeNull();
  const commands = fake.calls.map(([command]) => command);
  expect(commands).toContain("stems_cancel");
  expect(commands).not.toContain("stems_take");
});

test("an abort that reaches the shell before its separation starts is sent again", async () => {
  vi.useFakeTimers();
  // The shell has yet to start the job when the first cancel arrives, so
  // that one is lost; the next one stops it.
  let cancels = 0;
  let finish: ((names: string[] | null) => void) | undefined;
  const invoke = ((command: string) => {
    if (command === "stems_separate") return new Promise<string[] | null>((resolve) => (finish = resolve));
    if (command === "stems_cancel" && ++cancels === 2) finish?.(null);
    return Promise.resolve(0);
  }) as Invoke;
  const abort = new AbortController();
  const done = desktopStemSeparator(invoke).separate(audio, { onProgress: () => {}, signal: abort.signal });
  abort.abort();
  expect(cancels).toBe(1);
  await vi.advanceTimersByTimeAsync(PROGRESS_MS);
  expect(cancels).toBe(2);
  expect(await done).toBeNull();
});

test("an abort that comes as the shell finishes still returns nothing", async () => {
  const fake = fakeInvoke({ installed: true });
  const abort = new AbortController();
  const done = desktopStemSeparator(fake.invoke).separate(audio, { onProgress: () => {}, signal: abort.signal });
  fake.finish([...STEM_NAMES]);
  abort.abort();
  expect(await done).toBeNull();
});

test("a separation the shell refuses rejects with its reason", async () => {
  const invoke = ((command: string) =>
    command === "stems_separate"
      ? Promise.reject("A Stem Separation is already running; wait for it or cancel it.")
      : Promise.resolve(0)) as Invoke;
  const separating = desktopStemSeparator(invoke).separate(audio, {
    onProgress: () => {},
    signal: new AbortController().signal,
  });
  await expect(separating).rejects.toThrow("already running");
});

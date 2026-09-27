import { afterEach, expect, test, vi } from "vitest";

import type { Invoke } from "../audio/desktop-audio-output";
import { clipBody, desktopMixExporter, pathIn, PROGRESS_MS } from "./desktop-mix-exporter";
import type { ClipExportRequest, ExportRequest } from "./mix-exporter";

const request: ExportRequest = {
  commands: [{ type: "setTempo", bpm: 100 }],
  startTick: 0,
  endTick: 1_920,
  sampleRate: 48_000,
  encoding: { kind: "wav", bits: 24 },
};

afterEach(() => {
  vi.useRealTimers();
});

/** The Tauri side, answering as `desktop/src/lib.rs` does. */
function fakeInvoke(chosen: string | null = "C:/Music/Demo.wav") {
  const calls: [string, unknown][] = [];
  let finish: ((written: boolean) => void) | null = null;
  let progress = 0;
  const invoke = ((command: string, args?: Record<string, unknown> | Uint8Array) => {
    calls.push([command, args]);
    switch (command) {
      case "export_choose_file":
        return Promise.resolve(chosen);
      case "export_choose_folder":
        return Promise.resolve("C:\\Music\\Slices");
      case "export_mix":
      case "export_clip":
        return new Promise<boolean>((resolve) => (finish = resolve));
      case "export_progress":
        return Promise.resolve((progress += 0.25));
      case "export_cancel":
        finish?.(false);
        return Promise.resolve(null);
      default:
        return Promise.reject(new Error(command));
    }
  }) as Invoke;
  return { invoke, calls, finish: (written: boolean) => finish?.(written) };
}

test("the Audio Editor's Slices go into a folder, each at a path in it with the folder's own separator", async () => {
  const { invoke, calls } = fakeInvoke();
  const exporter = desktopMixExporter(invoke);
  const folder = await exporter.chooseFolder();
  expect(calls).toEqual([["export_choose_folder", undefined]]);
  expect(folder?.label).toBe("C:\\Music\\Slices");
  expect((await exporter.fileIn(folder!, "Break – 01", "wav")).label).toBe("C:\\Music\\Slices\\Break – 01.wav");
  expect(pathIn("/home/me/Slices/", "Kick", "mp3")).toBe("/home/me/Slices/Kick.mp3");
  expect(pathIn("C:/Music", "Kick", "wav")).toBe("C:/Music/Kick.wav");
});

test("the save dialog offers a WAV named after the Project", async () => {
  const { invoke, calls } = fakeInvoke();
  const target = await desktopMixExporter(invoke).chooseFile("Demo", "wav");
  expect(calls).toEqual([["export_choose_file", { name: "Demo", kind: "wav" }]]);
  expect(target?.label).toBe("C:/Music/Demo.wav");
});

test("the save dialog offers an MP3 when that is the kind asked for", async () => {
  const { invoke, calls } = fakeInvoke("C:/Music/Demo.mp3");
  const target = await desktopMixExporter(invoke).chooseFile("Demo", "mp3");
  expect(calls).toEqual([["export_choose_file", { name: "Demo", kind: "mp3" }]]);
  expect(target?.label).toBe("C:/Music/Demo.mp3");
});

test("closing the dialog chooses nothing", async () => {
  const { invoke } = fakeInvoke(null);
  expect(await desktopMixExporter(invoke).chooseFile("Demo", "wav")).toBeNull();
});

test("the shell renders and writes the file, reporting progress as it goes", async () => {
  vi.useFakeTimers();
  const fake = fakeInvoke();
  const exporter = desktopMixExporter(fake.invoke);
  const target = (await exporter.chooseFile("Demo", "wav"))!;
  const onProgress = vi.fn<(fraction: number) => void>();
  const done = exporter.exportMix(target, request, { onProgress, signal: new AbortController().signal });

  await vi.advanceTimersByTimeAsync(PROGRESS_MS * 2);
  expect(onProgress).toHaveBeenCalledWith(0.25);
  expect(onProgress).toHaveBeenCalledWith(0.5);
  fake.finish(true);
  expect(await done).toBe(true);
  expect(onProgress).toHaveBeenLastCalledWith(1);
  expect(fake.calls).toContainEqual(["export_mix", { path: "C:/Music/Demo.wav", request }]);

  // Polling stops with the export.
  const polls = fake.calls.length;
  await vi.advanceTimersByTimeAsync(PROGRESS_MS * 5);
  expect(fake.calls.length).toBe(polls);
});

test("aborting cancels the export in the shell", async () => {
  const fake = fakeInvoke();
  const exporter = desktopMixExporter(fake.invoke);
  const target = (await exporter.chooseFile("Demo", "wav"))!;
  const abort = new AbortController();
  const done = exporter.exportMix(target, request, { onProgress: () => {}, signal: abort.signal });
  abort.abort();
  expect(await done).toBe(false);
  expect(fake.calls.map(([command]) => command)).toContain("export_cancel");
});

const clip: ClipExportRequest = {
  audio: new Uint8Array([82, 73, 70, 70]),
  fileOffset: 1.5,
  duration: 2,
  sampleRate: 44_100,
  encoding: { kind: "mp3", kbps: 256 },
};

test("the save dialog says it is exporting a Clip", async () => {
  const { invoke, calls } = fakeInvoke("C:/Música/vocals.mp3");
  const target = await desktopMixExporter(invoke).chooseFile("vocals", "mp3", "clip");
  expect(calls).toEqual([["export_choose_file", { name: "vocals", kind: "mp3", clip: true }]]);
  expect(target?.label).toBe("C:/Música/vocals.mp3");
});

test("a Clip goes to the shell as one raw body: its JSON's length, the JSON, then the audio", () => {
  const body = clipBody("C:/Música/vocals.mp3", clip);
  const length = new DataView(body.buffer).getUint32(0, true);
  const json: unknown = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length)));
  expect(json).toEqual({
    path: "C:/Música/vocals.mp3",
    request: { fileOffset: 1.5, duration: 2, sampleRate: 44_100, encoding: { kind: "mp3", kbps: 256 } },
  });
  expect([...body.subarray(4 + length)]).toEqual([82, 73, 70, 70]);
});

test("the shell writes a Clip, reporting progress, and aborting cancels it", async () => {
  vi.useFakeTimers();
  const fake = fakeInvoke();
  const exporter = desktopMixExporter(fake.invoke);
  const target = (await exporter.chooseFile("vocals", "wav", "clip"))!;
  const onProgress = vi.fn<(fraction: number) => void>();
  const done = exporter.exportClip(target, clip, { onProgress, signal: new AbortController().signal });
  await vi.advanceTimersByTimeAsync(PROGRESS_MS);
  expect(onProgress).toHaveBeenCalledWith(0.25);
  fake.finish(true);
  expect(await done).toBe(true);
  expect(fake.calls).toContainEqual(["export_clip", clipBody("C:/Music/Demo.wav", clip)]);

  const abort = new AbortController();
  const cancelled = exporter.exportClip(target, clip, { onProgress, signal: abort.signal });
  abort.abort();
  expect(await cancelled).toBe(false);
  expect(fake.calls.map(([command]) => command)).toContain("export_cancel");
});

test("a cancel sent before the shell's export started is sent again", async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  let finish: ((written: boolean) => void) | undefined;
  const invoke = ((command: string) => {
    calls.push(command);
    // This shell misses the first cancel, then hears the next.
    if (command === "export_cancel" && calls.filter((c) => c === command).length > 1) finish?.(false);
    if (command === "export_clip") return new Promise<boolean>((resolve) => (finish = resolve));
    return Promise.resolve(0);
  }) as Invoke;
  const abort = new AbortController();
  const done = desktopMixExporter(invoke).exportClip({ label: "x", path: "x" } as never, clip, {
    onProgress: () => {},
    signal: abort.signal,
  });
  abort.abort();
  await vi.advanceTimersByTimeAsync(PROGRESS_MS);
  expect(await done).toBe(false);
});

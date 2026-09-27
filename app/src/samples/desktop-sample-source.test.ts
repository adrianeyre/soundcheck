import { expect, test } from "vitest";

import type { Invoke } from "../audio/desktop-audio-output";
import { desktopSampleSource } from "./desktop-sample-source";

/** The Tauri side, answering as `desktop/src/lib.rs` does. */
function fakeInvoke(chosen: string | null) {
  const calls: [string, unknown][] = [];
  const invoke = ((command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    switch (command) {
      case "samples_choose_folder":
        return Promise.resolve(chosen);
      case "samples_list_audio":
        return Promise.resolve(["Kicks/kick.wav", "snare.flac"]);
      case "project_read_bytes":
        return Promise.resolve([82, 73, 70, 70]);
      default:
        return Promise.resolve(null);
    }
  }) as Invoke;
  return { invoke, calls };
}

test("a chosen folder is named by its path and shown by its last name", async () => {
  expect(await desktopSampleSource(fakeInvoke("C:\\Samples\\Drums\\").invoke).chooseFolder()).toEqual({
    id: "C:\\Samples\\Drums\\",
    label: "Drums",
  });
  expect(await desktopSampleSource(fakeInvoke(null).invoke).chooseFolder()).toBeNull();
});

test("listing, reading and auditioning each name the folder and a path inside it", async () => {
  const { invoke, calls } = fakeInvoke(null);
  const source = desktopSampleSource(invoke);
  const folder = { id: "C:/Samples", label: "Samples" };
  expect(await source.listAudio(folder)).toEqual(["Kicks/kick.wav", "snare.flac"]);
  expect([...(await source.readBytes({ folder, path: "Kicks/kick.wav" }))]).toEqual([82, 73, 70, 70]);
  await source.audition({ folder, path: "snare.flac" });
  await source.stopAudition();
  expect(calls).toEqual([
    ["samples_list_audio", { folder: "C:/Samples" }],
    ["project_read_bytes", { folder: "C:/Samples", path: "Kicks/kick.wav" }],
    ["audio_audition", { folder: "C:/Samples", path: "snare.flac" }],
    ["audio_audition_stop", undefined],
  ]);
});

import { expect, test } from "vitest";

import type { Invoke } from "../audio/desktop-audio-output";
import { desktopFileStorage } from "./desktop-file-storage";

/** The Tauri side, answering as `desktop/src/project_files.rs` does. */
function fakeInvoke(chosen: string | null = "C:/songs/Demo") {
  const calls: [string, unknown][] = [];
  const invoke = ((command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    switch (command) {
      case "project_choose_folder":
        return Promise.resolve(chosen);
      case "project_read_text":
        return Promise.resolve('{"schemaVersion":1}');
      case "project_read_bytes":
        // Tauri's IPC is JSON: the Rust side's bytes arrive as numbers.
        return Promise.resolve([82, 73, 70, 70, 0, 255]);
      case "project_read_lines":
        return Promise.resolve({ text: "{}\n", end: 3 });
      case "project_list_files":
        return Promise.resolve(["audio/take1.wav", "project.json"]);
      default:
        return Promise.resolve(null);
    }
  }) as Invoke;
  return { invoke, calls };
}

test("every call names the folder and a path inside it, and nothing else", async () => {
  const { invoke, calls } = fakeInvoke();
  const storage = desktopFileStorage(invoke);

  const folder = await storage.chooseFolderToSave("Demo");
  expect(folder).toEqual({ id: "C:/songs/Demo", label: "C:/songs/Demo" });
  expect(calls[0]).toEqual(["project_choose_folder", { mode: "save", name: "Demo" }]);

  expect(await storage.readText(folder!, "project.json")).toBe('{"schemaVersion":1}');
  expect(await storage.listFiles(folder!, "")).toEqual(["audio/take1.wav", "project.json"]);
  await storage.writeText(folder!, "project.json", "{}");
  expect(await storage.readBytes(folder!, "audio/kick.wav")).toEqual(new Uint8Array([82, 73, 70, 70, 0, 255]));
  await storage.writeBytes(folder!, "audio/kick.wav", new Uint8Array([82, 73, 70, 70, 1]));
  await storage.copyFile({ id: "D:/old", label: "D:/old" }, "audio/take1.wav", folder!, "audio/take1.wav");
  await storage.appendText(folder!, "changes/alice.jsonl", "{}\n");
  expect(await storage.readLines(folder!, "changes/bob.jsonl", 0)).toEqual({ text: "{}\n", end: 3 });

  expect(calls.slice(1)).toEqual([
    ["project_read_text", { folder: "C:/songs/Demo", path: "project.json" }],
    ["project_list_files", { folder: "C:/songs/Demo", path: "" }],
    ["project_write_text", { folder: "C:/songs/Demo", path: "project.json", text: "{}" }],
    ["project_read_bytes", { folder: "C:/songs/Demo", path: "audio/kick.wav" }],
    [
      "project_write_bytes",
      { folder: "C:/songs/Demo", path: "audio/kick.wav", bytes: [82, 73, 70, 70, 1] },
    ],
    [
      "project_copy_file",
      {
        fromFolder: "D:/old",
        fromPath: "audio/take1.wav",
        toFolder: "C:/songs/Demo",
        toPath: "audio/take1.wav",
      },
    ],
    ["project_append_text", { folder: "C:/songs/Demo", path: "changes/alice.jsonl", text: "{}\n" }],
    ["project_read_lines", { folder: "C:/songs/Demo", path: "changes/bob.jsonl", from: 0 }],
  ]);
});

test("cancelling the folder chooser chooses nothing", async () => {
  const { invoke, calls } = fakeInvoke(null);
  const storage = desktopFileStorage(invoke);
  expect(await storage.chooseFolderToOpen()).toBeNull();
  expect(calls[0]).toEqual(["project_choose_folder", { mode: "open", name: null }]);
});

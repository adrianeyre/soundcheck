// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test } from "vitest";

import { browserFileStorage } from "./browser-file-storage";
import { openProject, saveProject } from "./project-folder";
import { sampleProject } from "../project/fixtures";

/** A folder as the File System Access API hands it out, kept in memory. */
class FakeDirectory {
  readonly kind = "directory";
  readonly entries = new Map<string, FakeDirectory | FakeFile>();
  constructor(readonly name: string) {}

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const found = this.entries.get(name);
    if (found instanceof FakeDirectory) return Promise.resolve(found);
    if (found || !options?.create) return Promise.reject(new Error(`No folder ${name}`));
    const made = new FakeDirectory(name);
    this.entries.set(name, made);
    return Promise.resolve(made);
  }

  getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    const found = this.entries.get(name);
    if (found instanceof FakeFile) return Promise.resolve(found);
    if (found || !options?.create) return Promise.reject(new Error(`No file ${name}`));
    const made = new FakeFile(name);
    this.entries.set(name, made);
    return Promise.resolve(made);
  }

  async *values(): AsyncIterableIterator<FakeDirectory | FakeFile> {
    for (const entry of this.entries.values()) yield entry;
  }
}

class FakeFile {
  readonly kind = "file";
  contents = new Blob([]);
  constructor(readonly name: string) {}
  getFile(): Promise<Blob> {
    return Promise.resolve(this.contents);
  }
  createWritable(options?: { keepExistingData?: boolean }) {
    // As the real one does, it writes to a copy that replaces the file on close.
    let draft = options?.keepExistingData ? this.contents : new Blob([]);
    let at = 0;
    return Promise.resolve({
      write: (data: Blob | string) => {
        const added = new Blob([data]);
        draft = new Blob([draft.slice(0, at), added, draft.slice(at + added.size)]);
        at += added.size;
        return Promise.resolve();
      },
      seek: (position: number) => {
        at = position;
        return Promise.resolve();
      },
      close: () => {
        this.contents = draft;
        return Promise.resolve();
      },
    });
  }
}

const picked: { next: FakeDirectory | null } = { next: null };
const globals = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
  globals.showDirectoryPicker = () =>
    picked.next ? Promise.resolve(picked.next) : Promise.reject(new Error("AbortError"));
});
afterEach(() => {
  delete globals.showDirectoryPicker;
});

test("without the File System Access API there is no browser storage at all", () => {
  delete globals.showDirectoryPicker;
  expect(browserFileStorage()).toBeNull();
});

test("a Project saves into a folder named after it, and opens again from there", async () => {
  const home = new FakeDirectory("Music");
  picked.next = home;
  const storage = browserFileStorage()!;
  const project = sampleProject();

  const folder = (await storage.chooseFolderToSave("Test song"))!;
  expect(folder.label).toBe("Music/Test song");
  // The audio is already in the folder, as importing it would have left it.
  await storage.writeText(folder, "audio/take1.wav", "RIFF take 1");
  expect(await saveProject(storage, project, folder)).toEqual({ ok: true, missingAudio: [] });
  expect(await storage.listFiles(folder, "")).toEqual(["audio/take1.wav", "project.json"]);
  expect(await storage.listFiles(folder, "audio")).toEqual(["audio/take1.wav"]);
  expect(await storage.listFiles(folder, "renders")).toEqual([]);

  // Chosen again later: Open picks the Project's own folder, not its parent.
  picked.next = await home.getDirectoryHandle("Test song");
  const again = (await storage.chooseFolderToOpen())!;
  expect(await openProject(storage, again)).toEqual({
    ok: true,
    project,
    missingAudio: [],
    // The take is read back, for the engine to play.
    samples: new Map([["audio/take1.wav", { name: "take1.wav", bytes: [...new TextEncoder().encode("RIFF take 1")] }]]),
  });
});

test("a pad's WAV is written into audio/ and read back byte for byte", async () => {
  picked.next = new FakeDirectory("Music");
  const storage = browserFileStorage()!;
  const folder = (await storage.chooseFolderToSave("Beat"))!;
  const kick = new Uint8Array([82, 73, 70, 70, 0, 255, 128, 64]);

  await storage.writeBytes(folder, "audio/kick.wav", kick);
  expect(await storage.readBytes(folder, "audio/kick.wav")).toEqual(kick);
  expect(await storage.listFiles(folder, "")).toEqual(["audio/kick.wav"]);
  await expect(storage.readBytes(folder, "audio/gone.wav")).rejects.toThrow("No file gone.wav");
});

test("saving elsewhere copies the audio across, byte for byte", async () => {
  const home = new FakeDirectory("Music");
  picked.next = home;
  const storage = browserFileStorage()!;
  const first = (await storage.chooseFolderToSave("First"))!;
  await storage.writeText(first, "audio/take1.wav", "RIFF take 1");
  await saveProject(storage, sampleProject(), first);

  const second = (await storage.chooseFolderToSave("Second"))!;
  expect(await saveProject(storage, sampleProject(), second, first)).toEqual({
    ok: true,
    missingAudio: [],
  });
  expect(await storage.readText(second, "audio/take1.wav")).toBe("RIFF take 1");

  picked.next = null;
  expect(await storage.chooseFolderToOpen()).toBeNull();
});

test("a Shared Project's Changes are appended a line at a time, and read once each", async () => {
  picked.next = new FakeDirectory("Music");
  const storage = browserFileStorage()!;
  const folder = (await storage.chooseFolderToSave("Beat"))!;

  await storage.appendText(folder, "changes/alice.jsonl", '{"seq":1}\n');
  await storage.appendText(folder, "changes/alice.jsonl", '{"seq":2}\n{"é');
  const first = await storage.readLines(folder, "changes/alice.jsonl", 0);
  expect(first).toEqual({ text: '{"seq":1}\n{"seq":2}\n', end: 20 });

  // The rest of a line still being written, with a character of two bytes before it.
  await storage.appendText(folder, "changes/alice.jsonl", '":3}\n');
  const next = await storage.readLines(folder, "changes/alice.jsonl", first.end);
  expect(next).toEqual({ text: '{"é":3}\n', end: 29 });
  expect(await storage.readLines(folder, "changes/alice.jsonl", next.end)).toEqual({ text: "", end: 29 });

  await storage.writeText(folder, "changes/alice.jsonl", '{"seq":9}\n');
  expect(await storage.readLines(folder, "changes/alice.jsonl", next.end)).toEqual({ text: '{"seq":9}\n', end: 10 });
  await expect(storage.readLines(folder, "changes/bob.jsonl", 0)).rejects.toThrow("No file bob.jsonl");
});

// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { expect, test, vi } from "vitest";

import type { AuditionContext } from "../reference/browser-reference-player";
import {
  AUDITION_GAIN,
  NEEDS_PERMISSION,
  PICKED_FOR_SESSION,
  browserSampleSource,
  folderFiles,
  indexedDbHandleStore,
  isAudioPath,
  memoryHandleStore,
  pickFolderFiles,
  type SampleDirectory,
  type SampleFileEntry,
} from "./browser-sample-source";

type Tree = { [name: string]: string | Tree };

/** A folder on a pretend disk, as the File System Access API hands it over. */
function directory(name: string, tree: Tree, permission: { state: PermissionState; onRequest?: PermissionState } = { state: "granted" }): SampleDirectory {
  const entry = (child: string): SampleDirectory | SampleFileEntry => {
    const value = tree[child];
    if (value === undefined) throw new DOMException(`${child} not found`, "NotFoundError");
    return typeof value === "string"
      ? { kind: "file", name: child, getFile: () => Promise.resolve(new Blob([value])) }
      : directory(child, value, permission);
  };
  return {
    kind: "directory",
    name,
    async *values() {
      for (const child of Object.keys(tree)) yield entry(child);
    },
    getDirectoryHandle: async (child) => entry(child) as SampleDirectory,
    getFileHandle: async (child) => entry(child) as SampleFileEntry,
    queryPermission: async () => permission.state,
    requestPermission: async () => {
      if (!permission.onRequest) throw new DOMException("User activation is required", "SecurityError");
      permission.state = permission.onRequest;
      return permission.state;
    },
  };
}

const drums: Tree = {
  "snare.WAV": "snare",
  "notes.txt": "not audio",
  Kicks: { "kick.wav": "kick", "deep.flac": "deep" },
  Loops: { "beat.mp3": "beat" },
};

function ids() {
  let next = 0;
  return () => `folder-${next++}`;
}

test("only the files the engine can play are listed, whatever the case of their extension", () => {
  expect(["a.wav", "b.FLAC", "c.Mp3", "d.txt", "wav", "e.wav.bak"].filter(isAudioPath)).toEqual([
    "a.wav",
    "b.FLAC",
    "c.Mp3",
  ]);
});

test("a chosen folder is remembered by its handle, and its audio listed and read from inside it", async () => {
  const handles = memoryHandleStore();
  const source = browserSampleSource({ pickDirectory: async () => directory("Drums", drums), handles, newId: ids() });
  const folder = await source.chooseFolder();
  expect(folder).toEqual({ id: "folder-0", label: "Drums" });
  expect(await source.listAudio(folder!)).toEqual(["Kicks/deep.flac", "Kicks/kick.wav", "Loops/beat.mp3", "snare.WAV"]);
  expect(new TextDecoder().decode(await source.readBytes({ folder: folder!, path: "Kicks/kick.wav" }))).toBe("kick");

  // The next launch reads it through the same handle.
  const again = browserSampleSource({ pickDirectory: async () => directory("Other", {}), handles });
  expect(await again.listAudio(folder!)).toHaveLength(4);
});

test("cancelling the directory picker chooses no folder", async () => {
  const source = browserSampleSource({
    pickDirectory: () => Promise.reject(new DOMException("The user aborted a request.", "AbortError")),
    handles: memoryHandleStore(),
  });
  expect(await source.chooseFolder()).toBeNull();
});

test("where the browser wants permission again, the folder is read only once it is granted", async () => {
  const handles = memoryHandleStore();
  const permission: { state: PermissionState; onRequest?: PermissionState } = { state: "prompt" };
  await handles.put("folder-0", directory("Drums", drums, permission));
  const source = browserSampleSource({ pickDirectory: async () => directory("x", {}), handles });
  const folder = { id: "folder-0", label: "Drums" };

  // On launch there has been no click to ask from.
  await expect(source.listAudio(folder)).rejects.toThrow(NEEDS_PERMISSION);
  // From a click the browser asks, and the musician allows it.
  permission.onRequest = "granted";
  expect(await source.listAudio(folder)).toHaveLength(4);
});

test("a folder the browser no longer knows says to add it again", async () => {
  const source = browserSampleSource({ pickDirectory: async () => directory("x", {}), handles: memoryHandleStore() });
  await expect(source.listAudio({ id: "gone", label: "Gone" })).rejects.toThrow(/Gone is no longer known/);
});

test("without a directory picker a folder input's files are browsed for the session", async () => {
  const kick = new File(["kick"], "kick.wav");
  const source = browserSampleSource({
    pickDirectory: null,
    pickFiles: async () => ({ name: "Drums", files: new Map([["Kicks/kick.wav", kick], ["read me.txt", new Blob()]]) }),
    newId: ids(),
  });
  const folder = (await source.chooseFolder())!;
  expect(folder).toEqual({ id: "folder-0", label: "Drums" });
  expect(await source.listAudio(folder)).toEqual(["Kicks/kick.wav"]);
  expect(new TextDecoder().decode(await source.readBytes({ folder, path: "Kicks/kick.wav" }))).toBe("kick");

  // After a reload the files are gone, and it says so.
  const reloaded = browserSampleSource({ pickDirectory: null });
  await expect(reloaded.listAudio(folder)).rejects.toThrow(PICKED_FOR_SESSION);
});

/** A file as a folder input hands it over, named by its path from the folder chosen. */
function pickedFile(path: string): File {
  return Object.defineProperty(new File([path], path.split("/").pop()!), "webkitRelativePath", { value: path });
}

test("a folder input's files are named by their path inside the folder chosen", () => {
  const picked = folderFiles([pickedFile("Drums/snare.wav"), pickedFile("Drums/Kicks/kick.wav")]);
  expect(picked?.name).toBe("Drums");
  expect([...(picked?.files.keys() ?? [])]).toEqual(["snare.wav", "Kicks/kick.wav"]);
  expect(folderFiles([])).toBeNull();
});

test("the folder input asks for a folder, and cancelling it chooses none", async () => {
  const click = vi.spyOn(HTMLInputElement.prototype, "click");
  click.mockImplementationOnce(function (this: HTMLInputElement) {
    expect(this.webkitdirectory).toBe(true);
    Object.defineProperty(this, "files", { value: [pickedFile("Drums/kick.wav")] });
    this.dispatchEvent(new Event("change"));
  });
  expect((await pickFolderFiles())?.name).toBe("Drums");
  click.mockImplementationOnce(function (this: HTMLInputElement) {
    this.dispatchEvent(new Event("cancel"));
  });
  expect(await pickFolderFiles()).toBeNull();
  click.mockRestore();
});

test("handles are kept in IndexedDB between launches", async () => {
  const factory = new IDBFactory();
  // Anything structured cloning keeps stands in for a real handle here.
  const handle = { kind: "directory", name: "Drums" } as unknown as SampleDirectory;
  await indexedDbHandleStore(factory, "test").put("folder-0", handle);
  expect(await indexedDbHandleStore(factory, "test").get("folder-0")).toEqual(handle);
  expect(await indexedDbHandleStore(factory, "test").get("other")).toBeUndefined();
});

type Call = () => void;

function node() {
  return { connect: vi.fn<Call>(), disconnect: vi.fn<Call>(), addEventListener: vi.fn<Call>() };
}

test("an audition plays at the fixed preview level, one at a time, in a context of its own", async () => {
  const sources: {
    start: ReturnType<typeof vi.fn<Call>>;
    stop: ReturnType<typeof vi.fn<Call>>;
    addEventListener: ReturnType<typeof vi.fn<(type: string, listener: () => void) => void>>;
  }[] = [];
  const gains: { gain: { value: number } }[] = [];
  const context = {
    decodeAudioData: vi.fn<AuditionContext["decodeAudioData"]>(() => Promise.resolve({ duration: 1 } as AudioBuffer)),
    createBufferSource: () => {
      const source = {
        ...node(),
        addEventListener: vi.fn<(type: string, listener: () => void) => void>(),
        start: vi.fn<Call>(),
        stop: vi.fn<Call>(),
        buffer: null,
      };
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    },
    createGain: () => {
      const gain = { ...node(), gain: { value: 1 } };
      gains.push(gain);
      return gain as unknown as GainNode;
    },
    destination: {} as AudioNode,
    resume: () => Promise.resolve(),
  } satisfies AuditionContext;
  const open = vi.fn<() => AuditionContext>(() => context);
  const source = browserSampleSource({
    pickDirectory: async () => directory("Drums", drums),
    handles: memoryHandleStore(),
    openContext: open,
  });
  const folder = (await source.chooseFolder())!;

  await source.audition({ folder, path: "snare.WAV" });
  await source.audition({ folder, path: "Kicks/kick.wav" });
  expect(open).toHaveBeenCalledTimes(1);
  expect(gains.map((gain) => gain.gain.value)).toEqual([AUDITION_GAIN, AUDITION_GAIN]);
  expect(sources[0]?.stop).toHaveBeenCalled();
  expect(sources[1]?.start).toHaveBeenCalled();
  // Only the audition that plays to its end says so: not one stopped, nor one replaced.
  const ended = vi.fn<Call>();
  const stopListening = source.onAuditionEnd!(ended);
  const endOf = (index: number) => sources[index]!.addEventListener.mock.calls.find(([type]) => type === "ended")![1];
  endOf(0)();
  expect(ended).not.toHaveBeenCalled();
  endOf(1)();
  expect(ended).toHaveBeenCalledTimes(1);
  stopListening();
  await source.audition({ folder, path: "snare.WAV" });
  endOf(2)();
  expect(ended).toHaveBeenCalledTimes(1);
  // Stopping stops the one playing.
  await source.audition({ folder, path: "snare.WAV" });
  await source.stopAudition();
  expect(sources[3]?.stop).toHaveBeenCalled();

  context.decodeAudioData.mockRejectedValueOnce(new DOMException("Unable to decode", "EncodingError"));
  await expect(source.audition({ folder, path: "Loops/beat.mp3" })).rejects.toThrow(/beat.mp3 couldn't be played/);
});

/**
 * The sample browser on the browser dev host. Where there is the File System
 * Access API (Chromium), a folder is chosen with the directory picker and its
 * handle kept in IndexedDB, so it is there on every launch; the browser may
 * ask again before it lets the page read it, which needs a click, so a
 * listing that is refused says so and the musician reads it again. Elsewhere
 * a folder input hands over its files for the session only.
 *
 * Auditioning is Web Audio in a context of its own, beside the worklet that
 * plays the mix, so it never reaches the mix, its meters or an export.
 */
import { type AuditionContext } from "../reference/browser-reference-player";
import type { Bytes } from "../storage/file-storage";
import type { SampleFolder, SampleRef, SampleSource } from "./sample-source";

/** The engine's `AUDITION_GAIN`: the fixed preview level the desktop plays at. */
export const AUDITION_GAIN = 0.5;

/** The files the engine can play, by extension, as `desktop/src/samples.rs` lists them. */
const AUDIO_EXTENSIONS = ["wav", "flac", "mp3"];

export function isAudioPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && AUDIO_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/** As much of the File System Access API as reading a sample folder needs. */
export interface SampleDirectory {
  readonly kind: "directory";
  readonly name: string;
  values: () => AsyncIterableIterator<SampleDirectory | SampleFileEntry>;
  getDirectoryHandle: (name: string) => Promise<SampleDirectory>;
  getFileHandle: (name: string) => Promise<SampleFileEntry>;
  queryPermission?: (options: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: "read" }) => Promise<PermissionState>;
}

export interface SampleFileEntry {
  readonly kind: "file";
  readonly name: string;
  getFile: () => Promise<Blob>;
}

/** Where the chosen folders' handles are kept between launches. */
export interface HandleStore {
  get: (id: string) => Promise<SampleDirectory | undefined>;
  put: (id: string, directory: SampleDirectory) => Promise<void>;
}

/** A folder's files as a folder input hands them over, by folder-relative path. */
export interface PickedFiles {
  name: string;
  files: ReadonlyMap<string, Blob>;
}

export interface BrowserSampleSourceOptions {
  /** The directory picker; null where there is none, and the folder input is used instead. */
  pickDirectory?: (() => Promise<SampleDirectory>) | null;
  handles?: HandleStore;
  pickFiles?: () => Promise<PickedFiles | null>;
  openContext?: () => AuditionContext;
  newId?: () => string;
}

/** Said where the browser wants the musician's permission before the page reads a folder again. */
export const NEEDS_PERMISSION = "the browser needs your permission to read it again";

/** Said where a folder input's folder is asked for after the page has reloaded. */
export const PICKED_FOR_SESSION = "this browser can't reopen a folder after the page reloads: remove it and add it again";

export function browserSampleSource({
  pickDirectory = directoryPicker(),
  handles = defaultHandleStore(),
  pickFiles = pickFolderFiles,
  openContext = () => new AudioContext(),
  newId = () => crypto.randomUUID(),
}: BrowserSampleSourceOptions = {}): SampleSource {
  const picked = new Map<string, ReadonlyMap<string, Blob>>();
  let context: AuditionContext | null = null;
  let playing: AudioBufferSourceNode | null = null;
  const ended = new Set<() => void>();

  const directory = async (folder: SampleFolder): Promise<SampleDirectory> => {
    const found = await handles.get(folder.id);
    if (!found) throw new Error(`${folder.label} is no longer known to this browser: remove it and add it again`);
    if (found.queryPermission && (await found.queryPermission({ mode: "read" })) !== "granted") {
      // Only granted with a click; on launch the request is refused.
      const asked = await found.requestPermission?.({ mode: "read" }).catch(() => "denied" as const);
      if (asked !== "granted") throw new Error(NEEDS_PERMISSION);
    }
    return found;
  };

  const file = async ({ folder, path }: SampleRef): Promise<Blob> => {
    const files = picked.get(folder.id);
    if (files) {
      const blob = files.get(path);
      if (!blob) throw new Error(`${path} isn't in ${folder.label}`);
      return blob;
    }
    if (!pickDirectory) throw new Error(PICKED_FOR_SESSION);
    const parts = path.split("/").filter((part) => part.length > 0);
    const name = parts.pop();
    if (!name) throw new Error(`${path} isn't a file in ${folder.label}`);
    let at = await directory(folder);
    for (const part of parts) at = await at.getDirectoryHandle(part);
    return (await at.getFileHandle(name)).getFile();
  };

  const stop = () => {
    playing?.stop();
    playing?.disconnect();
    playing = null;
  };

  return {
    async chooseFolder() {
      if (!pickDirectory) {
        const chosen = await pickFiles();
        if (!chosen) return null;
        const id = newId();
        picked.set(id, chosen.files);
        return { id, label: chosen.name };
      }
      // The picker rejects when the musician cancels.
      const chosen = await pickDirectory().catch(() => null);
      if (!chosen) return null;
      const id = newId();
      await handles.put(id, chosen);
      return { id, label: chosen.name };
    },

    async listAudio(folder) {
      const files = picked.get(folder.id);
      if (files) return [...files.keys()].filter(isAudioPath).toSorted();
      if (!pickDirectory) throw new Error(PICKED_FOR_SESSION);
      return (await audioUnder(await directory(folder), "")).toSorted();
    },

    async readBytes(sample): Promise<Bytes> {
      return new Uint8Array(await (await file(sample)).arrayBuffer());
    },

    async audition(sample) {
      context ??= openContext();
      await context.resume();
      const audio = await context
        .decodeAudioData(await (await file(sample)).arrayBuffer())
        .catch(() => Promise.reject(new Error(`${sample.path} couldn't be played: it isn't audio this browser can read`)));
      stop();
      const level = context.createGain();
      level.gain.value = AUDITION_GAIN;
      level.connect(context.destination);
      const source = context.createBufferSource();
      source.buffer = audio;
      source.connect(level);
      source.addEventListener("ended", () => {
        level.disconnect();
        // Stopped, or replaced by the next audition, it didn't play to its end.
        if (playing !== source) return;
        playing = null;
        for (const listener of ended) listener();
      });
      source.start();
      playing = source;
    },

    async stopAudition() {
      stop();
    },

    onAuditionEnd(listener) {
      ended.add(listener);
      return () => ended.delete(listener);
    },
  };
}

async function audioUnder(at: SampleDirectory, prefix: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of at.values()) {
    const path = `${prefix}${entry.name}`;
    if (entry.kind === "directory") found.push(...(await audioUnder(entry, `${path}/`)));
    else if (isAudioPath(path)) found.push(path);
  }
  return found;
}

function directoryPicker(): (() => Promise<SampleDirectory>) | null {
  const found = (globalThis as { showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<SampleDirectory> })
    .showDirectoryPicker;
  return typeof found === "function" ? () => found.call(globalThis, { mode: "read" }) : null;
}

function defaultHandleStore(): HandleStore {
  return typeof indexedDB === "undefined" ? memoryHandleStore() : indexedDbHandleStore(indexedDB);
}

/** Handles for the session only, where there is no IndexedDB. */
export function memoryHandleStore(): HandleStore {
  const handles = new Map<string, SampleDirectory>();
  return {
    get: async (id) => handles.get(id),
    put: async (id, directory) => {
      handles.set(id, directory);
    },
  };
}

const DATABASE = "soundcheck-sample-folders";
const HANDLES = "handles";

/** Folder handles in IndexedDB, which keeps them by structured cloning. */
export function indexedDbHandleStore(indexedDB: IDBFactory, name = DATABASE): HandleStore {
  let opened: Promise<IDBDatabase> | null = null;
  const database = () => {
    opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.addEventListener("upgradeneeded", () => request.result.createObjectStore(HANDLES));
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error ?? new Error("The sample folders couldn't be opened")));
    });
    return opened;
  };

  async function run<T>(mode: IDBTransactionMode, ask: (handles: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const transaction = (await database()).transaction(HANDLES, mode);
    const request = ask(transaction.objectStore(HANDLES));
    return new Promise((resolve, reject) => {
      const failed = () => reject(transaction.error ?? new Error("The sample folders couldn't be read or written"));
      transaction.addEventListener("complete", () => resolve(request.result));
      transaction.addEventListener("error", failed);
      transaction.addEventListener("abort", failed);
    });
  }

  return {
    get: async (id) => (await run("readonly", (handles) => handles.get(id))) as SampleDirectory | undefined,
    put: async (id, directory) => {
      await run("readwrite", (handles) => handles.put(directory, id));
    },
  };
}

/** Ask for a folder with a folder input; null if the musician cancels. */
export function pickFolderFiles(document: Document = globalThis.document): Promise<PickedFiles | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.addEventListener("change", () => resolve(input.files ? folderFiles(input.files) : null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** A folder input's files, by path inside the chosen folder; its name is each path's first part. */
export function folderFiles(list: Iterable<File>): PickedFiles | null {
  const files = new Map<string, Blob>();
  let name = "";
  for (const file of list) {
    const [first = "", ...rest] = (file.webkitRelativePath || file.name).split("/");
    name ||= first;
    files.set(rest.length > 0 ? rest.join("/") : first, file);
  }
  return files.size === 0 ? null : { name, files };
}

/**
 * A Shared Project's folder (ADR 0007): `project.json`, the base it was
 * shared from, the `audio/` everyone's Changes name, and `changes/`, one
 * file per copy of the Project holding every Change that copy has made
 * since, a line each.
 *
 * Each copy only ever adds lines to the end of its own file, so a file-sync
 * service or a shared drive never has two edits of one file to choose
 * between; the Changes, in whatever order they turn up, make the same
 * Project on every copy. Collaborators can be apart for days: what they did
 * meanwhile arrives when their files do.
 */
import type { Change } from "../project/change";
import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import { type HistoryOptions, ProjectHistory } from "../project/history";
import type { Project } from "../project/model";
import type { FileStorage, ProjectFolder } from "../storage/file-storage";
import { AUDIO_FOLDER, audioFiles, fileName, openProject, readAudio } from "../storage/project-folder";

export const CHANGES_FOLDER = "changes";
const EXTENSION = ".jsonl";

/** How often a Shared Project's folder is looked at for Collaborators' Changes. */
export const POLL_EVERY_MS = 2000;

/** The file a copy's Changes go in. */
export function changesFile(copy: string): string {
  return `${CHANGES_FOLDER}/${copy}${EXTENSION}`;
}

/** A Change as a line of its copy's file. */
export function changeLine(change: Change): string {
  return `${JSON.stringify(change)}\n`;
}

const KINDS: ReadonlySet<unknown> = new Set(["edit", "undo", "redo"]);

/**
 * The Changes a file's lines hold. A line that isn't one, damaged or half
 * synced, is skipped: nothing a Collaborator's file holds stops the rest.
 */
export function parseChanges(text: string): Change[] {
  const changes: Change[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isChange(value)) changes.push(value);
    } catch {
      // Not a whole line of JSON: skipped.
    }
  }
  return changes;
}

/** Whether `value`, from a file or a Collaborator, is a Change in its shape. */
export function isChange(value: unknown): value is Change {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Partial<Record<keyof Change, unknown>>;
  return (
    typeof change.id === "string" &&
    typeof change.copy === "string" &&
    typeof change.seq === "number" &&
    typeof change.clock === "number" &&
    KINDS.has(change.kind) &&
    typeof change.sync === "string" &&
    (change.by === undefined || typeof change.by === "string") &&
    Array.isArray(change.writes) &&
    change.writes.every((each: unknown) => typeof (each as { key?: unknown } | null)?.key === "string")
  );
}

/** Whether the folder holds a Shared Project: it has a file of Changes. */
export async function isShared(storage: FileStorage, folder: ProjectFolder): Promise<boolean> {
  return (await storage.listFiles(folder, CHANGES_FOLDER)).some((path) => path.endsWith(EXTENSION));
}

/** How far into each copy's file its Changes have been read, in bytes. */
export type ReadSoFar = Map<string, number>;

/** Every copy's Changes added since `from`, and how far that reads each file. */
export async function readChanges(
  storage: FileStorage,
  folder: ProjectFolder,
  from: ReadSoFar = new Map(),
  skip?: string,
): Promise<{ changes: Change[]; read: ReadSoFar }> {
  const read = new Map(from);
  const changes: Change[] = [];
  for (const path of await storage.listFiles(folder, CHANGES_FOLDER)) {
    if (!path.endsWith(EXTENSION) || path === skip) continue;
    const lines = await storage.readLines(folder, path, read.get(path) ?? 0);
    changes.push(...parseChanges(lines.text));
    read.set(path, lines.end);
  }
  return { changes, read };
}

/**
 * Make the Project in `folder` a Shared Project: `history`'s Project as it
 * is now becomes its base, which `save` writes there, and this copy's file
 * of Changes, empty so far, says it is shared. Undo still reaches the steps
 * from before. Changes made while it saves are the first in the file, once
 * a `FolderSync` with nothing yet `written` follows it.
 */
export async function shareFolder<T>(
  storage: FileStorage,
  folder: ProjectFolder,
  history: ProjectHistory,
  save: (base: Project) => Promise<T>,
): Promise<T> {
  history.rebase();
  const saved = await save(history.project);
  await storage.appendText(folder, changesFile(history.copy), "");
  return saved;
}

export type OpenedFolder =
  | {
      ok: true;
      history: ProjectHistory;
      samples: LoadedSamples;
      missingAudio: string[];
      /** How far each copy's file was read, where the folder is a Shared Project. */
      shared: ReadSoFar | null;
    }
  | { ok: false; error: string };

/**
 * Open the Project in `folder`: its `project.json`, and in a Shared Project
 * every Change anyone has made since, with the audio they name. `options`
 * say which copy this is, so its own Changes go on from where they were.
 */
export async function openFolder(
  storage: FileStorage,
  folder: ProjectFolder,
  options: Pick<HistoryOptions, "copy" | "by"> = {},
): Promise<OpenedFolder> {
  const opened = await openProject(storage, folder);
  if (!opened.ok) return opened;
  if (!(await isShared(storage, folder))) {
    const { samples, missingAudio } = opened;
    return { ok: true, history: new ProjectHistory(opened.project, { by: options.by }), samples, missingAudio, shared: null };
  }
  const { changes, read } = await readChanges(storage, folder);
  const history = new ProjectHistory(opened.project, { ...options, changes });
  const later = audioFiles(history.project).filter((file) => !opened.samples.has(file));
  const more = await readAudio(storage, folder, later);
  const kept = new Set(audioFiles(history.project));
  return {
    ok: true,
    history,
    samples: new Map([...opened.samples, ...more.samples]),
    missingAudio: [...opened.missingAudio.filter((file) => kept.has(file)), ...more.missingAudio],
    shared: read,
  };
}

export interface FolderSyncOptions {
  /** The audio the Project has loaded, by path: new files are written into the folder from it. */
  samples: () => LoadedSamples;
  /** Audio that Collaborators' Changes name, read from the folder once it is there. */
  onAudio: (samples: LoadedSamples) => void;
  /** Writing or reading the folder has failed, with why, or works again, with null. It is tried again meanwhile. */
  onTrouble?: (message: string | null) => void;
  /** How far into each copy's file its Changes were read when the Project was opened. */
  read?: ReadSoFar;
  /**
   * The last of this copy's own Changes its file already holds, by seq:
   * every one in the log, where the file is what they were read from.
   */
  written?: number;
}

/**
 * Keeps a Shared Project's folder and its history in step: this copy's
 * Changes are added to its file as they are made, the audio they name first,
 * and Collaborators' files are looked at every so often for theirs. What it
 * writes is read from the log, so none of this copy's Changes is missed or
 * written twice, whenever it started following.
 */
export class FolderSync {
  readonly #storage: FileStorage;
  readonly #folder: ProjectFolder;
  readonly #history: ProjectHistory;
  readonly #options: FolderSyncOptions;
  readonly #own: string;
  #read: ReadSoFar;
  /** The seq of the last of this copy's Changes in its file. */
  #written: number;
  #stopped = false;
  /** A write failed partway, so the next one starts on a line of its own. */
  #broken = false;
  /** Audio known to be in the folder, once it has been listed. */
  #there: Set<string> | null = null;
  /** Audio already read for the Project, so none is read twice. */
  readonly #fetched = new Set<string>();
  #queue: Promise<void> = Promise.resolve();
  #trouble: string | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #unsubscribe: () => void;

  constructor(storage: FileStorage, folder: ProjectFolder, history: ProjectHistory, options: FolderSyncOptions) {
    this.#storage = storage;
    this.#folder = folder;
    this.#history = history;
    this.#options = options;
    this.#own = changesFile(history.copy);
    this.#read = new Map(options.read);
    this.#written = options.written ?? history.have[history.copy] ?? 0;
    this.#unsubscribe = history.onChange(() => void this.#enqueue(() => this.#write()));
  }

  /** Write what is waiting, then take in what Collaborators have written since last time. */
  poll(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#write();
      await this.#take();
    });
  }

  /** Look at the folder every `interval` milliseconds, until `stop`. */
  start(interval = POLL_EVERY_MS): void {
    this.#timer ??= setInterval(() => void this.poll(), interval);
  }

  /** Stop following the history and the folder, once what is waiting has been written. */
  stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#unsubscribe();
    const last = this.#enqueue(() => this.#write());
    this.#stopped = true;
    return last;
  }

  /** Everything asked of it so far, done in order, one at a time. */
  #enqueue(task: () => Promise<void>): Promise<void> {
    if (this.#stopped) return this.#queue;
    const next = this.#queue.then(task).then(
      () => this.#report(null),
      (reason: unknown) => this.#report(reason instanceof Error ? reason.message : String(reason)),
    );
    this.#queue = next;
    return next;
  }

  #report(trouble: string | null) {
    if (trouble === this.#trouble) return;
    this.#trouble = trouble;
    this.#options.onTrouble?.(trouble);
  }

  /**
   * Add this copy's Changes not yet in its file to it, writing the audio the
   * Project names that the folder hasn't got first, so a Collaborator who
   * reads a Change can nearly always read its audio too.
   */
  async #write() {
    await this.#writeAudio();
    const copy = this.#history.copy;
    const waiting = this.#history.log.filter((change) => change.copy === copy && change.seq > this.#written);
    if (waiting.length === 0) return;
    // A line cut short by a failed write is ended, so the rest still parse.
    const text = (this.#broken ? "\n" : "") + waiting.map(changeLine).join("");
    this.#broken = true;
    await this.#storage.appendText(this.#folder, this.#own, text);
    this.#broken = false;
    this.#written = Math.max(...waiting.map((change) => change.seq));
  }

  async #writeAudio() {
    const wanted = audioFiles(this.#history.project);
    if (wanted.length === 0) return;
    this.#there ??= new Set(await this.#storage.listFiles(this.#folder, AUDIO_FOLDER));
    const samples = this.#options.samples();
    for (const file of wanted) {
      const sample = samples.get(file);
      if (this.#there.has(file) || !sample) continue;
      await this.#storage.writeBytes(this.#folder, file, Uint8Array.from(sample.bytes));
      this.#there.add(file);
    }
  }

  /** Collaborators' new Changes, then any audio they name that is here now. */
  async #take() {
    const { changes, read } = await readChanges(this.#storage, this.#folder, this.#read, this.#own);
    this.#read = read;
    if (changes.length > 0) this.#history.receive(changes);

    const samples = this.#options.samples();
    const missing = audioFiles(this.#history.project).filter((file) => !samples.has(file) && !this.#fetched.has(file));
    if (missing.length === 0) return;
    this.#there = new Set(await this.#storage.listFiles(this.#folder, AUDIO_FOLDER));
    const found = new Map<string, LoadedSample>();
    for (const file of missing) {
      if (!this.#there.has(file)) continue;
      const bytes = await this.#storage.readBytes(this.#folder, file);
      // A WAV still arriving is left until it has all come.
      if (!whole(bytes)) continue;
      found.set(file, { name: fileName(file), bytes: [...bytes] });
      this.#fetched.add(file);
    }
    if (found.size > 0) this.#options.onAudio(found);
  }
}

/** Whether a file is all there: a WAV says how long it is at its start. */
function whole(bytes: Uint8Array): boolean {
  const riff = bytes.length >= 8 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF";
  if (!riff) return true;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  return bytes.length >= size + 8;
}

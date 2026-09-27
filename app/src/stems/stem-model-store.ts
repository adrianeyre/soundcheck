/**
 * Where the Browser Version keeps the installed `htdemucs.onnx`: the site's
 * own storage, outside any Project, so it survives a reload. The Origin
 * Private File System where the browser can write to it, which is made for
 * big files; IndexedDB elsewhere. Either is the site's alone, and the
 * browser's "delete site data" removes it.
 */

/** The installed model, kept as a file the worker reads when it separates. */
export interface StemModelStore {
  /** The installed model, or null if there is none. */
  read(): Promise<Blob | null>;
  /** Keep `model`, replacing any: the old one stays until the new one is whole. */
  write(model: Blob): Promise<void>;
  remove(): Promise<void>;
}

const FOLDER = "models";
const FILE = "htdemucs.onnx";

/** The parts of the Origin Private File System the store uses, so tests can stand in for it. */
export interface OpfsRoot {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsFolder>;
}
interface OpfsFolder {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFile>;
  removeEntry(name: string): Promise<void>;
}
interface OpfsFile {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}

function notFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

/** The model in the Origin Private File System, in `models/htdemucs.onnx`. */
export function opfsModelStore(root: () => Promise<OpfsRoot>): StemModelStore {
  const folder = async (create: boolean) => (await root()).getDirectoryHandle(FOLDER, { create });
  return {
    async read() {
      try {
        const file = await (await (await folder(false)).getFileHandle(FILE)).getFile();
        return file.size > 0 ? file : null;
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async write(model) {
      const handle = await (await folder(true)).getFileHandle(FILE, { create: true });
      // A writable stream writes beside the file and swaps it in on close,
      // so a write that fails part way leaves the old model whole.
      const writable = await handle.createWritable();
      try {
        await writable.write(model);
      } catch (error) {
        await writable.abort();
        throw error;
      }
      await writable.close();
    },
    async remove() {
      try {
        await (await folder(false)).removeEntry(FILE);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    },
  };
}

const DATABASE = "soundcheck-models";
const MODELS = "models";

/** The model as a Blob in IndexedDB, where the browser can't write the Origin Private File System. */
export function indexedDbModelStore(indexedDB: IDBFactory, name = DATABASE): StemModelStore {
  let opened: Promise<IDBDatabase> | null = null;
  const database = () => {
    opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.addEventListener("upgradeneeded", () => request.result.createObjectStore(MODELS));
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error ?? new Error("The model's storage couldn't be opened")));
    });
    return opened;
  };

  async function run<T>(mode: IDBTransactionMode, ask: (models: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const transaction = (await database()).transaction(MODELS, mode);
    const request = ask(transaction.objectStore(MODELS));
    return new Promise((resolve, reject) => {
      const failed = () => reject(transaction.error ?? new Error("The model couldn't be read or kept"));
      transaction.addEventListener("complete", () => resolve(request.result));
      transaction.addEventListener("error", failed);
      transaction.addEventListener("abort", failed);
    });
  }

  return {
    read: async () => ((await run("readonly", (models) => models.get(FILE))) as Blob | undefined) ?? null,
    // One transaction, so the old model stays unless the new one is kept whole.
    write: async (model) => {
      await run("readwrite", (models) => models.put(model, FILE));
    },
    remove: async () => {
      await run("readwrite", (models) => models.delete(FILE));
    },
  };
}

/** Whether this browser can write files into the Origin Private File System from a page. */
function canWriteOpfs(): boolean {
  const handle = (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function" && !!handle && "createWritable" in handle.prototype;
}

/** The browser's best store for the model, or null if it has none. */
export function browserModelStore(): StemModelStore | null {
  if (canWriteOpfs()) return opfsModelStore(() => navigator.storage.getDirectory() as Promise<OpfsRoot>);
  if (typeof indexedDB !== "undefined") return indexedDbModelStore(indexedDB);
  return null;
}

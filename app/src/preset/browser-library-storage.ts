/**
 * The library on the browser dev host: an IndexedDB database of the
 * library's files, keyed by path. It belongs to the dev host's origin, so
 * every Project opened there sees the same library.
 */
import { filesUnder, type LibraryStorage } from "./library-storage";

const DATABASE = "soundcheck-library";
const FILES = "files";

export function browserLibraryStorage(indexedDB: IDBFactory, name = DATABASE): LibraryStorage {
  let opened: Promise<IDBDatabase> | null = null;
  const database = () => {
    opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.addEventListener("upgradeneeded", () => request.result.createObjectStore(FILES));
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error ?? new Error("The library couldn't be opened")));
    });
    return opened;
  };

  /** One request against the files, in its own transaction, settled when that commits. */
  async function run<T>(mode: IDBTransactionMode, ask: (files: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const transaction = (await database()).transaction(FILES, mode);
    const request = ask(transaction.objectStore(FILES));
    return new Promise((resolve, reject) => {
      const failed = () => reject(transaction.error ?? new Error("The library couldn't be read or written"));
      transaction.addEventListener("complete", () => resolve(request.result));
      transaction.addEventListener("error", failed);
      transaction.addEventListener("abort", failed);
    });
  }

  return {
    async listFiles(path) {
      const keys = await run("readonly", (files) => files.getAllKeys());
      return filesUnder(keys.map(String), path);
    },
    async readText(path) {
      const text: unknown = await run("readonly", (files) => files.get(path));
      if (typeof text !== "string") throw new Error(`${path} isn't in the library`);
      return text;
    },
    writeText: async (path, text) => {
      await run("readwrite", (files) => files.put(text, path));
    },
    async readBytes(path) {
      const bytes: unknown = await run("readonly", (files) => files.get(path));
      // Structured cloning keeps the bytes a typed array, but not always one
      // of this realm's, so it is recognised by shape.
      if (!ArrayBuffer.isView(bytes)) throw new Error(`${path} isn't in the library`);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
    },
    writeBytes: async (path, bytes) => {
      await run("readwrite", (files) => files.put(bytes.slice(), path));
    },
    deleteFile: async (path) => {
      await run("readwrite", (files) => files.delete(path));
    },
  };
}

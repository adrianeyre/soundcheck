/**
 * Where the app-level library lives: outside any Project, so what is in it
 * loads into every Project (#50). It sits behind one interface so the
 * desktop app (the app-data folder) and the browser dev host (IndexedDB) both
 * fit behind it; `platform.ts` picks which.
 *
 * Paths are relative to the library and separated by "/" whatever the
 * platform, as a Project folder's are. Most files are text; a saved Kit's
 * samples are bytes (#51).
 */
export interface LibraryStorage {
  /**
   * Every file under `path`, as library-relative paths in order. A path with
   * nothing under it is empty, not an error.
   */
  listFiles: (path: string) => Promise<string[]>;
  /** Read a text file. Rejects if it isn't there. */
  readText: (path: string) => Promise<string>;
  /** Write a text file, replacing any that is there. */
  writeText: (path: string, text: string) => Promise<void>;
  /** Read a file's bytes, such as a saved Kit's sample. Rejects if it isn't there. */
  readBytes: (path: string) => Promise<Uint8Array>;
  /** Write a file's bytes, replacing any that is there. */
  writeBytes: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Delete a file. One that isn't there is already gone, which is not an error. */
  deleteFile: (path: string) => Promise<void>;
}

/** Everything under `path`, a folder, out of `paths`, in order. */
export function filesUnder(paths: Iterable<string>, path: string): string[] {
  const folder = path.replace(/\/+$/, "");
  const prefix = folder === "" ? "" : `${folder}/`;
  return [...paths].filter((file) => file.startsWith(prefix)).toSorted();
}

/** A library held in memory: for tests, and wherever there is nowhere to keep one. */
export function memoryLibraryStorage(files = new Map<string, string | Uint8Array>()): LibraryStorage {
  return {
    listFiles: async (path) => filesUnder(files.keys(), path),
    async readText(path) {
      const text = files.get(path);
      if (typeof text !== "string") throw new Error(`${path} isn't in the library`);
      return text;
    },
    writeText: async (path, text) => {
      files.set(path, text);
    },
    async readBytes(path) {
      const bytes = files.get(path);
      if (!(bytes instanceof Uint8Array)) throw new Error(`${path} isn't in the library`);
      return bytes.slice();
    },
    writeBytes: async (path, bytes) => {
      files.set(path, bytes.slice());
    },
    deleteFile: async (path) => {
      files.delete(path);
    },
  };
}

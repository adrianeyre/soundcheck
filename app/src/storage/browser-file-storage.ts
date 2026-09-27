/**
 * Project folders in the browser dev host, through the File System Access
 * API (Chromium only, as the PRD's [web] notes say). The desktop app is the
 * MVP (ADR 0002); this keeps `pnpm dev` able to save and open a Project.
 *
 * The API hands out folder handles rather than paths, so each chosen folder
 * is kept here under an id and the rest of the app never sees a path.
 */
import type { FileStorage, ProjectFolder } from "./file-storage";

/** As much of the File System Access API as a Project folder needs. */
interface Directory {
  readonly kind: "directory";
  readonly name: string;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FileEntry>;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<Directory>;
  values: () => AsyncIterableIterator<Directory | FileEntry>;
}

interface FileEntry {
  readonly kind: "file";
  readonly name: string;
  getFile: () => Promise<Blob>;
  createWritable: (options?: { keepExistingData?: boolean }) => Promise<{
    write: (data: Blob | string) => Promise<void>;
    seek: (position: number) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

const NEWLINE = 0x0a;

type Picker = (options?: { mode?: "read" | "readwrite" }) => Promise<Directory>;

function picker(): Picker | null {
  const found = (globalThis as { showDirectoryPicker?: Picker }).showDirectoryPicker;
  return typeof found === "function" ? found.bind(globalThis) : null;
}

/** Null where the browser has no File System Access API (Firefox, Safari). */
export function browserFileStorage(): FileStorage | null {
  const pick = picker();
  if (!pick) return null;

  const folders = new Map<string, Directory>();
  let nextId = 0;
  const remember = (directory: Directory, label: string): ProjectFolder => {
    const id = `folder-${nextId++}`;
    folders.set(id, directory);
    return { id, label };
  };
  const directory = (folder: ProjectFolder): Directory => {
    const found = folders.get(folder.id);
    if (!found) throw new Error(`${folder.label} is no longer open`);
    return found;
  };

  /** Walk a folder-relative path to the folder holding its last part. */
  const walk = async (folder: ProjectFolder, path: string, create: boolean) => {
    const parts = path.split("/").filter((part) => part.length > 0);
    const name = parts.pop();
    if (!name) throw new Error(`${path} is not a file in the Project folder`);
    let at = directory(folder);
    for (const part of parts) at = await at.getDirectoryHandle(part, { create });
    return { at, name };
  };

  const list = async (at: Directory, prefix: string): Promise<string[]> => {
    const files: string[] = [];
    for await (const entry of at.values()) {
      const path = `${prefix}${entry.name}`;
      if (entry.kind === "directory") files.push(...(await list(entry, `${path}/`)));
      else files.push(path);
    }
    return files.toSorted();
  };

  return {
    async chooseFolderToOpen() {
      const chosen = await pick({ mode: "readwrite" }).catch(() => null);
      return chosen && remember(chosen, chosen.name);
    },

    async chooseFolderToSave(suggestedName: string) {
      const parent = await pick({ mode: "readwrite" }).catch(() => null);
      if (!parent) return null;
      // The picker chooses where the Project goes; the Project's own folder
      // is made inside it, named after the Project.
      const chosen = await parent.getDirectoryHandle(suggestedName, { create: true });
      return remember(chosen, `${parent.name}/${suggestedName}`);
    },

    async readText(folder, path) {
      const { at, name } = await walk(folder, path, false);
      return (await (await at.getFileHandle(name)).getFile()).text();
    },

    async writeText(folder, path, text) {
      const { at, name } = await walk(folder, path, true);
      const writable = await (await at.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    },

    async readBytes(folder, path) {
      const { at, name } = await walk(folder, path, false);
      return new Uint8Array(await (await (await at.getFileHandle(name)).getFile()).arrayBuffer());
    },

    async writeBytes(folder, path, bytes) {
      const { at, name } = await walk(folder, path, true);
      const writable = await (await at.getFileHandle(name, { create: true })).createWritable();
      await writable.write(new Blob([bytes]));
      await writable.close();
    },

    async appendText(folder, path, text) {
      const { at, name } = await walk(folder, path, true);
      const file = await at.getFileHandle(name, { create: true });
      const { size } = await file.getFile();
      const writable = await file.createWritable({ keepExistingData: true });
      await writable.seek(size);
      await writable.write(text);
      await writable.close();
    },

    async readLines(folder, path, from) {
      const { at, name } = await walk(folder, path, false);
      const file = await (await at.getFileHandle(name)).getFile();
      const start = file.size < from ? 0 : from;
      const bytes = new Uint8Array(await file.slice(start).arrayBuffer());
      const whole = bytes.lastIndexOf(NEWLINE) + 1;
      return { text: new TextDecoder().decode(bytes.subarray(0, whole)), end: start + whole };
    },

    async listFiles(folder, path) {
      let at = directory(folder);
      const parts = path.split("/").filter((part) => part.length > 0);
      try {
        for (const part of parts) at = await at.getDirectoryHandle(part);
      } catch {
        return [];
      }
      return list(at, parts.length > 0 ? `${parts.join("/")}/` : "");
    },

    async copyFile(from, fromPath, to, toPath) {
      const source = await walk(from, fromPath, false);
      const blob = await (await source.at.getFileHandle(source.name)).getFile();
      const target = await walk(to, toPath, true);
      const writable = await (await target.at.getFileHandle(target.name, { create: true })).createWritable();
      await writable.write(blob);
      await writable.close();
    },
  };
}

/**
 * A `FileStorage` held in memory, for tests: every folder is a map of
 * folder-relative path to contents, so saving a Project, copying its folder
 * elsewhere and opening it again all happen without a disk.
 *
 * A file is text or bytes, whichever it was written as, and reads back as
 * either, as a real file does.
 */
import type { Bytes, FileStorage, Lines, ProjectFolder } from "./file-storage";

export function fakeFolder(id: string): ProjectFolder {
  return { id, label: id };
}

/** What a file holds: a WAV is bytes, `project.json` is text. */
type Contents = string | Bytes;

export class FakeFileStorage implements FileStorage {
  readonly folders = new Map<string, Map<string, Contents>>();
  /** What the choosers return, as the musician's choice would. */
  openChoice: ProjectFolder | null = null;
  saveChoice: ProjectFolder | null = null;
  /** Every name offered to the save chooser. */
  readonly suggested: string[] = [];

  /** Put a file in a folder, as anything outside the app would have. */
  add(id: string, path: string, contents: Contents): ProjectFolder {
    this.#at(id).set(path, contents);
    return fakeFolder(id);
  }

  /** Copy a whole folder, as copying it in a file manager would. */
  copyFolder(fromId: string, toId: string): ProjectFolder {
    this.folders.set(toId, new Map(this.#at(fromId)));
    return fakeFolder(toId);
  }

  /** Everything in a folder, in order. */
  files(id: string): string[] {
    return [...this.#at(id).keys()].toSorted();
  }

  chooseFolderToOpen(): Promise<ProjectFolder | null> {
    return Promise.resolve(this.openChoice);
  }

  chooseFolderToSave(suggestedName: string): Promise<ProjectFolder | null> {
    this.suggested.push(suggestedName);
    return Promise.resolve(this.saveChoice);
  }

  readText(folder: ProjectFolder, path: string): Promise<string> {
    const contents = this.#read(folder, path);
    return typeof contents === "string"
      ? Promise.resolve(contents)
      : contents.then((bytes) => new TextDecoder().decode(bytes));
  }

  writeText(folder: ProjectFolder, path: string, text: string): Promise<void> {
    this.#at(folder.id).set(path, text);
    return Promise.resolve();
  }

  readBytes(folder: ProjectFolder, path: string): Promise<Bytes> {
    const contents = this.#read(folder, path);
    return typeof contents === "string"
      ? Promise.resolve(new TextEncoder().encode(contents))
      : contents;
  }

  writeBytes(folder: ProjectFolder, path: string, bytes: Bytes): Promise<void> {
    this.#at(folder.id).set(path, Uint8Array.from(bytes));
    return Promise.resolve();
  }

  async appendText(folder: ProjectFolder, path: string, text: string): Promise<void> {
    const there = this.#at(folder.id).has(path) ? await this.readText(folder, path) : "";
    this.#at(folder.id).set(path, there + text);
  }

  async readLines(folder: ProjectFolder, path: string, from: number): Promise<Lines> {
    const bytes = await this.readBytes(folder, path);
    const start = bytes.length < from ? 0 : from;
    const rest = bytes.subarray(start);
    const whole = rest.lastIndexOf(0x0a) + 1;
    return { text: new TextDecoder().decode(rest.subarray(0, whole)), end: start + whole };
  }

  listFiles(folder: ProjectFolder, path: string): Promise<string[]> {
    const prefix = path === "" ? "" : `${path}/`;
    return Promise.resolve(this.files(folder.id).filter((file) => file.startsWith(prefix)));
  }

  async copyFile(
    from: ProjectFolder,
    fromPath: string,
    to: ProjectFolder,
    toPath: string,
  ): Promise<void> {
    const contents = this.#read(from, fromPath);
    this.#at(to.id).set(toPath, typeof contents === "string" ? contents : await contents);
  }

  /** A file's contents, or a rejection where there is no such file. */
  #read(folder: ProjectFolder, path: string): string | Promise<Bytes> {
    const contents = this.#at(folder.id).get(path);
    if (contents === undefined) return Promise.reject(new Error(`${path} is not in ${folder.id}`));
    return typeof contents === "string" ? contents : Promise.resolve(contents);
  }

  #at(id: string): Map<string, Contents> {
    let folder = this.folders.get(id);
    if (!folder) {
      folder = new Map();
      this.folders.set(id, folder);
    }
    return folder;
  }
}

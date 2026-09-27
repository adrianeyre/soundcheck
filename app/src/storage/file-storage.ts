/**
 * Where a Project's folder lives, behind one interface so the desktop app and
 * the browser dev host both fit behind it (ADR 0002: the desktop comes first).
 *
 * A Project is a folder holding `project.json`, the serialised Project, and an
 * `audio/` folder with a copy of every audio file the Project uses. The
 * Project's own data never names anything outside its folder: every path here
 * is relative to the folder and separated by "/" whatever the platform, so a
 * folder opens the same after being moved, copied or carried to another
 * machine.
 */

/**
 * The bytes of a file: a WAV, on the way to or from a pad. The buffer is a
 * plain `ArrayBuffer` and not a shared one, so a Blob will take it as it is.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Lines read from a file, and where they end in it, in bytes. */
export interface Lines {
  text: string;
  end: number;
}

/** A folder the musician has chosen. */
export interface ProjectFolder {
  /** How the platform names the folder: its path, on the desktop. */
  readonly id: string;
  /** What the musician is shown. */
  readonly label: string;
}

export interface FileStorage {
  /** Ask for a Project folder to open, or null if the musician cancels. */
  chooseFolderToOpen: () => Promise<ProjectFolder | null>;
  /**
   * Ask where to put a Project folder, creating it; null if the musician
   * cancels. `suggestedName` is offered as the folder's name.
   */
  chooseFolderToSave: (suggestedName: string) => Promise<ProjectFolder | null>;
  /** Read a text file in the folder. Rejects if it isn't there. */
  readText: (folder: ProjectFolder, path: string) => Promise<string>;
  /** Write a text file in the folder, making any folders it needs. */
  writeText: (folder: ProjectFolder, path: string, text: string) => Promise<void>;
  /**
   * Read a file in the folder as bytes, for the audio it holds. Rejects if
   * it isn't there.
   */
  readBytes: (folder: ProjectFolder, path: string) => Promise<Bytes>;
  /** Write a file of bytes in the folder, making any folders it needs. */
  writeBytes: (folder: ProjectFolder, path: string, bytes: Bytes) => Promise<void>;
  /**
   * Add text to the end of a file, making it and any folders it needs if it
   * isn't there: a Shared Project's file of Changes (ADR 0007), written a
   * line at a time and never rewritten.
   */
  appendText: (folder: ProjectFolder, path: string, text: string) => Promise<void>;
  /**
   * The whole lines of a text file from byte `from` on, and the byte after
   * them to read on from next time. A last line with no newline yet, still
   * being written or synced, waits for next time. A file now shorter than
   * `from` was written anew, and is read from its start. Rejects if it
   * isn't there.
   */
  readLines: (folder: ProjectFolder, path: string, from: number) => Promise<Lines>;
  /**
   * Every file under `path` — "" for the whole folder — as folder-relative
   * paths. A path that isn't there is empty, not an error.
   */
  listFiles: (folder: ProjectFolder, path: string) => Promise<string[]>;
  /** Copy a file between folders, or within one, making folders as needed. */
  copyFile: (from: ProjectFolder, fromPath: string, to: ProjectFolder, toPath: string) => Promise<void>;
}

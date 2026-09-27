/**
 * The sample browser's platform interface (#52): folders of samples on the
 * musician's machine, read in place, and auditioned straight to the audio
 * output. `platform.ts` picks the implementation: the desktop app reads
 * folders through the Tauri shell, and the browser dev host through the File
 * System Access API, or a folder input where there is none.
 *
 * Which folders the musician has added is not the platform's: it is kept in
 * the app-level library (`sample-folders.ts`), so it is remembered app-wide.
 */
import type { Bytes } from "../storage/file-storage";

/** A folder the musician has added. */
export interface SampleFolder {
  /** How the platform names the folder: its path on the desktop, an id for its handle in the browser. */
  readonly id: string;
  /** What the musician is shown. */
  readonly label: string;
}

/** One file in a sample folder: which folder, and where in it. */
export interface SampleRef {
  folder: SampleFolder;
  /** Relative to the folder, separated by "/". */
  path: string;
}

export interface SampleSource {
  /** Ask for a folder to add, or null if the musician cancels. */
  chooseFolder: () => Promise<SampleFolder | null>;
  /** Every audio file in the folder and the folders inside it, as folder-relative paths in order. */
  listAudio: (folder: SampleFolder) => Promise<string[]>;
  /** A file's bytes, for copying into the Project. */
  readBytes: (sample: SampleRef) => Promise<Bytes>;
  /**
   * Play a file once, straight to the audio output at a fixed preview
   * level, past the mixer, so it is never in the mix or an export. Rejects
   * with the reason where it can't: no audio running, or not audio at all.
   */
  audition: (sample: SampleRef) => Promise<void>;
  stopAudition: () => Promise<void>;
  /**
   * Hear when an audition plays to its end, where the platform can tell;
   * returns how to stop listening. Without it, the browser shows a sample
   * playing until it is stopped or another is auditioned.
   */
  onAuditionEnd?: (listener: () => void) => () => void;
}

/** The name at the end of a path, whichever separator it uses. */
export function lastName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
}

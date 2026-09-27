/**
 * **Stem Separation**: some audio in, its four **Stems** out, behind a
 * platform interface (ADR 0005). The desktop app runs htdemucs on ONNX
 * Runtime in the Tauri shell (`desktop/src/stems.rs`); the Browser Version
 * runs it on ONNX Runtime Web in a Web Worker (`browser-stem-separator.ts`).
 * Both cut the song into chunks and cross-fade the Stems with the engine's
 * `StemSeparation`, so they give the same Stems.
 *
 * The model is never downloaded or bundled, as its weights are for personal
 * use only: the musician exports `htdemucs.onnx` themselves and installs it
 * from that file, once, outside any Project.
 */

/** htdemucs' Stems, in the order they come out. Matches `SOURCES` in `desktop/src/stems.rs`. */
export const STEM_NAMES = ["drums", "bass", "other", "vocals"] as const;
export type StemName = (typeof STEM_NAMES)[number];

/** The rate the Stems come out at, whatever the source's: the engine resamples every file it loads. */
export const STEM_SAMPLE_RATE = 44_100;

export interface Stem {
  name: StemName;
  /** A stereo 32-bit float WAV file at `STEM_SAMPLE_RATE`. */
  wav: Uint8Array;
}

/** Whether separation can run here, and if its model is installed. */
export type SeparatorStatus =
  | { kind: "unavailable"; reason: string }
  | { kind: "notInstalled" }
  | { kind: "installed" };

/** A model file the musician has chosen to install. */
export interface ModelFile {
  /** What the musician is shown: its path, on the desktop. */
  readonly label: string;
}

/**
 * What a separation is doing, for the musician to see: reading the audio,
 * loading the model, running it on the song's chunks, then making the four
 * Stems' files. A separator that can't tell reports only progress.
 */
export type SeparationStage = "reading" | "loadingModel" | "separating" | "finishing";

export interface SeparationOptions {
  /** How far the separation has got, 0 to 1. */
  onProgress: (fraction: number) => void;
  /** Each stage as it starts, in order, where the separator can tell. */
  onStage?: (stage: SeparationStage) => void;
  /** Aborting cancels the separation, and nothing comes back. */
  signal: AbortSignal;
}

export interface StemSeparator {
  /** Where the installed model is kept, as the musician is told when offered to install it. */
  readonly modelKeptIn?: string;
  status(): Promise<SeparatorStatus>;
  /**
   * An `htdemucs.onnx` the musician exported where this platform looks first,
   * the repo's `model/` folder (`pnpm htdemucs:export` writes it there), or
   * null if there isn't one there. Not yet checked: installing it does. A
   * platform that can't look anywhere hasn't this.
   */
  findModel?(): Promise<ModelFile | null>;
  /** Ask for the musician's `htdemucs.onnx`, or null if they cancel. */
  chooseModelFile(): Promise<ModelFile | null>;
  /**
   * Check the file is htdemucs and install it, replacing any installed
   * model. Rejects, saying why, when it isn't: the model already installed
   * stays as it was.
   */
  installModel(file: ModelFile): Promise<void>;
  /**
   * Separate an audio file (WAV, FLAC or MP3; mono is separated as stereo)
   * into its four Stems, in `STEM_NAMES`' order, or null if cancelled. One
   * separation runs at a time: rejects while another does, and when there
   * is no model installed.
   */
  separate(audio: Uint8Array, options: SeparationOptions): Promise<Stem[] | null>;
}

/** A platform with no Stem Separation: says so, and refuses everything. */
export function unavailableStemSeparator(reason: string): StemSeparator {
  const refuse = () => Promise.reject(new Error(reason));
  return {
    status: () => Promise.resolve({ kind: "unavailable", reason }),
    chooseModelFile: refuse,
    installModel: refuse,
    separate: refuse,
  };
}

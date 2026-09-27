/**
 * A Stem Separation for tests, in memory: no model, no shell. It behaves as
 * the desktop's does from the outside (one separation at a time, progress
 * from 0 to 1, cancelling returns nothing, a model file refused with a
 * reason), so the UI built on `StemSeparator` can be tested without either.
 */
import { STEM_NAMES, type ModelFile, type Stem, type StemName, type StemSeparator } from "./stem-separator";

export interface FakeStemSeparatorOptions {
  /** Whether a model is installed to begin with. */
  installed?: boolean;
  /** What the file chooser picks, or null for the musician cancelling it. */
  chosen?: string | null;
  /** A model found where the app looks first, without asking; by default, none. */
  found?: string | null;
  /** How many steps a separation reports progress in. */
  steps?: number;
  /** Awaited between steps; a test can hold a separation here. */
  between?: () => Promise<void>;
  /** Each Stem's WAV file; by default, the audio it was given. */
  stem?: (audio: Uint8Array, name: StemName) => Uint8Array;
}

export interface FakeStemSeparator extends StemSeparator {
  /** Every model file installed, by label. */
  readonly installs: string[];
  /** Every audio file separated, cancelled or not. */
  readonly separations: Uint8Array[];
}

/** Why the fake refuses a file: any whose name isn't htdemucs.onnx. */
export const FAKE_REFUSAL = "This isn't htdemucs: its output is f32 [1, 6, 2, 343980].";

export function fakeStemSeparator({
  installed = false,
  chosen = "htdemucs.onnx",
  found = null,
  steps = 4,
  between = () => Promise.resolve(),
  stem = (audio) => audio,
}: FakeStemSeparatorOptions = {}): FakeStemSeparator {
  const installs: string[] = [];
  const separations: Uint8Array[] = [];
  let running = false;
  return {
    installs,
    separations,

    status: () => Promise.resolve(installed ? { kind: "installed" } : { kind: "notInstalled" }),

    findModel: () => Promise.resolve(found === null ? null : ({ label: found } satisfies ModelFile)),

    chooseModelFile: () => Promise.resolve(chosen === null ? null : ({ label: chosen } satisfies ModelFile)),

    async installModel(file) {
      if (!/(^|[/\\])htdemucs\.onnx$/.test(file.label)) throw new Error(FAKE_REFUSAL);
      installs.push(file.label);
      installed = true;
    },

    async separate(audio, { onProgress, onStage, signal }) {
      if (!installed) throw new Error("The Stem Separation model isn't installed.");
      if (running) throw new Error("A Stem Separation is already running; wait for it or cancel it.");
      running = true;
      separations.push(audio);
      try {
        onStage?.("reading");
        onStage?.("loadingModel");
        onStage?.("separating");
        for (let step = 0; step < steps; step++) {
          if (signal.aborted) return null;
          onProgress(step / steps);
          await between();
        }
        if (signal.aborted) return null;
        onStage?.("finishing");
        onProgress(1);
        return STEM_NAMES.map((name): Stem => ({ name, wav: stem(audio, name) }));
      } finally {
        running = false;
      }
    },
  };
}

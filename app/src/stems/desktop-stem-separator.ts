/**
 * Stem Separation on the desktop: the Tauri shell (`desktop/src/stems.rs`)
 * checks and installs the model, and separates on a worker thread, off the
 * UI and audio threads. Progress is polled over IPC, as a mix export's is.
 */
import type { Invoke } from "../audio/desktop-audio-output";
import type { ModelFile, StemName, StemSeparator } from "./stem-separator";

/** How often to ask how far the separation has got. */
export const PROGRESS_MS = 250;

interface DesktopModelFile extends ModelFile {
  readonly path: string;
}

/** The shell rejects with its reason as a string; this makes it an Error. */
function saying(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

export function desktopStemSeparator(invoke: Invoke): StemSeparator {
  const cancel = () => void invoke("stems_cancel");
  return {
    modelKeptIn: "the app's own folder, outside any Project",
    async status() {
      const installed = await invoke<boolean>("stems_model_installed").catch(saying);
      return installed ? { kind: "installed" } : { kind: "notInstalled" };
    },

    async findModel() {
      const path = await invoke<string | null>("stems_find_model").catch(() => null);
      return path === null ? null : ({ label: path, path } satisfies DesktopModelFile);
    },

    async chooseModelFile() {
      const path = await invoke<string | null>("stems_choose_model");
      return path === null ? null : ({ label: path, path } satisfies DesktopModelFile);
    },

    async installModel(file) {
      const { path } = file as DesktopModelFile;
      await invoke("stems_install_model", { path }).catch(saying);
    },

    async separate(audio, { onProgress, onStage, signal }) {
      signal.addEventListener("abort", cancel);
      // The shell reads the audio and loads the model before its first
      // chunk, and says only how far it has got: past zero, it's separating.
      onStage?.("loadingModel");
      let separating = false;
      const poll = setInterval(() => {
        // A cancel that reached the shell before its separation started
        // stopped nothing, so it is sent again until the separation ends.
        if (signal.aborted) return cancel();
        void invoke<number>("stems_progress").then((fraction) => {
          if (!separating && fraction > 0) {
            separating = true;
            onStage?.("separating");
          }
          onProgress(fraction);
        }, () => {});
      }, PROGRESS_MS);
      try {
        if (signal.aborted) return null;
        // The file as the request's raw body, not a JSON list of numbers.
        const names = await invoke<StemName[] | null>("stems_separate", audio).catch(saying);
        // Aborted too late to stop the shell: nothing comes back all the same.
        if (names === null || signal.aborted) return null;
        onStage?.("finishing");
        // Each Stem as raw bytes, one at a time: a song's are ~60 MB each.
        const stems = [];
        for (const [index, name] of names.entries()) {
          stems.push({ name, wav: new Uint8Array(await invoke<ArrayBuffer>("stems_take", { index })) });
        }
        onProgress(1);
        return stems;
      } finally {
        clearInterval(poll);
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}

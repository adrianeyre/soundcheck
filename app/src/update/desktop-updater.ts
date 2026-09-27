/**
 * Updates on the desktop: the Tauri shell (`desktop/src/update.rs`) checks
 * the latest Release and installs through Tauri's updater. The download's
 * progress is polled over IPC, as a mix export's is.
 */
import type { Invoke } from "../audio/desktop-audio-output";
import type { FoundUpdate, Updater, UpdateStatus } from "./updater";

/** How often to ask how far the download has got. */
export const PROGRESS_MS = 250;

/** The shell rejects with its reason as a string; this makes it an Error. */
function saying(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

export function desktopUpdater(invoke: Invoke): Updater {
  return {
    status: () => invoke<UpdateStatus>("update_status").catch(saying),
    check: () => invoke<FoundUpdate | null>("update_check").catch(saying),
    async install(onProgress) {
      const poll = setInterval(() => void invoke<number>("update_progress").then(onProgress, () => {}), PROGRESS_MS);
      try {
        await invoke("update_install").catch(saying);
      } finally {
        clearInterval(poll);
      }
    },
  };
}

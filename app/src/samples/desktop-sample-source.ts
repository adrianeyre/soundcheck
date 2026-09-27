/**
 * The sample browser on the desktop: folders on disk, read through the Tauri
 * shell (`desktop/src/samples.rs`), which resolves every path inside the
 * folder and refuses anything that would leave it. Auditioning goes to the
 * native engine's host, which adds the file to the output past the mixer.
 */
import type { Invoke } from "../audio/desktop-audio-output";
import { lastName, type SampleSource } from "./sample-source";

export function desktopSampleSource(invoke: Invoke): SampleSource {
  return {
    async chooseFolder() {
      const path = await invoke<string | null>("samples_choose_folder");
      return path === null ? null : { id: path, label: lastName(path) };
    },
    listAudio: (folder) => invoke<string[]>("samples_list_audio", { folder: folder.id }),
    async readBytes({ folder, path }) {
      // Tauri's IPC is JSON, so the bytes arrive as a list of numbers.
      return Uint8Array.from(await invoke<number[]>("project_read_bytes", { folder: folder.id, path }));
    },
    audition: async ({ folder, path }) => {
      await invoke("audio_audition", { folder: folder.id, path });
    },
    stopAudition: async () => {
      await invoke("audio_audition_stop");
    },
  };
}

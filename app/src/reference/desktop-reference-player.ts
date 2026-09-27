/**
 * The Reference Track on the desktop: chosen in the system's file dialog
 * and read by the Tauri shell, and auditioned by the native engine's host,
 * which adds it to the output past the mixer and the meters.
 */
import type { Invoke } from "../audio/desktop-audio-output";
import type { ReferencePlayer } from "./reference-player";

export function desktopReferencePlayer(invoke: Invoke): ReferencePlayer {
  return {
    // Tauri's IPC is JSON, so the bytes arrive as a list of numbers, as
    // the UI holds them.
    chooseFile: () => invoke<{ name: string; bytes: number[] } | null>("reference_choose_file"),
    audition: async (sample, gain) => {
      await invoke("audio_audition_reference", { bytes: sample.bytes, gain });
    },
    stopAudition: async () => {
      await invoke("audio_audition_stop");
    },
  };
}

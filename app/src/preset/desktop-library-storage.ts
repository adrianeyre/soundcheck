/**
 * The library on the desktop: a folder in the app-data folder, reached
 * through the Tauri shell (`desktop/src/library.rs`), which resolves every
 * path inside it and refuses anything that would leave it.
 */
import type { Invoke } from "../audio/desktop-audio-output";
import type { LibraryStorage } from "./library-storage";

export function desktopLibraryStorage(invoke: Invoke): LibraryStorage {
  return {
    listFiles: (path) => invoke<string[]>("library_list_files", { path }),
    readText: (path) => invoke<string>("library_read_text", { path }),
    writeText: async (path, text) => {
      await invoke("library_write_text", { path, text });
    },
    // Tauri's IPC is JSON, so bytes cross it as a list of numbers.
    readBytes: async (path) => Uint8Array.from(await invoke<number[]>("library_read_bytes", { path })),
    writeBytes: async (path, bytes) => {
      await invoke("library_write_bytes", { path, bytes: [...bytes] });
    },
    deleteFile: async (path) => {
      await invoke("library_delete_file", { path });
    },
  };
}

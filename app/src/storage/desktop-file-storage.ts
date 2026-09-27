/**
 * Project folders on the desktop: the real filesystem, reached through the
 * Tauri shell (`desktop/src/project_files.rs`), which resolves every path
 * against the chosen folder and refuses anything that would leave it.
 */
import type { Invoke } from "../audio/desktop-audio-output";
import type { FileStorage, Lines, ProjectFolder } from "./file-storage";

function folderAt(path: string | null): ProjectFolder | null {
  return path === null ? null : { id: path, label: path };
}

export function desktopFileStorage(invoke: Invoke): FileStorage {
  return {
    async chooseFolderToOpen() {
      return folderAt(await invoke<string | null>("project_choose_folder", { mode: "open", name: null }));
    },

    async chooseFolderToSave(suggestedName: string) {
      return folderAt(
        await invoke<string | null>("project_choose_folder", { mode: "save", name: suggestedName }),
      );
    },

    readText: (folder, path) => invoke<string>("project_read_text", { folder: folder.id, path }),

    writeText: async (folder, path, text) => {
      await invoke("project_write_text", { folder: folder.id, path, text });
    },

    async readBytes(folder, path) {
      // Tauri's IPC is JSON, so the bytes arrive as a list of numbers.
      return Uint8Array.from(await invoke<number[]>("project_read_bytes", { folder: folder.id, path }));
    },

    writeBytes: async (folder, path, bytes) => {
      await invoke("project_write_bytes", { folder: folder.id, path, bytes: [...bytes] });
    },

    appendText: async (folder, path, text) => {
      await invoke("project_append_text", { folder: folder.id, path, text });
    },

    readLines: (folder, path, from) => invoke<Lines>("project_read_lines", { folder: folder.id, path, from }),

    listFiles: (folder, path) => invoke<string[]>("project_list_files", { folder: folder.id, path }),

    copyFile: async (from, fromPath, to, toPath) => {
      await invoke("project_copy_file", {
        fromFolder: from.id,
        fromPath,
        toFolder: to.id,
        toPath,
      });
    },
  };
}

/**
 * Exporting on the desktop: the Tauri shell (`desktop/src/export.rs`) shows
 * the save dialog, renders on an Engine of its own on a worker thread, never
 * the audio thread, and writes the file. Progress is polled over IPC.
 */
import { forShell, type Invoke } from "../audio/desktop-audio-output";
import { type ClipExportRequest, EXTENSIONS, type ExportFolder, type ExportOptions, type ExportTarget, type MixExporter } from "./mix-exporter";

/** How often to ask how far the export has got. */
export const PROGRESS_MS = 100;

interface DesktopTarget extends ExportTarget {
  readonly path: string;
}

interface DesktopFolder extends ExportFolder {
  readonly path: string;
}

/**
 * `name.extension` in the folder at `path`, with the separator the path
 * already uses: Windows reads either, and the musician is shown theirs.
 */
export function pathIn(path: string, name: string, extension: string): string {
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const folder = path.endsWith(separator) ? path.slice(0, -1) : path;
  return `${folder}${separator}${name}.${extension}`;
}

/**
 * `export_clip`'s raw body, as `read_clip_body` in `desktop/src/export.rs`
 * reads it: the JSON's byte length as four little-endian bytes, the JSON
 * (the path and the request), then the audio file.
 */
export function clipBody(path: string, { audio, ...request }: ClipExportRequest): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ path, request }));
  const body = new Uint8Array(4 + json.length + audio.length);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  body.set(audio, 4 + json.length);
  return body;
}

export function desktopMixExporter(invoke: Invoke): MixExporter {
  const cancel = () => void invoke("export_cancel");

  /** Run `write`, polling its progress, with the signal cancelling it. */
  const watched = async ({ onProgress, signal }: ExportOptions, write: () => Promise<boolean>) => {
    signal.addEventListener("abort", cancel);
    const poll = setInterval(() => {
      // A cancel that reached the shell before its export started stopped
      // nothing, so it is sent again until the export ends.
      if (signal.aborted) return cancel();
      void invoke<number>("export_progress").then(onProgress, () => {});
    }, PROGRESS_MS);
    try {
      if (signal.aborted) return false;
      const written = await write();
      if (written) onProgress(1);
      return written;
    } finally {
      clearInterval(poll);
      signal.removeEventListener("abort", cancel);
    }
  };

  return {
    async chooseFile(suggestedName, kind, subject = "mix") {
      const args = subject === "clip" ? { name: suggestedName, kind, clip: true } : { name: suggestedName, kind };
      const path = await invoke<string | null>("export_choose_file", args);
      return path === null ? null : ({ label: path, path } satisfies DesktopTarget);
    },

    async chooseFolder() {
      const path = await invoke<string | null>("export_choose_folder");
      return path === null ? null : ({ label: path, path } satisfies DesktopFolder);
    },

    fileIn(folder, name, kind) {
      const path = pathIn((folder as DesktopFolder).path, name, EXTENSIONS[kind]);
      return Promise.resolve({ label: path, path } satisfies DesktopTarget);
    },

    exportMix(target, request, options) {
      const { path } = target as DesktopTarget;
      return watched(options, () =>
        invoke<boolean>("export_mix", {
          path,
          request: { ...request, commands: request.commands.map(forShell) },
        }),
      );
    },

    exportClip(target, request, options) {
      const { path } = target as DesktopTarget;
      // The audio file as the request's raw body, not a JSON list of numbers.
      return watched(options, () => invoke<boolean>("export_clip", clipBody(path, request)));
    },
  };
}

/**
 * Where a recording of the DJ mix is saved, behind one interface so each
 * platform saves it its own way (`platform.ts` picks): the Desktop App asks
 * with the system's save dialog and writes the file itself; the Browser
 * Version uses the File System Access API's save dialog or, in a browser
 * without one, downloads it, as an export does.
 */
import type { Invoke } from "../audio/desktop-audio-output";

export type RecordingKind = "wav" | "mp3";

export interface DjRecordingSaver {
  /** Save `bytes` as `name`.wav or .mp3; answers where, or null if the DJ cancelled. */
  save(name: string, kind: RecordingKind, bytes: Uint8Array): Promise<string | null>;
}

const MIME: Record<RecordingKind, string> = { wav: "audio/wav", mp3: "audio/mpeg" };

type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ name: string; createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }>;

export function browserRecordingSaver(): DjRecordingSaver {
  return {
    async save(name, kind, bytes) {
      const file = `${name}.${kind}`;
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME[kind] });
      const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
      if (typeof picker === "function") {
        try {
          const handle = await picker.call(globalThis, {
            suggestedName: file,
            types: [{ description: kind === "wav" ? "WAV audio" : "MP3 audio", accept: { [MIME[kind]]: [`.${kind}`] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return handle.name;
        } catch (reason) {
          if (reason instanceof DOMException && reason.name === "AbortError") return null;
          throw reason;
        }
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return file;
    },
  };
}

export function desktopRecordingSaver(invoke: Invoke): DjRecordingSaver {
  return {
    async save(name, kind, bytes) {
      const path = await invoke<string | null>("export_choose_file", { name, kind });
      if (path === null) return null;
      await invoke("dj_save_recording", { path, bytes: [...bytes] });
      return path;
    },
  };
}

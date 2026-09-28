/**
 * Exporting in the browser dev host: the WASM engine renders on the main
 * thread, a step at a time so the page can show progress and cancel between
 * steps, and the file goes where the File System Access API's save dialog
 * says or, in a browser without one, downloads. The desktop app is the MVP
 * (ADR 0002); this keeps `pnpm dev` able to export.
 */
import init, { ClipRender, encode_mp3, encode_wav, Engine } from "@engine";

import { applyEngineCommand } from "../audio/apply-engine-command";
import { WasmPluginHost } from "../plugin/wasm-plugin-runtime";
import type { EngineCommand } from "../audio/audio-output";
import type { Bytes } from "../storage/file-storage";
import {
  type ClipExportRequest,
  type Encoding,
  type ExportKind,
  type ExportOptions,
  type ExportFolder,
  type ExportRequest,
  type ExportTarget,
  EXTENSIONS,
  type MixExporter,
  TAIL_SECONDS,
} from "./mix-exporter";

/** How each kind of file is offered in the save dialog and typed as it downloads. */
const FILE_TYPES: Record<ExportKind, { description: string; mime: string }> = {
  wav: { description: "WAV audio", mime: "audio/wav" },
  mp3: { description: "MP3 audio", mime: "audio/mpeg" },
};

/** Frames rendered between progress reports: a quarter of a second. */
const STEP = 12_000;

/** As much of the File System Access API as saving one file needs. */
interface FileHandle {
  readonly name: string;
  createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
}

/** As much of a folder's handle as writing files into it needs. */
interface FolderHandle {
  readonly name: string;
  getFileHandle: (name: string, options: { create: boolean }) => Promise<FileHandle>;
}

type FolderPicker = (options: { mode: "readwrite" }) => Promise<FolderHandle>;

type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileHandle>;

interface BrowserTarget extends ExportTarget {
  /** Null to download the file instead. */
  readonly handle: FileHandle | null;
  readonly kind: ExportKind;
}

interface BrowserFolder extends ExportFolder {
  /** Null to download each file instead. */
  readonly handle: FolderHandle | null;
}

function folderPicker(): FolderPicker | null {
  const found = (globalThis as { showDirectoryPicker?: FolderPicker }).showDirectoryPicker;
  return typeof found === "function" ? found.bind(globalThis) : null;
}

function savePicker(): SavePicker | null {
  const found = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  return typeof found === "function" ? found.bind(globalThis) : null;
}

/**
 * Commands that mean nothing to an offline render: the keyboard, recording
 * and the transport, which the render drives itself.
 */
const LIVE_ONLY: ReadonlySet<EngineCommand["type"]> = new Set([
  "noteOn",
  "noteOff",
  "setPatternPlaying",
  "setLatencyTest",
  "setLiveTrack",
  "setRecording",
  "play",
  "stop",
  "seek",
  "setLoop",
  "setMetronome",
  // The DJ Mixer is never in an export of the song (ADR 0013).
  "djSet",
]);

/**
 * Give an Engine that isn't playing live what one command says about the
 * Project, exactly as the playing engine hears it.
 */
export function applyCommand(engine: Engine, command: EngineCommand, plugins?: WasmPluginHost): void {
  if (!LIVE_ONLY.has(command.type)) applyEngineCommand(engine, command, plugins);
}

/** `audio`, interleaved stereo at `sampleRate`, as a file's bytes. */
function encode(audio: Float32Array, sampleRate: number, encoding: Encoding): Uint8Array {
  if (encoding.kind === "mp3") return encode_mp3(audio, sampleRate, encoding.kbps);
  const wav = encode_wav(audio, sampleRate, encoding.bits);
  if (!wav) throw new Error(`${encoding.bits}-bit WAV isn't offered`);
  return wav;
}

/**
 * Render `request` as a WAV or MP3 file's bytes on an Engine of its own, or
 * null if the signal aborts first. The WASM engine must be initialised.
 */
export async function renderMix(request: ExportRequest, options: ExportOptions): Promise<Bytes | null> {
  const engine = new Engine(request.sampleRate);
  try {
    const plugins = new WasmPluginHost(request.sampleRate);
    for (const command of request.commands) applyCommand(engine, command, plugins);
    const range = engine.start_render(request.startTick, request.endTick, TAIL_SECONDS);
    // The tail's length isn't known until it ends, so it counts as done.
    const audio = await renderSteps(range, (frames) => engine.render_next(frames), options);
    return audio && encoded(audio, request.sampleRate, request.encoding, options);
  } finally {
    engine.free();
  }
}

/**
 * Render one Audio Clip's own audio, the stretch of its file it plays, as a
 * WAV or MP3 file's bytes, or null if the signal aborts first. The WASM
 * engine must be initialised.
 */
export async function renderClip(request: ClipExportRequest, options: ExportOptions): Promise<Bytes | null> {
  const clip = new ClipRender(request.audio, request.fileOffset, request.duration, request.sampleRate);
  try {
    const audio = await renderSteps(clip.frames(), (frames) => clip.render_next(frames), options);
    return audio && encoded(audio, request.sampleRate, request.encoding, options);
  } finally {
    clip.free();
  }
}

/**
 * Render `next` step by step until it gives nothing more, reporting how far
 * it has got against `expected` frames, and letting the page draw that and
 * hear a cancel between steps. Null if the signal aborts first.
 */
async function renderSteps(
  expected: number,
  next: (frames: number) => Float32Array,
  { onProgress, signal }: ExportOptions,
): Promise<Float32Array | null> {
  const steps: Float32Array[] = [];
  let frames = 0;
  for (;;) {
    onProgress(Math.min(frames / Math.max(expected, 1), 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (signal.aborted) return null;
    const step = next(STEP);
    if (step.length === 0) break;
    steps.push(step);
    frames += step.length / 2;
  }
  const audio = new Float32Array(frames * 2);
  let offset = 0;
  for (const step of steps) {
    audio.set(step, offset);
    offset += step.length;
  }
  return audio;
}

function encoded(audio: Float32Array, sampleRate: number, encoding: Encoding, { onProgress }: ExportOptions): Bytes {
  const file = encode(audio, sampleRate, encoding);
  onProgress(1);
  return new Uint8Array(file);
}

function download(bytes: Bytes, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // After the click has handed the file over.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Write `file` where the musician chose, or download it. */
async function save({ handle, label, kind }: BrowserTarget, file: Bytes) {
  const { mime } = FILE_TYPES[kind];
  if (!handle) return download(file, label, mime);
  const writable = await handle.createWritable();
  await writable.write(new Blob([file], { type: mime }));
  await writable.close();
}

export function browserMixExporter(): MixExporter {
  return {
    async chooseFile(suggestedName, kind) {
      const pick = savePicker();
      const extension = EXTENSIONS[kind];
      const name = `${suggestedName}.${extension}`;
      if (!pick) return { label: name, handle: null, kind } satisfies BrowserTarget;
      const { description, mime } = FILE_TYPES[kind];
      try {
        const handle = await pick({
          suggestedName: name,
          types: [{ description, accept: { [mime]: [`.${extension}`] } }],
        });
        return { label: handle.name, handle, kind } satisfies BrowserTarget;
      } catch (error) {
        // Closing the dialog rejects with an AbortError.
        if (error instanceof DOMException && error.name === "AbortError") return null;
        throw error;
      }
    },

    async chooseFolder() {
      const pick = folderPicker();
      // Without a folder picker, each file downloads.
      if (!pick) return { label: "Downloads", handle: null } satisfies BrowserFolder;
      try {
        const handle = await pick({ mode: "readwrite" });
        return { label: handle.name, handle } satisfies BrowserFolder;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return null;
        throw error;
      }
    },

    async fileIn(folder, name, kind) {
      const { handle } = folder as BrowserFolder;
      const file = `${name}.${EXTENSIONS[kind]}`;
      if (!handle) return { label: file, handle: null, kind } satisfies BrowserTarget;
      return { label: `${handle.name}/${file}`, handle: await handle.getFileHandle(file, { create: true }), kind } satisfies BrowserTarget;
    },

    async exportMix(target, request, options) {
      await init();
      const file = await renderMix(request, options);
      if (!file) return false;
      await save(target as BrowserTarget, file);
      return true;
    },

    async exportClip(target, request, options) {
      await init();
      const file = await renderClip(request, options);
      if (!file) return false;
      await save(target as BrowserTarget, file);
      return true;
    },
  };
}

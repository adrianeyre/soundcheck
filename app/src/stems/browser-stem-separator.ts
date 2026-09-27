/**
 * Stem Separation in the Browser Version (ADR 0005, ADR 0006): htdemucs on
 * ONNX Runtime Web in a Web Worker, off the UI and audio threads, with
 * WebGPU where the browser has it and WebAssembly on the CPU elsewhere. The
 * math around the model is the engine's, the same as the Desktop App's.
 *
 * The musician picks the `htdemucs.onnx` they exported; it is checked by
 * its shapes and kept in the site's own storage (`stem-model-store.ts`),
 * outside any Project, so it survives a reload. Each separation starts a
 * worker and ends it after, which cancels it at once and gives back its
 * memory: the model takes about 3 GB of it while it runs.
 */
import type { FromStemWorker, ToStemWorker } from "./stem-worker-core";
import type { StemModelStore } from "./stem-model-store";
import { STEM_NAMES, type ModelFile, type SeparationStage, type SeparatorStatus, type StemSeparator } from "./stem-separator";

/** What a Stem Separation worker is to the page, so tests can run one in-process. */
export interface StemWorker {
  postMessage(message: ToStemWorker): void;
  addEventListener(type: "message", listener: (event: { data: FromStemWorker }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  terminate(): void;
}

/** What the browser can do, which says whether separation can run here. */
export interface BrowserCapabilities {
  webAssembly: boolean;
  /** A WebGPU adapter to run the model on. */
  webGpu: boolean;
  /** WebAssembly threads, which need the page to be cross-origin isolated. */
  threads: boolean;
  /** `navigator.deviceMemory`, in GB, where the browser says (Chromium only). */
  memoryGb: number | undefined;
}

export interface BrowserStemSeparatorOptions {
  /** Where the model is kept, or null where the browser has no storage for it. */
  store: StemModelStore | null;
  startWorker: () => StemWorker;
  capabilities: () => Promise<BrowserCapabilities>;
  /** Ask for the model file; null if the musician cancels. */
  pick?: () => Promise<File | null>;
  /** Ask the browser not to evict the site's storage, where it may. */
  persist?: () => Promise<boolean>;
  /** Fetch the model the page's own server has, or null: `pnpm dev`'s serves the repo's `model/`. */
  fetchModel?: () => Promise<File | null>;
}

/** Where `pnpm dev` serves the repo's `model/htdemucs.onnx`, beside the page. Never deployed: see ADR 0005. */
export const SERVED_MODEL = "model/htdemucs.onnx";

/** Whether a response is a model, and not (say) a server's HTML page for every path. */
const isModel = (response: Response) =>
  response.ok && !(response.headers.get("Content-Type") ?? "").startsWith("text/");

/**
 * The model the page's own server has at `SERVED_MODEL`, or null. The dev
 * server serves the repo's `model/` folder there; GitHub Pages never has
 * it, as the weights mustn't be published, so there it's a 404 and the
 * musician is asked for the file. A HEAD first, so a missing model costs
 * nothing, and anything but a model (an HTML page, say) is ignored.
 */
export async function fetchServedModel(fetcher: typeof fetch = globalThis.fetch): Promise<File | null> {
  try {
    if (!isModel(await fetcher(SERVED_MODEL, { method: "HEAD" }))) return null;
    const response = await fetcher(SERVED_MODEL);
    if (!isModel(response)) return null;
    return new File([await response.blob()], "htdemucs.onnx");
  } catch {
    return null;
  }
}

/** Separating needs about 3 GB with the real model in ONNX Runtime Web (measured in Node); less than 4 won't do. */
export const MIN_MEMORY_GB = 4;

interface BrowserModelFile extends ModelFile {
  readonly file: File;
}

/** Why this browser can't separate Stems, or null if it can. */
export function whyUnavailable(capabilities: BrowserCapabilities, store: StemModelStore | null): string | null {
  if (!capabilities.webAssembly) return "Stem Separation needs WebAssembly, which this browser doesn't have. The Desktop App can separate Stems.";
  if (!store) {
    return "This browser has no storage for the site to keep Stem Separation's model in (a private window may have none). The Desktop App can separate Stems.";
  }
  if (capabilities.memoryGb !== undefined && capabilities.memoryGb < MIN_MEMORY_GB) {
    return `Stem Separation in a browser needs about ${MIN_MEMORY_GB} GB of memory, and this computer says it has ${capabilities.memoryGb} GB. The Desktop App can separate Stems.`;
  }
  if (!capabilities.webGpu && !capabilities.threads) {
    return "This browser has neither WebGPU nor WebAssembly threads here, and without one a song takes too long to separate. Current Chrome, Edge, Firefox and Safari have WebGPU on Windows and macOS; the Desktop App can separate Stems too.";
  }
  return null;
}

/** Ask for an `.onnx` file with a file input; null if the musician cancels. */
export function pickModelFile(document: Document = globalThis.document): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".onnx";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Run one job in a fresh worker: its replies until it answers, then the worker ended. */
function runWorker(
  startWorker: () => StemWorker,
  message: ToStemWorker,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
  onStage?: (stage: SeparationStage) => void,
): Promise<FromStemWorker | null> {
  const worker = startWorker();
  return new Promise<FromStemWorker | null>((resolve) => {
    signal?.addEventListener("abort", () => resolve(null), { once: true });
    worker.addEventListener("message", ({ data }) => {
      if (data.kind === "progress") onProgress(data.fraction);
      else if (data.kind === "stage") onStage?.(data.stage);
      else resolve(data);
    });
    worker.addEventListener("error", (event) =>
      resolve({ kind: "failed", reason: `Stem Separation stopped: ${event.message || "its worker failed"}. The browser may have run out of memory.` }),
    );
    // A worker, not a window: there is no target origin to give.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    worker.postMessage(message);
  }).finally(() => {
    // Ending it drops its listeners too, and anything it would still send.
    worker.terminate();
  });
}

function refusedWith(reply: FromStemWorker | null): never {
  throw new Error(reply?.kind === "failed" ? reply.reason : "Stem Separation's worker gave no answer.");
}

/** Say plainly when the site's storage is full. */
function storageError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return new Error(
      "There isn't room in this browser's storage for the site to keep the model (about 300 MB). Free some space, or clear other sites' data, and install it again.",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function browserStemSeparator({
  store,
  startWorker,
  capabilities,
  pick = pickModelFile,
  persist = () => Promise.resolve(false),
  fetchModel = () => Promise.resolve(null),
}: BrowserStemSeparatorOptions): StemSeparator {
  let running = false;

  async function unavailable(): Promise<string | null> {
    return whyUnavailable(await capabilities(), store);
  }

  return {
    modelKeptIn: "this browser's storage for the site, outside any Project, until you clear the site's data. It takes about 300 MB",
    async status(): Promise<SeparatorStatus> {
      const reason = await unavailable();
      if (reason || !store) return { kind: "unavailable", reason: reason ?? "" };
      try {
        return (await store.read()) ? { kind: "installed" } : { kind: "notInstalled" };
      } catch (error) {
        return { kind: "unavailable", reason: `This browser won't let the site read its storage, where the model is kept: ${storageError(error).message}` };
      }
    },

    async findModel() {
      if (await unavailable()) return null;
      const file = await fetchModel();
      return file ? ({ label: `the repo's ${SERVED_MODEL}`, file } satisfies BrowserModelFile) : null;
    },

    async chooseModelFile() {
      const file = await pick();
      return file ? ({ label: file.name, file } satisfies BrowserModelFile) : null;
    },

    async installModel(chosen) {
      const reason = await unavailable();
      if (reason || !store) throw new Error(reason ?? "");
      const { file } = chosen as BrowserModelFile;
      const reply = await runWorker(startWorker, { kind: "check", model: file }, () => {});
      if (reply?.kind !== "checked") refusedWith(reply);
      try {
        await store.write(file);
      } catch (error) {
        throw storageError(error);
      }
      // Best effort: a browser that grants it won't clear the model to make room.
      await persist().catch(() => false);
    },

    async separate(audio, { onProgress, onStage, signal }) {
      if (running) throw new Error("A Stem Separation is already running; wait for it or cancel it.");
      if (signal.aborted) return null;
      running = true;
      try {
        const model = await store?.read();
        if (!model) throw new Error("Stem Separation's model isn't installed: install htdemucs.onnx first.");
        // Posting copies the audio: the caller keeps its own.
        const reply = await runWorker(startWorker, { kind: "separate", model, audio }, onProgress, signal, onStage);
        if (reply === null || signal.aborted) return null;
        if (reply.kind !== "separated") refusedWith(reply);
        onProgress(1);
        return reply.wavs.map((wav, index) => ({ name: STEM_NAMES[index]!, wav }));
      } finally {
        running = false;
      }
    },
  };
}

/** A worker running `stem-worker.ts`, which Vite bundles with ONNX Runtime Web. */
export function startStemWorker(): StemWorker {
  return new Worker(new URL("./stem-worker.ts", import.meta.url), { type: "module", name: "Stem Separation" });
}

/** What this browser can do, asked of it. */
export async function browserCapabilities(): Promise<BrowserCapabilities> {
  const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
  return {
    webAssembly: typeof WebAssembly === "object",
    webGpu: adapter !== null && adapter !== undefined,
    threads: globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === "function",
    memoryGb: (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory,
  };
}

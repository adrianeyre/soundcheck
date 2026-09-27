import { readFileSync } from "node:fs";

import { initSync } from "@engine";
import * as ort from "onnxruntime-web";
import { beforeAll, expect, test } from "vitest";

import {
  browserStemSeparator,
  fetchServedModel,
  SERVED_MODEL,
  whyUnavailable,
  type BrowserCapabilities,
  type BrowserStemSeparatorOptions,
  type StemWorker,
} from "./browser-stem-separator";
import { FAKE_SEGMENT, FAKE_WEIGHTS, fakeHtdemucs, fakeHtdemucsAsExported, fakeStemsModel } from "./fake-htdemucs-model";
import type { StemModelStore } from "./stem-model-store";
import { STEM_NAMES, STEM_SAMPLE_RATE, type SeparationOptions } from "./stem-separator";
import { handleStemWorkerMessage, htdemucsShapes, type FromStemWorker, type StemWorkerRuntime, type ToStemWorker } from "./stem-worker-core";

// The real engine's WASM build and ONNX Runtime Web's Node build, running
// the fake htdemucs: everything the browser runs but the Worker and WebGPU.
beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

/** ONNX Runtime can take a second or two to load even the fake model. */
const ORT_MS = 30_000;

const runtime: StemWorkerRuntime = { ort, loadEngine: () => Promise.resolve(), executionProviders: ["wasm"] };

interface TestWorker extends StemWorker {
  terminated: boolean;
}

type Listener = (event: { data: FromStemWorker } & { message?: string }) => void;

/** A worker whose messages go to `receive`, and whose replies stop once it is ended. */
function testWorker(receive: (message: ToStemWorker, reply: (data: FromStemWorker) => void, fail: (message: string) => void) => void): TestWorker {
  const listeners = { message: [] as Listener[], error: [] as Listener[] };
  const worker: TestWorker = {
    terminated: false,
    addEventListener(type: "message" | "error", listener: Listener) {
      listeners[type].push(listener);
    },
    postMessage(message) {
      receive(
        message,
        (data) => !worker.terminated && listeners.message.forEach((listener) => listener({ data })),
        (text) => !worker.terminated && listeners.error.forEach((listener) => listener({ data: undefined as never, message: text })),
      );
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return worker;
}

/** A worker run in-process, as the real one runs in its own thread. */
function inProcessWorker(workers: TestWorker[]): () => StemWorker {
  return () => {
    const worker = testWorker((message, reply) => {
      // Posting copies what is sent, as a real worker's does.
      const sent = message.kind === "separate" ? { ...message, audio: message.audio.slice() } : message;
      void handleStemWorkerMessage(sent, reply, runtime);
    });
    workers.push(worker);
    return worker;
  };
}

function memoryStore(kept: Blob | null = null): StemModelStore & { model: Blob | null } {
  return {
    model: kept,
    async read() {
      return this.model;
    },
    async write(model) {
      this.model = model;
    },
    async remove() {
      this.model = null;
    },
  };
}

const CAN: BrowserCapabilities = { webAssembly: true, webGpu: false, threads: true, memoryGb: 8 };

function separator(options: Partial<BrowserStemSeparatorOptions> = {}) {
  const workers: TestWorker[] = [];
  const store = memoryStore();
  const stems = browserStemSeparator({
    store,
    startWorker: inProcessWorker(workers),
    capabilities: () => Promise.resolve(CAN),
    ...options,
  });
  return { stems, store, workers };
}

function file(bytes: Uint8Array, name = "htdemucs.onnx"): File {
  return new File([bytes as Uint8Array<ArrayBuffer>], name);
}

async function installed(options: Partial<BrowserStemSeparatorOptions> = {}) {
  const made = separator({ pick: () => Promise.resolve(file(fakeHtdemucsAsExported())), ...options });
  const chosen = await made.stems.chooseModelFile();
  await made.stems.installModel(chosen!);
  return made;
}

const quiet = (): SeparationOptions => ({ onProgress: () => {}, signal: new AbortController().signal });

/** A 32-bit float WAV's samples, its sides interleaved. */
function floatSamples(wav: Uint8Array): Float32Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  for (let at = 12; at + 8 <= wav.byteLength; ) {
    const id = String.fromCharCode(...wav.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (id === "data") return new Float32Array(wav.slice(at + 8, at + 8 + size).buffer);
    at += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

/** 16-bit stereo PCM WAV of `interleaved` at `rate`. */
function pcmWav(interleaved: Int16Array, rate: number): Uint8Array {
  const wav = new Uint8Array(44 + interleaved.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (at: number, text: string) => [...text].forEach((c, i) => (wav[at + i] = c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + interleaved.byteLength, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, interleaved.byteLength, true);
  new Int16Array(wav.buffer, 44).set(interleaved);
  return wav;
}

/**
 * `shared_song` in `desktop/src/stems/tests.rs`, byte for byte: 8 s of
 * 16-bit stereo noise with a little DC at 48 kHz, from the same xorshift32.
 */
function sharedSong(): Uint8Array {
  const rate = 48_000;
  const samples = new Int16Array(8 * rate * 2);
  let x = 0x5eed5eed;
  for (let i = 0; i < samples.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    samples[i] = (x >>> 20) - 2_048 + 300;
  }
  return pcmWav(samples, rate);
}

/** `seconds` of a tone at 44.1 kHz, a little different on each side. */
function tone(seconds: number): Uint8Array {
  const frames = Math.round(seconds * STEM_SAMPLE_RATE);
  const samples = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    samples[2 * i] = Math.round(8_000 * Math.sin((2 * Math.PI * 220 * i) / STEM_SAMPLE_RATE));
    samples[2 * i + 1] = Math.round(5_000 * Math.sin((2 * Math.PI * 330 * i) / STEM_SAMPLE_RATE));
  }
  return pcmWav(samples, STEM_SAMPLE_RATE);
}

test("the Stems and their rate are the engine's, which the Desktop App's are too", () => {
  const shapes = htdemucsShapes();
  expect(shapes.stems).toEqual([...STEM_NAMES]);
  expect(shapes.sampleRate).toBe(STEM_SAMPLE_RATE);
  expect(shapes.input).toEqual([1, 2, FAKE_SEGMENT]);
  expect(shapes.output).toEqual([1, 4, 2, FAKE_SEGMENT]);
});

test(
  "the Browser Version's Stems are the Desktop App's, for the same fake model and song",
  async () => {
    const { stems } = await installed({ pick: () => Promise.resolve(file(fakeHtdemucs())) });
    const separated = await stems.separate(sharedSong(), quiet());
    const desktop = JSON.parse(readFileSync(new URL("./fake-htdemucs-stems.json", import.meta.url), "utf8")) as {
      frames: number;
      every: number;
      stems: Record<string, { left: number[]; right: number[] }>;
    };
    expect(separated!.map((stem) => stem.name)).toEqual([...STEM_NAMES]);
    for (const { name, wav } of separated!) {
      const samples = floatSamples(wav);
      expect(samples.length / 2).toBe(desktop.frames);
      for (const [side, offset] of [
        ["left", 0],
        ["right", 1],
      ] as const) {
        const kept = desktop.stems[name]![side];
        const ours = kept.map((_, i) => samples[2 * i * desktop.every + offset]!);
        const largest = Math.max(...ours.map((s, i) => Math.abs(s - kept[i]!)));
        expect(largest, `${name} ${side}`).toBeLessThan(1e-6);
      }
    }
  },
  ORT_MS,
);

test(
  "each Stem is the fake model's share of the song, across every chunk and cross-fade",
  async () => {
    const { stems } = await installed();
    const song = tone(20);
    const separated = await stems.separate(song, quiet());
    // The song as the engine reads it: 16-bit to float, already at 44.1 kHz.
    const input = Float32Array.from(new Int16Array(song.buffer, 44), (s) => s / 32_768);
    let mean = 0;
    for (let i = 0; i < input.length; i += 2) mean += (input[i]! + input[i + 1]!) / 2;
    mean /= input.length / 2;
    for (const [index, { wav }] of separated!.entries()) {
      const samples = floatSamples(wav);
      expect(samples.length).toBe(input.length);
      const weight = FAKE_WEIGHTS[index]!;
      const largest = samples.reduce((most, s, i) => Math.max(most, Math.abs(s - ((input[i]! - mean) * weight + mean))), 0);
      expect(largest).toBeLessThan(1e-5);
    }
  },
  ORT_MS,
);

test(
  "progress rises from zero to one through each stage in turn, and the worker is ended after",
  async () => {
    const { stems, workers } = await installed();
    const reports: number[] = [];
    const stages: string[] = [];
    await stems.separate(tone(20), {
      onProgress: (fraction) => reports.push(fraction),
      onStage: (stage) => stages.push(stage),
      signal: new AbortController().signal,
    });
    expect(stages).toEqual(["reading", "loadingModel", "separating", "finishing"]);
    expect(reports[0]).toBe(0);
    expect(reports.at(-1)).toBe(1);
    expect(reports).toEqual(reports.toSorted((a, b) => a - b));
    expect(reports).toEqual(expect.arrayContaining([0.25, 0.5, 0.75]));
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  },
  ORT_MS,
);

test(
  "cancelling ends the worker and returns nothing",
  async () => {
    const { stems, workers } = await installed();
    const abort = new AbortController();
    const separating = stems.separate(tone(20), {
      onProgress: (fraction) => fraction > 0 && abort.abort(),
      signal: abort.signal,
    });
    await expect(separating).resolves.toBeNull();
    expect(workers.at(-1)!.terminated).toBe(true);
    // And the next may start.
    await expect(stems.separate(tone(0.5), quiet())).resolves.toHaveLength(4);
  },
  ORT_MS,
);

test(
  "one separation runs at a time",
  async () => {
    const { stems } = await installed();
    const first = stems.separate(tone(1), quiet());
    await expect(stems.separate(tone(1), quiet())).rejects.toThrow(/already running/);
    await expect(first).resolves.toHaveLength(4);
  },
  ORT_MS,
);

test("nothing separates before the model is installed", async () => {
  const { stems } = separator();
  expect(await stems.status()).toEqual({ kind: "notInstalled" });
  await expect(stems.separate(tone(1), quiet())).rejects.toThrow(/isn't installed/);
});

test(
  "audio that can't be read is refused with a reason",
  async () => {
    const { stems } = await installed();
    await expect(stems.separate(new TextEncoder().encode("not audio"), quiet())).rejects.toThrow(/./);
  },
  ORT_MS,
);

test(
  "installing htdemucs as the export writes it keeps it in the site's storage",
  async () => {
    const { stems, store, workers } = await installed();
    expect(await stems.status()).toEqual({ kind: "installed" });
    expect(new Uint8Array(await store.model!.arrayBuffer())).toEqual(fakeHtdemucsAsExported());
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  },
  ORT_MS,
);

test(
  "a model that isn't htdemucs is refused, and the installed one stays",
  async () => {
    const { stems, store } = await installed();
    const kept = store.model;
    await expect(stems.installModel({ label: "6s", file: file(fakeStemsModel(FAKE_SEGMENT, [0.1, 0.1, 0.2, 0.2, 0.2, 0.2])) } as never)).rejects.toThrow(
      "its output is float32 [1, 6, 2, 343980]",
    );
    await expect(stems.installModel({ label: "short", file: file(fakeStemsModel(44_100, [...FAKE_WEIGHTS])) } as never)).rejects.toThrow(
      "its input is float32 [1, 2, 44100]",
    );
    await expect(stems.installModel({ label: "song", file: file(new TextEncoder().encode("RIFF....WAVE not a model")) } as never)).rejects.toThrow(
      "isn't an ONNX model",
    );
    expect(store.model).toBe(kept);
  },
  ORT_MS,
);

test("choosing no file installs nothing", async () => {
  const { stems } = separator({ pick: () => Promise.resolve(null) });
  expect(await stems.chooseModelFile()).toBeNull();
});

test(
  "a full storage is said plainly",
  async () => {
    const store = memoryStore();
    store.write = () => Promise.reject(new DOMException("quota", "QuotaExceededError"));
    const made = separator({ store, pick: () => Promise.resolve(file(fakeHtdemucs())) });
    await expect(made.stems.installModel((await made.stems.chooseModelFile())!)).rejects.toThrow(/isn't room/);
  },
  ORT_MS,
);

test(
  "the site's storage is asked to persist once the model is installed",
  async () => {
    let asked = 0;
    await installed({ persist: () => Promise.resolve(++asked > 0) });
    expect(asked).toBe(1);
  },
  ORT_MS,
);

test("a worker that dies says the browser may have run out of memory", async () => {
  const store = memoryStore(new Blob(["model"]));
  const worker = testWorker((_message, _reply, fail) => queueMicrotask(() => fail("Out of memory")));
  const { stems } = separator({ store, startWorker: () => worker });
  await expect(stems.separate(tone(1), quiet())).rejects.toThrow(/run out of memory/);
});

/** Why a browser like `CAN` but for `capabilities` can't separate. */
const cant = (capabilities: Partial<BrowserCapabilities>, store: StemModelStore | null = memoryStore()) =>
  whyUnavailable({ ...CAN, ...capabilities }, store);

test("where it can't run, it says why, and refuses to install", async () => {
  expect(cant({})).toBeNull();
  expect(cant({ webAssembly: false })).toMatch(/needs WebAssembly/);
  expect(cant({}, null)).toMatch(/no storage/);
  expect(cant({ memoryGb: 2 })).toMatch(/needs about 4 GB of memory, and this computer says it has 2 GB/);
  expect(cant({ threads: false })).toMatch(/neither WebGPU nor WebAssembly threads/);
  expect(cant({ threads: false, webGpu: true })).toBeNull();
  // A browser that doesn't say how much memory it has is let try.
  expect(cant({ memoryGb: undefined })).toBeNull();

  const { stems } = separator({ capabilities: () => Promise.resolve({ ...CAN, threads: false }) });
  expect(await stems.status()).toEqual({ kind: "unavailable", reason: expect.stringMatching(/neither WebGPU/) });
  await expect(stems.installModel({ label: "htdemucs.onnx", file: file(fakeHtdemucs()) } as never)).rejects.toThrow(/neither WebGPU/);
});

/** A fetch that answers each of `routes` (by method) and 404s everything else, and what it was asked. */
function fetchWith(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    asked.push(key);
    return routes[key]?.() ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetcher, asked };
}

const bytes = (body: BodyInit | null = "weights") =>
  new Response(body, { headers: { "Content-Type": "application/octet-stream" } });

test("the model pnpm dev serves from the repo's model/ is fetched, after a HEAD says it's there", async () => {
  const { fetcher, asked } = fetchWith({ [`HEAD ${SERVED_MODEL}`]: () => bytes(null), [`GET ${SERVED_MODEL}`]: () => bytes() });
  const found = await fetchServedModel(fetcher);
  expect(found?.name).toBe("htdemucs.onnx");
  expect(await found?.text()).toBe("weights");
  expect(asked).toEqual([`HEAD ${SERVED_MODEL}`, `GET ${SERVED_MODEL}`]);
});

/** A server's HTML page, which some answer every path with. */
const page = () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });

/** The model a page's server serves. */
const served = () => Promise.resolve(file(fakeHtdemucsAsExported()));

test("where the page's server has no model, as on GitHub Pages, nothing is fetched", async () => {
  const missing = fetchWith({});
  expect(await fetchServedModel(missing.fetcher)).toBeNull();
  expect(missing.asked).toEqual([`HEAD ${SERVED_MODEL}`]);

  // A server that answers every path with its page isn't serving a model.
  expect(await fetchServedModel(fetchWith({ [`HEAD ${SERVED_MODEL}`]: page }).fetcher)).toBeNull();

  const offline = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
  expect(await fetchServedModel(offline)).toBeNull();
});

test("a model the page's server has is found, to install without asking, but not where the browser can't separate", async () => {
  const { stems } = separator({ fetchModel: served });
  const found = await stems.findModel!();
  expect(found?.label).toBe(`the repo's ${SERVED_MODEL}`);
  await stems.installModel(found!);
  expect(await stems.status()).toEqual({ kind: "installed" });

  expect(await separator({ fetchModel: () => Promise.resolve(null) }).stems.findModel!()).toBeNull();
  const unable = separator({ fetchModel: served, capabilities: () => Promise.resolve({ ...CAN, threads: false }) });
  expect(await unable.stems.findModel!()).toBeNull();
});

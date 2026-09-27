/**
 * What the Browser Version's Stem Separation worker does (`stem-worker.ts`),
 * apart from the worker itself, so tests can run it in-process with ONNX
 * Runtime Web's Node build. htdemucs runs on ONNX Runtime Web: WebGPU where
 * the browser has it, WebAssembly on the CPU elsewhere. The math around it,
 * cutting the song into chunks and cross-fading the Stems, is the engine's
 * `StemSeparation`, the same Rust the Desktop App runs (ADR 0005).
 */
import { StemSeparation, stem_separation_model } from "@engine";
import type { InferenceSession, Tensor } from "onnxruntime-web";

import type { SeparationStage } from "./stem-separator";

export type ToStemWorker =
  /** Check the model is htdemucs, without separating anything. */
  | { kind: "check"; model: Blob }
  /** Separate an audio file (WAV, FLAC or MP3) with the model. */
  | { kind: "separate"; model: Blob; audio: Uint8Array };

export type FromStemWorker =
  | { kind: "progress"; fraction: number }
  | { kind: "stage"; stage: SeparationStage }
  | { kind: "checked" }
  /** The four Stems as float WAV files, in `STEM_NAMES`' order. */
  | { kind: "separated"; wavs: Uint8Array[] }
  | { kind: "failed"; reason: string };

/** The parts of ONNX Runtime Web the worker uses, so tests can load its Node build. */
export interface StemWorkerRuntime {
  ort: {
    InferenceSession: { create(model: Uint8Array, options?: InferenceSession.SessionOptions): Promise<InferenceSession> };
    Tensor: new (type: "float32", data: Float32Array, dims: readonly number[]) => Tensor;
  };
  /** Load the engine's WASM build. */
  loadEngine: () => Promise<unknown>;
  /** Which of ONNX Runtime Web's backends to try, best first. */
  executionProviders: readonly ("webgpu" | "wasm")[];
}

/** What makes a model htdemucs, and the Stems it gives: the engine's, so both platforms check the same. */
interface HtdemucsShapes {
  sampleRate: number;
  stems: string[];
  input: number[];
  output: number[];
}

export function htdemucsShapes(): HtdemucsShapes {
  return JSON.parse(stem_separation_model()) as HtdemucsShapes;
}

function shapeOf(value: InferenceSession.ValueMetadata): string {
  return value.isTensor ? `${value.type} [${value.shape.join(", ")}]` : "not a tensor";
}

/**
 * Why a model with these inputs and outputs isn't htdemucs, or null if it
 * is: one float input of `[1, 2, 343980]` and one output of
 * `[1, 4, 2, 343980]`, as the Desktop App checks.
 */
export function modelProblem(session: Pick<InferenceSession, "inputMetadata" | "outputMetadata">): string | null {
  const { inputMetadata: inputs, outputMetadata: outputs } = session;
  if (inputs.length !== 1 || outputs.length !== 1) {
    return `This isn't htdemucs: it has ${inputs.length} inputs and ${outputs.length} outputs, and htdemucs has one of each.`;
  }
  const expected = htdemucsShapes();
  for (const [what, found, shape] of [
    ["input", inputs[0]!, expected.input],
    ["output", outputs[0]!, expected.output],
  ] as const) {
    const matches =
      found.isTensor && found.type === "float32" && found.shape.length === shape.length && found.shape.every((n, i) => n === shape[i]);
    if (!matches) {
      return `This isn't htdemucs: its ${what} is ${shapeOf(found)}, where htdemucs' is float32 [${shape.join(", ")}]. Export htdemucs.onnx with tools/htdemucs-onnx, as the README says.`;
    }
  }
  return null;
}

/** What went wrong, in words: the engine throws strings, ONNX Runtime Errors. */
function reasonOf(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return /memory|allocat/i.test(reason)
    ? `${reason}. The browser ran out of memory: a shorter song may fit, and the Desktop App has more room.`
    : reason;
}

async function open(runtime: StemWorkerRuntime, model: Blob, options: InferenceSession.SessionOptions): Promise<InferenceSession> {
  let session: InferenceSession;
  try {
    session = await runtime.ort.InferenceSession.create(new Uint8Array(await model.arrayBuffer()), options);
  } catch (error) {
    throw new Error(`This isn't an ONNX model ONNX Runtime can load: ${reasonOf(error)}`, { cause: error });
  }
  const problem = modelProblem(session);
  if (problem) {
    await session.release();
    throw new Error(problem);
  }
  return session;
}

async function separate(
  runtime: StemWorkerRuntime,
  model: Blob,
  audio: Uint8Array,
  post: (reply: FromStemWorker, transfer?: Transferable[]) => void,
): Promise<void> {
  post({ kind: "stage", stage: "reading" });
  await runtime.loadEngine();
  // The file first, so audio that can't be read is refused before the
  // model's 300 MB are loaded.
  const separation = StemSeparation.from_audio_file(audio);
  let session: InferenceSession | null = null;
  try {
    post({ kind: "progress", fraction: 0 });
    post({ kind: "stage", stage: "loadingModel" });
    session = await open(runtime, model, { executionProviders: runtime.executionProviders });
    post({ kind: "stage", stage: "separating" });
    const [input] = session.inputNames;
    const [output] = session.outputNames;
    const { input: shape, stems } = htdemucsShapes();
    const chunks = separation.chunks();
    for (let index = 0; index < chunks; index++) {
      post({ kind: "progress", fraction: index / chunks });
      const results = await session.run({ [input!]: new runtime.ort.Tensor("float32", separation.chunk(index), shape) });
      const stemsOut = results[output!]!;
      separation.add(index, stemsOut.data as Float32Array);
      stemsOut.dispose();
    }
    post({ kind: "stage", stage: "finishing" });
    // Each Stem is taken out of the engine as it is made into a file, so
    // the four are never all held twice.
    const wavs = stems.map((_, source) => separation.stem_wav(source));
    post({ kind: "separated", wavs }, wavs.map((wav) => wav.buffer as ArrayBuffer));
  } finally {
    separation.free();
    await session?.release();
  }
}

/** Answer one message; the worker is ended after each separation, which frees its memory. */
export async function handleStemWorkerMessage(
  message: ToStemWorker,
  post: (reply: FromStemWorker, transfer?: Transferable[]) => void,
  runtime: StemWorkerRuntime,
): Promise<void> {
  try {
    if (message.kind === "check") {
      await runtime.loadEngine();
      // On the CPU. The basic optimisations work out the shapes the export
      // leaves symbolic (its output's), and on htdemucs are quicker than none.
      const session = await open(runtime, message.model, { executionProviders: ["wasm"], graphOptimizationLevel: "basic" });
      await session.release();
      post({ kind: "checked" });
    } else {
      await separate(runtime, message.model, message.audio, post);
    }
  } catch (error) {
    post({ kind: "failed", reason: reasonOf(error) });
  }
}

/**
 * The Web Worker the Browser Version separates Stems in
 * (`browser-stem-separator.ts`): the engine's WASM build and ONNX Runtime
 * Web, WebGPU first where the browser has it. ONNX Runtime's own WASM file
 * is named here so Vite puts it in the build beside the worker; it loads
 * only when a separation starts.
 */
import init from "@engine";
import * as ort from "onnxruntime-web";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";

import { handleStemWorkerMessage, type FromStemWorker, type ToStemWorker } from "./stem-worker-core";

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };

const scope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<ToStemWorker>) => void): void;
  postMessage(message: FromStemWorker, transfer?: Transferable[]): void;
};
const hasGpu = "gpu" in navigator;

scope.addEventListener("message", ({ data }) => {
  void handleStemWorkerMessage(data, (reply, transfer = []) => scope.postMessage(reply, transfer), {
    ort,
    loadEngine: init,
    executionProviders: hasGpu ? ["webgpu", "wasm"] : ["wasm"],
  });
});

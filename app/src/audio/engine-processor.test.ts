/**
 * The processor loaded the way an AudioWorklet loads it: in a scope with no
 * TextEncoder or TextDecoder. Chrome still resolves `addModule` when the
 * module throws, so a missing global surfaces only later, as "The node name
 * 'engine' is not defined".
 */
import { readFileSync } from "node:fs";

import { afterEach, expect, test, vi } from "vitest";

import type { EngineCommand } from "./audio-output";
import type { ProcessorMessage, ProcessorOptions } from "./engine-processor";

type Listener = (event: { data: EngineCommand }) => void;

afterEach(() => {
  vi.unstubAllGlobals();
});

test("registers 'engine' and takes a string command with no TextEncoder or TextDecoder", async () => {
  vi.stubGlobal("TextEncoder", undefined);
  vi.stubGlobal("TextDecoder", undefined);
  vi.stubGlobal("sampleRate", 48_000);
  const listeners: Listener[] = [];
  const posted: ProcessorMessage[] = [];
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      readonly port = {
        addEventListener: (_type: string, listener: Listener) => listeners.push(listener),
        start: () => {},
        postMessage: (message: ProcessorMessage) => posted.push(message),
      };
    },
  );
  const registered = new Map<string, new (options: { processorOptions: ProcessorOptions }) => unknown>();
  vi.stubGlobal("registerProcessor", (name: string, processor: never) => registered.set(name, processor));

  await import("./engine-processor");

  const Processor = registered.get("engine");
  expect(Processor).toBeDefined();
  const module = new WebAssembly.Module(
    readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)),
  );
  const processor = new Processor!({ processorOptions: { module, trackCount: 1 } });
  expect(processor).toBeDefined();
  expect(posted).toEqual([{ type: "ready" }]);

  // Passing a string into the engine is what needs a TextEncoder.
  expect(() => {
    for (const listener of listeners) {
      listener({ data: { type: "insertEffect", chain: 0, index: 0, effect: "eq" } });
    }
  }).not.toThrow();
});

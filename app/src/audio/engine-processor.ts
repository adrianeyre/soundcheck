/**
 * The AudioWorklet processor that runs the Audio Engine's WASM build on the
 * browser's audio thread. Loaded by `worklet-audio-output.ts`; nothing else
 * imports it.
 *
 * The main thread compiles the WASM module and hands it over in
 * `processorOptions`, because the worklet scope can't fetch.
 */
// Must come first: the engine's glue needs a TextDecoder and a TextEncoder the moment it loads.
import "./text-codec-polyfill";

import { Engine, initSync } from "@engine";

import { WasmPluginHost } from "../plugin/wasm-plugin-runtime";
import { applyEngineCommand } from "./apply-engine-command";
import type { EngineCommand, EngineReport, Meters } from "./audio-output";
import { readGainReduction } from "./gain-reduction";

// The AudioWorklet global scope, which TypeScript's DOM library leaves out.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new (options: { processorOptions: ProcessorOptions }) => AudioWorkletProcessor,
): void;

export interface ProcessorOptions {
  module: WebAssembly.Module;
  trackCount: number;
}

/**
 * Messages the processor posts back to the main thread. A report carries
 * the live notes the engine recorded since the last one, flat: tick, pitch,
 * velocity and 1 for a note-on or 0 for a note-off.
 */
export type ProcessorMessage =
  | { type: "ready" }
  | ({ type: "report"; meters: Meters; recorded: Float64Array } & EngineReport);

// Often enough for a position readout to move smoothly.
const REPORT_SECONDS = 0.05;

class EngineProcessor extends AudioWorkletProcessor {
  #engine: Engine;
  #memory: WebAssembly.Memory;
  #framesSinceReport = 0;
  // Views onto the engine's output buffers. Rebuilt only when WASM memory
  // grows or the block size changes, so a normal block allocates nothing.
  #views: { buffer: ArrayBuffer; frames: number; left: Float32Array; right: Float32Array } | null =
    null;

  constructor({ processorOptions }: { processorOptions: ProcessorOptions }) {
    super();
    this.#memory = initSync({ module: processorOptions.module }).memory;
    this.#engine = new Engine(sampleRate);
    this.#engine.set_track_count(processorOptions.trackCount);
    // Plugins are compiled here, synchronously, as `loadPlugin` brings them:
    // the worklet scope can't wait for a promise mid-stream.
    const plugins = new WasmPluginHost(sampleRate);
    this.port.addEventListener("message", (event: MessageEvent<EngineCommand>) =>
      applyEngineCommand(this.#engine, event.data, plugins),
    );
    this.port.start();
    this.#post({ type: "ready" });
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0] ?? [];
    if (!left || !right) return true;
    const frames = left.length;

    this.#engine.render(frames);
    const views = this.#outputViews(frames);
    left.set(views.left);
    right.set(views.right);

    this.#framesSinceReport += frames;
    if (this.#framesSinceReport >= REPORT_SECONDS * sampleRate) {
      this.#framesSinceReport = 0;
      const trackCount = this.#engine.track_count();
      this.#post({
        type: "report",
        trackCount,
        activeVoices: this.#engine.active_voices(),
        playing: this.#engine.is_playing(),
        position: this.#engine.position(),
        meters: {
          master: this.#engine.master_peak(),
          tracks: Array.from({ length: trackCount }, (_, track) => this.#engine.track_peak(track)),
          buses: Array.from({ length: this.#engine.bus_count() }, (_, bus) => this.#engine.bus_peak(bus)),
          gainReduction: readGainReduction(this.#engine),
        },
        recorded: this.#engine.take_recorded_notes(),
      });
    }
    return true;
  }

  #outputViews(frames: number) {
    const buffer = this.#memory.buffer;
    const left = this.#engine.left_ptr();
    const views = this.#views;
    if (
      !views ||
      views.buffer !== buffer ||
      views.frames !== frames ||
      views.left.byteOffset !== left
    ) {
      this.#views = {
        buffer,
        frames,
        left: new Float32Array(buffer, left, frames),
        right: new Float32Array(buffer, this.#engine.right_ptr(), frames),
      };
    }
    return this.#views!;
  }

  #post(message: ProcessorMessage) {
    // A MessagePort, not a window: there is no target origin to give.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    this.port.postMessage(message);
  }
}

registerProcessor("engine", EngineProcessor);

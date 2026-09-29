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

/**
 * A file for a Deck of the DJ Mixer, decoded and analysed on the page's
 * thread (`dj_prepare`), so the audio thread only copies it in; or, with
 * no samples, the Deck emptied.
 */
export interface DjLoadMessage {
  type: "djLoad";
  deck: number;
  left: Float32Array | null;
  right: Float32Array | null;
  bpm: number;
  firstBeat: number;
}

/**
 * A sample for a Sampler Slot of the DJ Mixer, decoded on the page's thread
 * (`dj_prepare_sample`); or, with no samples, the slot emptied.
 */
export interface DjSampleMessage {
  type: "djSample";
  slot: number;
  left: Float32Array | null;
  right: Float32Array | null;
}

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
  | ({
      type: "report";
      meters: Meters;
      recorded: Float64Array;
      /** The DJ Mixer's report and recording, once it is in use. */
      dj: Float64Array | null;
      djRecording: Float32Array | null;
    } & EngineReport);

// Often enough for a position readout to move smoothly.
const REPORT_SECONDS = 0.05;

class EngineProcessor extends AudioWorkletProcessor {
  #engine: Engine;
  #memory: WebAssembly.Memory;
  #framesSinceReport = 0;
  /** Whether the DJ Mixer has been used, so there is something of it to report. */
  #djInUse = false;
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
    this.port.addEventListener("message", (event: MessageEvent<EngineCommand | DjLoadMessage | DjSampleMessage>) => {
      const message = event.data;
      if (message.type === "djSample") {
        this.#djInUse = true;
        if (message.left && message.right) this.#engine.dj_load_sample_samples(message.slot, message.left, message.right);
        else this.#engine.dj_unload_sample(message.slot);
        return;
      }
      if (message.type === "djLoad") {
        this.#djInUse = true;
        if (message.left && message.right) {
          this.#engine.dj_load_samples(message.deck, message.left, message.right, message.bpm, message.firstBeat);
        } else {
          this.#engine.dj_unload(message.deck);
        }
        return;
      }
      if (message.type === "djSet") this.#djInUse = true;
      applyEngineCommand(this.#engine, message, plugins);
    });
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
    // The DJ Mixer's headphone cue goes out of outputs 3 and 4, where the
    // device has them, as on the desktop (ADR 0013).
    const [, , cueLeft, cueRight] = outputs[0] ?? [];
    if (cueLeft && cueRight && this.#djInUse) {
      const at = this.#engine.dj_headphone_left_ptr();
      if (at !== 0) {
        const buffer = this.#memory.buffer;
        cueLeft.set(new Float32Array(buffer, at, frames));
        cueRight.set(new Float32Array(buffer, this.#engine.dj_headphone_right_ptr(), frames));
      }
    }

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
        dj: this.#djInUse ? this.#engine.dj_report() : null,
        djRecording: this.#djInUse ? this.#engine.dj_take_recording() : null,
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

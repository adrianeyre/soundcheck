/**
 * The browser dev host's Plugin runtime: a Plugin run by the host's own
 * `WebAssembly`, as `desktop/src/plugin.rs` runs it in wasmtime. It speaks
 * ABI version 1 (ADR 0003) and hands the engine's WASM build an instance it
 * can host in an Effect slot or on an Instrument Track
 * (`engine/src/plugin/js.rs`).
 *
 * Nothing here can stop a Plugin that runs away: the browser has no epoch
 * interruption, so on the dev host such a Plugin stalls the worklet. One
 * that traps is caught, and the engine bypasses it from then on.
 */

export const ABI_VERSION = 1;

interface Exports {
  memory: WebAssembly.Memory;
  sc_abi_version(): number;
  sc_manifest(): number;
  sc_manifest_len(): number;
  sc_init(sampleRate: number, maxFrames: number): number;
  sc_buffer(channel: number): number;
  sc_set_param(index: number, value: number): void;
  sc_process(frames: number): void;
  sc_reset(): void;
  /** Only an Instrument's. */
  sc_note_on?(note: number, velocity: number): void;
  sc_note_off?(note: number): void;
}

const EXPORTS = [
  "sc_abi_version",
  "sc_manifest",
  "sc_manifest_len",
  "sc_init",
  "sc_buffer",
  "sc_set_param",
  "sc_process",
  "sc_reset",
] as const;

/** What an Instrument exports besides: the ABI's note events. */
const INSTRUMENT_EXPORTS = ["sc_note_on", "sc_note_off"] as const;

/** A compiled Plugin and the manifest it gave, unchecked. */
export interface LoadedPlugin {
  module: WebAssembly.Module;
  manifestJson: string;
}

function start(module: WebAssembly.Module): Exports {
  if (WebAssembly.Module.imports(module).length > 0) {
    throw new Error("A Plugin can't import anything, and this one does.");
  }
  const exports = new WebAssembly.Instance(module, {}).exports as Partial<Record<string, unknown>>;
  if (!(exports.memory instanceof WebAssembly.Memory)) throw new Error("The Plugin doesn't export its `memory`.");
  for (const name of EXPORTS) {
    if (typeof exports[name] !== "function") {
      throw new Error(`The Plugin doesn't export \`${name}\` as ABI version 1 has it.`);
    }
  }
  return exports as unknown as Exports;
}

/**
 * Compile a Plugin and read its manifest, refusing one that isn't ABI
 * version 1. The engine checks the manifest itself (`plugin_manifest`).
 * Compiling is synchronous, which the worklet needs; the main thread only
 * does it when a Plugin is installed.
 */
export function loadPlugin(wasm: Uint8Array | WebAssembly.Module): LoadedPlugin {
  let module: WebAssembly.Module;
  try {
    module = wasm instanceof WebAssembly.Module ? wasm : new WebAssembly.Module(wasm.slice());
  } catch (error) {
    throw new Error(`This isn't a WebAssembly module: ${String(error)}`, { cause: error });
  }
  const exports = start(module);
  const version = exports.sc_abi_version();
  if (version !== ABI_VERSION) {
    throw new Error(`The Plugin is built for ABI version ${version}; this app hosts version ${ABI_VERSION}.`);
  }
  const pointer = exports.sc_manifest();
  const length = exports.sc_manifest_len();
  const bytes = new Uint8Array(exports.memory.buffer).subarray(pointer, pointer + length);
  if (bytes.length !== length) throw new Error("The Plugin's manifest is outside its memory.");
  const manifestJson = new TextDecoder().decode(bytes);
  if (declaresInstrument(manifestJson)) {
    for (const name of INSTRUMENT_EXPORTS) {
      if (typeof exports[name] !== "function") {
        throw new Error(`The Plugin is an Instrument but doesn't export \`${name}\` as ABI version 1 has it.`);
      }
    }
  }
  return { module, manifestJson };
}

/** Whether a manifest says its Plugin is an Instrument; the engine checks the rest. */
function declaresInstrument(manifestJson: string): boolean {
  try {
    const manifest: unknown = JSON.parse(manifestJson);
    return typeof manifest === "object" && manifest !== null && "kind" in manifest && manifest.kind === "instrument";
  } catch {
    return false;
  }
}

/** The part of the engine's WASM build a Plugin host drives. */
export interface PluginHostingEngine {
  insert_plugin_effect(chain: number, index: number, manifest: string, instance: WasmPluginInstance): boolean;
  insert_missing_plugin(chain: number, index: number, id: string): boolean;
  set_track_plugin_instrument(track: number, manifest: string, instance: WasmPluginInstance): boolean;
  set_track_missing_instrument(track: number, id: string): boolean;
}

/**
 * The Plugins one WASM Engine can host, compiled once each by their id, as
 * `loadPlugin` commands bring them; `insertPlugin` makes an instance per
 * slot. The worklet has one for the engine it plays, and the Audio Analysis
 * and the mix export one each for the engines they render.
 */
export class WasmPluginHost {
  readonly #modules = new Map<string, LoadedPlugin>();

  /** `maxFrames` is only the Plugin's buffer size: a longer block is processed in pieces. */
  constructor(
    readonly sampleRate: number,
    readonly maxFrames = 128,
  ) {}

  /** Compile `wasm` as the Plugin `id`. One that doesn't load leaves `id` missing. */
  load(id: string, wasm: Uint8Array): void {
    try {
      this.#modules.set(id, loadPlugin(wasm));
    } catch {
      this.#modules.delete(id);
    }
  }

  /**
   * Put the Plugin `id` in a slot: an instance of it if it loaded and
   * starts, or otherwise its place, which passes audio through.
   */
  insert(engine: PluginHostingEngine, chain: number, index: number, id: string): boolean {
    const loaded = this.#modules.get(id);
    if (loaded) {
      try {
        const instance = new WasmPluginInstance(loaded.module, this.sampleRate, this.maxFrames);
        if (engine.insert_plugin_effect(chain, index, loaded.manifestJson, instance)) return true;
      } catch {
        // It refused to start: its place is held instead.
      }
    }
    return engine.insert_missing_plugin(chain, index, id);
  }

  /**
   * Make the Plugin Instrument `id` a Track's Instrument: an instance of it
   * if it loaded, starts and is an Instrument, or otherwise its place, which
   * is silent.
   */
  setInstrument(engine: PluginHostingEngine, track: number, id: string): boolean {
    const loaded = this.#modules.get(id);
    if (loaded) {
      try {
        const instance = new WasmPluginInstance(loaded.module, this.sampleRate, this.maxFrames);
        if (engine.set_track_plugin_instrument(track, loaded.manifestJson, instance)) return true;
      } catch {
        // It refused to start: its place is held instead.
      }
    }
    return engine.set_track_missing_instrument(track, id);
  }
}

/**
 * One instance of a Plugin, as the engine's `JsPluginInstance` calls it:
 * audio arrives as pointers into the engine's memory, and is copied into
 * the Plugin's buffers and back without making an array per block.
 */
export class WasmPluginInstance {
  readonly #exports: Exports;
  readonly #frames: number;
  readonly #buffers: [number, number];
  #engineMemory: WebAssembly.Memory | null = null;
  #engineView = new Float32Array(0);
  #pluginView = new Float32Array(0);

  constructor(module: WebAssembly.Module, sampleRate: number, maxFrames: number) {
    this.#exports = start(module);
    this.#frames = maxFrames;
    const ready = this.#exports.sc_init(sampleRate, maxFrames);
    if (ready !== 0) throw new Error(`The Plugin refused to start (sc_init said ${ready}).`);
    this.#buffers = [this.#exports.sc_buffer(0), this.#exports.sc_buffer(1)];
    const size = this.#exports.memory.buffer.byteLength;
    if (this.#buffers.some((buffer) => buffer % 4 !== 0 || buffer + maxFrames * 4 > size)) {
      throw new Error("The Plugin's buffers are outside its memory.");
    }
  }

  /** Called by the engine once, with its own memory. */
  attachEngineMemory(memory: WebAssembly.Memory): void {
    this.#engineMemory = memory;
  }

  setParam(index: number, value: number): void {
    try {
      this.#exports.sc_set_param(index, value);
    } catch {
      // A Plugin that traps here traps again in `process`, where the engine hears of it.
    }
  }

  /** Process `frames` in place at `left` and `right` in the engine's memory; false if the Plugin trapped. */
  process(left: number, right: number, frames: number): boolean {
    const engine = this.#views();
    if (engine === null) return false;
    let plugin = this.#pluginView;
    const [pluginLeft, pluginRight] = [this.#buffers[0] / 4, this.#buffers[1] / 4];
    for (let done = 0; done < frames; done += this.#frames) {
      const count = Math.min(this.#frames, frames - done);
      const [engineLeft, engineRight] = [left / 4 + done, right / 4 + done];
      // By hand rather than with `subarray`, so a block makes no garbage.
      for (let i = 0; i < count; i++) {
        plugin[pluginLeft + i] = engine[engineLeft + i]!;
        plugin[pluginRight + i] = engine[engineRight + i]!;
      }
      try {
        this.#exports.sc_process(count);
      } catch {
        return false;
      }
      // A Plugin may grow its memory while it processes, which leaves the
      // old view detached.
      if (plugin.buffer !== this.#exports.memory.buffer) {
        plugin = this.#pluginView = new Float32Array(this.#exports.memory.buffer);
      }
      for (let i = 0; i < count; i++) {
        engine[engineLeft + i] = plugin[pluginLeft + i]!;
        engine[engineRight + i] = plugin[pluginRight + i]!;
      }
    }
    return true;
  }

  reset(): void {
    try {
      this.#exports.sc_reset();
    } catch {
      // As with `setParam`.
    }
  }

  /** Start an Instrument's note; false if the Plugin trapped, or isn't an Instrument. */
  noteOn(note: number, velocity: number): boolean {
    try {
      this.#exports.sc_note_on!(note, velocity);
      return true;
    } catch {
      return false;
    }
  }

  /** Release an Instrument's note; false as for `noteOn`. */
  noteOff(note: number): boolean {
    try {
      this.#exports.sc_note_off!(note);
      return true;
    } catch {
      return false;
    }
  }

  /** Views of both memories, remade only when one has grown. */
  #views(): Float32Array | null {
    if (this.#engineMemory === null) return null;
    if (this.#engineView.buffer !== this.#engineMemory.buffer) {
      this.#engineView = new Float32Array(this.#engineMemory.buffer);
    }
    if (this.#pluginView.buffer !== this.#exports.memory.buffer) {
      this.#pluginView = new Float32Array(this.#exports.memory.buffer);
    }
    return this.#engineView;
  }
}

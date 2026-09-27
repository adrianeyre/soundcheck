import { readFileSync } from "node:fs";

import { initSync } from "@engine";
import { beforeAll, describe, expect, test } from "vitest";

import { EXPECTED_OUTPUT, installedTestPlugin, testInput, testPluginWasm } from "./test-plugin";
import { loadPlugin, WasmPluginInstance } from "./wasm-plugin-runtime";

let wasm: Uint8Array;

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
  wasm = testPluginWasm();
}, 300_000);

/** Stand-in for the engine's memory: the two channels one after the other. */
function engineMemory(frames: number) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new Float32Array(memory.buffer);
  return { memory, view, left: 0, right: frames * 4 };
}

describe("the browser dev host's Plugin runtime", () => {
  test("renders the test Plugin's expected output, the samples wasmtime renders on desktop", () => {
    const { sampleRate, seed, blockFrames, blocks, changes } = EXPECTED_OUTPUT;
    const { manifest } = installedTestPlugin(wasm);
    const instance = new WasmPluginInstance(loadPlugin(wasm).module, sampleRate, blockFrames);
    // As desktop's instantiate does: every setting starts at its default.
    manifest.settings.forEach((setting, index) => instance.setParam(index, setting.default));
    const engine = engineMemory(blockFrames);
    instance.attachEngineMemory(engine.memory);

    const [left, right] = testInput(blockFrames * blocks, seed);
    for (let block = 0; block < blocks; block++) {
      for (const change of changes.filter((candidate) => candidate.block === block)) {
        instance.setParam(change.index, change.value);
      }
      const at = block * blockFrames;
      engine.view.set(left.subarray(at, at + blockFrames), engine.left / 4);
      engine.view.set(right.subarray(at, at + blockFrames), engine.right / 4);
      expect(instance.process(engine.left, engine.right, blockFrames)).toBe(true);
      left.set(engine.view.subarray(engine.left / 4, engine.left / 4 + blockFrames), at);
      right.set(engine.view.subarray(engine.right / 4, engine.right / 4 + blockFrames), at);
    }

    // Sample for sample: each expected value is an f32 written as a double.
    expect([...left]).toEqual(EXPECTED_OUTPUT.left.map(Math.fround));
    expect([...right]).toEqual(EXPECTED_OUTPUT.right.map(Math.fround));
  });

  test("processes a block longer than its buffers in pieces, as one block would be", () => {
    const { sampleRate } = EXPECTED_OUTPUT;
    const [left, right] = testInput(512, 7);
    const render = (maxFrames: number) => {
      const instance = new WasmPluginInstance(loadPlugin(wasm).module, sampleRate, maxFrames);
      const engine = engineMemory(512);
      instance.attachEngineMemory(engine.memory);
      engine.view.set(left, 0);
      engine.view.set(right, 128);
      instance.process(engine.left, engine.right, 512);
      return [...engine.view.subarray(0, 1024)];
    };
    expect(render(128)).toEqual(render(512));
  });

  test("reads the test Plugin's manifest, and refuses what isn't a Plugin", () => {
    const { manifest } = installedTestPlugin(wasm);
    expect(manifest).toMatchObject({ id: "dev.soundcheck.test.effect", kind: "effect" });
    expect(manifest.settings.map((setting) => setting.name)).toEqual(["gain", "smooth", "width"]);
    expect(() => loadPlugin(new Uint8Array([1, 2, 3]))).toThrow("This isn't a WebAssembly module");
    // The smallest module there is: no exports at all.
    const empty = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    expect(() => loadPlugin(empty)).toThrow("memory");
  });
});

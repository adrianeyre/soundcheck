/**
 * The SDK's test Plugins (`sdk/test-effect` and `sdk/test-instrument`),
 * built for wasm32 as the desktop host's tests build them, and the recipes
 * and samples every host is checked against. For tests.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { plugin_manifest } from "@engine";

import { readPluginManifest, type InstalledPlugin } from "./plugins";
import { loadPlugin } from "./wasm-plugin-runtime";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface ExpectedOutput {
  sampleRate: number;
  seed: number;
  blockFrames: number;
  blocks: number;
  changes: { block: number; index: number; value: number }[];
  left: number[];
  right: number[];
}

export const EXPECTED_OUTPUT: ExpectedOutput = JSON.parse(
  readFileSync(new URL("../../../sdk/test-effect/expected-output.json", import.meta.url), "utf8"),
);

/** `sdk/test-instrument`'s recipe: a Pattern Clip on one Instrument Track, and what the Master plays. */
export interface InstrumentExpectedOutput {
  sampleRate: number;
  tempo: number;
  clip: { start: number; length: number; notes: { pitch: number; start: number; length: number; velocity: number }[] };
  settings: Record<string, number>;
  ticks: number;
  left: number[];
  right: number[];
}

export const INSTRUMENT_EXPECTED_OUTPUT: InstrumentExpectedOutput = JSON.parse(
  readFileSync(new URL("../../../sdk/test-instrument/expected-output.json", import.meta.url), "utf8"),
);

/**
 * A test or example Plugin's `.wasm`, built by cargo: quick once it is up to
 * date. All four are built at once, as the desktop tests build them, into
 * their own target directory, named here so the path holds whatever
 * `CARGO_TARGET_DIR` says.
 */
function testWasm(
  crate:
    | "soundcheck_test_effect"
    | "soundcheck_test_instrument"
    | "soundcheck_example_bitcrusher"
    | "soundcheck_example_wavetable",
): Uint8Array {
  const targetDir = `${ROOT}target/test-plugin`;
  execFileSync(
    "cargo",
    [
      "build",
      "-p",
      "soundcheck-test-effect",
      "-p",
      "soundcheck-test-instrument",
      "-p",
      "soundcheck-example-bitcrusher",
      "-p",
      "soundcheck-example-wavetable",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
      "--target-dir",
      targetDir,
    ],
    { cwd: ROOT, stdio: "ignore" },
  );
  return new Uint8Array(readFileSync(`${targetDir}/wasm32-unknown-unknown/release/${crate}.wasm`));
}

export function testPluginWasm(): Uint8Array {
  return testWasm("soundcheck_test_effect");
}

export function testInstrumentWasm(): Uint8Array {
  return testWasm("soundcheck_test_instrument");
}

/** An example Plugin from `examples/plugins/`, built only against the SDK. */
export function exampleWasm(example: "bitcrusher" | "wavetable"): Uint8Array {
  return testWasm(`soundcheck_example_${example}`);
}

/** The test Plugin as the Plugins folder lists it. Needs the engine's WASM initialised. */
export function installedTestPlugin(wasm = testPluginWasm()): InstalledPlugin {
  return { manifest: readPluginManifest(plugin_manifest(loadPlugin(wasm).manifestJson)), wasm };
}

/** The test Plugin Instrument, as `installedTestPlugin` has the Effect. */
export function installedTestInstrument(wasm = testInstrumentWasm()): InstalledPlugin {
  return installedTestPlugin(wasm);
}

/** `soundcheck_test_effect::input`: the same noise, interleaved left then right. */
export function testInput(frames: number, seed: number): [Float32Array, Float32Array] {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.fround(Math.fround((state >>> 8) / 16_777_216) * 2 - 1);
  };
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = next();
    right[i] = next();
  }
  return [left, right];
}

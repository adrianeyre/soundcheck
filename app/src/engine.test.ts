import { readFileSync } from "node:fs";

import { Engine, engine_version, initSync, starter_kit } from "@engine";
import { beforeAll, expect, test } from "vitest";

import { STARTER_KIT } from "./project/model";

// Loads the real WASM build, so this proves the Rust → WASM → TypeScript path,
// including reading output straight from WASM memory as the worklet does.
let memory: WebAssembly.Memory;

beforeAll(() => {
  const wasm = readFileSync(
    new URL("../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url),
  );
  memory = initSync({ module: wasm }).memory;
});

test("the WASM engine reports a version", () => {
  expect(engine_version()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("the WASM engine renders Tracks into buffers the host can read", () => {
  const engine = new Engine(48_000);
  engine.set_track_count(16);
  engine.set_pattern_playing(true);

  let peak = 0;
  for (let block = 0; block < 400; block++) {
    engine.render(128);
    const left = new Float32Array(memory.buffer, engine.left_ptr(), 128);
    const right = new Float32Array(memory.buffer, engine.right_ptr(), 128);
    for (const sample of [...left, ...right]) peak = Math.max(peak, Math.abs(sample));
  }

  expect(engine.track_count()).toBe(16);
  expect(engine.active_voices()).toBeGreaterThan(16);
  expect(peak).toBeGreaterThan(0.05);
  expect(peak).toBeLessThanOrEqual(1);
  engine.free();
});

test("the starter kit the UI shows is the one the engine plays", () => {
  expect(JSON.parse(starter_kit())).toEqual(
    STARTER_KIT.map(({ name, note, chokeGroup }) => ({ name, note, chokeGroup })),
  );
});

test("the WASM engine plays a four-on-the-floor kick from the bundled kit", () => {
  const engine = new Engine(48_000);
  engine.set_track_count(1);
  expect(engine.set_track_instrument(0, "drumSampler")).toBe(true);
  // A kick on each of four beats, at 120 BPM: a beat is 24 000 frames.
  const kick = STARTER_KIT[0]!.note;
  engine.set_track_notes(0, new Float64Array([0, 240, kick, 1, 960, 240, kick, 1, 1920, 240, kick, 1, 2880, 240, kick, 1]));
  engine.play();

  const played: number[] = [];
  while (played.length < 4 * 24_000) {
    engine.render(1024);
    played.push(...new Float32Array(memory.buffer, engine.left_ptr(), 1024));
  }
  for (let beat = 0; beat < 4; beat++) {
    const attack = played.slice(beat * 24_000, beat * 24_000 + 2_400);
    expect(Math.max(...attack.map(Math.abs))).toBeGreaterThan(0.2);
  }
  engine.free();
});

test("the WASM engine takes a WAV the musician loads, and says what is wrong with one it can't", () => {
  const engine = new Engine(48_000);
  engine.set_track_count(1);
  engine.set_track_instrument(0, "drumSampler");
  const wav = readFileSync(new URL("../../engine/assets/kits/starter/snare.wav", import.meta.url));
  expect(engine.load_track_pad_sample(0, 0, wav)).toBeUndefined();
  expect(engine.load_track_pad_sample(0, 0, new Uint8Array([1, 2, 3]))).toMatch(/WAV/i);
  engine.free();
});

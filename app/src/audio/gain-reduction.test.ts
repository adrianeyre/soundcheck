import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import { busChain, readGainReduction } from "./gain-reduction";

// The real WASM build, as the worklet runs it.
beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

test("every chain's gain-reduction meters come off the WASM engine, one per Effect", () => {
  const engine = new Engine(48_000);
  engine.set_track_count(2);
  engine.set_track_notes(1, new Float64Array([0, 3_840, 60, 1]));
  engine.insert_effect(1, 0, "eq");
  engine.insert_effect(1, 1, "compressor");
  engine.set_effect_settings(1, 1, new Float32Array([-60, 20, 1, 100, 0, 0]));
  engine.insert_effect(-1, 0, "compressor");
  engine.set_bus_count(1);
  engine.insert_effect(busChain(0), 0, "compressor");
  engine.set_track_output(0, 0);
  engine.play();
  for (let block = 0; block < 100; block++) engine.render(128);

  const meters = readGainReduction(engine);
  expect(meters.tracks).toHaveLength(2);
  expect(meters.tracks[0]).toEqual([]);
  expect(meters.tracks[1]).toHaveLength(2);
  expect(meters.tracks[1]![0]).toBe(0);
  expect(meters.tracks[1]![1]).toBeGreaterThan(10);
  expect(meters.master).toHaveLength(1);
  expect(meters.buses).toEqual([[0]]);
  engine.free();
});

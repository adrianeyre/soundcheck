import init, { Engine } from "@engine";

import { loadTestChains } from "../load-test/load-test-chain";
import { TICKS_PER_BEAT } from "../project/time";

export interface OfflineRenderResult {
  audioSeconds: number;
  elapsedSeconds: number;
}

export type RenderOffline = (options: {
  trackCount: number;
  tempo: number;
  seconds: number;
}) => Promise<OfflineRenderResult>;

const SAMPLE_RATE = 48_000;

/**
 * Render the load-test pattern offline on its own Engine, and time it. Runs on
 * the main thread, so the page stops responding until it finishes.
 */
export const renderOffline: RenderOffline = async ({ trackCount, tempo, seconds }) => {
  await init();
  const engine = new Engine(SAMPLE_RATE);
  try {
    engine.set_tempo(tempo);
    engine.set_track_count(trackCount);
    for (const command of loadTestChains(0, trackCount)) {
      if (command.type === "insertEffect") engine.insert_effect(command.chain, command.index, command.effect);
      else if (command.type === "setEffectSettings")
        engine.set_effect_settings(command.chain, command.index, new Float32Array(command.settings));
    }
    engine.set_metronome(true);
    engine.set_pattern_playing(true);
    engine.set_loop(0, TICKS_PER_BEAT * 4, true);

    const ticks = (seconds * tempo * TICKS_PER_BEAT) / 60;
    const started = performance.now();
    const audio = engine.render_range(0, ticks);
    const elapsedSeconds = (performance.now() - started) / 1000;
    return { audioSeconds: audio.length / 2 / SAMPLE_RATE, elapsedSeconds };
  } finally {
    engine.free();
  }
};

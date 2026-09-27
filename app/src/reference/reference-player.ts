/**
 * The Reference Track (#106): a finished song the musician compares their
 * mix against. It is copied into the Project but never played through the
 * mix, so it is never in the meters or an export: it is chosen, auditioned
 * on its own and measured, and each platform does those its own way.
 */
import init, { analyse_audio_file } from "@engine";

import type { LoadedSample } from "../project/engine-sync";

export interface ReferencePlayer {
  /** Ask for an audio file to be the Reference Track, and read it; null if none was chosen. */
  chooseFile: () => Promise<LoadedSample | null>;
  /**
   * Play `sample` on its own, past the mixer, at `gain` (1 is its own
   * level), in place of anything auditioning already.
   */
  audition: (sample: LoadedSample, gain: number) => Promise<void>;
  stopAudition: () => Promise<void>;
}

/**
 * How far to turn the reference down so it is as loud as the mix: the
 * difference in integrated loudness, as a gain. Never above 1, so matching
 * never boosts a quiet reference into clipping; 1 when either is silent.
 */
export function matchedGain(mixLufs: number | null, referenceLufs: number | null): number {
  if (mixLufs === null || referenceLufs === null) return 1;
  return Math.min(1, 10 ** ((mixLufs - referenceLufs) / 20));
}

const measured = new WeakMap<LoadedSample, string>();

/**
 * The whole reference measured, as the engine's compact Audio Analysis
 * JSON. Measured in the UI's WASM build on either platform, where its bytes
 * already are, and once per file: a Reference Track doesn't change.
 */
export async function measureReference(sample: LoadedSample): Promise<string> {
  const known = measured.get(sample);
  if (known !== undefined) return known;
  await init();
  let measurements: string;
  try {
    measurements = analyse_audio_file(Uint8Array.from(sample.bytes));
  } catch (error) {
    throw new Error(`${sample.name} can't be measured: ${String(error)}`, { cause: error });
  }
  measured.set(sample, measurements);
  return measurements;
}

/** The integrated loudness in the engine's Audio Analysis JSON, or null for silence. */
export function integratedLufs(measurements: string): number | null {
  return (JSON.parse(measurements) as { loudness: { integrated_lufs: number | null } }).loudness.integrated_lufs;
}

/**
 * A Track browser file's BPM, Beat Grid, key and waveform, as a Deck shows
 * them, worked out without putting it on a Deck: in the UI's WASM build of
 * the engine, on either platform, where the file's bytes already are, as
 * the Reference Track is measured. It needs no audio running.
 */
import init, { dj_analyse } from "@engine";

import type { DjAnalysis } from "../audio/audio-output";

export async function analyseTrack(bytes: Uint8Array): Promise<DjAnalysis> {
  await init();
  // A turn of the event loop first, so the page draws between one track's analysis and the next.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return JSON.parse(dj_analyse(bytes)) as DjAnalysis;
}

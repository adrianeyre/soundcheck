import init, { ClipRender, encode_wav } from "@engine";

import type { LoadedSamples } from "../project/engine-sync";
import type { AudioClip } from "../project/model";
import { STEM_SAMPLE_RATE } from "./stem-separator";

/**
 * The stretch of its file `clip` plays (`fileOffset` for `duration`), as a
 * stereo 32-bit float WAV at the rate the Stems come out at: what is
 * separated, rather than the whole file. The engine cuts it, so it is the
 * audio the Clip plays, sample for sample.
 */
export async function clipAudio(clip: AudioClip, samples: LoadedSamples): Promise<Uint8Array> {
  const loaded = samples.get(clip.file);
  if (!loaded) throw new Error(`${clip.file} isn't loaded, so it can't be separated.`);
  await init();
  const render = new ClipRender(Uint8Array.from(loaded.bytes), clip.fileOffset, clip.duration, STEM_SAMPLE_RATE);
  try {
    const audio = render.render_next(render.frames());
    return new Uint8Array(encode_wav(audio, STEM_SAMPLE_RATE, 32)!);
  } finally {
    render.free();
  }
}

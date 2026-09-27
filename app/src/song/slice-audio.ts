/**
 * The Audio Editor's calls into the Audio Engine's WASM build, which the UI
 * holds on both platforms: an Audio Clip decoded for drawing and cutting,
 * and a Slice's audio to audition. The UI never works on samples itself.
 */
import init, { ClipRender, ClipWaveform, encode_wav } from "@engine";

import type { LoadedSample } from "../project/engine-sync";
import type { AudioClip } from "../project/model";

/** The rate a Slice is auditioned at. */
const AUDITION_RATE = 48_000;

/** The `duration` seconds of `sample` from `fileOffset` in that a Clip plays, decoded to draw: free it once it is done with. */
export async function clipWaveform(sample: LoadedSample, fileOffset: number, duration: number): Promise<ClipWaveform> {
  await init();
  return new ClipWaveform(Uint8Array.from(sample.bytes), fileOffset, duration);
}

/** `clip`'s audio as a 32-bit float WAV, to audition: the stretch it plays, sample for sample. */
export async function clipWav(clip: AudioClip, sample: LoadedSample): Promise<LoadedSample> {
  await init();
  const render = new ClipRender(Uint8Array.from(sample.bytes), clip.fileOffset, clip.duration, AUDITION_RATE);
  try {
    const wav = encode_wav(render.render_next(render.frames()), AUDITION_RATE, 32)!;
    return { name: `${sample.name} (Slice)`, bytes: [...wav] };
  } finally {
    render.free();
  }
}

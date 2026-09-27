import { expect, test } from "vitest";

import { readWavFile } from "./load-sample";

/** A WAV header followed by `frames` silent 16-bit mono frames. */
function wav(frames: number): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(44 + frames * 2);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const tag = (at: number, text: string) => [...text].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, frames * 2, true);
  return bytes;
}

test("a WAV is read as the bytes the engine decodes", async () => {
  const bytes = wav(100);
  const sample = await readWavFile(new File([bytes], "clap.wav"));
  expect(sample.name).toBe("clap.wav");
  expect(sample.bytes).toEqual([...bytes]);
});

test("anything that isn't a WAV is refused by name", async () => {
  await expect(readWavFile(new File([new Uint8Array(new ArrayBuffer(200))], "song.mp3"))).rejects.toThrow("song.mp3 isn't a WAV file");
  // A header and nothing else has no samples in it.
  await expect(readWavFile(new File([wav(0)], "empty.wav"))).rejects.toThrow("empty.wav isn't a WAV file");
});

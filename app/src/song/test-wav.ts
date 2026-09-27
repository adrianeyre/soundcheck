/**
 * A 16-bit PCM stereo WAV of `left` and `right` (-1 to 1) at `rate` Hz, as
 * the plain numbers the UI holds a file's bytes in. For tests.
 */
export function stereoWav(left: readonly number[], right: readonly number[], rate: number): number[] {
  const frames = Math.min(left.length, right.length);
  const view = new DataView(new ArrayBuffer(44 + frames * 4));
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.codePointAt(0)!));
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * 4, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * 4, toInt16(left[i]!), true);
    view.setInt16(46 + i * 4, toInt16(right[i]!), true);
  }
  return [...new Uint8Array(view.buffer)];
}

function toInt16(value: number): number {
  return Math.round(Math.max(-1, Math.min(1, value)) * 32_767);
}

/**
 * Reading a WAV the musician picks. The Audio Engine decodes it (ADR 0001
 * keeps files out of the engine, so the bytes go in, not a path); this only
 * checks the file looks like a WAV, because sending is fire-and-forget on
 * both platforms and an error has to be shown here.
 */
import type { LoadedSample } from "../project/engine-sync";

/** A WAV header is 44 bytes, and the engine wants samples after it. */
const HEADER_BYTES = 44;

/** Read `file` as a WAV, or throw with what is wrong with it. */
export async function readWavFile(file: File): Promise<LoadedSample> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const tag = (at: number) => String.fromCodePoint(...bytes.subarray(at, at + 4));
  if (bytes.length <= HEADER_BYTES || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error(`${file.name} isn't a WAV file`);
  }
  // A plain array: it crosses a MessagePort in the browser and Tauri's JSON
  // IPC on the desktop, and both leave it a list of numbers.
  return { name: file.name, bytes: [...bytes] };
}

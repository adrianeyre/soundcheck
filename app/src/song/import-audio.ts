/**
 * Importing an audio file onto an Audio Track. The Audio Engine decodes it
 * (ADR 0001 keeps files out of the engine, so the bytes go in, not a path).
 * Sending to the engine is fire-and-forget on both platforms, so the UI runs
 * the same decoder in its own WASM build first: that says whether the file
 * is one the engine can play, how long it is, and what its waveform looks
 * like, before anything is added to the Project.
 */
import init, { audio_file_summary } from "@engine";

import type { LoadedSample } from "../project/engine-sync";

/** How many points a file's waveform is drawn from, whatever its length. */
export const WAVEFORM_POINTS = 1024;

/** What a file sounds like, drawn: its loudest sample in each stretch. */
export interface Waveform {
  seconds: number;
  /** 0 to 1, spread evenly over `seconds`. */
  peaks: number[];
}

export interface ImportedAudio {
  sample: LoadedSample;
  waveform: Waveform;
}

/** The files an import offers to open. */
export const AUDIO_FILE_TYPES = ".wav,.flac,.mp3,audio/wav,audio/flac,audio/mpeg";

/**
 * `bytes` measured and drawn, or an error saying what is wrong with them:
 * not audio at all, or audio the engine can't decode.
 */
export async function summariseAudio(bytes: readonly number[] | Uint8Array): Promise<Waveform> {
  await init();
  const summary = audio_file_summary(Uint8Array.from(bytes), WAVEFORM_POINTS);
  const [seconds = 0, ...peaks] = summary;
  return { seconds, peaks };
}

/** Read `file` as WAV, FLAC or MP3, or throw with what is wrong with it. */
export async function readAudioFile(file: File): Promise<ImportedAudio> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let waveform: Waveform;
  try {
    waveform = await summariseAudio(bytes);
  } catch (error) {
    throw new Error(`${file.name} can't be imported: ${String(error)}`, { cause: error });
  }
  // A plain array: it crosses a MessagePort in the browser and Tauri's JSON
  // IPC on the desktop, and both leave it a list of numbers.
  return { sample: { name: file.name, bytes: [...bytes] }, waveform };
}

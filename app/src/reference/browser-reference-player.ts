/**
 * The Reference Track in the browser dev host: chosen through a file input,
 * and auditioned by Web Audio in a context of its own, beside the worklet
 * that plays the mix, so it never reaches the mix or its meters.
 */
import type { LoadedSample } from "../project/engine-sync";
import { AUDIO_FILE_TYPES } from "../song/import-audio";
import type { ReferencePlayer } from "./reference-player";

/** The part of Web Audio an audition uses, so tests can stand in for it. */
export interface AuditionContext {
  decodeAudioData: (data: ArrayBuffer) => Promise<AudioBuffer>;
  createBufferSource: () => AudioBufferSourceNode;
  createGain: () => GainNode;
  destination: AudioNode;
  resume: () => Promise<void>;
}

/** Ask for one audio file with a file input; null if the musician cancels. */
export function pickAudioFile(document: Document = globalThis.document): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = AUDIO_FILE_TYPES;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

export function browserReferencePlayer(
  pick: () => Promise<File | null> = pickAudioFile,
  openContext: () => AuditionContext = () => new AudioContext(),
): ReferencePlayer {
  let context: AuditionContext | null = null;
  let playing: AudioBufferSourceNode | null = null;
  const decoded = new WeakMap<LoadedSample, Promise<AudioBuffer>>();

  const stop = () => {
    playing?.stop();
    playing?.disconnect();
    playing = null;
  };

  return {
    async chooseFile() {
      const file = await pick();
      return file ? { name: file.name, bytes: [...new Uint8Array(await file.arrayBuffer())] } : null;
    },
    async audition(sample, gain) {
      context ??= openContext();
      await context.resume();
      let buffer = decoded.get(sample);
      if (!buffer) {
        buffer = context.decodeAudioData(Uint8Array.from(sample.bytes).buffer);
        decoded.set(sample, buffer);
      }
      const audio = await buffer;
      stop();
      const level = context.createGain();
      level.gain.value = Math.max(gain, 0);
      level.connect(context.destination);
      const source = context.createBufferSource();
      source.buffer = audio;
      source.connect(level);
      source.addEventListener("ended", () => {
        if (playing === source) playing = null;
        level.disconnect();
      });
      source.start();
      playing = source;
    },
    async stopAudition() {
      stop();
    },
  };
}

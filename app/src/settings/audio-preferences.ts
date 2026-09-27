import { readLocal, writeLocal, type LocalStore } from "./local-settings";

export const AUDIO_KEY = "soundcheck.audio";

/**
 * The audio host and buffer size the song plays through, where the platform
 * lets you choose (the desktop). Null is the platform's default.
 */
export interface AudioPreferences {
  /** A name from `listAudioHosts`, e.g. "ASIO" or "JACK". */
  host: string | null;
  /** Frames per callback to ask for. */
  bufferFrames: number | null;
}

export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = { host: null, bufferFrames: null };

export function readAudioPreferences(store?: LocalStore | null): AudioPreferences {
  const saved = readLocal(AUDIO_KEY, store);
  if (!saved) return DEFAULT_AUDIO_PREFERENCES;
  try {
    const { host, bufferFrames } = JSON.parse(saved) as Partial<Record<keyof AudioPreferences, unknown>>;
    return {
      host: typeof host === "string" && host !== "" ? host : null,
      bufferFrames:
        typeof bufferFrames === "number" && Number.isInteger(bufferFrames) && bufferFrames > 0 ? bufferFrames : null,
    };
  } catch {
    return DEFAULT_AUDIO_PREFERENCES;
  }
}

export function writeAudioPreferences(preferences: AudioPreferences, store?: LocalStore | null): void {
  writeLocal(AUDIO_KEY, JSON.stringify(preferences), store);
}

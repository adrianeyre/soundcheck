import { expect, test, vi } from "vitest";

import { desktopAudioAnalyser } from "./audio-analyser";
import { LISTENING } from "./listening";
import type { Invoke } from "./desktop-audio-output";

test("on the desktop the Project's commands and the range go to the Rust process", async () => {
  const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(() =>
    Promise.resolve({ measurements: '{"source":"track 1"}', spectrogram: null }),
  );
  const analyse = desktopAudioAnalyser(invoke as Invoke);
  const commands = [{ type: "setTempo", bpm: 120 }] as const;

  expect(await analyse(commands, { start: 0, end: 3840, track: 1 })).toEqual({ measurements: '{"source":"track 1"}' });
  expect(invoke).toHaveBeenCalledWith("audio_analyse", { commands, start: 0, end: 3840, track: 1, spectrogram: false, audio: null });
});

test("on the desktop a spectrogram is asked for, and comes back, only when wanted", async () => {
  const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(() =>
    Promise.resolve({ measurements: "{}", spectrogram: "iVBORw0KGgo=" }),
  );
  const analyse = desktopAudioAnalyser(invoke as Invoke);

  expect(await analyse([], { start: 0, end: 3840, track: null, spectrogram: true })).toEqual({
    measurements: "{}",
    spectrogram: "iVBORw0KGgo=",
  });
  expect(invoke).toHaveBeenCalledWith("audio_analyse", expect.objectContaining({ spectrogram: true }));
});

test("on the desktop the audio is asked for in the listening format, and comes back with its length", async () => {
  const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(() =>
    Promise.resolve({ measurements: "{}", spectrogram: null, audio: "UklGRg==", audioSeconds: 30 }),
  );
  const analyse = desktopAudioAnalyser(invoke as Invoke);

  expect(await analyse([], { start: 0, end: 3840, track: null, audio: true })).toEqual({
    measurements: "{}",
    audio: { data: "UklGRg==", seconds: 30 },
  });
  expect(invoke).toHaveBeenCalledWith(
    "audio_analyse",
    expect.objectContaining({ spectrogram: false, audio: { sampleRate: LISTENING.sampleRate, maxSeconds: LISTENING.maxSeconds } }),
  );
});

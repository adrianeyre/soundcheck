import { expect, test, vi } from "vitest";

import type { Invoke } from "./desktop-audio-output";
import { desktopAudioInputs } from "./desktop-audio-input";

test("an input is opened on armed Tracks' channels, metered and recorded from through the Tauri commands", async () => {
  const first = Uint8Array.of(82, 73, 70, 70);
  const second = Uint8Array.of(87, 65, 86, 69);
  const replies: Record<string, unknown> = {
    audio_input_devices: [
      { name: "Microphone", channels: 1 },
      { name: "Interface", channels: 8 },
    ],
    audio_input_open: { device: "Interface", sampleRate: 48_000, channels: 8 },
    audio_input_levels: [0.25, 0.5],
    audio_record_start: undefined,
    audio_record_stop: [
      { startTick: 1_920, seconds: 2.5 },
      { startTick: 1_920, seconds: 2.5 },
    ],
    audio_input_close: undefined,
  };
  const invoke = vi.fn<(command: string, args?: { index?: number }) => Promise<unknown>>((command, args) =>
    Promise.resolve(command === "audio_record_take" ? [first, second][args!.index!]!.buffer : replies[command]),
  ) as unknown as Invoke;
  const inputs = desktopAudioInputs(invoke);

  expect(await inputs.devices()).toEqual([
    { name: "Microphone", channels: 1 },
    { name: "Interface", channels: 8 },
  ]);
  const input = await inputs.open("Interface", [[4], [2, 3]], [3, 1]);
  expect(invoke).toHaveBeenCalledWith("audio_input_open", { device: "Interface", taps: [[4], [2, 3]], tracks: [3, 1] });
  expect(input.device).toBe("Interface");
  expect(await input.levels()).toEqual([0.25, 0.5]);
  await input.startRecording();
  expect(await input.stopRecording(3.5)).toEqual([
    { startTick: 1_920, seconds: 2.5, wav: first },
    { startTick: 1_920, seconds: 2.5, wav: second },
  ]);
  expect(invoke).toHaveBeenCalledWith("audio_record_stop", { offsetMs: 3.5 });
  await input.close();
  expect(invoke).toHaveBeenLastCalledWith("audio_input_close");
});

test("a take with nothing in it fetches no file", async () => {
  const invoke = vi.fn<(command: string) => Promise<unknown>>((command) =>
    Promise.resolve(command === "audio_input_open" ? { device: "Mic", sampleRate: 48_000, channels: 1 } : []),
  ) as unknown as Invoke;
  const input = await desktopAudioInputs(invoke).open(null, [null], [0]);
  expect(await input.stopRecording(0)).toEqual([]);
  expect(invoke).not.toHaveBeenCalledWith("audio_record_take", expect.anything());
});

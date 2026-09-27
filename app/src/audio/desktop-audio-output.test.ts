import { afterEach, expect, test, vi } from "vitest";

import type { RecordedNoteEvent } from "./audio-output";
import { desktopAudioOutput, type Invoke, type Measured } from "./desktop-audio-output";
import { desktopMidiInput } from "../midi/desktop-midi-input";
import type { NoteEvent } from "../midi/midi-input";

afterEach(() => vi.useRealTimers());

const measured: Measured = {
  callbacks: 100,
  lateCallbacks: 2,
  maxRenderSeconds: 0.004,
  callbackFrames: 480,
  framesPlayed: 48_000,
  outputLatency: 0.012,
  engine: { trackCount: 16, activeVoices: 30, playing: true, position: 960 },
  meters: {
    master: 0.5,
    tracks: [0.25, 0.125],
    gainReduction: { master: [4], tracks: [[0, 2.5], []] },
  },
};

/** A fake of the Tauri side, recording every call. */
function fakeInvoke() {
  const calls: [string, unknown][] = [];
  /** What the native side has recorded and not yet handed over. */
  const recorded: RecordedNoteEvent[] = [];
  const invoke = ((command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    switch (command) {
      case "audio_open":
        return Promise.resolve({
          host: "WASAPI",
          device: "Speakers",
          sampleRate: 48_000,
          channels: 2,
          requestedBufferFrames: 256,
          grantedBufferFrames: 480,
        });
      case "audio_stats":
        return Promise.resolve(measured);
      case "audio_recorded_notes":
        return Promise.resolve(recorded.splice(0));
      case "midi_devices":
        return Promise.resolve(["Keystation 49"]);
      default:
        return Promise.resolve(null);
    }
  }) as Invoke;
  return { invoke, calls, recorded };
}

test("opens the native output with the chosen buffer size and reports what was granted", async () => {
  const { invoke, calls } = fakeInvoke();
  const output = await desktopAudioOutput(invoke)({ bufferFrames: 256, trackCount: 16 });
  expect(calls[0]).toEqual(["audio_open", { options: { bufferFrames: 256, host: null, trackCount: 16 } }]);

  const stats = output.stats();
  expect(stats).toMatchObject({
    host: "WASAPI: Speakers",
    sampleRate: 48_000,
    requestedBufferFrames: 256,
    blockFrames: 480,
    baseLatency: 0.01,
    outputLatency: 0.012,
    underruns: null,
    callbacks: { callbacks: 100, late: 2, slowestRender: 0.004 },
    engine: measured.engine,
    // The gain-reduction meters come through as the native host sent them.
    meters: measured.meters,
  });
  expect(output.currentTime()).toBeGreaterThanOrEqual(1);
  await output.close();
});

test("every command goes over IPC as it is, and close stops the stream", async () => {
  vi.useFakeTimers();
  const { invoke, calls } = fakeInvoke();
  const output = await desktopAudioOutput(invoke)({ trackCount: 1, host: "ASIO" });
  expect(calls[0]![1]).toEqual({ options: { bufferFrames: null, host: "ASIO", trackCount: 1 } });

  output.send({ type: "noteOn", note: 60, velocity: 0.8 });
  output.send({ type: "setTrackNotes", track: 0, notes: [0, 240, 60, 1] });
  expect(calls.filter(([command]) => command === "audio_send").map(([, args]) => args)).toEqual([
    { command: { type: "noteOn", note: 60, velocity: 0.8 } },
    { command: { type: "setTrackNotes", track: 0, notes: [0, 240, 60, 1] } },
  ]);

  const polls = () => calls.filter(([command]) => command === "audio_stats").length;
  const before = polls();
  await vi.advanceTimersByTimeAsync(200);
  expect(polls()).toBeGreaterThan(before);

  await output.close();
  expect(calls.at(-1)![0]).toBe("audio_close");
  const after = polls();
  await vi.advanceTimersByTimeAsync(200);
  expect(polls()).toBe(after);
});

test("the desktop MIDI input names keyboards and leaves the notes to the native side", async () => {
  vi.useFakeTimers();
  const { invoke } = fakeInvoke();
  const onNote = vi.fn<(event: NoteEvent) => void>();
  const onDevices = vi.fn<(names: string[]) => void>();
  const midi = await desktopMidiInput(invoke)(onNote, onDevices);
  expect(onDevices).toHaveBeenCalledWith(["Keystation 49"]);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(onDevices.mock.calls.length).toBeGreaterThan(1);
  midi.close();
  expect(onNote).not.toHaveBeenCalled();
});

test("recorded live notes are drained on every poll and handed over once", async () => {
  vi.useFakeTimers();
  const { invoke, recorded } = fakeInvoke();
  const output = await desktopAudioOutput(invoke)({ trackCount: 1 });
  expect(output.takeRecordedNotes()).toEqual([]);

  const played: RecordedNoteEvent[] = [
    { tick: 960, pitch: 60, velocity: 0.8, on: true },
    { tick: 1_200, pitch: 60, velocity: 0, on: false },
  ];
  recorded.push(played[0]!);
  await vi.advanceTimersByTimeAsync(60);
  recorded.push(played[1]!);
  await vi.advanceTimersByTimeAsync(60);

  // Both polls' worth, in the order played, and only once.
  expect(output.takeRecordedNotes()).toEqual(played);
  expect(output.takeRecordedNotes()).toEqual([]);
  await output.close();
});

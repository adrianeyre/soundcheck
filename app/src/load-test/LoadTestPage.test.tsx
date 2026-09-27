// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { AudioOutput, AudioOutputStats, OpenAudioOutput } from "../audio/audio-output";
import type { RenderOffline } from "../audio/offline-render";
import type { MidiInput, NoteEvent, OpenMidiInput } from "../midi/midi-input";
import { LoadTestPage } from "./LoadTestPage";

afterEach(cleanup);

const renderOffline = vi.fn<RenderOffline>(() =>
  Promise.resolve({ audioSeconds: 60, elapsedSeconds: 4 }),
);

function fakeOutput(overrides: Partial<AudioOutputStats> = {}) {
  const stats: AudioOutputStats = {
    host: "Browser AudioWorklet",
    sampleRate: 48_000,
    blockFrames: 128,
    requestedBufferFrames: null,
    baseLatency: 0.0053,
    outputLatency: 0.012,
    underruns: {
      events: 2,
      duration: 0.004,
      averageLatency: 0.02,
      minimumLatency: 0.019,
      maximumLatency: 0.021,
    },
    callbacks: null,
    engine: { trackCount: 16, activeVoices: 40, playing: true, position: 0 },
    meters: null,
    ...overrides,
  };
  return {
    send: vi.fn<AudioOutput["send"]>(),
    stats: () => stats,
    currentTime: () => 0,
    takeRecordedNotes: () => [],
    resetCounters: vi.fn<AudioOutput["resetCounters"]>(),
    close: vi.fn<AudioOutput["close"]>(() => Promise.resolve()),
  } satisfies AudioOutput;
}

/** A MIDI input that lets the test play notes on it. */
function fakeMidi(names: string[] = ["Test Keys"]) {
  let play: ((event: NoteEvent) => void) | undefined;
  const open: OpenMidiInput = (onNote, onDevices) => {
    play = onNote;
    onDevices(names);
    return Promise.resolve<MidiInput>({ close() {} });
  };
  return { open, play: (event: NoteEvent) => play?.(event) };
}

async function startWith(output = fakeOutput(), midi = fakeMidi()) {
  const openOutput = vi.fn<OpenAudioOutput>(() => Promise.resolve(output));
  render(<LoadTestPage openOutput={openOutput} openMidi={midi.open} renderOffline={renderOffline} />);
  fireEvent.click(screen.getByRole("button", { name: "Start audio" }));
  await screen.findByRole("button", { name: "Stop audio" });
  return { openOutput, output, midi };
}

test("starting opens the output with 16 Tracks and the pattern playing", async () => {
  const { openOutput, output } = await startWith();
  expect(openOutput).toHaveBeenCalledWith({ latencyHint: "interactive", trackCount: 16 });
  expect(output.send).toHaveBeenCalledWith({ type: "setPatternPlaying", playing: true });
  expect(output.send).toHaveBeenCalledWith({ type: "setLatencyTest", on: false });
});

test("starting sets up the transport to loop the one-bar pattern", async () => {
  const { output } = await startWith();
  expect(output.send).toHaveBeenCalledWith({ type: "setTempo", bpm: 120 });
  expect(output.send).toHaveBeenCalledWith({
    type: "setLoop",
    startTick: 0,
    endTick: 3840,
    enabled: true,
  });
});

test("transport changes reach the engine", async () => {
  const { output } = await startWith();
  fireEvent.click(screen.getByLabelText("Metronome"));
  expect(output.send).toHaveBeenCalledWith({ type: "setMetronome", on: true });
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  expect(output.send).toHaveBeenCalledWith({ type: "stop" });
});

test("the offline render test reports how much faster than real time it ran", async () => {
  await startWith();
  fireEvent.click(screen.getByRole("button", { name: "Render 60 s offline" }));
  expect(await screen.findByText("60 s of audio in 4.0 s (15.0× real time)")).toBeInTheDocument();
  expect(renderOffline).toHaveBeenCalledWith({ trackCount: 16, tempo: 120, seconds: 60 });
});

test("shows dropouts, buffer size and reported latency", async () => {
  await startWith();
  expect(await screen.findByText("2 (4.0 ms of silence)")).toBeInTheDocument();
  expect(screen.getByText("128 frames")).toBeInTheDocument();
  expect(screen.getByText("5.3 ms (254 frames)")).toBeInTheDocument();
  expect(screen.getByText("12.0 ms")).toBeInTheDocument();
  expect(screen.getByText("20.0 ms / 19.0 ms / 21.0 ms")).toBeInTheDocument();
  expect(screen.getByText("Frame rate")).toBeInTheDocument();
  expect(screen.getByText("40")).toBeInTheDocument();
});

test("says so when the browser doesn't report underruns", async () => {
  await startWith(fakeOutput({ underruns: null }));
  expect(await screen.findByText(/not reported by this browser/)).toBeInTheDocument();
});

test("the Track count can be changed while running", async () => {
  const { output } = await startWith();
  fireEvent.change(screen.getByLabelText("Tracks"), { target: { value: "48" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(output.send).toHaveBeenCalledWith({ type: "setTrackCount", count: 48 });
  // Every Track runs EQ → Compressor → Reverb: the 16 it started with, and
  // the 32 it has just been given.
  const inserts = output.send.mock.calls.filter(([command]) => command.type === "insertEffect");
  expect(inserts).toHaveLength(48 * 3);
  expect(inserts.at(-1)![0]).toEqual({ type: "insertEffect", chain: 47, index: 2, effect: "reverb" });
});

test("MIDI keys play the engine, and latency-test mode can be switched on", async () => {
  const { output, midi } = await startWith();
  expect(screen.getByText("MIDI: Test Keys")).toBeInTheDocument();

  midi.play({ type: "noteOn", note: 64, velocity: 1 });
  expect(output.send).toHaveBeenCalledWith({ type: "noteOn", note: 64, velocity: 1 });

  fireEvent.click(screen.getByRole("checkbox", { name: /sharp click/ }));
  expect(output.send).toHaveBeenCalledWith({ type: "setLatencyTest", on: true });
});

test("the computer keyboard plays the engine and shows its octave", async () => {
  const { output } = await startWith();
  expect(screen.getByText(/play C4 to C5/)).toBeInTheDocument();

  fireEvent.keyDown(window, { code: "KeyA" });
  expect(output.send).toHaveBeenCalledWith({ type: "noteOn", note: 60, velocity: 0.8 });
  fireEvent.keyUp(window, { code: "KeyA" });
  expect(output.send).toHaveBeenCalledWith({ type: "noteOff", note: 60 });

  fireEvent.keyDown(window, { code: "KeyX" });
  expect(await screen.findByText(/play C5 to C6/)).toBeInTheDocument();
});

test("reset zeroes the output's counters, and stop closes it", async () => {
  const { output } = await startWith();
  fireEvent.click(await screen.findByRole("button", { name: "Reset counters" }));
  expect(output.resetCounters).toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Stop audio" }));
  expect(output.close).toHaveBeenCalled();
  expect(await screen.findByRole("button", { name: "Start audio" })).toBeInTheDocument();
});

const failToOpen: OpenAudioOutput = () => Promise.reject(new Error("no AudioWorklet"));

test("a failure to start is shown", async () => {
  render(
    <LoadTestPage openOutput={failToOpen} openMidi={fakeMidi().open} renderOffline={renderOffline} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start audio" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("no AudioWorklet");
});

// On the desktop, the buffer size is chosen and the native callback is timed.

test("on the desktop, a buffer size and audio host are chosen instead of a latency hint", async () => {
  const output = fakeOutput({
    host: "ASIO: Focusrite USB",
    blockFrames: 128,
    requestedBufferFrames: 128,
    baseLatency: 128 / 48_000,
    outputLatency: null,
    underruns: null,
    callbacks: { callbacks: 5_000, late: 3, slowestRender: 0.0031 },
  });
  const openOutput = vi.fn<OpenAudioOutput>(() => Promise.resolve(output));
  render(
    <LoadTestPage
      openOutput={openOutput}
      openMidi={fakeMidi().open}
      renderOffline={renderOffline}
      bufferSizes={[64, 128, 256, 512]}
      listAudioHosts={() => Promise.resolve(["WASAPI", "ASIO"])}
    />,
  );
  expect(screen.queryByLabelText("Latency hint")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Buffer size")).toHaveValue("256");
  fireEvent.change(screen.getByLabelText("Buffer size"), { target: { value: "128" } });
  fireEvent.change(await screen.findByLabelText("Audio host"), { target: { value: "ASIO" } });
  fireEvent.click(screen.getByRole("button", { name: "Start audio" }));
  await screen.findByRole("button", { name: "Stop audio" });

  expect(openOutput).toHaveBeenCalledWith({ bufferFrames: 128, host: "ASIO", trackCount: 16 });
  expect(await screen.findByText("3 of 5000 (slowest render 3.1 ms, budget 2.7 ms)")).toBeInTheDocument();
  expect(screen.getByText("Buffer size requested")).toBeInTheDocument();
  expect(screen.getByText("Buffer size granted")).toBeInTheDocument();
  expect(screen.getByText("ASIO: Focusrite USB")).toBeInTheDocument();
  expect(screen.getByText("not reported")).toBeInTheDocument();
  expect(screen.queryByText("Underruns")).not.toBeInTheDocument();
});

test("on the desktop, the default host needs no choosing", async () => {
  const openOutput = vi.fn<OpenAudioOutput>(() => Promise.resolve(fakeOutput()));
  render(
    <LoadTestPage
      openOutput={openOutput}
      openMidi={fakeMidi().open}
      renderOffline={renderOffline}
      bufferSizes={[128, 256]}
      listAudioHosts={() => Promise.resolve(["WASAPI"])}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start audio" }));
  await screen.findByRole("button", { name: "Stop audio" });
  expect(screen.queryByLabelText("Audio host")).not.toBeInTheDocument();
  expect(openOutput).toHaveBeenCalledWith({ bufferFrames: 256, trackCount: 16 });
});

test("on the desktop, it starts on the host and buffer size chosen in Settings", async () => {
  const openOutput = vi.fn<OpenAudioOutput>(() => Promise.resolve(fakeOutput()));
  render(
    <LoadTestPage
      openOutput={openOutput}
      openMidi={fakeMidi().open}
      renderOffline={renderOffline}
      bufferSizes={[64, 128, 256]}
      listAudioHosts={() => Promise.resolve(["ALSA", "JACK"])}
      initialHost="JACK"
      initialBufferFrames={64}
    />,
  );
  expect(await screen.findByLabelText("Audio host")).toHaveValue("JACK");
  expect(screen.getByLabelText("Buffer size")).toHaveValue("64");
  fireEvent.click(screen.getByRole("button", { name: "Start audio" }));
  await screen.findByRole("button", { name: "Stop audio" });
  expect(openOutput).toHaveBeenCalledWith({ bufferFrames: 64, host: "JACK", trackCount: 16 });
});

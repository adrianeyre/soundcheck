// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { initSync } from "@engine";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import { memoryKeyStore } from "../assistant/key-store";
import type { AudioInput, AudioInputs, RecordedTake } from "../audio/audio-input";
import type { AudioOutput } from "../audio/audio-output";
import { ProjectHistory } from "../project/history";
import { type AudioClip, createProject } from "../project/model";
import { OFFSET_KEY } from "./AudioRecordPanel";
import { SongPage } from "./SongPage";
import { stereoWav } from "./test-wav";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// A take is measured for its waveform with the engine's own decoder, in WASM.
beforeAll(() => {
  initSync({ module: readFileSync(resolvePath(import.meta.dirname, "../../../engine/pkg/soundcheck_engine_bg.wasm")) });
});

function fakeOutput() {
  return {
    send: vi.fn<AudioOutput["send"]>(),
    stats: () => ({
      host: "Test",
      sampleRate: 48_000,
      blockFrames: 128,
      requestedBufferFrames: null,
      callbacks: null,
      baseLatency: 0,
      outputLatency: 0,
      underruns: null,
      engine: { trackCount: 0, activeVoices: 0, playing: false, position: 0 },
      meters: null,
    }),
    currentTime: () => 0,
    takeRecordedNotes: () => [],
    resetCounters: () => {},
    close: vi.fn<AudioOutput["close"]>(() => Promise.resolve()),
  } satisfies AudioOutput;
}

/** An input that hands back `takes` when it stops, on a stereo Line In and an eight-channel Interface. */
function fakeInputs(takes: RecordedTake[]) {
  const input = {
    device: "Line In",
    levels: vi.fn<AudioInput["levels"]>(() => Promise.resolve([0.5, 0.25])),
    startRecording: vi.fn<AudioInput["startRecording"]>(() => Promise.resolve()),
    stopRecording: vi.fn<AudioInput["stopRecording"]>(() => Promise.resolve(takes)),
    close: vi.fn<AudioInput["close"]>(() => Promise.resolve()),
  } satisfies AudioInput;
  const inputs = {
    devices: vi.fn<AudioInputs["devices"]>(() =>
      Promise.resolve([
        { name: "Line In", channels: 2 },
        { name: "Interface", channels: 8 },
      ]),
    ),
    open: vi.fn<AudioInputs["open"]>(() => Promise.resolve(input)),
  } satisfies AudioInputs;
  return { inputs, input };
}

async function setUp(inputs: AudioInputs | null) {
  const history = new ProjectHistory(createProject("Demo"));
  const output = fakeOutput();
  render(<SongPage openOutput={() => Promise.resolve(output)} history={history} audioInputs={inputs} />);
  fireEvent.click(screen.getByRole("button", { name: "Start audio" }));
  await screen.findByText("Stop audio");
  return { history, output };
}

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

// Half a second of a 440 Hz tone at 48 kHz: a beat, 960 ticks, at 120 bpm.
const tone = Array.from({ length: 24_000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
const TAKE: RecordedTake = { startTick: 1_930, seconds: 0.5, wav: Uint8Array.from(stereoWav(tone, tone, 48_000)) };

test("an armed Audio Track records a take where it was played, which one undo removes", async () => {
  const { inputs, input } = fakeInputs([TAKE]);
  const { history, output } = await setUp(inputs);
  click("Add Audio Track");
  // The loopback-measured offset, kept for the next session.
  fireEvent.change(screen.getByLabelText("Offset (ms)"), { target: { value: "2.5" } });
  expect(localStorage.getItem(OFFSET_KEY)).toBe("2.5");

  // Arm on the chosen input, and its level shows.
  await screen.findByRole("option", { name: "Line In" });
  fireEvent.change(screen.getByLabelText("Audio 1 input device"), { target: { value: "Line In" } });
  click("Arm Audio 1");
  await waitFor(() => expect(inputs.open).toHaveBeenCalledWith("Line In", [null], [0]));
  await waitFor(() =>
    expect(screen.getByRole("meter", { name: "Audio 1 input level" })).toHaveAttribute("aria-valuetext", "-6.0 dB"),
  );

  // Record rolls the transport; stopping hands the take over.
  output.send.mockClear();
  click("Record audio");
  await waitFor(() => expect(output.send).toHaveBeenCalledWith({ type: "play" }));
  expect(input.startRecording).toHaveBeenCalled();
  click("Stop recording audio");
  await waitFor(() => expect(history.project.tracks[0]!.clips).toHaveLength(1));
  expect(input.stopRecording).toHaveBeenCalledWith(2.5);
  expect(output.send).toHaveBeenCalledWith({ type: "stop" });

  // The engine placed it at tick 1930, latency taken out; it lasts a beat.
  expect(history.project.tracks[0]!.clips[0]).toEqual({
    id: expect.any(String),
    kind: "audio",
    start: 1_930,
    duration: 0.5,
    file: "audio/Audio 1 take.wav",
    fileOffset: 0,
  });
  await waitFor(() =>
    expect(output.send).toHaveBeenCalledWith({ type: "loadAudioFile", file: expect.any(Number), bytes: [...TAKE.wav] }),
  );

  // The whole take is one undo step.
  expect(history.undoLabel).toBe("Record audio");
  history.undo();
  expect(history.project.tracks[0]!.clips).toEqual([]);

  click("Disarm Audio 1");
  await waitFor(() => expect(input.close).toHaveBeenCalled());
});

/** The choices in Audio 1's channel picker. */
const channelChoices = () =>
  [...(screen.getByLabelText("Audio 1 input channels") as HTMLSelectElement).options].map((option) => option.text);

test("a Track's Input picker lists its device's channels and pairs, and the choice is an undoable edit", async () => {
  const { inputs } = fakeInputs([]);
  const { history } = await setUp(inputs);
  click("Add Audio Track");

  // The default input (listed first) is stereo.
  await screen.findByRole("option", { name: "Interface" });
  expect(channelChoices()).toEqual(["Stereo 1/2 (default)", "Mono 1", "Mono 2", "Stereo 1/2"]);

  fireEvent.change(screen.getByLabelText("Audio 1 input device"), { target: { value: "Interface" } });
  expect(history.project.tracks[0]).toMatchObject({ input: { device: "Interface", channels: null } });
  expect(channelChoices()).toEqual([
    "Stereo 1/2 (default)",
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Mono ${n}`),
    "Stereo 1/2",
    "Stereo 3/4",
    "Stereo 5/6",
    "Stereo 7/8",
  ]);

  fireEvent.change(screen.getByLabelText("Audio 1 input channels"), { target: { value: "4" } });
  expect(history.project.tracks[0]).toMatchObject({ input: { device: "Interface", channels: [4] } });
  expect(screen.getByLabelText("Audio 1 input channels")).toHaveDisplayValue("Mono 5");
  expect(history.undoLabel).toBe("Set Track Input");

  // Back on the stereo Line In, channel 5 isn't there, so it goes back to the default.
  fireEvent.change(screen.getByLabelText("Audio 1 input device"), { target: { value: "Line In" } });
  expect(history.project.tracks[0]).toMatchObject({ input: { device: "Line In", channels: null } });
  history.undo();
  expect(history.project.tracks[0]).toMatchObject({ input: { device: "Interface", channels: [4] } });
});

test("two Tracks armed on different channels of one device record together, as one undo step", async () => {
  const { inputs, input } = fakeInputs([TAKE, { ...TAKE, startTick: 1_930 }]);
  const { history } = await setUp(inputs);
  click("Add Audio Track");
  click("Add Audio Track");
  await waitFor(() => expect(screen.getAllByRole("option", { name: "Interface" })).toHaveLength(2));
  for (const [track, channels] of [
    ["Audio 1", "4"],
    ["Audio 2", "2,3"],
  ]) {
    fireEvent.change(screen.getByLabelText(`${track} input device`), { target: { value: "Interface" } });
    fireEvent.change(screen.getByLabelText(`${track} input channels`), { target: { value: channels } });
  }

  click("Arm Audio 1");
  await waitFor(() => expect(inputs.open).toHaveBeenLastCalledWith("Interface", [[4]], [0]));
  click("Arm Audio 2");
  // One stream for both: the input reopens with each Track's channels.
  await waitFor(() => expect(inputs.open).toHaveBeenLastCalledWith("Interface", [[4], [2, 3]], [0, 1]));
  await waitFor(() => expect(screen.getByRole("meter", { name: "Audio 2 input level" })).toHaveAttribute("aria-valuetext", "-12.0 dB"));
  // Their Inputs can't change under an armed stream.
  expect(screen.getByLabelText("Audio 1 input channels")).toBeDisabled();

  click("Record audio");
  fireEvent.click(await screen.findByRole("button", { name: "Stop recording audio" }));
  await waitFor(() => expect(history.project.tracks.map((track) => track.clips.length)).toEqual([1, 1]));
  expect(history.project.tracks.map((track) => (track.clips[0] as AudioClip).file)).toEqual(["audio/Audio 1 take.wav", "audio/Audio 2 take.wav"]);
  expect(input.stopRecording).toHaveBeenCalledTimes(1);
  expect(history.undoLabel).toBe("Record audio");
  history.undo();
  expect(history.project.tracks.map((track) => track.clips.length)).toEqual([0, 0]);
});

test("Input Monitoring is an undoable edit the engine hears, and the input knows which engine Track each tap is", async () => {
  const { inputs } = fakeInputs([]);
  const { history, output } = await setUp(inputs);
  // An Instrument Track first: the Audio Track is the engine's second.
  click("Add Instrument Track");
  click("Add Audio Track");
  expect(screen.getByText(/Use headphones/)).toBeInTheDocument();

  output.send.mockClear();
  fireEvent.click(screen.getByRole("checkbox", { name: "Monitor Audio 2" }));
  expect(history.project.tracks[1]).toMatchObject({ kind: "audio", monitoring: true });
  expect(history.undoLabel).toBe("Set Input Monitoring");
  await waitFor(() => expect(output.send).toHaveBeenCalledWith({ type: "setTrackMonitoring", track: 1, on: true }));

  await screen.findByRole("option", { name: "Line In" });
  click("Arm Audio 2");
  await waitFor(() => expect(inputs.open).toHaveBeenCalledWith(null, [null], [1]));
  // It can be turned off while armed.
  expect(screen.getByRole("checkbox", { name: "Monitor Audio 2" })).toBeEnabled();
  history.undo();
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "Monitor Audio 2" })).not.toBeChecked());
  await waitFor(() => expect(output.send).toHaveBeenCalledWith({ type: "setTrackMonitoring", track: 1, on: false }));
});

test("Tracks on different devices can't be armed together", async () => {
  const { inputs } = fakeInputs([]);
  await setUp(inputs);
  click("Add Audio Track");
  click("Add Audio Track");
  await waitFor(() => expect(screen.getAllByRole("option", { name: "Interface" })).toHaveLength(2));
  fireEvent.change(screen.getByLabelText("Audio 2 input device"), { target: { value: "Interface" } });
  click("Arm Audio 1");
  await screen.findByRole("button", { name: "Disarm Audio 1" });
  click("Arm Audio 2");
  expect(await screen.findByRole("alert")).toHaveTextContent("Tracks armed together record from one input device");
  expect(screen.getByRole("button", { name: "Arm Audio 2" })).toHaveAttribute("aria-pressed", "false");
  expect(inputs.open).toHaveBeenCalledTimes(1);
});

test("a take with nothing in it adds nothing", async () => {
  const { inputs } = fakeInputs([]);
  const { history } = await setUp(inputs);
  click("Add Audio Track");
  click("Arm Audio 1");
  await screen.findByRole("button", { name: "Disarm Audio 1" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Record audio" })).toBeEnabled());
  click("Record audio");
  fireEvent.click(await screen.findByRole("button", { name: "Stop recording audio" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Record audio" })).toBeInTheDocument());
  expect(history.project.tracks[0]!.clips).toEqual([]);
});

test("the Record audio Widget is off the Grid until there is an Audio Track to record onto", async () => {
  const { inputs } = fakeInputs([]);
  await setUp(inputs);
  expect(screen.queryByRole("button", { name: "Move Record audio" })).not.toBeInTheDocument();
  click("Add Audio Track");
  expect(screen.getByRole("button", { name: "Move Record audio" })).toBeInTheDocument();
  click("Delete Audio 1");
  expect(screen.queryByRole("button", { name: "Move Record audio" })).not.toBeInTheDocument();
});

test("where the platform has no audio inputs, the Record audio Widget stays off the Grid", async () => {
  await setUp(null);
  click("Add Audio Track");
  expect(screen.queryByRole("button", { name: "Move Record audio" })).not.toBeInTheDocument();
});

test("no Request starts while a take is recording, so the take isn't refused when it lands", async () => {
  const { inputs } = fakeInputs([TAKE]);
  const history = new ProjectHistory(createProject("Demo"));
  let started = 0;
  const conversations = () => () => {
    started++;
    return { next: () => Promise.resolve({ text: "Done.", toolCalls: [] }) };
  };
  render(
    <SongPage
      openOutput={() => Promise.resolve(fakeOutput())}
      history={history}
      audioInputs={inputs}
      keyStore={memoryKeyStore("sk-test")}
      conversations={conversations}
    />,
  );
  click("Start audio");
  await screen.findByText("Stop audio");
  click("Add Audio Track");
  click("Arm Audio 1");
  await waitFor(() => expect(inputs.open).toHaveBeenCalled());
  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: "add reverb" } });
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();

  click("Record audio");
  await screen.findByText("Stop recording to make a Request.");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  fireEvent.keyDown(screen.getByLabelText("Request"), { key: "Enter" });
  expect(started).toBe(0);

  // The take lands as its own step, and then a Request may start.
  click("Stop recording audio");
  await waitFor(() => expect(history.project.tracks[0]!.clips).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  expect(history.undoLabel).toBe("Record audio");
});

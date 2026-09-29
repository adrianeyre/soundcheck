// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { initSync } from "@engine";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import type { AudioOutput, DjAnalysis, EngineCommand } from "../audio/audio-output";
import { memoryLibraryStorage } from "../preset/library-storage";
import { SAMPLE_DRAG_TYPE } from "../samples/sample-drag";
import type { SampleSource } from "../samples/sample-source";
import { DjPage } from "./DjPage";
import type { AddedTake, AddTakeRequest } from "./dj-session";
import { DECK_FIELDS, DJ_REPORT_LEN, GLOBAL_FIELDS } from "./dj-report";
import type { DjRecordingSaver } from "./recording-saver";

beforeAll(() => {
  // The page encodes a recording with the engine's own writer.
  initSync({ module: readFileSync(resolvePath(import.meta.dirname, "../../../engine/pkg/soundcheck_engine_bg.wasm")) });
});

afterEach(cleanup);

const ANALYSIS: DjAnalysis = {
  seconds: 180,
  bpm: 124,
  firstBeat: 0.1,
  key: { tonic: 9, minor: true },
  waveformRate: 100,
  waveform: Array.from({ length: 18_000 * 4 }, (_, i) => (i % 4) / 8),
};

function fakeOutput() {
  const sent: EngineCommand[] = [];
  const report: number[] = Array.from({ length: DJ_REPORT_LEN }, () => 0);
  const load = vi.fn<(deck: number, bytes: Uint8Array) => Promise<DjAnalysis>>(async (deck) => {
    const at = GLOBAL_FIELDS + deck * DECK_FIELDS;
    report[at] = 1;
    report[at + 3] = ANALYSIS.seconds;
    report[at + 4] = ANALYSIS.bpm;
    report[at + 5] = ANALYSIS.bpm;
    report[at + 6] = 1;
    report[at + 21] = 1;
    return ANALYSIS;
  });
  const takeRecording = vi.fn<() => Promise<Float32Array>>(async () => new Float32Array([0.1, 0.1, 0.2, 0.2]));
  const output: AudioOutput = {
    send: (command) => sent.push(command),
    stats: () => ({
      host: "Fake",
      sampleRate: 48_000,
      blockFrames: 128,
      requestedBufferFrames: null,
      baseLatency: 0,
      outputLatency: null,
      underruns: null,
      callbacks: null,
      engine: null,
      meters: null,
      dj: report,
    }),
    currentTime: () => 0,
    takeRecordedNotes: () => [],
    resetCounters: () => {},
    close: async () => {},
    dj: { load, unload: () => {}, loadSample: async () => ({ seconds: 1, bpm: 0 }), unloadSample: () => {}, takeRecording, headphones: false },
  };
  const dj = (name: string) => sent.filter((c) => c.type === "djSet" && c.name === name);
  return { output, sent, report, load, takeRecording, dj };
}

function saver() {
  const save = vi.fn<DjRecordingSaver["save"]>(async (name, kind) => `${name}.${kind}`);
  return { save };
}

async function loadDeckOne(fake: ReturnType<typeof fakeOutput>) {
  const input = screen.getByLabelText("Load a file onto Deck 1");
  const file = new File([new Uint8Array([1, 2, 3])], "Night Drive.mp3", { type: "audio/mpeg" });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(fake.load).toHaveBeenCalled());
  await screen.findAllByText("Night Drive");
  // The Deck's controls wait for the engine to report it loaded and for its analysis.
  const deck = screen.getByRole("region", { name: "Deck 1" });
  await waitFor(() => expect(within(deck).getByRole("button", { name: "Play Deck 1" })).toBeEnabled());
}

test("a new output is told every knob, and a file loads onto a Deck with its BPM and key", async () => {
  const fake = fakeOutput();
  render(<DjPage output={fake.output} active saver={saver()} />);
  expect(fake.dj("crossfader")).toHaveLength(1);
  expect(fake.dj("assign")).toHaveLength(4);

  await loadDeckOne(fake);
  expect(fake.load.mock.calls[0]![0]).toBe(0);
  const deck = screen.getByRole("region", { name: "Deck 1" });
  await waitFor(() => expect(within(deck).getByText("124.00", { selector: ".dj-bpm" })).toBeInTheDocument());
  expect(within(deck).getByText("Am · 8A")).toBeInTheDocument();
  expect(within(deck).getByRole("slider", { name: "Deck 1 needle search" })).toBeInTheDocument();
  // And the Track browser has it, analysed.
  const browser = screen.getByRole("region", { name: "Track browser 1" });
  expect(within(browser).getByText("124.00")).toBeInTheDocument();
});

test("the Deck's controls and the keyboard reach the engine", async () => {
  const fake = fakeOutput();
  render(<DjPage output={fake.output} active saver={saver()} />);
  await loadDeckOne(fake);
  const deck = screen.getByRole("region", { name: "Deck 1" });

  fireEvent.click(await within(deck).findByRole("button", { name: "Play Deck 1" }));
  expect(fake.dj("play").at(-1)).toMatchObject({ index: 0, value: 1 });

  const cue = within(deck).getByRole("button", { name: "Deck 1 cue" });
  fireEvent.pointerDown(cue);
  fireEvent.pointerUp(cue);
  expect(fake.dj("cueDown")).toHaveLength(1);
  expect(fake.dj("cueUp")).toHaveLength(1);

  fireEvent.click(within(deck).getByRole("button", { name: "Deck 1 4 beat loop" }));
  expect(fake.dj("autoLoop").at(-1)).toMatchObject({ value: 4 });
  fireEvent.click(within(deck).getByRole("button", { name: "Deck 1 jump forward 4 beats" }));
  expect(fake.dj("beatJump").at(-1)).toMatchObject({ value: 4 });
  fireEvent.click(within(deck).getByRole("button", { name: "Deck 1 Beat Sync" }));
  expect(fake.dj("sync").at(-1)).toMatchObject({ value: 1 });

  fireEvent.click(within(deck).getByRole("button", { name: "Set Hot Cue A" }));
  expect(within(deck).getByRole("button", { name: /Jump to Hot Cue A/ })).toBeInTheDocument();

  const jog = within(deck).getByRole("group", { name: /Deck 1 jog wheel/ });
  fireEvent.keyDown(jog, { key: "ArrowRight" });
  fireEvent.keyUp(jog, { key: "ArrowRight" });
  expect(fake.dj("bend").map((c) => (c as { value: number }).value)).toEqual([0.04, 0]);

  // W plays Deck 1 from the keyboard, and Q is its Cue.
  fireEvent.keyDown(window, { code: "KeyW" });
  expect(fake.dj("play")).toHaveLength(2);
  fireEvent.keyDown(window, { code: "KeyQ" });
  fireEvent.keyUp(window, { code: "KeyQ" });
  expect(fake.dj("cueDown")).toHaveLength(2);
});

test("the mixer's knobs and faders reach the engine, by mouse or keys", () => {
  const fake = fakeOutput();
  render(<DjPage output={fake.output} active saver={saver()} />);
  const mixer = screen.getByRole("region", { name: "Mixer" });
  const high = within(mixer).getByRole("slider", { name: "Channel 1 high EQ" });
  fireEvent.keyDown(high, { key: "ArrowDown" });
  expect(fake.dj("eqHigh").at(-1)).toMatchObject({ index: 0, value: -0.5 });
  fireEvent.click(within(mixer).getByRole("button", { name: "Kill Channel 2 low" }));
  expect(fake.dj("eqLow").at(-1)).toMatchObject({ index: 1, value: -26 });
  fireEvent.change(within(mixer).getByRole("slider", { name: "Crossfader" }), { target: { value: "-0.5" } });
  expect(fake.dj("crossfader").at(-1)).toMatchObject({ value: -0.5 });
  fireEvent.click(within(mixer).getByRole("radio", { name: "Dub Echo" }));
  expect(fake.dj("colourType").at(-1)).toMatchObject({ value: 1 });
  for (let step = 0; step < 5; step++) fireEvent.click(within(mixer).getByRole("button", { name: /^Next Beat FX/ }));
  expect(within(mixer).getByRole("status", { name: "Beat FX display" })).toHaveTextContent("TRANS");
  fireEvent.click(within(mixer).getByRole("button", { name: "Beat FX on" }));
  expect(fake.dj("beatFxType").at(-1)).toMatchObject({ value: 5 });
  expect(fake.dj("beatFxOn").at(-1)).toMatchObject({ value: 1 });
  expect(within(mixer).getByRole("meter", { name: "Channel 1 level" })).toBeInTheDocument();
  // Only the knob that moved was sent.
  expect(fake.dj("eqHigh")).toHaveLength(4 + 1);
});

test("a recording of the mix is encoded and saved", async () => {
  const fake = fakeOutput();
  const { save } = saver();
  render(<DjPage output={fake.output} active saver={{ save }} />);
  fireEvent.click(screen.getByRole("button", { name: "Record the mix" }));
  expect(fake.dj("record").at(-1)).toMatchObject({ value: 1 });
  // The engine says it is recording.
  fake.report[5] = 1;
  await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
  fireEvent.click(screen.getByRole("button", { name: "Stop and save the recording" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  const [name, kind, bytes] = save.mock.calls[0]!;
  expect(name).toMatch(/^Mix /);
  expect(kind).toBe("wav");
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
  expect(await screen.findByText(/Recording saved/)).toBeInTheDocument();
});

test("a recording of the mix, once stopped, can be added to the song", async () => {
  const fake = fakeOutput();
  const onAddToSong = vi.fn<(request: AddTakeRequest) => Promise<AddedTake>>(async () => ({ message: "Mix take 1 is in the song." }));
  render(<DjPage output={fake.output} active saver={saver()} onAddToSong={onAddToSong} />);
  const mixer = screen.getByRole("region", { name: "Mixer" });
  const add = within(mixer).getByRole("button", { name: "Add the recording to the song, at the playhead, on a new Audio Track" });
  expect(add).toBeDisabled();
  fireEvent.click(within(mixer).getByRole("button", { name: "Record the mix" }));
  expect(fake.dj("recordSource").at(-1)).toMatchObject({ value: 0 });
  fake.report[5] = 1;
  await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
  fireEvent.click(within(mixer).getByRole("button", { name: "Stop and save the recording" }));
  fake.report[5] = 0;
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
  await waitFor(() =>
    expect(onAddToSong).toHaveBeenCalledWith(
      expect.objectContaining({ wav: expect.any(Uint8Array), name: "Mix take", place: "playhead", track: "new", bpm: null }),
    ),
  );
  expect(await screen.findByText("Mix take 1 is in the song.")).toBeInTheDocument();
});

test("without audio the page offers to start it", () => {
  const onStart = vi.fn<() => void>();
  render(<DjPage output={null} onStart={onStart} active saver={saver()} />);
  fireEvent.click(screen.getByRole("button", { name: "Start audio for mixing" }));
  expect(onStart).toHaveBeenCalled();
  expect(screen.getAllByText("Start audio to load a Deck.")).toHaveLength(2);
});

function fakeSamples() {
  const readBytes = vi.fn<SampleSource["readBytes"]>(async () => new Uint8Array([1, 2, 3]));
  const source: SampleSource = {
    chooseFolder: async () => null,
    listAudio: async () => ["Set/Night Drive.mp3"],
    readBytes,
    audition: async () => {},
    stopAudition: async () => {},
  };
  return { source, readBytes };
}

test("a file dragged from the folder tree onto a Deck is read and loaded, and its waveform joins the stack", async () => {
  const fake = fakeOutput();
  const { source, readBytes } = fakeSamples();
  render(<DjPage output={fake.output} active saver={saver()} samples={source} library={memoryLibraryStorage()} />);
  // The Track browser opens on the folder tree, with the Decks to put a file on.
  const browser = screen.getByRole("region", { name: "Track browser 1" });
  expect(within(browser).getByRole("tab", { name: "Folders" })).toHaveAttribute("aria-selected", "true");
  expect(within(browser).getByRole("heading", { name: "Folders" })).toBeInTheDocument();

  const sample = { folder: { id: "music", label: "Music" }, path: "Set/Night Drive.mp3" };
  const deck = screen.getByRole("region", { name: "Deck 2" });
  fireEvent.drop(deck, {
    dataTransfer: {
      types: [SAMPLE_DRAG_TYPE],
      files: [],
      getData: (type: string) => (type === SAMPLE_DRAG_TYPE ? JSON.stringify(sample) : ""),
    },
  });
  await waitFor(() => expect(fake.load).toHaveBeenCalledWith(1, expect.any(Uint8Array)));
  expect(readBytes).toHaveBeenCalledWith(sample);
  const stack = screen.getByRole("region", { name: "Waveforms" });
  await waitFor(() => expect(within(stack).getByRole("img", { name: /Deck 2 waveform around the playhead/ })).toBeInTheDocument());
  expect(within(stack).getByText("Deck 1 is empty")).toBeInTheDocument();
  fireEvent.click(within(stack).getByRole("button", { name: "Zoom the waveforms in" }));
  expect(within(stack).getByLabelText("Showing 4 seconds")).toBeInTheDocument();

  // The loaded list has it, a tab away; the other Track browser stays on its folders.
  fireEvent.click(within(browser).getByRole("tab", { name: /Loaded tracks/ }));
  expect(within(browser).getByRole("tab", { name: "Loaded tracks (1)" })).toHaveAttribute("aria-selected", "true");
  const other = screen.getByRole("region", { name: "Track browser 2" });
  expect(within(other).getByRole("tab", { name: "Folders" })).toHaveAttribute("aria-selected", "true");
});

test("without sample folders the Track browser says so and offers the loaded list", () => {
  render(<DjPage output={fakeOutput().output} active saver={saver()} />);
  const browser = screen.getByRole("region", { name: "Track browser 1" });
  expect(within(browser).getByRole("tab", { name: /Loaded tracks/ })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(within(browser).getByRole("tab", { name: "Folders" }));
  expect(within(browser).getByText(/can't list folders/)).toBeInTheDocument();
});

test("a Deck's BROWSE button goes to the Track browser on its side of the mixer", () => {
  render(<DjPage output={fakeOutput().output} active saver={saver()} />);
  for (const [deck, browser] of [[1, 1], [2, 2]]) {
    fireEvent.click(screen.getByRole("button", { name: `Browse files for Deck ${deck}` }));
    expect(screen.getByRole("region", { name: `Track browser ${browser}` })).toHaveFocus();
  }
});

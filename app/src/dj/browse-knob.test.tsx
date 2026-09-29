// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { AudioOutput, DjAnalysis } from "../audio/audio-output";
import { type LibraryStorage, memoryLibraryStorage } from "../preset/library-storage";
import { saveSampleFolders } from "../samples/sample-folders";
import type { SampleRef, SampleSource } from "../samples/sample-source";
import { DjPages, type DjPagesProps } from "./DjPages";
import { DECK_FIELDS, DJ_REPORT_LEN, GLOBAL_FIELDS } from "./dj-report";

afterEach(cleanup);

const ANALYSIS: DjAnalysis = { seconds: 180, bpm: 120, firstBeat: 0, key: null, waveformRate: 100, waveform: [] };

function fakeOutput() {
  const report: number[] = Array.from({ length: DJ_REPORT_LEN }, () => 0);
  const load = vi.fn<(deck: number, bytes: Uint8Array) => Promise<DjAnalysis>>(async (deck) => {
    report[GLOBAL_FIELDS + deck * DECK_FIELDS] = 1;
    return ANALYSIS;
  });
  const loadSample = vi.fn<(slot: number, bytes: Uint8Array) => Promise<{ seconds: number; bpm: number }>>(async () => ({ seconds: 0.5, bpm: 0 }));
  const output: AudioOutput = {
    send: () => {},
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
    dj: { load, unload: () => {}, loadSample, unloadSample: () => {}, takeRecording: async () => new Float32Array(), headphones: false },
  };
  return { output, load, loadSample };
}

const MUSIC = { id: "music", label: "Music" };
/** Each file's bytes: its path's first letter, so which one was read shows. */
const bytesOf = (sample: SampleRef) => new Uint8Array([sample.path.split("/").at(-1)!.charCodeAt(0)]);

function fakeSamples() {
  const readBytes = vi.fn<SampleSource["readBytes"]>(async (sample) => bytesOf(sample));
  const source: SampleSource = {
    chooseFolder: async () => null,
    listAudio: async () => ["Kick.wav", "Set/Night Drive.mp3", "Set/Sunrise.mp3"],
    readBytes,
    audition: async () => {},
    stopAudition: async () => {},
  };
  return { source, readBytes };
}

async function setUp(overrides: Partial<DjPagesProps> = {}) {
  const fake = fakeOutput();
  const samples = fakeSamples();
  const library: LibraryStorage = memoryLibraryStorage();
  await saveSampleFolders(library, [MUSIC]);
  const props: DjPagesProps = {
    view: "pads",
    panelId: (view) => `page-${view}`,
    output: fake.output,
    saver: { save: async () => null },
    bundled: () => null,
    samples: samples.source,
    library,
    ...overrides,
  };
  const view = render(<DjPages {...props} />);
  return { fake, samples, props, view };
}

const controller = () => screen.getByRole("region", { name: "Pad Controller" });
const knob = () => within(controller()).getByRole("button", { name: /^Browse knob/ });
const turn = (by: 1 | -1) => fireEvent.keyDown(knob(), { key: by > 0 ? "ArrowDown" : "ArrowUp" });
const press = (withShift = false) => fireEvent.click(knob(), { shiftKey: withShift });
const display = () => within(controller()).getByText(/^(Folders: |No track chosen)/);
const browser = (name = "Track browser") => screen.getByRole("region", { name });
const row = (name: string, where = browser()) => within(where).getByRole("treeitem", { name: new RegExp(`^${name}`) });
const half = (side: "Left" | "Right") => within(controller()).getByRole("group", { name: new RegExp(`^${side} half`) });

test("the browse knob moves through the folder tree: turn, press to open, SHIFT and press to close, and LOAD a file onto a Deck", async () => {
  const { fake, samples, view, props } = await setUp();
  await waitFor(() => expect(row("Kick.wav")).toBeInTheDocument());

  // Pressed, the cursor goes from the loaded list to the tree; focus stays on the knob, to go on turning it.
  knob().focus();
  press();
  expect(knob()).toHaveFocus();
  expect(within(browser()).getByRole("tab", { name: "Folders" })).toHaveAttribute("aria-selected", "true");
  expect(display()).toHaveTextContent("Folders: nothing chosen");
  turn(1);
  expect(display()).toHaveTextContent("Folders: Music");
  expect(row("Music")).toHaveAttribute("data-cursor", "true");
  expect(row("Music")).toHaveAttribute("aria-selected", "true");
  turn(1);
  expect(display()).toHaveTextContent("Folders: Set");
  expect(row("Set")).toHaveAttribute("aria-expanded", "false");

  // On a closed folder, the press opens it.
  press();
  await waitFor(() => expect(row("Set")).toHaveAttribute("aria-expanded", "true"));
  turn(1);
  expect(display()).toHaveTextContent("Folders: Night Drive.mp3");
  expect(row("Night Drive.mp3")).toHaveAttribute("data-cursor", "true");

  // LOAD puts the file on the half's Deck, as a loaded track goes, and it joins the loaded list.
  fireEvent.click(within(half("Left")).getByRole("button", { name: /^Load the chosen track onto Deck 1/ }));
  await waitFor(() => expect(fake.load).toHaveBeenCalledWith(0, new Uint8Array(["N".charCodeAt(0)])));
  expect(samples.readBytes).toHaveBeenCalledWith({ folder: MUSIC, path: "Set/Night Drive.mp3" });
  // SHIFT and LOAD: the next file down.
  fireEvent.click(within(half("Right")).getByRole("button", { name: /^Load the chosen track onto Deck 2/ }), { shiftKey: true });
  await waitFor(() => expect(fake.load).toHaveBeenCalledWith(1, new Uint8Array(["S".charCodeAt(0)])));
  expect(display()).toHaveTextContent("Folders: Sunrise.mp3");

  // The Mixer page's Track browsers follow the cursor.
  view.rerender(<DjPages {...props} view="mixing" />);
  // Drawn for the first time, it reads its folders first.
  await waitFor(() => expect(row("Sunrise.mp3", browser("Track browser 1"))).toHaveAttribute("data-cursor", "true"), { timeout: 3000 });
  expect(row("Sunrise.mp3", browser("Track browser 2"))).toHaveAttribute("data-cursor", "true");
  view.rerender(<DjPages {...props} view="pads" />);

  // SHIFT and press, on a file in a folder: the folder closes, the cursor on it.
  press(true);
  await waitFor(() => expect(row("Set")).toHaveAttribute("aria-expanded", "false"));
  expect(display()).toHaveTextContent("Folders: Set");
  expect(within(browser()).queryByRole("treeitem", { name: /^Sunrise/ })).not.toBeInTheDocument();

  // On a folder already closed, or open, the press goes back to the loaded list, where the knob turns through the tracks.
  press();
  await waitFor(() => expect(row("Set")).toHaveAttribute("aria-expanded", "true"));
  press();
  expect(within(browser()).getByRole("tab", { name: "Loaded tracks (2)" })).toHaveAttribute("aria-selected", "true");
  turn(1);
  expect(within(browser()).getByRole("button", { name: "Choose Night Drive, chosen" })).toBeInTheDocument();
});

test("SHIFT and a Sampler pad loads the file the knob is on in the tree into its slot", async () => {
  const { fake } = await setUp();
  await waitFor(() => expect(row("Kick.wav")).toBeInTheDocument());
  press();
  turn(1);
  turn(1);
  turn(1);
  expect(display()).toHaveTextContent("Folders: Kick.wav");

  fireEvent.click(within(half("Left")).getByRole("button", { name: /^PAD MODE 4: SAMPLER/ }));
  fireEvent.click(within(controller()).getByRole("button", { name: "SHIFT" }));
  const pads = within(half("Left")).getByRole("group", { name: /pads, SAMPLER$/ });
  const pad = within(pads).getByRole("button", { name: /^Sampler Slot 1,/ });
  fireEvent.pointerDown(pad);
  fireEvent.pointerUp(pad);
  await waitFor(() => expect(fake.loadSample).toHaveBeenCalledWith(0, new Uint8Array(["K".charCodeAt(0)])));
});

test("on a folder, LOAD says to turn to a file; the musician's own click in the tree moves the knob's cursor there", async () => {
  const { fake } = await setUp();
  await waitFor(() => expect(row("Kick.wav")).toBeInTheDocument());
  press();
  turn(1);
  fireEvent.click(within(half("Left")).getByRole("button", { name: /^Load the chosen track onto Deck 1/ }));
  expect(await within(controller()).findByText(/The browse knob is on Music in the folders: turn it to a file/)).toBeInTheDocument();
  expect(fake.load).not.toHaveBeenCalled();

  fireEvent.click(row("Kick.wav"));
  expect(display()).toHaveTextContent("Folders: Kick.wav");
  fireEvent.click(within(half("Right")).getByRole("button", { name: /^Load the chosen track onto Deck 2/ }));
  await waitFor(() => expect(fake.load).toHaveBeenCalledWith(1, new Uint8Array(["K".charCodeAt(0)])));
});

test("where the platform has no folders, the press stays on the loaded list and the knob turns through it", async () => {
  await setUp({ samples: null });
  const list = browser();
  fireEvent.change(within(list).getByLabelText("Add files to the Track browser"), {
    target: { files: ["A.mp3", "B.mp3"].map((name) => new File([new Uint8Array([1])], name)) },
  });
  await within(list).findByRole("button", { name: "Choose B" });
  press();
  expect(within(list).getByRole("tab", { name: "Loaded tracks (2)" })).toHaveAttribute("aria-selected", "true");
  turn(1);
  expect(within(list).getByRole("button", { name: "Choose A, chosen" })).toBeInTheDocument();
  expect(within(controller()).getByText("A", { selector: ".dj-pc-cursor" })).toBeInTheDocument();
});

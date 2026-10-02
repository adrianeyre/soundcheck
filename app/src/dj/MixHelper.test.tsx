// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { initSync } from "@engine";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import type { StartExchange } from "../assistant/assistant";
import type { Decide } from "../assistant/jev";
import type { AudioOutput, DjAnalysis } from "../audio/audio-output";
import { DjPage } from "./DjPage";
import { DECK_FIELDS, DJ_REPORT_LEN, GLOBAL_FIELDS } from "./dj-report";

beforeAll(() => {
  initSync({ module: readFileSync(resolvePath(import.meta.dirname, "../../../engine/pkg/soundcheck_engine_bg.wasm")) });
});

afterEach(cleanup);

function analysis(bpm: number, tonic: number, minor: boolean): DjAnalysis {
  return { seconds: 200, bpm, firstBeat: 0, key: { tonic, minor }, waveformRate: 100, waveform: [] };
}

/** What each file is, by its first byte: as the fake analysis and the fake Deck both read it. */
const FILES: Record<string, DjAnalysis> = {
  "Night Drive.mp3": analysis(124, 9, true), // Am, 8A
  "Fifth Up.mp3": analysis(125, 4, true), // Em, 9A
  "Clash.mp3": analysis(124, 6, true), // F♯m, 11A
  "Relative.mp3": analysis(122, 0, false), // C, 8B
};
const NAMES = Object.keys(FILES);
const byBytes = (bytes: Uint8Array) => FILES[NAMES[bytes[0]!]!]!;

function fakeOutput() {
  const report: number[] = Array.from({ length: DJ_REPORT_LEN }, () => 0);
  const load = vi.fn<(deck: number, bytes: Uint8Array) => Promise<DjAnalysis>>(async (deck, bytes) => {
    const found = byBytes(bytes);
    const at = GLOBAL_FIELDS + deck * DECK_FIELDS;
    report[at] = 1;
    report[at + 3] = found.seconds;
    report[at + 4] = found.bpm;
    report[at + 5] = found.bpm;
    report[at + 6] = 1;
    report[at + 21] = 1;
    return found;
  });
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
    dj: { load, unload: () => {}, loadSample: async () => ({ seconds: 1, bpm: 0 }), unloadSample: () => {}, takeRecording: async () => new Float32Array(), headphones: false },
  };
  return { output, load };
}

const saver = { save: async (name: string) => name };

async function addTracks() {
  const [input] = screen.getAllByLabelText("Add files to the Track browser");
  const files = NAMES.map((name, index) => new File([new Uint8Array([index])], name, { type: "audio/mpeg" }));
  fireEvent.change(input!, { target: { files } });
  const helper = screen.getByRole("region", { name: "Mix Helper" });
  await within(helper).findByText("All 4 tracks analysed.");
  return helper;
}

test("every track is analysed as it is added, and the rest are ranked by how well each mixes into the Deck", async () => {
  const fake = fakeOutput();
  const analyse = vi.fn<(bytes: Uint8Array) => Promise<DjAnalysis>>(async (bytes) => byBytes(bytes));
  render(<DjPage output={fake.output} active saver={saver} analyse={analyse} />);
  const helper = await addTracks();
  expect(analyse).toHaveBeenCalledTimes(4);
  // Analysed, the Track browser shows each one's BPM and key before any is on a Deck.
  const browser = screen.getByRole("region", { name: "Track browser 1" });
  fireEvent.click(within(browser).getByRole("tab", { name: /Loaded tracks/ }));
  expect(within(browser).getByText("Em · 9A")).toBeInTheDocument();
  expect(within(helper).getByText(/Load a track onto a Deck/)).toBeInTheDocument();

  fireEvent.click(within(browser).getByRole("button", { name: "Load Night Drive onto Deck 1" }));
  const ranking = await within(helper).findByRole("table", { name: "Best matches for Deck 1" });
  const rows = within(ranking).getAllByRole("row").slice(1);
  expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual(["Fifth Up", "Relative", "Clash"]);
  expect(rows[0]).toHaveTextContent("a fifth up");
  expect(rows[2]).toHaveTextContent("a key clash");
  const decks = within(helper).getByRole("table", { name: "On the Decks" });
  expect(within(decks).getByText("Night Drive (paused)")).toBeInTheDocument();
  expect(within(decks).getByText("Am · 8A")).toBeInTheDocument();
  expect(within(helper).getByText(/Set up the Assistant or Jev/)).toBeInTheDocument();

  // A match loads onto a Deck that isn't the one being mixed into.
  fireEvent.click(within(rows[0]!).getByRole("button", { name: "Load Fifth Up onto Deck 2" }));
  await waitFor(() => expect(fake.load).toHaveBeenLastCalledWith(1, expect.any(Uint8Array)));
});

test("Jev and the Assistant, where set up, each pick from the ranking", async () => {
  const fake = fakeOutput();
  const decide = vi.fn<Decide>(async (_state, questions) => {
    const options = Object.keys((questions.next as { options: Record<string, string> }).options);
    const relative = options.find((o) => o.endsWith("Relative"))!;
    return {
      model: "jev-1.13.0",
      usage: { input: 1, output: 0 },
      answers: { next: { kind: "choice", choice: relative, confidence: 0.9, probabilities: Object.fromEntries(options.map((o) => [o, o === relative ? 0.9 : 0.05])) } },
    };
  });
  const exchange = vi.fn<StartExchange>(() => ({
    next: async () => ({
      text: "",
      toolCalls: [{ id: "1", name: "suggest_tracks", input: { picks: [{ trackId: "track-1", why: "Up a fifth, nearly the same tempo." }] } }],
    }),
  }));
  render(
    <DjPage
      output={fake.output}
      active
      saver={saver}
      analyse={async (bytes) => byBytes(bytes)}
      mixHelper={{ assistant: { name: "Claude", exchange }, decide }}
    />,
  );
  const helper = await addTracks();
  const browser = screen.getByRole("region", { name: "Track browser 1" });
  fireEvent.click(within(browser).getByRole("tab", { name: /Loaded tracks/ }));
  fireEvent.click(within(browser).getByRole("button", { name: "Load Night Drive onto Deck 1" }));
  await within(helper).findByRole("table", { name: "Best matches for Deck 1" });

  fireEvent.click(within(helper).getByRole("button", { name: "Ask Jev" }));
  const jev = await within(helper).findByRole("region", { name: "Jev's picks" });
  expect(within(jev).getAllByRole("listitem")[0]).toHaveTextContent("Relative · 122.00 BPM · C · 8B · 90%");
  expect(decide.mock.calls[0]![0]).toMatchObject({ mixing_into: "Deck 1: Night Drive, paused, 124.00 BPM, Am · 8A" });

  fireEvent.click(within(helper).getByRole("button", { name: "Ask the Assistant (Claude)" }));
  const picks = await within(helper).findByRole("region", { name: "The Assistant's picks" });
  expect(within(picks).getByText("Up a fifth, nearly the same tempo.")).toBeInTheDocument();
  expect(within(picks).getByText("Fifth Up")).toBeInTheDocument();
  expect(exchange.mock.calls[0]![1]).toContain("Mixing into Deck 1: Night Drive");
});

const refused: StartExchange = () => ({
  next: async () => {
    throw new Error("Claude would not accept that API key. Check it and enter it again.");
  },
});

test("an Assistant that fails says why", async () => {
  const fake = fakeOutput();
  const exchange = refused;
  render(
    <DjPage output={fake.output} active saver={saver} analyse={async (bytes) => byBytes(bytes)} mixHelper={{ assistant: { name: "Claude", exchange } }} />,
  );
  const helper = await addTracks();
  const browser = screen.getByRole("region", { name: "Track browser 1" });
  fireEvent.click(within(browser).getByRole("tab", { name: /Loaded tracks/ }));
  fireEvent.click(within(browser).getByRole("button", { name: "Load Night Drive onto Deck 1" }));
  fireEvent.click(await within(helper).findByRole("button", { name: "Ask the Assistant (Claude)" }));
  expect(await within(helper).findByRole("alert")).toHaveTextContent("would not accept that API key");
});

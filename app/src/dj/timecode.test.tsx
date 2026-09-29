// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { initSync, timecode_formats } from "@engine";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import type { AudioOutput, EngineCommand } from "../audio/audio-output";
import { DjPages, type DjPagesProps } from "./DjPages";
import { DECK_FIELDS, DECKS, DJ_REPORT_LEN, GLOBAL_FIELDS, readDjReport, SAMPLER_FIELDS, TIMECODE_FIELDS } from "./dj-report";
import type { DjRecordingSaver } from "./recording-saver";
import { readTimecodeSetup, TIMECODE_FORMATS, TIMECODE_KEY, type TimecodeChoice, type TimecodeInput, type TimecodeStatus } from "./timecode-input";

beforeAll(() => {
  initSync({ module: readFileSync(resolvePath(import.meta.dirname, "../../../engine/pkg/soundcheck_engine_bg.wasm")) });
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const timecodeAt = (deck: number, field: number) => GLOBAL_FIELDS + DECKS * DECK_FIELDS + SAMPLER_FIELDS + deck * TIMECODE_FIELDS + field;

function fakeOutput() {
  const sent: EngineCommand[] = [];
  const report: number[] = Array.from({ length: DJ_REPORT_LEN }, () => 0);
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
    dj: {
      load: async () => {
        throw new Error("no file here");
      },
      unload: () => {},
      loadSample: async () => ({ seconds: 1, bpm: 0 }),
      unloadSample: () => {},
      takeRecording: async () => new Float32Array(),
      headphones: false,
    },
  };
  const dj = (name: string, index?: number) =>
    sent.filter((c): c is Extract<EngineCommand, { type: "djSet" }> => c.type === "djSet" && c.name === name && (index === undefined || c.index === index));
  return { output, sent, report, dj };
}

function fakeInput() {
  let chosen: TimecodeChoice[] = [];
  const status = (): TimecodeStatus => ({ choices: chosen, running: [...new Set(chosen.map((c) => c.device))], failed: null });
  return {
    listDevices: vi.fn<TimecodeInput["listDevices"]>(async () => [
      { name: "DJ Interface", channels: 4 },
      { name: "Microphone", channels: 1 },
    ]),
    choose: vi.fn<TimecodeInput["choose"]>(async (choices) => {
      chosen = choices;
      return status();
    }),
    status: vi.fn<TimecodeInput["status"]>(async () => status()),
  } satisfies TimecodeInput;
}

const saver = (): DjRecordingSaver => ({ save: vi.fn<DjRecordingSaver["save"]>(async (name, kind) => `${name}.${kind}`) });

function setUp(overrides: Partial<DjPagesProps> = {}) {
  const fake = fakeOutput();
  const props: DjPagesProps = {
    view: "pads",
    panelId: (view) => `page-${view}`,
    output: fake.output,
    saver: saver(),
    bundled: () => null,
    ...overrides,
  };
  const view = render(<DjPages {...props} />);
  return { fake, props, view };
}

/** Let the page read the engine's report again. */
const nextReport = () => act(() => new Promise((resolve) => setTimeout(resolve, 60)));

const controller = () => screen.getByRole("region", { name: "Pad Controller" });
const leftHalf = () => within(controller()).getByRole("group", { name: /^Left half/ });
const int = () => within(leftHalf()).getByRole("button", { name: /^Deck 1 INT/ });

test("the records a Deck can read are the engine's, and the report says what each Deck's vinyl is doing", () => {
  const engine = JSON.parse(timecode_formats()) as { id: string; label: string; carrier: number }[];
  expect(TIMECODE_FORMATS).toEqual(engine);

  const flat = Array.from({ length: DJ_REPORT_LEN }, () => 0);
  flat[timecodeAt(1, 0)] = 2;
  flat[timecodeAt(1, 1)] = 1;
  flat[timecodeAt(1, 2)] = -0.5;
  flat[timecodeAt(1, 3)] = 42.5;
  flat[timecodeAt(1, 4)] = 2000;
  flat[timecodeAt(1, 5)] = 4;
  flat[timecodeAt(1, 6)] = 1;
  flat[timecodeAt(0, 3)] = -1;
  const report = readDjReport(flat);
  expect(report.decks[1]).toMatchObject({
    mode: "abs",
    timecode: { signal: true, speed: -0.5, position: 42.5, carrier: 2000, format: 4, absReady: true },
  });
  expect(report.decks[0]).toMatchObject({ mode: "int", timecode: { signal: false, position: null } });
});

test("INT turns the half's Deck to REL and back, as the engine reports it", async () => {
  const input = fakeInput();
  const { fake } = setUp({ timecodeInput: input });
  expect(int()).toHaveAttribute("data-light", "on");
  fireEvent.click(int());
  expect(fake.dj("mode", 0).at(-1)).toMatchObject({ kind: "deck", value: 1 });
  expect(screen.getByText(/Deck 1 is in REL, but has no timecode input yet/)).toBeInTheDocument();

  fake.report[timecodeAt(0, 0)] = 1;
  await nextReport();
  expect(int()).toHaveAccessibleName(/now REL/);
  expect(int()).not.toHaveAttribute("data-light");
  fireEvent.click(int());
  expect(fake.dj("mode", 0).at(-1)).toMatchObject({ value: 0 });

  // From ABS, INT goes back to INT too.
  fake.report[timecodeAt(0, 0)] = 2;
  await nextReport();
  fireEvent.click(int());
  expect(fake.dj("mode", 0).at(-1)).toMatchObject({ value: 0 });
});

test("where there is no timecode input, INT says REL needs the Desktop App and leaves the Deck alone", () => {
  const { fake } = setUp({ timecodeInput: null });
  fireEvent.click(within(leftHalf()).getByRole("button", { name: /^Deck 1 INT/ }));
  expect(fake.dj("mode")).toHaveLength(0);
  expect(screen.getByText(/needs the Desktop App/)).toBeInTheDocument();
});

test("a Deck's panel shows its mode, its record's signal and speed, and chooses its input and record", async () => {
  const input = fakeInput();
  const { fake } = setUp({ view: "mixing", timecodeInput: input });
  const deck = screen.getByRole("region", { name: "Deck 2" });
  const panel = within(deck).getByRole("group", { name: "Deck 2 timecode vinyl" });

  fireEvent.click(within(panel).getByRole("radio", { name: /^Deck 2 ABS/ }));
  expect(fake.dj("mode", 1).at(-1)).toMatchObject({ value: 2 });
  fake.report[timecodeAt(1, 0)] = 2;
  fake.report[timecodeAt(1, 1)] = 1;
  fake.report[timecodeAt(1, 2)] = 0.98;
  await nextReport();
  expect(within(panel).getByRole("radio", { name: /^Deck 2 ABS/ })).toHaveAttribute("aria-checked", "true");
  expect(within(panel).getByRole("img", { name: "Deck 2: a timecode signal" })).toHaveAttribute("data-light", "on");
  expect(within(panel).getByLabelText("Deck 2 record speed")).toHaveTextContent("+0.980×");
  expect(within(panel).getByText(/choose which record under INPUT/)).toBeInTheDocument();

  fireEvent.click(within(panel).getByRole("button", { name: "Deck 2 timecode input and record" }));
  await within(panel).findByRole("option", { name: "DJ Interface" });
  fireEvent.change(within(panel).getByRole("combobox", { name: "Deck 2 timecode input device" }), { target: { value: "DJ Interface" } });
  await waitFor(() => expect(input.choose).toHaveBeenLastCalledWith([{ deck: 1, device: "DJ Interface", left: 2, right: 3 }]));
  // A four-input interface has two pairs; Deck 2 starts on inputs 3 and 4.
  const pair = within(panel).getByRole("combobox", { name: "Deck 2 timecode input pair" });
  expect(within(pair).getAllByRole("option").map((o) => o.textContent)).toEqual(["Inputs 1-2", "Inputs 3-4"]);
  expect(pair).toHaveValue("2");
  await waitFor(() => expect(within(panel).getByRole("status")).toHaveTextContent("Reading Inputs 3-4 of DJ Interface"));

  fireEvent.change(within(panel).getByRole("combobox", { name: "Deck 2 timecode record" }), { target: { value: "8" } });
  expect(fake.dj("timecodeFormat", 1).at(-1)).toMatchObject({ value: 8 });
  fireEvent.click(within(panel).getByRole("checkbox", { name: "Swap left and right" }));
  expect(fake.dj("timecodeSwap", 1).at(-1)).toMatchObject({ value: 1 });

  // Kept for next time, where the headphone device is.
  expect(JSON.parse(localStorage.getItem(TIMECODE_KEY) ?? "[]")[1]).toEqual({
    device: "DJ Interface",
    left: 2,
    format: 8,
    swap: true,
    invert: false,
  });
});

test("the kept choices are told to each new engine and input, with each Deck's mode", async () => {
  localStorage.setItem(
    TIMECODE_KEY,
    JSON.stringify([{ device: "DJ Interface", left: 0, format: 1, swap: false, invert: true }, { device: null, left: 2, format: 0 }]),
  );
  expect(readTimecodeSetup()[0]).toEqual({ device: "DJ Interface", left: 0, format: 1, swap: false, invert: true });
  const input = fakeInput();
  const { fake, props, view } = setUp({ timecodeInput: input });
  await waitFor(() => expect(input.choose).toHaveBeenCalledWith([{ deck: 0, device: "DJ Interface", left: 0, right: 1 }]));
  expect(fake.dj("timecodeFormat", 0).at(-1)).toMatchObject({ value: 1 });
  expect(fake.dj("timecodeInvert", 0).at(-1)).toMatchObject({ value: 1 });

  fake.report[timecodeAt(0, 0)] = 1;
  await nextReport();
  const next = fakeOutput();
  view.rerender(<DjPages {...props} output={next.output} />);
  expect(next.dj("mode", 0).at(-1)).toMatchObject({ value: 1 });
  expect(next.dj("timecodeFormat", 0).at(-1)).toMatchObject({ value: 1 });
  await waitFor(() => expect(input.choose).toHaveBeenCalledTimes(2));
});

test("kept choices that don't make sense are put back to their defaults", () => {
  localStorage.setItem(TIMECODE_KEY, JSON.stringify([{ device: 3, left: -2, format: 99 }, "nonsense"]));
  expect(readTimecodeSetup().slice(0, 2)).toEqual([
    { device: null, left: 0, format: 0, swap: false, invert: false },
    { device: null, left: 2, format: 0, swap: false, invert: false },
  ]);
  localStorage.setItem(TIMECODE_KEY, "{not json");
  expect(readTimecodeSetup()).toHaveLength(DECKS);
});

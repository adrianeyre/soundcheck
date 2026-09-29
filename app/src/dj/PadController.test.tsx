// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { initSync } from "@engine";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import type { AudioOutput, DjAnalysis, DjSampleInfo, EngineCommand } from "../audio/audio-output";
import { memoryLibraryStorage } from "../preset/library-storage";
import { DjPages, type DjPagesProps } from "./DjPages";
import type { AddedTake, AddTakeRequest } from "./dj-session";
import { DECK_FIELDS, DJ_REPORT_LEN, GLOBAL_FIELDS } from "./dj-report";
import type { DjRecordingSaver } from "./recording-saver";
import { readSampler, slotAudioPath } from "./sampler-library";

beforeAll(() => {
  // A take is encoded with the engine's own writer.
  initSync({ module: readFileSync(resolvePath(import.meta.dirname, "../../../engine/pkg/soundcheck_engine_bg.wasm")) });
});

afterEach(cleanup);

const ANALYSIS: DjAnalysis = {
  seconds: 180,
  bpm: 120,
  firstBeat: 0,
  key: { tonic: 9, minor: true },
  waveformRate: 100,
  waveform: Array.from({ length: 400 }, () => 0.1),
};

function fakeOutput() {
  const sent: EngineCommand[] = [];
  const report: number[] = Array.from({ length: DJ_REPORT_LEN }, () => 0);
  const load = vi.fn<(deck: number, bytes: Uint8Array) => Promise<DjAnalysis>>(async (deck) => {
    const at = GLOBAL_FIELDS + deck * DECK_FIELDS;
    report[at] = 1;
    report[at + 2] = 10;
    report[at + 3] = ANALYSIS.seconds;
    report[at + 4] = ANALYSIS.bpm;
    report[at + 5] = ANALYSIS.bpm;
    report[at + 6] = 1;
    report[at + 21] = 1;
    return ANALYSIS;
  });
  // Every sample is found to be at 124 BPM.
  const loadSample = vi.fn<(slot: number, bytes: Uint8Array) => Promise<DjSampleInfo>>(async () => ({ seconds: 0.5, bpm: 124 }));
  const unloadSample = vi.fn<(slot: number) => void>();
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
    dj: { load, unload: () => {}, loadSample, unloadSample, takeRecording, headphones: false },
  };
  const dj = (name: string, kind?: string) =>
    sent.filter((c): c is Extract<EngineCommand, { type: "djSet" }> => c.type === "djSet" && c.name === name && (!kind || c.kind === kind));
  return { output, sent, report, load, loadSample, unloadSample, takeRecording, dj };
}

const controller = () => screen.getByRole("region", { name: "Pad Controller" });

const left = () => within(controller()).getByRole("group", { name: /^Left half/ });
const right = () => within(controller()).getByRole("group", { name: /^Right half/ });
const shift = () => fireEvent.click(within(controller()).getByRole("button", { name: "SHIFT" }));

const hotCuePads = () => within(left()).getByRole("group", { name: /pads, HOT CUE$/ });
const mode = (index: number) => fireEvent.click(within(left()).getByRole("button", { name: new RegExp(`^PAD MODE ${index}:`) }));

const saver = (): DjRecordingSaver => ({ save: vi.fn<DjRecordingSaver["save"]>(async (name, kind) => `${name}.${kind}`) });

/** The Starter Kit, as the engine would give it: 22 sounds, each a byte of its own. */
const bundled = (index: number) => (index < 22 ? { name: `Sound ${index + 1}`, bytes: new Uint8Array([index]) } : null);

function setUp(overrides: Partial<DjPagesProps> = {}) {
  const fake = fakeOutput();
  const props: DjPagesProps = {
    view: "pads",
    panelId: (view) => `page-${view}`,
    output: fake.output,
    saver: saver(),
    bundled,
    ...overrides,
  };
  const view = render(<DjPages {...props} />);
  return { fake, props, view };
}

/** Press and let go of a held button, or a pad. */
function tap(element: HTMLElement) {
  fireEvent.pointerDown(element);
  fireEvent.pointerUp(element);
}

async function loadDeck(deck: number, name = "Night Drive.mp3") {
  const browser = screen.getByRole("region", { name: "Track browser" });
  fireEvent.change(within(browser).getByLabelText("Add files to the Track browser"), {
    target: { files: [new File([new Uint8Array([1, 2, 3])], name, { type: "audio/mpeg" })] },
  });
  const title = name.replace(/\.[^.]+$/, "");
  fireEvent.click(await within(browser).findByRole("button", { name: `Choose ${title}` }));
  fireEvent.click(within(browser).getByRole("button", { name: `Load ${title} onto Deck ${deck + 1}` }));
}

async function waitForReport() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
}

test("the Sampler starts with the Starter Kit, and a pad plays its slot while the bank chooses which", async () => {
  const { fake } = setUp();
  await waitFor(() => expect(fake.loadSample).toHaveBeenCalledTimes(22));
  expect(fake.loadSample).toHaveBeenCalledWith(0, new Uint8Array([0]));

  fireEvent.click(within(left()).getByRole("button", { name: /^PAD MODE 4: SAMPLER/ }));
  const pads = within(left()).getByRole("group", { name: /pads, SAMPLER$/ });
  const kick = within(pads).getByRole("button", { name: "Sampler Slot 1, Sound 1" });
  fireEvent.pointerDown(kick);
  expect(fake.dj("play", "sampler").at(-1)).toMatchObject({ index: 0 });
  fireEvent.pointerUp(kick);
  expect(fake.dj("release", "sampler").at(-1)).toMatchObject({ index: 0 });

  // PARAMETER in Sampler mode changes the bank, which both halves share.
  fireEvent.click(within(left()).getByRole("button", { name: "Next Sampler bank" }));
  tap(within(pads).getByRole("button", { name: "Sampler Slot 17, Sound 17" }));
  expect(fake.dj("play", "sampler").at(-1)).toMatchObject({ index: 16 });
  fireEvent.click(within(right()).getByRole("button", { name: /^PAD MODE 4: SAMPLER/ }));
  expect(within(right()).getByRole("button", { name: "Sampler Slot 22, Sound 22" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "BANK 4" }));
  expect(within(right()).getByRole("button", { name: "Sampler Slot 64, empty" })).toBeInTheDocument();
});

test("SHIFT and a Sampler pad pauses a sounding slot, or loads the chosen track into a still one", async () => {
  const { fake } = setUp();
  await waitFor(() => expect(fake.loadSample).toHaveBeenCalledTimes(22));
  await loadDeck(0, "Vocal Chop.wav");
  fireEvent.click(within(left()).getByRole("button", { name: /^PAD MODE 4: SAMPLER/ }));

  fireEvent.click(within(controller()).getByRole("button", { name: "SHIFT" }));
  tap(within(left()).getByRole("button", { name: "Sampler Slot 3, Sound 3" }));
  await waitFor(() => expect(fake.loadSample).toHaveBeenLastCalledWith(2, new Uint8Array([1, 2, 3])));
  expect(await within(left()).findByRole("button", { name: "Sampler Slot 3, Vocal Chop" })).toBeInTheDocument();

  // Sounding (as the engine reports it), SHIFT and the pad pauses it.
  fake.report[GLOBAL_FIELDS + 4 * DECK_FIELDS + 4 + 2] = 2;
  await waitForReport();
  fireEvent.click(within(controller()).getByRole("button", { name: "SHIFT" }));
  tap(within(left()).getByRole("button", { name: "Sampler Slot 3, Vocal Chop" }));
  expect(fake.dj("pause", "sampler").at(-1)).toMatchObject({ index: 2 });
  // SHIFT lets go after one press.
  expect(within(controller()).getByRole("button", { name: "SHIFT" })).toHaveAttribute("aria-pressed", "false");
});

test("each slot can be changed, renamed, set to loop or cleared, and is kept for next time", async () => {
  const library = memoryLibraryStorage();
  const { fake } = setUp({ library });
  await waitFor(() => expect(fake.loadSample).toHaveBeenCalledTimes(22));
  fireEvent.click(within(controller()).getByRole("button", { name: "Edit the Sampler Slots" }));
  const slots = within(controller()).getByRole("group", { name: "Bank 1 Sampler Slots" });

  fireEvent.change(within(slots).getByLabelText("Load a file into a Sampler Slot"), {
    target: { files: [new File([new Uint8Array([9, 9])], "Air Horn.wav")] },
  });
  await waitFor(() => expect(fake.loadSample).toHaveBeenLastCalledWith(0, new Uint8Array([9, 9])));
  expect(await within(slots).findByDisplayValue("Air Horn")).toBeInTheDocument();
  fireEvent.change(within(slots).getByLabelText("Slot 1 name"), { target: { value: "Horn" } });
  fireEvent.change(within(slots).getByLabelText("Slot 1 plays"), { target: { value: "2" } });
  expect(fake.dj("mode", "sampler").at(-1)).toMatchObject({ index: 0, value: 2 });
  fireEvent.click(within(slots).getByRole("button", { name: "Clear slot 2" }));
  await waitFor(() => expect(fake.unloadSample).toHaveBeenCalledWith(1));

  await waitFor(async () => {
    const saved = await readSampler(library, bundled);
    expect(saved?.slots[0]).toMatchObject({ name: "Horn", mode: 2, bytes: new Uint8Array([9, 9]) });
    expect(saved?.slots[1]).toBeNull();
    expect(saved?.slots[2]).toMatchObject({ name: "Sound 3", bundled: 2 });
  });
  expect(await library.readBytes(slotAudioPath(0))).toEqual(new Uint8Array([9, 9]));

  // A new session opens the Sampler as it was left.
  cleanup();
  const again = setUp({ library });
  await waitFor(() => expect(again.fake.loadSample).toHaveBeenCalledWith(0, new Uint8Array([9, 9])));
  fireEvent.click(within(left()).getByRole("button", { name: /^PAD MODE 4: SAMPLER/ }));
  expect(within(left()).getByRole("button", { name: "Sampler Slot 1, Horn" })).toBeInTheDocument();
  expect(within(left()).getByRole("button", { name: "Sampler Slot 2, empty" })).toBeInTheDocument();
});

test("Hot Cue mode sets, calls and, with SHIFT, deletes the Deck's Hot Cues A to P", async () => {
  const { fake } = setUp();
  await loadDeck(0);
  await waitForReport();
  fireEvent.pointerDown(within(hotCuePads()).getByRole("button", { name: "Deck 1 set Hot Cue P" }));
  const hot = within(hotCuePads()).getByRole("button", { name: /^Deck 1 Hot Cue P, P, at 0:10.0/ });
  expect(hot).toHaveAttribute("data-lit", "on");
  fireEvent.pointerDown(hot);
  expect(fake.dj("jumpHold").at(-1)).toMatchObject({ index: 0, value: 10 });
  fireEvent.pointerUp(hot);
  expect(fake.dj("jumpRelease")).toHaveLength(1);
  fireEvent.click(within(controller()).getByRole("button", { name: "SHIFT" }));
  tap(hot);
  expect(within(hotCuePads()).getByRole("button", { name: "Deck 1 set Hot Cue P" })).toBeInTheDocument();
});

test("SHIFT and each PAD MODE button gives its second mode, with its pages", async () => {
  const { fake } = setUp();
  await loadDeck(0);
  await waitForReport();

  // Beat Jump opens on its second page: 1 beat back, first.
  mode(3);
  tap(within(left()).getByRole("button", { name: "Deck 1 Beat Jump back 1 beat" }));
  expect(fake.dj("beatJump").at(-1)).toMatchObject({ value: -1 });
  tap(within(left()).getByRole("button", { name: "Deck 1 Beat Jump forward 32 bars" }));
  expect(fake.dj("beatJump").at(-1)).toMatchObject({ value: 128 });
  fireEvent.click(within(left()).getByRole("button", { name: "Deck 1 next pad page" }));
  expect(within(left()).getByText("PAGE 3/3")).toBeInTheDocument();
  tap(within(left()).getByRole("button", { name: "Deck 1 Beat Jump forward 128 beats" }));
  expect(fake.dj("beatJump").at(-1)).toMatchObject({ value: 128 });
  fireEvent.click(within(left()).getByRole("button", { name: "Deck 1 next pad page" }));
  tap(within(left()).getByRole("button", { name: "Deck 1 Beat Jump back FINE" }));
  expect(fake.dj("beatJump").at(-1)).toMatchObject({ value: -1 / 32 });

  // SHIFT: Beat Loop, 1/64 of a beat to 128 bars.
  shift();
  mode(3);
  expect(within(left()).getByRole("group", { name: /pads, BEAT LOOP$/ })).toBeInTheDocument();
  tap(within(left()).getByRole("button", { name: "Deck 1 Beat Loop 128 bars" }));
  expect(fake.dj("autoLoop").at(-1)).toMatchObject({ value: 512 });

  // SHIFT and PAD MODE 1: Keyboard, the Hot Cue played at a pitch.
  shift();
  mode(1);
  const up7 = within(left()).getByRole("button", { name: "Deck 1 play Hot Cue A at +7 semitones" });
  fireEvent.pointerDown(up7);
  expect(fake.dj("keyShift").at(-1)).toMatchObject({ value: 7 });
  expect(fake.dj("jumpHold").at(-1)).toMatchObject({ value: 0 });
  fireEvent.pointerUp(up7);

  // SHIFT and PAD MODE 4: Key Shift, on five pages.
  shift();
  mode(4);
  fireEvent.click(within(left()).getByRole("button", { name: "Deck 1 previous pad page" }));
  tap(within(left()).getByRole("button", { name: "Deck 1 Key Shift +12 semitones" }));
  expect(fake.dj("keyShift").at(-1)).toMatchObject({ value: 12 });
});

test("a Pad FX takes the Beat FX for its Deck while held and gives it back as the mixer had it", async () => {
  const { fake } = setUp();
  await loadDeck(0);
  await waitForReport();
  fireEvent.click(within(left()).getByRole("button", { name: /^PAD MODE 2:/ }));
  const roll = within(left()).getByRole("button", { name: /^Deck 1 Pad FX F: Roll 1\/8/ });
  fireEvent.pointerDown(roll);
  expect(fake.dj("beatFxType").at(-1)).toMatchObject({ value: 11 });
  expect(fake.dj("beatFxDivision").at(-1)).toMatchObject({ value: 1 / 8 });
  expect(fake.dj("beatFxTarget").at(-1)).toMatchObject({ value: 0 });
  expect(fake.dj("beatFxOn").at(-1)).toMatchObject({ value: 1 });
  fireEvent.pointerUp(roll);
  // The mixer's own: Delay, a beat, on the Master, off.
  expect(fake.dj("beatFxType").at(-1)).toMatchObject({ value: 0 });
  expect(fake.dj("beatFxTarget").at(-1)).toMatchObject({ value: 6 });
  expect(fake.dj("beatFxOn").at(-1)).toMatchObject({ value: 0 });
});

test("the Deck buttons, SLIDE FX and INT drive the half's Deck", async () => {
  const { fake } = setUp();
  await loadDeck(0);
  await waitForReport();
  const slip = within(left()).getByRole("button", { name: "Deck 1 Slip Reverse, while held" });
  fireEvent.pointerDown(slip);
  expect(fake.dj("slipReverse").at(-1)).toMatchObject({ index: 0, value: 1 });
  fireEvent.pointerUp(slip);
  expect(fake.dj("slipReverse").at(-1)).toMatchObject({ value: 0 });
  fireEvent.click(within(left()).getByRole("button", { name: "Deck 1 Silent Cue" }));
  expect(fake.dj("silentCue").at(-1)).toMatchObject({ value: 1 });
  fireEvent.click(within(left()).getByRole("button", { name: "Deck 1 4 beat loop" }));
  expect(fake.dj("autoLoop").at(-1)).toMatchObject({ value: 4 });
  fireEvent.click(within(left()).getByRole("button", { name: "Deck 1 key up a semitone" }));
  expect(fake.dj("keyShift").at(-1)).toMatchObject({ value: 1 });
  fireEvent.click(within(controller()).getByRole("button", { name: "SHIFT" }));
  fireEvent.click(within(left()).getByRole("button", { name: "Make Deck 1 the Sync Master" }));
  expect(fake.dj("syncMaster").at(-1)).toMatchObject({ index: 0 });

  // FX 2 enabled, the touch strip lends it the Beat FX at the strip's level; let go, it gives it back.
  fireEvent.click(within(left()).getByRole("button", { name: /^FX 2, Echo, on Deck 1/ }));
  const strip = within(left()).getByRole("slider", { name: /touch strip: level of Echo/ });
  fireEvent.pointerDown(strip);
  fireEvent.change(strip, { target: { value: "0.8" } });
  expect(fake.dj("beatFxLevel").at(-1)).toMatchObject({ value: 0.8 });
  expect(fake.dj("beatFxType").at(-1)).toMatchObject({ value: 1 });
  fireEvent.pointerUp(strip);
  expect(fake.dj("beatFxOn").at(-1)).toMatchObject({ value: 0 });

  // SHIFT and INT: the left half drives Deck 3, which plays even while the Mixer page shows two Decks.
  fireEvent.click(within(controller()).getByRole("button", { name: "SHIFT" }));
  fireEvent.click(within(left()).getByRole("button", { name: "Switch the left half to Deck 3" }));
  expect(within(controller()).getByRole("group", { name: "Left half, Deck 3" })).toBeInTheDocument();
  fireEvent.click(within(left()).getByRole("button", { name: /^Load the chosen track onto Deck 3/ }));
  await waitFor(() => expect(fake.load).toHaveBeenLastCalledWith(2, expect.any(Uint8Array)));
});

test("the browse knob moves through the loaded tracks and LOAD puts the one it is on onto the Deck", async () => {
  const { fake } = setUp();
  const browser = screen.getByRole("region", { name: "Track browser" });
  fireEvent.change(within(browser).getByLabelText("Add files to the Track browser"), {
    target: { files: ["A.mp3", "B.mp3"].map((name) => new File([new Uint8Array([name.charCodeAt(0)])], name)) },
  });
  await within(browser).findByRole("button", { name: "Choose B" });
  const knob = within(controller()).getByRole("button", { name: /^Browse knob/ });
  fireEvent.keyDown(knob, { key: "ArrowDown" });
  fireEvent.keyDown(knob, { key: "ArrowDown" });
  expect(within(browser).getByRole("button", { name: "Choose B, chosen" })).toBeInTheDocument();
  fireEvent.click(within(right()).getByRole("button", { name: /^Load the chosen track onto Deck 2/ }));
  await waitFor(() => expect(fake.load).toHaveBeenCalledWith(1, new Uint8Array(["B".charCodeAt(0)])));
});

test("a take recorded on the Pads page goes into the song, and the Mixer page shares the Pads page's Decks", async () => {
  const onAddToSong = vi.fn<(request: AddTakeRequest) => Promise<AddedTake>>(async () => ({ message: "Sampler take 1 is in the song." }));
  const { fake, view, props } = setUp({ onAddToSong });
  await loadDeck(0);
  await waitForReport();
  tap(within(within(left()).getByRole("group", { name: /pads, HOT CUE$/ })).getByRole("button", { name: "Deck 1 set Hot Cue A" }));

  fireEvent.click(within(controller()).getByRole("radio", { name: "Record the Sampler alone" }));
  fireEvent.click(within(controller()).getByRole("button", { name: "Record the Sampler" }));
  expect(fake.dj("recordSource").at(-1)).toMatchObject({ value: 1 });
  expect(fake.dj("record").at(-1)).toMatchObject({ value: 1 });
  fake.report[5] = 1;
  fake.report[GLOBAL_FIELDS + 4 * DECK_FIELDS + 3] = 1;
  await waitForReport();
  fireEvent.click(within(controller()).getByRole("button", { name: "Stop recording" }));
  await waitFor(() => expect(fake.takeRecording).toHaveBeenCalled());
  fake.report[5] = 0;
  const add = await within(controller()).findByRole("button", { name: "Add the recording to the song, at the playhead, on a new Audio Track" });
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
  await waitFor(() => expect(onAddToSong).toHaveBeenCalled());
  const { wav, name } = onAddToSong.mock.calls[0]![0];
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
  expect(name).toBe("Sampler take");
  expect(await within(controller()).findByText("Sampler take 1 is in the song.")).toBeInTheDocument();

  // The Mixer page, opened now, is on the same session: Deck 1 has the Hot Cue set on the Pads page.
  view.rerender(<DjPages {...props} view="mixing" />);
  const deck = await screen.findByRole("region", { name: "Deck 1" });
  expect(within(deck).getByRole("button", { name: /^Jump to Hot Cue A/ })).toBeInTheDocument();
  // Its own Pad Controller is on its Grid, hidden until the DJ shows it; the Pads page's is hidden with its page.
  expect(screen.queryAllByRole("region", { name: "Pad Controller" })).toHaveLength(0);
});

test("EDIT SLOTS sets a slot's pitch, cents, sync and BPM, found as it loads, and keeps them", async () => {
  const library = memoryLibraryStorage();
  const { fake } = setUp({ library });
  await waitFor(() => expect(fake.loadSample).toHaveBeenCalledTimes(22));
  // Each slot is told how it plays, at pitch 0 and not synced, with the BPM found for its sample.
  expect(fake.dj("pitch", "sampler").find((c) => c.index === 0)).toMatchObject({ value: 0 });
  expect(fake.dj("sync", "sampler").find((c) => c.index === 0)).toMatchObject({ value: 0 });
  expect(fake.dj("bpm", "sampler").find((c) => c.index === 0)).toMatchObject({ value: 124 });
  fireEvent.click(within(controller()).getByRole("button", { name: "Edit the Sampler Slots" }));
  const slots = within(controller()).getByRole("group", { name: "Bank 1 Sampler Slots" });
  expect(within(slots).getByLabelText("Slot 1 BPM")).toHaveValue(124);

  fireEvent.change(within(slots).getByLabelText("Slot 1 pitch, in semitones"), { target: { value: "7" } });
  expect(fake.dj("pitch", "sampler").at(-1)).toMatchObject({ index: 0, value: 7 });
  fireEvent.change(within(slots).getByLabelText("Slot 1 fine pitch, in cents"), { target: { value: "-25" } });
  expect(fake.dj("pitch", "sampler").at(-1)).toMatchObject({ index: 0, value: 6.75 });
  expect(within(slots).getByLabelText("Slot 1 pitch, in semitones")).toHaveValue(7);
  fireEvent.change(within(slots).getByLabelText("Slot 1 pitch, in semitones"), { target: { value: "30" } });
  expect(fake.dj("pitch", "sampler").at(-1)).toMatchObject({ index: 0, value: 12 });

  const sync = within(slots).getByRole("button", { name: "Sync slot 1 to the master tempo" });
  expect(sync).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(sync);
  expect(fake.dj("sync", "sampler").at(-1)).toMatchObject({ index: 0, value: 1 });
  expect(sync).toHaveAttribute("aria-pressed", "true");

  fireEvent.change(within(slots).getByLabelText("Slot 1 BPM"), { target: { value: "128.5" } });
  expect(fake.dj("bpm", "sampler").at(-1)).toMatchObject({ index: 0, value: 128.5 });

  await waitFor(async () => {
    const saved = await readSampler(library, bundled);
    expect(saved?.slots[0]).toMatchObject({ pitch: 12, sync: true, bpm: 128.5 });
  });

  // A new session sends them again as it gives the engine the slot.
  cleanup();
  const again = setUp({ library });
  await waitFor(() => expect(again.fake.dj("bpm", "sampler").find((c) => c.index === 0)).toMatchObject({ value: 128.5 }));
  expect(again.fake.dj("pitch", "sampler").find((c) => c.index === 0)).toMatchObject({ value: 12 });
  expect(again.fake.dj("sync", "sampler").find((c) => c.index === 0)).toMatchObject({ value: 1 });
});

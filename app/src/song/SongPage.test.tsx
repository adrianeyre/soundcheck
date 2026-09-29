// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { encode_wav, initSync } from "@engine";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import type { AudioOutput, Meters, OpenAudioOutput, RecordedNoteEvent } from "../audio/audio-output";
import type { ModelReply } from "../assistant/assistant";
import { memoryKeyStore } from "../assistant/key-store";
import { BUSY, ProjectHistory } from "../project/history";
import { SYNTH_PARAMS, synthSettingsToFlat } from "../instrument/synth-params";
import { synthPreset, synthPresetNames } from "../instrument/synth-presets";
import { KitLibrary } from "../kit/kit-library";
import { memoryLibraryStorage } from "../preset/library-storage";
import {
  type AudioClip,
  createAudioTrack,
  createDrumTrack,
  createInstrumentTrack,
  createProject,
  DEFAULT_SYNTH,
  type InstrumentTrack,
  STARTER_KIT,
  trackKind,
} from "../project/model";
import { fakeExporter } from "../export/fake-exporter";
import { FakeFileStorage, fakeFolder } from "../storage/fake-file-storage";
import { saveProject } from "../storage/project-folder";
import { NO_STEMS_IN_BROWSER } from "../platform";
import { FAKE_REFUSAL, fakeStemSeparator, type FakeStemSeparatorOptions } from "../stems/fake-stem-separator";
import { type StemSeparator, unavailableStemSeparator } from "../stems/stem-separator";
import { fakeUpdater } from "../update/fake-updater";
import { summariseAudio } from "./import-audio";
import { SongPage } from "./SongPage";
import { FakeRelay } from "../collab/fake-relay";
import { LiveSession } from "../collab/live-session";
import { inviteLink, newInvite } from "../collab/live-wire";
import { chooseFromFileMenu, fileMenuEnabled, openFileMenu } from "../ui/file-menu-testing";

afterEach(cleanup);

// Importing audio measures it with the engine's own decoder, in WASM.
beforeAll(() => {
  initSync({ module: readFileSync(resolvePath(import.meta.dirname, "../../../engine/pkg/soundcheck_engine_bg.wasm")) });
});

/**
 * The engine the tests drive by hand: `engine.position` is where the
 * transport is, and `engine.recorded` is what the host has recorded and not
 * yet handed over.
 */
function fakeOutput() {
  const engine = { trackCount: 0, activeVoices: 0, playing: false, position: 0 };
  const recorded: RecordedNoteEvent[] = [];
  // What the engine would be measuring, for the meters to show.
  let meters: Meters | null = null;
  const output = {
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
      engine,
      meters,
    }),
    currentTime: () => 0,
    takeRecordedNotes: () => recorded.splice(0),
    resetCounters: () => {},
    close: vi.fn<AudioOutput["close"]>(() => Promise.resolve()),
  } satisfies AudioOutput;
  return Object.assign(output, {
    engine,
    recorded,
    setMeters(latest: Meters) {
      meters = latest;
    },
  });
}

function setUp(storage: FakeFileStorage | null = null) {
  const history = new ProjectHistory(createProject("Demo"));
  const output = fakeOutput();
  const openOutput = vi.fn<OpenAudioOutput>(() => Promise.resolve(output));
  render(<SongPage openOutput={openOutput} storage={storage} history={history} />);
  const tracks = () => history.project.tracks as InstrumentTrack[];
  return { history, output, tracks };
}

// The grid has hundreds of cells, and role queries over that many are slow,
// so buttons are found by their accessible name directly.
function button(name: string | RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => {
    const label = (b.getAttribute("aria-label") ?? b.textContent ?? "").trim();
    return typeof name === "string" ? label === name : name.test(label);
  });
  if (!found) throw new Error(`No button ${String(name)}`);
  return found;
}
const click = (name: string | RegExp) => fireEvent.click(button(name));
const cell = (name: string) => screen.getByLabelText(name);
const step = (name: string) => fireEvent.click(cell(name));
const cells = (pitch: string) => screen.getAllByLabelText(new RegExp(`^${pitch} step `));

/** The smallest thing the UI will take as a WAV: a RIFF/WAVE header and some. */
function riffWav(): number[] {
  const wav = [...new Uint8Array(64)];
  [..."RIFF"].forEach((c, i) => (wav[i] = c.codePointAt(0)!));
  [..."WAVE"].forEach((c, i) => (wav[8 + i] = c.codePointAt(0)!));
  return wav;
}

test("adds, renames, reorders and deletes Instrument Tracks, each undoable", () => {
  const { history, tracks } = setUp();
  click("Add Instrument Track");
  click("Add Instrument Track");
  expect(tracks().map((t) => t.name)).toEqual(["Synth 1", "Synth 2"]);
  expect(tracks()[0]!.instrument.type).toBe("synth");

  const [first] = screen.getAllByRole("textbox", { name: "Track name" });
  fireEvent.change(first!, { target: { value: "Bass" } });
  fireEvent.blur(first!);
  expect(tracks()[0]!.name).toBe("Bass");

  click("Move Bass down");
  expect(tracks().map((t) => t.name)).toEqual(["Synth 2", "Bass"]);
  click("Move Bass up");
  expect(tracks().map((t) => t.name)).toEqual(["Bass", "Synth 2"]);

  click("Delete Synth 2");
  expect(tracks().map((t) => t.name)).toEqual(["Bass"]);

  // Undo walks every step back, and redo forward again.
  const steps = 6;
  for (let i = 0; i < steps; i++) click(/^Undo/);
  expect(history.project.tracks).toEqual([]);
  expect(button(/^Undo/)).toBeDisabled();
  for (let i = 0; i < steps; i++) click(/^Redo/);
  expect(tracks().map((t) => t.name)).toEqual(["Bass"]);
  expect(screen.getByRole("textbox", { name: "Track name" })).toHaveValue("Bass");
});

/** The Widgets on the Grid, by id. */
const onGrid = () => [...document.querySelectorAll<HTMLElement>(".widget")].map((frame) => frame.dataset.widget);

test("a Pattern Clip is programmed in the Step Sequencer and every edit undoes", () => {
  const { tracks } = setUp();
  // With no Pattern Clip selected, its editors have nothing to show, so they are off the Grid.
  expect(onGrid()).not.toEqual(expect.arrayContaining(["stepSequencer"]));
  expect(onGrid()).not.toEqual(expect.arrayContaining(["pianoRoll"]));
  expect(onGrid()).not.toEqual(expect.arrayContaining(["instrument"]));
  click("Add Instrument Track");
  click("Add Pattern Clip");
  expect(onGrid()).toEqual(expect.arrayContaining(["stepSequencer", "pianoRoll", "instrument"]));
  const clip = () => tracks()[0]!.clips[0]!;
  expect(clip().length).toBe(4 * 3840);
  // 4 bars of 16ths.
  expect(cells("C4")).toHaveLength(64);

  step("C4 step 1");
  step("E4 step 5");
  expect(clip().notes).toEqual([
    { pitch: 60, start: 0, length: 240, velocity: 0.8 },
    { pitch: 64, start: 960, length: 240, velocity: 0.8 },
  ]);
  expect(cell("C4 step 1")).toHaveAttribute("aria-pressed", "true");

  step("C4 step 1");
  expect(clip().notes.map((n) => n.pitch)).toEqual([64]);
  click(/^Undo/);
  expect(clip().notes.map((n) => n.pitch)).toEqual([60, 64]);
  click(/^Redo/);
  expect(clip().notes.map((n) => n.pitch)).toEqual([64]);

  fireEvent.change(screen.getByLabelText("Length (bars)"), { target: { value: "2" } });
  expect(clip().length).toBe(2 * 3840);
  fireEvent.change(screen.getByLabelText("Step size"), { target: { value: "480" } });
  expect(cells("C4")).toHaveLength(16);
  click(/^Undo/);
  expect(clip().length).toBe(4 * 3840);
});

test("the Piano Roll edits the Step Sequencer's notes, each edit one undo step", () => {
  const { tracks } = setUp();
  click("Add Instrument Track");
  click("Add Pattern Clip");
  const clip = () => tracks()[0]!.clips[0]!;
  const pianoRoll = screen.getByRole("region", { name: "Piano Roll" });

  // A step shows in the Piano Roll...
  step("C4 step 1");
  const drawn = within(pianoRoll).getByRole("button", { name: "C4 at 1.1.000" });
  // ...and moving it there, a step later, shows in the Step Sequencer.
  fireEvent.mouseDown(drawn, { clientX: 0, clientY: 0 });
  fireEvent.mouseMove(window, { clientX: 16, clientY: 0 });
  fireEvent.mouseUp(window, { clientX: 16, clientY: 0 });
  expect(clip().notes).toEqual([{ pitch: 60, start: 240, length: 240, velocity: 0.8 }]);
  expect(cell("C4 step 1")).toHaveAttribute("aria-pressed", "false");
  expect(cell("C4 step 2")).toHaveAttribute("aria-pressed", "true");
  expect(button(/^Undo/)).toHaveAccessibleName("Undo Move notes");

  click(/^Undo/);
  expect(cell("C4 step 1")).toHaveAttribute("aria-pressed", "true");
  expect(within(pianoRoll).getByRole("button", { name: "C4 at 1.1.000" })).toBeInTheDocument();
  click(/^Undo/);
  expect(clip().notes).toEqual([]);
});

test("a preset is picked from the list and its settings are then edited, all undoable", () => {
  const { tracks } = setUp();
  click("Add Instrument Track");
  click("Add Pattern Clip");
  const synth = () => {
    const instrument = tracks()[0]!.instrument;
    if (instrument.type !== "synth") throw new Error("a Synth Track");
    return instrument;
  };
  expect(synth().preset).toBeNull();

  // Every factory preset is on the picker, under its category.
  const picker = screen.getByLabelText("Synth 1 preset") as HTMLSelectElement;
  expect([...picker.options].map((option) => option.value)).toEqual(["", ...synthPresetNames()]);

  fireEvent.change(picker, { target: { value: "Warm Pad" } });
  expect(synth().preset).toBe("Warm Pad");
  expect(synth().settings).toEqual(synthPreset("Warm Pad")!.settings);

  // The panel draws a control for every setting the Synth declares.
  const panel = screen.getByLabelText("Synth 1 Synth");
  expect(panel.querySelectorAll("input, select")).toHaveLength(SYNTH_PARAMS.length);

  const cutoff = screen.getByLabelText(/^Cutoff/);
  fireEvent.change(cutoff, { target: { value: "900" } });
  expect(synth().settings.cutoffHz).toBe(900);
  fireEvent.change(screen.getByLabelText("Oscillator 1 wave"), { target: { value: "square" } });
  expect(synth().settings.osc1Wave).toBe("square");

  click(/^Undo/);
  expect(synth().settings.osc1Wave).toBe(synthPreset("Warm Pad")!.settings.osc1Wave);
  click(/^Undo/);
  expect(synth().settings.cutoffHz).toBe(synthPreset("Warm Pad")!.settings.cutoffHz);
  click(/^Undo/);
  expect(synth().preset).toBeNull();
  expect(synth().settings).toEqual(DEFAULT_SYNTH);
});

test("the engine plays what the Project says once audio starts", async () => {
  const { output } = setUp();
  click("Add Instrument Track");
  click("Add Pattern Clip");
  step("C4 step 1");

  click("Start audio");
  await screen.findByText("Stop audio");
  // The Project reaches the engine from an effect, which runs after the
  // button it renders alongside.
  await waitFor(() => expect(output.send).toHaveBeenCalledWith({ type: "setTrackCount", count: 1 }));
  expect(output.send).toHaveBeenCalledWith({ type: "setTrackNotes", track: 0, notes: [0, 240, 60, 0.8] });

  // The Track's sound goes with it: a new engine Track has the engine's
  // defaults, not the Project's.
  output.send.mockClear();
  fireEvent.change(screen.getByLabelText("Synth 1 preset"), { target: { value: "Saw Lead" } });
  expect(output.send).toHaveBeenCalledWith({
    type: "setSynthSettings",
    track: 0,
    settings: synthSettingsToFlat(synthPreset("Saw Lead")!.settings),
  });

  output.send.mockClear();
  step("D4 step 2");
  expect(output.send).toHaveBeenCalledWith({
    type: "setTrackNotes",
    track: 0,
    notes: [0, 240, 60, 0.8, 240, 240, 62, 0.8],
  });

  click("Play");
  expect(output.send).toHaveBeenCalledWith({ type: "play" });
});

test("Clips are arranged on the timeline, and the ruler sets the loop region", async () => {
  const { history, tracks, output } = setUp();
  click("Add Instrument Track");
  click("Add Pattern Clip");
  step("C4 step 1");

  // One bar is 96 px at the default zoom, so this is a two-bar drag right.
  const clip = screen.getByLabelText("Synth 1 Clip 1");
  fireEvent.mouseDown(clip, { clientX: 0 });
  fireEvent.mouseUp(clip, { clientX: 2 * 96 });
  expect(tracks()[0]!.clips[0]!.start).toBe(2 * 3840);

  click("Start audio");
  await screen.findByText("Stop audio");
  // The engine plays the note where the Clip now sits.
  await waitFor(() =>
    expect(output.send).toHaveBeenCalledWith({ type: "setTrackNotes", track: 0, notes: [7680, 240, 60, 0.8] }),
  );

  output.send.mockClear();
  fireEvent.mouseDown(screen.getByLabelText("Ruler"), { clientX: 0 });
  fireEvent.mouseUp(window, { clientX: 4 * 96 });
  expect(output.send).toHaveBeenCalledWith({ type: "setLoop", startTick: 0, endTick: 4 * 3840, enabled: true });
  expect(screen.getByLabelText("Plays")).toHaveTextContent("Loop region: 1.1.000–5.1.000 · loops");

  click(/^Undo/);
  expect(tracks()[0]!.clips[0]!.start).toBe(0);
  expect(history.undoLabel).toBe("Edit notes");
});

test("opening a saved Project plays and edits that Project instead", async () => {
  const storage = new FakeFileStorage();
  const saved = new ProjectHistory(createProject("Night drive"));
  saved.execute({ type: "addTrack", track: createInstrumentTrack("Pad", "pad") });
  saved.execute({ type: "addClip", trackId: "pad", clip: { id: "pad-1", kind: "pattern", start: 0, length: 3840, notes: [{ pitch: 62, start: 0, length: 240, velocity: 0.5 }] } });
  await saveProject(storage, saved.project, fakeFolder("/songs/night"));
  storage.openChoice = fakeFolder("/songs/night");

  const { output } = setUp(storage);
  click("Add Instrument Track");
  // The Project in hand has unsaved changes, so opening asks first.
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  click("Start audio");
  await screen.findByText("Stop audio");

  output.send.mockClear();
  chooseFromFileMenu("Open…");
  await screen.findByDisplayValue("Night drive");
  // The Project that was being edited is gone, and the opened one is here.
  expect(screen.getAllByRole("textbox", { name: "Track name" }).map((input) => (input as HTMLInputElement).value)).toEqual(["Pad"]);
  // The engine follows the Project that was opened, from an effect that can run
  // a little after it shows.
  await waitFor(() => expect(output.send).toHaveBeenCalledWith({ type: "setTrackNotes", track: 0, notes: [0, 240, 62, 0.5] }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("haven't been saved"));
  confirm.mockRestore();
});

test("the mixer sets a Track's channel and the Master, and the engine hears it", async () => {
  const { output, history, tracks } = setUp();
  click("Add Instrument Track");

  click("Start audio");
  await screen.findByText("Stop audio");
  output.send.mockClear();

  fireEvent.change(screen.getByLabelText("Synth 1 volume"), { target: { value: "0.5" } });
  fireEvent.change(screen.getByLabelText("Synth 1 pan"), { target: { value: "-1" } });
  click("Mute Synth 1");
  click("Solo Synth 1");
  expect(tracks()[0]!.mixer).toEqual({ volume: 0.5, pan: -1, mute: true, solo: true, eq: { low: 0, lowMid: 0, highMid: 0, high: 0 } });
  expect(output.send).toHaveBeenCalledWith({
    type: "setTrackMixer",
    track: 0,
    volume: 0.5,
    pan: -1,
    mute: true,
    solo: true,
  });

  fireEvent.change(screen.getByLabelText("Master volume"), { target: { value: "0.25" } });
  expect(history.project.master.volume).toBe(0.25);
  expect(output.send).toHaveBeenCalledWith({ type: "setMasterVolume", volume: 0.25 });

  // Every mixer move is a Project command, so it undoes.
  click(/^Undo/);
  expect(history.project.master.volume).toBe(1);
});

test("the meters show what the engine measured", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { output } = setUp();
    click("Add Instrument Track");
    click("Start audio");
    await screen.findByText("Stop audio");

    output.setMeters({ master: 1, tracks: [0.5] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(screen.getByLabelText("Master level")).toHaveAttribute("aria-valuetext", "0.0 dB, clipping");
    expect(screen.getByLabelText("Synth 1 level")).toHaveAttribute("aria-valuetext", "-6.0 dB");
  } finally {
    vi.useRealTimers();
  }
});

const noteOn = (tick: number, pitch: number, velocity = 0.8): RecordedNoteEvent => ({
  tick,
  pitch,
  velocity,
  on: true,
});
const noteOff = (tick: number, pitch: number): RecordedNoteEvent => ({
  tick,
  pitch,
  velocity: 0,
  on: false,
});

const BAR = 3_840;

/** Start audio with one Instrument Track, ready to record. */
async function ready() {
  const parts = setUp();
  click("Add Instrument Track");
  click("Start audio");
  await screen.findByText("Stop audio");
  return parts;
}

test("recording a live keyboard makes a Pattern Clip where recording started", async () => {
  const { output, tracks, history } = await ready();
  // Live notes play the Track being recorded onto; under load React can run
  // the effect that says so a little after "Stop audio" shows.
  await waitFor(() => expect(output.send).toHaveBeenCalledWith({ type: "setLiveTrack", track: 0 }));

  output.engine.position = BAR;
  click("Record");
  expect(output.send).toHaveBeenCalledWith({ type: "setRecording", on: true });
  expect(output.send).toHaveBeenCalledWith({ type: "play" });
  expect(button("Stop recording")).toHaveAttribute("aria-pressed", "true");

  // Two notes played a beat apart; the second is still held at the stop.
  output.recorded.push(noteOn(BAR + 240, 60), noteOff(BAR + 480, 60), noteOn(BAR + 960, 64, 0.5));
  output.engine.position = BAR + 1_920;
  click("Stop recording");
  expect(output.send).toHaveBeenCalledWith({ type: "setRecording", on: false });
  expect(output.send).toHaveBeenCalledWith({ type: "stop" });

  const clip = tracks()[0]!.clips[0]!;
  expect(clip.start).toBe(BAR);
  expect(clip.length).toBe(4 * BAR);
  expect(clip.notes).toEqual([
    { pitch: 60, start: 240, length: 240, velocity: 0.8 },
    // Held at the stop, so it ends there.
    { pitch: 64, start: 960, length: 960, velocity: 0.5 },
  ]);

  // The whole recording is one undo step.
  expect(history.undoLabel).toBe("Record");
  click(/^Undo/);
  expect(tracks()[0]!.clips).toEqual([]);
});

test("recording into the selected Clip places notes relative to it and keeps what was there", async () => {
  const { output, tracks } = await ready();
  click("Add Pattern Clip");
  step("C4 step 1");
  const clip = () => tracks()[0]!.clips[0]!;
  expect(clip().start).toBe(0);

  output.engine.position = 960;
  click("Record");
  output.recorded.push(noteOn(1_000, 67), noteOff(1_240, 67));
  output.engine.position = 1_920;
  click("Stop recording");

  expect(tracks()[0]!.clips).toHaveLength(1);
  expect(clip().notes).toEqual([
    { pitch: 60, start: 0, length: 240, velocity: 0.8 },
    { pitch: 67, start: 1_000, length: 240, velocity: 0.8 },
  ]);
});

test("quantising snaps recorded starts to the Step Sequencer's step size", async () => {
  const { output, tracks } = await ready();
  fireEvent.click(screen.getByLabelText("Quantise to step size"));

  click("Record");
  output.recorded.push(noteOn(13, 60), noteOff(200, 60), noteOn(1_010, 64), noteOff(1_100, 64));
  output.engine.position = 1_920;
  click("Stop recording");

  // The default step is a 16th: 240 ticks.
  expect(tracks()[0]!.clips[0]!.notes.map((note) => note.start)).toEqual([0, 960]);
});

test("recording nothing leaves the Project alone", async () => {
  const { output, tracks, history } = await ready();
  click("Record");
  output.engine.position = 960;
  click("Stop recording");
  expect(tracks()[0]!.clips).toEqual([]);
  expect(history.undoLabel).toBe("Add Track");
  expect(output.send).toHaveBeenCalledWith({ type: "setRecording", on: false });
});

test("the computer keyboard plays into the engine, so it records like a MIDI keyboard", async () => {
  const { output } = await ready();
  click("Record");
  // The home row is white keys; A is the C of the current octave.
  fireEvent.keyDown(window, { code: "KeyA" });
  fireEvent.keyUp(window, { code: "KeyA" });
  // The engine stamps and logs whatever reaches it, so playing is recording.
  expect(output.send).toHaveBeenCalledWith({ type: "noteOn", note: 60, velocity: 0.8 });
  expect(output.send).toHaveBeenCalledWith({ type: "noteOff", note: 60 });
});

test("playback stops at the end of the song, or loops it with Loop ticked", async () => {
  const { output } = await ready();
  click("Add Pattern Clip");
  // A four-bar Clip is a four-bar song: Play stops there and goes back to the start.
  await waitFor(() => expect(output.send).toHaveBeenCalledWith({ type: "setPlayRange", startTick: 0, endTick: 4 * BAR }));
  expect(output.send).toHaveBeenCalledWith({ type: "setLoop", startTick: 0, endTick: 4 * BAR, enabled: false });
  fireEvent.click(screen.getByRole("checkbox", { name: /Loop/ }));
  expect(output.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "setMetronome" }));
  expect(output.send).toHaveBeenCalledWith({ type: "setLoop", startTick: 0, endTick: 4 * BAR, enabled: true });
});

test("an empty song stops after its first bar, a take plays on, and Whole song clears a Section", async () => {
  const { output, history } = await ready();
  // Nothing on the timeline: Play plays a bar and stops, rather than on for ever.
  await waitFor(() => expect(output.send).toHaveBeenCalledWith({ type: "setPlayRange", startTick: 0, endTick: BAR }));
  // Recording runs on past the end, so the take is never cut off.
  output.send.mockClear();
  click("Record");
  await waitFor(() => expect(output.send).toHaveBeenCalledWith({ type: "setPlayRange", startTick: 0, endTick: 0 }));
  click("Stop recording");

  // A Section selected on the timeline is what plays, until Whole song.
  history.execute({ type: "addSection", section: { id: "verse", name: "Verse", startBar: 3, bars: 2 } });
  const verse = await screen.findByRole("button", { name: /^Section Verse,/ });
  fireEvent.mouseDown(verse, { clientX: 5 });
  fireEvent.mouseUp(window, { clientX: 5 });
  expect(screen.getByLabelText("Plays")).toHaveTextContent("Verse");
  output.send.mockClear();
  click("Whole song");
  expect(screen.getByRole("button", { name: /^Section Verse,/ })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByLabelText("Plays")).toHaveTextContent("Whole song");
});

test("clicking a key or a drum wherever one is drawn plays it through the engine", async () => {
  const { output } = await ready();
  click("Add Pattern Clip");
  // The Step Sequencer's and the Piano Roll's pianos both play the selected Clip's Track.
  const [inSequencer, inRoll] = screen.getAllByRole("button", { name: "Play E4" });
  for (const key of [inSequencer!, inRoll!]) {
    output.send.mockClear();
    fireEvent.pointerDown(key);
    fireEvent.pointerUp(key);
    expect(output.send).toHaveBeenCalledWith({ type: "noteOn", note: 64, velocity: 0.8 });
    expect(output.send).toHaveBeenCalledWith({ type: "noteOff", note: 64 });
  }

  click("Add Drum Track");
  fireEvent.click(screen.getAllByRole("button", { name: "Add Pattern Clip" }).at(-1)!);
  const snares = screen.getAllByRole("button", { name: "Hit Snare" });
  expect(snares.length).toBeGreaterThanOrEqual(2);
  for (const snare of snares) {
    output.send.mockClear();
    fireEvent.pointerDown(snare);
    expect(output.send).toHaveBeenCalledWith({ type: "noteOn", note: 38, velocity: 0.8 });
  }
});

test("a Drum Track is programmed by pad name, and its pads are edited and loaded", async () => {
  const { output, tracks } = setUp();
  click("Add Drum Track");
  click("Add Pattern Clip");
  expect(tracks()[0]!.name).toBe("Drums 1");
  const instrument = () => tracks()[0]!.instrument;

  // The grid names the kit's pads, not pitches, and a step is that pad's note.
  expect(cells("Closed Hat")).toHaveLength(64);
  expect(screen.queryByLabelText("Octaves from C")).not.toBeInTheDocument();
  step("Kick step 1");
  step("Kick step 5");
  expect(tracks()[0]!.clips[0]!.notes.map((n) => n.pitch)).toEqual([36, 36]);

  // A pad's own settings, and each of them undoes.
  fireEvent.change(cell("Open Hat pan"), { target: { value: "-0.5" } });
  fireEvent.change(cell("Open Hat pitch"), { target: { value: "-2" } });
  const pads = () => {
    const drums = instrument();
    if (drums.type !== "drumSampler") throw new Error("not a Drum Sampler");
    return drums.pads;
  };
  expect(pads()[4]).toMatchObject({ name: "Open Hat", pan: -0.5, pitch: -2, chokeGroup: 1 });
  click(/^Undo/);
  expect(pads()[4]!.pitch).toBe(0);

  // A WAV the musician loads goes to the engine and is named on its pad.
  click("Start audio");
  await screen.findByText("Stop audio");
  output.send.mockClear();
  const wav = riffWav();
  fireEvent.change(cell("Clap sample"), { target: { files: [new File([new Uint8Array(wav)], "clap.wav")] } });
  await screen.findByText("clap.wav");
  await waitFor(() => expect(output.send).toHaveBeenCalledWith({ type: "setPadSample", track: 0, pad: 2, wav }));
  // The pad names where the WAV will live in the Project folder, and loading
  // it undoes like any other edit.
  expect(pads()[2]!.sample).toBe("audio/clap.wav");
  click(/^Undo Load sample$/);
  expect(pads()[2]!.sample).toBeNull();

  // A Pad added past the kit's end is a row of the grid too, and the engine
  // builds the kit again at its new size; taking it off undoes like any edit.
  output.send.mockClear();
  click("Add Pad");
  expect(pads()).toHaveLength(STARTER_KIT.length + 1);
  expect(cells("Pad 23")).toHaveLength(64);
  await waitFor(() =>
    expect(output.send).toHaveBeenCalledWith({ type: "setTrackInstrument", track: 0, instrument: "drumSampler", pads: STARTER_KIT.length + 1 }),
  );
  click("Remove last Pad");
  expect(screen.queryAllByLabelText(/^Pad 23 step /)).toHaveLength(0);
  await waitFor(() =>
    expect(output.send).toHaveBeenCalledWith({ type: "setTrackInstrument", track: 0, instrument: "drumSampler", pads: STARTER_KIT.length }),
  );
  click(/^Undo Remove Pad$/);
  expect(pads()).toHaveLength(STARTER_KIT.length + 1);
});

test("a WAV loaded onto a pad is saved with the Project and plays again when it is opened", async () => {
  const storage = new FakeFileStorage();
  const folder = fakeFolder("/songs/beat");
  storage.saveChoice = folder;
  setUp(storage);
  click("Add Drum Track");
  click("Add Pattern Clip");

  const wav = riffWav();
  fireEvent.change(cell("Clap sample"), { target: { files: [new File([new Uint8Array(wav)], "clap.wav")] } });
  await screen.findByText("clap.wav");
  chooseFromFileMenu("Save");
  // The Project folder holds its own copy of the WAV, beside the data file.
  await waitFor(() => expect(storage.files(folder.id)).toEqual(["audio/clap.wav", "project.json"]));
  expect([...(await storage.readBytes(folder, "audio/clap.wav"))]).toEqual(wav);

  // Another copy of Soundcheck, with nothing loaded, opening the folder it finds:
  // the pad plays the same bytes, read back out of the Project.
  cleanup();
  storage.openChoice = folder;
  const { output } = setUp(storage);
  click("Start audio");
  await screen.findByText("Stop audio");
  output.send.mockClear();
  chooseFromFileMenu("Open…");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Track name" })).toHaveValue("Drums 1"));
  await waitFor(() => expect(output.send).toHaveBeenCalledWith({ type: "setPadSample", track: 0, pad: 2, wav }));
});

test("a file that isn't a WAV is refused and nothing is sent", async () => {
  const { output } = setUp();
  click("Add Drum Track");
  click("Add Pattern Clip");
  click("Start audio");
  await screen.findByText("Stop audio");
  output.send.mockClear();

  fireEvent.change(cell("Kick sample"), { target: { files: [new File(["nope"], "beat.mp3")] } });
  expect(await screen.findByRole("alert")).toHaveTextContent("beat.mp3 isn't a WAV file");
  expect(output.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "setPadSample" }));
});

test("stopping audio while recording keeps the take, and the Record button goes back", async () => {
  const { output, tracks, history } = await ready();
  output.engine.position = BAR;
  click("Record");
  output.recorded.push(noteOn(BAR + 240, 60), noteOff(BAR + 480, 60));
  output.engine.position = BAR + 960;

  click("Stop audio");
  await screen.findByText("Start audio");

  // The take is in the Project, as its own undo step, and nothing is armed.
  expect(tracks()[0]!.clips[0]!.notes).toEqual([{ pitch: 60, start: 240, length: 240, velocity: 0.8 }]);
  expect(history.undoLabel).toBe("Record");
  expect(button("Record")).toHaveAttribute("aria-pressed", "false");
  expect(output.send).toHaveBeenCalledWith({ type: "setRecording", on: false });
});

test("opening a Project while recording abandons the take instead of landing it in the new one", async () => {
  const storage = new FakeFileStorage();
  const saved = new ProjectHistory(createProject("Night drive"));
  saved.execute({ type: "addTrack", track: createInstrumentTrack("Pad", "pad") });
  await saveProject(storage, saved.project, fakeFolder("/songs/night"));
  storage.openChoice = fakeFolder("/songs/night");

  const { output } = setUp(storage);
  click("Add Instrument Track");
  click("Add Pattern Clip");
  click("Start audio");
  await screen.findByText("Stop audio");

  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  click("Record");
  output.recorded.push(noteOn(240, 60), noteOff(480, 60));
  output.send.mockClear();
  chooseFromFileMenu("Open…");
  await screen.findByDisplayValue("Night drive");
  confirm.mockRestore();

  // The engine is no longer recording or rolling, the Record button is back,
  // and the take stayed with the Project it was played into.
  expect(output.send).toHaveBeenCalledWith({ type: "setRecording", on: false });
  expect(output.send).toHaveBeenCalledWith({ type: "stop" });
  expect(button("Record")).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByLabelText("Pad Clip 1")).not.toBeInTheDocument();
  // Nothing of the old Project is still selected: no editor is open on it.
  expect(screen.queryByLabelText("Step grid")).not.toBeInTheDocument();
});

test("while the Assistant is working the Project is left alone: no edits, no undo, no Open", async () => {
  const output = fakeOutput();
  const history = new ProjectHistory(createProject("Demo"));
  // The model is held up mid-Request, as a slow API call would be.
  let reply!: (value: ModelReply) => void;
  const held = new Promise<ModelReply>((resolve) => {
    reply = resolve;
  });
  let turn = 0;
  const conversations = () => () => ({
    next: () => (turn++ === 0 ? held : Promise.resolve<ModelReply>({ text: "Done.", toolCalls: [] })),
  });
  render(
    <SongPage
      openOutput={() => Promise.resolve(output)}
      storage={new FakeFileStorage()}
      keyStore={memoryKeyStore("sk-test")}
      conversations={conversations}
      history={history}
    />,
  );
  click("Add Instrument Track");

  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: "turn it down" } });
  click("Send");

  // Nothing may change the Project under the Request, which is one step.
  expect(fileMenuEnabled("New")).toBe(false);
  expect(fileMenuEnabled("Open…")).toBe(false);
  expect(button(/^Undo/)).toBeDisabled();
  click("Add Instrument Track");
  expect(screen.getByRole("alert")).toHaveTextContent("The Assistant is working on the Project");
  expect(history.project.tracks).toHaveLength(1);

  await act(async () => {
    reply({ text: "", toolCalls: [{ id: "a", name: "set_master_volume", input: { volume: 0.5 } }] });
  });

  // The Request is one step of its own, and the page is the musician's again.
  expect(history.undoLabel).toBe("Request");
  expect(fileMenuEnabled("Open…")).toBe(true);
  click("Add Instrument Track");
  expect(history.project.tracks).toHaveLength(2);
  expect(history.undoLabel).toBe("Add Track");
});

test("a saved Kit the Assistant loads plays its samples, and undo takes it off the Drum Sampler", async () => {
  const library = memoryLibraryStorage();
  const kick = { name: "808 kick.wav", bytes: riffWav() };
  const pads = STARTER_KIT.map((pad) => (pad.note === 36 ? { ...pad, sample: "audio/808 kick.wav" } : { ...pad }));
  await new KitLibrary(library).save("808", pads, new Map([["audio/808 kick.wav", kick]]));
  const project = createProject("Beat");
  project.tracks.push(createDrumTrack("Drums", "drums"));
  const history = new ProjectHistory(project);
  const output = fakeOutput();
  const replies: ModelReply[] = [
    { text: "", toolCalls: [{ id: "g", name: "load_tools", input: { group: "sounds" } }] },
    { text: "", toolCalls: [{ id: "i", name: "set_instrument", input: { trackId: "drums", instrument: "drumSampler", preset: "808" } }] },
    { text: "The drums play your 808 kit.", toolCalls: [] },
  ];
  let turn = 0;
  const conversations = () => () => ({ next: () => Promise.resolve(replies[turn++]!) });
  render(
    <SongPage
      openOutput={() => Promise.resolve(output)}
      keyStore={memoryKeyStore("sk-test")}
      conversations={conversations}
      history={history}
      library={library}
    />,
  );
  click("Start audio");
  await screen.findByText("Stop audio");

  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: "use my 808 kit" } });
  click("Send");

  await screen.findByText("The drums play your 808 kit.");
  expect(history.project.tracks[0]).toMatchObject({ instrument: { type: "drumSampler", preset: "808", pads } });
  // The Kit's sample is copied into the Project, so the engine plays it on the Kick.
  await waitFor(() => expect(output.send).toHaveBeenCalledWith({ type: "setPadSample", track: 0, pad: 0, wav: kick.bytes }));
  click(/^Undo/);
  expect(history.project).toEqual(project);
});

test("audio imported onto an Audio Track plays, draws, saves into the folder and opens again", async () => {
  const storage = new FakeFileStorage();
  const folder = fakeFolder("/songs/vocals");
  storage.saveChoice = folder;
  const { history, output } = setUp(storage);
  click("Start audio");
  await screen.findByText("Stop audio");
  output.send.mockClear();
  click("Add Instrument Track");
  click("Add Audio Track");

  // The engine's test tone: a quarter of a second, which is half a beat at
  // 120 bpm.
  const bytes = [...readFileSync(resolvePath(import.meta.dirname, "../../../engine/tests/fixtures/tone.flac"))];
  fireEvent.change(screen.getByLabelText("Import audio onto Audio 2"), {
    target: { files: [new File([Uint8Array.from(bytes)], "tone.flac")] },
  });
  await screen.findByLabelText("Audio 2 Clip 1");
  expect(history.project.tracks[1]!.clips).toEqual([
    { id: expect.any(String), kind: "audio", start: 0, duration: 0.25, file: "audio/tone.flac", fileOffset: 0 },
  ]);
  expect(screen.getByLabelText("Waveform")).toBeInTheDocument();
  // The Audio Track is the engine's second Track, like it is the Project's.
  await waitFor(() => {
    expect(output.send).toHaveBeenCalledWith({ type: "setTrackAudio", track: 1, audio: true });
    expect(output.send).toHaveBeenCalledWith({ type: "loadAudioFile", file: 1, bytes });
    expect(output.send).toHaveBeenCalledWith({ type: "setTrackAudioClips", track: 1, clips: [0, 0.25, 1, 0] });
    // Decoding the file for its waveform is slow when the whole suite shares the machine.
  }, { timeout: 5_000 });

  chooseFromFileMenu("Save");
  await waitFor(() => expect(storage.files(folder.id)).toEqual(["audio/tone.flac", "project.json"]));
  expect([...(await storage.readBytes(folder, "audio/tone.flac"))]).toEqual(bytes);

  // Another copy of Soundcheck opens the folder, with the original long gone: the
  // Clip plays the Project's own copy, and its waveform is drawn again.
  cleanup();
  storage.openChoice = folder;
  const again = setUp(storage);
  click("Start audio");
  await screen.findByText("Stop audio");
  chooseFromFileMenu("Open…");
  await waitFor(() =>
    expect(again.output.send).toHaveBeenCalledWith({ type: "loadAudioFile", file: 1, bytes }),
    { timeout: 5_000 },
  );
  expect(await screen.findByLabelText("Waveform")).toBeInTheDocument();
});

test("the File menu's shortcuts add each kind of Track from anywhere, and the menu shows them", () => {
  const { history } = setUp();
  fireEvent.keyDown(window, { key: "A", ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: "D", ctrlKey: true, shiftKey: true });
  expect(history.project.tracks.map(trackKind)).toEqual(["audio", "instrument", "drum"]);

  fireEvent.click(screen.getByRole("button", { name: "File menu" }));
  expect(screen.getByRole("menuitem", { name: "Save As…" })).toHaveAttribute("aria-keyshortcuts", "Control+Shift+S");
  fireEvent.click(screen.getByRole("menuitem", { name: "Tracks" }));
  expect(screen.getByRole("menuitem", { name: "Add Audio Track" })).toHaveAttribute("aria-keyshortcuts", "Control+Shift+A");
});

test("a file that isn't audio is refused onto an Audio Track, and nothing is added", async () => {
  const { history } = setUp();
  click("Add Audio Track");
  fireEvent.change(screen.getByLabelText("Import audio onto Audio 1"), {
    target: { files: [new File(["nope"], "notes.txt")] },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("notes.txt can't be imported");
  expect(history.project.tracks[0]!.clips).toEqual([]);
});

test("right-clicking an Audio Clip offers Export Clip…, which exports that Clip's own audio", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const output = fakeOutput();
  const { exporter, clipExports } = fakeExporter("C:/Music/tone.wav");
  render(<SongPage openOutput={() => Promise.resolve(output)} history={history} exporter={exporter} />);
  click("Start audio");
  await screen.findByText("Stop audio");
  click("Add Audio Track");
  const bytes = readFileSync(resolvePath(import.meta.dirname, "../../../engine/tests/fixtures/tone.flac"));
  fireEvent.change(screen.getByLabelText(/^Import audio onto /), {
    target: { files: [new File([Uint8Array.from(bytes)], "tone.flac")] },
  });
  const clip = await screen.findByLabelText(/ Clip 1$/);

  fireEvent.contextMenu(clip, { clientX: 40, clientY: 40 });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Export Clip…" }));
  const dialog = await screen.findByRole("dialog", { name: "Export Clip" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Export WAV…" }));

  await waitFor(() => expect(clipExports).toHaveLength(1));
  // The suggested name is the Clip's.
  expect(exporter.chooseFile).toHaveBeenCalledWith("tone", "wav", "clip");
  const [{ request }] = clipExports as [(typeof clipExports)[number]];
  expect(request).toMatchObject({ fileOffset: 0, duration: 0.25 });
  expect([...request.audio]).toEqual([...bytes]);
});

test("clicking an Audio Clip, or its Track, opens it in the Audio Editor, whose split is one undo step", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  render(<SongPage openOutput={() => Promise.resolve(fakeOutput())} history={history} />);
  expect(screen.queryByRole("region", { name: "Audio Editor" })).not.toBeInTheDocument();
  click("Add Audio Track");
  expect(screen.getByRole("button", { name: "Edit audio" })).toBeDisabled();
  const bytes = readFileSync(resolvePath(import.meta.dirname, "../../../engine/tests/fixtures/tone.flac"));
  fireEvent.change(screen.getByLabelText(/^Import audio onto /), {
    target: { files: [new File([Uint8Array.from(bytes)], "tone.flac")] },
  });
  const clip = await screen.findByLabelText(/ Clip 1$/);
  fireEvent.click(clip);
  const editor = await screen.findByRole("region", { name: "Audio Editor" });
  expect(within(editor).getByRole("heading", { name: /Audio Editor: Audio 1/ })).toBeInTheDocument();

  // Deselected, it goes; its Track's Edit audio brings it back.
  fireEvent.mouseDown(clip.parentElement!);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Audio Editor" })).not.toBeInTheDocument());
  click("Edit audio");
  const again = await screen.findByRole("region", { name: "Audio Editor" });
  expect(screen.getByRole("button", { name: "Edit audio" })).toHaveAttribute("aria-pressed", "true");

  fireEvent.change(within(again).getByLabelText("Slice at"), { target: { value: "equal" } });
  fireEvent.change(within(again).getByLabelText("Parts"), { target: { value: "2" } });
  fireEvent.click(within(again).getByRole("button", { name: "Auto-slice" }));
  fireEvent.click(within(again).getByRole("button", { name: "Split into 2 Clips" }));
  const clips = history.project.tracks[0]!.clips as AudioClip[];
  expect(clips.map(({ fileOffset, duration }) => [fileOffset, Number(duration.toFixed(6))])).toEqual([
    [0, 0.125],
    [0.125, 0.125],
  ]);
  history.undo();
  expect(history.project.tracks[0]!.clips).toHaveLength(1);
});

/**
 * The page with `stems` separating, an Audio Track holding tone.flac (a
 * quarter of a second) trimmed to 0.125 s from 0.05 s in, at tick 96, and
 * its Clip's context menu open.
 */
async function withToneClip(stems: StemSeparator) {
  const history = new ProjectHistory(createProject("Demo"));
  const output = fakeOutput();
  render(<SongPage openOutput={() => Promise.resolve(output)} history={history} stems={stems} />);
  click("Start audio");
  await screen.findByText("Stop audio");
  click("Add Audio Track");
  const bytes = readFileSync(resolvePath(import.meta.dirname, "../../../engine/tests/fixtures/tone.flac"));
  fireEvent.change(screen.getByLabelText(/^Import audio onto /), {
    target: { files: [new File([Uint8Array.from(bytes)], "tone.flac")] },
  });
  await screen.findByLabelText(/ Clip 1$/);
  const clipId = history.project.tracks[0]!.clips[0]!.id;
  act(() => {
    history.execute({ type: "trimClip", clipId, start: 96, length: 240, fileOffset: 0.05 });
  });
  return { history, clipId, before: history.project };
}

/** Open the Tone Clip's context menu, on its Separate into Stems. */
async function openMenu() {
  fireEvent.contextMenu(screen.getByRole("button", { name: "Audio 1 Clip 1" }), { clientX: 40, clientY: 40 });
  return screen.findByRole("menuitem", { name: "Separate into Stems" });
}

/** A separation held at its second step until `release` is called. */
function heldSeparator(options: FakeStemSeparatorOptions = {}) {
  const { promise: held, resolve } = Promise.withResolvers<void>();
  let steps = 0;
  const stems = fakeStemSeparator({ installed: true, ...options, between: () => (++steps === 2 ? held : Promise.resolve()) });
  return { stems, release: () => act(resolve) };
}

test("Separate into Stems puts a trimmed Clip's four Stems on new Tracks under its Track, in its place, as one undo step", async () => {
  const stems = fakeStemSeparator({ installed: true });
  const { history, before } = await withToneClip(stems);
  fireEvent.click(await openMenu());

  expect(await screen.findByText("Separated tone into its Stems")).toBeInTheDocument();
  // Only the stretch the Clip plays was separated.
  expect(stems.separations).toHaveLength(1);
  expect((await summariseAudio(stems.separations[0]!)).seconds).toBeCloseTo(0.125, 3);

  const tracks = history.project.tracks;
  expect(tracks.map((track) => track.name)).toEqual([
    "Audio 1",
    "tone – Vocals",
    "tone – Drums",
    "tone – Bass",
    "tone – Other",
  ]);
  expect(tracks[0]!.clips).toEqual([]);
  // As long as the source Clip, and where it was.
  const { duration } = before.tracks[0]!.clips[0] as AudioClip;
  expect(duration).toBeCloseTo(0.125, 9);
  for (const track of tracks.slice(1)) {
    expect(track.clips).toEqual([expect.objectContaining({ kind: "audio", start: 96, duration, fileOffset: 0 })]);
  }
  expect(history.undoLabel).toBe("Separate into Stems");
  act(() => history.undo());
  expect(history.project).toEqual(before);
});

test("cancelling a Stem Separation leaves the Project as it was, and the musician can edit while it runs", async () => {
  const { stems, release } = heldSeparator();
  const { history, before } = await withToneClip(stems);
  fireEvent.click(await openMenu());

  const progress = await screen.findByRole("progressbar", { name: "Stem Separation progress" });
  expect(progress).toHaveAttribute("value", "0.25");
  // Only one at a time.
  expect(await openMenu()).toHaveAttribute("aria-disabled", "true");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  // Editing goes on meanwhile.
  click("Add Audio Track");
  expect(history.project.tracks).toHaveLength(2);
  act(() => history.undo());

  click("Cancel Stem Separation");
  release();
  expect(await screen.findByText("Stem Separation of tone cancelled")).toBeInTheDocument();
  expect(history.project).toEqual(before);
});

test("a Stem Separation whose Clip was deleted meanwhile changes nothing and says why", async () => {
  const { stems, release } = heldSeparator();
  const { history, clipId } = await withToneClip(stems);
  fireEvent.click(await openMenu());
  await screen.findByRole("progressbar", { name: "Stem Separation progress" });

  act(() => {
    history.execute({ type: "deleteClip", clipId });
  });
  const deleted = history.project;
  release();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "tone was deleted while it was being separated, so its Stems were discarded.",
  );
  expect(history.project).toBe(deleted);
});

test("a Stem Separation that ends while an Assistant Request holds the history places no Stems and says why", async () => {
  const { stems, release } = heldSeparator();
  const { history, before } = await withToneClip(stems);
  fireEvent.click(await openMenu());
  await screen.findByRole("progressbar", { name: "Stem Separation progress" });

  // A Request starts meanwhile, and is still working when the separation ends.
  const request = history.beginGroup("Make it brighter");
  release();
  expect(await screen.findByRole("alert")).toHaveTextContent(`tone's Stems couldn't be added: ${BUSY}`);
  expect(history.project).toBe(before);
  expect(stems.separations).toHaveLength(1);

  // Once the Request has finished, nothing is left waiting to land.
  act(() => request.end());
  expect(history.project).toBe(before);
  expect(history.project.tracks).toHaveLength(1);
});

test("without the model, Separate into Stems offers to install it first; declining does nothing", async () => {
  const stems = fakeStemSeparator({ installed: false });
  const { history, before } = await withToneClip(stems);
  fireEvent.click(await openMenu());
  const offer = await screen.findByRole("dialog", { name: "Install the Stem Separation model" });
  fireEvent.click(within(offer).getByRole("button", { name: "Not now" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(stems.installs).toEqual([]);
  expect(stems.separations).toEqual([]);
  expect(history.project).toBe(before);

  fireEvent.click(await openMenu());
  const again = await screen.findByRole("dialog", { name: "Install the Stem Separation model" });
  fireEvent.click(within(again).getByRole("button", { name: "Choose the model file…" }));
  expect(await screen.findByText("Separated tone into its Stems")).toBeInTheDocument();
  expect(stems.installs).toEqual(["htdemucs.onnx"]);
  expect(history.project.tracks).toHaveLength(5);
});

test("a model file that isn't htdemucs is refused, saying why, and nothing is separated", async () => {
  const stems = fakeStemSeparator({ installed: false, chosen: "C:/Models/other.onnx" });
  const { history, before } = await withToneClip(stems);
  fireEvent.click(await openMenu());
  fireEvent.click(await screen.findByRole("button", { name: "Choose the model file…" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(`The model wasn't installed: ${FAKE_REFUSAL}`);
  expect(stems.separations).toEqual([]);
  expect(history.project).toBe(before);
});

test("a model exported into the repo's model/ is installed without asking, then separates", async () => {
  const stems = fakeStemSeparator({ installed: false, found: "/repo/model/htdemucs.onnx" });
  const { history } = await withToneClip(stems);
  fireEvent.click(await openMenu());
  expect(await screen.findByText("Separated tone into its Stems")).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Install the Stem Separation model" })).not.toBeInTheDocument();
  expect(stems.installs).toEqual(["/repo/model/htdemucs.onnx"]);
  expect(history.project.tracks).toHaveLength(5);
});

test("a model found in model/ that isn't htdemucs is refused, and the musician is asked for the file, saying why", async () => {
  const stems = fakeStemSeparator({ installed: false, found: "/repo/model/other.onnx" });
  const { history } = await withToneClip(stems);
  fireEvent.click(await openMenu());
  const offer = await screen.findByRole("dialog", { name: "Install the Stem Separation model" });
  expect(within(offer).getByRole("alert")).toHaveTextContent(`/repo/model/other.onnx wasn't installed: ${FAKE_REFUSAL}`);
  expect(offer).toHaveTextContent("It writes it to the repo's model/ folder, where Soundcheck looks first");
  fireEvent.click(within(offer).getByRole("button", { name: "Choose the model file…" }));
  expect(await screen.findByText("Separated tone into its Stems")).toBeInTheDocument();
  expect(stems.installs).toEqual(["htdemucs.onnx"]);
  expect(history.project.tracks).toHaveLength(5);
});

test("the offer to install the model says where it will be kept", async () => {
  const stems = { ...fakeStemSeparator({ installed: false }), modelKeptIn: "this browser's storage for the site" };
  await withToneClip(stems);
  fireEvent.click(await openMenu());
  const offer = await screen.findByRole("dialog", { name: "Install the Stem Separation model" });
  expect(offer).toHaveTextContent("It's kept in this browser's storage for the site.");
});

test("where the browser can't separate Stems, Separate into Stems is disabled, saying why", async () => {
  await withToneClip(unavailableStemSeparator(NO_STEMS_IN_BROWSER));
  await waitFor(async () => {
    const item = await openMenu();
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription(NO_STEMS_IN_BROWSER);
  });
});

test("closing the Project cancels its Stem Separation, and nothing lands in the next one", async () => {
  const { stems, release } = heldSeparator();
  let signal: AbortSignal | null = null;
  const separate = stems.separate.bind(stems);
  stems.separate = (audio, options) => {
    signal = options.signal;
    return separate(audio, options);
  };
  await withToneClip(stems);
  fireEvent.click(await openMenu());
  await screen.findByRole("progressbar", { name: "Stem Separation progress" });

  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  chooseFromFileMenu("New");
  confirm.mockRestore();
  expect(signal!.aborted).toBe(true);
  release();
  expect(await screen.findByText("Stem Separation of tone cancelled")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Clip 1$/ })).not.toBeInTheDocument();
  expect(screen.queryAllByRole("textbox", { name: "Track name" })).toEqual([]);
});

/**
 * The page with `stems` separating, an Audio Track already in the Project,
 * its audio running with the playhead at tick 1920.
 */
async function withPlayhead(stems: StemSeparator, storage = new FakeFileStorage()) {
  const history = new ProjectHistory(createProject("Demo"));
  const output = fakeOutput();
  render(<SongPage openOutput={() => Promise.resolve(output)} history={history} stems={stems} storage={storage} />);
  click("Start audio");
  await screen.findByText("Stop audio");
  click("Add Audio Track");
  output.engine.position = 1920;
  return { history, before: history.project };
}

/** tone.flac, a quarter of a second long. */
const toneFile = () =>
  readFileSync(resolvePath(import.meta.dirname, "../../../engine/tests/fixtures/tone.flac"));

/** Choose File → Import as Stems…, then `bytes` as the file. */
function importAsStems(bytes: Uint8Array = toneFile(), name = "tone.flac") {
  chooseFromFileMenu("Import as Stems…");
  fireEvent.change(screen.getByLabelText("Import as Stems"), {
    target: { files: [new File([Uint8Array.from(bytes)], name)] },
  });
}

/** Each Stem a WAV of its own: a tenth of a second of silence, as a different number of frames. */
const distinctStems = (_audio: Uint8Array, name: string) =>
  new Uint8Array(encode_wav(new Float32Array(2 * (4410 + name.length)), 44_100, 32)!);

test("Import as Stems… puts a whole file's four Stems on new Tracks at the end, from the playhead, as one undo step", async () => {
  const storage = new FakeFileStorage();
  const folder = fakeFolder("/songs/stems");
  storage.saveChoice = folder;
  const stems = fakeStemSeparator({ installed: true, stem: distinctStems });
  const { history, before } = await withPlayhead(stems, storage);
  importAsStems();

  expect(await screen.findByText("Separated tone into its Stems")).toBeInTheDocument();
  // The whole file was separated, as it is.
  expect(stems.separations).toHaveLength(1);
  expect([...stems.separations[0]!]).toEqual([...toneFile()]);

  const tracks = history.project.tracks;
  expect(tracks.map((track) => track.name)).toEqual([
    "Audio 1",
    "tone – Vocals",
    "tone – Drums",
    "tone – Bass",
    "tone – Other",
  ]);
  expect(tracks[0]).toEqual(before.tracks[0]);
  for (const track of tracks.slice(1)) {
    expect(track.kind).toBe("audio");
    expect(track.clips).toEqual([expect.objectContaining({ kind: "audio", start: 1920, fileOffset: 0 })]);
    expect((track.clips[0] as AudioClip).duration).toBeCloseTo(0.25, 3);
  }
  expect(history.undoLabel).toBe("Import as Stems");

  // Only the Stems' audio is in the Project, not the file's.
  chooseFromFileMenu("Save");
  await waitFor(() =>
    expect(storage.files(folder.id)).toEqual([
      "audio/tone – Bass.wav",
      "audio/tone – Drums.wav",
      "audio/tone – Other.wav",
      "audio/tone – Vocals.wav",
      "project.json",
    ]),
  );

  act(() => history.undo());
  expect(history.project).toEqual(before);
});

test("cancelling Import as Stems… changes nothing", async () => {
  const { stems, release } = heldSeparator();
  const { history, before } = await withPlayhead(stems);
  importAsStems();
  expect(await screen.findByText("Separating tone into Stems…")).toBeInTheDocument();
  await screen.findByRole("progressbar", { name: "Stem Separation progress" });

  click("Cancel Stem Separation");
  release();
  expect(await screen.findByText("Stem Separation of tone cancelled")).toBeInTheDocument();
  expect(history.project).toBe(before);
});

test("without the model, Import as Stems… offers to install it first; declining does nothing", async () => {
  const stems = fakeStemSeparator({ installed: false });
  const { history, before } = await withPlayhead(stems);
  importAsStems();
  const offer = await screen.findByRole("dialog", { name: "Install the Stem Separation model" });
  fireEvent.click(within(offer).getByRole("button", { name: "Not now" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(stems.installs).toEqual([]);
  expect(stems.separations).toEqual([]);
  expect(history.project).toBe(before);

  importAsStems();
  const again = await screen.findByRole("dialog", { name: "Install the Stem Separation model" });
  fireEvent.click(within(again).getByRole("button", { name: "Choose the model file…" }));
  expect(await screen.findByText("Separated tone into its Stems")).toBeInTheDocument();
  expect(stems.installs).toEqual(["htdemucs.onnx"]);
  expect(history.project.tracks).toHaveLength(5);
});

test("a file that isn't audio isn't imported as Stems, and says why", async () => {
  const stems = fakeStemSeparator({ installed: true });
  const { history, before } = await withPlayhead(stems);
  importAsStems(new TextEncoder().encode("not audio"), "notes.mp3");
  expect(await screen.findByRole("alert")).toHaveTextContent(/^notes\.mp3 can't be imported: /);
  expect(stems.separations).toEqual([]);
  expect(history.project).toBe(before);
});

test("on the browser dev host Import as Stems… is disabled, saying why", async () => {
  await withPlayhead(unavailableStemSeparator(NO_STEMS_IN_BROWSER));
  await waitFor(async () => {
    openFileMenu();
    const item = await screen.findByRole("menuitem", { name: "Import as Stems…" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription(NO_STEMS_IN_BROWSER);
  });
});

test("a newer version's notice asks about unsaved changes before it restarts the app, and Settings has it too", async () => {
  const fake = fakeUpdater();
  const history = new ProjectHistory(createProject("Demo"));
  const openOutput = vi.fn<OpenAudioOutput>(() => Promise.resolve(fakeOutput()));
  const view = render(<SongPage openOutput={openOutput} history={history} updater={fake.updater} />);
  const notice = await screen.findByRole("region", { name: "Update" });
  expect(notice).toHaveTextContent("Soundcheck 1.2.3 is out");

  click("Add Instrument Track");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(within(notice).getByRole("button", { name: "Install and restart" }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("haven't been saved"));
  expect(fake.calls).not.toContain("install");
  confirm.mockRestore();

  view.rerender(<SongPage view="settings" openOutput={openOutput} history={history} updater={fake.updater} />);
  expect(screen.getByRole("region", { name: "Updates" })).toHaveTextContent("You have Soundcheck 0.1.0.");
});

test("with no updater, as in the Browser Version, Settings has no Updates section", () => {
  render(<SongPage view="settings" openOutput={vi.fn<OpenAudioOutput>()} />);
  expect(screen.queryByRole("region", { name: "Updates" })).not.toBeInTheDocument();
});

test("opened from an invite link, the Editor offers to join, and joining opens the Live Session's Project", async () => {
  const relay = new FakeRelay();
  const invite = newInvite("wss://relay.test");
  const alice = new LiveSession({
    invite,
    history: new ProjectHistory(createProject("Alice's song"), { by: "Alice" }),
    joining: false,
    samples: () => new Map(),
    onAudio: () => {},
    connect: relay.connect,
  });
  window.history.replaceState(null, "", inviteLink(invite, "/editor"));
  render(
    <SongPage
      openOutput={() => Promise.resolve(fakeOutput())}
      history={new ProjectHistory(createProject("Demo"))}
      connectRelay={relay.connect}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Live Session" });
  // The link is taken out of the address, so reloading doesn't offer it again.
  expect(location.hash).toBe("");
  expect(within(dialog).getByRole("textbox", { name: "Invite link" })).toHaveValue(
    `${location.origin}${inviteLink(invite, "/editor")}`,
  );

  fireEvent.click(within(dialog).getByRole("button", { name: "Join" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Editor: Alice's song" })).toBeInTheDocument());
  await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Live with Alice."));
  expect(document.querySelector(".save-state")).toHaveTextContent("Live");
  expect(fileMenuEnabled("Share this Project…")).toBe(false);
  alice.leave();
});

/** A Project with one Audio Clip, of a file no copy here has. */
function songWithATake(title: string) {
  const song = createProject(title);
  const vocals = createAudioTrack("Vocals", "vocals");
  vocals.clips.push({ id: "take", kind: "audio", start: 0, duration: 2, file: "audio/take.wav", fileOffset: 0 });
  song.tracks.push(vocals);
  return song;
}

test("an Audio Clip whose file isn't here says its audio is missing", () => {
  render(<SongPage openOutput={() => Promise.resolve(fakeOutput())} history={new ProjectHistory(songWithATake("Demo"))} />);
  expect(screen.getByRole("button", { name: "Vocals Clip 1" })).toHaveAccessibleDescription("Its audio is missing, so it is silent");
});

test("in a Live Session, an Audio Clip whose audio hasn't arrived says it is waiting for it", async () => {
  const relay = new FakeRelay();
  const invite = newInvite("wss://relay.test");
  const alice = new LiveSession({
    invite,
    history: new ProjectHistory(songWithATake("Alice's song"), { by: "Alice" }),
    joining: false,
    samples: () => new Map(),
    onAudio: () => {},
    connect: relay.connect,
  });
  window.history.replaceState(null, "", inviteLink(invite, "/editor"));
  render(
    <SongPage
      openOutput={() => Promise.resolve(fakeOutput())}
      history={new ProjectHistory(createProject("Demo"))}
      connectRelay={relay.connect}
    />,
  );
  fireEvent.click(within(screen.getByRole("dialog", { name: "Live Session" })).getByRole("button", { name: "Join" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Editor: Alice's song" })).toBeInTheDocument());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Vocals Clip 1" })).toHaveAccessibleDescription(
      "Waiting for its audio: silent until it arrives",
    ),
  );
  alice.leave();
});

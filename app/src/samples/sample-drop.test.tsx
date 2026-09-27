// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { initSync } from "@engine";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import type { ModelReply } from "../assistant/assistant";
import { memoryKeyStore } from "../assistant/key-store";
import type { OpenAudioOutput } from "../audio/audio-output";
import { memoryLibraryStorage } from "../preset/library-storage";
import { ProjectHistory } from "../project/history";
import { createProject, type AudioTrack, type InstrumentTrack } from "../project/model";
import { barTicks } from "../project/time";
import { SongPage } from "../song/SongPage";
import { DEFAULT_ZOOM } from "../song/timeline-view";
import { stereoWav } from "../song/test-wav";
import { FakeFileStorage, fakeFolder } from "../storage/fake-file-storage";
import { SAMPLE_DRAG_TYPE } from "./sample-drag";
import type { SampleFolder, SampleRef, SampleSource } from "./sample-source";
import { chooseFromFileMenu } from "../ui/file-menu-testing";

afterEach(cleanup);

// A dropped file is measured with the engine's own decoder, in WASM.
beforeAll(() => {
  initSync({ module: readFileSync(resolvePath(import.meta.dirname, "../../../engine/pkg/soundcheck_engine_bg.wasm")) });
});

const folder: SampleFolder = { id: "C:/Samples", label: "Samples" };
const TONE = [...readFileSync(resolvePath(import.meta.dirname, "../../../engine/tests/fixtures/tone.flac"))];
const CLAP = stereoWav([0.5, -0.5, 0.25], [0.5, -0.5, 0.25], 48_000);

/** A sample folder on a pretend disk, holding the engine's test tone and a clap. */
function fakeSource(): SampleSource {
  const files: Record<string, number[]> = { "Loops/tone.flac": TONE, "clap.wav": CLAP };
  return {
    chooseFolder: () => Promise.resolve(null),
    listAudio: () => Promise.resolve(Object.keys(files).toSorted()),
    readBytes: ({ path }) => Promise.resolve(Uint8Array.from(files[path] ?? [])),
    audition: () => Promise.resolve(),
    stopAudition: () => Promise.resolve(),
  };
}

/** The Song page, with Claude replaced by `replies` in turn where they are given. No test calls the API. */
function setUp(replies?: ModelReply[]) {
  let turn = 0;
  const storage = new FakeFileStorage();
  const history = new ProjectHistory(createProject("Demo"));
  const library = memoryLibraryStorage(new Map([["sample-folders.json", JSON.stringify({ folders: [folder] })]]));
  render(
    <SongPage
      openOutput={vi.fn<OpenAudioOutput>()}
      storage={storage}
      history={history}
      samples={fakeSource()}
      library={library}
      {...(replies && {
        keyStore: memoryKeyStore("sk-test"),
        conversations: () => () => ({ next: () => Promise.resolve(replies[turn++]!) }),
      })}
    />,
  );
  return { storage, history };
}

/** What the browser puts on a drag, as a drop target sees it. */
function dragOf(sample: SampleRef) {
  const data = JSON.stringify(sample);
  return { types: [SAMPLE_DRAG_TYPE], getData: (type: string) => (type === SAMPLE_DRAG_TYPE ? data : ""), dropEffect: "" };
}

/** By name, hidden or not: Save is on the Settings page. */
function click(name: string) {
  const found = [...document.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  fireEvent.click(found);
}

test("a file dropped onto an Audio Track's lane becomes an Audio Clip there, undoes, and saves into the folder", async () => {
  const { storage, history } = setUp();
  click("Add Audio Track");
  const lane = screen.getByLabelText("Audio 1 lane");
  const dataTransfer = dragOf({ folder, path: "Loops/tone.flac" });
  // The lane says it will take the sample before it is dropped.
  expect(fireEvent.dragOver(lane, { dataTransfer })).toBe(false);
  // jsdom has no DragEvent, so the drop is a mouse event carrying the drag's
  // data: a little past the first bar line, which snaps back onto it.
  const drop = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: DEFAULT_ZOOM + 10 });
  Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
  fireEvent(lane, drop);

  // Decoding the file for its waveform is slow when the whole suite shares the machine.
  await screen.findByLabelText("Audio 1 Clip 1", undefined, { timeout: 10_000 });
  const track = () => history.project.tracks[0] as AudioTrack;
  const bar = barTicks(history.project.timeSignature);
  expect(track().clips).toEqual([
    { id: expect.any(String), kind: "audio", start: bar, duration: 0.25, file: "audio/tone.flac", fileOffset: 0 },
  ]);
  expect(history.undoLabel).toBe("Drop sample");
  history.undo();
  expect(track().clips).toEqual([]);
  history.redo();
  expect(track().clips).toHaveLength(1);

  // The Project's own copy: the sample folder is never named in it.
  const project = fakeFolder("/songs/demo");
  storage.saveChoice = project;
  chooseFromFileMenu("Save");
  await waitFor(() => expect(storage.files(project.id)).toEqual(["audio/tone.flac", "project.json"]));
  expect([...(await storage.readBytes(project, "audio/tone.flac"))]).toEqual(TONE);
  expect(await storage.readText(project, "project.json")).not.toContain("Samples");
}, 15_000);

test("a sample the Assistant places from the browser's folders is copied into the Project, as a drop copies it", async () => {
  const replies: ModelReply[] = [];
  const { storage, history } = setUp(replies);
  click("Add Audio Track");
  const trackId = history.project.tracks[0]!.id;
  const bar = barTicks(history.project.timeSignature);
  replies.push(
    { text: "", toolCalls: [{ id: "g", name: "load_tools", input: { group: "audio_clips" } }] },
    {
      text: "",
      toolCalls: [{ id: "p", name: "place_audio_clip", input: { trackId, source: "library:Samples/Loops/tone.flac", start: bar } }],
    },
    { text: "The tone is on Audio 1 at bar 2.", toolCalls: [] },
  );

  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: "put the tone loop on Audio 1 at bar 2" } });
  click("Send");

  expect(await screen.findByLabelText("What changed", undefined, { timeout: 10_000 })).toHaveTextContent(
    "Placed the sample “tone.flac” on “Audio 1” at 2.1.000, copied into the Project as audio/tone.flac",
  );
  expect((history.project.tracks[0] as AudioTrack).clips).toEqual([
    { id: expect.any(String), kind: "audio", start: bar, duration: 0.25, file: "audio/tone.flac", fileOffset: 0 },
  ]);
  expect(history.undoLabel).toBe("Request");

  const project = fakeFolder("/songs/demo");
  storage.saveChoice = project;
  // The Assistant's settings have a Save of their own; Ctrl+S is the Project's.
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await waitFor(() => expect(storage.files(project.id)).toEqual(["audio/tone.flac", "project.json"]));
  expect([...(await storage.readBytes(project, "audio/tone.flac"))]).toEqual(TONE);
  expect(await storage.readText(project, "project.json")).not.toContain("Samples");
}, 15_000);

test("anything else dragged over a lane is left alone", () => {
  setUp();
  click("Add Audio Track");
  const dataTransfer = { types: ["Files"], getData: () => "", dropEffect: "" };
  expect(fireEvent.dragOver(screen.getByLabelText("Audio 1 lane"), { dataTransfer })).toBe(true);
});

test("a file put on a Pad from the browser's menu, or dropped on one, is the pad's sample and undoes", async () => {
  const { storage, history } = setUp();
  click("Add Drum Track");
  click("Add Pattern Clip");
  const pads = () => {
    const { instrument } = history.project.tracks[0] as InstrumentTrack;
    return instrument.type === "drumSampler" ? instrument.pads : [];
  };

  // Found once the folder is read; a query over the whole Editor can outlast the 1 s default on a busy machine.
  fireEvent.click(await screen.findByRole("treeitem", { name: "clap.wav" }, { timeout: 5_000 }));
  fireEvent.change(screen.getByRole("combobox", { name: "Put on" }), {
    target: { value: `pad:${history.project.tracks[0]!.id}:2` },
  });
  await waitFor(() => expect(pads()[2]!.sample).toBe("audio/clap.wav"));
  expect(history.undoLabel).toBe("Drop sample");
  history.undo();
  expect(JSON.stringify(pads())).not.toContain("clap.wav");

  // Dropped onto the Kick's row: the same file is the same copy.
  const kick = screen.getByLabelText("Kick volume").closest("tr")!;
  const dataTransfer = dragOf({ folder, path: "clap.wav" });
  expect(fireEvent.dragOver(kick, { dataTransfer })).toBe(false);
  fireEvent.drop(kick, { dataTransfer });
  await waitFor(() => expect(pads()[0]!.sample).toBe("audio/clap.wav"));

  const project = fakeFolder("/songs/beat");
  storage.saveChoice = project;
  chooseFromFileMenu("Save");
  await waitFor(() => expect(storage.files(project.id)).toEqual(["audio/clap.wav", "project.json"]));
  expect([...(await storage.readBytes(project, "audio/clap.wav"))]).toEqual(CLAP);
});

test("a file that isn't a WAV is refused on a Pad, and nothing changes", async () => {
  const { history } = setUp();
  click("Add Drum Track");
  click("Add Pattern Clip");
  const before = history.project;
  // In its folder, which opens first.
  fireEvent.click(await screen.findByRole("treeitem", { name: "Loops" }, { timeout: 5_000 }));
  fireEvent.click(screen.getByRole("treeitem", { name: "tone.flac" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Put on" }), {
    target: { value: `pad:${history.project.tracks[0]!.id}:0` },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("tone.flac isn't a WAV file");
  expect(history.project).toBe(before);
});

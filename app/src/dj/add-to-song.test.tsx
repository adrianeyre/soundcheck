// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { initSync } from "@engine";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import type { AudioOutput, EngineCommand, OpenAudioOutput } from "../audio/audio-output";
import { ProjectHistory } from "../project/history";
import { type AudioTrack, createAudioTrack, createProject } from "../project/model";
import { SongPage } from "../song/SongPage";
import { DJ_REPORT_LEN, GLOBAL_FIELDS } from "./dj-report";

beforeAll(() => {
  // The take is encoded, and measured for its waveform, by the engine in WASM.
  initSync({ module: readFileSync(resolvePath(import.meta.dirname, "../../../engine/pkg/soundcheck_engine_bg.wasm")) });
});

afterEach(cleanup);

/** At 120 BPM in 4/4, a bar is 3840 ticks: the playhead is half way through bar 4. */
const BAR_4 = 3 * 3840;
const PLAYHEAD = BAR_4 + 1920;

function fakeOutput(position = PLAYHEAD) {
  const sent: EngineCommand[] = [];
  const report: number[] = Array.from({ length: DJ_REPORT_LEN }, () => 0);
  report[3] = 120;
  // Half a second of a quiet tone, interleaved stereo.
  const take = new Float32Array(48_000);
  for (let i = 0; i < take.length; i++) take[i] = 0.2 * Math.sin(i / 20);
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
      engine: { trackCount: 0, activeVoices: 0, playing: false, position },
      meters: null,
      dj: report,
    }),
    currentTime: () => 0,
    takeRecordedNotes: () => [],
    resetCounters: () => {},
    close: async () => {},
    dj: {
      load: async () => ({ seconds: 1, bpm: 120, firstBeat: 0, key: null, waveformRate: 100, waveform: [] }),
      unload: () => {},
      loadSample: async () => ({ seconds: 0.5, bpm: 0 }),
      unloadSample: () => {},
      takeRecording: async () => take,
      headphones: false,
    },
  };
  return { output, sent, report };
}

type Fake = ReturnType<typeof fakeOutput>;

/** Start audio on the Pads page and record a take, with Deck 1 playing at `bpm` if it is given. */
async function recordTake(fake: Fake, bpm?: number) {
  const page = document.getElementById("page-pads")!;
  const start = within(page).queryByRole("button", { name: "Start audio for mixing" });
  if (start) fireEvent.click(start);
  const controller = await within(page).findByRole("region", { name: "Pad Controller" });
  await waitFor(() => expect(within(controller).getByRole("button", { name: "Record the mix" })).toBeEnabled());
  fireEvent.click(within(controller).getByRole("button", { name: "Record the mix" }));
  fake.report[5] = 1;
  if (bpm !== undefined) {
    fake.report[3] = bpm;
    fake.report[GLOBAL_FIELDS + 1] = 1;
  }
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
  fireEvent.click(within(controller).getByRole("button", { name: "Stop recording" }));
  fake.report[5] = 0;
  fake.report[GLOBAL_FIELDS + 1] = 0;
  return controller;
}

async function addToSong(controller: HTMLElement, name: string | RegExp = /^Add the recording to the song, /) {
  const add = within(controller).getByRole("button", { name });
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
}

function choose(controller: HTMLElement, item: string) {
  fireEvent.click(within(controller).getByRole("button", { name: "Where Add to song puts the take" }));
  fireEvent.click(within(controller).getByRole("menuitemradio", { name: item }));
}

function renderPads(history: ProjectHistory, fake: Fake) {
  const openOutput = vi.fn<OpenAudioOutput>(() => Promise.resolve(fake.output));
  return render(<SongPage openOutput={openOutput} history={history} view="pads" />);
}

test("a take goes in at the Editor's playhead, on a new Audio Track, in one undo", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const before = history.project.tracks.length;
  const fake = fakeOutput();
  renderPads(history, fake);
  const controller = await recordTake(fake);
  await addToSong(controller, "Add the recording to the song, at the playhead, on a new Audio Track");

  await waitFor(() => expect(history.project.tracks).toHaveLength(before + 1));
  const track = history.project.tracks.at(-1) as AudioTrack;
  expect(track.kind).toBe("audio");
  expect(track.name).toMatch(/^Mix take \d+$/);
  expect(track.clips).toHaveLength(1);
  expect(track.clips[0]).toMatchObject({ kind: "audio", start: PLAYHEAD, fileOffset: 0 });
  expect(track.clips[0]!.duration).toBeCloseTo(0.5, 2);
  expect(track.clips[0]!.file).toMatch(/^audio\/.*\.wav$/);
  expect(await within(controller).findByText(/is in the song on Mix take \d+, a new Audio Track, from 4\.3\.000 \(the playhead\)/)).toBeInTheDocument();
  // Nothing was playing: there was no mix tempo to hold up against the song's.
  expect(within(controller).queryByText(/BPM there/)).not.toBeInTheDocument();
  expect(history.undoLabel).toBe("Add recording to song");

  history.undo();
  expect(history.project.tracks).toHaveLength(before);
});

test("the take can go in at the start of the playhead's bar, or at the song's start", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const fake = fakeOutput();
  renderPads(history, fake);
  const controller = await recordTake(fake);

  choose(controller, "At the start of the playhead's bar");
  await addToSong(controller, "Add the recording to the song, at the start of the playhead's bar, on a new Audio Track");
  await waitFor(() => expect((history.project.tracks.at(-1) as AudioTrack).clips[0]?.start).toBe(BAR_4));
  expect(await within(controller).findByText(/from bar 4\./)).toBeInTheDocument();

  choose(controller, "At the start of the song");
  const count = history.project.tracks.length;
  await addToSong(controller, "Add the recording to the song, at the start of the song, on a new Audio Track");
  await waitFor(() => expect(history.project.tracks).toHaveLength(count + 1));
  expect((history.project.tracks.at(-1) as AudioTrack).clips[0]?.start).toBe(0);
});

test("on the selected Audio Track where it has room, and on a new one where it hasn't", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const vocals = createAudioTrack("Vocals");
  vocals.clips.push({ id: "vox", kind: "audio", start: 0, duration: 1, file: "audio/vox.wav", fileOffset: 0 });
  expect(history.execute({ type: "addTrack", track: vocals }).ok).toBe(true);
  const fake = fakeOutput();
  const openOutput = vi.fn<OpenAudioOutput>(() => Promise.resolve(fake.output));
  const view = render(<SongPage openOutput={openOutput} history={history} view="editor" />);
  // The Vocals Clip selected in the Editor makes Vocals the selected Audio Track.
  fireEvent.click(await screen.findByLabelText("Vocals Clip 1"));
  view.rerender(<SongPage openOutput={openOutput} history={history} view="pads" />);
  const controller = await recordTake(fake);

  choose(controller, "On the selected Audio Track");
  const count = history.project.tracks.length;
  await addToSong(controller, "Add the recording to the song, at the playhead, on the selected Audio Track");
  await waitFor(() => expect(history.project.tracks.find((t) => t.id === vocals.id)!.clips).toHaveLength(2));
  expect(history.project.tracks).toHaveLength(count);
  expect((history.project.tracks.find((t) => t.id === vocals.id) as AudioTrack).clips[1]).toMatchObject({ start: PLAYHEAD });
  expect(await within(controller).findByText(/is in the song on Vocals, from 4\.3\.000/)).toBeInTheDocument();
  history.undo();
  expect(history.project.tracks.find((t) => t.id === vocals.id)!.clips).toHaveLength(1);

  // At the song's start, Vocals' own Clip is in the way: a new Audio Track, and the page says why.
  choose(controller, "At the start of the song");
  await addToSong(controller, "Add the recording to the song, at the start of the song, on the selected Audio Track");
  await waitFor(() => expect(history.project.tracks).toHaveLength(count + 1));
  expect((history.project.tracks.at(-1) as AudioTrack).clips[0]).toMatchObject({ start: 0 });
  expect(await within(controller).findByText(/It isn't on the selected Audio Track: Vocals already has a Clip there\./)).toBeInTheDocument();
});

test("a mix at another tempo than the song's is said, and the song can take the mix's tempo as an undo of its own", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  expect(history.project.tempo).toBe(120);
  const fake = fakeOutput(0);
  renderPads(history, fake);
  const controller = await recordTake(fake, 128);
  await addToSong(controller);

  expect(
    await within(controller).findByText(
      /The mix was at 128 BPM and the song is at 120 BPM there: the take is audio, so it keeps the mix's tempo and isn't stretched/,
    ),
  ).toBeInTheDocument();
  const tracks = history.project.tracks.length;
  fireEvent.click(within(controller).getByRole("button", { name: "Set the song's tempo to 128 BPM, the mix's" }));
  expect(history.project.tempo).toBe(128);
  expect(history.undoLabel).toBe("Set tempo to the mix's");
  expect(await within(controller).findByText(/The song is at 128 BPM from bar 1 now/)).toBeInTheDocument();
  expect(within(controller).queryByRole("button", { name: /^Set the song's tempo/ })).not.toBeInTheDocument();

  // Its undo is the tempo's alone: the take stays.
  history.undo();
  expect(history.project.tempo).toBe(120);
  expect(history.project.tracks).toHaveLength(tracks);
});

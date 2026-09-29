// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { initSync } from "@engine";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import type { AudioOutput, EngineCommand, OpenAudioOutput } from "../audio/audio-output";
import { ProjectHistory } from "../project/history";
import { type AudioTrack, createProject } from "../project/model";
import { SongPage } from "../song/SongPage";
import { DJ_REPORT_LEN } from "./dj-report";

beforeAll(() => {
  // The take is encoded, and measured for its waveform, by the engine in WASM.
  initSync({ module: readFileSync(resolvePath(import.meta.dirname, "../../../engine/pkg/soundcheck_engine_bg.wasm")) });
});

afterEach(cleanup);

function fakeOutput() {
  const sent: EngineCommand[] = [];
  const report: number[] = Array.from({ length: DJ_REPORT_LEN }, () => 0);
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
      engine: null,
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
      loadSample: async () => 0.5,
      unloadSample: () => {},
      takeRecording: async () => take,
      headphones: false,
    },
  };
  return { output, sent, report };
}

test("a take recorded on the Pads page is added to the song as an Audio Clip on a new Audio Track, in one undo", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const before = history.project.tracks.length;
  const fake = fakeOutput();
  const openOutput = vi.fn<OpenAudioOutput>(() => Promise.resolve(fake.output));
  render(<SongPage openOutput={openOutput} history={history} view="pads" />);

  const page = document.getElementById("page-pads")!;
  expect(within(page).getByRole("heading", { level: 1, name: "Pads" })).toBeVisible();
  fireEvent.click(await within(page).findByRole("button", { name: "Start audio for mixing" }));
  const controller = await within(page).findByRole("region", { name: "Pad Controller" });
  await waitFor(() => expect(within(controller).getByRole("button", { name: "Record the mix" })).toBeEnabled());

  fireEvent.click(within(controller).getByRole("button", { name: "Record the mix" }));
  fake.report[5] = 1;
  await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
  fireEvent.click(within(controller).getByRole("button", { name: "Stop recording" }));
  fake.report[5] = 0;
  const add = within(controller).getByRole("button", { name: "Add the recording to the song, on a new Audio Track" });
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);

  await waitFor(() => expect(history.project.tracks).toHaveLength(before + 1));
  const track = history.project.tracks.at(-1) as AudioTrack;
  expect(track.kind).toBe("audio");
  expect(track.name).toMatch(/^Mix take \d+$/);
  expect(track.clips).toHaveLength(1);
  expect(track.clips[0]).toMatchObject({ kind: "audio", start: 0, fileOffset: 0 });
  expect(track.clips[0]!.duration).toBeCloseTo(0.5, 2);
  expect(track.clips[0]!.file).toMatch(/^audio\/.*\.wav$/);
  expect(await within(controller).findByText(/is in the song/)).toBeInTheDocument();
  expect(history.undoLabel).toBe("Add recording to song");

  history.undo();
  expect(history.project.tracks).toHaveLength(before);
});

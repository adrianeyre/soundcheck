// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { AudioOutput, AudioOutputOptions, OpenAudioOutput } from "../audio/audio-output";
import { ProjectHistory } from "../project/history";
import { createInstrumentTrack, createProject } from "../project/model";
import { SongPage } from "../song/SongPage";
import { AUDIO_KEY, readAudioPreferences } from "./audio-preferences";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

/** An output as the desktop would open it: JACK grants its server's 1024 frames whatever is asked. */
function fakeOutput(options: AudioOutputOptions) {
  const host = options.host ?? "ALSA";
  return {
    send: vi.fn<AudioOutput["send"]>(),
    stats: () => ({
      host: `${host}: system`,
      sampleRate: 48_000,
      blockFrames: host === "JACK" ? 1024 : (options.bufferFrames ?? 512),
      requestedBufferFrames: options.bufferFrames ?? null,
      callbacks: null,
      baseLatency: 0,
      outputLatency: null,
      underruns: null,
      engine: null,
      meters: null,
    }),
    currentTime: () => 0,
    takeRecordedNotes: () => [],
    resetCounters: () => {},
    close: vi.fn<AudioOutput["close"]>(() => Promise.resolve()),
  } satisfies AudioOutput;
}

/** The Settings page with the platform's audio device stubbed: ALSA and JACK, as on Linux. */
function setUp(openOutput = vi.fn<OpenAudioOutput>((options) => Promise.resolve(fakeOutput(options)))) {
  const history = new ProjectHistory(createProject("Demo"));
  history.execute({ type: "addTrack", track: createInstrumentTrack("Bass") });
  render(
    <SongPage
      view="settings"
      openOutput={openOutput}
      history={history}
      audioDevice={{ listAudioHosts: () => Promise.resolve(["ALSA", "JACK"]), bufferSizes: [64, 128, 256] }}
    />,
  );
  return { openOutput };
}

const hostSelect = () => screen.getByLabelText<HTMLSelectElement>("Audio host");
const bufferSelect = () => screen.getByLabelText<HTMLSelectElement>("Buffer size");
const choose = (select: HTMLSelectElement, value: string) => fireEvent.change(select, { target: { value } });
// Start audio is on the Editor page, hidden while Settings shows.
const startAudio = () => fireEvent.click(screen.getByRole("button", { name: "Start audio", hidden: true }));

test("the host and buffer size chosen in Settings are kept, and audio starts on them", async () => {
  const { openOutput } = setUp();
  await screen.findByRole("option", { name: "JACK" });
  expect(screen.getByRole("option", { name: "Default (ALSA)" })).toBeInTheDocument();

  choose(hostSelect(), "JACK");
  choose(bufferSelect(), "128");
  expect(readAudioPreferences()).toEqual({ host: "JACK", bufferFrames: 128 });
  expect(openOutput).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("Audio is off");
  expect(screen.getByText(/JACK plays at its server's buffer size/)).toBeInTheDocument();

  startAudio();
  await waitFor(() => expect(openOutput).toHaveBeenCalledTimes(1));
  expect(openOutput).toHaveBeenCalledWith(expect.objectContaining({ host: "JACK", bufferFrames: 128 }));
  // What the stream actually got, beside what was asked for.
  expect(await screen.findByText(/Playing through JACK: system at 48000 Hz/)).toHaveTextContent(
    "1024 frames a buffer (21.3 ms); asked for 128.",
  );

  // Next launch, the same choice.
  cleanup();
  setUp();
  await screen.findByRole("option", { name: "JACK" });
  expect(hostSelect()).toHaveValue("JACK");
  expect(bufferSelect()).toHaveValue("128");
});

test("changing the choice while audio runs restarts it there, without restarting the app", async () => {
  const { openOutput } = setUp();
  await screen.findByRole("option", { name: "JACK" });
  startAudio();
  await screen.findByText(/Playing through ALSA: system/);
  const first = (await openOutput.mock.results[0]!.value) as ReturnType<typeof fakeOutput>;
  expect(openOutput).toHaveBeenLastCalledWith({ latencyHint: "interactive", trackCount: 0 });

  choose(bufferSelect(), "64");
  await waitFor(() => expect(openOutput).toHaveBeenCalledTimes(2));
  expect(first.close).toHaveBeenCalled();
  expect(openOutput).toHaveBeenLastCalledWith(expect.objectContaining({ bufferFrames: 64 }));
  expect(await screen.findByText(/Playing through ALSA: system/)).toHaveTextContent("64 frames a buffer (1.3 ms).");
  // The new stream is a fresh engine, and is sent the Project again.
  const second = (await openOutput.mock.results[1]!.value) as ReturnType<typeof fakeOutput>;
  await waitFor(() => expect(second.send).toHaveBeenCalledWith({ type: "setTrackCount", count: 1 }));

  // Back to the host's default size: nothing is asked for.
  choose(bufferSelect(), "");
  await waitFor(() => expect(openOutput).toHaveBeenCalledTimes(3));
  expect(openOutput).toHaveBeenLastCalledWith({ latencyHint: "interactive", trackCount: 0 });
  expect(JSON.parse(localStorage.getItem(AUDIO_KEY)!)).toEqual({ host: null, bufferFrames: null });
});

test("a host that fails to start says why beside the choice", async () => {
  const jackDown = "JACK has no audio output: no JACK server is running.";
  const openOutput = vi.fn<OpenAudioOutput>((options) =>
    options.host === "JACK" ? Promise.reject(jackDown) : Promise.resolve(fakeOutput(options)),
  );
  setUp(openOutput);
  await screen.findByRole("option", { name: "JACK" });
  startAudio();
  await screen.findByText(/Playing through ALSA/);

  choose(hostSelect(), "JACK");
  expect(await screen.findByRole("alert")).toHaveTextContent(`Audio didn't start: ${jackDown}`);
  // Choosing ALSA again brings it back, once audio is started.
  choose(hostSelect(), "ALSA");
  startAudio();
  await screen.findByText(/Playing through ALSA/);
});

test("a saved choice that isn't readable is the platform's default", () => {
  localStorage.setItem(AUDIO_KEY, "{not json");
  expect(readAudioPreferences()).toEqual({ host: null, bufferFrames: null });
  localStorage.setItem(AUDIO_KEY, JSON.stringify({ host: "", bufferFrames: -3 }));
  expect(readAudioPreferences()).toEqual({ host: null, bufferFrames: null });
});

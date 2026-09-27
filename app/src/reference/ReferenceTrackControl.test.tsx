// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { initSync } from "@engine";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import type { AudioOutput, OpenAudioOutput } from "../audio/audio-output";
import type { LoadedSample } from "../project/engine-sync";
import { ProjectHistory } from "../project/history";
import { createProject } from "../project/model";
import { SongPage } from "../song/SongPage";
import { stereoWav } from "../song/test-wav";
import type { ReferencePlayer } from "./reference-player";
import { ReferenceTrackControl } from "./ReferenceTrackControl";

afterEach(cleanup);

// A chosen file is measured with the engine's own decoder, in WASM.
beforeAll(() => {
  initSync({ module: readFileSync(resolvePath(import.meta.dirname, "../../../engine/pkg/soundcheck_engine_bg.wasm")) });
});

/** Half a second of a 1 kHz tone at half scale: about -6 LUFS. */
function finished(name = "finished.wav"): LoadedSample {
  const tone = Array.from({ length: 24_000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1_000 * i) / 48_000));
  return { name, bytes: stereoWav(tone, tone, 48_000) };
}

/** A player that hands over `chosen` files in turn, and keeps what it was asked to play. */
function fakePlayer(...chosen: (LoadedSample | null)[]) {
  return {
    chooseFile: vi.fn<ReferencePlayer["chooseFile"]>(() => Promise.resolve(chosen.shift() ?? null)),
    audition: vi.fn<ReferencePlayer["audition"]>(() => Promise.resolve()),
    stopAudition: vi.fn<ReferencePlayer["stopAudition"]>(() => Promise.resolve()),
  } satisfies ReferencePlayer;
}

function songPage(player: ReferencePlayer) {
  const history = new ProjectHistory(createProject("Demo"));
  const openOutput = vi.fn<OpenAudioOutput>(() => Promise.resolve({} as AudioOutput));
  render(<SongPage openOutput={openOutput} history={history} reference={player} />);
  return history;
}

test("a Reference Track is added beside the transport, copied into the Project, replaced and removed, each one undo step", async () => {
  const history = songPage(fakePlayer(finished(), finished("other.wav")));

  fireEvent.click(screen.getByRole("button", { name: "Add reference" }));
  await waitFor(() => expect(history.project.referenceTrack).toEqual({ file: "audio/finished.wav" }));
  expect(screen.getByRole("status", { name: "Reference Track" })).toHaveTextContent("finished.wav");
  expect(history.undoLabel).toBe("Add Reference Track");

  fireEvent.click(screen.getByRole("button", { name: "Replace reference" }));
  await waitFor(() => expect(history.project.referenceTrack).toEqual({ file: "audio/other.wav" }));
  expect(history.undoLabel).toBe("Replace Reference Track");

  fireEvent.click(screen.getByRole("button", { name: "Remove the Reference Track" }));
  expect(history.project.referenceTrack).toBeNull();
  history.undo();
  expect(history.project.referenceTrack).toEqual({ file: "audio/other.wav" });
});

test("a file that isn't audio is refused, saying why, and nothing changes", async () => {
  const history = songPage(fakePlayer({ name: "notes.txt", bytes: [1, 2, 3] }));
  fireEvent.click(screen.getByRole("button", { name: "Add reference" }));
  expect(await screen.findByText(/notes\.txt can't be measured/)).toBeInTheDocument();
  expect(history.project.referenceTrack).toBeNull();
  expect(history.canUndo).toBe(false);
});

test("the reference auditions at its own level, or turned down to the mix's loudness, and stops", async () => {
  const player = fakePlayer();
  const sample = finished();
  const measureMix = vi.fn<() => Promise<number | null>>(() => Promise.resolve(-20));
  render(
    <ReferenceTrackControl
      referenceTrack={{ file: "audio/finished.wav" }}
      sample={sample}
      player={player}
      measureMix={measureMix}
      onChoose={() => {}}
      onRemove={() => {}}
      onError={(error) => {
        throw new Error(error);
      }}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Audition finished.wav" }));
  await waitFor(() => expect(player.audition).toHaveBeenCalledWith(sample, 1));
  expect(measureMix).not.toHaveBeenCalled();

  // Matched while it plays: heard again straight away, about 14 dB down.
  fireEvent.click(screen.getByRole("checkbox", { name: "Match loudness" }));
  await waitFor(() => expect(player.audition).toHaveBeenCalledTimes(2));
  expect(player.audition.mock.calls[1]![1]).toBeCloseTo(10 ** (-14 / 20), 2);

  fireEvent.click(screen.getByRole("button", { name: "Stop the reference" }));
  await waitFor(() => expect(player.stopAudition).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Audition finished.wav" })).toBeInTheDocument();
});

test("a Reference Track the folder hasn't got is shown missing, and can't be auditioned", () => {
  render(
    <ReferenceTrackControl
      referenceTrack={{ file: "audio/finished.wav" }}
      sample={undefined}
      player={fakePlayer()}
      onChoose={() => {}}
      onRemove={() => {}}
      onError={() => {}}
    />,
  );
  expect(screen.getByRole("status", { name: "Reference Track" })).toHaveTextContent("finished.wav (missing)");
  expect(screen.getByRole("button", { name: "Audition finished.wav" })).toBeDisabled();
  // Where the mix can't be measured, loudness can't be matched.
  expect(screen.getByRole("checkbox", { name: "Match loudness" })).toBeDisabled();
});

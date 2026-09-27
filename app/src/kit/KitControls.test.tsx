// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { OpenAudioOutput } from "../audio/audio-output";
import { memoryLibraryStorage, type LibraryStorage } from "../preset/library-storage";
import { ProjectHistory } from "../project/history";
import { createProject, type DrumPad, STARTER_KIT_PRESET } from "../project/model";
import { SongPage } from "../song/SongPage";
import { FakeFileStorage, fakeFolder } from "../storage/fake-file-storage";
import { chooseFromFileMenu } from "../ui/file-menu-testing";

afterEach(cleanup);

/** The smallest thing the UI will take as a WAV: a RIFF/WAVE header and some. */
function riffWav(fill: number): number[] {
  const wav = Array<number>(64).fill(fill);
  [..."RIFF"].forEach((c, i) => (wav[i] = c.codePointAt(0)!));
  [..."WAVE"].forEach((c, i) => (wav[8 + i] = c.codePointAt(0)!));
  return wav;
}

/** One session of the app, with a Drum Track holding a Pattern Clip, sharing `library` with the others. */
function session(library: LibraryStorage, storage = new FakeFileStorage()) {
  const history = new ProjectHistory(createProject("Demo"));
  render(<SongPage openOutput={vi.fn<OpenAudioOutput>()} storage={storage} history={history} library={library} />);
  click("Add Drum Track");
  click("Add Pattern Clip");
  const pads = (): DrumPad[] => {
    const track = history.project.tracks[0];
    if (track?.kind !== "instrument" || track.instrument.type !== "drumSampler") throw new Error("no pads");
    return track.instrument.pads;
  };
  return { history, pads, storage };
}

/** By name, hidden or not: Save is on the Settings page. */
function click(name: string) {
  const found = [...document.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  fireEvent.click(found);
}

test("a Kit saved in one Project loads into another, samples and all, undoes, and saves into its folder", async () => {
  const library = memoryLibraryStorage();
  const clap = riffWav(7);

  // The first Project: a clap on pad 3, and the Open Hat turned down.
  const first = session(library);
  fireEvent.change(screen.getByLabelText("Clap sample"), { target: { files: [new File([new Uint8Array(clap)], "clap.wav")] } });
  await screen.findByText("clap.wav");
  fireEvent.change(screen.getByLabelText("Open Hat volume"), { target: { value: "0.5" } });
  click("Save kit of Drums 1's pads");
  const dialog = screen.getByRole("dialog", { name: "Save kit" });
  fireEvent.change(within(dialog).getByLabelText("Kit name"), { target: { value: "Claps" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save kit" })).not.toBeInTheDocument());
  const saved = first.pads();
  cleanup();

  // Another Project, in a later session, reading the same library.
  const folder = fakeFolder("/songs/second");
  const second = session(library);
  second.storage.saveChoice = folder;
  const picker = screen.getByLabelText("Drums 1 kit");
  await within(picker).findByRole("option", { name: "Claps" });
  expect(picker).toHaveValue(STARTER_KIT_PRESET);
  fireEvent.change(picker, { target: { value: "Claps" } });
  await screen.findByText("clap.wav");
  expect(second.pads()).toEqual(saved);
  expect(screen.getByLabelText("Drums 1 kit")).toHaveValue("Claps");

  // One undo step, back to the Starter Kit.
  expect(second.history.undoLabel).toBe("Load Kit");
  click("Undo Load Kit");
  expect(second.pads()[2]!.sample).toBeNull();
  click("Redo Load Kit");
  expect(second.pads()[2]!.sample).toBe("audio/clap.wav");

  // The Project folder holds its own copy of the Kit's sample.
  chooseFromFileMenu("Save");
  await waitFor(() => expect(second.storage.files(folder.id)).toEqual(["audio/clap.wav", "project.json"]));
  expect([...(await second.storage.readBytes(folder, "audio/clap.wav"))]).toEqual(clap);
});

test("a saved Kit is deleted from the Kits dialog, and the Starter Kit can't be", async () => {
  const library = memoryLibraryStorage();
  session(library);
  click("Save kit of Drums 1's pads");
  const saving = screen.getByRole("dialog", { name: "Save kit" });
  fireEvent.change(within(saving).getByLabelText("Kit name"), { target: { value: STARTER_KIT_PRESET } });
  fireEvent.click(within(saving).getByRole("button", { name: "Save" }));
  expect(await within(saving).findByRole("alert")).toHaveTextContent("bundled Kit's name");
  fireEvent.change(within(saving).getByLabelText("Kit name"), { target: { value: "Plain" } });
  fireEvent.click(within(saving).getByRole("button", { name: "Save" }));
  await within(screen.getByLabelText("Drums 1 kit")).findByRole("option", { name: "Plain" });

  click("Manage kits");
  const kits = screen.getByRole("dialog", { name: "Kits" });
  expect(within(kits).queryByRole("button", { name: `Delete ${STARTER_KIT_PRESET}` })).not.toBeInTheDocument();
  fireEvent.click(within(kits).getByRole("button", { name: "Delete Plain" }));
  await waitFor(() => expect(within(kits).queryByText("Plain")).not.toBeInTheDocument());
  expect(await library.listFiles("kits")).toEqual([]);
});

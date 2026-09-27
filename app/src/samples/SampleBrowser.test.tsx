// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { memoryLibraryStorage } from "../preset/library-storage";
import { SAMPLE_DRAG_TYPE } from "./sample-drag";
import { PREVIEW_KEY, SHOWN_FILES, SampleBrowser, type SampleBrowserProps } from "./SampleBrowser";
import type { SampleFolder, SampleSource } from "./sample-source";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const drums: SampleFolder = { id: "C:/Samples/Drums", label: "Drums" };
const loops: SampleFolder = { id: "D:/Loops", label: "Loops" };

/** Folders on a pretend disk, and the musician's answer to the chooser. */
function fakeSource(chosen: SampleFolder | null = drums) {
  const files: Record<string, string[]> = {
    [drums.id]: ["Kicks/kick.wav", "Kicks/808/boom.wav", "snare.wav"],
    [loops.id]: ["beat.flac"],
  };
  const answer = { chosen };
  const source = {
    get chosen() {
      return answer.chosen;
    },
    set chosen(folder: SampleFolder | null) {
      answer.chosen = folder;
    },
    chooseFolder: vi.fn<SampleSource["chooseFolder"]>(() => Promise.resolve(answer.chosen)),
    listAudio: vi.fn<SampleSource["listAudio"]>((folder) => Promise.resolve(files[folder.id] ?? [])),
    readBytes: vi.fn<SampleSource["readBytes"]>(() => Promise.resolve(new Uint8Array([1, 2, 3]))),
    audition: vi.fn<SampleSource["audition"]>(() => Promise.resolve()),
    stopAudition: vi.fn<SampleSource["stopAudition"]>(() => Promise.resolve()),
  };
  return source satisfies SampleSource;
}

function show(props: Partial<SampleBrowserProps> = {}) {
  const onUse = vi.fn<SampleBrowserProps["onUse"]>();
  const onError = vi.fn<SampleBrowserProps["onError"]>();
  render(
    <SampleBrowser
      source={fakeSource()}
      library={memoryLibraryStorage()}
      canAudition
      targets={[
        { id: "track:a", label: "Audio 1" },
        { id: "pad:d:0", label: "Drums 1: Kick" },
      ]}
      onUse={onUse}
      onError={onError}
      {...props}
    />,
  );
  return { onUse, onError };
}

/** A library with these folders already added, as on a later launch. */
function libraryWith(...folders: SampleFolder[]) {
  return memoryLibraryStorage(new Map([["sample-folders.json", JSON.stringify({ folders })]]));
}

const item = (name: string) => screen.getByRole("treeitem", { name });
const findItem = (name: string | RegExp) => screen.findByRole("treeitem", { name });
const tree = () => screen.getByRole("tree", { name: "Sample folders" });
const key = (name: string) => fireEvent.keyDown(tree(), { key: name });

test("where there are no sample folders to reach, the browser says it is unavailable", () => {
  show({ source: null });
  expect(screen.getByText(/The sample browser is unavailable here/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add folder" })).not.toBeInTheDocument();
});

test("with no folders yet, it says what it is for and offers to add one", async () => {
  show({ source: fakeSource() });
  expect(await screen.findByText(/Add a folder of samples to browse its folders/)).toBeInTheDocument();
  expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
  expect(await findItem("Drums")).toHaveAttribute("aria-expanded", "true");
});

test("a folder's files are shown in the folders they sit in, which open and close", async () => {
  show({ library: libraryWith(drums) });
  const drumsItem = await findItem("Drums");
  expect(drumsItem).toHaveAttribute("aria-level", "1");
  // Its folders first, closed, then its files; each folder with how many files it holds.
  const kicks = await findItem("Kicks");
  expect(kicks).toHaveAttribute("aria-expanded", "false");
  expect(kicks).toHaveAttribute("aria-level", "2");
  expect(kicks).toHaveAccessibleDescription("2 samples");
  expect(item("snare.wav")).toHaveAttribute("aria-level", "2");
  expect(screen.queryByRole("treeitem", { name: "kick.wav" })).not.toBeInTheDocument();

  fireEvent.click(kicks);
  expect(kicks).toHaveAttribute("aria-expanded", "true");
  expect(item("808")).toHaveAttribute("aria-level", "3");
  expect(item("kick.wav")).toHaveAttribute("aria-level", "3");
  const names = within(tree())
    .getAllByRole("treeitem")
    .map((row) => row.getAttribute("aria-labelledby") && document.getElementById(row.getAttribute("aria-labelledby")!)?.textContent);
  expect(names).toEqual(["Drums", "Kicks", "808", "kick.wav", "snare.wav"]);

  fireEvent.click(drumsItem);
  expect(drumsItem).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("treeitem", { name: "snare.wav" })).not.toBeInTheDocument();
});

test("folders added and removed are remembered in the library for the next launch", async () => {
  const files = new Map<string, string>();
  const source = fakeSource();
  show({ source, library: memoryLibraryStorage(files) });
  await screen.findByText(/Add a folder of samples/);
  fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
  await findItem("snare.wav");
  source.chosen = loops;
  fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
  await findItem("beat.flac");
  // Choosing nothing adds nothing.
  source.chosen = null;
  fireEvent.click(screen.getByRole("button", { name: "Add folder" }));

  // A selected folder is removed from the browser, never from the disk.
  fireEvent.click(item("Drums"));
  const details = screen.getByRole("group", { name: "Selected folder" });
  expect(details).toHaveTextContent("stay where they are on your machine");
  fireEvent.click(within(details).getByRole("button", { name: "Remove Drums" }));
  expect(screen.queryByRole("treeitem", { name: "Drums" })).not.toBeInTheDocument();

  // The next launch: a new browser over the same library.
  cleanup();
  show({ source: fakeSource(), library: memoryLibraryStorage(files) });
  expect(await findItem("beat.flac")).toBeInTheDocument();
  expect(screen.queryByRole("treeitem", { name: "Drums" })).not.toBeInTheDocument();
});

test("the tree is one stop for the keyboard, and the arrow keys walk and open it", async () => {
  show({ library: libraryWith(drums) });
  await findItem("snare.wav");
  // Only the selected line is in the tab order.
  expect(within(tree()).getAllByRole("treeitem").filter((row) => row.tabIndex === 0)).toEqual([item("Drums")]);

  key("ArrowDown");
  expect(item("Kicks")).toHaveFocus();
  expect(item("Kicks")).toHaveAttribute("aria-selected", "true");
  key("ArrowRight");
  expect(item("Kicks")).toHaveAttribute("aria-expanded", "true");
  key("ArrowRight");
  expect(item("808")).toHaveFocus();
  key("ArrowLeft");
  expect(item("Kicks")).toHaveFocus();
  key("ArrowLeft");
  expect(item("Kicks")).toHaveAttribute("aria-expanded", "false");
  key("End");
  expect(item("snare.wav")).toHaveFocus();
  key("Home");
  expect(item("Drums")).toHaveFocus();
  // Typing a name's start goes to it.
  key("s");
  expect(item("snare.wav")).toHaveFocus();
  key("Enter");
  key("Enter");
});

test("a file auditions from Enter, its play button or the selection, and Escape stops it", async () => {
  const source = fakeSource();
  show({ source, library: libraryWith(drums) });
  fireEvent.click(await findItem("snare.wav"));
  key("Enter");
  expect(source.audition).toHaveBeenCalledWith({ folder: drums, path: "snare.wav" });
  expect(item("snare.wav")).toHaveAttribute("data-playing", "true");
  const details = screen.getByRole("group", { name: "Selected sample" });
  expect(details).toHaveTextContent("snare.wav");
  expect(details).toHaveTextContent("Drums · WAV");
  key("Escape");
  expect(source.stopAudition).toHaveBeenCalledTimes(1);
  expect(item("snare.wav")).not.toHaveAttribute("data-playing");

  fireEvent.click(within(details).getByRole("button", { name: "Audition" }));
  expect(source.audition).toHaveBeenCalledTimes(2);
  fireEvent.click(within(details).getByRole("button", { name: "Stop" }));
  expect(source.stopAudition).toHaveBeenCalledTimes(2);

  fireEvent.doubleClick(item("snare.wav"));
  expect(source.audition).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole("button", { name: "Stop audition" }));
  expect(source.stopAudition).toHaveBeenCalledTimes(3);
});

test("where the platform says an audition has ended, the file stops showing as playing", async () => {
  const listeners: (() => void)[] = [];
  const source = { ...fakeSource(), onAuditionEnd: (listener: () => void) => (listeners.push(listener), () => {}) };
  show({ source, library: libraryWith(drums) });
  fireEvent.click(await findItem("snare.wav"));
  key("Enter");
  await waitFor(() => expect(item("snare.wav")).toHaveAttribute("data-playing", "true"));
  for (const listener of listeners) listener();
  await waitFor(() => expect(item("snare.wav")).not.toHaveAttribute("data-playing"));
});

test("without audio running nothing auditions, and it says to start audio", async () => {
  const source = fakeSource();
  show({ source, library: libraryWith(drums), canAudition: false });
  fireEvent.click(await findItem("snare.wav"));
  key("Enter");
  expect(source.audition).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Audition" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Preview on select" })).toBeDisabled();
  expect(screen.getByText(/Start audio to audition/)).toBeInTheDocument();
});

test("with preview on, each file plays as it is selected, and the choice is remembered", async () => {
  const source = fakeSource();
  show({ source, library: libraryWith(drums) });
  const toggle = await screen.findByRole("button", { name: "Preview on select" });
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(localStorage.getItem(PREVIEW_KEY)).toBe("on");

  fireEvent.click(await findItem("snare.wav"));
  expect(source.audition).toHaveBeenCalledWith({ folder: drums, path: "snare.wav" });
  // Moving onto a folder plays nothing.
  key("ArrowUp");
  expect(source.audition).toHaveBeenCalledTimes(1);

  cleanup();
  show({ source, library: libraryWith(drums) });
  expect(await screen.findByRole("button", { name: "Preview on select" })).toHaveAttribute("aria-pressed", "true");
});

test("a file is dragged with its folder and path, or put on a Track or Pad from the selection", async () => {
  const { onUse } = show({ library: libraryWith(drums) });
  fireEvent.click(await findItem("Kicks"));
  const setData = vi.fn<DataTransfer["setData"]>();
  fireEvent.dragStart(item("kick.wav"), { dataTransfer: { setData, effectAllowed: "" } });
  expect(setData).toHaveBeenCalledWith(SAMPLE_DRAG_TYPE, JSON.stringify({ folder: drums, path: "Kicks/kick.wav" }));
  // Folders aren't dragged.
  expect(item("Kicks")).not.toHaveAttribute("draggable", "true");

  expect(screen.queryByRole("combobox", { name: "Put on" })).not.toBeInTheDocument();
  fireEvent.click(item("kick.wav"));
  expect(screen.getByRole("group", { name: "Selected sample" })).toHaveTextContent("Drums / Kicks · WAV");
  fireEvent.change(screen.getByRole("combobox", { name: "Put on" }), { target: { value: "pad:d:0" } });
  expect(onUse).toHaveBeenCalledWith({ folder: drums, path: "Kicks/kick.wav" }, "pad:d:0");
});

test("searching keeps the matching files, opens the folders that hold them and marks the words", async () => {
  show({ library: libraryWith(drums, loops) });
  await findItem("snare.wav");
  await findItem("beat.flac");
  const search = screen.getByRole("searchbox", { name: "Search samples" });
  fireEvent.change(search, { target: { value: "kick wav" } });
  await waitFor(() => expect(screen.queryByRole("treeitem", { name: "snare.wav" })).not.toBeInTheDocument());
  expect(item("Kicks")).toHaveAttribute("aria-expanded", "true");
  expect(item("kick.wav").querySelector("mark")).toHaveTextContent("kick");
  // A folder with nothing matching is left out.
  expect(screen.queryByRole("treeitem", { name: "Loops" })).not.toBeInTheDocument();
  // "Kicks/808/boom.wav" has both words in its path too.
  expect(item("boom.wav")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("2 of 4 samples match");

  fireEvent.change(search, { target: { value: "nothing" } });
  expect(await screen.findByRole("status")).toHaveTextContent("No samples match “nothing”.");
  fireEvent.click(screen.getAllByRole("button", { name: "Clear search" }).at(-1)!);
  expect(await findItem("snare.wav")).toBeInTheDocument();

  // Escape in the box clears it too, and the down arrow goes into the tree.
  fireEvent.change(search, { target: { value: "beat" } });
  await waitFor(() => expect(screen.queryByRole("treeitem", { name: "snare.wav" })).not.toBeInTheDocument());
  fireEvent.keyDown(search, { key: "Escape" });
  expect(search).toHaveValue("");
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(item("Drums")).toHaveFocus();
});

test("a big folder shows its first entries, and the rest on asking", async () => {
  const many = Array.from({ length: SHOWN_FILES + 5 }, (_, index) => `hit ${index + 1}.wav`);
  const source = fakeSource();
  source.listAudio.mockResolvedValue(many);
  show({ source, library: libraryWith(drums) });
  const more = await findItem(`Show 5 more of 5`);
  expect(screen.queryByRole("treeitem", { name: `hit ${SHOWN_FILES + 1}.wav` })).not.toBeInTheDocument();
  fireEvent.click(more);
  expect(await findItem(`hit ${SHOWN_FILES + 5}.wav`)).toBeInTheDocument();
  expect(screen.queryByRole("treeitem", { name: /^Show/ })).not.toBeInTheDocument();
});

test("a folder that couldn't be read says so, and is read again from a click, which a browser can ask permission on", async () => {
  const source = fakeSource();
  source.listAudio.mockRejectedValueOnce(new Error("the browser needs your permission to read it again"));
  show({ source, library: libraryWith(drums) });
  const failed = await findItem(/Drums couldn.t be read: the browser needs your permission/);
  expect(failed).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(failed);
  fireEvent.click(screen.getByRole("button", { name: "Read Drums again" }));
  expect(await findItem("snare.wav")).toBeInTheDocument();
  expect(source.listAudio).toHaveBeenCalledTimes(2);
});

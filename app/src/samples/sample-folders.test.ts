import { expect, test } from "vitest";

import { memoryLibraryStorage } from "../preset/library-storage";
import {
  SAMPLE_FOLDERS_FILE,
  addSampleFolder,
  loadSampleFolders,
  removeSampleFolder,
  saveSampleFolders,
} from "./sample-folders";

const drums = { id: "C:/Samples/Drums", label: "Drums" };
const loops = { id: "D:/Loops", label: "Loops" };

test("folders added and removed are what the next launch reads back", async () => {
  // The library outlives the app: a second launch reads the same files.
  const files = new Map<string, string>();
  expect(await loadSampleFolders(memoryLibraryStorage(files))).toEqual([]);

  let folders = addSampleFolder([], drums);
  folders = addSampleFolder(folders, loops);
  // Adding one that is there already changes nothing.
  folders = addSampleFolder(folders, { ...drums });
  await saveSampleFolders(memoryLibraryStorage(files), folders);
  expect(await loadSampleFolders(memoryLibraryStorage(files))).toEqual([drums, loops]);

  await saveSampleFolders(memoryLibraryStorage(files), removeSampleFolder(folders, drums.id));
  expect(await loadSampleFolders(memoryLibraryStorage(files))).toEqual([loops]);
});

const read = (text: string) => loadSampleFolders(memoryLibraryStorage(new Map([[SAMPLE_FOLDERS_FILE, text]])));

test("a damaged file, or a damaged entry in it, is skipped rather than breaking the browser", async () => {
  expect(await read("not json")).toEqual([]);
  expect(await read("null")).toEqual([]);
  expect(await read('{"folders":"C:/"}')).toEqual([]);
  expect(await read(JSON.stringify({ folders: [drums, null, { id: 3 }, { id: "", label: "" }, loops, drums] }))).toEqual([
    drums,
    loops,
  ]);
});

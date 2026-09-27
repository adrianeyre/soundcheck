import { expect, test } from "vitest";

import {
  baseName,
  filterSampleTree,
  folderPart,
  formatOf,
  matchRanges,
  sampleTree,
  searchWords,
  type SampleTreeFolder,
} from "./sample-tree";

const files = ["snare.wav", "Kicks/kick 10.wav", "Kicks/kick 2.wav", "Kicks/808/boom.flac", "Loops/beat.mp3", "Ambient/pad.wav"];

/** The tree as indented lines, folders ending in "/", with each folder's count. */
function outline(folder: SampleTreeFolder, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  return [
    ...folder.folders.flatMap((child) => [`${pad}${child.name}/ (${child.count})`, ...outline(child, depth + 1)]),
    ...folder.files.map((path) => `${pad}${baseName(path)}`),
  ];
}

test("files are arranged in the folders they sit in, folders first, in the order a musician counts", () => {
  const tree = sampleTree(files);
  expect(tree.count).toBe(6);
  expect(outline(tree)).toEqual([
    "Ambient/ (1)",
    "  pad.wav",
    "Kicks/ (3)",
    "  808/ (1)",
    "    boom.flac",
    "  kick 2.wav",
    "  kick 10.wav",
    "Loops/ (1)",
    "  beat.mp3",
    "snare.wav",
  ]);
  // Each folder knows its own path, and each file keeps its whole one.
  expect(tree.folders[1]?.folders[0]?.path).toBe("Kicks/808");
  expect(tree.folders[1]?.files).toEqual(["Kicks/kick 2.wav", "Kicks/kick 10.wav"]);
});

test("a search keeps only the files with every word in their path, and the folders that hold them", () => {
  const tree = sampleTree(files);
  expect(outline(filterSampleTree(tree, searchWords("  KICK  wav "))!)).toEqual([
    "Kicks/ (2)",
    "  kick 2.wav",
    "  kick 10.wav",
  ]);
  // A folder's name counts, so searching for it finds everything inside.
  expect(filterSampleTree(tree, searchWords("808"))?.count).toBe(1);
  expect(filterSampleTree(tree, searchWords("nothing"))).toBeNull();
  expect(filterSampleTree(tree, searchWords(""))).toBe(tree);
});

test("the words of a search are found in a name, merged where they overlap", () => {
  expect(matchRanges("Kick 808 kick.wav", searchWords("kick 80"))).toEqual([
    [0, 4],
    [5, 7],
    [9, 13],
  ]);
  expect(matchRanges("abcd", ["abc", "bcd"])).toEqual([[0, 4]]);
  expect(matchRanges("snare", [])).toEqual([]);
});

test("a path's name, folder and format", () => {
  expect(baseName("Kicks/808/boom.flac")).toBe("boom.flac");
  expect(folderPart("Kicks/808/boom.flac")).toBe("Kicks/808");
  expect(folderPart("snare.wav")).toBe("");
  expect(formatOf("Kicks/boom.flac")).toBe("FLAC");
  expect(formatOf("README")).toBe("");
});

import { expect, test } from "vitest";

import { sampleProject } from "../project/fixtures";
import { ProjectHistory } from "../project/history";
import type { AudioClip, AudioTrack, Project } from "../project/model";
import { FakeFileStorage, fakeFolder } from "../storage/fake-file-storage";
import { openProject, saveProject } from "../storage/project-folder";
import { IMPORT_LABEL, placeImportedStems, placeStems, SEPARATE_LABEL } from "./place-stems";
import { STEM_NAMES, type Stem } from "./stem-separator";

/** Each Stem a file of its own: its name's bytes. */
const STEMS: Stem[] = STEM_NAMES.map((name) => ({ name, wav: new TextEncoder().encode(`RIFF ${name}`) }));

/** The sample Project's Vocals Clip, trimmed: 4 s from 0.5 s into take1.wav, at bar 2. */
function vocalsClip(project: Project): AudioClip {
  return (project.tracks[2] as AudioTrack).clips[0]!;
}

function ids() {
  let next = 0;
  return () => `stem-${++next}`;
}

test("a trimmed Clip's Stems go on four new Tracks under its Track, as long as it and where it was, in its place", () => {
  const project = sampleProject();
  const source = vocalsClip(project);
  const history = new ProjectHistory(project);

  const placed = placeStems(project, new Map(), source, STEMS, ids());
  if (!placed.ok) throw new Error(placed.error);
  expect(history.execute(placed.commands, SEPARATE_LABEL).ok).toBe(true);

  const tracks = history.project.tracks;
  expect(tracks.map((track) => track.name)).toEqual([
    "Keys",
    "Bass",
    "Vocals",
    "take1 – Vocals",
    "take1 – Drums",
    "take1 – Bass",
    "take1 – Other",
    "Drums",
  ]);
  expect(tracks.slice(3, 7).map((track) => track.id)).toEqual(placed.trackIds);
  const stemClips = tracks.slice(3, 7).map((track) => {
    expect(track.kind).toBe("audio");
    expect(track.clips).toHaveLength(1);
    return track.clips[0] as AudioClip;
  });
  // Each plays its whole Stem, which is the stretch the source Clip played.
  for (const clip of stemClips) expect(clip).toMatchObject({ kind: "audio", start: 3840, duration: 4, fileOffset: 0 });
  expect(stemClips.map((clip) => clip.file)).toEqual([
    "audio/take1 – Vocals.wav",
    "audio/take1 – Drums.wav",
    "audio/take1 – Bass.wav",
    "audio/take1 – Other.wav",
  ]);
  // The source Clip is gone; its Track stays.
  expect(tracks[2]!.clips).toEqual([]);
  // The Stems' audio is the Project's, under the paths the Clips name.
  expect([...placed.samples.keys()]).toEqual(stemClips.map((clip) => clip.file));
  expect(new TextDecoder().decode(Uint8Array.from(placed.samples.get("audio/take1 – Drums.wav")!.bytes))).toBe(
    "RIFF drums",
  );
});

test("the whole Stem Separation is one undo step, which restores the Project exactly", () => {
  const project = sampleProject();
  const history = new ProjectHistory(project);
  const placed = placeStems(project, new Map(), vocalsClip(project), STEMS, ids());
  if (!placed.ok) throw new Error(placed.error);
  history.execute(placed.commands, SEPARATE_LABEL);

  expect(history.undoLabel).toBe(SEPARATE_LABEL);
  history.undo();
  expect(history.project).toEqual(sampleProject());
  expect(history.canUndo).toBe(false);
});

test("a Clip deleted while it was being separated changes nothing, and says why", () => {
  const project = sampleProject();
  const source = vocalsClip(project);
  const history = new ProjectHistory(project);
  history.execute({ type: "deleteClip", clipId: source.id });

  const placed = placeStems(history.project, new Map(), source, STEMS, ids());
  expect(placed).toEqual({ ok: false, error: "take1 was deleted while it was being separated, so its Stems were discarded." });
});

test("a Clip trimmed while it was being separated gets no Stems: they are of audio it no longer plays", () => {
  const project = sampleProject();
  const source = vocalsClip(project);
  const history = new ProjectHistory(project);
  history.execute({ type: "trimClip", clipId: source.id, start: 3840, length: 960, fileOffset: 0.5 });

  const placed = placeStems(history.project, new Map(), source, STEMS, ids());
  expect(placed.ok).toBe(false);
  expect(!placed.ok && placed.error).toMatch(/^take1 was trimmed while it was being separated/);
});

test("a Clip moved while it was being separated has its Stems where it is now", () => {
  const project = sampleProject();
  const source = vocalsClip(project);
  const history = new ProjectHistory(project);
  history.execute({ type: "moveClip", clipId: source.id, start: 7680 });

  const placed = placeStems(history.project, new Map(), source, STEMS, ids());
  if (!placed.ok) throw new Error(placed.error);
  history.execute(placed.commands);
  expect(history.project.tracks[3]!.clips[0]).toMatchObject({ start: 7680, duration: 4 });
});

test("a Stem's file never takes the name of one the Project already has", () => {
  const project = sampleProject();
  const taken = new Map([["audio/take1 – Vocals.wav", { name: "take1 – Vocals.wav", bytes: [1, 2, 3] }]]);
  const placed = placeStems(project, taken, vocalsClip(project), STEMS, ids());
  expect(placed.ok && [...placed.samples.keys()][0]).toBe("audio/take1 – Vocals-2.wav");
});

test("saving and reopening the Project keeps the Stems' audio", async () => {
  const storage = new FakeFileStorage();
  const folder = fakeFolder("/songs/first");
  storage.add("/songs/first", "audio/take1.wav", "RIFF take 1");
  const history = new ProjectHistory(sampleProject());
  const placed = placeStems(history.project, new Map(), vocalsClip(history.project), STEMS, ids());
  if (!placed.ok) throw new Error(placed.error);
  history.execute(placed.commands);

  expect(await saveProject(storage, history.project, folder, null, placed.samples)).toEqual({ ok: true, missingAudio: [] });
  const opened = await openProject(storage, folder);
  if (!opened.ok) throw new Error(opened.error);
  expect(opened.project).toEqual(history.project);
  for (const [path, sample] of placed.samples) expect(opened.samples.get(path)?.bytes).toEqual(sample.bytes);
});

test("only the Stems kept get Tracks, still in their order, and the source Clip goes all the same", () => {
  const project = sampleProject();
  const history = new ProjectHistory(project);
  const placed = placeStems(project, new Map(), vocalsClip(project), STEMS, ids(), ["other", "vocals"]);
  if (!placed.ok) throw new Error(placed.error);
  history.execute(placed.commands, SEPARATE_LABEL);

  const tracks = history.project.tracks;
  expect(tracks.map((track) => track.name)).toEqual(["Keys", "Bass", "Vocals", "take1 – Vocals", "take1 – Other", "Drums"]);
  expect(placed.trackIds).toEqual([tracks[3]!.id, tracks[4]!.id]);
  expect([...placed.samples.keys()]).toEqual(["audio/take1 – Vocals.wav", "audio/take1 – Other.wav"]);
  expect(tracks[2]!.clips).toEqual([]);
});

test("an imported file's Stems go on four new Tracks at the end of the list, from the playhead, as long as the file", () => {
  const project = sampleProject();
  const history = new ProjectHistory(project);

  const placed = placeImportedStems(project, new Map(), { name: "Song Mix.flac", duration: 12.5 }, STEMS, 480, ids());
  if (!placed.ok) throw new Error(placed.error);
  expect(history.execute(placed.commands, IMPORT_LABEL).ok).toBe(true);

  const tracks = history.project.tracks;
  expect(tracks.map((track) => track.name)).toEqual([
    ...project.tracks.map((track) => track.name),
    "Song Mix – Vocals",
    "Song Mix – Drums",
    "Song Mix – Bass",
    "Song Mix – Other",
  ]);
  expect(placed.trackIds).toEqual(tracks.slice(-4).map((track) => track.id));
  // Nothing else changed: the Tracks there already are as they were.
  expect(tracks.slice(0, -4)).toEqual(project.tracks);
  const paths = ["Vocals", "Drums", "Bass", "Other"].map((stem) => `audio/Song Mix – ${stem}.wav`);
  tracks.slice(-4).forEach((track, at) => {
    expect(track.kind).toBe("audio");
    expect(track.clips).toEqual([
      expect.objectContaining({ kind: "audio", start: 480, duration: 12.5, fileOffset: 0, file: paths[at] }),
    ]);
  });
  // Only the Stems' audio joins the Project.
  expect([...placed.samples.keys()]).toEqual(paths);

  history.undo();
  expect(history.project).toEqual(project);
});

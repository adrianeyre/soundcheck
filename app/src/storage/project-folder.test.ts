import { expect, test } from "vitest";

import { EngineSync } from "../project/engine-sync";
import { sampleProject } from "../project/fixtures";
import { createDrumTrack, createProject, type DrumPad, type Project, SCHEMA_VERSION } from "../project/model";
import { serialiseProject } from "../project/serialise";
import { FakeFileStorage, fakeFolder } from "./fake-file-storage";
import {
  audioFiles,
  AUDIO_FOLDER,
  audioPathFor,
  DATA_FILE,
  nameAudioByContent,
  openProject,
  padSamples,
  saveProject,
} from "./project-folder";

const TAKE = `${AUDIO_FOLDER}/take1.wav`;
/** A WAV as the musician's file left it: bytes, not text. */
const KICK = [82, 73, 70, 70, 0, 255, 128, 64];
const CLAP = [82, 73, 70, 70, 9, 8, 7, 6];

/** What opening a folder with the take in it reads back into memory. */
const TAKE_LOADED = new Map([[TAKE, { name: "take1.wav", bytes: [...new TextEncoder().encode("RIFF take 1")] }]]);

/** A folder holding a Project's audio, as an import would have left it. */
function storageWithAudio() {
  const storage = new FakeFileStorage();
  storage.add("/songs/first", TAKE, "RIFF take 1");
  return storage;
}

/** A Project of one Drum Track, with `samples` on the pads named. */
function drumProject(samples: Record<number, string> = {}): Project {
  const project = createProject("Beat");
  project.tracks.push(createDrumTrack("Drums", "drums"));
  for (const [pad, sample] of Object.entries(samples)) padsOf(project)[Number(pad)]!.sample = sample;
  return project;
}

function padsOf(project: Project): DrumPad[] {
  const track = project.tracks[0];
  if (track?.kind !== "instrument" || track.instrument.type !== "drumSampler") throw new Error("no pads");
  return track.instrument.pads;
}

test("the audio a Project names is every Audio Clip's file and every loaded pad", () => {
  const project = sampleProject();
  expect(audioFiles(project)).toEqual([TAKE]);

  // Two pads playing the same file name it once, and an Audio Clip's file
  // is audio the Project uses but not a sample on any pad.
  const drums = drumProject({ 0: `${AUDIO_FOLDER}/kick.wav`, 2: `${AUDIO_FOLDER}/kick.wav` });
  expect(audioFiles(drums)).toEqual([`${AUDIO_FOLDER}/kick.wav`]);
  expect(padSamples(drums)).toEqual([`${AUDIO_FOLDER}/kick.wav`]);
  expect(padSamples(sampleProject())).toEqual([]);
});

test("a sample goes under its own name in audio/, and a name already taken gets a number", () => {
  expect(audioPathFor("kick.wav", [])).toBe(`${AUDIO_FOLDER}/kick.wav`);
  // Two pads given different files both called kick.wav keep both copies.
  const taken = [`${AUDIO_FOLDER}/kick.wav`];
  expect(audioPathFor("kick.wav", taken)).toBe(`${AUDIO_FOLDER}/kick-2.wav`);
  expect(audioPathFor("kick.wav", [...taken, `${AUDIO_FOLDER}/kick-2.wav`])).toBe(`${AUDIO_FOLDER}/kick-3.wav`);
  // Only the file's own name goes in the folder, whatever it was called
  // where the musician found it, so nothing can lead out of `audio/`.
  expect(audioPathFor("C:/loops/kick.wav", [])).toBe(`${AUDIO_FOLDER}/kick.wav`);
  expect(audioPathFor("C:\\loops\\kick.wav", [])).toBe(`${AUDIO_FOLDER}/kick.wav`);
  expect(audioPathFor("../../kick.wav", [])).toBe(`${AUDIO_FOLDER}/kick.wav`);
  expect(audioPathFor("what?.wav", [])).toBe(`${AUDIO_FOLDER}/what .wav`);
  expect(audioPathFor("", [])).toBe(`${AUDIO_FOLDER}/sample.wav`);
});

test("in a Shared Project, two different files of one name get names of their own from what they hold", () => {
  nameAudioByContent(true);
  try {
    const kick = audioPathFor("kick.wav", [], KICK);
    const other = audioPathFor("kick.wav", [], [...KICK, 1]);
    expect(kick).toMatch(/^audio\/kick-[0-9a-f]{12}\.wav$/);
    expect(other).toMatch(/^audio\/kick-[0-9a-f]{12}\.wav$/);
    expect(other).not.toBe(kick);
    // The same file gets the same name on every copy.
    expect(audioPathFor("kick.wav", [], [...KICK])).toBe(kick);
  } finally {
    nameAudioByContent(false);
  }
  expect(audioPathFor("kick.wav", [], KICK)).toBe(`${AUDIO_FOLDER}/kick.wav`);
});

test("a Project saved, closed and opened again is exactly the Project that was saved", async () => {
  const storage = storageWithAudio();
  const folder = fakeFolder("/songs/first");
  const project = sampleProject();

  expect(await saveProject(storage, project, folder)).toEqual({ ok: true, missingAudio: [] });
  expect(storage.files(folder.id)).toEqual([TAKE, DATA_FILE]);

  const opened = await openProject(storage, folder);
  expect(opened).toEqual({ ok: true, project, missingAudio: [], samples: TAKE_LOADED });
  // Deep-equal, and a Project in its own right rather than the same object.
  expect(opened.ok && opened.project).not.toBe(project);
});

test("saving somewhere else brings the audio with it, so the new folder is whole", async () => {
  const storage = storageWithAudio();
  const first = fakeFolder("/songs/first");
  const project = sampleProject();
  await saveProject(storage, project, first);

  const second = fakeFolder("/elsewhere/second");
  expect(await saveProject(storage, project, second, first)).toEqual({ ok: true, missingAudio: [] });
  expect(storage.files(second.id)).toEqual([TAKE, DATA_FILE]);
  expect(await openProject(storage, second)).toEqual({ ok: true, project, missingAudio: [], samples: TAKE_LOADED });
});

test("a Project folder moved or copied elsewhere opens with all its audio", async () => {
  const storage = storageWithAudio();
  const first = fakeFolder("/songs/first");
  const project = sampleProject();
  await saveProject(storage, project, first);

  // As a file manager, a USB stick or another machine would leave it.
  const moved = storage.copyFolder(first.id, "D:/backup/first");
  storage.folders.delete(first.id);

  const opened = await openProject(storage, moved);
  expect(opened).toEqual({ ok: true, project, missingAudio: [], samples: TAKE_LOADED });
  expect(storage.files(moved.id)).toContain(TAKE);
});

test("a file imported onto an Audio Track is saved into audio/, and plays after the original has gone", async () => {
  const storage = new FakeFileStorage();
  const folder = fakeFolder("/songs/vocals");
  const project = sampleProject();
  // Imported from the musician's own file, which is held in memory from then
  // on: the Project never reads the original again, so deleting it is fine.
  const imported = new Map([[TAKE, { name: "take1.wav", bytes: KICK }]]);

  expect(await saveProject(storage, project, folder, null, imported)).toEqual({ ok: true, missingAudio: [] });
  expect([...(await storage.readBytes(folder, TAKE))]).toEqual(KICK);

  const opened = await openProject(storage, folder);
  expect(opened).toEqual({ ok: true, project, missingAudio: [], samples: imported });
  expect(opened.ok && new EngineSync().update(opened.project, opened.samples)).toContainEqual({
    type: "loadAudioFile",
    file: 1,
    bytes: KICK,
  });
});

test("a WAV loaded onto a pad is saved into audio/, and opens back onto that pad", async () => {
  const storage = new FakeFileStorage();
  const folder = fakeFolder("/songs/beat");
  const project = drumProject({ 0: `${AUDIO_FOLDER}/kick.wav` });
  const loaded = new Map([[`${AUDIO_FOLDER}/kick.wav`, { name: "kick.wav", bytes: KICK }]]);

  expect(await saveProject(storage, project, folder, null, loaded)).toEqual({ ok: true, missingAudio: [] });
  expect(storage.files(folder.id)).toEqual([`${AUDIO_FOLDER}/kick.wav`, DATA_FILE]);
  expect([...(await storage.readBytes(folder, `${AUDIO_FOLDER}/kick.wav`))]).toEqual(KICK);

  const opened = await openProject(storage, folder);
  expect(opened).toEqual({ ok: true, project, missingAudio: [], samples: loaded });
  // And the pad plays those same bytes: the engine takes bytes, not paths.
  expect(opened.ok && new EngineSync().update(opened.project, opened.samples)).toContainEqual({
    type: "setPadSample",
    track: 0,
    pad: 0,
    wav: KICK,
  });
});

test("two pads' samples called the same thing each keep their own copy", async () => {
  const storage = new FakeFileStorage();
  const folder = fakeFolder("/songs/beat");
  // As loading kick.wav onto one pad and another kick.wav onto the next left it.
  const second = audioPathFor("kick.wav", [`${AUDIO_FOLDER}/kick.wav`]);
  const project = drumProject({ 0: `${AUDIO_FOLDER}/kick.wav`, 1: second });
  const loaded = new Map([
    [`${AUDIO_FOLDER}/kick.wav`, { name: "kick.wav", bytes: KICK }],
    [second, { name: "kick.wav", bytes: CLAP }],
  ]);
  await saveProject(storage, project, folder, null, loaded);

  expect(storage.files(folder.id)).toEqual([`${AUDIO_FOLDER}/kick-2.wav`, `${AUDIO_FOLDER}/kick.wav`, DATA_FILE]);
  const opened = await openProject(storage, folder);
  expect(opened.ok && [...opened.samples].map(([path, sample]) => [path, sample.bytes])).toEqual([
    [second, CLAP],
    [`${AUDIO_FOLDER}/kick.wav`, KICK],
  ]);
});

test("a Project folder copied elsewhere opens with the samples on its pads", async () => {
  const storage = new FakeFileStorage();
  const first = fakeFolder("/songs/beat");
  const project = drumProject({ 0: `${AUDIO_FOLDER}/kick.wav` });
  const loaded = new Map([[`${AUDIO_FOLDER}/kick.wav`, { name: "kick.wav", bytes: KICK }]]);
  await saveProject(storage, project, first, null, loaded);

  // Onto a USB stick and off it again, into a copy of Soundcheck that has loaded
  // nothing: the folder is all there is to go on.
  const copied = storage.copyFolder(first.id, "D:/backup/beat");
  storage.folders.delete(first.id);
  const opened = await openProject(storage, copied);
  expect(opened).toEqual({ ok: true, project, missingAudio: [], samples: loaded });

  // Saving it on from there keeps the samples with it, without the folder it
  // came from being reachable any more.
  const onward = fakeFolder("/songs/copy");
  expect(opened.ok && (await saveProject(storage, opened.project, onward, copied, opened.samples))).toEqual({
    ok: true,
    missingAudio: [],
  });
  expect([...(await storage.readBytes(onward, `${AUDIO_FOLDER}/kick.wav`))]).toEqual(KICK);
});

test("a pad whose sample the folder hasn't got is reported, and the Project still opens", async () => {
  const storage = new FakeFileStorage();
  const folder = fakeFolder("/songs/beat");
  const project = drumProject({ 0: `${AUDIO_FOLDER}/kick.wav` });

  // Nothing loaded and nowhere to copy from: the sample can't be written.
  expect(await saveProject(storage, project, folder)).toEqual({
    ok: true,
    missingAudio: [`${AUDIO_FOLDER}/kick.wav`],
  });
  const opened = await openProject(storage, folder);
  expect(opened).toEqual({
    ok: true,
    project,
    missingAudio: [`${AUDIO_FOLDER}/kick.wav`],
    samples: new Map(),
  });
});

test("audio the folder hasn't got is reported, and the Project still saves", async () => {
  const storage = new FakeFileStorage();
  const folder = fakeFolder("/songs/first");
  const result = await saveProject(storage, sampleProject(), folder);
  expect(result).toEqual({ ok: true, missingAudio: [TAKE] });

  const opened = await openProject(storage, folder);
  expect(opened.ok && opened.missingAudio).toEqual([TAKE]);
});

test("a folder that isn't a Project says so", async () => {
  const storage = new FakeFileStorage();
  const empty = storage.add("/photos", "holiday.jpg", "not a Project");
  const result = await openProject(storage, empty);
  expect(result).toEqual({ ok: false, error: `This folder isn't a Project: it has no ${DATA_FILE}` });
});

test("a Project saved by a newer version of Soundcheck is refused with a reason", async () => {
  const storage = new FakeFileStorage();
  const folder = storage.add(
    "/songs/future",
    DATA_FILE,
    JSON.stringify({ ...sampleProject(), schemaVersion: SCHEMA_VERSION + 1 }),
  );
  const result = await openProject(storage, folder);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error).toMatch(/newer version of Soundcheck/);
});

test("a Project from an older schema is migrated forward, and a damaged one refused", async () => {
  const storage = new FakeFileStorage();
  // Schema 0 predates the Project model, so there is nothing to migrate from.
  const old = storage.add("/songs/old", DATA_FILE, JSON.stringify({ ...sampleProject(), schemaVersion: 0 }));
  expect(!(await openProject(storage, old)).ok).toBe(true);

  const damaged = storage.add("/songs/damaged", DATA_FILE, '{"schemaVersion":1,"name":"Half a song"}');
  const result = await openProject(storage, damaged);
  expect(!result.ok && result.error).toMatch(/damaged/);
});

test("the Claude API key can be neither written into a Project folder nor read from one", async () => {
  const storage = new FakeFileStorage();
  const folder = fakeFolder("/songs/keys");
  const project = sampleProject();
  await saveProject(storage, project, folder);

  // Only the Project's own data is written, and nothing in it is a secret.
  expect(storage.files(folder.id)).toEqual([DATA_FILE]);
  const written = await storage.readText(folder, DATA_FILE);
  expect(Object.keys(JSON.parse(written)).toSorted()).toEqual(
    ["buses", "master", "name", "referenceTrack", "schemaVersion", "sections", "tempo", "tempoChanges", "timeSignature", "tracks"],
  );
  expect(written).not.toMatch(/sk-ant-/);

  // And a folder that has had one added to it by hand is refused, so a key
  // can never ride back in either.
  await storage.writeText(
    folder,
    DATA_FILE,
    serialiseProject({ ...project, apiKey: "sk-ant-secret" } as unknown as typeof project),
  );
  const result = await openProject(storage, folder);
  expect(!result.ok && result.error).toMatch(/unknown fields: apiKey/);
});

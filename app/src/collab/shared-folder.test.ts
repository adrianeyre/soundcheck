import { expect, test } from "vitest";

import type { Command } from "../project/commands";
import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import { sampleProject } from "../project/fixtures";
import { ProjectHistory } from "../project/history";
import { createAudioTrack } from "../project/model";
import { FakeFileStorage, fakeFolder } from "../storage/fake-file-storage";
import type { ProjectFolder } from "../storage/file-storage";
import { saveProject } from "../storage/project-folder";
import { changeLine, changesFile, FolderSync, isShared, openFolder, parseChanges, shareFolder } from "./shared-folder";

/** A WAV as far as its length goes: the RIFF header says how long the file is. */
function wav(length: number): number[] {
  const bytes = new Uint8Array(length);
  bytes.set([..."RIFF"].map((letter) => letter.charCodeAt(0)));
  new DataView(bytes.buffer).setUint32(4, length - 8, true);
  bytes.set([..."WAVE"].map((letter) => letter.charCodeAt(0)), 8);
  return [...bytes];
}

/** One person's copy of a Shared Project: their history, the audio they have loaded, and the sync between them and the folder. */
interface Person {
  history: ProjectHistory;
  samples: LoadedSamples;
  sync: FolderSync;
  trouble: (string | null)[];
}

function follow(
  storage: FakeFileStorage,
  folder: ProjectFolder,
  history: ProjectHistory,
  samples: LoadedSamples = new Map(),
  written?: number,
): Person {
  const person: Person = { history, samples, sync: undefined as unknown as FolderSync, trouble: [] };
  person.sync = new FolderSync(storage, folder, history, {
    samples: () => person.samples,
    onAudio: (added) => {
      person.samples = new Map([...person.samples, ...added]);
    },
    onTrouble: (message) => person.trouble.push(message),
    written,
  });
  return person;
}

/** Alice shares a Project into `shared`; Bob opens it there. */
async function aliceAndBob(storage = new FakeFileStorage()) {
  const folder = fakeFolder("shared");
  const history = new ProjectHistory(sampleProject(), { copy: "alice", by: "Alice" });
  await shareFolder(storage, folder, history, (base) => saveProject(storage, base, folder));
  const opened = await openFolder(storage, folder, { copy: "bob", by: "Bob" });
  if (!opened.ok) throw new Error(opened.error);
  return {
    storage,
    folder,
    alice: follow(storage, folder, history, new Map(), 0),
    bob: follow(storage, folder, opened.history, opened.samples),
  };
}

function run(person: Person, commands: Command | Command[]) {
  const result = person.history.execute(commands);
  if (!result.ok) throw new Error(result.error);
}

test("sharing a Project leaves its base and an empty file of this copy's Changes, which is what says it is shared", async () => {
  const { storage, folder } = await aliceAndBob();
  expect(storage.files(folder.id)).toEqual(["changes/alice.jsonl", "project.json"]);
  expect(await isShared(storage, folder)).toBe(true);
  expect(await isShared(storage, fakeFolder("plain"))).toBe(false);
});

test("each person's Changes reach the other through the folder, and both end with the same Project", async () => {
  const { storage, folder, alice, bob } = await aliceAndBob();
  run(alice, { type: "setTempo", tempo: 90 });
  run(bob, { type: "renameTrack", trackId: "keys", name: "Piano" });
  await alice.sync.poll();
  await bob.sync.poll();
  await alice.sync.poll();

  expect(alice.history.project).toEqual(bob.history.project);
  expect(bob.history.project.tempo).toBe(90);
  expect(alice.history.project.tracks[0]!.name).toBe("Piano");
  // Each only ever wrote its own file.
  expect(storage.files(folder.id)).toEqual(["changes/alice.jsonl", "changes/bob.jsonl", "project.json"]);
  expect(parseChanges(await storage.readText(folder, changesFile("bob"))).map((change) => change.id)).toEqual(["bob:1"]);
  // And undo is still of your own.
  alice.history.undo();
  await alice.sync.poll();
  await bob.sync.poll();
  expect(bob.history.project.tempo).toBe(120);
  expect(bob.history.project.tracks[0]!.name).toBe("Piano");
});

test("days apart: whatever each did offline comes together when the folder syncs, in whichever order", async () => {
  const { storage, folder, alice, bob } = await aliceAndBob();
  run(alice, { type: "setTempo", tempo: 90 });
  run(alice, { type: "renameTrack", trackId: "bass", name: "Sub" });
  await alice.sync.poll();
  // Bob's copy of the folder hadn't synced: his file reaches Alice later.
  await bob.sync.stop();
  const bobsCopy = storage.copyFolder(folder.id, "bob-offline");
  const bobOffline = follow(storage, bobsCopy, bob.history, bob.samples);
  storage.folders.get("bob-offline")!.delete(changesFile("alice"));
  run(bobOffline, { type: "renameTrack", trackId: "keys", name: "Piano" });
  run(bobOffline, { type: "setTempo", tempo: 100 });
  await bobOffline.sync.poll();

  // The sync service carries each file across.
  storage.add(folder.id, changesFile("bob"), await storage.readText(bobsCopy, changesFile("bob")));
  storage.add(bobsCopy.id, changesFile("alice"), await storage.readText(folder, changesFile("alice")));
  await alice.sync.poll();
  await bobOffline.sync.poll();
  expect(alice.history.project).toEqual(bob.history.project);
  expect(alice.history.project.tracks.map((track) => track.name)).toEqual(
    expect.arrayContaining(["Piano", "Sub"]),
  );
});

test("a Shared Project opened again is its base and every Change, and this copy goes on from its own last one", async () => {
  const { storage, folder, alice, bob } = await aliceAndBob();
  run(alice, { type: "setTempo", tempo: 90 });
  run(bob, { type: "renameTrack", trackId: "keys", name: "Piano" });
  await alice.sync.poll();
  await bob.sync.poll();

  const again = await openFolder(storage, folder, { copy: "alice", by: "Alice" });
  if (!again.ok) throw new Error(again.error);
  expect(again.history.project).toEqual(bob.history.project);
  expect(again.shared?.get(changesFile("bob"))).toBeGreaterThan(0);
  again.history.execute({ type: "setTempo", tempo: 95 });
  expect(again.history.log.at(-1)?.id).toBe("alice:2");
});

test("audio a Change names is written into the folder with it, and read by a Collaborator once all of it is there", async () => {
  const { storage, folder, alice, bob } = await aliceAndBob();
  const take = wav(64);
  alice.samples = new Map([["audio/take-1.wav", { name: "take-1.wav", bytes: take }]]);
  const vocal = createAudioTrack("Take", "take");
  vocal.clips.push({ id: "take-clip", kind: "audio", start: 0, duration: 1, file: "audio/take-1.wav", fileOffset: 0 });
  run(alice, { type: "addTrack", track: vocal });
  await alice.sync.poll();
  expect(storage.files(folder.id)).toContain("audio/take-1.wav");

  // Bob's sync service has only half of it so far.
  storage.add(folder.id, "audio/take-1.wav", Uint8Array.from(take.slice(0, 32)));
  await bob.sync.poll();
  expect(bob.history.project.tracks.some((track) => track.id === "take")).toBe(true);
  expect(bob.samples.has("audio/take-1.wav")).toBe(false);

  storage.add(folder.id, "audio/take-1.wav", Uint8Array.from(take));
  await bob.sync.poll();
  expect(bob.samples.get("audio/take-1.wav")).toEqual<LoadedSample>({ name: "take-1.wav", bytes: take });
});

test("a line still being synced waits, and a damaged one is skipped", async () => {
  const { storage, folder, alice } = await aliceAndBob();
  // Bob's Changes, as his file holds them while it is still arriving.
  const bob = new ProjectHistory(alice.history.project, { copy: "bob" });
  bob.execute({ type: "setTempo", tempo: 90 });
  bob.execute({ type: "renameTrack", trackId: "keys", name: "Piano" });
  const [first, second] = bob.log.map(changeLine);
  storage.add(folder.id, changesFile("bob"), `${first}not a Change\n${second!.slice(0, 20)}`);
  await alice.sync.poll();
  expect(alice.history.project.tempo).toBe(90);
  expect(alice.history.project.tracks[0]!.name).toBe("Keys");

  storage.add(folder.id, changesFile("bob"), `${first}not a Change\n${second}`);
  await alice.sync.poll();
  expect(alice.history.project.tracks[0]!.name).toBe("Piano");
});

test("a write that fails is said, tried again, and leaves every line whole", async () => {
  const storage = new FakeFileStorage();
  const { folder, alice, bob } = await aliceAndBob(storage);
  const append = storage.appendText.bind(storage);
  // The write as the Change is made fails, and so does the next poll's.
  let failures = 2;
  storage.appendText = async (at, path, text) => {
    if (failures-- > 0) {
      // Half of it reached the disk before it failed.
      await append(at, path, text.slice(0, 15));
      throw new Error("The disk is full");
    }
    await append(at, path, text);
  };
  run(alice, { type: "setTempo", tempo: 90 });
  await alice.sync.poll();
  expect(alice.trouble).toEqual(["The disk is full"]);

  await alice.sync.poll();
  expect(alice.trouble).toEqual(["The disk is full", null]);
  await bob.sync.poll();
  expect(bob.history.project.tempo).toBe(90);
  expect(parseChanges(await storage.readText(folder, changesFile("alice")))).toHaveLength(1);
});

test("a Change made while the Project is being shared is the first its file holds", async () => {
  const storage = new FakeFileStorage();
  const folder = fakeFolder("shared");
  const history = new ProjectHistory(sampleProject(), { copy: "alice" });
  history.execute({ type: "setTempo", tempo: 100 });
  await shareFolder(storage, folder, history, async (base) => {
    await saveProject(storage, base, folder);
    // Alice goes on editing while the base is written.
    history.execute({ type: "setTempo", tempo: 90 });
  });
  const alice = follow(storage, folder, history, new Map(), 0);
  await alice.sync.poll();

  const bob = await openFolder(storage, folder, { copy: "bob" });
  expect(bob.ok && bob.history.project.tempo).toBe(90);
  expect(parseChanges(await storage.readText(folder, changesFile("alice"))).map((change) => change.id)).toEqual(["alice:2"]);
});

test("stopping writes what is still waiting, and nothing after", async () => {
  const { storage, folder, alice } = await aliceAndBob();
  run(alice, { type: "setTempo", tempo: 90 });
  await alice.sync.stop();
  run(alice, { type: "setTempo", tempo: 80 });
  await alice.sync.poll();
  expect(parseChanges(await storage.readText(folder, changesFile("alice")))).toHaveLength(1);
});

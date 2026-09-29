import { readFileSync } from "node:fs";

import { initSync } from "@engine";
import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, test } from "vitest";

import type { Invoke } from "../audio/desktop-audio-output";
import { renderMix } from "../export/browser-mix-exporter";
import { exportRequest } from "../export/mix-exporter";
import { browserLibraryStorage } from "../preset/browser-library-storage";
import { desktopLibraryStorage } from "../preset/desktop-library-storage";
import { filesUnder, type LibraryStorage, memoryLibraryStorage } from "../preset/library-storage";
import { applyCommand } from "../project/commands";
import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import { createDrumTrack, createProject, type DrumPad, type Project, STARTER_KIT_PRESET } from "../project/model";
import { TICKS_PER_BEAT } from "../project/time";
import { stereoWav } from "../song/test-wav";
import { FakeFileStorage, fakeFolder } from "../storage/fake-file-storage";
import { audioFiles, openProject, saveProject } from "../storage/project-folder";
import { BUNDLED_KIT, KitLibrary, KitRefused, loadKitCommand } from "./kit-library";

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

/** The desktop's library as the Tauri shell keeps it, stood in for by a map behind the same commands. */
function desktopStorage(): LibraryStorage {
  const files = new Map<string, string | number[]>();
  const invoke = (async (command: string, args: Record<string, unknown> = {}) => {
    const path = args.path as string;
    const read = () => {
      if (!files.has(path)) throw new Error(`${path} could not be read`);
      return files.get(path);
    };
    if (command === "library_list_files") return filesUnder(files.keys(), path);
    if (command === "library_read_text" || command === "library_read_bytes") return read();
    if (command === "library_write_text") return void files.set(path, args.text as string);
    if (command === "library_write_bytes") return void files.set(path, args.bytes as number[]);
    if (command === "library_delete_file") return void files.delete(path);
    throw new Error(`no command ${command}`);
  }) as Invoke;
  return desktopLibraryStorage(invoke);
}

const STORAGES: [string, () => LibraryStorage][] = [
  ["desktop", desktopStorage],
  ["browser dev host", () => browserLibraryStorage(new IDBFactory())],
  ["memory", () => memoryLibraryStorage()],
];

/** A short burst of noise-free tone, as a WAV the musician might load onto a pad. */
function toneWav(hz: number): number[] {
  const tone = Array.from({ length: 4_800 }, (_, at) => 0.5 * Math.sin((2 * Math.PI * hz * at) / 48_000));
  return stereoWav(tone, tone, 48_000);
}

const KICK: LoadedSample = { name: "kick.wav", bytes: toneWav(60) };
const SNARE: LoadedSample = { name: "snare.wav", bytes: toneWav(220) };

/** A Project with one Drum Track, `drums`, playing each of its first four pads once a beat. */
function drumSong(name: string): Project {
  const project = createProject(name);
  const track = createDrumTrack("Drums", "drums");
  const notes = [36, 38, 39, 42].map((pitch, beat) => ({
    pitch,
    start: beat * TICKS_PER_BEAT,
    length: TICKS_PER_BEAT / 2,
    velocity: 1,
  }));
  track.clips = [{ id: "beat", kind: "pattern", start: 0, length: 4 * TICKS_PER_BEAT, notes }];
  project.tracks = [track];
  return project;
}

function padsOf(project: Project): DrumPad[] {
  const track = project.tracks[0];
  if (track?.kind !== "instrument" || track.instrument.type !== "drumSampler") throw new Error("no pads");
  return track.instrument.pads;
}

/** The first Project's kit: its own kick on two pads, a snare, and tweaks to the others. */
function tweakedSong(): { project: Project; samples: LoadedSamples } {
  const project = drumSong("First");
  const pads = padsOf(project);
  Object.assign(pads[0]!, { sample: "audio/kick.wav", volume: 0.8 });
  Object.assign(pads[1]!, { sample: "audio/snare.wav", pitch: 3, pan: -0.5 });
  Object.assign(pads[2]!, { sample: "audio/kick.wav", pitch: -5 });
  Object.assign(pads[3]!, { volume: 0.3, chokeGroup: 2 });
  const samples = new Map([
    ["audio/kick.wav", KICK],
    ["audio/snare.wav", SNARE],
  ]);
  return { project, samples };
}

async function rendered(project: Project, samples: LoadedSamples): Promise<number[]> {
  const request = exportRequest(project, samples, { startTick: 0, endTick: 4 * TICKS_PER_BEAT }, { sampleRate: 48_000, encoding: { kind: "wav", bits: 32 } });
  const wav = (await renderMix(request, { onProgress: () => {}, signal: new AbortController().signal }))!;
  return [...wav];
}

describe.each(STORAGES)("on the %s", (_, storage) => {
  test("a Kit saved in one Project loads into another and sounds the same", async () => {
    const at = storage();
    const first = tweakedSong();
    await new KitLibrary(at).save("My Kit", padsOf(first.project), first.samples);

    // Another session of the app, with another Project, reads the library afresh.
    const loading = new KitLibrary(at);
    const [kit] = await loading.load();
    expect(kit!.name).toBe("My Kit");
    const second = drumSong("Second");
    // The second Project already has a different file called kick.wav.
    const theirs = new Map([["audio/kick.wav", { name: "kick.wav", bytes: toneWav(440) }]]);
    const loaded = loadKitCommand("drums", kit!, await loading.samples(kit!), theirs, audioFiles(second));
    const result = applyCommand(second, loaded.command);
    if (!result.ok) throw new Error(result.error);
    const samples = new Map([...theirs, ...loaded.samples]);

    // Pad for pad the same, the shared kick copied once, under paths of its own.
    const pads = padsOf(result.project);
    expect(pads.map((pad) => ({ ...pad, sample: null }))).toEqual(padsOf(first.project).map((pad) => ({ ...pad, sample: null })));
    expect(pads.map((pad) => pad.sample)).toEqual([
      "audio/kick-2.wav",
      "audio/snare.wav",
      "audio/kick-2.wav",
      ...Array<null>(padsOf(first.project).length - 3).fill(null),
    ]);
    expect([...loaded.samples.keys()]).toEqual(["audio/kick-2.wav", "audio/snare.wav"]);
    expect(result.project.tracks[0]).toMatchObject({ instrument: { preset: "My Kit" } });

    const heard = await rendered(result.project, samples);
    expect(heard).toEqual(await rendered(first.project, first.samples));
    // And not just because every Drum Sampler sounds alike.
    expect(heard).not.toEqual(await rendered(drumSong("Plain"), new Map()));
  });

  test("a Kit is deleted with its samples, and stays that way", async () => {
    const at = storage();
    const first = tweakedSong();
    const library = new KitLibrary(at);
    await library.save("Gone", padsOf(first.project), first.samples);
    expect(await at.listFiles("kits")).toHaveLength(3);
    await library.delete("Gone");
    expect(library.savedKits).toEqual([]);
    expect(await at.listFiles("kits")).toEqual([]);
    expect(await new KitLibrary(at).load()).toEqual([]);
  });
});

test("the loading Project's folder holds the Kit's samples, and opens with them after it is moved", async () => {
  const library = new KitLibrary(memoryLibraryStorage());
  const first = tweakedSong();
  const kit = await library.save("Travels", padsOf(first.project), first.samples);

  const second = drumSong("Second");
  const loaded = loadKitCommand("drums", kit, await library.samples(kit), new Map(), audioFiles(second));
  const result = applyCommand(second, loaded.command);
  if (!result.ok) throw new Error(result.error);

  const files = new FakeFileStorage();
  const folder = fakeFolder("/songs/second");
  expect(await saveProject(files, result.project, folder, null, loaded.samples)).toEqual({ ok: true, missingAudio: [] });
  expect(files.files(folder.id)).toEqual(expect.arrayContaining(["audio/kick.wav", "audio/snare.wav"]));

  // The Kit is deleted and the folder moved: the Project needs neither the library nor where it was.
  await library.delete("Travels");
  const moved = files.copyFolder(folder.id, "D:/backup/second");
  files.folders.delete(folder.id);
  const opened = await openProject(files, moved);
  if (!opened.ok) throw new Error(opened.error);
  expect(opened.missingAudio).toEqual([]);
  expect(await rendered(opened.project, opened.samples)).toEqual(await rendered(first.project, first.samples));
});

test("a Kit's name must be new, and not the bundled Kit's", async () => {
  const library = new KitLibrary(memoryLibraryStorage());
  const pads = padsOf(drumSong("Any"));
  await library.save("  Mine ", pads, new Map());
  expect(library.savedKits.map((kit) => kit.name)).toEqual(["Mine"]);
  await expect(library.save("mine", pads, new Map())).rejects.toThrow(KitRefused);
  await expect(library.save(STARTER_KIT_PRESET.toUpperCase(), pads, new Map())).rejects.toThrow(/bundled/);
  await expect(library.save(" ", pads, new Map())).rejects.toThrow(/name/);
  await expect(library.delete(STARTER_KIT_PRESET)).rejects.toThrow(/comes with the app/);
});

test("a Kit whose sample isn't loaded is refused, and nothing is written", async () => {
  const at = memoryLibraryStorage();
  const pads = padsOf(drumSong("Any")).map((pad, index) => (index === 0 ? { ...pad, sample: "audio/lost.wav" } : pad));
  await expect(new KitLibrary(at).save("Lost", pads, new Map())).rejects.toThrow(/lost\.wav, is missing/);
  expect(await at.listFiles("")).toEqual([]);
});

test("the bundled Starter Kit loads back over a saved one", () => {
  const first = tweakedSong();
  const loaded = loadKitCommand("drums", BUNDLED_KIT, new Map(), first.samples, audioFiles(first.project));
  const result = applyCommand(first.project, loaded.command);
  if (!result.ok) throw new Error(result.error);
  expect(result.project.tracks[0]).toMatchObject({ instrument: { preset: STARTER_KIT_PRESET } });
  expect(padsOf(result.project)).toEqual(padsOf(drumSong("Plain")));
  expect(loaded.samples.size).toBe(0);
});

test("a damaged Kit, or one missing a sample, is left out of the library rather than breaking it", async () => {
  const at = memoryLibraryStorage();
  const library = new KitLibrary(at);
  const first = tweakedSong();
  await library.save("Good", padsOf(first.project), first.samples);
  const broken = await library.save("Broken", padsOf(first.project), first.samples);
  await at.deleteFile(`kits/${broken.id}/audio/snare.wav`);
  await at.writeText("kits/junk/kit.json", "{ not json");
  await at.writeText("kits/bad/kit.json", JSON.stringify({ version: 1, name: "Bad", pads: [] }));
  await at.writeText(
    "kits/escape/kit.json",
    JSON.stringify({ version: 1, name: "Escape", pads: padsOf(drumSong("x")).map((pad) => ({ ...pad, sample: "../../secret.wav" })) }),
  );
  expect((await new KitLibrary(at).load()).map((kit) => kit.name)).toEqual(["Good"]);
});

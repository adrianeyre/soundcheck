/**
 * The sounds stories of the v3 PRD that reach the app's library, as the
 * tool calls a model would make for them, through the in-memory library:
 * a Synth sound saved as a User Preset in one Project loads in another; a
 * saved Kit loads onto a Drum Sampler, samples and all, and one undo takes
 * it back out of the Project; a Drum Sampler's Pads save as a Kit with
 * their samples; and a name the library already has is refused rather
 * than saved over. Saving is outside the Project, so undo leaves it.
 */
import { expect, test } from "vitest";

import { KitLibrary } from "../kit/kit-library";
import { memoryLibraryStorage, type LibraryStorage } from "../preset/library-storage";
import { PresetLibrary } from "../preset/preset-library";
import type { LoadedSample, LoadedSamples } from "../project/engine-sync";
import { ProjectHistory } from "../project/history";
import {
  createBus,
  createDrumTrack,
  createEffect,
  createInstrumentTrack,
  createProject,
  DEFAULT_SYNTH,
  type Instrument,
  type Project,
  STARTER_KIT,
} from "../project/model";
import { stereoWav } from "../song/test-wav";
import { runRequest, type Conversation, type ModelReply, type StartConversation, type ToolResult } from "./assistant";
import { requestMessage } from "./context";
import { assistantLibrary, type AssistantLibrary } from "./library";
import type { ToolCall } from "./tools";

/**
 * Each turn of the script sees the results of the one before; the first
 * message of the Request, as the model would read it, is kept in `sent`.
 */
function scripted(...turns: ((results: readonly ToolResult[]) => ModelReply)[]) {
  const sent: string[] = [];
  const start: StartConversation = (request, project, library) => {
    sent.push(requestMessage(request, project, library));
    let turn = 0;
    const conversation: Conversation = {
      next(results) {
        const reply = turns[turn++];
        if (!reply) throw new Error("the Assistant asked for more turns than the script has");
        return Promise.resolve(reply(results));
      },
    };
    return conversation;
  };
  return { start, sent };
}

function call(id: string, name: string, input: unknown): ToolCall {
  return { id, name, input };
}

function succeeded(results: readonly ToolResult[]): void {
  const failed = results.filter((result) => result.isError);
  if (failed.length > 0) throw new Error(`a call failed: ${failed.map((result) => result.content).join(" ")}`);
}

const loadSounds = () => ({ text: "", toolCalls: [call("g1", "load_tools", { group: "sounds" })] });
const says = (text: string) => () => ({ text, toolCalls: [] });

/**
 * The library as the app has it on start-up: read from `storage`, which
 * outlives every Project, with `audio` as the Project's loaded samples.
 */
async function openLibrary(storage: LibraryStorage, audio = new Map<string, LoadedSample>()): Promise<AssistantLibrary> {
  const presets = new PresetLibrary(storage);
  const kits = new KitLibrary(storage);
  await Promise.all([presets.load(), kits.load()]);
  return assistantLibrary(presets, kits, {
    samples: () => audio,
    add: (added) => {
      for (const [path, sample] of added) audio.set(path, sample);
    },
  });
}

function instrumentOf(project: Project, trackId: string): Instrument {
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (track?.kind !== "instrument") throw new Error(`no Instrument Track ${trackId}`);
  return track.instrument;
}

/** A short tone, as a WAV the musician might load onto a pad. */
function toneWav(hz: number): number[] {
  const tone = Array.from({ length: 4_800 }, (_, at) => 0.5 * Math.sin((2 * Math.PI * hz * at) / 48_000));
  return stereoWav(tone, tone, 48_000);
}

const KICK: LoadedSample = { name: "808 kick.wav", bytes: toneWav(50) };

/** The Starter Kit, with the Kick playing `KICK` from the Project's `audio/`. */
function eightOhEightPads() {
  return STARTER_KIT.map((pad) => (pad.note === 36 ? { ...pad, name: "808 Kick", sample: "audio/808 kick.wav" } : { ...pad }));
}

/** A library with the Kit “808” saved in it, from another Project whose Kick played `KICK`. */
async function libraryWith808(): Promise<LibraryStorage> {
  const storage = memoryLibraryStorage();
  const loaded: LoadedSamples = new Map([["audio/808 kick.wav", KICK]]);
  await new KitLibrary(storage).save("808", eightOhEightPads(), loaded);
  return storage;
}

/**
 * “Warm Pad” is also a Factory Preset's name, which the library won't let a
 * User Preset take (#50): the model is told, saves it under a name of its
 * own, and says so, and the next Request finds it by that name.
 */
test("“save this synth sound as Warm Pad” saves a User Preset that a new Track in another Project loads", async () => {
  const storage = memoryLibraryStorage();
  const warm = { ...DEFAULT_SYNTH, cutoffHz: 900, attack: 0.4, release: 1.2 };
  const first = createProject("First song");
  const pad = createInstrumentTrack("Pad", "pad");
  pad.instrument = { type: "synth", preset: null, settings: warm };
  first.tracks.push(pad);
  const history = new ProjectHistory(first);

  const saving = scripted(
    loadSounds,
    (results) => {
      succeeded(results);
      return { text: "", toolCalls: [call("s1", "save_preset", { source: "pad", name: "Warm Pad" })] };
    },
    (results) => {
      expect(results[0]).toMatchObject({
        isError: true,
        content: "“Warm Pad” is a Factory Preset's name, and Factory Presets can't be changed. Nothing was saved.",
      });
      return { text: "", toolCalls: [call("s2", "save_preset", { source: "pad", name: "My Warm Pad" })] };
    },
    (results) => {
      succeeded(results);
      expect(results[0]!.content).toMatch(/undoing this Request doesn't remove it/);
      return says("Warm Pad is a factory preset, so I saved your sound as My Warm Pad.")();
    },
  );
  const saved = await runRequest({
    history,
    request: "save this synth sound as Warm Pad",
    start: saving.start,
    library: await openLibrary(storage),
  });

  expect(saved.error).toBeNull();
  // The musician is told that undo won't take it back out of the library.
  expect(saved.changes).toEqual([
    "Saved the settings of the Synth on “Pad” as the User Preset “My Warm Pad” in the library, outside the Project, which undo leaves as it is",
  ]);
  // Saving changed nothing in the Project, so the Request left no undo step, and the Project is as it was.
  expect(history.canUndo).toBe(false);
  expect(history.project).toEqual(first);

  // A new Project, after the app has started again: only the library's files carry the Preset over.
  const second = new ProjectHistory(createProject("Second song"));
  const using = scripted(
    () => ({
      text: "",
      toolCalls: [call("t1", "create_track", { name: "Pad", kind: "instrument" }), call("g1", "load_tools", { group: "sounds" })],
    }),
    (results) => {
      succeeded(results);
      const trackId = /trackId is ([^.\s]+)\./.exec(results[0]!.content)![1]!;
      return { text: "", toolCalls: [call("i1", "set_instrument", { trackId, instrument: "synth", preset: "my warm pad" })] };
    },
    (results) => {
      succeeded(results);
      return says("The new Pad track plays My Warm Pad.")();
    },
  );
  const used = await runRequest({
    history: second,
    request: "use Warm Pad on a new track",
    start: using.start,
    library: await openLibrary(storage),
  });

  expect(used.error).toBeNull();
  expect(using.sent[0]).toContain('The musician\'s User Presets, which load_preset loads by name:\n[{"name":"My Warm Pad","for":"synth"}]');
  const track = second.project.tracks[0]!;
  expect(instrumentOf(second.project, track.id)).toEqual({ type: "synth", preset: "My Warm Pad", settings: warm });
  expect(used.changes).toEqual(["Added the Instrument Track “Pad”", "“Pad” plays the Synth with its “My Warm Pad” User Preset"]);
  second.undo();
  expect(second.project.tracks).toEqual([]);
});

test("an Effect's settings save as a User Preset that the rest of the Request can load, and undo leaves it saved", async () => {
  const storage = memoryLibraryStorage();
  const project = createProject("Room");
  const bus = createBus("Verb", "verb");
  const reverb = createEffect("reverb", "big-room");
  reverb.settings = { ...reverb.settings, size: 0.9, decay: 4.5 };
  bus.insertChain.push(reverb);
  project.buses.push(bus);
  const history = new ProjectHistory(project);

  const { start } = scripted(
    loadSounds,
    (results) => {
      succeeded(results);
      return {
        text: "",
        toolCalls: [
          call("s1", "save_preset", { source: "big-room", name: "Big Room" }),
          call("e1", "add_effect", { channel: "master", effect: "reverb", preset: "Big Room" }),
        ],
      };
    },
    (results) => {
      succeeded(results);
      return says("Saved the Big Room reverb and put it on the Master.")();
    },
  );
  const outcome = await runRequest({ history, request: "save the verb as Big Room and use it on the master", start, library: await openLibrary(storage) });

  expect(outcome.error).toBeNull();
  expect(history.project.master.insertChain.at(-1)!.settings).toEqual(reverb.settings);
  history.undo();
  expect(history.project).toEqual(project);
  const kept = await new PresetLibrary(storage).load();
  expect(kept).toMatchObject([{ name: "Big Room", target: "reverb", settings: reverb.settings }]);
});

test("“use my 808 kit” loads the saved Kit, its samples copied into the Project, and one undo takes it out", async () => {
  const storage = await libraryWith808();
  const project = createProject("Beat");
  project.tracks.push(createDrumTrack("Drums", "drums"));
  const history = new ProjectHistory(project);
  const audio = new Map<string, LoadedSample>();

  const { start, sent } = scripted(
    loadSounds,
    (results) => {
      succeeded(results);
      return { text: "", toolCalls: [call("i1", "set_instrument", { trackId: "drums", instrument: "drumSampler", preset: "808" })] };
    },
    (results) => {
      succeeded(results);
      expect(results[0]!.content).toContain("808 Kick 36");
      return says("The drums play your 808 kit.")();
    },
  );
  const outcome = await runRequest({ history, request: "use my 808 kit", start, library: await openLibrary(storage, audio) });

  expect(outcome.error).toBeNull();
  expect(sent[0]).toContain('The musician\'s saved Kits, which set_instrument loads onto a Drum Sampler by name:\n[{"name":"808","pads":8}]');
  expect(outcome.changes).toEqual(["“Drums” plays the Drum Sampler with the saved Kit “808”"]);
  const drums = instrumentOf(history.project, "drums");
  expect(drums).toEqual({ type: "drumSampler", preset: "808", pads: eightOhEightPads() });
  // The Kit's sample is the Project's own now, where its Kick names it.
  expect(audio.get("audio/808 kick.wav")?.bytes).toEqual(KICK.bytes);

  history.undo();
  expect(history.project).toEqual(project);
  expect(instrumentOf(history.project, "drums")).toMatchObject({ preset: "Starter Kit", pads: STARTER_KIT });
});

test("a Kit the library hasn't got is refused, and the Kits there are are named", async () => {
  const storage = await libraryWith808();
  const history = new ProjectHistory(createProject("Beat"));
  history.execute({ type: "addTrack", track: createDrumTrack("Drums", "drums") });
  const before = history.project;

  const { start } = scripted(
    loadSounds,
    () => ({ text: "", toolCalls: [call("i1", "set_instrument", { trackId: "drums", instrument: "drumSampler", preset: "909" })] }),
    (results) => {
      expect(results[0]).toMatchObject({
        isError: true,
        content: 'The Drum Sampler has no Kit called "909". Its Kits are: Starter Kit, 808. Nothing was changed.',
      });
      return says("You have no 909 kit.")();
    },
  );
  await runRequest({ history, request: "use my 909 kit", start, library: await openLibrary(storage) });

  expect(history.project).toBe(before);
});

test("a Drum Sampler's Pads save as a Kit with a copy of their samples, which another Project loads", async () => {
  const storage = memoryLibraryStorage();
  const project = createProject("Beat");
  const drums = createDrumTrack("Drums", "drums");
  drums.instrument = { type: "drumSampler", preset: "Starter Kit", pads: eightOhEightPads() };
  project.tracks.push(drums);
  const history = new ProjectHistory(project);

  const { start } = scripted(
    loadSounds,
    () => ({ text: "", toolCalls: [call("k1", "save_kit", { trackId: "drums", name: "808" })] }),
    (results) => {
      succeeded(results);
      expect(results[0]!.content).toContain("with a copy of the sample its Pads play");
      return says("Saved the drums as the 808 kit.")();
    },
  );
  const outcome = await runRequest({
    history,
    request: "save these drums as a kit called 808",
    start,
    library: await openLibrary(storage, new Map([["audio/808 kick.wav", KICK]])),
  });

  expect(outcome.changes).toEqual([
    "Saved “Drums”'s Pads as the Kit “808” in the library, outside the Project, which undo leaves as it is",
  ]);
  expect(history.canUndo).toBe(false);
  const [kit] = await new KitLibrary(storage).load();
  expect(kit).toMatchObject({ name: "808" });
  const samples = await new KitLibrary(storage).samples(kit!);
  expect([...samples.values()]).toEqual([KICK]);
});

test("a name the library already has is refused rather than saved over, and nothing is saved", async () => {
  const storage = await libraryWith808();
  await new PresetLibrary(storage).save("synth", "My Warm Pad", { ...DEFAULT_SYNTH, cutoffHz: 900 });
  const files = await storage.listFiles("");
  const project = createProject("Beat");
  const keys = createInstrumentTrack("Keys", "keys");
  keys.instrument = { type: "synth", preset: null, settings: { ...DEFAULT_SYNTH, cutoffHz: 5000 } };
  project.tracks.push(keys, createDrumTrack("Drums", "drums"));
  const history = new ProjectHistory(project);

  const { start } = scripted(
    loadSounds,
    () => ({
      text: "",
      toolCalls: [
        call("s1", "save_preset", { source: "keys", name: "my warm pad" }),
        call("s2", "save_preset", { source: "keys", name: "Sub Bass" }),
        call("k1", "save_kit", { trackId: "drums", name: "808" }),
        call("k2", "save_kit", { trackId: "drums", name: "Starter Kit" }),
      ],
    }),
    (results) => {
      expect(results.map((result) => [result.isError, result.content])).toEqual([
        [true, "The Synth already has a Preset called “my warm pad”. Nothing was saved."],
        [true, "“Sub Bass” is a Factory Preset's name, and Factory Presets can't be changed. Nothing was saved."],
        [true, "There is already a Kit called “808”. Nothing was saved."],
        [true, "“Starter Kit” is the bundled Kit's name, which can't be taken. Nothing was saved."],
      ]);
      return says("Those names are taken.")();
    },
  );
  const outcome = await runRequest({ history, request: "save everything", start, library: await openLibrary(storage) });

  expect(outcome.changes).toEqual([]);
  expect(await storage.listFiles("")).toEqual(files);
  const [warm] = await new PresetLibrary(storage).load();
  expect(warm).toMatchObject({ name: "My Warm Pad", settings: { cutoffHz: 900 } });
});

test("save_preset takes a Synth or an Effect, and points a Drum Sampler to save_kit", async () => {
  const project = createProject("Beat");
  project.tracks.push(createDrumTrack("Drums", "drums"));
  const history = new ProjectHistory(project);

  const { start } = scripted(
    loadSounds,
    () => ({
      text: "",
      toolCalls: [
        call("s1", "save_preset", { source: "drums", name: "Kit" }),
        call("s2", "save_preset", { source: "nowhere", name: "Kit" }),
        call("k1", "save_kit", { trackId: "drums", name: "" }),
      ],
    }),
    (results) => {
      expect(results.map((result) => result.content)).toEqual([
        "“Drums” plays the Drum Sampler, whose Pads are saved as a Kit: use save_kit. Nothing was changed.",
        "There is no Track or Effect nowhere. source is an Instrument Track's trackId or an Effect's effectId, as listed in the Project. Nothing was changed.",
        "name must be 1 to 100 characters. Nothing was changed.",
      ]);
      return says("Nothing saved.")();
    },
  );
  await runRequest({ history, request: "save it", start, library: await openLibrary(memoryLibraryStorage()) });
});

test("without a library, saving is refused and the Project is untouched", async () => {
  const project = createProject("Beat");
  project.tracks.push(createInstrumentTrack("Keys", "keys"));
  const history = new ProjectHistory(project);
  const { start } = scripted(
    loadSounds,
    () => ({ text: "", toolCalls: [call("s1", "save_preset", { source: "keys", name: "Keys" })] }),
    (results) => {
      expect(results[0]).toMatchObject({ isError: true, content: "There is no library here to save into. Nothing was saved." });
      return says("I couldn't save it.")();
    },
  );
  const outcome = await runRequest({ history, request: "save it", start });
  expect(outcome.changes).toEqual([]);
});

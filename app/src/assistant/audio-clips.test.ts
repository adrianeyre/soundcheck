/**
 * The Audio Clip story of the v3 PRD, as the tool calls a model would make
 * for it: a take from the sample browser's folders goes on a new Audio
 * Track, copied into the Project as a drop copies it, and is trimmed where
 * listening says its sound starts, as one Request and one undo. The sample
 * browser is an in-memory stand-in for the desktop's, and the real WASM
 * engine decodes and hears the files.
 *
 * Also: a Project's own audio file placed, trimmed and copied, and the
 * browser dev host, which has no sample browser and says so.
 */
import { readFileSync } from "node:fs";

import { initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import { wasmAudioAnalyser } from "../audio/audio-analyser";
import { KitLibrary } from "../kit/kit-library";
import { memoryLibraryStorage } from "../preset/library-storage";
import type { LoadedSample } from "../project/engine-sync";
import { ProjectHistory } from "../project/history";
import {
  type AudioClip,
  type AudioTrack,
  createAudioTrack,
  createInstrumentTrack,
  createProject,
  type Project,
} from "../project/model";
import { barTicks, secondsAt, tempoMapOf } from "../project/time";
import type { SampleFolder, SampleSource } from "../samples/sample-source";
import { stereoWav } from "../song/test-wav";
import { runRequest, type Conversation, type ModelReply, type StartConversation, type ToolResult } from "./assistant";
import { requestMessage } from "./context";
import { assistantLibrary, EMPTY_LIBRARY, type LibraryContents } from "./library";
import { listenWith } from "./listen";
import { InvalidToolCall, MAX_LISTED_SAMPLES, planToolCall, type ToolCall, type ToolPlan } from "./tools";

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

const RATE = 48_000;

/** `silence` seconds of nothing, then `sound` seconds of a tone, as a WAV a take might be. */
function takeWav(silence: number, sound: number): number[] {
  const samples = Array.from({ length: Math.round((silence + sound) * RATE) }, (_, at) =>
    at < silence * RATE ? 0 : 0.5 * Math.sin((2 * Math.PI * 220 * at) / RATE),
  );
  return stereoWav(samples, samples, RATE);
}

const VOCAL_TAKE = takeWav(0.5, 1.5);
const SAMPLES: SampleFolder = { id: "C:/Users/me/Samples", label: "Samples" };

/** A sample folder on a pretend disk, standing in for the desktop's. */
function fakeSource(files: Record<string, number[]> = { "Takes/vocal take.wav": VOCAL_TAKE, "Drums/kick.wav": takeWav(0, 0.25) }): SampleSource {
  return {
    chooseFolder: () => Promise.resolve(null),
    listAudio: () => Promise.resolve(Object.keys(files).toSorted()),
    readBytes: ({ path }) => {
      const bytes = files[path];
      return bytes ? Promise.resolve(Uint8Array.from(bytes)) : Promise.reject(new Error("no such file"));
    },
    audition: () => Promise.resolve(),
    stopAudition: () => Promise.resolve(),
  };
}

/** The library over `audio`, the Project's loaded samples, with the sample browser where `source` is given. */
function libraryOver(audio: Map<string, LoadedSample>, source: SampleSource | null) {
  const storage = memoryLibraryStorage();
  return assistantLibrary(
    { userPresets: [], save: () => Promise.reject(new Error("nothing is saved here")) },
    new KitLibrary(storage),
    { samples: () => audio, add: (added) => added.forEach((sample, path) => audio.set(path, sample)) },
    source && { source, folders: () => Promise.resolve([SAMPLES]) },
  );
}

/** Each turn of the script sees the results of the one before; the first message is kept in `sent`. */
function scripted(...turns: ((results: readonly ToolResult[]) => ModelReply)[]) {
  const sent: string[] = [];
  const results: (readonly ToolResult[])[] = [];
  const start: StartConversation = (request, project, library) => {
    sent.push(requestMessage(request, project, library));
    let turn = 0;
    const conversation: Conversation = {
      next(given) {
        results.push(given);
        const reply = turns[turn++];
        if (!reply) throw new Error("the Assistant asked for more turns than the script has");
        return Promise.resolve(reply(given));
      },
    };
    return conversation;
  };
  return { start, sent, results };
}

function call(id: string, name: string, input: unknown): ToolCall {
  return { id, name, input };
}

function succeeded(results: readonly ToolResult[]): void {
  const failed = results.filter((result) => result.isError);
  if (failed.length > 0) throw new Error(`a call failed: ${failed.map((result) => result.content).join(" ")}`);
}

/** The id a tool's report gives, such as "whose trackId is …". */
function reported(result: ToolResult | undefined, id: string): string {
  const found = new RegExp(`${id} is ([\\w-]+)`).exec(result?.content ?? "");
  if (!found) throw new Error(`no ${id} in ${result?.content}`);
  return found[1]!;
}

const says = (text: string) => () => ({ text, toolCalls: [] });

test("“put the vocal take on a new audio track at bar 9 and trim the silence at its start” is one Request and one undo", async () => {
  const project = createProject("Song");
  const history = new ProjectHistory(project);
  const audio = new Map<string, LoadedSample>();
  const library = libraryOver(audio, fakeSource());
  const bar9 = 8 * barTicks(project.timeSignature);
  let trackId = "";
  let clipId = "";
  const { start, sent, results } = scripted(
    () => ({
      text: "",
      toolCalls: [call("g", "load_tools", { group: "audio_clips" }), call("t", "create_track", { name: "Vocals", kind: "audio" })],
    }),
    (given) => {
      succeeded(given);
      trackId = reported(given[1], "trackId");
      return { text: "", toolCalls: [call("l", "list_samples", { match: "vocal" })] };
    },
    (given) => {
      succeeded(given);
      return {
        text: "",
        toolCalls: [call("p", "place_audio_clip", { trackId, source: "library:Samples/Takes/vocal take.wav", start: bar9 })],
      };
    },
    (given) => {
      succeeded(given);
      clipId = reported(given[0], "clipId");
      return { text: "", toolCalls: [call("a", "analyse_audio", { trackId, start: bar9 })] };
    },
    (given) => {
      succeeded(given);
      // Where the voice comes in, less where the Clip starts, is the silence to trim.
      const measured = JSON.parse(given[0]!.content.split("\n")[2]!) as { onsets: { at: { s: number }[] } };
      const silence = measured.onsets.at[0]!.s - secondsAt(tempoMapOf(history.project), bar9);
      return { text: "", toolCalls: [call("s", "trim_audio_clip", { clipId, startOffset: silence })] };
    },
    (given) => {
      succeeded(given);
      return says("The vocal take is on a new Vocals track from bar 9, with the silence at its start trimmed off.")();
    },
  );

  const outcome = await runRequest({
    history,
    request: "put the vocal take on a new audio track at bar 9 and trim the silence at its start",
    start,
    library,
    listen: (song, range) => listenWith(wasmAudioAnalyser(() => Promise.resolve()), audio)(song, range),
  });

  expect(outcome.error).toBeNull();
  // The first message names the sample folders; the Project had no audio of its own yet.
  expect(sent[0]).toContain('The sample browser\'s folders, whose files list_samples lists:\n["Samples"]');
  expect(sent[0]).not.toContain("The Project's audio files");
  expect(results[2]![0]!.content).toContain('[{"folder":"Samples","files":["Takes/vocal take.wav"]}]');

  // Copied into the Project, as a drop copies it: its own path in audio/, the sample folder never named.
  expect([...audio.keys()]).toEqual(["audio/vocal take.wav"]);
  expect(audio.get("audio/vocal take.wav")).toEqual({ name: "vocal take.wav", bytes: VOCAL_TAKE });
  const vocals = history.project.tracks[0] as AudioTrack;
  expect(vocals).toMatchObject({ name: "Vocals", kind: "audio" });
  const clip = vocals.clips[0]!;
  expect(vocals.clips).toHaveLength(1);
  expect(clip.file).toBe("audio/vocal take.wav");
  expect(JSON.stringify(history.project)).not.toContain("Samples");
  // Trimmed where the voice comes in: the sound stays where it was, so the Clip starts that much later.
  expect(clip.fileOffset).toBeCloseTo(0.5, 1);
  expect(clip.fileOffset + clip.duration).toBeCloseTo(2, 3);
  expect(secondsAt(tempoMapOf(history.project), clip.start) - clip.fileOffset).toBeCloseTo(16, 3);
  expect(outcome.changes).toEqual([
    "Added the Audio Track “Vocals”",
    "Placed the sample “vocal take.wav” on “Vocals” at 9.1.000, copied into the Project as audio/vocal take.wav",
    expect.stringMatching(/^Trimmed an Audio Clip on “Vocals” to play 0\.\d+ s to 2 s of “vocal take\.wav”, from 9\.[12]\.\d{3}$/),
  ]);

  history.undo();
  expect(history.project).toEqual(project);
  expect(history.canUndo).toBe(false);
}, 20_000);

/** A Project whose Audio Track plays `audio/vocal take.wav`, with a second Audio Track and an Instrument Track. */
function projectWithTake(): Project {
  const project = createProject("Song");
  const vocals = createAudioTrack("Vocals", "vocals");
  vocals.clips.push({ id: "take", kind: "audio", start: 0, duration: 2, file: "audio/vocal take.wav", fileOffset: 0 });
  project.tracks.push(vocals, createAudioTrack("Doubles", "doubles"), createInstrumentTrack("Keys", "keys"));
  return project;
}

test("a Project's own audio file is listed with its length, placed, trimmed at its end and copied, as one undo", async () => {
  const project = projectWithTake();
  const history = new ProjectHistory(project);
  const audio = new Map<string, LoadedSample>([["audio/vocal take.wav", { name: "vocal take.wav", bytes: VOCAL_TAKE }]]);
  const bar = barTicks(project.timeSignature);
  let placed = "";
  const { start, sent } = scripted(
    () => ({ text: "", toolCalls: [call("g", "load_tools", { group: "audio_clips" })] }),
    () => ({
      text: "",
      toolCalls: [call("p", "place_audio_clip", { trackId: "vocals", source: "audio/vocal take.wav", start: 4 * bar })],
    }),
    (given) => {
      succeeded(given);
      placed = reported(given[0], "clipId");
      return {
        text: "",
        toolCalls: [
          call("e", "trim_audio_clip", { clipId: placed, endOffset: 1 }),
          call("c", "copy_audio_clip", { clipId: placed, start: 8 * bar, trackId: "doubles" }),
        ],
      };
    },
    (given) => {
      succeeded(given);
      return says("Done.")();
    },
  );

  const outcome = await runRequest({ history, request: "use the take again at bar 5, just its first second, and double it at bar 9", start, library: libraryOver(audio, fakeSource()) });

  expect(outcome.error).toBeNull();
  expect(sent[0]).toContain('The Project\'s audio files, which place_audio_clip places by file, and how many seconds each lasts:\n[{"file":"audio/vocal take.wav","seconds":2}]');
  const [vocals, doubles] = history.project.tracks as AudioTrack[];
  const trimmed: AudioClip = { id: placed, kind: "audio", start: 4 * bar, duration: 1, file: "audio/vocal take.wav", fileOffset: 0 };
  expect(vocals!.clips).toEqual([project.tracks[0]!.clips[0], trimmed]);
  expect(doubles!.clips).toEqual([{ ...trimmed, id: expect.any(String) as unknown as string, start: 8 * bar }]);
  expect(outcome.changes).toEqual([
    "Placed “vocal take.wav” on “Vocals” at 5.1.000",
    "Trimmed an Audio Clip on “Vocals” to play 0 s to 1 s of “vocal take.wav”, from 5.1.000",
    "Copied an Audio Clip on “Vocals” to 9.1.000 onto “Doubles”",
  ]);
  // Nothing new was copied into the Project: the file was already in it.
  expect([...audio.keys()]).toEqual(["audio/vocal take.wav"]);

  history.undo();
  expect(history.project).toEqual(project);
});

test("on the browser dev host, with no sample browser, only the Project's files are offered, and the tools say so", async () => {
  const project = projectWithTake();
  const history = new ProjectHistory(project);
  const audio = new Map<string, LoadedSample>([["audio/vocal take.wav", { name: "vocal take.wav", bytes: VOCAL_TAKE }]]);
  const { start, sent, results } = scripted(
    () => ({ text: "", toolCalls: [call("g", "load_tools", { group: "audio_clips" })] }),
    () => ({
      text: "",
      toolCalls: [
        call("l", "list_samples", {}),
        call("p", "place_audio_clip", { trackId: "doubles", source: "library:Samples/Takes/vocal take.wav", start: 0 }),
      ],
    }),
    () => ({ text: "", toolCalls: [call("q", "place_audio_clip", { trackId: "doubles", source: "audio/vocal take.wav", start: 0 })] }),
    says("There is no sample browser here, so I used the take already in the Project."),
  );

  await runRequest({ history, request: "put a vocal on the doubles", start, library: libraryOver(audio, null) });

  expect(sent[0]).not.toContain("sample browser's folders");
  const [listed, refused] = results[2]!;
  expect(listed).toMatchObject({ isError: false });
  expect(listed!.content).toContain("The sample browser isn't available here");
  expect(listed!.content).toContain("The Project's audio files: audio/vocal take.wav (2 s).");
  expect(refused).toMatchObject({ isError: true });
  expect(refused!.content).toContain("The sample browser isn't available here");
  expect(refused!.content).toContain("Nothing was changed.");
  succeeded(results[3]!);
  expect((history.project.tracks[1] as AudioTrack).clips).toHaveLength(1);
});

test("a sample that can't be read, or isn't audio, changes nothing, and the model is told why", async () => {
  const history = new ProjectHistory(projectWithTake());
  const source = fakeSource({ "notes.wav": [1, 2, 3] });
  const { start, results } = scripted(
    () => ({ text: "", toolCalls: [call("g", "load_tools", { group: "audio_clips" })] }),
    () => ({
      text: "",
      toolCalls: [
        call("m", "place_audio_clip", { trackId: "doubles", source: "library:Samples/gone.wav", start: 0 }),
        call("n", "place_audio_clip", { trackId: "doubles", source: "library:Samples/notes.wav", start: 0 }),
      ],
    }),
    says("Neither file could be placed."),
  );

  await runRequest({ history, request: "place the samples", start, library: libraryOver(new Map(), source) });

  const [missing, broken] = results[2]!;
  expect(missing).toMatchObject({ isError: true, content: "gone.wav couldn't be read: no such file. Nothing was changed." });
  expect(broken).toMatchObject({ isError: true });
  expect(broken!.content).toContain("notes.wav can't be imported");
  expect(history.project).toEqual(projectWithTake());
});

const CONTENTS: LibraryContents = {
  ...EMPTY_LIBRARY,
  sampleFolders: [SAMPLES, { id: "D:/More/Samples", label: "Samples" }],
  audioFiles: [{ file: "audio/vocal take.wav", seconds: 2 }],
};

function plan(name: string, input: unknown, project = projectWithTake(), contents = CONTENTS): ToolPlan {
  return planToolCall({ id: "call-1", name, input }, project, contents);
}

/** The sample `source` names, as place_audio_clip reads it. */
function sampleNamed(source: string) {
  return plan("place_audio_clip", { trackId: "doubles", source, start: 0 }).copySample?.sample;
}

test("place_audio_clip names a sample by its folder, which a number tells apart from another of the same name", () => {
  expect(sampleNamed("library:Samples/Takes/vocal take.wav")).toEqual({ folder: SAMPLES, path: "Takes/vocal take.wav" });
  expect(sampleNamed("library:Samples (2)/kick.wav")).toEqual({ folder: { id: "D:/More/Samples", label: "Samples" }, path: "kick.wav" });
  expect(() => sampleNamed("library:Loops/kick.wav")).toThrow("They are: Samples, Samples (2).");
  expect(() => sampleNamed("audio/gone.wav")).toThrow("The Project's audio files: audio/vocal take.wav (2 s).");
  expect(() => plan("place_audio_clip", { trackId: "keys", source: "audio/vocal take.wav", start: 0 })).toThrow(
    "Keys is an Instrument Track",
  );
});

test("trim_audio_clip keeps the sound where it is, and can't run past the file or trim a Pattern Clip", () => {
  const project = projectWithTake();
  project.tempo = 60;
  // At 60 BPM a beat is a second: 0.25 s trimmed off the start moves the Clip a quarter beat later.
  const trim = plan("trim_audio_clip", { clipId: "take", startOffset: 0.25 }, project);
  expect(trim.commands).toEqual([{ type: "trimClip", clipId: "take", start: 240, length: 1_680, fileOffset: 0.25 }]);
  expect(trim.report).toBe("Clip take now plays 0.25 s to 2 s of audio/vocal take.wav, 1.75 s, from tick 240 (1.1.240).");
  expect(() => plan("trim_audio_clip", { clipId: "take", endOffset: 2.5 }, project)).toThrow("endOffset must be a number from 0 to 2");
  expect(() => plan("trim_audio_clip", { clipId: "take", startOffset: 1, endOffset: 1 }, project)).toThrow("the Clip would play nothing");
  expect(() => plan("trim_audio_clip", { clipId: "take" }, project)).toThrow("needs startOffset, endOffset or both");

  const keys = project.tracks[2]!;
  if (keys.kind === "instrument") keys.clips.push({ id: "riff", kind: "pattern", start: 0, length: 960, notes: [] });
  expect(() => plan("trim_audio_clip", { clipId: "riff", endOffset: 1 }, project)).toThrow(InvalidToolCall);
});

test(`list_samples returns at most ${MAX_LISTED_SAMPLES} files, and says how many more there are`, () => {
  const files = Array.from({ length: 250 }, (_, at) => `loop ${String(at).padStart(3, "0")}.wav`);
  const listing = plan("list_samples", { folder: "Samples" }).listSamples!;
  expect(listing.folders).toEqual([SAMPLES]);
  const report = listing.report([files]);
  const listed = JSON.parse(report.slice(report.indexOf("\n") + 1)) as { folder: string; files: string[]; more: number }[];
  expect(listed).toEqual([{ folder: "Samples", files: files.slice(0, MAX_LISTED_SAMPLES), more: 50 }]);
  expect(report).toContain("narrow them with match");
  expect(() => plan("list_samples", { folder: "Loops" })).toThrow("There is no sample folder Loops");
});

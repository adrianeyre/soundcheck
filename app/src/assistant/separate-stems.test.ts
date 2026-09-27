/**
 * `separate_stems`: the Assistant separates an Audio Clip into its Stems
 * inside a Request, waiting for the separation and placing the Stems as
 * part of its one undo step. The separation is the fake one, and the
 * Clip's audio is cut by a stand-in for the engine's.
 */
import { expect, test } from "vitest";

import type { LoadedSample } from "../project/engine-sync";
import { sampleProject } from "../project/fixtures";
import { ProjectHistory } from "../project/history";
import type { AudioClip, AudioTrack, Project } from "../project/model";
import { assistantStems } from "../stems/assistant-stems";
import { fakeStemSeparator, type FakeStemSeparatorOptions } from "../stems/fake-stem-separator";
import { unavailableStemSeparator } from "../stems/stem-separator";
import {
  runRequest,
  STEMS_CANCELLED,
  STEMS_NOT_INSTALLED,
  STEMS_UNAVAILABLE,
  type ModelReply,
  type RequestMode,
  type RunningSeparation,
  type StartConversation,
  type ToolResult,
} from "./assistant";
import { planToolCall, toolDefinitions } from "./tools";

const SUGGESTION: RequestMode = { smallCore: false, suggestion: true };

/** The sample Project's Vocals Clip: 4 s of take1.wav, on the Vocals Track. */
function vocalsClip(project: Project): AudioClip {
  return (project.tracks[2] as AudioTrack).clips[0]!;
}

/** The loaded audio, the fake separation over it, and what it separated. */
function setUp(options: FakeStemSeparatorOptions = { installed: true }) {
  const audio = new Map<string, LoadedSample>([["audio/take1.wav", { name: "take1.wav", bytes: [1, 2, 3] }]]);
  const separator = fakeStemSeparator({ stem: (_, name) => new TextEncoder().encode(`RIFF ${name}`), ...options });
  const stems = assistantStems(
    separator,
    {
      samples: () => audio,
      add: (added) => added.forEach((sample, path) => audio.set(path, sample)),
      remove: (paths) => paths.forEach((path) => audio.delete(path)),
    },
    () => Promise.resolve(new TextEncoder().encode("RIFF the Clip")),
  );
  return { audio, separator, stems };
}

/** Each turn of the script sees the results of the one before, and how many turns are left. */
function scripted(...turns: ((results: readonly ToolResult[]) => ModelReply)[]) {
  const results: (readonly ToolResult[])[] = [];
  const turnsLeft: number[] = [];
  const start: StartConversation = () => {
    let turn = 0;
    return {
      next(given, left) {
        results.push(given);
        turnsLeft.push(left);
        const reply = turns[turn++];
        if (!reply) throw new Error("the Assistant asked for more turns than the script has");
        return Promise.resolve(reply(given));
      },
    };
  };
  return { start, results, turnsLeft };
}

const separates = (input: Record<string, unknown>) => () => ({
  text: "",
  toolCalls: [
    { id: "g", name: "load_tools", input: { group: "audio_clips" } },
    { id: "s", name: "separate_stems", input: { clipId: "vocals-1", ...input } },
  ],
});
const says = (text: string) => () => ({ text, toolCalls: [] });

test("a Request separates a Clip, keeps only its vocals, and is one undo step", async () => {
  const history = new ProjectHistory(sampleProject());
  const { audio, separator, stems } = setUp();
  const { start, results } = scripted(separates({ keep: ["vocals"] }), says("The vocals are on their own Track."));

  const outcome = await runRequest({ history, request: "pull the vocals out of take1", start, stems });

  expect(outcome.error).toBeNull();
  expect(separator.separations).toHaveLength(1);
  const result = results[1]![1]!;
  expect(result.isError).toBe(false);
  const tracks = history.project.tracks;
  expect(tracks.map((track) => track.name)).toEqual(["Keys", "Bass", "Vocals", "take1 – Vocals", "Drums"]);
  const stemTrack = tracks[3] as AudioTrack;
  // The result names the new Track by its id, so the Assistant can carry on with it.
  expect(result.content).toContain(`${stemTrack.id} “take1 – Vocals” (vocals)`);
  expect(result.content).toContain("The Drums, Bass, Other Stems were discarded.");
  expect(stemTrack.clips).toEqual([expect.objectContaining({ file: "audio/take1 – Vocals.wav", start: 3840, duration: 4 })]);
  expect(tracks[2]!.clips).toEqual([]);
  expect([...audio.keys()]).toEqual(["audio/take1.wav", "audio/take1 – Vocals.wav"]);
  expect(outcome.changes).toEqual(["Separated “take1” on “Vocals” into Stems, keeping Vocals, in place of the Clip"]);

  history.undo();
  expect(history.project).toEqual(sampleProject());
  expect(history.canUndo).toBe(false);
});

test("left out, keep keeps all four Stems, and the wait uses no turn", async () => {
  const history = new ProjectHistory(sampleProject());
  const { stems } = setUp();
  const { start, turnsLeft } = scripted(separates({}), says("Done."));

  await runRequest({ history, request: "separate take1", start, stems });

  expect(history.project.tracks.slice(3, 7).map((track) => track.name)).toEqual([
    "take1 – Vocals",
    "take1 – Drums",
    "take1 – Bass",
    "take1 – Other",
  ]);
  expect(turnsLeft).toEqual([12, 11]);
});

test("the musician sees the separation's progress in the Request, and it ends", async () => {
  const history = new ProjectHistory(sampleProject());
  const { stems } = setUp();
  const shown: (Omit<RunningSeparation, "cancel"> | null)[] = [];
  const { start } = scripted(separates({}), says("Done."));

  await runRequest({
    history,
    request: "separate take1",
    start,
    stems,
    onSeparation: (separation) => shown.push(separation && { clipName: separation.clipName, progress: separation.progress }),
  });

  expect(shown.map((separation) => separation?.progress ?? null)).toEqual([0, 0, 0.25, 0.5, 0.75, 1, null]);
  expect(shown[0]?.clipName).toBe("take1");
});

test("with the model not installed the call fails, changes nothing, and nothing is installed", async () => {
  const history = new ProjectHistory(sampleProject());
  const { audio, separator, stems } = setUp({ installed: false });
  const { start, results } = scripted(separates({ keep: ["vocals"] }), says("It isn't installed."));

  const outcome = await runRequest({ history, request: "pull the vocals out", start, stems });

  expect(results[1]![1]).toMatchObject({ content: STEMS_NOT_INSTALLED, isError: true });
  expect(separator.separations).toEqual([]);
  expect(separator.installs).toEqual([]);
  expect(history.project).toEqual(sampleProject());
  expect(history.canUndo).toBe(false);
  expect([...audio.keys()]).toEqual(["audio/take1.wav"]);
  expect(outcome.changes).toEqual([]);
});

test("cancelled by the musician, the call fails, nothing changes, and the Assistant sums up", async () => {
  const history = new ProjectHistory(sampleProject());
  let running: RunningSeparation | null = null;
  const { audio, stems } = setUp({
    installed: true,
    // The musician presses Cancel halfway.
    between: () => {
      if (running && running.progress >= 0.5) running.cancel();
      return Promise.resolve();
    },
  });
  const { start, results, turnsLeft } = scripted(
    () => ({
      text: "",
      toolCalls: [
        { id: "g", name: "load_tools", input: { group: "audio_clips" } },
        { id: "s", name: "separate_stems", input: { clipId: "vocals-1" } },
        { id: "v", name: "set_track_volume", input: { trackId: "keys", volumeDb: -3 } },
      ],
    }),
    says("The separation was cancelled, so nothing changed."),
  );

  const outcome = await runRequest({
    history,
    request: "separate take1 and turn the keys down",
    start,
    stems,
    onSeparation: (separation) => {
      running = separation;
    },
  });

  expect(results[1]![1]).toMatchObject({ content: STEMS_CANCELLED, isError: true });
  // A call after it in the same turn isn't made, and the next reply is the summary.
  expect(results[1]![2]!.isError).toBe(true);
  expect(turnsLeft).toEqual([12, 0]);
  expect(outcome.message).toBe("The separation was cancelled, so nothing changed.");
  expect(history.project).toEqual(sampleProject());
  expect(history.canUndo).toBe(false);
  expect([...audio.keys()]).toEqual(["audio/take1.wav"]);
});

test("where Stem Separation isn't available, as in a browser that can't run the model, the call fails and changes nothing", async () => {
  for (const stems of [assistantStems(unavailableStemSeparator("Not in the browser."), { samples: () => new Map(), add: () => undefined, remove: () => undefined }), undefined]) {
    const history = new ProjectHistory(sampleProject());
    const { start, results } = scripted(separates({}), says("It isn't available."));

    await runRequest({ history, request: "separate take1", start, stems });

    expect(results[1]![1]).toMatchObject({ content: STEMS_UNAVAILABLE, isError: true });
    expect(history.project).toEqual(sampleProject());
  }
});

test("a Suggestion separates once: applying it places the Stems it separated, as one undo step", async () => {
  const history = new ProjectHistory(sampleProject());
  const { audio, separator, stems } = setUp();
  const { start } = scripted(separates({ keep: ["vocals", "bass"] }), says("Apply it to get the Stems."));

  const outcome = await runRequest({ history, request: "separate take1", start, stems, mode: SUGGESTION });

  // Worked out against a copy: the Project is as it was, and the Stems' audio is there to hear.
  expect(history.project).toEqual(sampleProject());
  expect(audio.has("audio/take1 – Vocals.wav")).toBe(true);
  const applied = await outcome.suggestion!.apply();

  expect(applied.failed).toEqual([]);
  expect(separator.separations).toHaveLength(1);
  const tracks = history.project.tracks;
  expect(tracks.map((track) => track.name)).toEqual(["Keys", "Bass", "Vocals", "take1 – Vocals", "take1 – Bass", "Drums"]);
  expect((tracks[3] as AudioTrack).clips[0]!.file).toBe("audio/take1 – Vocals.wav");
  expect([...audio.keys()]).toEqual(["audio/take1.wav", "audio/take1 – Vocals.wav", "audio/take1 – Bass.wav"]);
  history.undo();
  expect(history.project).toEqual(sampleProject());
});

test("a rejected Suggestion leaves no Stem audio in the Project", async () => {
  const history = new ProjectHistory(sampleProject());
  const { audio, stems } = setUp();
  const { start } = scripted(separates({}), says("Apply it to get the Stems."));

  const outcome = await runRequest({ history, request: "separate take1", start, stems, mode: SUGGESTION });
  outcome.suggestion!.discard();

  expect(history.project).toEqual(sampleProject());
  expect([...audio.keys()]).toEqual(["audio/take1.wav"]);
});

test("a Suggestion whose Clip was deleted before it was applied reports it and leaves no Stem audio", async () => {
  const history = new ProjectHistory(sampleProject());
  const { audio, stems } = setUp();
  const { start } = scripted(separates({}), says("Apply it to get the Stems."));
  const outcome = await runRequest({ history, request: "separate take1", start, stems, mode: SUGGESTION });
  history.execute({ type: "deleteClip", clipId: vocalsClip(history.project).id });

  const applied = await outcome.suggestion!.apply();

  expect(applied.failed).toHaveLength(1);
  expect(applied.failed[0]).toMatch(/Clip vocals-1|no Clip/);
  expect([...audio.keys()]).toEqual(["audio/take1.wav"]);
});

test("keep names only Stems", () => {
  const project = sampleProject();
  expect(() => planToolCall({ id: "s", name: "separate_stems", input: { clipId: "vocals-1", keep: ["guitar"] } }, project)).toThrow(
    'keep can only name vocals, drums, bass, other, not "guitar"',
  );
  expect(() => planToolCall({ id: "s", name: "separate_stems", input: { clipId: "vocals-1", keep: [] } }, project)).toThrow(
    "keep must be a list",
  );
});

test("the model is told separating takes a while and removes the source Clip", () => {
  const tool = toolDefinitions(["audio_clips"], false, false).find(({ name }) => name === "separate_stems");
  expect(tool?.description).toMatch(/takes a while/);
  expect(tool?.description).toMatch(/source Clip is removed/);
});

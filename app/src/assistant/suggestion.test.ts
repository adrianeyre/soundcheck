/**
 * Suggestion mode: a Request worked out against a copy of the Project,
 * applied as one undo step only when the musician says so, and worked out
 * again against the Project if it has changed since. The model is
 * scripted; no test calls a real API.
 */
import { afterEach, expect, test, vi } from "vitest";

import { synthPresetNames } from "../instrument/synth-presets";
import type { UserPreset } from "../preset/preset-library";
import { sampleProject } from "../project/fixtures";
import { ProjectHistory } from "../project/history";
import type { Project } from "../project/model";
import {
  runRequest,
  type FinishedRequest,
  type ModelReply,
  type RequestMode,
  type StartConversation,
  type ToolResult,
} from "./assistant";
import { requestMessage, systemPrompt } from "./context";
import { EMPTY_LIBRARY, type AssistantLibrary } from "./library";
import { SMALL_CORE_TOOL_DEFINITIONS, type ToolCall } from "./tools";

type Turn = (results: readonly ToolResult[]) => ModelReply;

const SUGGESTION: RequestMode = { smallCore: false, suggestion: true };

/** The model, scripted one Request after another: each `start` plays the next script. */
function scripted(...requests: Turn[][]) {
  const sent: { message: string; mode: RequestMode | undefined; tools: string[][]; results: (readonly ToolResult[])[] }[] = [];
  let index = 0;
  const start: StartConversation = (request, project, library, conversation, mode) => {
    const turns = requests[index++];
    if (!turns) throw new Error("more Requests were made than the script has");
    const one = { message: requestMessage(request, project, library, conversation), mode, tools: [] as string[][], results: [] as (readonly ToolResult[])[] };
    sent.push(one);
    let turn = 0;
    return {
      next(results, _turnsLeft, tools) {
        one.tools.push(tools.map((tool) => tool.name));
        one.results.push(results);
        const reply = turns[turn++];
        if (!reply) throw new Error("the Assistant asked for more turns than the script has");
        return Promise.resolve(reply(results));
      },
    };
  };
  return { start, sent };
}

function call(name: string, input: unknown, id = `call-${name}`): ToolCall {
  return { id, name, input };
}

const calls =
  (...toolCalls: ToolCall[]): Turn =>
  () => ({ text: "", toolCalls });

const says = (text: string) => () => ({ text, toolCalls: [] });

/** The id a tool's report gives, such as "whose trackId is …". */
function reported(result: ToolResult | undefined, id: string): string {
  const found = new RegExp(`${id} is ([\\w-]+)`).exec(result?.content ?? "");
  if (!found) throw new Error(`no ${id} in ${result?.content}`);
  return found[1]!;
}

/**
 * A Request that adds a Track and a Clip on it, naming the Track by the id
 * create_track reported, and turns two of the sample song's Tracks down.
 */
function addsAPad(): Turn[] {
  return [
    calls(call("create_track", { name: "Pad", kind: "instrument" }), call("set_track_volume", { trackId: "keys", volume: 0.5 })),
    (results) =>
      calls(
        call("place_clip", { trackId: reported(results[0], "trackId"), start: 0, length: 1920 }),
        call("set_track_volume", { trackId: "bass", volume: 0.25 }),
      )(results),
    says("I added a Pad and turned the keys and bass down."),
  ];
}

/** An id per call, the same on every run, so two runs can be compared. */
function sameIdsEachRun() {
  let count = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++count).padStart(12, "0")}`);
  return () => {
    count = 0;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A history of the sample song with one step to undo and one to redo, as a musician's would have. */
function editedHistory(): ProjectHistory {
  const history = new ProjectHistory(sampleProject());
  history.execute({ type: "renameTrack", trackId: "keys", name: "Piano" });
  history.execute({ type: "setTempo", tempo: 100 });
  history.undo();
  return history;
}

test("a Suggestion changes nothing in the Project or its history until it is applied", async () => {
  const history = editedHistory();
  const before = history.project;
  const heard: Project[] = [];
  const changed = vi.fn<() => void>();
  history.subscribe(changed);
  let busy = false;
  const { start } = scripted([
    ...addsAPad().slice(0, 2),
    (results) => {
      busy = history.busy;
      return calls(call("analyse_audio", {}))(results);
    },
    says("I added a Pad and turned the keys and bass down."),
  ]);

  const outcome = await runRequest({
    history,
    request: "add a pad and make room for it",
    start,
    mode: SUGGESTION,
    listen: (project) => {
      heard.push(project);
      return Promise.resolve({ measurements: "Integrated loudness: -14 LUFS" });
    },
  });

  expect(outcome.error).toBeNull();
  expect(outcome.changes).toHaveLength(4);
  expect(outcome.suggestion?.status).toBe("pending");
  // The real history was held still while the Request ran, and is just as it was.
  expect(busy).toBe(true);
  expect(history.project).toBe(before);
  expect(changed).not.toHaveBeenCalled();
  expect(history.busy).toBe(false);
  expect(history.undoLabel).toBe("Rename Track");
  expect(history.redoLabel).toBe("Set tempo");
  // analyse_audio heard the copy, with the Suggestion's changes in it.
  expect(heard[0]!.tracks.map((track) => track.name)).toEqual(["Piano", "Bass", "Vocals", "Drums", "Pad"]);
  expect(heard[0]!.tracks[0]!.mixer.volume).toBe(0.5);
  // Until it is applied, a follow-up would be told none of it is in the Project.
  expect(outcome.undone()).toBe(true);

  outcome.suggestion!.discard();
  expect(outcome.suggestion!.status).toBe("discarded");
  expect(history.project).toBe(before);
  await expect(outcome.suggestion!.apply()).rejects.toThrow(/discarded/);
  expect(history.project).toBe(before);
});

test("applying a Suggestion is one undo step, and gives the Project running the Request directly gives", async () => {
  const again = sameIdsEachRun();
  const direct = editedHistory();
  await runRequest({ history: direct, request: "add a pad", start: scripted(addsAPad()).start });

  again();
  const history = editedHistory();
  const before = history.project;
  const outcome = await runRequest({ history, request: "add a pad", start: scripted(addsAPad()).start, mode: SUGGESTION });
  const applied = await outcome.suggestion!.apply();

  expect(applied).toEqual({ changes: outcome.changes, failed: [], reworked: false });
  expect(history.project).toEqual(direct.project);
  expect(outcome.suggestion!.status).toBe("applied");
  expect(outcome.undone()).toBe(false);
  expect(history.undoLabel).toBe("Request");
  // The step the musician could redo went, as it does for any change.
  expect(history.canRedo).toBe(false);

  history.undo();
  expect(history.project).toBe(before);
  expect(outcome.undone()).toBe(true);
  await expect(outcome.suggestion!.apply()).rejects.toThrow(/applied/);
});

test("an edit made before Apply is kept, and a call that no longer applies is reported", async () => {
  const history = new ProjectHistory(sampleProject());
  const outcome = await runRequest({ history, request: "add a pad", start: scripted(addsAPad()).start, mode: SUGGESTION });

  // Meanwhile the musician renames the vocals and deletes the bass.
  history.execute({ type: "renameTrack", trackId: "vocals", name: "Lead vocal" });
  history.execute({ type: "deleteTrack", trackId: "bass" });
  const edited = history.project;

  const applied = await outcome.suggestion!.apply();

  expect(applied.reworked).toBe(true);
  expect(applied.failed).toEqual([expect.stringMatching(/^Set “Bass” to .*: There is no Track bass\. .*Nothing was changed\.$/)]);
  expect(applied.changes).toHaveLength(3);
  const tracks = history.project.tracks;
  expect(tracks.map((track) => track.name)).toEqual(["Keys", "Lead vocal", "Drums", "Pad"]);
  // The Clip went on the Pad the Suggestion added, named by the id it had there.
  expect(tracks[3]!.clips).toHaveLength(1);
  expect(tracks[0]!.mixer.volume).toBe(0.5);
  // One undo takes the Suggestion back and leaves the musician's edit.
  history.undo();
  expect(history.project).toBe(edited);
});

test("a Suggestion saves its Presets only when it is applied, and can load them before", async () => {
  const saved: UserPreset[] = [];
  const savePreset = vi.fn<AssistantLibrary["savePreset"]>((target, name, settings) => {
    const preset = { id: `preset-${saved.length + 1}`, name, target, settings };
    saved.push(preset);
    return Promise.resolve(preset);
  });
  const library: AssistantLibrary = {
    contents: () => Promise.resolve({ ...EMPTY_LIBRARY, userPresets: [...saved] }),
    savePreset,
    saveKit: () => Promise.reject(new Error("not in this test")),
    loadKit: () => Promise.reject(new Error("not in this test")),
    listSamples: () => Promise.reject(new Error("not in this test")),
    copySample: () => Promise.reject(new Error("not in this test")),
  };
  const history = new ProjectHistory(sampleProject());
  const { start, sent } = scripted([
    calls(call("load_tools", { group: "sounds" })),
    calls(call("set_instrument", { trackId: "keys", instrument: "synth", preset: synthPresetNames()[1] })),
    calls(call("save_preset", { source: "keys", name: "Dark keys" })),
    calls(call("load_preset", { trackId: "bass", preset: "Dark keys" })),
    says("Saved the keys as Dark keys and loaded it on the bass."),
  ]);

  const outcome = await runRequest({ history, request: "save the keys' sound and use it on the bass", start, library, mode: SUGGESTION });

  expect(sent[0]!.results.flat().filter((result) => result.isError)).toEqual([]);
  expect(outcome.changes).toHaveLength(3);
  expect(savePreset).not.toHaveBeenCalled();

  const applied = await outcome.suggestion!.apply();
  expect(applied.failed).toEqual([]);
  expect(savePreset).toHaveBeenCalledTimes(1);
  const [keys, bass] = history.project.tracks;
  if (keys?.kind !== "instrument" || bass?.kind !== "instrument") throw new Error("Both are Instrument Tracks.");
  expect(bass.instrument).toEqual({ ...keys.instrument, preset: "Dark keys" });
});

test("a follow-up is told when the Suggestion before it was discarded", async () => {
  const history = new ProjectHistory(sampleProject());
  const { start, sent } = scripted(addsAPad(), [says("Fine.")]);
  const first = await runRequest({ history, request: "add a pad", start, mode: SUGGESTION });
  first.suggestion!.discard();
  const conversation: FinishedRequest[] = [{ request: "add a pad", outcome: first }];

  await runRequest({ history, request: "something else then", start, conversation, mode: SUGGESTION });

  expect(sent[1]!.message).toContain(`The musician didn't apply the earlier Request "add a pad", which was a Suggestion`);
});

test("a Request that changes nothing is no Suggestion", async () => {
  const history = new ProjectHistory(sampleProject());
  const { start } = scripted([calls(call("read_channel", { channel: "keys" })), says("The keys are at unity.")]);

  const outcome = await runRequest({ history, request: "how loud are the keys?", start, mode: SUGGESTION });

  expect(outcome.suggestion).toBeNull();
  expect(outcome.undone()).toBe(false);
});

test("the smaller core starts without read_automation, set_track_solo and set_master_volume, which come with their groups", async () => {
  const history = new ProjectHistory(sampleProject());
  const { start, sent } = scripted([
    calls(call("set_master_volume", { volume: 0.8 })),
    calls(call("load_tools", { group: "routing" })),
    calls(call("set_master_volume", { volume: 0.8 })),
    says("The Master is at 0.8."),
  ]);

  await runRequest({ history, request: "turn the master down a bit", start, mode: { smallCore: true, suggestion: false } });

  const [one] = sent;
  expect(one!.mode).toEqual({ smallCore: true, suggestion: false });
  expect(one!.tools[0]).toEqual(SMALL_CORE_TOOL_DEFINITIONS.map((tool) => tool.name));
  expect(one!.results[1]![0]).toMatchObject({ isError: true, content: expect.stringContaining(`load_tools with group "routing"`) });
  expect(one!.results[2]![0]!.content).toContain("set_track_solo, set_master_volume");
  expect(one!.tools[2]).toContain("set_master_volume");
  expect(one!.results[3]![0]).toMatchObject({ isError: false });
  expect(history.project.master.volume).toBe(0.8);
});

test("the system prompt names the core a Request starts with, and says when its changes are a Suggestion", () => {
  const small = systemPrompt({ smallCore: true, suggestion: true });
  expect(small).toContain(`You start with the core tools: ${SMALL_CORE_TOOL_DEFINITIONS.map((tool) => tool.name).join(", ")}.`);
  expect(small).toContain("read_automation, set_automation, clear_automation");
  expect(small).toContain("Your changes are a Suggestion");
  expect(systemPrompt({ smallCore: false, suggestion: false })).not.toContain("Suggestion");
});

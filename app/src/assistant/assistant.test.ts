import { expect, test, vi } from "vitest";

import { KitLibrary } from "../kit/kit-library";
import { memoryLibraryStorage } from "../preset/library-storage";
import { sampleProject } from "../project/fixtures";
import { ProjectHistory } from "../project/history";
import type { UserPreset } from "../preset/preset-library";
import { createProject, DEFAULT_SYNTH } from "../project/model";
import {
  MAX_TURNS,
  runRequest,
  summarise,
  type Conversation,
  type ModelReply,
  type RequestStatus,
  type StartConversation,
  type ToolResult,
} from "./assistant";
import { requestMessage, SYSTEM_PROMPT } from "./context";
import { assistantLibrary } from "./library";
import {
  CORE_TOOL_DEFINITIONS,
  groupToolNames,
  TOOL_GROUPS,
  toolDefinitions,
  type ToolCall,
  type ToolGroup,
} from "./tools";

/**
 * Claude, replaced by a script: each reply is sent in turn, and what the
 * Assistant sent back is kept so a test can check it. No test calls the API.
 */
function scripted(...replies: ModelReply[]) {
  const sent: { request: string; results: readonly ToolResult[]; turnsLeft: number; tools: string[] }[] = [];
  let turn = 0;
  const start: StartConversation = (request, project, library) => {
    const conversation: Conversation = {
      next(results, turnsLeft, tools) {
        const names = tools.map((tool) => tool.name);
        sent.push({ request: requestMessage(request, project, library), results, turnsLeft, tools: names });
        const reply = replies[turn++];
        if (!reply) throw new Error("the Assistant asked for more turns than the script has");
        return Promise.resolve(reply);
      },
    };
    return conversation;
  };
  return { start, sent };
}

function call(name: string, input: unknown, id = `call-${name}`): ToolCall {
  return { id, name, input };
}

function says(text: string): ModelReply {
  return { text, toolCalls: [] };
}

/** A turn that loads groups of tools, to call from the next. */
function loads(...groups: ToolGroup[]): ModelReply {
  return { text: "", toolCalls: groups.map((group) => call("load_tools", { group }, `load-${group}`)) };
}

/** Adds one Track, then the API call fails, as a rejected key would. */
const failsAfterOneTool: StartConversation = () => ({
  next: vi
    .fn<Conversation["next"]>()
    .mockResolvedValueOnce({ text: "", toolCalls: [call("create_track", { name: "Kick", kind: "instrument" })] })
    .mockRejectedValueOnce(new Error("Claude would not accept that API key. Check it and enter it again.")),
});

/** Asks for the same tool for ever, even when it has none left. */
const neverFinishes = vi.fn<Conversation["next"]>(() =>
  Promise.resolve({ text: "", toolCalls: [call("create_track", { name: "Again", kind: "instrument" })] }),
);

test("one Request builds the Project the tool calls describe, and one undo takes it all back", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const before = history.project;
  const { start } = scripted(
    {
      text: "",
      toolCalls: [
        call("create_track", { name: "Kick", kind: "instrument" }, "a"),
        call("create_track", { name: "Bass", kind: "instrument" }, "b"),
        call("load_tools", { group: "time" }, "load"),
      ],
    },
    { text: "", toolCalls: [call("set_tempo", { tempo: 128 }, "c")] },
    says("Added a Kick and a Bass, at 128 BPM."),
  );

  const outcome = await runRequest({ history, request: "two tracks at 128", start });

  expect(outcome.error).toBeNull();
  expect(outcome.message).toBe("Added a Kick and a Bass, at 128 BPM.");
  expect(history.project.tracks.map((track) => track.name)).toEqual(["Kick", "Bass"]);
  expect(history.project.tempo).toBe(128);
  expect(summarise(outcome)).toBe(
    "Added the Instrument Track “Kick”. Added the Instrument Track “Bass”. Set the tempo to 128 BPM.",
  );

  expect(history.undoLabel).toBe("Request");
  expect(history.undo()).toBe(true);
  expect(history.project).toBe(before);
  expect(history.canUndo).toBe(false);

  // And redo brings the whole Request back, still as one step.
  expect(history.redo()).toBe(true);
  expect(history.project.tracks).toHaveLength(2);
});

test("the model is sent a summary of the Project it is being asked to change", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  history.execute({ type: "setTempo", tempo: 90 });
  const { start, sent } = scripted(says("Nothing to do."));

  await runRequest({ history, request: "speed it up", start });

  expect(sent[0]!.request).toContain('"tempo":90');
  expect(sent[0]!.request).toContain("speed it up");
  expect(sent[0]!.results).toEqual([]);
});

test("the model is told the musician's User Presets, and loads one by name", async () => {
  const history = new ProjectHistory(sampleProject());
  const userPresets: UserPreset[] = [
    { id: "u1", name: "Glass Keys", target: "synth", settings: { ...DEFAULT_SYNTH, cutoffHz: 2500 } },
  ];
  const { start, sent } = scripted(
    loads("sounds"),
    { text: "", toolCalls: [call("load_preset", { trackId: "keys", preset: "Glass Keys" })] },
    says("Keys now use your Glass Keys preset."),
  );

  const library = assistantLibrary(
    { userPresets, save: () => Promise.reject(new Error("nothing is saved here")) },
    new KitLibrary(memoryLibraryStorage()),
    { samples: () => new Map(), add: () => undefined },
  );

  const outcome = await runRequest({ history, request: "use my Glass Keys sound on the keys", start, library });

  expect(sent[0]!.request).toContain('[{"name":"Glass Keys","for":"synth"}]');
  expect(outcome.changes).toEqual(["Loaded the “Glass Keys” User Preset into “Keys”"]);
  const keys = history.project.tracks[0]!;
  expect(keys.kind === "instrument" && keys.instrument).toEqual({
    type: "synth",
    preset: "Glass Keys",
    settings: userPresets[0]!.settings,
  });
  history.undo();
  expect(history.project).toEqual(sampleProject());
});

test("an invalid tool call changes nothing and goes back to the model to fix", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const { start, sent } = scripted(
    loads("time"),
    { text: "", toolCalls: [call("set_tempo", { tempo: 9000 }, "bad")] },
    { text: "", toolCalls: [call("set_tempo", { tempo: 90 }, "good")] },
    says("Sorry, 9000 BPM was too fast."),
  );

  const outcome = await runRequest({ history, request: "as fast as possible", start });

  expect(sent[2]!.results).toEqual([
    { callId: "bad", content: expect.stringContaining("tempo must be a number from 20 to 999") as unknown as string, isError: true },
  ]);
  expect(outcome.error).toBeNull();
  expect(outcome.changes).toEqual(["Set the tempo to 90 BPM"]);
  expect(history.project.tempo).toBe(90);
  // The rejected call left no trace: one step, and it is the good tempo.
  history.undo();
  expect(history.project.tempo).toBe(120);
});

test("a Request that mixes and changes Insert Chains undoes in one step, out-of-range settings and all", async () => {
  const history = new ProjectHistory(sampleProject());
  const before = history.project;
  const { start, sent } = scripted(
    {
      text: "",
      toolCalls: [
        call("set_track_pan", { trackId: "keys", pan: -0.4 }, "pan"),
        call("set_track_mute", { trackId: "bass", mute: true }, "mute"),
        call("set_track_solo", { trackId: "vocals", solo: true }, "solo"),
        call("load_tools", { group: "sounds" }, "load"),
      ],
    },
    {
      text: "",
      toolCalls: [
        call("add_effect", { channel: "master", effect: "eq", index: 0 }, "add"),
        call("move_effect", { effectId: "keys-reverb", index: 0 }, "move"),
        call("remove_effect", { effectId: "master-comp" }, "remove"),
        call("set_effect_settings", { effectId: "keys-eq", settings: { band1GainDb: 40 } }, "loud"),
      ],
    },
    {
      text: "",
      toolCalls: [call("set_effect_settings", { effectId: "keys-eq", settings: { band1GainDb: -3 } }, "cut")],
    },
    says("Panned the keys, muted the bass, soloed the vocals and reworked the Insert Chains."),
  );

  const outcome = await runRequest({ history, request: "mix it", start });

  expect(outcome.error).toBeNull();
  expect(sent[2]!.results.find((result) => result.callId === "loud")).toEqual({
    callId: "loud",
    content: "The EQ's band1GainDb must be a number from -24 to 24 dB. Nothing was changed.",
    isError: true,
  });
  const [keys, bass, vocals] = history.project.tracks;
  expect(keys!.mixer.pan).toBe(-0.4);
  expect(bass!.mixer.mute).toBe(true);
  expect(vocals!.mixer.solo).toBe(true);
  expect(keys!.insertChain.map((effect) => effect.id)).toEqual(["keys-reverb", "keys-eq"]);
  expect(keys!.insertChain[1]!.settings).toMatchObject({ band1GainDb: -3 });
  expect(history.project.master.insertChain.map((effect) => effect.type)).toEqual(["eq"]);
  expect(outcome.changes).toHaveLength(7);

  expect(history.undoLabel).toBe("Request");
  expect(history.undo()).toBe(true);
  expect(history.project).toBe(before);
  expect(history.canUndo).toBe(false);
});

test("a Request that changes nothing leaves the undo history alone", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const { start } = scripted(says("You have no Tracks to rename."));

  const outcome = await runRequest({ history, request: "rename the drums", start });

  expect(outcome.changes).toEqual([]);
  expect(summarise(outcome)).toBe("Nothing changed.");
  expect(history.canUndo).toBe(false);
});

test("what the Assistant managed before an error is kept, as one undo step", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const outcome = await runRequest({ history, request: "add a kick", start: failsAfterOneTool });

  expect(outcome.error).toBe("Claude would not accept that API key. Check it and enter it again.");
  expect(outcome.changes).toEqual(["Added the Instrument Track “Kick”"]);
  expect(history.undoLabel).toBe("Request");
  history.undo();
  expect(history.project.tracks).toEqual([]);
});

test("the Assistant is stopped if it never finishes, and a tool call on its last turn is not made", async () => {
  const history = new ProjectHistory(createProject("Demo"));

  const outcome = await runRequest({ history, request: "go forever", start: () => ({ next: neverFinishes }) });

  expect(outcome.error).toBe(`The Assistant is still going after ${MAX_TURNS} turns, so it was stopped.`);
  expect(neverFinishes).toHaveBeenCalledTimes(MAX_TURNS + 1);
  expect(outcome.changes).toHaveLength(MAX_TURNS);
  expect(history.project.tracks).toHaveLength(MAX_TURNS);
});

test("a Request that uses every turn still ends with a summary, and its changes are one undo step", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const before = history.project;
  const volumes = Array.from({ length: MAX_TURNS }, (_, turn) => (turn + 1) / 20);
  const { start, sent } = scripted(
    ...volumes.map((volume) => ({ text: "Trying another level.", toolCalls: [call("set_master_volume", { volume }, `volume-${volume}`)] })),
    says(`Tried ${MAX_TURNS} levels and left the Master at ${volumes.at(-1)}; I ran out of turns before choosing one.`),
  );

  const outcome = await runRequest({ history, request: "find the right tempo", start });

  // Every turn is told how many it has left, and the last is for the summary.
  expect(sent.map(({ turnsLeft }) => turnsLeft)).toEqual(Array.from({ length: MAX_TURNS + 1 }, (_, turn) => MAX_TURNS - turn));
  expect(sent.at(-1)!.results).toEqual([
    { callId: `volume-${volumes.at(-1)}`, content: expect.stringContaining(`The Master is at volume ${volumes.at(-1)}`) as unknown as string, isError: false },
  ]);
  expect(outcome.error).toBeNull();
  expect(outcome.message).toBe(`Tried ${MAX_TURNS} levels and left the Master at ${volumes.at(-1)}; I ran out of turns before choosing one.`);
  expect(outcome.changes).toHaveLength(MAX_TURNS);
  expect(history.project.master.volume).toBe(volumes.at(-1));

  expect(history.undoLabel).toBe("Request");
  expect(history.undo()).toBe(true);
  expect(history.project).toBe(before);
  expect(history.canUndo).toBe(false);
});

test("the system prompt asks for independent calls in one turn, and says how many turns there are", () => {
  expect(SYSTEM_PROMPT).toContain("Make the calls that don't depend on each other's results together, in one turn, such as analyse_audio for each of several Tracks");
  expect(SYSTEM_PROMPT).toContain(`A Request has ${MAX_TURNS} turns with tools`);
});

test("the model reads the notes the summary only counts, then rewrites them, as one undo step", async () => {
  const history = new ProjectHistory(sampleProject());
  const before = history.project;
  const { start, sent } = scripted(
    { text: "", toolCalls: [call("read_notes", { clipId: "keys-1" }, "read"), call("load_tools", { group: "notes" }, "load")] },
    {
      text: "",
      toolCalls: [
        call("set_pattern_notes", {
          clipId: "keys-1",
          notes: [
            { pitch: 60, start: 0, length: 480, velocity: 0.8 },
            { pitch: 64, start: 960, length: 1920, velocity: 0.7 },
          ],
        }),
      ],
    },
    says("Held the last note of the Keys for two beats."),
  );

  const outcome = await runRequest({ history, request: "make the last note of the keys longer", start });

  // The summary counts the Clip's notes; read_notes gives each, with its id.
  expect(sent[0]!.request).toContain('"clips":[{"clipId":"keys-1","start":0,"length":3840,"notes":2}]');
  expect(sent[0]!.request).not.toContain('"velocity"');
  expect(sent[1]!.results[0]).toEqual(
    {
      callId: "read",
      content:
        'Clip keys-1 on Track keys (“Keys”), its 2 notes:\n[{"id":"0:60","pitch":60,"start":0,"length":480,"velocity":0.8},{"id":"960:64","pitch":64,"start":960,"length":480,"velocity":0.7}]',
      isError: false,
    },
  );
  // Reading, like loading tools, is not a change.
  expect(outcome.error).toBeNull();
  expect(outcome.changes).toHaveLength(1);
  const [keys] = history.project.tracks;
  expect(keys!.clips[0]).toMatchObject({ notes: [{ length: 480 }, { length: 1920 }] });
  expect(history.undo()).toBe(true);
  expect(history.project).toBe(before);
});

test("the system prompt says the Project is a summary, and names the read tools", () => {
  expect(SYSTEM_PROMPT).toContain("The Project below is a summary");
  for (const tool of ["read_channel", "read_automation", "read_notes"]) expect(SYSTEM_PROMPT).toContain(tool);
  expect(requestMessage("anything", createProject())).toMatch(/^A summary of the Project as it stands, whose detail the read tools return:\n/);
});

test("a Request starts with the core tools, and a group's tools are sent from the turn after load_tools", async () => {
  const history = new ProjectHistory(sampleProject());
  const { start, sent } = scripted(
    { text: "", toolCalls: [call("load_tools", { group: "sounds" }, "load")] },
    { text: "", toolCalls: [call("add_effect", { channel: "master", effect: "eq" }, "add")] },
    says("Added an EQ to the Master."),
  );

  const outcome = await runRequest({ history, request: "put an EQ on the Master", start });

  expect(outcome.error).toBeNull();
  expect(sent[0]!.tools).toEqual(CORE_TOOL_DEFINITIONS.map((tool) => tool.name));
  expect(sent[0]!.tools).not.toContain("add_effect");
  expect(sent[1]!.results).toEqual([
    {
      callId: "load",
      content: `The sounds tools are loaded for the rest of the Request, to call from your next turn: ${groupToolNames("sounds").join(", ")}.`,
      isError: false,
    },
  ]);
  // Loaded for the rest of the Request, the summary turn included.
  const withSounds = toolDefinitions(["sounds"]).map((tool) => tool.name);
  expect(withSounds).toEqual(expect.arrayContaining([...CORE_TOOL_DEFINITIONS.map((tool) => tool.name), ...groupToolNames("sounds")]));
  for (const turn of [sent[1]!, sent[2]!]) expect(turn.tools).toEqual(withSounds);
  expect(sent[2]!.results).toEqual([expect.objectContaining({ callId: "add", isError: false })]);
  expect(outcome.changes).toEqual(["Added an EQ to the Master"]);
  expect(history.project.master.insertChain.map((effect) => effect.type)).toEqual(["compressor", "eq"]);
});

test("a group's tool called before its group is loaded changes nothing, and the model is told to load it", async () => {
  const history = new ProjectHistory(sampleProject());
  const before = history.project;
  const { start, sent } = scripted(
    { text: "", toolCalls: [call("add_effect", { channel: "master", effect: "eq" }, "add")] },
    says("I need the sounds tools first."),
  );

  const outcome = await runRequest({ history, request: "put an EQ on the Master", start });

  expect(sent[1]!.results).toEqual([
    {
      callId: "add",
      content: 'add_effect is one of the sounds tools, which aren\'t loaded: call load_tools with group "sounds", then call add_effect in a later turn. Nothing was changed.',
      isError: true,
    },
  ]);
  expect(outcome.changes).toEqual([]);
  expect(history.project).toBe(before);
});

test("loading a group says which tools it adds, and an unknown group is refused", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const { start, sent } = scripted(
    { text: "", toolCalls: [call("load_tools", { group: "audio_clips" }, "audio"), call("load_tools", { group: "mixing" }, "unknown")] },
    says("The audio tools are loaded."),
  );

  await runRequest({ history, request: "put the take on the vocals", start });

  expect(sent[1]!.results).toEqual([
    {
      callId: "audio",
      content: expect.stringContaining("list_samples, place_audio_clip, trim_audio_clip, copy_audio_clip") as unknown as string,
      isError: false,
    },
    { callId: "unknown", content: expect.stringContaining("group must be one of notes, routing") as unknown as string, isError: true },
  ]);
  expect(sent[1]!.tools).toEqual(toolDefinitions(["audio_clips"]).map((tool) => tool.name));
});

test("the system prompt names the core tools and lists every group, with what it is for and its tools", () => {
  expect(SYSTEM_PROMPT).toContain(`You start with the core tools: ${CORE_TOOL_DEFINITIONS.map((tool) => tool.name).join(", ")}.`);
  for (const [group, purpose] of Object.entries(TOOL_GROUPS)) expect(SYSTEM_PROMPT).toContain(`- ${group}: ${purpose} (`);
  expect(SYSTEM_PROMPT).toContain(`- sounds: ${TOOL_GROUPS.sounds} (${groupToolNames("sounds").join(", ")}).`);
  expect(SYSTEM_PROMPT).toContain(`- automation: ${TOOL_GROUPS.automation} (set_automation, clear_automation).`);
  expect(SYSTEM_PROMPT).toContain(
    `- audio_clips: ${TOOL_GROUPS.audio_clips} (list_samples, place_audio_clip, trim_audio_clip, copy_audio_clip, separate_stems).`,
  );
});

test("a Request adds up the tokens each turn cost, and says what it is doing as it goes", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const { start } = scripted(
    {
      text: "",
      toolCalls: [call("create_track", { name: "Kick", kind: "instrument" }, "a"), call("load_tools", { group: "time" }, "b")],
      usage: { input: 1000, output: 50 },
    },
    // A turn a server sent no usage for counts none.
    { text: "", toolCalls: [call("set_tempo", { tempo: 128 }, "c")] },
    { ...says("Done."), usage: { input: 1200, output: 20 } },
  );
  const seen: RequestStatus[] = [];

  const outcome = await runRequest({ history, request: "a kick at 128", start, onStatus: (status) => seen.push(status) });

  expect(outcome.usage).toEqual({ input: 2200, output: 70 });
  // A turn with no usage leaves the context as the turn before left it.
  expect(seen).toEqual([
    { turn: 1, doing: { kind: "thinking" }, usage: { input: 0, output: 0 }, context: 0 },
    { turn: 1, doing: { kind: "tool", name: "create_track" }, usage: { input: 1000, output: 50 }, context: 1050 },
    { turn: 1, doing: { kind: "tool", name: "load_tools" }, usage: { input: 1000, output: 50 }, context: 1050 },
    { turn: 2, doing: { kind: "thinking" }, usage: { input: 1000, output: 50 }, context: 1050 },
    { turn: 2, doing: { kind: "tool", name: "set_tempo" }, usage: { input: 1000, output: 50 }, context: 1050 },
    { turn: 3, doing: { kind: "thinking" }, usage: { input: 1000, output: 50 }, context: 1050 },
  ]);
  // The last turn held the most: everything before it, and its own reply.
  expect(outcome.context).toBe(1220);
});

/** Adds one Track, at a cost, then the API call fails. */
const costsThenFails: StartConversation = () => ({
  next: vi
    .fn<Conversation["next"]>()
    .mockResolvedValueOnce({ text: "", toolCalls: [call("create_track", { name: "Kick", kind: "instrument" })], usage: { input: 900, output: 40 } })
    .mockRejectedValueOnce(new Error("Claude is busy with your other requests. Try again shortly.")),
});

test("a Request that fails still says what it cost up to then", async () => {
  const history = new ProjectHistory(createProject("Demo"));

  const outcome = await runRequest({ history, request: "add a kick", start: costsThenFails });

  expect(outcome.error).toMatch(/busy/);
  expect(outcome.usage).toEqual({ input: 900, output: 40 });
});

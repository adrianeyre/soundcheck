/**
 * The routing story of the v3 PRD, as the tool calls a model would make for
 * it: Buses added, Tracks routed to them and Sends set, all as one Request
 * that one undo takes back, and a loop refused as the mixer refuses it.
 */
import { expect, test } from "vitest";

import { EngineSync } from "../project/engine-sync";
import { sampleProject } from "../project/fixtures";
import { ProjectHistory } from "../project/history";
import { routingProblem, sendProblem } from "../project/routing";
import { runRequest, type Conversation, type ModelReply, type StartConversation, type ToolResult } from "./assistant";
import type { ToolCall } from "./tools";

/** Each turn of the script sees the results of the one before. */
function scripted(...turns: ((results: readonly ToolResult[]) => ModelReply)[]): StartConversation {
  return () => {
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
}

function call(id: string, name: string, input: unknown): ToolCall {
  return { id, name, input };
}

function succeeded(results: readonly ToolResult[]): void {
  const failed = results.filter((result) => result.isError);
  if (failed.length > 0) throw new Error(`a call failed: ${failed.map((result) => result.content).join(" ")}`);
}

/** The busId add_bus reported, as a model would read it. */
function busIdFrom(results: readonly ToolResult[], callId: string): string {
  const content = results.find((result) => result.callId === callId)?.content ?? "";
  const id = /whose busId is (\S+?)\./.exec(content)?.[1];
  if (!id) throw new Error(`add_bus reported no busId: ${content}`);
  return id;
}

test("“put the drums on a bus and add some reverb to it with a send from the vocals” is one Request and one undo", async () => {
  // The fixture's Drums output to the Master; its Vocals already send to Band.
  const history = new ProjectHistory(sampleProject());
  const before = history.project;
  let drumBus = "";
  let reverbBus = "";
  const start = scripted(
    () => ({
      text: "",
      toolCalls: [call("g1", "load_tools", { group: "routing" }), call("g2", "load_tools", { group: "sounds" })],
    }),
    (results) => {
      succeeded(results);
      return {
        text: "",
        toolCalls: [call("b1", "add_bus", { name: "Drum Bus" }), call("b2", "add_bus", { name: "Reverb" })],
      };
    },
    (results) => {
      succeeded(results);
      drumBus = busIdFrom(results, "b1");
      reverbBus = busIdFrom(results, "b2");
      return {
        text: "",
        toolCalls: [
          call("o1", "set_output", { channel: "drums", target: drumBus }),
          call("e1", "add_effect", { channel: reverbBus, effect: "reverb" }),
          call("s1", "add_send", { channel: drumBus, busId: reverbBus, level: 0.25 }),
          call("s2", "add_send", { channel: "vocals", busId: reverbBus, level: 0.5 }),
        ],
      };
    },
    (results) => {
      succeeded(results);
      return { text: "Put the drums on a Drum Bus and sent it and the vocals to a new Reverb Bus.", toolCalls: [] };
    },
  );

  const outcome = await runRequest({
    history,
    request: "put the drums on a bus and add some reverb to it with a send from the vocals",
    start,
  });
  expect(outcome.error).toBeNull();
  const after = history.project;
  expect(after.buses.map((bus) => [bus.id, bus.name, bus.output, bus.sends])).toEqual([
    ["band", "Band", null, []],
    [drumBus, "Drum Bus", null, [{ busId: reverbBus, level: 0.25 }]],
    [reverbBus, "Reverb", null, []],
  ]);
  expect(after.buses[2]!.insertChain.map((effect) => effect.type)).toEqual(["reverb"]);
  const drums = after.tracks.find((track) => track.id === "drums")!;
  const vocals = after.tracks.find((track) => track.id === "vocals")!;
  expect(drums.output).toBe(drumBus);
  expect(vocals.sends).toEqual([
    { busId: "band", level: 0.5 },
    { busId: reverbBus, level: 0.5 },
  ]);
  expect(outcome.changes).toEqual([
    "Added the Bus “Drum Bus”",
    "Added the Bus “Reverb”",
    "Routed “Drums” to the Bus “Drum Bus”",
    "Added a Reverb to the Bus “Reverb”",
    "Added a Send from the Bus “Drum Bus” to the Bus “Reverb” at -12.0 dB",
    "Added a Send from “Vocals” to the Bus “Reverb” at -6.0 dB",
  ]);

  // The Audio Engine hears the new routing: Drums, its fourth Track, into
  // the second Bus, and Vocals sending to the third as well as the first.
  const sync = new EngineSync();
  sync.update(before, new Map());
  const sent = sync.update(after, new Map());
  expect(sent).toContainEqual(expect.objectContaining({ type: "setBusCount", count: 3 }));
  expect(sent).toContainEqual(expect.objectContaining({ type: "setTrackOutput", track: 3 }));

  // Every Request is one undo step, whatever it did.
  expect(history.undoLabel).toBe("Request");
  expect(history.undo()).toBe(true);
  expect(history.project).toEqual(before);
  expect(history.canUndo).toBe(false);
});

test("a loop by output or by Send is refused with the mixer's message, and nothing changes", async () => {
  const project = sampleProject();
  project.buses.push({ ...project.buses[0]!, id: "drum-bus", name: "Drum Bus", insertChain: [], output: "band", sends: [] });
  const history = new ProjectHistory(project);
  const before = history.project;
  const start = scripted(
    () => ({ text: "", toolCalls: [call("g1", "load_tools", { group: "routing" })] }),
    () => ({
      text: "",
      toolCalls: [
        call("o1", "set_output", { channel: "band", target: "drum-bus" }),
        call("s1", "add_send", { channel: "band", busId: "drum-bus" }),
      ],
    }),
    (results) => {
      // What the mixer shows on the Output and Send it won't let the musician pick.
      const output = routingProblem(before, { busId: "band" }, "drum-bus")!;
      const send = sendProblem(before, { busId: "band" }, "drum-bus")!;
      expect(output).toMatch(/would go round in a loop \(Band → Drum Bus → Band\)/);
      expect(results).toEqual([
        { callId: "o1", content: `${output}. Nothing was changed.`, isError: true },
        { callId: "s1", content: `${send}. Nothing was changed.`, isError: true },
      ]);
      return { text: "Band can't feed Drum Bus: Drum Bus already feeds Band.", toolCalls: [] };
    },
  );
  const outcome = await runRequest({ history, request: "send the band bus into the drum bus", start });
  expect(outcome.error).toBeNull();
  expect(outcome.changes).toEqual([]);
  expect(history.project).toEqual(before);
});

/**
 * Conversations: a follow-up Request is sent the earlier ones, what the
 * Assistant replied and the changes each made, not their tool calls, and is
 * told when one has been undone or redone since. The model is scripted; no
 * test calls a real API.
 */
import { expect, test } from "vitest";

import { ProjectHistory } from "../project/history";
import { createInstrumentTrack, createProject, type Project } from "../project/model";
import {
  runRequest,
  type ConversationSoFar,
  type FinishedRequest,
  type ModelReply,
  type StartConversation,
  type ToolResult,
} from "./assistant";
import { earlierExchanges, MAX_CONVERSATION_CHARACTERS, requestMessage } from "./context";
import type { ToolCall, ToolDefinition } from "./tools";

type Turn = (results: readonly ToolResult[]) => ModelReply;

/** What one Request sent the model: its first message, the earlier Requests before it, and each turn's tools. */
interface Sent {
  message: string;
  earlier: ReturnType<typeof earlierExchanges>;
  conversation: ConversationSoFar | undefined;
  tools: (readonly ToolDefinition[])[];
  results: (readonly ToolResult[])[];
}

/** The model, scripted one Request after another: each `start` plays the next script. */
function scripted(...requests: Turn[][]) {
  const sent: Sent[] = [];
  let index = 0;
  const start: StartConversation = (request, project, library, conversation) => {
    const turns = requests[index++];
    if (!turns) throw new Error("more Requests were made than the script has");
    const one: Sent = {
      message: requestMessage(request, project, library, conversation),
      earlier: earlierExchanges(conversation),
      conversation,
      tools: [],
      results: [],
    };
    sent.push(one);
    let turn = 0;
    return {
      next(results, _turnsLeft, tools) {
        one.tools.push(tools);
        one.results.push(results);
        const reply = turns[turn++];
        if (!reply) throw new Error("the Assistant asked for more turns than the script has");
        return Promise.resolve(reply(results));
      },
    };
  };
  return { start, sent };
}

function call(id: string, name: string, input: unknown): ToolCall {
  return { id, name, input };
}

function calls(...toolCalls: ToolCall[]): Turn {
  return (results) => {
    const failed = results.filter((result) => result.isError);
    if (failed.length > 0) throw new Error(failed.map((result) => result.content).join("\n"));
    return { text: "", toolCalls };
  };
}

function says(text: string): Turn {
  return (results) => {
    const failed = results.filter((result) => result.isError);
    if (failed.length > 0) throw new Error(failed.map((result) => result.content).join("\n"));
    return { text, toolCalls: [] };
  };
}

function withVocals(): Project {
  return { ...createProject("Demo"), tracks: [createInstrumentTrack("Vocals", "vocals")] };
}

/** Runs each Request in turn in one Conversation, as the Request box does. */
async function converse(history: ProjectHistory, start: StartConversation, conversation: FinishedRequest[], request: string) {
  const outcome = await runRequest({ history, request, start, conversation });
  conversation.push({ request, outcome });
  return outcome;
}

const ADD_REVERB = [
  calls(call("a", "load_tools", { group: "sounds" })),
  calls(call("b", "add_effect", { channel: "vocals", effect: "reverb" })),
  says("I added a reverb to the vocals."),
];

test("a follow-up changes what the Request before it made, and is sent its summary, not its tool calls", async () => {
  const history = new ProjectHistory(withVocals());
  const reverbId = () => history.project.tracks[0]!.insertChain[0]!.id;
  const { start, sent } = scripted(ADD_REVERB, [
    // The sounds tools are still loaded: no load_tools this time.
    (results) => calls(call("c", "set_effect_settings", { effectId: reverbId(), settings: { damping: 0.9 } }))(results),
    says("I made the reverb darker."),
  ]);
  const conversation: FinishedRequest[] = [];

  await converse(history, start, conversation, "add a reverb to the vocals");
  const followUp = await converse(history, start, conversation, "make it darker");

  expect(followUp.error).toBeNull();
  const chain = history.project.tracks[0]!.insertChain;
  expect(chain).toHaveLength(1);
  expect(chain[0]!.type).toBe("reverb");
  expect(chain[0]!.settings).toMatchObject({ damping: 0.9 });

  // The first Request goes before the second as what was asked and what the Assistant said it did.
  const [earlier] = sent[1]!.earlier;
  expect(sent[1]!.earlier).toHaveLength(1);
  expect(earlier!.request).toBe("add a reverb to the vocals");
  expect(earlier!.reply).toContain("I added a reverb to the vocals.");
  expect(earlier!.reply).toContain(`What this Request changed: ${conversation[0]!.outcome.changes[0]}.`);
  expect(conversation[0]!.outcome.changes[0]).toBe("Added a Reverb to “Vocals”");
  // None of its tool traffic: not the calls, not what they reported.
  const everything = JSON.stringify(sent[1]!.earlier);
  expect(everything).not.toMatch(/load_tools|add_effect|effectId/);
  expect(everything).not.toContain(sent[0]!.results[2]![0]!.content);

  // The first Request had no Conversation before it; the second is told the groups still loaded.
  expect(sent[0]!.earlier).toEqual([]);
  expect(sent[0]!.message).not.toMatch(/still loaded/);
  expect(sent[1]!.message).toMatch(/tool groups loaded earlier in this Conversation are still loaded: sounds\./);
  expect(sent[1]!.tools[0]!.map((tool) => tool.name)).toContain("set_effect_settings");
  expect(sent[1]!.message).not.toMatch(/undone/);

  // Each is still its own undo step.
  history.undo();
  expect(history.project.tracks[0]!.insertChain[0]!.settings).not.toMatchObject({ damping: 0.9 });
  expect(history.project.tracks[0]!.insertChain).toHaveLength(1);
  history.undo();
  expect(history.project.tracks[0]!.insertChain).toEqual([]);
});

test("a follow-up is told an earlier Request was undone, and later that it was redone", async () => {
  const history = new ProjectHistory(withVocals());
  const { start, sent } = scripted(ADD_REVERB, [says("Nothing to do.")], [says("Nothing to do.")], [says("Nothing to do.")]);
  const conversation: FinishedRequest[] = [];

  const first = await converse(history, start, conversation, "add a reverb to the vocals");
  history.undo();
  expect(first.undone()).toBe(true);

  await converse(history, start, conversation, "what did you just do?");
  expect(sent[1]!.conversation?.earlier[0]?.since).toBe("undone");
  expect(sent[1]!.message).toContain(
    'The musician has undone the earlier Request "add a reverb to the vocals", so none of its changes are in the Project now.',
  );

  // Still undone: still told, so the model doesn't think the reverb is there.
  await converse(history, start, conversation, "and now?");
  expect(sent[2]!.message).toContain("The musician has undone the earlier Request");

  // The Requests since changed nothing, so the first can be redone.
  history.redo();
  expect(first.undone()).toBe(false);
  await converse(history, start, conversation, "and now?");
  expect(sent[3]!.conversation?.earlier[0]?.since).toBe("redone");
  expect(sent[3]!.message).toContain(
    'The musician undid the earlier Request "add a reverb to the vocals" and has redone it since, so its changes are in the Project again.',
  );
  expect(sent[3]!.message).not.toContain("The musician has undone");
});

test("a long Conversation drops its oldest Requests first, to stay under the cap", async () => {
  const history = new ProjectHistory(withVocals());
  // Each reply is a fifth of the cap, so only the latest four fit.
  const long = "x".repeat(MAX_CONVERSATION_CHARACTERS / 5);
  const { start, sent } = scripted(...Array.from({ length: 7 }, () => [says(long)]));
  const conversation: FinishedRequest[] = [];

  for (let request = 1; request <= 7; request++) await converse(history, start, conversation, `Request ${request}`);

  expect(sent[6]!.earlier.map(({ request }) => request)).toEqual(["Request 3", "Request 4", "Request 5", "Request 6"]);
  expect(sent[6]!.message).toContain("The first 2 Requests of this Conversation are left out, to keep it short.");
  const characters = sent[6]!.earlier.reduce((total, { request, reply }) => total + request.length + reply.length, 0);
  expect(characters).toBeLessThanOrEqual(MAX_CONVERSATION_CHARACTERS);
});

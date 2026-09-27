import { expect, test } from "vitest";

import { createProject } from "../project/model";
import { MAX_TURNS } from "./assistant";
import { ASSISTANT_MODEL, claudeConversations } from "./claude";
import { clientOptions } from "./connection";
import { turnsLeftNote } from "./context";
import { CORE_TOOL_DEFINITIONS } from "./tools";

/** One reply's worth of Claude's JSON, with only the parts read here. */
function message(content: unknown[], stopReason = "tool_use") {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: ASSISTANT_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/**
 * Claude's HTTP, replaced by a stub. Every reply is scripted and every
 * request is kept, so no test calls the real API.
 */
function stubbed(...replies: { status?: number; body: unknown }[]) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  let turn = 0;
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies[turn++];
    if (!reply) throw new Error("Claude was asked for more replies than the script has");
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  // Nothing is retried: a test that fails should say so at once.
  return { conversations: claudeConversations("sk-test", { fetch, maxRetries: 0 }), sent };
}

test("a Request goes to Claude with the tools and the Project, and its tool calls come back", async () => {
  const { conversations, sent } = stubbed({
    body: message([
      { type: "text", text: "Setting that up." },
      { type: "tool_use", id: "toolu_1", name: "set_tempo", input: { tempo: 128 } },
    ]),
  });

  const conversation = conversations("make it 128", createProject("Demo"));
  const reply = await conversation.next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);

  expect(reply.text).toBe("Setting that up.");
  expect(reply.toolCalls).toEqual([{ id: "toolu_1", name: "set_tempo", input: { tempo: 128 } }]);

  // The Messages API, wherever the SDK is pointed.
  expect(sent[0]!.url).toContain("/v1/messages");
  expect(sent[0]!.body.model).toBe("claude-opus-5-5");
  expect(sent[0]!.body.tools).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "create_track" })]) as unknown,
  );
  expect(JSON.stringify(sent[0]!.body.messages)).toContain("make it 128");
  expect(String(sent[0]!.body.system)).toContain("Soundcheck");
});

test("what a tool did is sent back as the result of that call", async () => {
  const toolUse = { type: "tool_use", id: "toolu_1", name: "set_tempo", input: { tempo: 128 } };
  const { conversations, sent } = stubbed(
    { body: message([toolUse]) },
    { body: message([{ type: "text", text: "Done." }], "end_turn") },
  );

  const conversation = conversations("make it 128", createProject("Demo"));
  await conversation.next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);
  const reply = await conversation.next([{ callId: "toolu_1", content: "The tempo is now 128 BPM.", isError: false }], MAX_TURNS - 1, CORE_TOOL_DEFINITIONS);

  expect(reply.toolCalls).toEqual([]);
  expect(reply.text).toBe("Done.");
  // The model's own turn goes back unchanged, then the result of its call.
  expect(sent[1]!.body.messages).toEqual([
    expect.objectContaining({ role: "user" }) as unknown,
    { role: "assistant", content: [toolUse] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "The tempo is now 128 BPM.", is_error: false },
        { type: "text", text: turnsLeftNote(MAX_TURNS - 1) },
      ],
    },
  ]);
  expect(sent[1]!.body.tool_choice).toBeUndefined();
});

/** The last block of the last message sent. */
function lastBlock(messages: unknown): unknown {
  return (messages as { content: unknown[] }[]).at(-1)!.content.at(-1);
}

test("each turn's results tell Claude how many turns it has left, and the last has no tools", async () => {
  const toolUse = { type: "tool_use", id: "toolu_1", name: "set_tempo", input: { tempo: 128 } };
  const { conversations, sent } = stubbed(
    { body: message([toolUse]) },
    { body: message([{ ...toolUse, id: "toolu_2" }]) },
    { body: message([{ type: "text", text: "Set the tempo to 128 BPM." }], "end_turn") },
  );

  const conversation = conversations("make it 128", createProject("Demo"));
  await conversation.next([], 2, CORE_TOOL_DEFINITIONS);
  await conversation.next([{ callId: "toolu_1", content: "The tempo is now 128 BPM.", isError: false }], 1, CORE_TOOL_DEFINITIONS);
  const reply = await conversation.next([{ callId: "toolu_2", content: "The tempo is now 128 BPM.", isError: false }], 0, CORE_TOOL_DEFINITIONS);

  expect(reply.text).toBe("Set the tempo to 128 BPM.");
  expect(lastBlock(sent[1]!.body.messages)).toEqual({ type: "text", text: "This is your last turn with tools; then one more, without tools, to write your summary." });
  expect(sent[1]!.body.tool_choice).toBeUndefined();
  expect(lastBlock(sent[2]!.body.messages)).toEqual({ type: "text", text: turnsLeftNote(0) });
  expect(turnsLeftNote(0)).toMatch(/no turns with tools left/);
  // The tools are still defined, for the calls already made, but can't be called.
  expect(sent[2]!.body.tools).toEqual(sent[0]!.body.tools);
  expect(sent[2]!.body.tool_choice).toEqual({ type: "none" });
});

test("a spectrogram goes back as an image in the result of the call that asked for it", async () => {
  const toolUse = { type: "tool_use", id: "toolu_1", name: "analyse_audio", input: { spectrogram: true } };
  const { conversations, sent } = stubbed(
    { body: message([toolUse]) },
    { body: message([{ type: "text", text: "The low mids are crowded." }], "end_turn") },
  );

  const conversation = conversations("why is it muddy?", createProject("Demo"));
  await conversation.next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);
  await conversation.next([{ callId: "toolu_1", content: "The whole mix, measured:\n{}", isError: false, image: "iVBORw0KGgo=" }], MAX_TURNS - 1, CORE_TOOL_DEFINITIONS);

  expect((sent[1]!.body.messages as unknown[])[2]).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [
          { type: "text", text: "The whole mix, measured:\n{}" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        ],
        is_error: false,
      },
      { type: "text", text: turnsLeftNote(MAX_TURNS - 1) },
    ],
  });
});

test("a key Claude will not accept is said so in words the musician can act on", async () => {
  const { conversations } = stubbed({
    status: 401,
    body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
  });

  await expect(conversations("add a kick", createProject()).next([], MAX_TURNS, CORE_TOOL_DEFINITIONS)).rejects.toThrow(
    "Claude would not accept that API key. Check it and enter it again.",
  );
});

test("a Request Claude declines stops the Request rather than looking like nothing to do", async () => {
  const { conversations } = stubbed({ body: message([], "refusal") });

  await expect(conversations("do something else", createProject()).next([], MAX_TURNS, CORE_TOOL_DEFINITIONS)).rejects.toThrow(/declined this Request/);
});

test("a connection's base URL and custom headers go on the request", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return Promise.resolve(
      new Response(JSON.stringify(message([{ type: "text", text: "Done." }], "end_turn")), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const options = clientOptions({
    apiKey: "sk-test",
    baseUrl: "https://gateway.example.com",
    customHeaders: "x-team: audio",
  });
  const conversations = claudeConversations("sk-test", { ...options, fetch, maxRetries: 0 });

  await conversations("hello", createProject("Demo")).next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);

  expect(seen[0]?.url).toBe("https://gateway.example.com/v1/messages");
  expect(seen[0]?.headers.get("x-team")).toBe("audio");
  expect(seen[0]?.headers.get("x-api-key")).toBe("sk-test");
});

test("the chosen model and effort go on the request, with effort left off for Haiku", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Promise.resolve(
      new Response(JSON.stringify(message([{ type: "text", text: "Done." }], "end_turn")), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const ask = (choice: Parameters<typeof claudeConversations>[2]) =>
    claudeConversations("sk-test", { fetch, maxRetries: 0 }, choice)("hello", createProject("Demo")).next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);

  await ask({});
  await ask({ model: "claude-sonnet-5", effort: "xhigh" });
  await ask({ model: "claude-haiku-4-5", effort: "low" });

  expect(bodies.map((body) => [body.model, body.output_config])).toEqual([
    [ASSISTANT_MODEL, undefined],
    ["claude-sonnet-5", { effort: "xhigh" }],
    ["claude-haiku-4-5", undefined],
  ]);
});

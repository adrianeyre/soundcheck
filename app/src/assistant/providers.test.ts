import { expect, test } from "vitest";

import { createProject } from "../project/model";
import { MAX_TURNS, withoutAudio, withoutImage, type ConversationSoFar, type ToolResult } from "./assistant";
import type { ProviderId } from "./catalogue";
import type { Connection } from "./connection";
import { turnsLeftNote } from "./context";
import { conversationsFor, exchangesFor } from "./providers";
import { declareCapabilities, addTextOnlyModel, TEXT_ONLY_MODEL } from "./test-catalogue";
import { AUDIO_ATTACHED, CORE_TOOL_DEFINITIONS, SPECTROGRAM_ATTACHED, toolDefinitions } from "./tools";

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/**
 * A provider's HTTP, replaced by a stub: every reply is scripted and every
 * request kept, so no test calls a real API. It stands where the platform's
 * `fetch` does, so what it sees is what goes out on the desktop.
 */
function stubbed(...replies: unknown[]) {
  const sent: Sent[] = [];
  let turn = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies[turn++];
    if (reply === undefined) throw new Error("The model was asked for more replies than the script has");
    const request = new Request(input, init);
    sent.push({ url: request.url, headers: request.headers, body: (await request.json()) as Record<string, unknown> });
    return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } });
  };
  return { fetch, sent };
}

const GATEWAY: Connection = {
  apiKey: "sk-test",
  baseUrl: "https://gateway.example.com/v1",
  customHeaders: "x-team: audio",
};

/** The spectrogram `analyse_audio` sends back, as a base64 PNG. */
const PNG = "iVBORw0KGgo=";

/** What a model that can't see images is told instead. */
const NO_IMAGE_NOTE = withoutImage({ callId: "", content: "", isError: false, image: PNG }).content.trim();

const RESULTS: ToolResult[] = [
  { callId: "call_1", content: "Tempo set to 128 BPM.", isError: false },
  { callId: "call_2", content: "The mix, bars 1-4:\nPeak -3 dB", isError: false, image: PNG },
];

/** One OpenAI Chat Completions reply. */
function completion(message: Record<string, unknown>) {
  return {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 0,
    model: "gpt-6-astra",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: null, ...message } }],
  };
}

const OPENAI_CALLS = completion({
  content: "Setting that up.",
  tool_calls: [
    { id: "call_1", type: "function", function: { name: "set_tempo", arguments: '{"tempo":128}' } },
    { id: "call_2", type: "function", function: { name: "analyse_audio", arguments: '{"trackId":""}' } },
  ],
});

/** The turns left when the results go back: one used, or, at 0, the last turn, with no tools. */
const TURNS_LEFT = MAX_TURNS - 1;

async function roundTrip(
  provider: ProviderId,
  connection: Connection,
  turnsLeft: number,
  ...replies: unknown[]
): ReturnType<typeof roundTripWith> {
  return roundTripWith(RESULTS, provider, connection, turnsLeft, ...replies);
}

async function roundTripWith(
  results: readonly ToolResult[],
  provider: ProviderId,
  connection: Connection,
  turnsLeft: number,
  ...replies: unknown[]
) {
  const { fetch, sent } = stubbed(...replies);
  const conversation = conversationsFor(provider, connection, fetch)("make it 128", createProject("Demo"));
  const first = await conversation.next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);
  // Each result answers the call it came from, by the id the reply gave it.
  const second = await conversation.next(
    results.map((result, index) => ({ ...result, callId: first.toolCalls[index]!.id })),
    turnsLeft,
    CORE_TOOL_DEFINITIONS,
  );
  return { first, second, sent };
}

test("OpenAI: a Request goes to the gateway with the key, headers and tools, and comes back as tool calls", async () => {
  const { first, second, sent } = await roundTrip(
    "openai",
    { ...GATEWAY, effort: "high" },
    TURNS_LEFT,
    OPENAI_CALLS,
    completion({ content: "Done." }),
  );

  expect(first.text).toBe("Setting that up.");
  expect(first.toolCalls).toEqual([
    { id: "call_1", name: "set_tempo", input: { tempo: 128 } },
    { id: "call_2", name: "analyse_audio", input: { trackId: "" } },
  ]);
  expect(second).toEqual({ text: "Done.", toolCalls: [] });

  expect(sent[0]!.url).toBe("https://gateway.example.com/v1/chat/completions");
  expect(sent[0]!.headers.get("authorization")).toBe("Bearer sk-test");
  expect(sent[0]!.headers.get("x-team")).toBe("audio");
  expect(sent[0]!.body.model).toBe("gpt-6-astra");
  expect(sent[0]!.body.reasoning_effort).toBe("high");
  expect(sent[0]!.body.tools).toHaveLength(CORE_TOOL_DEFINITIONS.length);
  expect((sent[0]!.body.tools as unknown[])[0]).toEqual({
    type: "function",
    function: {
      name: CORE_TOOL_DEFINITIONS[0]!.name,
      description: CORE_TOOL_DEFINITIONS[0]!.description,
      parameters: CORE_TOOL_DEFINITIONS[0]!.input_schema,
    },
  });

  // The results go back as tool messages, the spectrogram as an image after
  // them, and then the turns left.
  const messages = sent[1]!.body.messages as Record<string, unknown>[];
  expect(messages.slice(-4)).toEqual([
    { role: "tool", tool_call_id: "call_1", content: "Tempo set to 128 BPM." },
    { role: "tool", tool_call_id: "call_2", content: "The mix, bars 1-4:\nPeak -3 dB" },
    {
      role: "user",
      content: [
        { type: "text", text: "The spectrogram from tool call call_2:" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    },
    { role: "user", content: turnsLeftNote(TURNS_LEFT) },
  ]);
  expect(sent[1]!.body.tool_choice).toBeUndefined();
});

test("OpenAI: an effort the model doesn't take is left off", async () => {
  const { fetch, sent } = stubbed(completion({ content: "Done." }));
  await conversationsFor("openai", { apiKey: "sk-test", effort: "none" }, fetch)("hi", createProject("Demo")).next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);

  expect(sent[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
  expect(sent[0]!.body.reasoning_effort).toBeUndefined();
});

test("Local: no key is needed, Ollama is the default server, and tool results go back as text alone", async () => {
  const { first, sent } = await roundTrip(
    "local",
    { apiKey: "", customHeaders: "x-team: audio", model: "qwen3:8b" },
    TURNS_LEFT,
    OPENAI_CALLS,
    completion({ content: "Done." }),
  );

  expect(first.toolCalls.map((call) => call.name)).toEqual(["set_tempo", "analyse_audio"]);
  expect(sent[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
  expect(sent[0]!.headers.get("x-team")).toBe("audio");
  expect(sent[0]!.body.model).toBe("qwen3:8b");
  expect(sent[0]!.body.tools).toHaveLength(CORE_TOOL_DEFINITIONS.length);

  // It declares no image input, so the spectrogram is left out, and it is told so.
  const messages = sent[1]!.body.messages as Record<string, unknown>[];
  expect(messages.slice(-3)).toEqual([
    { role: "tool", tool_call_id: "call_1", content: "Tempo set to 128 BPM." },
    { role: "tool", tool_call_id: "call_2", content: `The mix, bars 1-4:\nPeak -3 dB\n${NO_IMAGE_NOTE}` },
    { role: "user", content: turnsLeftNote(TURNS_LEFT) },
  ]);
});

test("Local: a base URL points it at another server, such as llama.cpp's", async () => {
  const { fetch, sent } = stubbed(completion({ content: "Done." }));
  const connection = { apiKey: "", baseUrl: "http://127.0.0.1:8080/v1" };
  await conversationsFor("local", connection, fetch)("hi", createProject("Demo")).next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);

  expect(sent[0]!.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
});

/** One Gemini generateContent reply. */
function generated(parts: unknown[]) {
  return { candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts } }] };
}

test("Gemini: a Request goes to the gateway with the key, headers and tools, and comes back as tool calls", async () => {
  const { first, second, sent } = await roundTrip(
    "gemini",
    { ...GATEWAY, baseUrl: "https://gateway.example.com", effort: "low" },
    TURNS_LEFT,
    generated([
      { text: "Setting that up." },
      { functionCall: { id: "call_1", name: "set_tempo", args: { tempo: 128 } }, thoughtSignature: "sig" },
      // Gemini needn't give a call an id; the Assistant gives it one.
      { functionCall: { name: "analyse_audio", args: { trackId: "" } } },
    ]),
    generated([{ text: "Done." }]),
  );

  expect(first.text).toBe("Setting that up.");
  expect(first.toolCalls).toEqual([
    { id: "call_1", name: "set_tempo", input: { tempo: 128 } },
    { id: "call_2_2", name: "analyse_audio", input: { trackId: "" } },
  ]);
  expect(second).toEqual({ text: "Done.", toolCalls: [] });

  expect(sent[0]!.url).toMatch(/^https:\/\/gateway\.example\.com\/v1beta\/models\/gemini-3\.8-flash:generateContent/);
  expect(sent[0]!.headers.get("x-goog-api-key")).toBe("sk-test");
  expect(sent[0]!.headers.get("x-team")).toBe("audio");
  const tools = sent[0]!.body.tools as { functionDeclarations: unknown[] }[];
  expect(tools[0]!.functionDeclarations).toHaveLength(CORE_TOOL_DEFINITIONS.length);
  expect(tools[0]!.functionDeclarations[0]).toEqual({
    name: CORE_TOOL_DEFINITIONS[0]!.name,
    description: CORE_TOOL_DEFINITIONS[0]!.description,
    parametersJsonSchema: CORE_TOOL_DEFINITIONS[0]!.input_schema,
  });
  expect(sent[0]!.body.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: "LOW" } });

  // The model's own turn goes back unchanged, then the results as function
  // responses, the spectrogram inside its own.
  const contents = sent[1]!.body.contents as { role: string; parts: Record<string, unknown>[] }[];
  expect(contents[1]!.parts[1]).toMatchObject({ thoughtSignature: "sig" });
  expect(contents[2]).toEqual({
    role: "user",
    parts: [
      { functionResponse: { id: "call_1", name: "set_tempo", response: { output: "Tempo set to 128 BPM." } } },
      {
        functionResponse: {
          name: "analyse_audio",
          response: { output: "The mix, bars 1-4:\nPeak -3 dB" },
          parts: [{ inlineData: { mimeType: "image/png", data: PNG } }],
        },
      },
      { text: turnsLeftNote(TURNS_LEFT) },
    ],
  });
  expect(sent[1]!.body.toolConfig).toBeUndefined();
});

test("OpenAI and Local: on the last turn the results say so, and no tool can be called", async () => {
  for (const provider of ["openai", "local"] as const) {
    const { second, sent } = await roundTrip(provider, GATEWAY, 0, OPENAI_CALLS, completion({ content: "Set the tempo." }));

    expect(second.text).toBe("Set the tempo.");
    const messages = sent[1]!.body.messages as Record<string, unknown>[];
    expect(messages.at(-1)).toEqual({ role: "user", content: turnsLeftNote(0) });
    expect(sent[1]!.body.tools).toEqual(sent[0]!.body.tools);
    expect(sent[1]!.body.tool_choice).toBe("none");
  }
});

test("Gemini: on the last turn the results say so, and no function can be called", async () => {
  const { second, sent } = await roundTrip(
    "gemini",
    GATEWAY,
    0,
    generated([
      { functionCall: { id: "call_1", name: "set_tempo", args: { tempo: 128 } } },
      { functionCall: { id: "call_2", name: "analyse_audio", args: { trackId: "" } } },
    ]),
    generated([{ text: "Set the tempo." }]),
  );

  expect(second.text).toBe("Set the tempo.");
  const contents = sent[1]!.body.contents as { parts: unknown[] }[];
  expect(contents[2]!.parts.at(-1)).toEqual({ text: turnsLeftNote(0) });
  expect(sent[1]!.body.tools).toEqual(sent[0]!.body.tools);
  expect(sent[1]!.body.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
});

/** One Claude Messages reply. */
function claudeMessage(content: unknown[], stopReason = "end_turn") {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/** Each provider's reply calling `set_tempo` and `analyse_audio`, and its reply after. */
const TWO_CALLS: { provider: ProviderId; calls: unknown; done: unknown }[] = [
  {
    provider: "claude",
    calls: claudeMessage(
      [
        { type: "tool_use", id: "toolu_1", name: "set_tempo", input: { tempo: 128 } },
        { type: "tool_use", id: "toolu_2", name: "analyse_audio", input: { spectrogram: true } },
      ],
      "tool_use",
    ),
    done: claudeMessage([{ type: "text", text: "Done." }]),
  },
  { provider: "openai", calls: OPENAI_CALLS, done: completion({ content: "Done." }) },
  {
    provider: "gemini",
    calls: generated([
      { functionCall: { id: "call_1", name: "set_tempo", args: { tempo: 128 } } },
      { functionCall: { id: "call_2", name: "analyse_audio", args: { spectrogram: true } } },
    ]),
    done: generated([{ text: "Done." }]),
  },
  { provider: "local", calls: OPENAI_CALLS, done: completion({ content: "Done." }) },
  { provider: "grok", calls: OPENAI_CALLS, done: completion({ content: "Done." }) },
];

/** `analyse_audio`'s result as `runRequest` makes it, the spectrogram asked for. */
const SEEN: ToolResult[] = [
  RESULTS[0]!,
  { callId: "call_2", content: `The whole mix, measured${SPECTROGRAM_ATTACHED}:\nPeak -3 dB`, isError: false, image: PNG },
];

test.each(TWO_CALLS.flatMap((each) => [true, false].map((imageInput) => ({ ...each, imageInput }))))(
  "$provider: with image input $imageInput, the spectrogram is sent exactly when the model declares it",
  async ({ provider, calls, done, imageInput }) => {
    declareCapabilities(provider, { imageInput });
    const { sent } = await roundTripWith(SEEN, provider, GATEWAY, TURNS_LEFT, calls, done);

    const results = JSON.stringify(sent[1]!.body);
    expect(results.includes(PNG)).toBe(imageInput);
    expect(results.includes(NO_IMAGE_NOTE)).toBe(!imageInput);
    // A model that sees none isn't told it is attached.
    expect(results.includes(SPECTROGRAM_ATTACHED)).toBe(imageInput);
    expect(results).toContain("Peak -3 dB");
  },
);

test("Local: the image input the musician turned on is used, and sends the spectrogram as OpenAI does", async () => {
  const { sent } = await roundTrip("local", { apiKey: "", capabilities: { imageInput: true } }, TURNS_LEFT, OPENAI_CALLS, completion({ content: "Done." }));

  const messages = sent[1]!.body.messages as Record<string, unknown>[];
  expect(messages.at(-2)).toEqual({
    role: "user",
    content: [
      { type: "text", text: "The spectrogram from tool call call_2:" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
    ],
  });
});

/** The audio `analyse_audio` sends back when it listens, as a base64 WAV. */
const WAV = "UklGRiQAAABXQVZF";

/** `analyse_audio`'s result as `runRequest` makes it when it listens. */
const HEARD: ToolResult[] = [
  RESULTS[0]!,
  {
    callId: "call_2",
    content: `The whole mix, measured${AUDIO_ATTACHED}:\nThe audio attached is all of it.\nPeak -3 dB`,
    isError: false,
    audio: WAV,
  },
];

/** What a model that isn't sent audio is told instead. */
const NO_AUDIO_NOTE = withoutAudio(HEARD[1]!).content.split("\n").at(-1)!;

test.each(TWO_CALLS.flatMap((each) => [true, false].map((audioInput) => ({ ...each, audioInput }))))(
  "$provider: with audio input $audioInput, the audio is sent exactly when the model declares it and its API takes it",
  async ({ provider, calls, done, audioInput }) => {
    declareCapabilities(provider, { audioInput });
    const { sent } = await roundTripWith(HEARD, provider, GATEWAY, TURNS_LEFT, calls, done);

    // Claude's Messages API has no audio input, whatever a model declares.
    const hears = audioInput && provider !== "claude";
    const results = JSON.stringify(sent[1]!.body);
    expect(results.includes(WAV)).toBe(hears);
    expect(results.includes(NO_AUDIO_NOTE)).toBe(!hears);
    expect(results.includes(AUDIO_ATTACHED)).toBe(hears);
    expect(results.includes("The audio attached is")).toBe(hears);
    expect(results).toContain("Peak -3 dB");
  },
);

test("Gemini: the audio goes after the function responses as an inline WAV part, since a function response takes no audio", async () => {
  const { sent } = await roundTripWith(HEARD, "gemini", GATEWAY, TURNS_LEFT, TWO_CALLS[2]!.calls, TWO_CALLS[2]!.done);

  const contents = sent[1]!.body.contents as { role: string; parts: Record<string, unknown>[] }[];
  const parts = contents.at(-1)!.parts;
  expect(parts.slice(2, 4)).toEqual([
    { text: 'The audio for the analyse_audio result "The whole mix, measured (the audio is attached):":' },
    { inlineData: { mimeType: "audio/wav", data: WAV } },
  ]);
  expect(JSON.stringify(parts.slice(0, 2))).not.toContain(WAV);
});

test("OpenAI and Local: the audio a model hears goes in a user message after the results, as input_audio", async () => {
  declareCapabilities("openai", { audioInput: true });
  const openai = await roundTripWith(HEARD, "openai", GATEWAY, TURNS_LEFT, OPENAI_CALLS, completion({ content: "Done." }));
  const local = await roundTripWith(
    HEARD,
    "local",
    { apiKey: "", capabilities: { audioInput: true } },
    TURNS_LEFT,
    OPENAI_CALLS,
    completion({ content: "Done." }),
  );

  for (const { sent } of [openai, local]) {
    const messages = sent[1]!.body.messages as Record<string, unknown>[];
    expect(messages.at(-2)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "The audio from tool call call_2:" },
        { type: "input_audio", input_audio: { data: WAV, format: "wav" } },
      ],
    });
  }
});

test("a model that makes one tool call a turn is asked for one, where its API has a way to ask", async () => {
  // Claude and OpenAI declare several; Local starts with one, and the musician can turn several on.
  const claude = await roundTrip("claude", GATEWAY, TURNS_LEFT, TWO_CALLS[0]!.calls, TWO_CALLS[0]!.done);
  expect(claude.sent[0]!.body.tool_choice).toBeUndefined();
  const openai = await roundTrip("openai", GATEWAY, TURNS_LEFT, OPENAI_CALLS, completion({ content: "Done." }));
  expect(openai.sent[0]!.body.parallel_tool_calls).toBeUndefined();
  const local = await roundTrip("local", { apiKey: "" }, TURNS_LEFT, OPENAI_CALLS, completion({ content: "Done." }));
  expect(local.sent.map((each) => each.body.parallel_tool_calls)).toEqual([false, false]);
  const several = { apiKey: "", capabilities: { parallelToolCalls: true } };
  const localSeveral = await roundTrip("local", several, TURNS_LEFT, OPENAI_CALLS, completion({ content: "Done." }));
  expect(localSeveral.sent[0]!.body.parallel_tool_calls).toBeUndefined();

  declareCapabilities("claude", { parallelToolCalls: false });
  const one = await roundTrip("claude", GATEWAY, 0, TWO_CALLS[0]!.calls, TWO_CALLS[0]!.done);
  expect(one.sent[0]!.body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  // The last turn has no tools at all.
  expect(one.sent[1]!.body.tool_choice).toEqual({ type: "none" });
});

test("a model that can't use tools isn't used: its provider's default is", async () => {
  addTextOnlyModel();
  const { fetch, sent } = stubbed(completion({ content: "Done." }));
  await conversationsFor("local", { apiKey: "", model: TEXT_ONLY_MODEL.id }, fetch)("hi", createProject("Demo")).next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);

  expect(sent[0]!.body.model).toBe("llama3.1:8b");
});

/** The names of the tools a request sent, in whichever shape its Provider sends them. */
function sentToolNames(provider: ProviderId, body: Record<string, unknown>): string[] {
  switch (provider) {
    case "claude":
      return (body.tools as { name: string }[]).map((tool) => tool.name);
    case "openai":
    case "grok":
    case "meta":
    case "local":
      return (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    case "gemini":
      return (body.tools as { functionDeclarations: { name: string }[] }[])[0]!.functionDeclarations.map((tool) => tool.name);
  }
}

/** Each Provider's reply calling load_tools, then its reply that is only text. */
const LOADS_SOUNDS: Record<ProviderId, [unknown, unknown]> = {
  claude: [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "tool_use", id: "toolu_1", name: "load_tools", input: { group: "sounds" } }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    {
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "Done." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ],
  openai: [
    completion({ tool_calls: [{ id: "call_1", type: "function", function: { name: "load_tools", arguments: '{"group":"sounds"}' } }] }),
    completion({ content: "Done." }),
  ],
  local: [
    completion({ tool_calls: [{ id: "call_1", type: "function", function: { name: "load_tools", arguments: '{"group":"sounds"}' } }] }),
    completion({ content: "Done." }),
  ],
  grok: [
    completion({ tool_calls: [{ id: "call_1", type: "function", function: { name: "load_tools", arguments: '{"group":"sounds"}' } }] }),
    completion({ content: "Done." }),
  ],
  meta: [
    completion({ tool_calls: [{ id: "call_1", type: "function", function: { name: "load_tools", arguments: '{"group":"sounds"}' } }] }),
    completion({ content: "Done." }),
  ],
  gemini: [generated([{ functionCall: { id: "call_1", name: "load_tools", args: { group: "sounds" } } }]), generated([{ text: "Done." }])],
};

test("every Provider sends the tool list it is given each turn, so it grows after load_tools", async () => {
  const grown = toolDefinitions(["sounds"]);
  for (const provider of ["claude", "openai", "local", "gemini", "meta"] as const) {
    const { fetch, sent } = stubbed(...LOADS_SOUNDS[provider]);
    const conversation = conversationsFor(provider, GATEWAY, fetch)("add an EQ", createProject("Demo"));
    const first = await conversation.next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);
    const loaded = { callId: first.toolCalls[0]!.id, content: "The sounds tools are loaded.", isError: false };
    await conversation.next([loaded], TURNS_LEFT, grown);

    expect(sentToolNames(provider, sent[0]!.body)).toEqual(CORE_TOOL_DEFINITIONS.map((tool) => tool.name));
    expect(sentToolNames(provider, sent[0]!.body)).not.toContain("add_effect");
    expect(sentToolNames(provider, sent[1]!.body)).toEqual(grown.map((tool) => tool.name));
    expect(sentToolNames(provider, sent[1]!.body)).toContain("add_effect");
  }
});

/** The Conversation a follow-up is sent: one earlier Request, undone since, which loaded the sounds tools. */
const SO_FAR: ConversationSoFar = {
  earlier: [
    {
      request: "add a reverb to the vocals",
      message: "I added a reverb to the vocals.",
      changes: ["Added a Reverb to “Vocals”"],
      error: null,
      since: "undone",
    },
  ],
  loaded: ["sounds"],
};

/** A message's text: all of it, and a placeholder for each part that isn't text. */
function text(content: unknown): string {
  return typeof content === "string"
    ? content
    : (content as { type?: string; text?: string }[]).map((part) => part.text ?? `[${part.type ?? "part"}]`).join("\n");
}

/** Each message a Provider sent, as who sent it and its text, whatever else it holds; OpenAI's system prompt left out. */
function sentTurns(provider: ProviderId, body: Record<string, unknown>): { role: string; text: string }[] {
  switch (provider) {
    case "claude":
      return (body.messages as { role: string; content: unknown }[]).map(({ role, content }) => ({ role, text: text(content) }));
    case "openai":
    case "grok":
    case "meta":
    case "local":
      return (body.messages as { role: string; content: unknown }[])
        .filter(({ role }) => role !== "system")
        .map(({ role, content }) => ({ role, text: content === null ? "" : text(content) }));
    case "gemini":
      return (body.contents as { role: string; parts: { text?: string }[] }[]).map(({ role, parts }) => ({
        role: role === "model" ? "assistant" : role,
        text: parts.map((part) => part.text ?? "[part]").join("\n"),
      }));
  }
}

test.each(TWO_CALLS)("$provider: a follow-up is sent the earlier Requests and their changes before its own, not their tool calls", async ({ provider, calls, done }) => {
  const { fetch, sent } = stubbed(calls, done);
  const conversation = conversationsFor(provider, GATEWAY, fetch)("make it darker", createProject("Demo"), undefined, SO_FAR);
  const first = await conversation.next([], MAX_TURNS, toolDefinitions(["sounds"]));
  await conversation.next(
    RESULTS.map((result, index) => ({ ...result, callId: first.toolCalls[index]!.id })),
    TURNS_LEFT,
    toolDefinitions(["sounds"]),
  );

  const turns = sentTurns(provider, sent[0]!.body);
  expect(turns).toHaveLength(3);
  expect(turns[0]).toEqual({ role: "user", text: "add a reverb to the vocals" });
  expect(turns[1]).toEqual({
    role: "assistant",
    text: "I added a reverb to the vocals.\n\nWhat this Request changed: Added a Reverb to “Vocals”.",
  });
  expect(turns[2]!.role).toBe("user");
  expect(turns[2]!.text).toContain("The musician has undone the earlier Request \"add a reverb to the vocals\"");
  expect(turns[2]!.text).toContain("still loaded: sounds.");
  expect(turns[2]!.text).toMatch(/The musician's Request:\nmake it darker$/);

  // The next turn carries on the same messages: the earlier Request stays first, as text alone.
  const next = sentTurns(provider, sent[1]!.body);
  expect(next.slice(0, 3)).toEqual(turns);
  expect(next.length).toBeGreaterThan(3);
});

test.each(TWO_CALLS)("$provider: a new Conversation's Request is sent alone", async ({ provider, done }) => {
  const { fetch, sent } = stubbed(done);
  await conversationsFor(provider, GATEWAY, fetch)("make it darker", createProject("Demo")).next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);

  const turns = sentTurns(provider, sent[0]!.body);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.text).not.toMatch(/earlier Request|still loaded/);
});

/** Each provider's reply, with the tokens it says it cost, and what the Assistant counts of them. */
const WITH_USAGE: { provider: ProviderId; reply: unknown }[] = [
  {
    provider: "claude",
    reply: {
      ...claudeMessage([{ type: "text", text: "Done." }]),
      // Cached input is billed too, so it counts as input.
      usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 30 },
    },
  },
  { provider: "openai", reply: { ...completion({ content: "Done." }), usage: { prompt_tokens: 125, completion_tokens: 30, total_tokens: 155 } } },
  { provider: "local", reply: { ...completion({ content: "Done." }), usage: { prompt_tokens: 125, completion_tokens: 30, total_tokens: 155 } } },
  {
    provider: "grok",
    // xAI counts the reasoning apart from the completion, and bills it too.
    reply: {
      ...completion({ content: "Done." }),
      usage: { prompt_tokens: 125, completion_tokens: 10, total_tokens: 155, completion_tokens_details: { reasoning_tokens: 20 } },
    },
  },
  {
    provider: "gemini",
    // Gemini counts its thinking apart from the reply; both are output.
    reply: { ...generated([{ text: "Done." }]), usageMetadata: { promptTokenCount: 125, candidatesTokenCount: 10, thoughtsTokenCount: 20 } },
  },
];

test.each(WITH_USAGE)("$provider: a reply says the tokens it cost, input and output", async ({ provider, reply }) => {
  const { fetch } = stubbed(reply);
  const got = await conversationsFor(provider, GATEWAY, fetch)("hi", createProject("Demo")).next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);
  expect(got.usage).toEqual({ input: 125, output: 30 });
});

test.each([
  { provider: "local" as const, reply: completion({ content: "Done." }) },
  { provider: "gemini" as const, reply: generated([{ text: "Done." }]) },
])("$provider: a server that sends no usage counts no tokens", async ({ provider, reply }) => {
  const { fetch } = stubbed(reply);
  const got = await conversationsFor(provider, GATEWAY, fetch)("hi", createProject("Demo")).next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);
  expect(got.usage).toBeUndefined();
});

test("Grok: a Request goes to xAI's API with the key, the effort and the tools, and comes back as tool calls", async () => {
  const { fetch, sent } = stubbed(OPENAI_CALLS);
  const conversation = conversationsFor("grok", { apiKey: "xai-test", effort: "xhigh" }, fetch)("make it 128", createProject("Demo"));
  const reply = await conversation.next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);

  expect(reply.toolCalls.map((call) => call.name)).toEqual(["set_tempo", "analyse_audio"]);
  expect(sent[0]!.url).toBe("https://api.x.ai/v1/chat/completions");
  expect(sent[0]!.headers.get("authorization")).toBe("Bearer xai-test");
  expect(sent[0]!.body).toMatchObject({ model: "grok-4.7", reasoning_effort: "xhigh", max_completion_tokens: 16_000 });
  expect(sent[0]!.body.max_tokens).toBeUndefined();
});

test("Grok: an effort the model doesn't take is left off", async () => {
  const { fetch, sent } = stubbed(completion({ content: "Done." }));
  await conversationsFor("grok", { apiKey: "xai-test", model: "grok-4.5", effort: "xhigh" }, fetch)("hi", createProject("Demo")).next(
    [],
    MAX_TURNS,
    CORE_TOOL_DEFINITIONS,
  );
  expect(sent[0]!.body.model).toBe("grok-4.5");
  expect(sent[0]!.body.reasoning_effort).toBeUndefined();
});

test("Meta AI: a Request goes to Meta's Model API with the key, the effort and the tools, and comes back as tool calls", async () => {
  const { fetch, sent } = stubbed(OPENAI_CALLS);
  const conversation = conversationsFor("meta", { apiKey: "meta-test", effort: "max" }, fetch)("make it 128", createProject("Demo"));
  const reply = await conversation.next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);

  expect(reply.toolCalls.map((call) => call.name)).toEqual(["set_tempo", "analyse_audio"]);
  expect(sent[0]!.url).toBe("https://api.meta.ai/v1/chat/completions");
  expect(sent[0]!.headers.get("authorization")).toBe("Bearer meta-test");
  // Muse Spark counts its reasoning in max_tokens; `max` is 1.3's alone.
  expect(sent[0]!.body).toMatchObject({ model: "muse-spark-1.3", reasoning_effort: "max", max_tokens: 16_000 });
  expect(sent[0]!.body.max_completion_tokens).toBeUndefined();
});

test("Meta AI: an effort the model doesn't take is left off, and reasoning can't be turned off", async () => {
  const { fetch, sent } = stubbed(completion({ content: "Done." }), completion({ content: "Done." }));
  await conversationsFor("meta", { apiKey: "k", model: "muse-spark-1.2", effort: "max" }, fetch)("hi", createProject("Demo")).next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);
  await conversationsFor("meta", { apiKey: "k", effort: "none" }, fetch)("hi", createProject("Demo")).next([], MAX_TURNS, CORE_TOOL_DEFINITIONS);
  expect(sent[0]!.body.model).toBe("muse-spark-1.2");
  expect(sent[0]!.body.reasoning_effort).toBeUndefined();
  expect(sent[1]!.body.reasoning_effort).toBeUndefined();
});

test("a one-off exchange goes to each Provider with its own system prompt and message, and no Project", async () => {
  const tool = { name: "suggest_tracks", description: "Pick tracks.", input_schema: CORE_TOOL_DEFINITIONS[0]!.input_schema };
  const call = { trackId: "track-1", why: "Up a fifth." };
  const replies: Record<"claude" | "openai" | "gemini", unknown> = {
    claude: claudeMessage([{ type: "tool_use", id: "toolu_1", name: "suggest_tracks", input: { picks: [call] } }], "tool_use"),
    openai: completion({ tool_calls: [{ id: "call_1", type: "function", function: { name: "suggest_tracks", arguments: JSON.stringify({ picks: [call] }) } }] }),
    gemini: generated([{ functionCall: { id: "call_1", name: "suggest_tracks", args: { picks: [call] } } }]),
  };
  for (const provider of ["claude", "openai", "gemini"] as const) {
    const { fetch, sent } = stubbed(replies[provider]);
    const reply = await exchangesFor(provider, { apiKey: "sk-test" }, fetch)("You are the Mix Helper.", "Mixing into Deck 1.").next([], 1, [tool]);
    expect(reply.toolCalls).toEqual([{ id: expect.any(String), name: "suggest_tracks", input: { picks: [call] } }]);
    const body = JSON.stringify(sent[0]!.body);
    expect(body).toContain("You are the Mix Helper.");
    expect(body).toContain("Mixing into Deck 1.");
    expect(body).not.toContain("A summary of the Project");
    expect(body).not.toContain("You are the Assistant in Soundcheck");
  }
});

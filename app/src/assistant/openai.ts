/**
 * The Assistant's connection to OpenAI, to xAI's Grok, to Meta AI's Model
 * API (dev.meta.ai, OpenAI-compatible at api.meta.ai/v1), and to a local model
 * through its OpenAI-compatible endpoint (Ollama, llama.cpp's server).
 *
 * All speak Chat Completions, the one API a local server is sure to have.
 * xAI keeps it as the predecessor of its Responses API, with no date to
 * turn it off (docs.x.ai/developers/model-capabilities/legacy/chat-completions).
 * As with Claude, the official SDK runs in the webview and only the HTTP
 * leaves, through the `fetch` it is given (`platform.ts` picks it).
 */
import OpenAI, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  type ClientOptions,
} from "openai";

import {
  type Conversation,
  type ModelReply,
  sentTo,
  type StartConversation,
  type StartExchange,
  type TokenUsage,
  type ToolResult,
} from "./assistant";
import { LISTENING } from "../audio/listening";
import type { Capabilities } from "./catalogue";
import { type Opening, requestOpening, turnsLeftNote } from "./context";
import type { ToolDefinition } from "./tools";

/** Which model a Request uses, and at what reasoning effort; unset means the default. */
export interface OpenAIChoice {
  model: string;
  effort?: OpenAI.ReasoningEffort;
}

/** The SDK client settings: a gateway's base URL and headers, and, in tests, a stub `fetch`. */
export type OpenAIOptions = Pick<ClientOptions, "fetch" | "baseURL" | "defaultHeaders" | "maxRetries">;

/** Room for a long reply without risking an HTTP timeout, as for Claude. */
const MAX_TOKENS = 16_000;

/** Who is on the other end, as far as a Request needs to know. */
interface Server {
  /** Its name, in what the musician is told. */
  who: string;
  /** What the model can do, from the catalogue. */
  capabilities: Capabilities;
  /**
   * The name the reply's token limit goes under: OpenAI's reasoning models
   * count their thinking against `max_completion_tokens`, and a local
   * server knows only the older `max_tokens`.
   */
  maxTokens: "max_completion_tokens" | "max_tokens";
  /**
   * Its `completion_tokens` leave out the reasoning, which is counted in
   * `completion_tokens_details.reasoning_tokens` instead and billed too:
   * xAI's do (docs.x.ai's Chat Completions reference), OpenAI's include it.
   */
  reasoningApart?: boolean;
}

/** The Assistant's tools, as Chat Completions' functions. */
export function openaiTools(definitions: readonly ToolDefinition[]): OpenAI.ChatCompletionFunctionTool[] {
  return definitions.map((tool) => ({
  type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
}

/** The Providers that speak OpenAI's Chat Completions. */
export type OpenAIShaped = "openai" | "grok" | "meta" | "local";

/**
 * Who each is: Meta AI's Muse Spark takes the token limit as `max_tokens`,
 * which counts the reasoning too, as a local server does. A local model
 * needs no key, but the SDK insists on one, and a local server ignores it;
 * it takes no effort either.
 */
const SERVERS: Record<OpenAIShaped, Omit<Server, "capabilities"> & { local?: true }> = {
  openai: { who: "OpenAI", maxTokens: "max_completion_tokens" },
  grok: { who: "Grok", maxTokens: "max_completion_tokens", reasoningApart: true },
  meta: { who: "Meta AI", maxTokens: "max_tokens" },
  local: { who: "The local model", maxTokens: "max_tokens", local: true },
};

function serverOf(kind: OpenAIShaped, capabilities: Capabilities): Server {
  const { local: _, ...server } = SERVERS[kind];
  return { ...server, capabilities };
}

/** The client and model for `kind`. */
function clientOf(kind: OpenAIShaped, apiKey: string, options: OpenAIOptions, choice: OpenAIChoice): [OpenAI, OpenAIChoice] {
  if (SERVERS[kind].local) return [new OpenAI({ apiKey: apiKey || "local", dangerouslyAllowBrowser: true, ...options }), { model: choice.model }];
  return [new OpenAI({ apiKey, dangerouslyAllowBrowser: true, ...options }), choice];
}

function startFor(kind: OpenAIShaped, apiKey: string, options: OpenAIOptions, choice: OpenAIChoice, capabilities: Capabilities): StartConversation {
  const [client, chosen] = clientOf(kind, apiKey, options, choice);
  const server = serverOf(kind, capabilities);
  return (request, project, library, soFar, mode) => conversation(client, chosen, server, requestOpening(request, project, library, soFar, mode));
}

/** Talks to OpenAI with the user's own key. */
export function openaiConversations(apiKey: string, options: OpenAIOptions, choice: OpenAIChoice, capabilities: Capabilities): StartConversation {
  return startFor("openai", apiKey, options, choice, capabilities);
}

/** Talks to Grok with the user's own key. */
export function grokConversations(apiKey: string, options: OpenAIOptions, choice: OpenAIChoice, capabilities: Capabilities): StartConversation {
  return startFor("grok", apiKey, options, choice, capabilities);
}

/** Talks to Meta AI's Muse Spark with the user's own key. */
export function metaConversations(apiKey: string, options: OpenAIOptions, choice: OpenAIChoice, capabilities: Capabilities): StartConversation {
  return startFor("meta", apiKey, options, choice, capabilities);
}

/** Talks to a model served on this machine. */
export function localConversations(apiKey: string, options: OpenAIOptions, choice: OpenAIChoice, capabilities: Capabilities): StartConversation {
  return startFor("local", apiKey, options, choice, capabilities);
}

/** A one-off exchange (`StartExchange`) with an OpenAI-shaped Provider, on the same key and model as its Requests. */
export function openaiExchanges(
  kind: OpenAIShaped,
  apiKey: string,
  options: OpenAIOptions,
  choice: OpenAIChoice,
  capabilities: Capabilities,
): StartExchange {
  const [client, chosen] = clientOf(kind, apiKey, options, choice);
  const server = serverOf(kind, capabilities);
  return (system, message) => conversation(client, chosen, server, { system, earlier: [], first: () => message });
}

function conversation(client: OpenAI, choice: OpenAIChoice, server: Server, { system, earlier, first: opening }: Opening): Conversation {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  return {
    async next(results, turnsLeft, tools) {
      if (messages.length === 0) {
        messages.push({ role: "system", content: system });
        // The Conversation's earlier Requests come first, as plain text turns.
        for (const { request: asked, reply } of earlier) {
          messages.push({ role: "user", content: asked }, { role: "assistant", content: reply });
        }
        messages.push({ role: "user", content: opening() });
      } else {
        messages.push(...toolMessages(results, server.capabilities), { role: "user", content: turnsLeftNote(turnsLeft) });
      }
      const completion = await send(client, choice, server, messages, tools, turnsLeft > 0);
      const reply = completion.choices[0]?.message;
      if (!reply) throw new Error(`${server.who} sent back no reply.`);
      messages.push(reply);
      return { ...read(reply, server.who), ...usageOf(completion.usage, server) };
    },
  };
}

async function send(
  client: OpenAI,
  choice: OpenAIChoice,
  server: Server,
  messages: OpenAI.ChatCompletionMessageParam[],
  definitions: readonly ToolDefinition[],
  tools: boolean,
): Promise<OpenAI.ChatCompletion> {
  try {
    return await client.chat.completions.create({
      model: choice.model,
      ...(choice.effort && { reasoning_effort: choice.effort }),
      [server.maxTokens]: MAX_TOKENS,
      // Chat Completions is stateless: each request sends the whole list, so
      // one that grew with load_tools needs nothing more.
      tools: openaiTools(definitions),
      ...(!tools && { tool_choice: "none" as const }),
      ...(!server.capabilities.parallelToolCalls && { parallel_tool_calls: false }),
      messages,
    });
  } catch (error) {
    throw new Error(explain(error, server.who), { cause: error });
  }
}

function read(message: OpenAI.ChatCompletionMessage, who: string): ModelReply {
  if (message.refusal) throw new Error(`${who} declined this Request. Try asking for the change a different way.`);
  const toolCalls = (message.tool_calls ?? [])
    .filter((call) => call.type === "function")
    .map((call) => ({ id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) }));
  return { text: message.content ?? "", toolCalls };
}

/** A local server may send no usage; one that does counts as OpenAI's does. */
function usageOf(usage: OpenAI.CompletionUsage | undefined, server: Server): { usage: TokenUsage } | undefined {
  if (!usage) return undefined;
  const reasoning = server.reasoningApart ? (usage.completion_tokens_details?.reasoning_tokens ?? 0) : 0;
  return { usage: { input: usage.prompt_tokens, output: usage.completion_tokens + reasoning } };
}

/** Arguments come as JSON text; text that isn't JSON goes on as it is, for the tool to reject. */
function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return text;
  }
}

/**
 * One tool message per result. A tool message holds text only, so a
 * spectrogram, and the audio, follow the results in a user message of their
 * own, for a model that can see or hear them: audio as an `input_audio`
 * part, which Chat Completions takes only in a user message.
 */
function toolMessages(sent: readonly ToolResult[], capabilities: Capabilities): OpenAI.ChatCompletionMessageParam[] {
  const results = sent.map((result) => sentTo(capabilities, result));
  const messages: OpenAI.ChatCompletionMessageParam[] = results.map((result) => ({
    role: "tool",
    tool_call_id: result.callId,
    content: result.isError ? `Error: ${result.content}` : result.content,
  }));
  const attached = results.flatMap((result): OpenAI.ChatCompletionContentPart[] => [
    ...(result.image === undefined
      ? []
      : [
          { type: "text" as const, text: `The spectrogram from tool call ${result.callId}:` },
          { type: "image_url" as const, image_url: { url: `data:image/png;base64,${result.image}` } },
        ]),
    ...(result.audio === undefined
      ? []
      : [
          { type: "text" as const, text: `The audio from tool call ${result.callId}:` },
          { type: "input_audio" as const, input_audio: { data: result.audio, format: LISTENING.format } },
        ]),
  ]);
  if (attached.length > 0) messages.push({ role: "user", content: attached });
  return messages;
}

/** Say what went wrong in words the musician can act on. */
function explain(error: unknown, who: string): string {
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return `${who} would not accept that API key. Check it and enter it again.`;
  }
  if (error instanceof RateLimitError) return `${who} is busy with your other requests. Try again shortly.`;
  if (error instanceof APIConnectionError) return `${who} could not be reached: ${error.message}`;
  if (error instanceof APIError) return `${who} returned an error: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

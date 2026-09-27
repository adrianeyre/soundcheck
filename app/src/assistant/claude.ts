/**
 * The Assistant's one connection to Claude.
 *
 * The client is the official SDK, built in the webview: everything a Request
 * needs — the Project, the tools, the undo group — is already TypeScript
 * here, so moving the tool loop to Rust would mean a second copy of the
 * Project model for no gain. Only the HTTP leaves: the `fetch` it is given
 * (`platform.ts` picks it) makes the request. On the desktop that is Tauri's
 * HTTP plugin, so the request is sent from Rust, where CORS doesn't apply and
 * a gateway needn't answer the webview's preflight; on the browser dev host it
 * is the page's own fetch, so a gateway must allow CORS there. The key is
 * fetched from the OS credential store over IPC only when a Request runs, and
 * the webview loads no remote content.
 */
import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  type ClientOptions,
} from "@anthropic-ai/sdk";

import type { Project } from "../project/model";
import {
  DIRECT,
  sentTo,
  type Conversation,
  type ConversationSoFar,
  type ModelReply,
  type StartConversation,
  type TokenUsage,
  type ToolResult,
} from "./assistant";
import { capabilitiesOf, type Capabilities } from "./catalogue";
import { earlierExchanges, requestMessage, systemPrompt, turnsLeftNote } from "./context";
import { EMPTY_LIBRARY, type LibraryContents } from "./library";
import type { ToolDefinition } from "./tools";

/** The default model. */
export const ASSISTANT_MODEL = "claude-opus-5-5";

/** How hard the model thinks, and so how much a Request costs. */
export type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

/** Haiku 4.5 rejects `effort`, so it is left off for it. */
export function takesEffort(model: string): boolean {
  return !model.startsWith("claude-haiku-4-5");
}

/** Which model a Request uses, and at what effort; unset means the model's default. */
export interface ModelChoice {
  model?: string;
  effort?: Effort;
}

/** Room for a long reply without risking an HTTP timeout. */
const MAX_TOKENS = 16_000;

/**
 * How the client is built. The app passes the base URL and headers of the
 * user's `Connection`, for a gateway in front of the API. Tests stand a
 * `fetch` in front of the SDK so none calls the real API, and
 * `scripts/real-model-check.ts` uses one to count tokens.
 */
export type ClaudeOptions = Pick<ClientOptions, "fetch" | "baseURL" | "defaultHeaders" | "maxRetries">;

/** Talks to Claude with the user's own key. */
export function claudeConversations(
  apiKey: string,
  options: ClaudeOptions = {},
  choice: ModelChoice = {},
  capabilities: Capabilities = capabilitiesOf("claude", choice.model ?? ASSISTANT_MODEL),
): StartConversation {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, ...options });
  return (request, project, library = EMPTY_LIBRARY, soFar, mode = DIRECT) =>
    conversation(client, choice, capabilities, systemPrompt(mode), request, project, library, soFar);
}

function conversation(
  client: Anthropic,
  choice: ModelChoice,
  capabilities: Capabilities,
  system: string,
  request: string,
  project: Project,
  library: LibraryContents,
  soFar: ConversationSoFar | undefined,
): Conversation {
  // Claude's API has no audio input (the catalogue declares none), so no
  // result is sent with its audio.
  const block = (result: ToolResult) => toolResultBlock(sentTo({ ...capabilities, audioInput: false }, result));
  // The Conversation's earlier Requests come first, as plain text turns.
  const messages: Anthropic.MessageParam[] = earlierExchanges(soFar).flatMap(({ request: asked, reply }): Anthropic.MessageParam[] => [
    { role: "user", content: asked },
    { role: "assistant", content: reply },
  ]);
  let first = true;
  return {
    async next(results, turnsLeft, tools) {
      messages.push(
        first
          ? { role: "user", content: requestMessage(request, project, library, soFar) }
          : { role: "user", content: [...results.map(block), { type: "text", text: turnsLeftNote(turnsLeft) }] },
      );
      first = false;
      const response = await send(client, choice, capabilities, system, messages, tools, turnsLeft > 0);
      // The whole reply goes back, blocks we don't read included: the model
      // needs its own thinking returned unchanged to carry on.
      messages.push({ role: "assistant", content: response.content });
      return read(response);
    },
  };
}

async function send(
  client: Anthropic,
  choice: ModelChoice,
  capabilities: Capabilities,
  system: string,
  messages: Anthropic.MessageParam[],
  definitions: readonly ToolDefinition[],
  tools: boolean,
): Promise<Anthropic.Message> {
  const model = choice.model ?? ASSISTANT_MODEL;
  try {
    return await client.messages.create({
      model,
      ...(choice.effort && takesEffort(model) && { output_config: { effort: choice.effort } }),
      max_tokens: MAX_TOKENS,
      system,
      // The tools stay defined when they are off, for the tool calls
      // already in the messages. Each request carries the whole list, so
      // one that grew with load_tools needs nothing more.
      tools: [...definitions],
      ...(!tools && { tool_choice: { type: "none" } }),
      ...(tools && !capabilities.parallelToolCalls && { tool_choice: { type: "auto", disable_parallel_tool_use: true } }),
      messages,
    });
  } catch (error) {
    throw new Error(explain(error), { cause: error });
  }
}

function read(response: Anthropic.Message): ModelReply {
  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined this Request. Try asking for the change a different way.");
  }
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const toolCalls = response.content
    .filter((block) => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
  return { text, toolCalls, usage: usageOf(response.usage) };
}

/** Cached input is billed too, at its own rate, so it counts as input. */
function usageOf(usage: Anthropic.Usage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return { input, output: usage.output_tokens };
}

/** A picture goes with its text, as an image block inside the tool result. */
function toolResultBlock(result: ToolResult): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: result.callId,
    content:
      result.image === undefined
        ? result.content
        : [
            { type: "text", text: result.content },
            { type: "image", source: { type: "base64", media_type: "image/png", data: result.image } },
          ],
    is_error: result.isError,
  };
}

/** Say what went wrong in words the musician can act on. */
function explain(error: unknown): string {
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return "Claude would not accept that API key. Check it and enter it again.";
  }
  if (error instanceof RateLimitError) return "Claude is busy with your other requests. Try again shortly.";
  if (error instanceof APIConnectionError) return `Claude could not be reached: ${error.message}`;
  if (error instanceof APIError) return `Claude returned an error: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

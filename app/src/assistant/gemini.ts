/**
 * The Assistant's connection to Google Gemini.
 *
 * As with Claude, the official SDK runs in the webview and only the HTTP
 * leaves, through the `fetch` it is given (`platform.ts` picks it); the SDK
 * takes one in its `httpOptions`.
 */
import {
  ApiError,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponse,
  type HttpOptions,
  type Part,
} from "@google/genai";

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

/** Which model a Request uses, and at what thinking level; unset means the model's default. */
export interface GeminiChoice {
  model: string;
  effort?: string;
}

/** The SDK's HTTP settings: a gateway's base URL and headers, and, in tests, a stub `fetch`. */
export type GeminiOptions = Pick<HttpOptions, "fetch" | "baseUrl" | "headers" | "retryOptions">;

/** Room for a long reply, thinking included, as for Claude. */
const MAX_TOKENS = 16_000;

/** The Assistant's tools, as Gemini's function declarations. */
export function geminiTools(definitions: readonly ToolDefinition[]): FunctionDeclaration[] {
  return definitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.input_schema,
  }));
}

/** Talks to Gemini with the user's own key. */
export function geminiConversations(
  apiKey: string,
  options: GeminiOptions,
  choice: GeminiChoice,
  capabilities: Capabilities,
): StartConversation {
  const client = new GoogleGenAI({ apiKey, httpOptions: options });
  return (request, project, library, soFar, mode) =>
    conversation(client, choice, capabilities, requestOpening(request, project, library, soFar, mode));
}

/** A one-off exchange with Gemini (`StartExchange`), on the same key and model as its Requests. */
export function geminiExchanges(apiKey: string, options: GeminiOptions, choice: GeminiChoice, capabilities: Capabilities): StartExchange {
  const client = new GoogleGenAI({ apiKey, httpOptions: options });
  return (system, message) => conversation(client, choice, capabilities, { system, earlier: [], first: () => message });
}

function conversation(client: GoogleGenAI, choice: GeminiChoice, capabilities: Capabilities, { system, earlier, first: opening }: Opening): Conversation {
  // The Conversation's earlier Requests come first, as plain text turns.
  const contents: Content[] = earlier.flatMap(({ request: asked, reply }): Content[] => [
    { role: "user", parts: [{ text: asked }] },
    { role: "model", parts: [{ text: reply }] },
  ]);
  let first = true;
  // A function response is matched to its call by name, and by id when
  // Gemini gave the call one; calls it gave none get one here.
  const calls = new Map<string, { name: string; id?: string }>();
  // A model that can't see images is sent none, and one that can't hear audio no audio.
  const sent = (result: ToolResult) => sentTo(capabilities, result);
  return {
    async next(results, turnsLeft, tools) {
      contents.push(
        first
          ? { role: "user", parts: [{ text: opening() }] }
          : {
              role: "user",
              parts: [
                ...results.map((result) => functionResponse(sent(result), calls)),
                ...results.flatMap((result) => audioParts(sent(result))),
                { text: turnsLeftNote(turnsLeft) },
              ],
            },
      );
      first = false;
      const reply = await send(client, choice, system, contents, tools, turnsLeft > 0);
      const content = reply.candidates?.[0]?.content;
      if (!content) throw new Error(declined(reply));
      // The whole reply goes back unchanged: its thought signatures let the
      // model carry on from where it was.
      contents.push(content);
      return { ...read(content, calls, contents.length), ...usageOf(reply) };
    },
  };
}

async function send(
  client: GoogleGenAI,
  choice: GeminiChoice,
  systemInstruction: string,
  contents: Content[],
  definitions: readonly ToolDefinition[],
  tools: boolean,
): Promise<GenerateContentResponse> {
  try {
    return await client.models.generateContent({
      model: choice.model,
      contents,
      config: {
        systemInstruction,
        // generateContent is stateless: each request declares the whole
        // list, so one that grew with load_tools needs nothing more.
        tools: [{ functionDeclarations: geminiTools(definitions) }],
        ...(!tools && { toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } } }),
        maxOutputTokens: MAX_TOKENS,
        ...(choice.effort && { thinkingConfig: { thinkingLevel: choice.effort.toUpperCase() as ThinkingLevel } }),
      },
    });
  } catch (error) {
    throw new Error(explain(error), { cause: error });
  }
}

function read(content: Content, calls: Map<string, { name: string; id?: string }>, turn: number): ModelReply {
  const parts = content.parts ?? [];
  const text = parts
    .filter((part) => part.text !== undefined && !part.thought)
    .map((part) => part.text)
    .join("");
  const toolCalls = parts.flatMap((part, index) => {
    const call = part.functionCall;
    if (!call?.name) return [];
    const id = call.id ?? `call_${turn}_${index}`;
    calls.set(id, { name: call.name, ...(call.id && { id: call.id }) });
    return [{ id, name: call.name, input: call.args ?? {} }];
  });
  return { text, toolCalls };
}

/** Gemini counts its thinking apart from the reply, and bills both as output. */
function usageOf({ usageMetadata: usage }: GenerateContentResponse): { usage: TokenUsage } | undefined {
  if (!usage) return undefined;
  return {
    usage: {
      input: usage.promptTokenCount ?? 0,
      output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    },
  };
}

/** A result as a function response; a spectrogram goes inside it, as an image part. */
function functionResponse(result: ToolResult, calls: Map<string, { name: string; id?: string }>): Part {
  const call = calls.get(result.callId);
  return {
    functionResponse: {
      ...(call?.id && { id: call.id }),
      name: call?.name ?? "",
      response: result.isError ? { error: result.content } : { output: result.content },
      ...(result.image !== undefined && { parts: [{ inlineData: { mimeType: "image/png", data: result.image } }] }),
    },
  };
}

/**
 * A result's audio, after the function responses: a function response
 * takes images and documents but not audio, so it goes in a part of its
 * own, as inline data, the way Gemini takes audio in a prompt, labelled with
 * the report it goes with.
 */
function audioParts(result: ToolResult): Part[] {
  if (result.audio === undefined) return [];
  const heard = result.content.split("\n")[0];
  return [{ text: `The audio for the analyse_audio result "${heard}":` }, { inlineData: { mimeType: LISTENING.mimeType, data: result.audio } }];
}

function declined(response: GenerateContentResponse): string {
  if (response.promptFeedback?.blockReason) {
    return "Gemini declined this Request. Try asking for the change a different way.";
  }
  return "Gemini sent back no reply.";
}

/** Say what went wrong in words the musician can act on. */
function explain(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Gemini would not accept that API key. Check it and enter it again.";
    }
    if (error.status === 429) return "Gemini is busy with your other requests. Try again shortly.";
    return `Gemini returned an error: ${error.message}`;
  }
  if (error instanceof TypeError) return `Gemini could not be reached: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

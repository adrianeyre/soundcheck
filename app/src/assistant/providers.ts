/**
 * One way in to every provider: a connection becomes the `StartConversation`
 * that `runRequest` talks through, whichever model is behind it. Every
 * provider's requests go through the `fetch` given here, the platform's.
 */
import type { StartConversation } from "./assistant";
import { assistantModel, effortsFor, provider as providerOf, type ProviderId } from "./catalogue";
import { claudeConversations } from "./claude";
import { capabilitiesFor, clientOptions, headersOf, modelChoice, type Connection } from "./connection";
import { geminiConversations } from "./gemini";
import { grokConversations, localConversations, metaConversations, openaiConversations, type OpenAIChoice } from "./openai";

export function conversationsFor(
  provider: ProviderId,
  connection: Connection,
  fetch: typeof globalThis.fetch | undefined,
): StartConversation {
  const model = assistantModel(provider, connection.model);
  const capabilities = capabilitiesFor(provider, connection);
  // An effort the model doesn't take is left off, as `takesEffort` does for Claude.
  const effort = connection.effort && effortsFor(provider, model).includes(connection.effort) ? connection.effort : undefined;
  const baseUrl = connection.baseUrl?.trim();
  const headers = headersOf(connection);
  // The same gateway settings as `clientOptions` gives Claude's SDK.
  const openai = { ...(baseUrl && { baseURL: baseUrl }), ...(Object.keys(headers).length > 0 && { defaultHeaders: headers }), fetch };
  switch (provider) {
    case "claude":
      return claudeConversations(connection.apiKey, { ...clientOptions(connection), fetch }, modelChoice({ ...connection, model }), capabilities);
    case "openai":
      return openaiConversations(
        connection.apiKey,
        openai,
        { model, ...(effort && { effort: effort as OpenAIChoice["effort"] }) },
        capabilities,
      );
    case "grok":
      return grokConversations(
        connection.apiKey,
        { ...openai, baseURL: baseUrl || providerOf("grok").baseUrl },
        { model, ...(effort && { effort: effort as OpenAIChoice["effort"] }) },
        capabilities,
      );
    case "meta":
      return metaConversations(
        connection.apiKey,
        { ...openai, baseURL: baseUrl || providerOf("meta").baseUrl },
        { model, ...(effort && { effort: effort as OpenAIChoice["effort"] }) },
        capabilities,
      );
    case "local":
      return localConversations(
        connection.apiKey,
        { ...openai, baseURL: baseUrl || providerOf("local").baseUrl },
        { model },
        capabilities,
      );
    case "gemini":
      return geminiConversations(
        connection.apiKey,
        { ...(baseUrl && { baseUrl }), headers, ...(fetch && { fetch }) },
        { model, ...(effort && { effort }) },
        capabilities,
      );
  }
}

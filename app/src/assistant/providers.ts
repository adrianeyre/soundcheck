/**
 * One way in to every provider: a connection becomes the `StartConversation`
 * that `runRequest` talks through, whichever model is behind it. Every
 * provider's requests go through the `fetch` given here, the platform's.
 */
import type { StartConversation, StartExchange } from "./assistant";
import { assistantModel, effortsFor, provider as providerOf, type ProviderId } from "./catalogue";
import { claudeConversations, claudeExchanges } from "./claude";
import { capabilitiesFor, clientOptions, headersOf, modelChoice, type Connection } from "./connection";
import { geminiConversations, geminiExchanges } from "./gemini";
import {
  grokConversations,
  localConversations,
  metaConversations,
  openaiConversations,
  openaiExchanges,
  type OpenAIChoice,
} from "./openai";

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

/**
 * A one-off exchange with `provider`, outside any Request (`StartExchange`),
 * on the same key, model, effort and gateway as its Requests: what the Mix
 * Helper asks the musician's Provider through.
 */
export function exchangesFor(provider: ProviderId, connection: Connection, fetch: typeof globalThis.fetch | undefined): StartExchange {
  const model = assistantModel(provider, connection.model);
  const capabilities = capabilitiesFor(provider, connection);
  const effort = connection.effort && effortsFor(provider, model).includes(connection.effort) ? connection.effort : undefined;
  const baseUrl = connection.baseUrl?.trim();
  const headers = headersOf(connection);
  const openai = { ...(baseUrl && { baseURL: baseUrl }), ...(Object.keys(headers).length > 0 && { defaultHeaders: headers }), fetch };
  const choice = { model, ...(effort && { effort: effort as OpenAIChoice["effort"] }) };
  switch (provider) {
    case "claude":
      return claudeExchanges(connection.apiKey, { ...clientOptions(connection), fetch }, modelChoice({ ...connection, model }), capabilities);
    case "openai":
      return openaiExchanges("openai", connection.apiKey, openai, choice, capabilities);
    case "grok":
    case "meta":
    case "local":
      return openaiExchanges(provider, connection.apiKey, { ...openai, baseURL: baseUrl || providerOf(provider).baseUrl }, choice, capabilities);
    case "gemini":
      return geminiExchanges(
        connection.apiKey,
        { ...(baseUrl && { baseUrl }), headers, ...(fetch && { fetch }) },
        { model, ...(effort && { effort }) },
        capabilities,
      );
  }
}

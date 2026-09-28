/**
 * How the Assistant reaches its model: which provider, and for each one the
 * user's API key, which model to use at what effort, and optionally a base
 * URL and extra headers for a gateway in front of the API.
 *
 * All of it is kept together by the platform's key store, never in a
 * Project: a header can carry a token as secret as the key. Settings with
 * only Claude's connection are saved as that connection alone, and a
 * connection with only a key as the bare key, so what was saved before the
 * rest existed still reads, as Claude's.
 */
import {
  ADJUSTABLE_CAPABILITIES,
  assistantModel,
  capabilitiesOf,
  contextWindowOf,
  effortsFor,
  isProviderId,
  LOCAL_CONTEXT,
  provider as providerOf,
  PROVIDERS,
  type AdjustableCapability,
  type Capabilities,
  type ProviderId,
} from "./catalogue";
import type { RequestMode } from "./assistant";
import type { ClaudeOptions, Effort, ModelChoice } from "./claude";
import type { JevConnection } from "./jev";

/** One provider's connection. */
export interface Connection {
  /** Empty for a provider that needs none. */
  apiKey: string;
  /** Where to send requests instead of the provider's own API. */
  baseUrl?: string;
  /** `Name: value`, one per line, as `ANTHROPIC_CUSTOM_HEADERS` has them. */
  customHeaders?: string;
  /** Unset means the provider's default model. */
  model?: string;
  /** One of the model's effort levels; unset means the model's own default. */
  effort?: string;
  /**
   * Where the musician says the model can do more or less than the catalogue
   * declares, for a provider whose models vary by how they are run (Local).
   */
  capabilities?: Partial<Record<AdjustableCapability, boolean>>;
  /**
   * Whether a Request starts with the smaller core, for a provider with
   * small models; unset, it does.
   */
  smallCore?: boolean;
  /** Whether a Request makes a Suggestion; unset, only a provider with small models' does. */
  suggestion?: boolean;
  /**
   * Whether `analyse_audio` may send a model that takes audio the render
   * itself; unset, it doesn't, since audio costs more than the numbers.
   */
  hearAudio?: boolean;
  /**
   * How many tokens the server gives a turn, for a provider whose server
   * decides (Local); unset, Ollama's default.
   */
  contextWindow?: number;
}

/**
 * The chosen provider, and each provider's own connection, kept while
 * another is chosen; and the Decision Engine's, which is no provider.
 */
export interface Settings {
  provider: ProviderId;
  connections: Partial<Record<ProviderId, Connection>>;
  /** Jev's connection, where the musician set one up (`jev.ts`). */
  jev?: JevConnection;
}

/** A header name, as HTTP defines a token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function saveSettings(settings: Settings): string {
  const saved = Object.entries(settings.connections).filter(([, connection]) => connection);
  if (settings.provider === "claude" && saved.every(([id]) => id === "claude") && !settings.jev) {
    return saveConnection(settings.connections.claude ?? { apiKey: "" });
  }
  const connections = Object.fromEntries(saved.map(([id, connection]) => [id, stored(connection!)]));
  return JSON.stringify({ provider: settings.provider, connections, ...(settings.jev && { jev: storedJev(settings.jev) }) });
}

export function readSettings(saved: string): Settings {
  if (saved.startsWith("{")) {
    try {
      const parsed = JSON.parse(saved) as { provider?: unknown; connections?: unknown; jev?: unknown };
      if (isProviderId(parsed.provider) && typeof parsed.connections === "object" && parsed.connections) {
        const connections: Settings["connections"] = {};
        for (const { id } of PROVIDERS) {
          const connection = readFields(id, (parsed.connections as Record<string, unknown>)[id]);
          if (connection) connections[id] = connection;
        }
        const jev = readJev(parsed.jev);
        return { provider: parsed.provider, connections, ...(jev && { jev }) };
      }
    } catch {
      // Read it as Claude's connection, below.
    }
  }
  return { provider: "claude", connections: { claude: readConnection(saved) } };
}

/** Jev's fields worth keeping: blank ones are left out. */
function storedJev({ apiKey, baseUrl, model }: JevConnection): JevConnection {
  return { apiKey, ...(baseUrl?.trim() && { baseUrl: baseUrl.trim() }), ...(model?.trim() && { model: model.trim() }) };
}

function readJev(value: unknown): JevConnection | null {
  const parsed = (typeof value === "object" && value ? value : {}) as Partial<Record<keyof JevConnection, unknown>>;
  if (typeof parsed.apiKey !== "string" || !parsed.apiKey) return null;
  return {
    apiKey: parsed.apiKey,
    ...(typeof parsed.baseUrl === "string" && parsed.baseUrl && { baseUrl: parsed.baseUrl }),
    ...(typeof parsed.model === "string" && parsed.model && { model: parsed.model }),
  };
}

/**
 * The providers the musician has set up, in the catalogue's order: each
 * with a connection saved, with a key where it needs one. The Editor's
 * Request box lets them switch between these.
 */
export function readyProviders(settings: Settings | null): ProviderId[] {
  if (!settings) return [];
  return PROVIDERS.filter(({ id, needsKey }) => {
    const connection = settings.connections[id];
    return connection !== undefined && (!needsKey || connection.apiKey.trim().length > 0);
  }).map(({ id }) => id);
}

/** The connection the chosen provider uses; unset until one is entered. */
export function chosenConnection(settings: Settings | null): Connection | null {
  return settings?.connections[settings.provider] ?? null;
}

export function saveConnection(connection: Connection): string {
  const baseUrl = connection.baseUrl?.trim();
  const customHeaders = connection.customHeaders?.trim();
  const { model, effort, smallCore, suggestion, hearAudio, contextWindow } = connection;
  const modes = smallCore !== undefined || suggestion !== undefined || hearAudio !== undefined || contextWindow !== undefined;
  if (!baseUrl && !customHeaders && !model && !effort && !hasCapabilities(connection) && !modes) return connection.apiKey;
  return JSON.stringify(stored(connection));
}

/** The fields worth keeping: blank ones are left out. */
function stored(connection: Connection): Record<string, unknown> {
  const baseUrl = connection.baseUrl?.trim();
  const customHeaders = connection.customHeaders?.trim();
  const { model, effort, capabilities, smallCore, suggestion, hearAudio, contextWindow } = connection;
  return {
    apiKey: connection.apiKey,
    ...(baseUrl && { baseUrl }),
    ...(customHeaders && { customHeaders }),
    ...(model && { model }),
    ...(effort && { effort }),
    ...(hasCapabilities(connection) && { capabilities }),
    ...(smallCore !== undefined && { smallCore }),
    ...(suggestion !== undefined && { suggestion }),
    ...(hearAudio !== undefined && { hearAudio }),
    ...(contextWindow !== undefined && { contextWindow }),
  };
}

function hasCapabilities(connection: Connection): boolean {
  return Object.keys(connection.capabilities ?? {}).length > 0;
}

export function readConnection(saved: string): Connection {
  if (saved.startsWith("{")) {
    try {
      const connection = readFields("claude", JSON.parse(saved));
      if (connection) return connection;
    } catch {
      // Not ours: read it as a bare key, as it always was.
    }
  }
  return { apiKey: saved };
}

/** One provider's saved connection, keeping only the fields it can use. */
function readFields(provider: ProviderId, value: unknown): Connection | null {
  const parsed = (typeof value === "object" && value ? value : {}) as Partial<Record<keyof Connection, unknown>>;
  if (typeof parsed.apiKey !== "string") return null;
  // A model that can't use tools can't be the Assistant, so its provider's default is.
  const model = typeof parsed.model === "string" && assistantModel(provider, parsed.model) === parsed.model ? parsed.model : undefined;
  const levels = effortsFor(provider, model ?? "");
  const capabilities = readCapabilities(provider, parsed.capabilities);
  return {
    apiKey: parsed.apiKey,
    ...(typeof parsed.baseUrl === "string" && { baseUrl: parsed.baseUrl }),
    ...(typeof parsed.customHeaders === "string" && { customHeaders: parsed.customHeaders }),
    ...(model && { model }),
    ...(typeof parsed.effort === "string" && levels.includes(parsed.effort) && { effort: parsed.effort }),
    ...(Object.keys(capabilities).length > 0 && { capabilities }),
    ...(typeof parsed.smallCore === "boolean" && providerOf(provider).smallModels && { smallCore: parsed.smallCore }),
    ...(typeof parsed.suggestion === "boolean" && { suggestion: parsed.suggestion }),
    ...(typeof parsed.hearAudio === "boolean" && { hearAudio: parsed.hearAudio }),
    ...(isContextWindow(parsed.contextWindow) && providerOf(provider).adjustableCapabilities && { contextWindow: parsed.contextWindow }),
  };
}

/** The capabilities the musician set, where the provider lets them: each one a boolean. */
function readCapabilities(provider: ProviderId, value: unknown): NonNullable<Connection["capabilities"]> {
  if (!providerOf(provider).adjustableCapabilities || typeof value !== "object" || !value) return {};
  const saved = value as Record<string, unknown>;
  return Object.fromEntries(
    ADJUSTABLE_CAPABILITIES.filter((name) => typeof saved[name] === "boolean").map((name) => [name, saved[name]]),
  );
}

/**
 * What the connection's model can do: what the catalogue declares, with the
 * musician's changes where the provider takes them.
 */
export function capabilitiesFor(provider: ProviderId, connection: Connection): Capabilities {
  const declared = capabilitiesOf(provider, assistantModel(provider, connection.model));
  return providerOf(provider).adjustableCapabilities ? { ...declared, ...connection.capabilities } : declared;
}

/** A context window is a whole number of tokens, above none. */
export function isContextWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * How many tokens a turn of the connection's model can hold: the
 * catalogue's, or, where the server decides, what the musician set, or
 * Ollama's default.
 */
export function contextWindowFor(provider: ProviderId, connection: Connection): number {
  const declared = contextWindowOf(provider, assistantModel(provider, connection.model));
  if (providerOf(provider).adjustableCapabilities) return connection.contextWindow ?? declared ?? LOCAL_CONTEXT;
  return declared ?? LOCAL_CONTEXT;
}

/**
 * How the connection's Requests run: a provider with small models starts
 * with the smaller core and makes Suggestions, and the musician can turn
 * either off, or turn Suggestions on for any provider. The model hears
 * `analyse_audio`'s audio only where it takes audio and the musician turned
 * that on.
 */
export function requestModeFor(provider: ProviderId, connection: Connection): RequestMode {
  const { smallModels } = providerOf(provider);
  return {
    smallCore: smallModels && (connection.smallCore ?? true),
    suggestion: connection.suggestion ?? smallModels,
    hearsAudio: capabilitiesFor(provider, connection).audioInput && connection.hearAudio === true,
  };
}

/** What is wrong with a connection the user entered, or null when nothing is. */
export function checkConnection(connection: Connection): string | null {
  const baseUrl = connection.baseUrl?.trim();
  if (baseUrl && !/^https?:\/\/[^/\s]+/.test(baseUrl)) {
    return "The base URL must start with https:// or http://.";
  }
  for (const line of headerLines(connection.customHeaders)) {
    const colon = line.indexOf(":");
    if (colon < 1 || !HEADER_NAME.test(line.slice(0, colon).trim())) {
      return `Each custom header must be "Name: value" on its own line; "${line}" isn't.`;
    }
  }
  return null;
}

/** The SDK client settings a connection asks for. */
export function clientOptions(connection: Connection): ClaudeOptions {
  const baseUrl = connection.baseUrl?.trim();
  const headers = headersOf(connection);
  return {
    ...(baseUrl && { baseURL: baseUrl }),
    ...(Object.keys(headers).length > 0 && { defaultHeaders: headers }),
  };
}

/** The custom headers, by name. */
export function headersOf(connection: Connection): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerLines(connection.customHeaders)) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function headerLines(text = ""): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The model and effort a Claude connection asks for. */
export function modelChoice({ model, effort }: Connection): ModelChoice {
  return { ...(model && { model }), ...(effort && { effort: effort as Effort }) };
}

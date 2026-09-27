/**
 * What the real-model check (#27) needs from the API besides the app's own
 * code: which provider, model and version to run, the connection from the
 * environment, and a `fetch` that proves every answer came from that
 * provider's model and waits out a busy API.
 *
 * It is kept apart from `real-model-check.ts` so that it can be tested
 * without the network: nothing here calls a model unless given a `fetch`
 * that does.
 */
import { defaultModel, effortsFor, findModel, isProviderId, provider as providerOf, PROVIDERS, type ProviderId } from "../src/assistant/catalogue";
import type { Connection } from "../src/assistant/connection";

/** The MVP's scenarios (#27), then the v3 PRD's stories (#107), in the order they run. */
export const SCENARIOS = [
  "build",
  "clipping",
  "notes",
  "routing",
  "automation",
  "tempo",
  "sounds",
  "audioclips",
  "sections",
  "arrangement",
  "buildup",
  "conversation",
  "suggestion",
  "listening",
  "compare",
  "reference",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** Names for several scenarios at once. The one-loud-Track clipping fix is v3's story 16 as well as the MVP's. */
export const SCENARIO_GROUPS: Record<string, readonly Scenario[]> = {
  mvp: ["build", "clipping"],
  v3: SCENARIOS.filter((scenario) => scenario !== "build"),
};

/** What a run was asked to do, from the command line. */
export interface Choice {
  scenarios: Scenario[];
  provider: ProviderId;
  /** The id the provider's API calls it. */
  model: string;
  effort?: string;
}

/**
 * `[<scenario or group>…] [--provider <id>] [--model <family or id>] [--version <version>] [--effort <level>]`.
 * No scenario means all of them; `mvp` and `v3` name their groups. The model and version are the catalogue's, as the
 * Model and Version pickers show them ("Opus", "5.5"), or `--model` can be
 * the API's own id. Anything left out is the catalogue's default.
 */
export function parseArgs(args: readonly string[]): Choice {
  const scenarios = new Set<Scenario>();
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      const named = SCENARIO_GROUPS[arg] ?? ((SCENARIOS as readonly string[]).includes(arg) ? [arg as Scenario] : null);
      if (!named) {
        throw new Error(
          `There is no scenario "${arg}". Choose from: ${[...SCENARIOS, ...Object.keys(SCENARIO_GROUPS)].join(", ")}.`,
        );
      }
      for (const scenario of named) scenarios.add(scenario);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals < 0 ? undefined : equals);
    if (!["provider", "model", "version", "effort"].includes(name)) throw new Error(`There is no option "--${name}".`);
    const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
    if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
    options[name] = value;
  }

  const provider = options.provider ?? "claude";
  if (!isProviderId(provider)) {
    throw new Error(`There is no provider "${provider}". Choose from: ${PROVIDERS.map(({ id }) => id).join(", ")}.`);
  }
  const model = modelFor(provider, options.model, options.version);
  const effort = options.effort;
  if (effort !== undefined && !effortsFor(provider, model).includes(effort)) {
    const levels = effortsFor(provider, model);
    throw new Error(
      levels.length === 0
        ? `${model} has no effort setting.`
        : `${model} has no effort "${effort}". Choose from: ${levels.join(", ")}.`,
    );
  }
  // In the order they run, whatever order they were named in.
  const chosen = scenarios.size > 0 ? SCENARIOS.filter((scenario) => scenarios.has(scenario)) : [...SCENARIOS];
  return { scenarios: chosen, provider, model, ...(effort && { effort }) };
}

function modelFor(provider: ProviderId, model: string | undefined, version: string | undefined): string {
  const { families } = providerOf(provider);
  if (model === undefined && version === undefined) return defaultModel(provider);
  if (model !== undefined && findModel(provider, model)) {
    if (version !== undefined && findModel(provider, model)!.version.name !== version) {
      throw new Error(`--model ${model} is already one version; leave out --version.`);
    }
    return model;
  }
  const family =
    model === undefined ? families[0]! : families.find((each) => each.name.toLowerCase() === model.toLowerCase());
  // A model the catalogue doesn't list is still choosable, as it is in the app.
  if (!family) {
    if (version !== undefined) throw new Error(`The catalogue has no model "${model}" to take --version from.`);
    return model!;
  }
  if (version === undefined) return family.versions[0]!.id;
  const found = family.versions.find((each) => each.name === version);
  if (!found) {
    throw new Error(`${family.name} has no version "${version}". Choose from: ${family.versions.map(({ name }) => name).join(", ")}.`);
  }
  return found.id;
}

/** Where each provider's key, base URL and custom headers come from. */
export const ENVIRONMENT: Record<ProviderId, { apiKey: string; baseUrl: string; customHeaders: string }> = {
  claude: { apiKey: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL", customHeaders: "ANTHROPIC_CUSTOM_HEADERS" },
  openai: { apiKey: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL", customHeaders: "OPENAI_CUSTOM_HEADERS" },
  gemini: { apiKey: "GEMINI_API_KEY", baseUrl: "GEMINI_BASE_URL", customHeaders: "GEMINI_CUSTOM_HEADERS" },
  grok: { apiKey: "XAI_API_KEY", baseUrl: "XAI_BASE_URL", customHeaders: "XAI_CUSTOM_HEADERS" },
  local: { apiKey: "LOCAL_API_KEY", baseUrl: "LOCAL_BASE_URL", customHeaders: "LOCAL_CUSTOM_HEADERS" },
};

/**
 * The connection the app would save for this choice, from the environment.
 * The custom headers are kept and sent: behind a gateway they can decide
 * which provider answers.
 */
export function connectionFromEnvironment(choice: Choice, env: Record<string, string | undefined>): Connection {
  const names = ENVIRONMENT[choice.provider];
  const apiKey = env[names.apiKey] ?? "";
  if (!apiKey && providerOf(choice.provider).needsKey) {
    throw new Error(`Set ${names.apiKey}: this check calls the real ${providerOf(choice.provider).name} API.`);
  }
  const baseUrl = env[names.baseUrl]?.trim();
  const customHeaders = env[names.customHeaders]?.trim();
  return {
    apiKey,
    ...(baseUrl && { baseUrl }),
    ...(customHeaders && { customHeaders }),
    model: choice.model,
    ...(choice.effort && { effort: choice.effort }),
  };
}

/**
 * Whether a model an API answered with is one of the provider's own. A
 * gateway can fail a request over to another provider and still answer it,
 * so the model asked for proves nothing; the one in the response does. A
 * local server answers with whatever it has loaded, and has no other
 * provider to fail over to, so any named model is its own.
 */
export function isProvidersModel(provider: ProviderId, model: string | null): boolean {
  if (!model) return false;
  switch (provider) {
    case "claude":
      return model.startsWith("claude");
    case "openai":
      return /^(gpt-|chatgpt-|o\d)/.test(model);
    case "gemini":
      return /^(models\/)?gemini-/.test(model);
    case "grok":
      return model.startsWith("grok-");
    case "local":
      return true;
  }
}

/** The model a successful response names: Gemini calls it `modelVersion`. */
export function responseModel(provider: ProviderId, body: unknown): string | null {
  const fields = (typeof body === "object" && body ? body : {}) as Record<string, unknown>;
  const model = provider === "gemini" ? fields.modelVersion : fields.model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

export interface Usage {
  calls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export function noUsage(): Usage {
  return { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

/** One response's token use, in each provider's own terms. Input excludes cache reads. */
export function usageOf(provider: ProviderId, body: unknown): Omit<Usage, "calls"> {
  const fields = (typeof body === "object" && body ? body : {}) as Record<string, Record<string, unknown> | undefined>;
  if (provider === "claude") {
    const usage = fields.usage ?? {};
    return {
      input: number(usage.input_tokens),
      output: number(usage.output_tokens),
      cacheWrite: number(usage.cache_creation_input_tokens),
      cacheRead: number(usage.cache_read_input_tokens),
    };
  }
  if (provider === "gemini") {
    const usage = fields.usageMetadata ?? {};
    const cached = number(usage.cachedContentTokenCount);
    return {
      input: number(usage.promptTokenCount) - cached,
      output: number(usage.candidatesTokenCount) + number(usage.thoughtsTokenCount),
      cacheWrite: 0,
      cacheRead: cached,
    };
  }
  const usage = fields.usage ?? {};
  const cached = number((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  // xAI counts the reasoning apart from the completion; OpenAI's completion includes it.
  const reasoning = provider === "grok" ? number((usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens) : 0;
  return { input: number(usage.prompt_tokens) - cached, output: number(usage.completion_tokens) + reasoning, cacheWrite: 0, cacheRead: cached };
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** US$ per million tokens. Only the models a check has been costed for. */
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  // A cache write is 1.25 times input.
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};

/** The estimated cost in US$, or null for a model with no price on record. */
export function cost(model: string, usage: Usage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const dollars =
    usage.input * price.input + usage.output * price.output + usage.cacheWrite * price.cacheWrite + usage.cacheRead * price.cacheRead;
  return dollars / 1_000_000;
}

/**
 * How long a 429 or 503 says to wait, in ms, or null when it doesn't say.
 * `retry-after-ms` and `retry-after` come first, then any rate-limit reset
 * header: Anthropic's are timestamps, OpenAI's durations such as `6m0s`.
 */
export function resetDelay(headers: Headers, now: number): number | null {
  const ms = Number(headers.get("retry-after-ms") ?? Number.NaN);
  if (Number.isFinite(ms)) return Math.max(0, ms);
  const retryAfter = headers.get("retry-after");
  const after = retryAfter === null ? null : until(retryAfter, now);
  if (after !== null) return after;
  const resets: number[] = [];
  for (const [name, value] of headers) {
    if (!/ratelimit.*reset/i.test(name)) continue;
    const reset = until(value, now);
    if (reset !== null) resets.push(reset);
  }
  return resets.length > 0 ? Math.max(...resets) : null;
}

function until(value: string, now: number): number | null {
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const count = Number(text);
    // A number that large is a Unix time, not a wait.
    return count > 1e9 ? Math.max(0, count * 1000 - now) : count * 1000;
  }
  const duration = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(text);
  if (text && duration) {
    const [, hours, minutes, secs, ms] = duration.map(Number) as number[];
    return (hours || 0) * 3_600_000 + (minutes || 0) * 60_000 + (secs || 0) * 1000 + (ms || 0);
  }
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Each response one Request got, by status and the model that answered, and each wait. */
export interface RequestRecord {
  responses: { status: number; model: string | null }[];
  waits: { status: number; seconds: number }[];
  usage: Usage;
  /**
   * The whole prompt of the Request's first call, in tokens as its API
   * counted them (input, cache writes and cache reads): the system prompt,
   * the tools and the Project summary. Null until a call succeeds.
   */
  firstPrompt: number | null;
}

/** The waits one Request may spend on a busy API before the check gives up. */
export const WAIT_BUDGET_MS = 10 * 60_000;
const FIRST_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
/** How long one call may take before it is abandoned: the SDKs' own default. */
const CALL_TIMEOUT_MS = 10 * 60_000;

export interface WatchOptions {
  provider: ProviderId;
  /** The model asked for, to name in a failure. */
  model: string;
  fetch: typeof globalThis.fetch;
  /** Headers every request must carry, such as a gateway's routing header; a request without one isn't sent. */
  requiredHeaders?: readonly string[];
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * A `fetch` for the providers' SDKs that
 * - records the model named by every response, and stops the check as soon
 *   as one isn't the provider's: the run says nothing about the model chosen;
 * - waits out a 429 or 503, for as long as it says or with backoff, logging
 *   each wait, for up to `WAIT_BUDGET_MS` per Request;
 * - stops the check at once on a 429 with no reset time, which won't pass.
 * Once stopped, it sends nothing more, so the SDKs' own retries cost nothing.
 */
export function watchedFetch(options: WatchOptions) {
  const { provider, model, requiredHeaders = [], log = console.log } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const send = options.fetch;
  const name = providerOf(provider).name;
  let record: RequestRecord = { responses: [], waits: [], usage: noUsage(), firstPrompt: null };
  let waited = 0;
  let stopped: string | null = null;

  const watched: typeof globalThis.fetch = async (input, init) => {
    if (stopped !== null) throw new Error(`Not sent: the check has stopped. ${stopped}`);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, header) => headers.set(header, value));
    const missing = requiredHeaders.filter((header) => !headers.has(header));
    if (missing.length > 0) {
      stopped = `A request was about to go without the ${missing.join(", ")} header(s), so it wasn't sent.`;
      throw new Error(`Not sent: ${stopped}`);
    }

    for (let attempt = 1; ; attempt++) {
      // A fresh timeout for each call: the SDK's own would count the waits too.
      const response = await send(input, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (response.status !== 429 && response.status !== 503) return read(response);
      const said = excerpt(await response.clone().text());
      const reset = resetDelay(response.headers, now());
      const left = WAIT_BUDGET_MS - waited;
      if (response.status === 429 && reset === null) {
        stopped = noReset(provider, said);
      } else if (left <= 0 || (reset !== null && reset > left)) {
        stopped = gaveUp(provider, response.status, waited, reset, said);
      }
      if (stopped !== null) {
        record.responses.push({ status: response.status, model: null });
        return response;
      }
      const wait = Math.min(reset ?? Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** (attempt - 1)), left);
      waited += wait;
      record.waits.push({ status: response.status, seconds: wait / 1000 });
      log(
        `   ${response.status} from ${name}${said && ` (${said})`}; waiting ${seconds(wait)} ` +
          `(${reset === null ? "backoff" : "as it asked"}; ${seconds(waited)} of this Request's ${seconds(WAIT_BUDGET_MS)} used)`,
      );
      await sleep(wait);
    }
  };

  async function read(response: Response): Promise<Response> {
    if (!response.ok) {
      record.responses.push({ status: response.status, model: null });
      return response;
    }
    let body: unknown = null;
    try {
      body = await response.clone().json();
    } catch {
      // No JSON, so no model named: it fails the check below.
    }
    const answered = responseModel(provider, body);
    record.responses.push({ status: response.status, model: answered });
    const counted = usageOf(provider, body);
    record.usage.calls++;
    record.usage.input += counted.input;
    record.usage.output += counted.output;
    record.usage.cacheWrite += counted.cacheWrite;
    record.usage.cacheRead += counted.cacheRead;
    record.firstPrompt ??= counted.input + counted.cacheWrite + counted.cacheRead;
    if (!isProvidersModel(provider, answered)) stopped = foreignModel(provider, model, answered);
    return response;
  }

  return {
    fetch: watched,
    /** Starts a Request's record, and its wait budget, afresh. */
    beginRequest(): RequestRecord {
      record = { responses: [], waits: [], usage: noUsage(), firstPrompt: null };
      waited = 0;
      return record;
    },
    /** Why the check stopped, or null while it may go on. */
    get stopped(): string | null {
      return stopped;
    },
  };

  function foreignModel(id: ProviderId, asked: string, answered: string | null): string {
    const what = answered === null ? "a response that names no model" : `the model "${answered}"`;
    const gateway =
      id === "claude"
        ? " Through a gateway that routes by a header, keep that header in ANTHROPIC_CUSTOM_HEADERS, which stops it failing over to another provider."
        : "";
    return (
      `${name} was asked for "${asked}" and answered with ${what}, which isn't ${name}'s. ` +
      `A gateway in front of the API most likely failed the request over to another provider.${gateway} ` +
      `This run is not a result for ${name}.`
    );
  }
}

function noReset(provider: ProviderId, said: string): string {
  const got = `429 with no reset time${said && ` (${said})`}.`;
  if (provider === "claude") {
    return (
      `${got} This most likely means the credentials are a Claude subscription (OAuth) account, which Anthropic ` +
      `doesn't let answer traffic that doesn't come from Claude Code. This check needs an Anthropic API-key ` +
      `(pay-as-you-go) account, directly or behind the gateway. Waiting won't help.`
    );
  }
  return `${got} The account most likely has no quota left for this model, or refuses this kind of traffic. Waiting won't help.`;
}

function gaveUp(provider: ProviderId, status: number, waited: number, reset: number | null, said: string): string {
  const got =
    reset !== null && waited < WAIT_BUDGET_MS
      ? `${status}, asking to wait ${seconds(reset)}, more than is left of this Request's ${seconds(WAIT_BUDGET_MS)}`
      : `Still ${status} after waiting ${seconds(waited)}`;
  const gateway =
    provider === "claude" && status === 503
      ? " Through a gateway, a 503 can mean no Claude account would take the request. If its Claude accounts are " +
        "subscription (OAuth) ones, they refuse traffic that doesn't come from Claude Code, and an Anthropic API-key account is needed."
      : "";
  return `${got}${said && ` (${said})`}.${gateway}`;
}

function excerpt(text: string): string {
  const line = text.replaceAll(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function seconds(ms: number): string {
  const whole = Math.round(ms / 1000);
  return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)} min${whole % 60 ? ` ${whole % 60} s` : ""}`;
}

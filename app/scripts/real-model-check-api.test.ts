import { describe, expect, it } from "vitest";

import {
  connectionFromEnvironment,
  cost,
  isProvidersModel,
  noUsage,
  parseArgs,
  resetDelay,
  SCENARIOS,
  responseModel,
  usageOf,
  WAIT_BUDGET_MS,
  watchedFetch,
  type WatchOptions,
} from "./real-model-check-api";

describe("parseArgs", () => {
  it("defaults to every scenario on Claude's default model", () => {
    expect(parseArgs([])).toEqual({ scenarios: [...SCENARIOS], provider: "claude", model: "claude-opus-5-5" });
  });

  it("takes a group of scenarios, and runs each once in its order", () => {
    expect(parseArgs(["mvp"]).scenarios).toEqual(["build", "clipping"]);
    expect(parseArgs(["v3"]).scenarios).toEqual(SCENARIOS.filter((scenario) => scenario !== "build"));
    expect(parseArgs(["conversation", "v3", "notes"]).scenarios).toEqual(parseArgs(["v3"]).scenarios);
    expect(parseArgs(["suggestion", "build"]).scenarios).toEqual(["build", "suggestion"]);
    expect(() => parseArgs(["mastering"])).toThrow(/no scenario "mastering".*compare, reference, mvp, v3/);
  });

  it("takes scenarios, and a provider, model and version as the pickers name them", () => {
    expect(parseArgs(["clipping", "--provider", "claude", "--model", "sonnet", "--version=4.6"])).toEqual({
      scenarios: ["clipping"],
      provider: "claude",
      model: "claude-sonnet-4-6",
    });
  });

  it("takes a family's default version, or a version of the default family", () => {
    expect(parseArgs(["--model", "Fable"]).model).toBe("claude-fable-5-1");
    expect(parseArgs(["--version", "4.8"]).model).toBe("claude-opus-4-8");
    expect(parseArgs(["--provider", "gemini"]).model).toBe("gemini-3.8-flash");
  });

  it("takes an API model id, listed or not", () => {
    expect(parseArgs(["--model", "claude-haiku-4-5"]).model).toBe("claude-haiku-4-5");
    expect(parseArgs(["--provider", "local", "--model", "phi4:14b"]).model).toBe("phi4:14b");
  });

  it("takes an effort the model has, and refuses one it hasn't", () => {
    expect(parseArgs(["--effort", "high"]).effort).toBe("high");
    expect(() => parseArgs(["--model", "sonnet", "--version", "4.6", "--effort", "xhigh"])).toThrow(/no effort "xhigh"/);
    expect(() => parseArgs(["--model", "haiku", "--effort", "low"])).toThrow(/no effort setting/);
  });

  it("refuses what it doesn't know", () => {
    expect(() => parseArgs(["listen"])).toThrow(/no scenario "listen"/);
    expect(() => parseArgs(["--provider", "mistral"])).toThrow(/no provider "mistral"/);
    expect(() => parseArgs(["--model", "opus", "--version", "9"])).toThrow(/Opus has no version "9"/);
    expect(() => parseArgs(["--model"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--key", "x"])).toThrow(/no option "--key"/);
  });
});

describe("connectionFromEnvironment", () => {
  it("keeps ANTHROPIC_CUSTOM_HEADERS, so a gateway's routing header is sent", () => {
    const connection = connectionFromEnvironment(parseArgs([]), {
      ANTHROPIC_API_KEY: "key",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_CUSTOM_HEADERS: "x-gateway-exclude-providers: codex",
    });
    expect(connection).toEqual({
      apiKey: "key",
      baseUrl: "https://gateway.example",
      customHeaders: "x-gateway-exclude-providers: codex",
      model: "claude-opus-5-5",
    });
  });

  it("asks for the provider's key, except Local's", () => {
    expect(() => connectionFromEnvironment(parseArgs(["--provider", "openai"]), {})).toThrow(/Set OPENAI_API_KEY/);
    expect(connectionFromEnvironment(parseArgs(["--provider", "local"]), {}).apiKey).toBe("");
  });
});

describe("the model check", () => {
  it("reads the model each provider's response names", () => {
    expect(responseModel("claude", { model: "claude-opus-5-5" })).toBe("claude-opus-5-5");
    expect(responseModel("gemini", { modelVersion: "gemini-3.8-flash" })).toBe("gemini-3.8-flash");
    expect(responseModel("openai", {})).toBeNull();
  });

  it("accepts only the provider's own models", () => {
    expect(isProvidersModel("claude", "claude-opus-5-5")).toBe(true);
    expect(isProvidersModel("claude", "gpt-5.5")).toBe(false);
    expect(isProvidersModel("claude", null)).toBe(false);
    expect(isProvidersModel("openai", "gpt-6-sol-2026-08-01")).toBe(true);
    expect(isProvidersModel("openai", "claude-opus-5-5")).toBe(false);
    expect(isProvidersModel("gemini", "gemini-3.8-flash")).toBe(true);
    expect(isProvidersModel("local", "llama3.1:8b")).toBe(true);
    expect(isProvidersModel("grok", "grok-4.7")).toBe(true);
    expect(isProvidersModel("grok", "gpt-6-astra")).toBe(false);
  });
});

describe("usage and cost", () => {
  it("reads token use in each provider's terms, cache reads apart from input", () => {
    expect(usageOf("claude", { usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 } })).toEqual({
      input: 10,
      output: 2,
      cacheWrite: 0,
      cacheRead: 5,
    });
    expect(
      usageOf("openai", { usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }),
    ).toEqual({ input: 6, output: 2, cacheWrite: 0, cacheRead: 4 });
    expect(
      usageOf("gemini", {
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 1 },
      }),
    ).toEqual({ input: 9, output: 5, cacheWrite: 0, cacheRead: 1 });
    // xAI's completion leaves out the reasoning, which is billed as output too.
    expect(
      usageOf("grok", { usage: { prompt_tokens: 10, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 3 } } }),
    ).toEqual({ input: 10, output: 5, cacheWrite: 0, cacheRead: 0 });
  });

  it("prices only a model it has a price for", () => {
    const usage = { ...noUsage(), input: 1_000_000, output: 100_000 };
    expect(cost("claude-opus-5-5", usage)).toBeCloseTo(6);
    expect(cost("gpt-5.5", usage)).toBeNull();
  });
});

describe("resetDelay", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const delay = (headers: Record<string, string>) => resetDelay(new Headers(headers), now);

  it("reads retry-after in seconds, milliseconds or as a date", () => {
    expect(delay({ "retry-after": "30" })).toBe(30_000);
    expect(delay({ "retry-after-ms": "1500", "retry-after": "30" })).toBe(1500);
    expect(delay({ "retry-after": "Thu, 24 Sep 2026 12:01:00 GMT" })).toBe(60_000);
  });

  it("reads rate-limit resets as timestamps or durations, taking the latest", () => {
    expect(
      delay({
        "anthropic-ratelimit-requests-reset": "2026-09-24T12:00:10Z",
        "anthropic-ratelimit-tokens-reset": "2026-09-24T12:00:40Z",
      }),
    ).toBe(40_000);
    expect(delay({ "x-ratelimit-reset-tokens": "6m0s" })).toBe(360_000);
    expect(delay({ "x-ratelimit-reset-requests": "20ms" })).toBe(20);
  });

  it("is null when nothing says when", () => {
    expect(delay({})).toBeNull();
    expect(delay({ "retry-after": "soon" })).toBeNull();
  });
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) => new Response("busy", { status: code, headers });

function watch(responses: Response[], options: Partial<WatchOptions> = {}) {
  const sent: RequestInit[] = [];
  const waits: number[] = [];
  const log: string[] = [];
  const watcher = watchedFetch({
    provider: "claude",
    model: "claude-opus-5-5",
    fetch: (_input, init) => {
      sent.push(init ?? {});
      const next = responses.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error("no more responses"));
    },
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    now: () => 0,
    log: (line) => log.push(line),
    ...options,
  });
  return { watcher, sent, waits, log };
}

describe("watchedFetch", () => {
  it("records the model and usage of every response", async () => {
    const { watcher } = watch([
      ok({ model: "claude-opus-5-5", usage: { input_tokens: 3, output_tokens: 1 } }),
      ok({ model: "claude-opus-5-5", usage: { input_tokens: 4, output_tokens: 2 } }),
    ]);
    const record = watcher.beginRequest();
    await watcher.fetch("https://api.example/v1/messages", {});
    await watcher.fetch("https://api.example/v1/messages", {});
    expect(record.responses).toEqual([
      { status: 200, model: "claude-opus-5-5" },
      { status: 200, model: "claude-opus-5-5" },
    ]);
    expect(record.usage).toEqual({ calls: 2, input: 7, output: 3, cacheWrite: 0, cacheRead: 0 });
    expect(watcher.stopped).toBeNull();
  });

  it("records the first call's whole prompt, cached or not, for each Request", async () => {
    const { watcher } = watch([
      ok({ model: "claude-opus-5-5", usage: { input_tokens: 30, cache_creation_input_tokens: 5000, cache_read_input_tokens: 200, output_tokens: 1 } }),
      ok({ model: "claude-opus-5-5", usage: { input_tokens: 400, output_tokens: 2 } }),
      ok({ model: "claude-opus-5-5", usage: { input_tokens: 6, output_tokens: 2 } }),
    ]);
    const first = watcher.beginRequest();
    expect(first.firstPrompt).toBeNull();
    await watcher.fetch("https://api.example/v1/messages", {});
    await watcher.fetch("https://api.example/v1/messages", {});
    expect(first.firstPrompt).toBe(5230);
    const second = watcher.beginRequest();
    await watcher.fetch("https://api.example/v1/messages", {});
    expect(second.firstPrompt).toBe(6);
  });

  it("stops the check when another provider's model answers, and sends nothing more", async () => {
    const { watcher, sent } = watch([ok({ model: "gpt-5.5" }), ok({ model: "claude-opus-5-5" })]);
    const record = watcher.beginRequest();
    const response = await watcher.fetch("https://api.example/v1/messages", {});
    expect(response.status).toBe(200);
    expect(record.responses).toEqual([{ status: 200, model: "gpt-5.5" }]);
    expect(watcher.stopped).toMatch(/answered with the model "gpt-5.5", which isn't Claude's/);
    expect(watcher.stopped).toMatch(/not a result for Claude/);
    await expect(watcher.fetch("https://api.example/v1/messages", {})).rejects.toThrow(/Not sent/);
    expect(sent).toHaveLength(1);
  });

  it("stops the check on a response that names no model", async () => {
    const { watcher } = watch([new Response("not json", { status: 200 })]);
    watcher.beginRequest();
    await watcher.fetch("https://api.example/v1/messages", {});
    expect(watcher.stopped).toMatch(/names no model/);
  });

  it("waits out a 503 with backoff, logging each wait, then goes on", async () => {
    const { watcher, waits, log, sent } = watch([status(503), status(503), ok({ model: "claude-opus-5-5" })]);
    const record = watcher.beginRequest();
    const response = await watcher.fetch("https://api.example/v1/messages", { body: "{}" });
    expect(response.status).toBe(200);
    expect(waits).toEqual([5_000, 10_000]);
    expect(record.waits).toEqual([
      { status: 503, seconds: 5 },
      { status: 503, seconds: 10 },
    ]);
    expect(log).toHaveLength(2);
    expect(log[1]).toMatch(/503 from Claude \(busy\); waiting 10 s \(backoff; 15 s of this Request's 10 min used\)/);
    expect(sent.every((init) => init.body === "{}")).toBe(true);
    expect(watcher.stopped).toBeNull();
  });

  it("waits as long as a 429 asks", async () => {
    const { watcher, waits } = watch([status(429, { "retry-after": "20" }), ok({ model: "claude-opus-5-5" })]);
    watcher.beginRequest();
    await watcher.fetch("https://api.example/v1/messages", {});
    expect(waits).toEqual([20_000]);
  });

  it("stops at once on a 429 with no reset time, naming subscription credentials", async () => {
    const { watcher, waits } = watch([status(429)]);
    watcher.beginRequest();
    const response = await watcher.fetch("https://api.example/v1/messages", {});
    expect(response.status).toBe(429);
    expect(waits).toEqual([]);
    expect(watcher.stopped).toMatch(/429 with no reset time/);
    expect(watcher.stopped).toMatch(/Claude subscription \(OAuth\) account/);
    expect(watcher.stopped).toMatch(/API-key/);
  });

  it("gives up after about 10 minutes of waiting in one Request, and starts afresh with the next", async () => {
    const busy = Array.from({ length: 20 }, () => status(503));
    const { watcher, waits } = watch(busy);
    watcher.beginRequest();
    const response = await watcher.fetch("https://api.example/v1/messages", {});
    expect(response.status).toBe(503);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(WAIT_BUDGET_MS);
    expect(watcher.stopped).toMatch(/Still 503 after waiting 10 min/);
    expect(watcher.stopped).toMatch(/API-key account is needed/);
  });

  it("gives up rather than wait past the budget", async () => {
    const { watcher, waits } = watch([status(429, { "retry-after": "900" })]);
    watcher.beginRequest();
    await watcher.fetch("https://api.example/v1/messages", {});
    expect(waits).toEqual([]);
    expect(watcher.stopped).toMatch(/asking to wait 15 min/);
  });

  it("gives each Request its own wait budget", async () => {
    const { watcher, waits } = watch([status(503), ok({ model: "claude-opus-5-5" }), status(503), ok({ model: "claude-opus-5-5" })], {});
    watcher.beginRequest();
    await watcher.fetch("https://api.example/v1/messages", {});
    const second = watcher.beginRequest();
    await watcher.fetch("https://api.example/v1/messages", {});
    expect(waits).toEqual([5_000, 5_000]);
    expect(second.waits).toEqual([{ status: 503, seconds: 5 }]);
  });

  it("sends nothing without a required header", async () => {
    const { watcher, sent } = watch([ok({ model: "claude-opus-5-5" })], {
      requiredHeaders: ["x-gateway-exclude-providers"],
    });
    watcher.beginRequest();
    await expect(watcher.fetch("https://api.example/v1/messages", { headers: {} })).rejects.toThrow(/Not sent/);
    expect(sent).toHaveLength(0);
    expect(watcher.stopped).toMatch(/x-gateway-exclude-providers/);
  });

  it("sends a request carrying the required header", async () => {
    const { watcher, sent } = watch([ok({ model: "claude-opus-5-5" })], {
      requiredHeaders: ["x-gateway-exclude-providers"],
    });
    watcher.beginRequest();
    await watcher.fetch("https://api.example/v1/messages", {
      headers: new Headers({ "X-Gateway-Exclude-Providers": "codex" }),
    });
    expect(sent).toHaveLength(1);
    expect(watcher.stopped).toBeNull();
  });
});

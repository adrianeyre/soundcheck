import { expect, test } from "vitest";

import { assistantModel, defaultModel } from "./catalogue";
import { addTextOnlyModel, TEXT_ONLY_MODEL } from "./test-catalogue";
import {
  capabilitiesFor,
  checkConnection,
  clientOptions,
  contextWindowFor,
  modelChoice,
  readConnection,
  readSettings,
  readyProviders,
  requestModeFor,
  saveConnection,
  saveSettings,
  type Settings,
} from "./connection";

test("a key on its own is saved as the bare key, so keys saved before this still read", () => {
  expect(saveConnection({ apiKey: "sk-test" })).toBe("sk-test");
  expect(readConnection("sk-test")).toEqual({ apiKey: "sk-test" });
});

test("a base URL and custom headers are saved with the key and read back", () => {
  const connection = {
    apiKey: "sk-test",
    baseUrl: "https://gateway.example.com",
    customHeaders: "x-team: audio\nx-route: eu",
  };
  expect(readConnection(saveConnection(connection))).toEqual(connection);
});

test("blank settings are left out rather than saved empty", () => {
  expect(saveConnection({ apiKey: "sk-test", baseUrl: "  ", customHeaders: "\n" })).toBe("sk-test");
});

test("the client gets the base URL and the headers, one per line, as ANTHROPIC_CUSTOM_HEADERS writes them", () => {
  expect(
    clientOptions({
      apiKey: "sk-test",
      baseUrl: "https://gateway.example.com/",
      customHeaders: "x-team: audio\n\n  x-route:eu:west  \n",
    }),
  ).toEqual({
    baseURL: "https://gateway.example.com/",
    defaultHeaders: { "x-team": "audio", "x-route": "eu:west" },
  });
  expect(clientOptions({ apiKey: "sk-test" })).toEqual({});
});

test("a base URL that isn't http(s) and a header line with no name are refused, saying which", () => {
  expect(checkConnection({ apiKey: "sk-test", baseUrl: "gateway.example.com" })).toBe(
    "The base URL must start with https:// or http://.",
  );
  expect(checkConnection({ apiKey: "sk-test", customHeaders: "x-team audio" })).toBe(
    'Each custom header must be "Name: value" on its own line; "x-team audio" isn\'t.',
  );
  expect(checkConnection({ apiKey: "sk-test", customHeaders: "bad name: 1" })).toBe(
    'Each custom header must be "Name: value" on its own line; "bad name: 1" isn\'t.',
  );
  expect(checkConnection({ apiKey: "sk-test", baseUrl: "http://localhost:8080", customHeaders: "a: 1" })).toBeNull();
});

test("the model and effort are saved with the key, and an effort that isn't one is dropped", () => {
  const connection = { apiKey: "sk-test", model: "claude-sonnet-5", effort: "high" as const };
  expect(readConnection(saveConnection(connection))).toEqual(connection);
  expect(modelChoice(connection)).toEqual({ model: "claude-sonnet-5", effort: "high" });
  expect(modelChoice({ apiKey: "sk-test" })).toEqual({});
  expect(readConnection(JSON.stringify({ apiKey: "sk-test", effort: "extreme" }))).toEqual({ apiKey: "sk-test" });
});

test("a bare key and a saved JSON connection read as Claude's settings", () => {
  expect(readSettings("sk-test")).toEqual({ provider: "claude", connections: { claude: { apiKey: "sk-test" } } });
  const connection = { apiKey: "sk-test", baseUrl: "https://gateway.example.com", model: "claude-sonnet-5", effort: "high" };
  expect(readSettings(JSON.stringify(connection))).toEqual({ provider: "claude", connections: { claude: connection } });
});

test("settings with only Claude's connection save as that connection alone, as before", () => {
  expect(saveSettings({ provider: "claude", connections: { claude: { apiKey: "sk-test" } } })).toBe("sk-test");
  const connection = { apiKey: "sk-test", model: "claude-sonnet-5" };
  expect(saveSettings({ provider: "claude", connections: { claude: connection } })).toBe(saveConnection(connection));
});

test("each provider's settings are kept whichever provider is chosen", () => {
  const settings: Settings = {
    provider: "openai",
    connections: {
      claude: { apiKey: "sk-ant", model: "claude-sonnet-5", effort: "low" },
      openai: { apiKey: "sk-oai", customHeaders: "x-team: audio", model: "gpt-6-sol", effort: "none" },
      gemini: { apiKey: "gm", effort: "minimal", model: "gemini-3.6-flash" },
      local: { apiKey: "", baseUrl: "http://127.0.0.1:8080/v1", model: "qwen3:8b" },
    },
  };
  expect(readSettings(saveSettings(settings))).toEqual(settings);
  // Back to Claude: nothing of the others is lost.
  const back = { ...settings, provider: "claude" as const };
  expect(readSettings(saveSettings(back))).toEqual(back);
});

test("an effort a provider doesn't have is dropped when read", () => {
  const saved = JSON.stringify({
    provider: "gemini",
    connections: { gemini: { apiKey: "gm", effort: "max" }, local: { apiKey: "", effort: "high" }, nobody: { apiKey: "x" } },
  });
  expect(readSettings(saved)).toEqual({ provider: "gemini", connections: { gemini: { apiKey: "gm" }, local: { apiKey: "" } } });
});

test("Local's capabilities are saved with its settings and read back; another provider's are dropped", () => {
  const settings: Settings = {
    provider: "local",
    connections: { local: { apiKey: "", model: "gemma4:12b", capabilities: { imageInput: true, parallelToolCalls: true } } },
  };
  expect(readSettings(saveSettings(settings))).toEqual(settings);
  expect(capabilitiesFor("local", settings.connections.local!)).toEqual({
    toolUse: true,
    imageInput: true,
    audioInput: false,
    parallelToolCalls: true,
  });

  // Claude's are declared by the catalogue, not the musician; anything that isn't a yes or no is dropped too.
  const saved = JSON.stringify({
    provider: "claude",
    connections: {
      claude: { apiKey: "sk-ant", capabilities: { imageInput: false } },
      local: { apiKey: "", capabilities: { audioInput: "yes", toolUse: false } },
    },
  });
  expect(readSettings(saved).connections).toEqual({ claude: { apiKey: "sk-ant" }, local: { apiKey: "" } });
  expect(capabilitiesFor("claude", { apiKey: "sk-ant", capabilities: { imageInput: false } }).imageInput).toBe(true);
});

test("Local starts from what the catalogue declares for it: tools, and nothing it may be run without", () => {
  expect(capabilitiesFor("local", { apiKey: "", model: "qwen3:8b" })).toEqual({
    toolUse: true,
    imageInput: false,
    audioInput: false,
    parallelToolCalls: false,
  });
});

test("a saved model that can't use tools falls back to its provider's default", () => {
  addTextOnlyModel();
  const saved = JSON.stringify({
    provider: "local",
    connections: { local: { apiKey: "", model: TEXT_ONLY_MODEL.id }, claude: { apiKey: "sk-ant", model: "claude-sonnet-5" } },
  });
  expect(readSettings(saved).connections).toEqual({ local: { apiKey: "" }, claude: { apiKey: "sk-ant", model: "claude-sonnet-5" } });
  expect(assistantModel("local", TEXT_ONLY_MODEL.id)).toBe(defaultModel("local"));
  // A model the catalogue doesn't list is taken to be like the default, tools and all.
  expect(assistantModel("local", "my-own:7b")).toBe("my-own:7b");
});

test("a Local model starts with the smaller core and Suggestions, and any provider can have Suggestions", () => {
  expect(requestModeFor("local", { apiKey: "" })).toMatchObject({ smallCore: true, suggestion: true });
  expect(requestModeFor("local", { apiKey: "", smallCore: false, suggestion: false })).toMatchObject({ smallCore: false, suggestion: false });
  for (const provider of ["claude", "openai", "gemini"] as const) {
    expect(requestModeFor(provider, { apiKey: "key" })).toMatchObject({ smallCore: false, suggestion: false });
    // Only a provider with small models has the smaller core.
    expect(requestModeFor(provider, { apiKey: "key", smallCore: true, suggestion: true })).toMatchObject({ smallCore: false, suggestion: true });
  }
});

test("how Requests run is saved with each provider's settings and read back", () => {
  const settings: Settings = {
    provider: "local",
    connections: { local: { apiKey: "", smallCore: false, suggestion: false }, claude: { apiKey: "sk-test", suggestion: true } },
  };
  expect(readSettings(saveSettings(settings))).toEqual(settings);
  // Claude's alone is its connection, which keeps it too.
  const claudeOnly: Settings = { provider: "claude", connections: { claude: { apiKey: "sk-test", suggestion: true } } };
  expect(readSettings(saveSettings(claudeOnly))).toEqual(claudeOnly);
  // The smaller core is only a setting where the provider has one.
  expect(readSettings(JSON.stringify({ provider: "openai", connections: { openai: { apiKey: "k", smallCore: true } } }))).toEqual({
    provider: "openai",
    connections: { openai: { apiKey: "k" } },
  });
});

test("hearing audio is on by default wherever the model takes audio, unless the musician turns it off", () => {
  for (const provider of ["claude", "openai", "local", "meta"] as const) {
    expect(requestModeFor(provider, { apiKey: "key" }).hearsAudio).toBe(false);
  }
  expect(requestModeFor("gemini", { apiKey: "key" }).hearsAudio).toBe(true);
  expect(requestModeFor("gemini", { apiKey: "key", hearAudio: false }).hearsAudio).toBe(false);
  // Meta suggests Muse Spark 1.2 for audio, not 1.3.
  expect(requestModeFor("meta", { apiKey: "key", model: "muse-spark-1.2" }).hearsAudio).toBe(true);
  // Claude and OpenAI's models don't declare audio input, so the setting does nothing there.
  expect(requestModeFor("claude", { apiKey: "key", hearAudio: true }).hearsAudio).toBe(false);
  expect(requestModeFor("openai", { apiKey: "key", hearAudio: true }).hearsAudio).toBe(false);
  // Local hears once the musician says its model takes audio, and allows it.
  expect(requestModeFor("local", { apiKey: "", hearAudio: true }).hearsAudio).toBe(false);
  expect(requestModeFor("local", { apiKey: "", hearAudio: true, capabilities: { audioInput: true } }).hearsAudio).toBe(true);
});

test("hearing audio is saved with the provider's settings and read back", () => {
  const settings: Settings = {
    provider: "gemini",
    connections: { gemini: { apiKey: "k", hearAudio: true }, claude: { apiKey: "sk-test" } },
  };
  expect(readSettings(saveSettings(settings))).toEqual(settings);
  const claudeOnly: Settings = { provider: "claude", connections: { claude: { apiKey: "sk-test", hearAudio: false } } };
  expect(readSettings(saveSettings(claudeOnly))).toEqual(claudeOnly);
  expect(readConnection(saveConnection({ apiKey: "sk-test" })).hearAudio).toBeUndefined();
});

test("a connection's Context Window is its model's, or, for Local, what the musician set, or Ollama's default", () => {
  expect(contextWindowFor("claude", { apiKey: "key" })).toBe(1_000_000);
  expect(contextWindowFor("claude", { apiKey: "key", model: "claude-haiku-4-5" })).toBe(200_000);
  expect(contextWindowFor("openai", { apiKey: "key" })).toBe(1_050_000);
  expect(contextWindowFor("gemini", { apiKey: "key" })).toBe(1_048_576);
  expect(contextWindowFor("local", { apiKey: "" })).toBe(4_096);
  expect(contextWindowFor("local", { apiKey: "", contextWindow: 32_768 })).toBe(32_768);
  // Only a server that decides it is told one.
  expect(contextWindowFor("claude", { apiKey: "key", contextWindow: 32_768 })).toBe(1_000_000);
});

test("Local's Context Window is saved and read back, and one that isn't a whole number of tokens is dropped", () => {
  const saved = saveSettings({ provider: "local", connections: { local: { apiKey: "", contextWindow: 32_768 } } });
  expect(readSettings(saved).connections.local?.contextWindow).toBe(32_768);
  const bad = JSON.stringify({ provider: "local", connections: { local: { apiKey: "", contextWindow: -1 } } });
  expect(readSettings(bad).connections.local?.contextWindow).toBeUndefined();
  const notLocal = JSON.stringify({ provider: "claude", connections: { claude: { apiKey: "k", contextWindow: 5 } } });
  expect(readSettings(notLocal).connections.claude?.contextWindow).toBeUndefined();
});

test("Jev's connection is saved beside the providers' and read back, and doesn't make Claude's key a bare one", () => {
  const settings: Settings = {
    provider: "claude",
    connections: { claude: { apiKey: "sk-test" } },
    jev: { apiKey: "ts-key", baseUrl: " https://gateway.example.com ", model: "jev-1.13.0" },
  };
  const saved = saveSettings(settings);
  expect(saved.startsWith("{")).toBe(true);
  expect(readSettings(saved)).toEqual({ ...settings, jev: { apiKey: "ts-key", baseUrl: "https://gateway.example.com", model: "jev-1.13.0" } });
  // Without Jev, Claude's key alone is saved as it always was.
  expect(saveSettings({ provider: "claude", connections: { claude: { apiKey: "sk-test" } } })).toBe("sk-test");
  // Jev set up before any provider is still read, with no provider ready.
  const jevOnly = readSettings(saveSettings({ provider: "claude", connections: {}, jev: { apiKey: "ts-key" } }));
  expect(jevOnly).toEqual({ provider: "claude", connections: {}, jev: { apiKey: "ts-key" } });
  expect(readyProviders(jevOnly)).toEqual([]);
});

test("the ready providers are those with a connection saved, with a key where one is needed, in the catalogue's order", () => {
  expect(readyProviders(null)).toEqual([]);
  expect(
    readyProviders({
      provider: "meta",
      connections: { local: { apiKey: "" }, meta: { apiKey: "m" }, openai: { apiKey: " " }, claude: { apiKey: "sk" } },
    }),
  ).toEqual(["claude", "meta", "local"]);
});

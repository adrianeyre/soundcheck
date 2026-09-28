// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { afterEach, expect, test } from "vitest";

import { sampleProject } from "../project/fixtures";
import { ProjectHistory } from "../project/history";
import { createProject } from "../project/model";
import { serialiseProject } from "../project/serialise";
import { assistantStems } from "../stems/assistant-stems";
import { fakeStemSeparator } from "../stems/fake-stem-separator";
import type { ConversationSoFar, ModelReply, StartConversation } from "./assistant";
import type { Connection } from "./connection";
import { AssistantSettings } from "./AssistantSettings";
import { memoryKeyStore, type KeyStore } from "./key-store";
import { RequestBox, type RequestBoxProps } from "./RequestBox";
import { addTextOnlyModel, TEXT_ONLY_MODEL } from "./test-catalogue";

afterEach(() => {
  cleanup();
  clearMocks();
});

/** Claude, replaced by scripted replies in turn. No test calls the API. */
function scripted(replies: ModelReply[] | Error): () => StartConversation {
  return () => () => {
    let turn = 0;
    return {
      next: () => (replies instanceof Error ? Promise.reject(replies) : Promise.resolve(replies[turn++]!)),
    };
  };
}

/**
 * The Request box on the Editor page and the Assistant's settings on the
 * Settings page, sharing one key store as they do in the app.
 */
function Both(props: RequestBoxProps) {
  return (
    <>
      <AssistantSettings keyStore={props.keyStore} />
      <RequestBox {...props} />
    </>
  );
}

function show(
  keyStore: KeyStore,
  replies: ModelReply[] | Error,
  history = new ProjectHistory(createProject("Demo")),
) {
  render(<Both history={history} keyStore={keyStore} conversations={scripted(replies)} />);
  return history;
}

const NOTHING: ModelReply[] = [{ text: "There is nothing to do.", toolCalls: [] }];

test("the key is asked for once, and kept where the platform puts it", async () => {
  const keyStore = memoryKeyStore();
  show(keyStore, NOTHING);
  // Until there is a key, the Request box says where to enter one.
  expect(await screen.findByText(/The Assistant needs a model to talk to/)).toBeInTheDocument();

  fireEvent.change(await screen.findByLabelText("Claude API key"), { target: { value: "sk-test" } });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));

  expect(await screen.findByLabelText("Request")).toBeInTheDocument();
  expect(await keyStore.read()).toBe("sk-test");
  // The key is never shown again, only that one is saved.
  expect(screen.getByLabelText("Claude API key")).toHaveValue("");
  expect(screen.getByRole("status")).toHaveTextContent("Saved. The Assistant will use Claude.");

  // Next time the Assistant opens, the key is already there.
  cleanup();
  show(keyStore, NOTHING);
  expect(await screen.findByLabelText("Request")).toBeInTheDocument();
});

test("a Request shows what changed, and undo takes the whole Request back", async () => {
  const history = show(memoryKeyStore("sk-test"), [
    {
      text: "",
      toolCalls: [
        { id: "a", name: "create_track", input: { name: "Kick", kind: "instrument" } },
        { id: "b", name: "load_tools", input: { group: "time" } },
      ],
    },
    { text: "", toolCalls: [{ id: "c", name: "set_tempo", input: { tempo: 128 } }] },
    { text: "Added a Kick and set 128 BPM.", toolCalls: [] },
  ]);

  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: "add a kick at 128" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  expect(await screen.findByLabelText("What changed")).toHaveTextContent(
    "Added the Instrument Track “Kick”. Set the tempo to 128 BPM.",
  );
  expect(screen.getByLabelText("What the Assistant said")).toHaveTextContent("Added a Kick and set 128 BPM.");
  expect(history.project.tracks).toHaveLength(1);

  expect(history.undoLabel).toBe("Request");
  history.undo();
  expect(history.project.tracks).toEqual([]);
  expect(history.project.tempo).toBe(120);
});

test("a key Claude will not accept is reported as such", async () => {
  show(memoryKeyStore("sk-wrong"), new Error("Claude would not accept that API key. Check it and enter it again."));

  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: "add a kick" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Claude would not accept that API key");
});

test("the key can be forgotten, and then it is asked for again", async () => {
  const keyStore = memoryKeyStore("sk-test");
  show(keyStore, NOTHING);

  expect(await screen.findByLabelText("Request")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Forget all API keys" }));

  expect(await screen.findByText(/The Assistant needs a model to talk to/)).toBeInTheDocument();
  expect(screen.queryByLabelText("Request")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  expect(await keyStore.read()).toBeNull();
});

test("a Request whose Project was replaced says so instead of claiming changes it didn't make", async () => {
  const keyStore = memoryKeyStore("sk-test");
  const history = new ProjectHistory(createProject("Demo"));
  // The model is held up mid-Request, as a slow API call would be.
  let reply!: (value: ModelReply) => void;
  const held = new Promise<ModelReply>((resolve) => {
    reply = resolve;
  });
  let turn = 0;
  const conversations = () => () => ({
    next: () =>
      turn++ === 0 ? held : Promise.resolve<ModelReply>({ text: "Sped it up.", toolCalls: [] }),
  });
  const box = (its: ProjectHistory) => (
    <RequestBox history={its} keyStore={keyStore} conversations={conversations} />
  );
  const view = render(box(history));

  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: "speed it up" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  // Open hands the page a different Project while the Assistant is waiting.
  const opened = new ProjectHistory(createProject("Night drive"));
  view.rerender(box(opened));
  await act(async () => {
    reply({ text: "", toolCalls: [{ id: "a", name: "set_tempo", input: { tempo: 128 } }] });
  });

  expect(await screen.findByRole("alert")).toHaveTextContent(/Project was replaced/);
  expect(screen.queryByLabelText("What changed")).not.toBeInTheDocument();
  expect(opened.project.tempo).toBe(120);
});

/** The model, scripted one Request after another, keeping the Conversation each was started with. */
function conversing(...requests: ModelReply[][]) {
  const started: (ConversationSoFar | undefined)[] = [];
  let index = 0;
  const conversations = (): StartConversation => (_request, _project, _library, soFar) => {
    started.push(soFar);
    const replies = requests[index++]!;
    let turn = 0;
    return { next: () => Promise.resolve(replies[turn++]!) };
  };
  return { conversations, started };
}

async function ask(request: string, count: number) {
  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: request } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  // The Request has finished when it joins the transcript.
  await waitFor(() => expect(screen.getAllByLabelText("What you asked")).toHaveLength(count));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toHaveAttribute("aria-busy", "true"));
}

const ADD_KICK: ModelReply[] = [
  { text: "", toolCalls: [{ id: "a", name: "create_track", input: { name: "Kick", kind: "instrument" } }] },
  { text: "Added a Kick.", toolCalls: [] },
];

test("a follow-up is sent the Request before it, the transcript shows both, and New conversation clears it", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const { conversations, started } = conversing(ADD_KICK, [{ text: "It is loud enough.", toolCalls: [] }], [
    { text: "Hello.", toolCalls: [] },
  ]);
  render(<RequestBox history={history} keyStore={memoryKeyStore("sk-test")} conversations={conversations} />);
  expect(screen.queryByRole("button", { name: "New conversation" })).not.toBeInTheDocument();

  await ask("add a kick", 1);
  await ask("make it louder", 2);

  expect(started[0]?.earlier).toEqual([]);
  expect(started[1]?.earlier).toEqual([
    expect.objectContaining({ request: "add a kick", message: "Added a Kick.", changes: ["Added the Instrument Track “Kick”"] }),
  ]);
  const transcript = within(screen.getByRole("list", { name: "Conversation" }));
  const [first, second] = transcript.getAllByRole("listitem");
  expect(within(first!).getByLabelText("What you asked")).toHaveTextContent("add a kick");
  expect(within(first!).getByLabelText("What changed")).toHaveTextContent("Added the Instrument Track “Kick”.");
  expect(within(second!).getByLabelText("What the Assistant said")).toHaveTextContent("It is loud enough.");

  // Undoing the first Request shows in the transcript.
  expect(within(first!).getByLabelText("What you asked")).not.toHaveTextContent("undone");
  act(() => {
    history.undo();
  });
  expect(within(first!).getByLabelText("What you asked")).toHaveTextContent("add a kick (undone)");

  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  expect(screen.queryByRole("list", { name: "Conversation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New conversation" })).not.toBeInTheDocument();

  // The next Request starts a new Conversation: nothing before it.
  await ask("hello", 1);
  expect(started[2]?.earlier).toEqual([]);
  expect(started[2]?.loaded).toEqual([]);
});

test("opening or creating a Project starts a new Conversation", async () => {
  const keyStore = memoryKeyStore("sk-test");
  const { conversations, started } = conversing(ADD_KICK, [{ text: "Hello.", toolCalls: [] }]);
  const box = (its: ProjectHistory) => <RequestBox history={its} keyStore={keyStore} conversations={conversations} />;
  const view = render(box(new ProjectHistory(createProject("Demo"))));

  await ask("add a kick", 1);

  // New or Open hands the page a different history.
  view.rerender(box(new ProjectHistory(createProject("Night drive"))));
  expect(screen.queryByRole("list", { name: "Conversation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New conversation" })).not.toBeInTheDocument();

  await ask("hello", 1);
  expect(started[1]?.earlier).toEqual([]);
});

test("connection settings keep the key and add a model, effort, base URL and headers", async () => {
  const keyStore = memoryKeyStore("sk-test");
  const used: Connection[] = [];
  render(
    <Both
      history={new ProjectHistory(createProject("Demo"))}
      keyStore={keyStore}
      conversations={(connection) => {
        used.push(connection);
        return scripted(NOTHING)();
      }}
    />,
  );

  await screen.findByLabelText("Request");
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "Sonnet" } });
  fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "high" } });
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://gateway.example.com" } });
  fireEvent.change(screen.getByLabelText("Custom headers"), { target: { value: "x-team: audio" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Claude Sonnet 5, high effort")).toBeInTheDocument();
  const saved = {
    apiKey: "sk-test",
    baseUrl: "https://gateway.example.com",
    customHeaders: "x-team: audio",
    model: "claude-sonnet-5",
    effort: "high",
  };
  expect(JSON.parse((await keyStore.read())!)).toEqual(saved);

  fireEvent.change(screen.getByLabelText("Request"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByLabelText("What the Assistant said")).toBeInTheDocument();
  expect(used).toEqual([saved]);
});

test("a base URL that isn't one is refused and nothing is saved", async () => {
  const keyStore = memoryKeyStore("sk-test");
  show(keyStore, NOTHING);

  await screen.findByLabelText("Request");
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "gateway.example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("The base URL must start with https:// or http://.");
  expect(await keyStore.read()).toBe("sk-test");
  expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
});

test("Haiku has no effort setting, so none is saved for it", async () => {
  const keyStore = memoryKeyStore("sk-test");
  show(keyStore, NOTHING);

  await screen.findByLabelText("Request");
  fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "max" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "Haiku" } });
  expect(screen.getByLabelText("Effort")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Claude Haiku 4.5, default effort")).toBeInTheDocument();
  expect(JSON.parse((await keyStore.read())!)).toEqual({ apiKey: "sk-test", model: "claude-haiku-4-5" });
});

/** The options a picker offers, as it shows them. */
function options(label: string): string[] {
  return [...(screen.getByLabelText(label) as HTMLSelectElement).options].map((option) => option.text);
}

test("Model lists the provider's families, Version that family's, and Effort that model's levels", async () => {
  show(memoryKeyStore("sk-test"), NOTHING);
  await screen.findByLabelText("Request");

  expect(options("Model")).toEqual(["Opus", "Sonnet", "Haiku", "Fable"]);
  expect(options("Version")).toEqual(["5.5 (default)", "5", "4.8", "4.7", "4.6"]);
  expect(options("Effort")).toEqual(["the model's default", "low", "medium", "high", "xhigh", "max"]);

  // Opus 4.6 has no `xhigh`.
  fireEvent.change(screen.getByLabelText("Version"), { target: { value: "claude-opus-4-6" } });
  expect(options("Effort")).toEqual(["the model's default", "low", "medium", "high", "max"]);

  // Changing Model picks its default version.
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "Fable" } });
  expect(screen.getByLabelText("Version")).toHaveValue("claude-fable-5-1");
  expect(options("Version")).toEqual(["5.1 (default)", "5"]);

  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "gemini" } });
  expect(options("Model")).toEqual(["Flash", "Flash-Lite", "Pro"]);
  expect(screen.getByLabelText("Version")).toHaveValue("gemini-3.8-flash");
  expect(options("Effort")).toEqual(["the model's default", "low", "medium", "high"]);

  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openai" } });
  expect(options("Model")).toEqual(["GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna"]);
  expect(options("Effort")).toEqual(["the model's default", "low", "medium", "high", "xhigh", "max"]);

  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "local" } });
  expect(options("Model")).toEqual(["Llama", "Qwen", "Mistral", "Gemma"]);
  expect(screen.getByLabelText("Version")).toHaveValue("llama3.1:8b");
  expect(screen.getByLabelText("Effort")).toBeDisabled();
});

test("each provider keeps its own settings, so switching to another and back loses nothing", async () => {
  const keyStore = memoryKeyStore(JSON.stringify({ apiKey: "sk-ant", model: "claude-sonnet-5", effort: "low" }));
  const used: [Connection, string][] = [];
  const history = new ProjectHistory(createProject("Demo"));
  render(
    <Both
      history={history}
      keyStore={keyStore}
      conversations={(connection, provider) => {
        used.push([connection, provider]);
        return scripted(NOTHING)();
      }}
    />,
  );
  expect(await screen.findByText("Claude Sonnet 5, low effort")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "gemini" } });
  fireEvent.change(screen.getByLabelText("Google Gemini API key"), { target: { value: "gm-test" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "Pro" } });
  fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "high" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Google Gemini Pro 3.1 (preview), high effort")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Request"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByLabelText("What the Assistant said")).toBeInTheDocument();
  expect(used).toEqual([[{ apiKey: "gm-test", baseUrl: "", customHeaders: "", model: "gemini-3.1-pro-preview", effort: "high" }, "gemini"]]);

  // Back to Claude: its settings are as they were.
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "claude" } });
  expect(screen.getByLabelText("Model")).toHaveValue("Sonnet");
  expect(screen.getByLabelText("Effort")).toHaveValue("low");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Claude Sonnet 5, low effort")).toBeInTheDocument();

  expect(JSON.parse((await keyStore.read())!)).toEqual({
    provider: "claude",
    connections: {
      claude: { apiKey: "sk-ant", model: "claude-sonnet-5", effort: "low" },
      gemini: { apiKey: "gm-test", model: "gemini-3.1-pro-preview", effort: "high" },
    },
  });
  // The key store has them all; the Project none.
  expect(serialiseProject(history.project)).not.toMatch(/sk-ant|gm-test/);
});

test("Local needs no key", async () => {
  const keyStore = memoryKeyStore();
  show(keyStore, NOTHING);

  fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "local" } });
  expect(screen.getByLabelText("Base URL")).toHaveAttribute("placeholder", "http://localhost:11434/v1");
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "Qwen" } });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));

  expect(await screen.findByText("Local (Ollama / llama.cpp) Qwen qwen3:8b, default effort")).toBeInTheDocument();
  expect(JSON.parse((await keyStore.read())!)).toEqual({
    provider: "local",
    connections: { local: { apiKey: "", model: "qwen3:8b" } },
  });
});

/** Claude's JSON for a reply that only says something, as bytes. */
const SAID = new TextEncoder().encode(
  JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "Done." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
);

/** Saves a connection to a gateway and makes a Request over it with the given fetch. */
async function requestThrough(fetch: typeof globalThis.fetch) {
  const keyStore = memoryKeyStore(
    JSON.stringify({ apiKey: "sk-test", baseUrl: "https://gateway.example.com", customHeaders: "x-team: audio" }),
  );
  render(<RequestBox history={new ProjectHistory(createProject("Demo"))} keyStore={keyStore} fetch={fetch} />);
  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByLabelText("What the Assistant said")).toHaveTextContent("Done.");
}

test("the platform's fetch makes the Request, with the key and the gateway's headers", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  await requestThrough((input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return Promise.resolve(new Response(SAID, { headers: { "content-type": "application/json" } }));
  });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("https://gateway.example.com/v1/messages");
  expect(seen[0]?.headers.get("x-api-key")).toBe("sk-test");
  expect(seen[0]?.headers.get("x-team")).toBe("audio");
});

test("on the desktop every header reaches Rust through the HTTP plugin's fetch", async () => {
  // Tauri's IPC, faked: the plugin hands the request to Rust in `fetch`,
  // sends it in `fetch_send` and streams the body back a chunk at a time,
  // a last byte of 1 ending it.
  const sent: { url: string; headers: [string, string][] }[] = [];
  const chunks = [[...SAID, 0], [1]];
  mockIPC((cmd, payload) => {
    const args = payload as Record<string, unknown>;
    switch (cmd) {
      case "plugin:http|fetch":
        sent.push(args.clientConfig as (typeof sent)[number]);
        return 1;
      case "plugin:http|fetch_send":
        return { status: 200, statusText: "OK", url: sent[0]?.url, headers: [["content-type", "application/json"]], rid: 2 };
      case "plugin:http|fetch_read_body":
        return chunks.shift();
      default:
        return null;
    }
  });

  await requestThrough(tauriFetch);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.url).toBe("https://gateway.example.com/v1/messages");
  const headers = new Map(sent[0]?.headers);
  expect(headers.get("x-api-key")).toBe("sk-test");
  expect(headers.get("x-team")).toBe("audio");
  expect(headers.get("anthropic-version")).toBeDefined();
  const names = [...headers.keys()];
  expect(names.some((name) => name.startsWith("x-stainless-"))).toBe(true);
});

/** Each provider's JSON for a reply that only says "Done.", and where its request goes. */
const PROVIDER_REPLIES = [
  {
    provider: "openai",
    url: "https://gateway.example.com/v1/chat/completions",
    reply: { id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done." } }] },
  },
  {
    provider: "local",
    url: "https://gateway.example.com/v1/chat/completions",
    reply: { id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done." } }] },
  },
  {
    provider: "gemini",
    url: "https://gateway.example.com/v1beta/models/gemini-3.8-flash:generateContent",
    reply: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Done." }] } }] },
  },
] as const;

test.each(PROVIDER_REPLIES)("on the desktop $provider's requests go through the HTTP plugin's fetch", async ({ provider, url, reply }) => {
  const sent: { url: string; headers: [string, string][] }[] = [];
  const chunks = [[...new TextEncoder().encode(JSON.stringify(reply)), 0], [1]];
  mockIPC((cmd, payload) => {
    const args = payload as Record<string, unknown>;
    switch (cmd) {
      case "plugin:http|fetch":
        sent.push(args.clientConfig as (typeof sent)[number]);
        return 1;
      case "plugin:http|fetch_send":
        return { status: 200, statusText: "OK", url: sent[0]?.url, headers: [["content-type", "application/json"]], rid: 2 };
      case "plugin:http|fetch_read_body":
        return chunks.shift();
      default:
        return null;
    }
  });
  const baseUrl = provider === "gemini" ? "https://gateway.example.com" : "https://gateway.example.com/v1";
  const keyStore = memoryKeyStore(
    JSON.stringify({ provider, connections: { [provider]: { apiKey: "sk-test", baseUrl, customHeaders: "x-team: audio" } } }),
  );
  render(<RequestBox history={new ProjectHistory(createProject("Demo"))} keyStore={keyStore} fetch={tauriFetch} />);
  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByLabelText("What the Assistant said")).toHaveTextContent("Done.");

  expect(sent).toHaveLength(1);
  expect(sent[0]?.url.split("?")[0]).toBe(url);
  expect(new Map(sent[0]?.headers).get("x-team")).toBe("audio");
});

/** The settings' list of what the chosen model can do. */
function capabilitiesShown() {
  return within(screen.getByRole("group", { name: /^What .* can do$/ }));
}

test("the settings show what the chosen model can do", async () => {
  show(memoryKeyStore("sk-test"), NOTHING);
  await screen.findByLabelText("Request");

  expect(screen.getByRole("group", { name: "What Opus 5.5 can do" })).toBeInTheDocument();
  expect(capabilitiesShown().getAllByRole("listitem").map((item) => item.textContent?.trim())).toEqual([
    "Uses tools: yes",
    "Sees images, such as spectrograms: yes",
    "Hears audio: no",
    "Makes several tool calls a turn: yes",
  ]);

  // Yes and no are marked apart, for the stylesheet to colour them.
  const values = capabilitiesShown().getAllByRole("listitem").map((item) => item.querySelector(".capability-value"));
  expect(values.map((value) => value?.getAttribute("data-on"))).toEqual(["true", "true", "false", "true"]);

  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "gemini" } });
  const hears = capabilitiesShown().getAllByRole("listitem").find((item) => item.textContent?.startsWith("Hears audio"));
  expect(hears).toHaveTextContent("Hears audio: yes");
});

test("Local's capabilities start from the catalogue, can be changed, and are saved with Local's settings", async () => {
  const keyStore = memoryKeyStore();
  const used: Connection[] = [];
  render(
    <Both
      history={new ProjectHistory(createProject("Demo"))}
      keyStore={keyStore}
      conversations={(connection) => {
        used.push(connection);
        return scripted(NOTHING)();
      }}
    />,
  );

  fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "local" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "Gemma" } });
  const group = within(screen.getByRole("group", { name: "What Gemma gemma4:e4b can do" }));
  // Tool use isn't the musician's to turn off: without it there is no Assistant.
  expect(group.getAllByRole("listitem").map((item) => item.textContent?.trim())).toEqual(["Uses tools: yes"]);
  const images = group.getByLabelText("Sees images, such as spectrograms");
  expect(images).not.toBeChecked();
  expect(group.getByLabelText("Hears audio")).not.toBeChecked();
  expect(group.getByLabelText("Makes several tool calls a turn")).not.toBeChecked();

  fireEvent.click(images);
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await screen.findByText("Local (Ollama / llama.cpp) Gemma gemma4:e4b, default effort");
  expect(JSON.parse((await keyStore.read())!)).toEqual({
    provider: "local",
    connections: { local: { apiKey: "", model: "gemma4:e4b", capabilities: { imageInput: true } } },
  });
  expect(screen.getByLabelText("Sees images, such as spectrograms")).toBeChecked();

  fireEvent.change(screen.getByLabelText("Request"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByLabelText("What the Assistant said");
  expect(used.at(-1)?.capabilities).toEqual({ imageInput: true });

  // Another model starts from what it declares.
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "Qwen" } });
  expect(screen.getByLabelText("Sees images, such as spectrograms")).not.toBeChecked();
});

test("a model that can't use tools isn't offered, and one saved falls back to the default", async () => {
  addTextOnlyModel();
  const keyStore = memoryKeyStore(JSON.stringify({ provider: "local", connections: { local: { apiKey: "", model: TEXT_ONLY_MODEL.id } } }));
  show(keyStore, NOTHING);

  expect(await screen.findByText("Local (Ollama / llama.cpp) Llama llama3.1:8b, default effort")).toBeInTheDocument();
  expect(screen.getByLabelText("Version")).toHaveValue("llama3.1:8b");
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "Qwen" } });
  expect(options("Version")).not.toContain(TEXT_ONLY_MODEL.name);
});

/** A Local model's settings: Suggestions and the smaller core, as it has by default. */
const LOCAL = JSON.stringify({ provider: "local", connections: { local: { apiKey: "" } } });

test("a Suggestion changes nothing until it is applied, and then is one undo step", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const { conversations } = conversing(ADD_KICK, [{ text: "Hello.", toolCalls: [] }]);
  render(<RequestBox history={history} keyStore={memoryKeyStore(LOCAL)} conversations={conversations} />);

  await ask("add a kick", 1);
  expect(screen.getByLabelText("What you asked")).toHaveTextContent("add a kick (suggested)");
  expect(screen.getByLabelText("What changed")).toHaveTextContent("Added the Instrument Track “Kick”.");
  expect(history.project.tracks).toEqual([]);
  expect(history.canUndo).toBe(false);
  // Another Request waits until this one is applied or discarded.
  expect(screen.getByLabelText("Request")).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument());
  expect(history.project.tracks.map((track) => track.name)).toEqual(["Kick"]);
  expect(history.undoLabel).toBe("Request");
  expect(screen.getByLabelText("What you asked")).toHaveTextContent(/^add a kick$/);
  expect(screen.getByLabelText("Request")).toBeEnabled();

  act(() => {
    history.undo();
  });
  expect(history.project.tracks).toEqual([]);
  expect(screen.getByLabelText("What you asked")).toHaveTextContent("add a kick (undone)");
});

test("a discarded Suggestion leaves the Project as it was, and the next Request can start", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const { conversations, started } = conversing(ADD_KICK, [{ text: "Hello.", toolCalls: [] }]);
  render(<RequestBox history={history} keyStore={memoryKeyStore(LOCAL)} conversations={conversations} />);

  await ask("add a kick", 1);
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.getByLabelText("What you asked")).toHaveTextContent("add a kick (discarded)");
  expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  expect(history.project.tracks).toEqual([]);
  expect(history.canUndo).toBe(false);

  await ask("hello", 2);
  expect(started[1]?.earlier).toEqual([expect.objectContaining({ request: "add a kick", since: "discarded" })]);
});

test("Local starts with Suggestions and the smaller core, and turning them off is saved", async () => {
  const keyStore = memoryKeyStore();
  const modes: unknown[] = [];
  render(
    <Both
      history={new ProjectHistory(createProject("Demo"))}
      keyStore={keyStore}
      conversations={() => (request, project, library, soFar, mode) => {
        modes.push(mode);
        return scripted(NOTHING)()(request, project, library, soFar, mode);
      }}
    />,
  );

  fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "local" } });
  const suggest = screen.getByLabelText("Suggest changes for me to apply");
  const fewer = screen.getByLabelText("Start with fewer, simpler tools");
  expect(suggest).toBeChecked();
  expect(fewer).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await screen.findByLabelText("Request");
  // The defaults are what an unset setting means, so none is saved.
  expect(JSON.parse((await keyStore.read())!)).toEqual({ provider: "local", connections: { local: { apiKey: "" } } });

  fireEvent.change(screen.getByLabelText("Request"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByLabelText("What the Assistant said");
  expect(modes.at(-1)).toEqual({ smallCore: true, suggestion: true, hearsAudio: false, decides: false });

  fireEvent.click(screen.getByLabelText("Suggest changes for me to apply"));
  fireEvent.click(screen.getByLabelText("Start with fewer, simpler tools"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(async () =>
    expect(JSON.parse((await keyStore.read())!)).toEqual({
      provider: "local",
      connections: { local: { apiKey: "", smallCore: false, suggestion: false } },
    }),
  );

  // Claude has no smaller core, but can make Suggestions.
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "claude" } });
  expect(screen.queryByLabelText("Start with fewer, simpler tools")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Suggest changes for me to apply")).not.toBeChecked();
});

test("hearing audio is offered only for a model that takes it, is off by default, and turning it on is saved", async () => {
  const keyStore = memoryKeyStore(JSON.stringify({ provider: "gemini", connections: { gemini: { apiKey: "k" } } }));
  const modes: unknown[] = [];
  render(
    <Both
      history={new ProjectHistory(createProject("Demo"))}
      keyStore={keyStore}
      conversations={() => (request, project, library, soFar, mode) => {
        modes.push(mode);
        return scripted(NOTHING)()(request, project, library, soFar, mode);
      }}
    />,
  );

  const hear = await screen.findByLabelText("Let the Assistant hear the audio when it listens");
  expect(hear).not.toBeChecked();
  fireEvent.change(screen.getByLabelText("Request"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByLabelText("What the Assistant said");
  expect(modes.at(-1)).toMatchObject({ hearsAudio: false });

  fireEvent.click(hear);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(async () =>
    expect(JSON.parse((await keyStore.read())!)).toEqual({ provider: "gemini", connections: { gemini: { apiKey: "k", hearAudio: true } } }),
  );
  fireEvent.change(screen.getByLabelText("Request"), { target: { value: "how does it sound?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(modes.at(-1)).toMatchObject({ hearsAudio: true }));

  // Claude's models don't take audio, so it isn't offered there.
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "claude" } });
  expect(screen.queryByLabelText("Let the Assistant hear the audio when it listens")).not.toBeInTheDocument();
  // Local's is offered once the musician says its model hears audio.
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "local" } });
  expect(screen.queryByLabelText("Let the Assistant hear the audio when it listens")).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Hears audio"));
  expect(screen.getByLabelText("Let the Assistant hear the audio when it listens")).not.toBeChecked();
});

test("a Request waiting for a Stem Separation shows its progress and a Cancel, which leaves the Project as it was", async () => {
  const history = new ProjectHistory(sampleProject());
  // The separation holds at each step until the test lets it go on.
  const held: (() => void)[] = [];
  const release = async () => {
    await waitFor(() => expect(held).toHaveLength(1));
    await act(async () => held.shift()!());
  };
  const separator = fakeStemSeparator({ installed: true, between: () => new Promise((resolve) => held.push(resolve)) });
  const stems = assistantStems(
    separator,
    { samples: () => new Map(), add: () => undefined, remove: () => undefined },
    () => Promise.resolve(new Uint8Array([1])),
  );
  render(
    <RequestBox
      history={history}
      keyStore={memoryKeyStore("sk-test")}
      stems={stems}
      conversations={scripted([
        {
          text: "",
          toolCalls: [
            { id: "g", name: "load_tools", input: { group: "audio_clips" } },
            { id: "s", name: "separate_stems", input: { clipId: "vocals-1" } },
          ],
        },
        { text: "You cancelled the separation, so nothing changed.", toolCalls: [] },
      ])}
    />,
  );

  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: "separate take1" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  const panel = await screen.findByRole("group", { name: "Stem Separation" });
  expect(panel).toHaveTextContent("Separating take1 into Stems…");
  await release();
  await waitFor(() => expect(within(panel).getByLabelText("Stem Separation progress")).toHaveAttribute("value", "0.25"));
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel Stem Separation" }));
  await release();

  expect(await screen.findByLabelText("What the Assistant said")).toHaveTextContent("You cancelled the separation");
  expect(screen.queryByRole("group", { name: "Stem Separation" })).not.toBeInTheDocument();
  expect(history.project).toEqual(sampleProject());
});

test("New or Open cancels a Stem Separation the Request is waiting for", async () => {
  const keyStore = memoryKeyStore("sk-test");
  // The separation holds until it is cancelled.
  const separator = fakeStemSeparator({ installed: true, between: () => new Promise(() => undefined) });
  let signal: AbortSignal | undefined;
  const stems = assistantStems(
    { ...separator, separate: (audio, given) => ((signal = given.signal), separator.separate(audio, given)) },
    { samples: () => new Map(), add: () => undefined, remove: () => undefined },
    () => Promise.resolve(new Uint8Array([1])),
  );
  const conversations = scripted([
    { text: "", toolCalls: [{ id: "g", name: "load_tools", input: { group: "audio_clips" } }, { id: "s", name: "separate_stems", input: { clipId: "vocals-1" } }] },
    { text: "Cancelled.", toolCalls: [] },
  ]);
  const { rerender } = render(<RequestBox history={new ProjectHistory(sampleProject())} keyStore={keyStore} stems={stems} conversations={conversations} />);

  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: "separate take1" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("group", { name: "Stem Separation" });
  await waitFor(() => expect(signal).toBeDefined());
  rerender(<RequestBox history={new ProjectHistory(createProject("New"))} keyStore={keyStore} stems={stems} conversations={conversations} />);

  expect(signal?.aborted).toBe(true);
});

test("while a Request runs the box says what it is doing, and after it what the Request and the Conversation cost", async () => {
  let reply!: (value: ModelReply) => void;
  const replies: Promise<ModelReply>[] = [
    Promise.resolve({ text: "", toolCalls: [{ id: "a", name: "create_track", input: { name: "Kick", kind: "instrument" } }], usage: { input: 1000, output: 200 } }),
    new Promise((resolve) => (reply = resolve)),
  ];
  const second: ModelReply[] = [{ text: "It is loud enough.", toolCalls: [], usage: { input: 3000, output: 100 } }];
  let index = 0;
  const conversations = (): StartConversation => () => {
    const these = index++ === 0 ? replies : second.map((each) => Promise.resolve(each));
    let turn = 0;
    return { next: () => these[turn++]! };
  };
  render(<RequestBox history={new ProjectHistory(createProject("Demo"))} keyStore={memoryKeyStore("sk-test")} conversations={conversations} />);

  fireEvent.change(await screen.findByLabelText("Request"), { target: { value: "add a kick" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  // The first turn's tool is done; the second waits on the model, and says so.
  const status = await screen.findByLabelText("What the Assistant is doing");
  await waitFor(() => expect(status).toHaveTextContent("Turn 2: waiting for the model… (1,200 tokens so far)"));
  expect(screen.queryByLabelText("Token usage")).not.toBeInTheDocument();

  act(() => reply({ text: "Added a Kick.", toolCalls: [], usage: { input: 1500, output: 100 } }));
  await waitFor(() => expect(screen.getAllByLabelText("What you asked")).toHaveLength(1));
  expect(screen.queryByLabelText("What the Assistant is doing")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Token usage")).toHaveTextContent(
    "Last Request: 2,800 tokens (2,500 in, 300 out) · This Conversation: 2,800 tokens (2,500 in, 300 out)",
  );

  await ask("make it louder", 2);
  expect(screen.getByLabelText("Token usage")).toHaveTextContent(
    "Last Request: 3,100 tokens (3,000 in, 100 out) · This Conversation: 5,900 tokens (5,500 in, 400 out)",
  );

  // A new Conversation starts counting again.
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  expect(screen.queryByLabelText("Token usage")).not.toBeInTheDocument();
});

test("the box shows how full the model's context got, and Refresh context has the next Request sent none before it", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const { conversations, started } = conversing(
    [{ text: "", toolCalls: [{ id: "a", name: "create_track", input: { name: "Kick", kind: "instrument" } }], usage: { input: 40_000, output: 1_000 } }, { text: "Added a Kick.", toolCalls: [], usage: { input: 120_000, output: 5_000 } }],
    [{ text: "It is loud enough.", toolCalls: [], usage: { input: 9_000, output: 1_000 } }],
    [{ text: "Hello.", toolCalls: [], usage: { input: 8_000, output: 500 } }],
  );
  render(<RequestBox history={history} keyStore={memoryKeyStore("sk-test")} conversations={conversations} />);
  expect(screen.queryByLabelText("Context used")).not.toBeInTheDocument();

  await ask("add a kick", 1);
  // The last turn held 125,000 of Claude Opus 5.5's 1M tokens.
  expect(screen.getByLabelText("Context used")).toHaveTextContent("Context: 13% used (125,000 of 1,000,000 tokens)");

  await ask("make it louder", 2);
  expect(started[1]?.earlier).toHaveLength(1);
  expect(screen.getByLabelText("Context used")).toHaveTextContent("Context: 1% used (10,000 of 1,000,000 tokens)");

  fireEvent.click(screen.getByRole("button", { name: "Refresh context" }));
  expect(screen.getByLabelText("Context used")).toHaveTextContent("Context refreshed");
  // Nothing more to refresh until another Request runs.
  expect(screen.getByRole("button", { name: "Refresh context" })).toBeDisabled();

  await ask("hello", 3);
  // The Requests before the refresh stay in the transcript, and the Conversation's cost, but aren't sent.
  expect(started[2]?.earlier).toEqual([]);
  expect(started[2]?.loaded).toEqual([]);
  expect(screen.getAllByLabelText("What you asked")).toHaveLength(3);
  expect(screen.getByRole("separator")).toHaveTextContent("Context refreshed");
  expect(screen.getByLabelText("Token usage")).toHaveTextContent("This Conversation: 184,500 tokens");
  expect(screen.getByRole("button", { name: "Refresh context" })).toBeEnabled();
});

test("a local server's Context Window is set in Settings, and the box measures against it", async () => {
  const keyStore = memoryKeyStore(JSON.stringify({ provider: "local", connections: { local: { apiKey: "", contextWindow: 32_768, suggestion: false } } }));
  const { conversations } = conversing([{ text: "Hi.", toolCalls: [], usage: { input: 16_000, output: 384 } }]);
  render(<RequestBox history={new ProjectHistory(createProject("Demo"))} keyStore={keyStore} conversations={conversations} />);

  await ask("hi", 1);
  expect(screen.getByLabelText("Context used")).toHaveTextContent("Context: 50% used (16,384 of 32,768 tokens)");
});

test("Settings keeps a local server's Context Window", async () => {
  const keyStore = memoryKeyStore();
  render(<AssistantSettings keyStore={keyStore} />);
  fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "local" } });
  fireEvent.change(screen.getByLabelText("Context window (tokens)"), { target: { value: "65536" } });
  fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
  await waitFor(async () => expect(JSON.parse((await keyStore.read())!).connections.local.contextWindow).toBe(65_536));
});

test("with several providers set up, the Request box switches between them, and the next Request goes to the one picked", async () => {
  const keyStore = memoryKeyStore(
    JSON.stringify({ provider: "claude", connections: { claude: { apiKey: "sk" }, meta: { apiKey: "meta" }, openai: { apiKey: "" } } }),
  );
  const asked: string[] = [];
  const conversations = (_connection: Connection, provider: string): StartConversation => {
    asked.push(provider);
    return () => ({ next: () => Promise.resolve({ text: `Answered by ${provider}.`, toolCalls: [] }) });
  };
  render(<RequestBox history={new ProjectHistory(createProject("Demo"))} keyStore={keyStore} conversations={conversations} />);

  const picker = await screen.findByRole("combobox", { name: "Assistant provider" });
  // OpenAI has no key, so it isn't ready to pick.
  expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual([
    "Claude Opus 5.5, default effort",
    "Meta AI Muse Spark 1.3, default effort",
  ]);
  fireEvent.change(picker, { target: { value: "meta" } });
  await waitFor(async () => expect(JSON.parse((await keyStore.read())!).provider).toBe("meta"));

  fireEvent.change(screen.getByLabelText("Request"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByLabelText("What the Assistant said")).toHaveTextContent("Answered by meta.");
  expect(asked).toEqual(["meta"]);
  // The other connections are kept, to switch back to.
  expect(JSON.parse((await keyStore.read())!).connections).toMatchObject({ claude: { apiKey: "sk" }, meta: { apiKey: "meta" } });
});

test("with one provider set up there is nothing to pick: the box says which it uses", async () => {
  render(<RequestBox history={new ProjectHistory(createProject("Demo"))} keyStore={memoryKeyStore("sk-test")} conversations={scripted(NOTHING)} />);
  expect(await screen.findByText("Claude Opus 5.5, default effort")).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Assistant provider" })).not.toBeInTheDocument();
});

test("Jev is set up in Settings beside the providers, and then the Assistant can ask it", async () => {
  const keyStore = memoryKeyStore("sk-test");
  const jevs: unknown[] = [];
  const modes: unknown[] = [];
  const conversations = (): StartConversation => (_request, _project, _library, _soFar, mode) => {
    modes.push(mode);
    return { next: () => Promise.resolve({ text: "Done.", toolCalls: [] }) };
  };
  render(
    <Both
      history={new ProjectHistory(createProject("Demo"))}
      keyStore={keyStore}
      conversations={conversations}
      decisions={(jev) => {
        jevs.push(jev);
        return () => Promise.reject(new Error("unused"));
      }}
    />,
  );

  fireEvent.change(await screen.findByLabelText("TypeSafe API key"), { target: { value: "ts-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Set up Jev" }));
  expect(await screen.findByText("with Jev deciding")).toBeInTheDocument();
  expect(JSON.parse((await keyStore.read())!)).toEqual({ provider: "claude", connections: { claude: { apiKey: "sk-test" } }, jev: { apiKey: "ts-key" } });

  fireEvent.change(screen.getByLabelText("Request"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByLabelText("What the Assistant said");
  expect(jevs).toEqual([{ apiKey: "ts-key" }]);
  expect(modes.at(-1)).toMatchObject({ decides: true });

  // Forgetting Jev keeps the provider's key.
  fireEvent.click(screen.getByRole("button", { name: "Forget Jev's key" }));
  await waitFor(() => expect(screen.queryByText("with Jev deciding")).not.toBeInTheDocument());
  expect(await keyStore.read()).toBe("sk-test");
});

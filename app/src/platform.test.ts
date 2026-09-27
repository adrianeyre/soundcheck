// @vitest-environment jsdom
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { afterEach, expect, test, vi } from "vitest";

import { currentPlatform, isDesktop, isMacOs, NO_STEMS_IN_BROWSER, NO_VST3_ON_MACOS } from "./platform";

// The global Tauri defines, named by Tauri rather than by us.
const TAURI = "__TAURI_INTERNALS__";
const globals = window as unknown as Record<string, unknown>;

afterEach(() => {
  delete globals[TAURI];
});

test("in a browser the AudioWorklet and Web MIDI are used, with latency hints", async () => {
  expect(isDesktop()).toBe(false);
  const platform = currentPlatform();
  expect(platform.name).toBe("browser");
  expect(platform.bufferSizes).toBeNull();
  // Recording audio is the desktop app's.
  expect(platform.audioInputs).toBeNull();
  // jsdom has no File System Access API, so no Project folders here.
  expect(platform.storage).toBeNull();
  // The sample browser reads folders through a folder input, there being no directory picker here.
  expect(platform.samples).not.toBeNull();
  expect(await platform.keyStore.read()).toBeNull();
  // The Assistant's requests are the browser's, so CORS applies.
  expect(platform.fetch).toBe(globalThis.fetch);
  // jsdom has no Web Workers to separate Stems in, and says so.
  expect(await platform.stems.status()).toEqual({ kind: "unavailable", reason: NO_STEMS_IN_BROWSER });
  // Each visit loads the latest deploy, so there is nothing to update.
  expect(platform.updater).toBeNull();
  // A web page can't run a native Plugin.
  expect(platform.vst3).toBeNull();
});

test("a browser with Web Workers separates Stems, saying why where it can't", async () => {
  globals.Worker = Object;
  try {
    const status = await currentPlatform().stems.status();
    // jsdom has neither the Origin Private File System nor IndexedDB.
    expect(status).toEqual({ kind: "unavailable", reason: expect.stringMatching(/no storage/) });
  } finally {
    delete globals.Worker;
  }
});

test("in the Tauri window the native host is used, with buffer sizes to choose", () => {
  globals[TAURI] = {};
  expect(isDesktop()).toBe(true);
  const platform = currentPlatform();
  expect(platform.name).toBe("desktop");
  expect(platform.bufferSizes).toContain(256);
  expect(platform.listAudioHosts).not.toBeNull();
  expect(platform.audioInputs).not.toBeNull();
  expect(platform.storage).not.toBeNull();
  expect(platform.samples).not.toBeNull();
  // The API key goes to the OS credential store, through the Tauri shell.
  expect(platform.keyStore).toBeDefined();
  // The Assistant's requests go through Rust, where CORS doesn't apply.
  expect(platform.fetch).toBe(tauriFetch);
  expect(platform.stems).toBeDefined();
  // The installed app updates itself through the shell.
  expect(platform.updater).not.toBeNull();
  // VST3 Plugins run in helper processes the shell starts.
  expect(platform.vst3).not.toBeNull();
  expect(platform.vst3Unavailable).toBeNull();
});

test("the webview says which OS it is on, and only macOS's WKWebView is macOS", () => {
  expect(isMacOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(true);
  expect(
    isMacOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"),
  ).toBe(false);
  expect(isMacOs("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(false);
});

test("on macOS the Desktop App offers no VST3 Plugins, and says why", () => {
  globals[TAURI] = {};
  const agent = vi
    .spyOn(navigator, "userAgent", "get")
    .mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)");
  try {
    const platform = currentPlatform();
    expect(platform.name).toBe("desktop");
    expect(platform.vst3).toBeNull();
    expect(platform.vst3Unavailable).toBe("VST3 Plugins aren't supported on macOS yet");
    expect(platform.vst3Unavailable).toBe(NO_VST3_ON_MACOS);
    // Everything else is the Desktop App's, as on Windows.
    expect(platform.audioInputs).not.toBeNull();
    expect(platform.updater).not.toBeNull();
  } finally {
    agent.mockRestore();
  }
});

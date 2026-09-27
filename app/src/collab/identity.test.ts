import { expect, test } from "vitest";

import type { LocalStore } from "../settings/local-settings";
import { liveCopyFor, relayFor, rememberLiveCopy, setTypedRelay } from "./identity";

function store(): LocalStore {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

test("a Live Session goes through the Relay Settings name, or else the one Soundcheck was built with, or none", () => {
  const here = store();
  expect(relayFor(here, "")).toBeNull();
  expect(relayFor(here, "https://relay.soundcheck.example")).toBe("wss://relay.soundcheck.example");
  setTypedRelay(" ws://192.168.1.20:8080 ", here);
  expect(relayFor(here, "https://relay.soundcheck.example")).toBe("ws://192.168.1.20:8080");
  setTypedRelay("", here);
  expect(relayFor(here, "wss://relay.soundcheck.example")).toBe("wss://relay.soundcheck.example");
});

test("this machine's copy in a Live Session is remembered, so rejoining it goes on as the same copy", () => {
  const here = store();
  expect(liveCopyFor("session-one", here)).toBeUndefined();
  rememberLiveCopy("session-one", "copy-a", here);
  expect(liveCopyFor("session-one", here)).toBe("copy-a");
  expect(liveCopyFor("session-two", here)).toBeUndefined();
});

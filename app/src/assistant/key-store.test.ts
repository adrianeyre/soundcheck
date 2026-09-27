// @vitest-environment jsdom
import { expect, test, vi } from "vitest";

import { desktopKeyStore, BROWSER_KEY, browserKeyStore, memoryKeyStore } from "./key-store";

test("the desktop keeps the key in the OS credential store, through the shell", async () => {
  const invoke = vi.fn<(command: string) => Promise<unknown>>((command) =>
    Promise.resolve(command === "api_key_read" ? "sk-saved" : undefined),
  );
  const store = desktopKeyStore(invoke as never);

  expect(await store.read()).toBe("sk-saved");
  await store.write("sk-new");
  expect(invoke).toHaveBeenCalledWith("api_key_write", { key: "sk-new" });
  await store.clear();
  expect(invoke).toHaveBeenCalledWith("api_key_clear");
});

test("a key that was never saved reads as none", async () => {
  const store = desktopKeyStore(vi.fn<() => Promise<null>>(() => Promise.resolve(null)) as never);
  expect(await store.read()).toBeNull();
  expect(await browserKeyStore(localStorage).read()).toBeNull();
  expect(await memoryKeyStore().read()).toBeNull();
});

test("the browser dev host remembers the key between runs", async () => {
  const store = browserKeyStore(localStorage);
  await store.write("sk-browser");
  expect(localStorage.getItem(BROWSER_KEY)).toBe("sk-browser");
  expect(await browserKeyStore(localStorage).read()).toBe("sk-browser");
  await store.clear();
  expect(await store.read()).toBeNull();
});

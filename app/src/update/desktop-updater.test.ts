import { afterEach, expect, test, vi } from "vitest";

import type { Invoke } from "../audio/desktop-audio-output";
import { desktopUpdater, PROGRESS_MS } from "./desktop-updater";

afterEach(() => {
  vi.useRealTimers();
});

/** The Tauri side, answering as `desktop/src/update.rs` does. */
function fakeInvoke({ found = { version: "1.2.3", date: null, notes: "What's new" } as unknown } = {}) {
  const calls: string[] = [];
  let fail: ((reason: string) => void) | null = null;
  let progress = 0;
  const invoke = ((command: string) => {
    calls.push(command);
    switch (command) {
      case "update_status":
        return Promise.resolve({ version: "0.1.0", off: null });
      case "update_check":
        return found instanceof Error ? Promise.reject(found.message) : Promise.resolve(found);
      case "update_progress":
        return Promise.resolve((progress += 0.25));
      case "update_install":
        return new Promise((_, reject) => (fail = reject));
      default:
        return Promise.reject(new Error(command));
    }
  }) as Invoke;
  return { invoke, calls, fail: (reason: string) => fail?.(reason) };
}

test("the status and a check are the shell's answers", async () => {
  const updater = desktopUpdater(fakeInvoke().invoke);
  expect(await updater.status()).toEqual({ version: "0.1.0", off: null });
  expect(await updater.check()).toEqual({ version: "1.2.3", date: null, notes: "What's new" });
  expect(await desktopUpdater(fakeInvoke({ found: null }).invoke).check()).toBeNull();
});

test("a check that fails rejects with the shell's reason as an Error", async () => {
  const updater = desktopUpdater(fakeInvoke({ found: new Error("Couldn't check for an update: offline") }).invoke);
  await expect(updater.check()).rejects.toThrow("Couldn't check for an update: offline");
});

test("installing polls the download's progress until the install ends", async () => {
  vi.useFakeTimers();
  const fake = fakeInvoke();
  const progress: number[] = [];
  const installing = desktopUpdater(fake.invoke).install((fraction) => progress.push(fraction));
  const failed = installing.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(PROGRESS_MS * 2);
  expect(progress).toEqual([0.25, 0.5]);

  fake.fail("Couldn't install the update: bad signature");
  expect(await failed).toEqual(new Error("Couldn't install the update: bad signature"));
  await vi.advanceTimersByTimeAsync(PROGRESS_MS * 2);
  expect(progress).toHaveLength(2);
});

import type { FoundUpdate, Updater, UpdateStatus } from "./updater";

export const NEWER: FoundUpdate = { version: "1.2.3", date: "2026-09-26T12:00:00Z", notes: "Faster exports." };

/** An updater for tests: its answers are given, and it records what was asked. */
export function fakeUpdater({
  status = { version: "0.1.0", off: null } as UpdateStatus,
  found = NEWER as FoundUpdate | null | Error,
} = {}) {
  const calls: string[] = [];
  let finish: { progress: (fraction: number) => void; fail: (error: Error) => void } | null = null;
  const updater: Updater = {
    status: async () => (calls.push("status"), status),
    check: async () => {
      calls.push("check");
      if (found instanceof Error) throw found;
      return found;
    },
    install: (onProgress) => {
      calls.push("install");
      // As the shell does, it only settles if it fails: success restarts the app.
      return new Promise((_, reject) => (finish = { progress: onProgress, fail: reject }));
    },
  };
  return {
    updater,
    calls,
    progress: (fraction: number) => finish?.progress(fraction),
    fail: (error: string) => finish?.fail(new Error(error)),
  };
}

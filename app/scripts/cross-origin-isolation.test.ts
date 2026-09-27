import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { CONFIG_SCRIPT, isolationTags, SERVICE_WORKER_FILE } from "./cross-origin-isolation";

/** What `window.coi.shouldRegister()` says in a window with `globals`. */
function shouldRegister(globals: Record<string, unknown>): boolean {
  const window: Record<string, unknown> = { ...globals };
  runInNewContext(CONFIG_SCRIPT, { window });
  return (window.coi as { shouldRegister: () => boolean }).shouldRegister();
}

describe("cross-origin isolation", () => {
  it("configures coi-serviceworker, then loads it, first in the head", () => {
    const tags = isolationTags();
    expect(tags.map((tag) => tag.injectTo)).toEqual(["head-prepend", "head-prepend"]);
    expect(tags[0]).toMatchObject({ tag: "script", children: CONFIG_SCRIPT });
    // Relative, so it works under Pages' sub-path, and a classic script, so it can find its own URL.
    expect(tags[1]).toEqual({ tag: "script", attrs: { src: SERVICE_WORKER_FILE }, injectTo: "head-prepend" });
  });

  it("registers the service worker in a browser", () => {
    expect(shouldRegister({})).toBe(true);
  });

  it("never registers it in the Desktop App's window", () => {
    expect(shouldRegister({ __TAURI_INTERNALS__: {} })).toBe(false);
  });
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { NewDeployNotice } from "./NewDeployNotice";
import { deployedStamp, isMissingAsset, reportIfMissingAsset, useNewDeploy } from "./new-deploy";

afterEach(cleanup);

/** The site's `version.json`, as a deploy wrote it; null for none (`pnpm dev`). */
function site(stamp: { build: string; version: string } | null) {
  return vi.fn<typeof fetch>(async () => (stamp ? new Response(JSON.stringify(stamp)) : new Response("Not found", { status: 404 })));
}

test("a file the site no longer has is told from other failures", () => {
  expect(isMissingAsset(new TypeError("Failed to fetch dynamically imported module: https://x/assets/a-12345678.js"))).toBe(true);
  expect(isMissingAsset(new TypeError("error loading dynamically imported module"))).toBe(true);
  expect(isMissingAsset(new TypeError("Importing a module script failed."))).toBe(true);
  expect(isMissingAsset(new Error("WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 64 6f @+0"))).toBe(true);
  expect(isMissingAsset(new Error("The Audio Engine (./assets/soundcheck_engine_bg-D7kKR3v_.wasm) couldn't be loaded: 404"))).toBe(true);
  expect(isMissingAsset(new Error("The audio device was unplugged"))).toBe(false);
  expect(isMissingAsset("Claude would not accept that API key.")).toBe(false);
});

const offline: typeof fetch = async () => Promise.reject(new TypeError("offline"));

test("the site's stamp is read past the cache, and none is no stamp", async () => {
  const served = site({ build: "abc", version: "1.8.0" });
  expect(await deployedStamp(served)).toEqual({ build: "abc", version: "1.8.0" });
  expect(served.mock.calls[0]![1]).toEqual({ cache: "no-store" });
  expect(await deployedStamp(site(null))).toBeNull();
  expect(await deployedStamp(offline)).toBeNull();
});

test("a page left open across a deploy says a newer version is out, and reloads to it", async () => {
  const reload = vi.fn<() => void>();
  const { result } = renderHook(() => useNewDeploy({ build: "old", enabled: true, fetch: site({ build: "new", version: "1.8.0" }), reload }));
  await waitFor(() => expect(result.current.newer).toEqual({ build: "new", version: "1.8.0" }));
  render(<NewDeployNotice deploy={result.current} />);
  expect(screen.getByRole("region", { name: "New version" })).toHaveTextContent("Soundcheck 1.8.0 is out. Reload to use it.");
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(reload).toHaveBeenCalled();
});

test("the same build, no stamp, or the Desktop App says nothing", async () => {
  const same = site({ build: "same", version: "1.7.0" });
  const { result } = renderHook(() => useNewDeploy({ build: "same", enabled: true, fetch: same }));
  await waitFor(() => expect(same).toHaveBeenCalled());
  expect(result.current.newer).toBeNull();
  const desktop = site({ build: "new", version: "1.8.0" });
  renderHook(() => useNewDeploy({ build: "old", enabled: false, fetch: desktop }));
  renderHook(() => useNewDeploy({ build: undefined, enabled: true, fetch: desktop }));
  expect(desktop).not.toHaveBeenCalled();
});

test("a file that failed to load says why a reload is needed, whether it was thrown or caught and reported", async () => {
  const { result } = renderHook(() => useNewDeploy({ build: "old", enabled: true, fetch: site({ build: "new", version: "1.8.0" }) }));
  act(() => {
    expect(reportIfMissingAsset(new Error("WebAssembly.instantiate(): expected magic word 00 61 73 6d"))).toBe(true);
  });
  await waitFor(() => expect(result.current.broken).toBe(true));
  render(<NewDeployNotice deploy={result.current} />);
  expect(screen.getByRole("region", { name: "New version" })).toHaveTextContent("part of the old version is no longer on the site");
  act(() => result.current.dismiss());
  expect(result.current.broken).toBe(false);
  expect(result.current.newer).toBeNull();

  const thrown = renderHook(() => useNewDeploy({ build: "old", enabled: true, fetch: site(null) }));
  act(() => {
    window.dispatchEvent(new Event("vite:preloadError"));
  });
  await waitFor(() => expect(thrown.result.current.broken).toBe(true));
  expect(reportIfMissingAsset(new Error("Something else"))).toBe(false);
});

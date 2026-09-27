import { readFileSync } from "node:fs";

import { initSync, plugin_manifest } from "@engine";
import { beforeAll, describe, expect, test } from "vitest";

import type { Invoke } from "../audio/desktop-audio-output";
import { memoryLibraryStorage } from "../preset/library-storage";
import { desktopPluginFolder, libraryPluginFolder } from "./plugin-folder";
import { testPluginWasm } from "./test-plugin";

let wasm: Uint8Array;

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
  wasm = testPluginWasm();
}, 300_000);

describe("the Plugins folder", () => {
  test("on the browser dev host, a Plugin installed into the library is listed with its .wasm", async () => {
    const library = memoryLibraryStorage();
    const folder = libraryPluginFolder(library, async (json) => plugin_manifest(json));
    expect(await folder.list()).toEqual([]);

    const installed = await folder.install(wasm);
    expect(installed.manifest).toMatchObject({ id: "dev.soundcheck.test.effect", name: "Test Effect", kind: "effect" });
    // Installed again, it replaces itself rather than listing twice.
    await folder.install(wasm);
    const listed = await libraryPluginFolder(library, async (json) => plugin_manifest(json)).list();
    expect(listed.map((plugin) => plugin.manifest)).toEqual([installed.manifest]);
    expect([...listed[0]!.wasm]).toEqual([...wasm]);

    await expect(folder.install(new Uint8Array([1, 2, 3]))).rejects.toThrow("This isn't a WebAssembly module");
  });

  test("on desktop, the shell installs, lists and reads each Plugin", async () => {
    const manifest = plugin_manifest(
      JSON.stringify({ id: "dev.example.drive", version: "1.0.0", kind: "effect", name: "Drive", settings: [] }),
    );
    const calls: [string, unknown][] = [];
    const invoke = (async (command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      if (command === "plugins_install") return { manifest };
      if (command === "plugins_list") return [{ manifest }];
      if (command === "plugins_read") return new Uint8Array([9, 8, 7]).buffer;
      throw new Error(`no command ${command}`);
    }) as Invoke;
    const folder = desktopPluginFolder(invoke);

    const installed = await folder.install(new Uint8Array([1, 2]));
    expect(installed.manifest.id).toBe("dev.example.drive");
    // A list of numbers over IPC: a Uint8Array would arrive as an object.
    expect(calls[0]).toEqual(["plugins_install", { wasm: [1, 2] }]);
    const listed = await folder.list();
    expect(listed.map((plugin) => [plugin.manifest.name, [...plugin.wasm]])).toEqual([["Drive", [9, 8, 7]]]);
    expect(calls.at(-1)).toEqual(["plugins_read", { id: "dev.example.drive" }]);
  });
});

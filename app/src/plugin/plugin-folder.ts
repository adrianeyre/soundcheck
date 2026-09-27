/**
 * The app-level Plugins folder, outside any Project, behind a platform
 * interface as the library is: WASM Plugins are installed into it once and
 * every Project can use them.
 *
 * On desktop it is a folder in the app-data folder, and the Tauri shell
 * compiles a Plugin in wasmtime before installing it (`desktop/src/plugin.rs`).
 * On the browser dev host it lives in the library's IndexedDB, and a Plugin
 * is checked with the host's own `WebAssembly` and the engine's manifest
 * check.
 */
import type { Invoke } from "../audio/desktop-audio-output";
import type { LibraryStorage } from "../preset/library-storage";
import { readPluginManifest, type InstalledPlugin } from "./plugins";
import { loadPlugin } from "./wasm-plugin-runtime";

export interface PluginFolder {
  /** Every installed Plugin, with its `.wasm`. */
  list(): Promise<InstalledPlugin[]>;
  /**
   * Install a Plugin's `.wasm`, replacing any version of it already there.
   * Rejects, saying why, when it isn't a Plugin this app can host.
   */
  install(wasm: Uint8Array): Promise<InstalledPlugin>;
}

/** `Installed` in `desktop/src/plugin.rs`. */
interface Installed {
  manifest: string;
}

export function desktopPluginFolder(invoke: Invoke): PluginFolder {
  // Raw bytes, not a JSON list of numbers: `plugins_read` answers with a
  // binary response.
  const read = async (id: string) => new Uint8Array(await invoke<ArrayBuffer>("plugins_read", { id }));
  return {
    async list() {
      const installed = await invoke<Installed[]>("plugins_list");
      return Promise.all(
        installed.map(async ({ manifest: json }) => {
          const manifest = readPluginManifest(json);
          return { manifest, wasm: await read(manifest.id) };
        }),
      );
    },
    async install(wasm) {
      const { manifest } = await invoke<Installed>("plugins_install", { wasm: [...wasm] });
      return { manifest: readPluginManifest(manifest), wasm: wasm.slice() };
    },
  };
}

/** Checks a manifest's JSON, answering it in the engine's one form: `plugin_manifest` from the WASM build. */
export type CheckManifest = (json: string) => Promise<string>;

const FOLDER = "plugins";

/**
 * The Plugins folder as part of a library: `plugins/<id>.wasm`, with the
 * checked manifest beside it as `plugins/<id>.json`.
 */
export function libraryPluginFolder(library: LibraryStorage, checkManifest: CheckManifest): PluginFolder {
  return {
    async list() {
      const paths = await library.listFiles(FOLDER);
      const plugins: InstalledPlugin[] = [];
      for (const path of paths.filter((file) => file.endsWith(".json"))) {
        try {
          const manifest = readPluginManifest(await library.readText(path));
          plugins.push({ manifest, wasm: await library.readBytes(`${FOLDER}/${manifest.id}.wasm`) });
        } catch {
          // One that can't be read is left out rather than failing the list.
        }
      }
      return plugins;
    },
    async install(wasm) {
      const { manifestJson } = loadPlugin(wasm);
      const checked = await checkManifest(manifestJson);
      const manifest = readPluginManifest(checked);
      await library.writeBytes(`${FOLDER}/${manifest.id}.wasm`, wasm);
      await library.writeText(`${FOLDER}/${manifest.id}.json`, checked);
      return { manifest, wasm: wasm.slice() };
    },
  };
}

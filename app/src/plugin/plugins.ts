/**
 * The WASM Plugins installed on this machine (ADR 0003), as the rest of the
 * UI finds them: by id, synchronously, so drawing an Effect's controls,
 * listing its Automation lanes, checking the Assistant's settings and
 * sending the engine its commands all see the same manifest.
 *
 * The Plugins folder (`plugin-folder.ts`) is where they are kept; the app
 * reads it at startup and after an install, and puts what it found here.
 */
import type { EffectParam } from "../effect/effect-params";
import { isVst3Id } from "../project/model";
import { vst3ManifestOf } from "./vst3";

/** One setting a Plugin declares. */
export type PluginParam = EffectParam<Record<string, number>>;

/** What a Plugin says about itself, as the engine checked it. */
export interface PluginManifest {
  id: string;
  version: string;
  kind: "effect" | "instrument";
  name: string;
  /** Its settings, as a built-in's table has them: every one a number. */
  settings: readonly PluginParam[];
  /** Only a VST3 Plugin's (ADR 0008), which the Project keeps beside it. */
  vst3?: { name: string; vendor: string };
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  /** The `.wasm`, for the engine to load. */
  wasm: Uint8Array;
}

/**
 * A manifest in the form the engine writes it (`PluginManifest::to_json`,
 * or `plugin_manifest` in the WASM build), which has already checked it.
 */
export function readPluginManifest(json: string): PluginManifest {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.version !== "string") {
    throw new Error("That isn't a Plugin manifest");
  }
  const settings = Array.isArray(value.settings) ? value.settings : [];
  return {
    id: value.id,
    version: value.version,
    kind: value.kind === "instrument" ? "instrument" : "effect",
    name: typeof value.name === "string" ? value.name : value.id,
    settings: settings.filter(isRecord).map((setting) => ({
      name: String(setting.name),
      label: String(setting.label),
      unit: typeof setting.unit === "string" ? setting.unit : "",
      min: Number(setting.min),
      max: Number(setting.max),
      default: Number(setting.default),
      step: Number(setting.step ?? 0),
      choices: [],
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

let installed: readonly InstalledPlugin[] = [];
const listeners = new Set<() => void>();

/** Every installed Plugin, sorted by name. The same array until it changes. */
export function installedPlugins(): readonly InstalledPlugin[] {
  return installed;
}

/** The installed Plugin `id`, or undefined when this machine hasn't got it. */
export function installedPlugin(id: string): InstalledPlugin | undefined {
  return installed.find((plugin) => plugin.manifest.id === id);
}

/**
 * The manifest of Plugin `id`: an installed WASM Plugin's, or a loaded VST3
 * Plugin's. Undefined when this machine hasn't got it, or hasn't loaded it.
 */
export function pluginManifest(id: string): PluginManifest | undefined {
  return isVst3Id(id) ? vst3ManifestOf(id) : installedPlugin(id)?.manifest;
}

/** What the Plugins folder holds now. */
export function setInstalledPlugins(plugins: readonly InstalledPlugin[]): void {
  installed = plugins.toSorted((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  for (const listener of listeners) listener();
}

/** Hear of every change, for `useSyncExternalStore`. */
export function subscribeToPlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

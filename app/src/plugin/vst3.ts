/**
 * VST3 Plugins (ADR 0008), as the UI sees them: what the Desktop App's scan
 * found, and each instance a Project has loaded, each in a helper process of
 * its own. Only the Desktop App hosts them; in the browser the platform part
 * is null, and a Project's VST3 Plugins are kept exactly and missing.
 *
 * Like the WASM Plugins' (`plugins.ts`), everything here is found
 * synchronously, so drawing a VST3 Effect's controls, checking the
 * Assistant's settings and sending the engine its commands all see the same
 * thing. `Vst3Sync` (`vst3-sync.ts`) keeps it in step with the Project.
 */
import type { Invoke } from "../audio/desktop-audio-output";
import { VST3_ID_PREFIX } from "../project/model";
import type { PluginManifest } from "./plugins";

/** One class a bundle holds: an Effect or an Instrument. `Class` in `desktop/src/vst3/moduleinfo.rs`. */
export interface Vst3Class {
  /** 32 hex digits. */
  cid: string;
  category: string;
  name: string;
  vendor: string;
  version: string;
  /** Such as `Fx`, `Instrument` and `Synth`. */
  subCategories: string[];
}

/** One bundle the scan found. `Scanned` in `desktop/src/vst3/scan.rs`. */
export interface Vst3Scanned {
  bundle: string;
  classes: Vst3Class[];
  /** Why it couldn't be scanned, if it couldn't. */
  error: string | null;
  source: "moduleInfo" | "helper" | "cache";
}

/** A setting a Plugin exposes: automatable, and neither read-only nor hidden. `Setting` in `desktop/src/vst3/mod.rs`. */
export interface Vst3Setting {
  /** Its ParamID. */
  id: number;
  /** The engine's name for it, and the Project's: `p<id>`. */
  name: string;
  label: string;
  unit: string;
  /** Normalised, 0 to 1, as `value` is. */
  default: number;
  /** 0 for continuous; otherwise how many steps it has, less one. */
  steps: number;
  value: number;
}

export interface Vst3Editor {
  width: number;
  height: number;
  resizable: boolean;
  platforms: string[];
}

/** A loaded instance. `Summary` in `desktop/src/vst3/mod.rs`. */
export interface Vst3Summary {
  key: string;
  /** Which load of `key` this is; the engine's slot takes this one. */
  generation: number;
  kind: "effect" | "instrument";
  settings: Vst3Setting[];
  editor: Vst3Editor | null;
}

/** A Plugin's state, in base64, as the Project keeps it. */
export interface Vst3State {
  component: string;
  controller: string;
}

/** What happened in a Plugin's window, or to its settings. `Notice` in `desktop/src/vst3/mod.rs`. */
export type Vst3Notice =
  | { type: "begin"; id: number }
  | { type: "edit"; id: number; value: number }
  | { type: "end"; id: number }
  /** It changed its settings, or their values, itself. */
  | { type: "restart"; flags: number }
  /** The musician closed its window, which was at `x`, `y`. */
  | { type: "closed"; x: number; y: number };

export interface Vst3Polled {
  /** By instance key, in the order they happened. */
  notices: [string, Vst3Notice][];
  /** The instances whose helper has gone: crashed, or killed for hanging. */
  gone: string[];
}

export interface Vst3LoadRequest {
  key: string;
  bundle: string;
  cid: string;
  name: string;
  version: string;
  sampleRate: number;
  state: Vst3State | null;
}

/** The Desktop App's VST3 host: the platform part, null in the browser. */
export interface Vst3Host {
  /** The folders VST3 Plugins are installed into on this machine. */
  defaultFolders(): Promise<string[]>;
  /** Every bundle in the default folders and `folders`. */
  scan(folders: readonly string[]): Promise<Vst3Scanned[]>;
  /** Loads a Plugin into a helper of its own as `request.key`, replacing any instance there. */
  load(request: Vst3LoadRequest): Promise<Vst3Summary>;
  unload(key: string): Promise<void>;
  poll(): Promise<Vst3Polled>;
  state(key: string): Promise<Vst3State>;
  /** Its settings again, after it changed them itself. */
  settings(key: string): Promise<Vst3Setting[]>;
  /** The Plugin's own words for setting `id` at `value`, such as "-6.0 dB". */
  text(key: string, id: number, value: number): Promise<string>;
  /** Opens its own window, at `at` if it has been open before. */
  openEditor(key: string, title: string, at: readonly [number, number] | null): Promise<void>;
  /** Closes its window, answering where it was. */
  closeEditor(key: string): Promise<[number, number]>;
}

/** The commands in `desktop/src/vst3/commands.rs`. */
export function desktopVst3(invoke: Invoke): Vst3Host {
  return {
    defaultFolders: () => invoke("vst3_default_folders"),
    scan: (folders) => invoke("vst3_scan", { folders: [...folders] }),
    load: (request) => invoke("vst3_load", { request }),
    unload: (key) => invoke("vst3_unload", { key }),
    poll: () => invoke("vst3_poll"),
    state: (key) => invoke("vst3_state", { key }),
    settings: (key) => invoke("vst3_settings", { key }),
    text: (key, id, value) => invoke("vst3_text", { key, id, value }),
    openEditor: (key, title, at) => invoke("vst3_open_editor", { key, title, at: at ? [...at] : null }),
    closeEditor: (key) => invoke("vst3_close_editor", { key }),
  };
}

/** A VST3 class's Plugin id in a Project: `vst3.` and its class id in lower case. */
export function vst3PluginId(cid: string): string {
  return `${VST3_ID_PREFIX}${cid.toLowerCase()}`;
}

/** The class id a VST3 Plugin id names, as the scan gives it: upper case. */
export function vst3Cid(pluginId: string): string {
  return pluginId.slice(VST3_ID_PREFIX.length).toUpperCase();
}

/** Whether a class is an Instrument rather than an Effect, as its sub-categories say. */
export function isVst3Instrument(vst3Class: Vst3Class): boolean {
  return vst3Class.subCategories.some((category) => category.split("|").includes("Instrument"));
}

/**
 * A VST3 Plugin's manifest, as the rest of the UI reads a WASM Plugin's: its
 * settings are the ones it exposes, by `p<ParamID>`, each normalised from 0
 * to 1. The engine is given the same one by the Desktop App.
 */
export function vst3Manifest(vst3Class: Vst3Class, summary: Pick<Vst3Summary, "kind" | "settings">): PluginManifest {
  return {
    id: vst3PluginId(vst3Class.cid),
    version: vst3Class.version,
    kind: summary.kind,
    name: vst3Class.name,
    settings: summary.settings.map((setting) => ({
      name: setting.name,
      label: setting.label,
      unit: setting.unit,
      min: 0,
      max: 1,
      default: setting.default,
      step: setting.steps > 0 ? 1 / setting.steps : 0,
      choices: [],
    })),
    vst3: { name: vst3Class.name, vendor: vst3Class.vendor },
  };
}

/**
 * One instance a Project has, by its key. `loading` while its helper starts
 * (a Plugin may take a minute, for its copy protection); `ready` once the
 * engine can host it; `crashed` once its helper has gone, when only
 * **Reload** brings it back; `failed` when it wouldn't load, saying why.
 */
export type Vst3Instance =
  | { status: "loading"; pluginId: string }
  | {
      status: "ready" | "crashed";
      pluginId: string;
      generation: number;
      manifest: PluginManifest;
      editor: Vst3Editor | null;
      /** Its window is open. */
      open: boolean;
    }
  | { status: "failed"; pluginId: string; error: string };

let scanned: readonly Vst3Scanned[] = [];
let scanning = false;
let instances: ReadonlyMap<string, Vst3Instance> = new Map();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/** What the last scan found, in bundle order. The same array until it changes. */
export function vst3Scanned(): readonly Vst3Scanned[] {
  return scanned;
}

export function setVst3Scanned(found: readonly Vst3Scanned[]): void {
  scanned = found;
  scanning = false;
  changed();
}

/** Whether a scan is under way. */
export function vst3Scanning(): boolean {
  return scanning;
}

export function setVst3Scanning(on: boolean): void {
  scanning = on;
  changed();
}

/** Every class the scan found, with the bundle it is in, sorted by name. */
export function vst3Classes(found = scanned): { bundle: string; vst3Class: Vst3Class }[] {
  return found
    .flatMap(({ bundle, classes }) => classes.map((vst3Class) => ({ bundle, vst3Class })))
    .toSorted((a, b) => a.vst3Class.name.localeCompare(b.vst3Class.name));
}

/** Where the class a Plugin id names is installed, or undefined when the scan didn't find it. */
export function vst3ClassOf(pluginId: string): { bundle: string; vst3Class: Vst3Class } | undefined {
  const cid = vst3Cid(pluginId);
  return vst3Classes().find(({ vst3Class }) => vst3Class.cid.toUpperCase() === cid);
}

/** Every instance, by key. The same map until it changes. */
export function vst3Instances(): ReadonlyMap<string, Vst3Instance> {
  return instances;
}

/** The instance `key`, or undefined when there is none. */
export function vst3Instance(key: string): Vst3Instance | undefined {
  return instances.get(key);
}

/** Change instance `key`, or forget it with undefined. */
export function setVst3Instance(key: string, instance: Vst3Instance | undefined): void {
  const next = new Map(instances);
  if (instance) next.set(key, instance);
  else next.delete(key);
  instances = next;
  changed();
}

/**
 * The manifest of the VST3 Plugin `pluginId`, from any instance of it that
 * has loaded, or undefined while none has: its settings are then kept as
 * they were saved.
 */
export function vst3ManifestOf(pluginId: string): PluginManifest | undefined {
  for (const instance of instances.values()) {
    if (instance.pluginId === pluginId && "manifest" in instance) return instance.manifest;
  }
  return undefined;
}

/**
 * The generation the engine's slot for instance `key` takes, or undefined
 * when there is nothing for it to host yet, and it is missing. A crashed
 * instance keeps its slot: the engine already bypasses or silences it.
 */
export function vst3Generation(key: string, pluginId: string): number | undefined {
  const instance = instances.get(key);
  return instance && instance.pluginId === pluginId && "generation" in instance ? instance.generation : undefined;
}

/** An Effect's instance key is its own id; an Instrument's is its Track's. */
export function vst3InstrumentKey(trackId: string): string {
  return `instrument:${trackId}`;
}

/** Hear of every change, for `useSyncExternalStore`. */
export function subscribeToVst3(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forget everything: for tests, and a Desktop App with no host. */
export function resetVst3(): void {
  scanned = [];
  scanning = false;
  instances = new Map();
  changed();
}

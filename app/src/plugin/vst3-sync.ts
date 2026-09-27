/**
 * Keeps the VST3 Plugins the Desktop App has loaded in step with the
 * Project (ADR 0008), as EngineSync keeps the engine: every VST3 Effect and
 * Instrument in the Project has an instance, loaded into a helper process of
 * its own, under a key that is the Effect's id or its Track's.
 *
 * - An instance is loaded once, from the state the Project saved, and then
 *   lives until its Effect or Track goes. The Plugin holds its own state from
 *   then on; it is fetched at most every 2 s while its window is open or its
 *   settings change, and when the Project is saved (`withStates`), so the
 *   saved Project has it without each fetch becoming a step to undo.
 * - A setting turned in the Plugin's own window comes back as an edit, and is
 *   recorded in the Project as one step when the musician lets go of it.
 * - A helper that crashes, or hangs and is killed, leaves its instance
 *   *crashed*; only **Reload** starts it again, from the last state fetched.
 *   A Plugin that crashes every time it loads would otherwise crash in a loop.
 * - A Plugin the scan didn't find isn't loaded, and stays missing.
 */
import type { Command } from "../project/commands";
import { isVst3Id, newId, type Effect, type Project, type Track } from "../project/model";
import type { PluginManifest } from "./plugins";
import {
  setVst3Instance,
  type Vst3Class,
  vst3ClassOf,
  type Vst3Host,
  vst3Instance,
  vst3Instances,
  vst3InstrumentKey,
  vst3Manifest,
  vst3PluginId,
  type Vst3State,
} from "./vst3";

/** How often a changing Plugin's state is fetched at most, in ms. */
export const STATE_EVERY_MS = 2_000;

/** `restartComponent`'s flag for "every value has changed", as a preset loaded in its window does. */
const PARAM_VALUES_CHANGED = 4;

/** One VST3 Plugin the Project has, and where. */
export interface Vst3Wanted {
  key: string;
  pluginId: string;
  name: string;
  state: Vst3State;
  settings: Record<string, number>;
  /** What its setting changes are recorded against. */
  target: { effectId: string } | { trackId: string };
  /** Its window's: "<Track>: <Plugin>". */
  title: string;
}

/** Every VST3 Plugin in `project`: in each Insert Chain, and each Track's Instrument. */
export function vst3Wanted(project: Project): Vst3Wanted[] {
  const wanted: Vst3Wanted[] = [];
  const chain = (owner: string, effects: readonly Effect[]) => {
    for (const effect of effects) {
      if (effect.type !== "plugin" || !effect.vst3 || !isVst3Id(effect.plugin.id)) continue;
      wanted.push({
        key: effect.id,
        pluginId: effect.plugin.id,
        name: effect.vst3.name,
        state: effect.vst3.state,
        settings: effect.settings,
        target: { effectId: effect.id },
        title: `${owner}: ${effect.vst3.name}`,
      });
    }
  };
  chain("Master", project.master.insertChain);
  for (const bus of project.buses) chain(bus.name, bus.insertChain);
  for (const track of project.tracks) {
    chain(track.name, track.insertChain);
    const instrument = track.kind === "instrument" ? track.instrument : null;
    if (instrument?.type !== "plugin" || !instrument.vst3 || !isVst3Id(instrument.plugin.id)) continue;
    wanted.push({
      key: vst3InstrumentKey(track.id),
      pluginId: instrument.plugin.id,
      name: instrument.vst3.name,
      state: instrument.vst3.state,
      settings: instrument.settings,
      target: { trackId: track.id },
      title: `${track.name}: ${instrument.vst3.name}`,
    });
  }
  return wanted;
}

export interface Vst3SyncOptions {
  /** The rate a helper first starts at; the Desktop App starts it again at the engine's if they differ. */
  sampleRate?: number;
  now?: () => number;
}

export class Vst3Sync {
  readonly #host: Vst3Host;
  readonly #sampleRate: number;
  readonly #now: () => number;
  #wanted = new Map<string, Vst3Wanted>();
  /** Loaded for an Effect or Track about to be added, so kept until it is. */
  #pending = new Set<string>();
  /** Which load of each key is the latest, so an older one finishing late is ignored. */
  #loads = new Map<string, number>();
  #nextLoad = 0;
  /** The last state fetched for each key, and which Plugin it is of. */
  #states = new Map<string, { pluginId: string; state: Vst3State }>();
  #fetched = new Map<string, number>();
  #dirty = new Set<string>();
  #editing = new Map<string, Set<number>>();
  #edits = new Map<string, Map<number, number>>();
  /** Where each window was when it closed. */
  #positions = new Map<string, [number, number]>();
  /** Each key being unloaded, which a load of the same key waits for, so it isn't unloaded after. */
  #unloading = new Map<string, Promise<void>>();

  constructor(host: Vst3Host, { sampleRate = 48_000, now = () => Date.now() }: Vst3SyncOptions = {}) {
    this.#host = host;
    this.#sampleRate = sampleRate;
    this.#now = now;
  }

  /**
   * Load what `project` has and isn't loaded, and unload what it no longer
   * has. Call it whenever the Project or the scan changes.
   */
  update(project: Project): void {
    const wanted = new Map(vst3Wanted(project).map((one) => [one.key, one]));
    for (const [key, one] of wanted) {
      this.#pending.delete(key);
      const before = this.#wanted.get(key);
      if (before && before.settings !== one.settings) this.#dirty.add(key);
      const instance = vst3Instance(key);
      if (instance?.pluginId === one.pluginId) continue;
      if (vst3ClassOf(one.pluginId)) void this.#load(one);
      else if (instance) this.#unload(key);
    }
    this.#wanted = wanted;
    for (const key of vst3Instances().keys()) {
      if (!wanted.has(key) && !this.#pending.has(key)) this.#unload(key);
    }
  }

  /**
   * A new VST3 Effect of `vst3Class`, loaded first so it starts at the
   * Plugin's own settings, for the caller to add to the Project; or why it
   * wouldn't load. If it isn't added after all, `discard` it.
   */
  async createEffect(vst3Class: Vst3Class, bundle: string): Promise<PluginManifest & { key: string }> {
    return this.#prepare(newId(), vst3Class, bundle);
  }

  /** As `createEffect`, for the Instrument of the Track `trackId` about to be added. */
  async createInstrument(vst3Class: Vst3Class, bundle: string, trackId: string): Promise<PluginManifest & { key: string }> {
    return this.#prepare(vst3InstrumentKey(trackId), vst3Class, bundle);
  }

  /** Unload what `createEffect` or `createInstrument` loaded, since it wasn't added. */
  discard(key: string): void {
    this.#pending.delete(key);
    if (!this.#wanted.has(key)) this.#unload(key);
  }

  async #prepare(key: string, vst3Class: Vst3Class, bundle: string): Promise<PluginManifest & { key: string }> {
    this.#pending.add(key);
    const pluginId = vst3PluginId(vst3Class.cid);
    await this.#start(key, pluginId, vst3Class, bundle, null);
    const instance = vst3Instance(key);
    if (instance?.status !== "ready") {
      this.#pending.delete(key);
      this.#unload(key);
      throw new Error(instance?.status === "failed" ? instance.error : `${vst3Class.name} didn't load`);
    }
    return { ...instance.manifest, key };
  }

  /** Start instance `key` again, from the last state it has: after a crash, or a load that failed. */
  reload(key: string): Promise<void> {
    const one = this.#wanted.get(key);
    return one ? this.#load(one) : Promise.resolve();
  }

  #load(one: Vst3Wanted): Promise<void> {
    const found = vst3ClassOf(one.pluginId);
    if (!found) return Promise.resolve();
    const kept = this.#states.get(one.key);
    const state = kept?.pluginId === one.pluginId ? kept.state : one.state;
    return this.#start(one.key, one.pluginId, found.vst3Class, found.bundle, state);
  }

  async #start(key: string, pluginId: string, vst3Class: Vst3Class, bundle: string, state: Vst3State | null): Promise<void> {
    const load = ++this.#nextLoad;
    this.#loads.set(key, load);
    setVst3Instance(key, { status: "loading", pluginId });
    try {
      await this.#unloading.get(key);
      if (this.#loads.get(key) !== load) return;
      const summary = await this.#host.load({
        key,
        bundle,
        cid: vst3Class.cid,
        name: vst3Class.name,
        version: vst3Class.version,
        sampleRate: this.#sampleRate,
        state: state && (state.component || state.controller) ? state : null,
      });
      if (this.#loads.get(key) !== load) return;
      if (!this.#wanted.has(key) && !this.#pending.has(key)) {
        // Its Effect or Track went while it loaded.
        this.#unload(key);
        return;
      }
      setVst3Instance(key, {
        status: "ready",
        pluginId,
        generation: summary.generation,
        manifest: vst3Manifest(vst3Class, summary),
        editor: summary.editor,
        open: false,
      });
    } catch (error) {
      if (this.#loads.get(key) !== load) return;
      setVst3Instance(key, { status: "failed", pluginId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  #unload(key: string): void {
    this.#loads.delete(key);
    this.#states.delete(key);
    this.#fetched.delete(key);
    this.#dirty.delete(key);
    this.#editing.delete(key);
    this.#edits.delete(key);
    this.#positions.delete(key);
    setVst3Instance(key, undefined);
    const unloading = this.#host
      .unload(key)
      .catch(() => {})
      .finally(() => {
        if (this.#unloading.get(key) === unloading) this.#unloading.delete(key);
      });
    this.#unloading.set(key, unloading);
  }

  /**
   * Hear what happened since the last poll: helpers that have gone are
   * *crashed*, windows the musician closed are closed, and a Plugin that
   * changed its settings itself is asked for them again. Answers the
   * commands that record in the Project what the musician turned in the
   * Plugins' windows, once they have let go.
   */
  async poll(): Promise<Command[]> {
    const polled = await this.#host.poll();
    for (const key of polled.gone) {
      const instance = vst3Instance(key);
      if (instance && "generation" in instance) setVst3Instance(key, { ...instance, status: "crashed", open: false });
    }
    const touched = new Set<string>();
    const commands: Command[] = [];
    for (const [key, notice] of polled.notices) {
      const editing = this.#editing.get(key) ?? new Set<number>();
      this.#editing.set(key, editing);
      if (notice.type === "begin") editing.add(notice.id);
      else if (notice.type === "end") editing.delete(notice.id);
      else if (notice.type === "edit") {
        const edits = this.#edits.get(key) ?? new Map<number, number>();
        this.#edits.set(key, edits.set(notice.id, notice.value));
        this.#dirty.add(key);
      } else if (notice.type === "closed") {
        this.#positions.set(key, [notice.x, notice.y]);
        const instance = vst3Instance(key);
        if (instance && "open" in instance) setVst3Instance(key, { ...instance, open: false });
      } else {
        this.#dirty.add(key);
        const command = await this.#restarted(key, (notice.flags & PARAM_VALUES_CHANGED) !== 0);
        if (command) commands.push(command);
      }
      touched.add(key);
    }
    for (const key of touched) {
      const edits = this.#edits.get(key);
      if (!edits?.size || this.#editing.get(key)?.size) continue;
      this.#edits.delete(key);
      const command = this.#record(key, new Map([...edits].map(([id, value]) => [`p${id}`, value])));
      if (command) commands.push(command);
    }
    this.#fetchStates();
    return commands;
  }

  /** Its settings again; with every value changed, all of them recorded in the Project. */
  async #restarted(key: string, valuesChanged: boolean): Promise<Command | null> {
    const instance = vst3Instance(key);
    if (instance?.status !== "ready") return null;
    try {
      const settings = await this.#host.settings(key);
      const current = vst3Instance(key);
      if (current?.status !== "ready" || current.generation !== instance.generation) return null;
      const found = vst3ClassOf(current.pluginId);
      const manifest = found ? vst3Manifest(found.vst3Class, { kind: current.manifest.kind, settings }) : current.manifest;
      setVst3Instance(key, { ...current, manifest });
      return valuesChanged ? this.#record(key, new Map(settings.map((setting) => [setting.name, setting.value]))) : null;
    } catch {
      return null;
    }
  }

  /** The command setting `values` of instance `key`'s settings in the Project: only those it exposes. */
  #record(key: string, values: ReadonlyMap<string, number>): Command | null {
    const one = this.#wanted.get(key);
    const instance = vst3Instance(key);
    if (!one || !instance || !("manifest" in instance)) return null;
    const exposed = new Set(instance.manifest.settings.map((param) => param.name));
    const settings = Object.fromEntries([...values].filter(([name, value]) => exposed.has(name) && one.settings[name] !== value));
    if (Object.keys(settings).length === 0) return null;
    return "effectId" in one.target
      ? { type: "setEffectSettings", effectId: one.target.effectId, settings }
      : { type: "setInstrumentSettings", trackId: one.target.trackId, settings };
  }

  /** Fetch the state of each instance whose window is open or that has changed, at most every 2 s. */
  #fetchStates(): void {
    const now = this.#now();
    for (const [key, instance] of vst3Instances()) {
      if (instance.status !== "ready" || !(instance.open || this.#dirty.has(key))) continue;
      if (now - (this.#fetched.get(key) ?? -Infinity) < STATE_EVERY_MS) continue;
      this.#fetched.set(key, now);
      this.#dirty.delete(key);
      void this.#fetchState(key, instance.pluginId);
    }
  }

  async #fetchState(key: string, pluginId: string): Promise<void> {
    try {
      const state = await this.#host.state(key);
      if (vst3Instance(key)?.pluginId === pluginId) this.#states.set(key, { pluginId, state });
    } catch {
      // A helper that has gone keeps the last state it gave.
    }
  }

  /**
   * `project` with each VST3 Plugin's state as it is now, for saving: fetched
   * from every instance that is running, and the last one fetched for one
   * that has crashed.
   */
  async withStates(project: Project): Promise<Project> {
    await Promise.all(
      [...vst3Instances()]
        .filter(([, instance]) => instance.status === "ready")
        .map(([key, instance]) => this.#fetchState(key, instance.pluginId)),
    );
    if (this.#states.size === 0) return project;
    const saved = structuredClone(project);
    const stateOf = (key: string, pluginId: string) => {
      const kept = this.#states.get(key);
      return kept?.pluginId === pluginId ? { ...kept.state } : undefined;
    };
    const chain = (effects: Effect[]) => {
      for (const effect of effects) {
        if (effect.type !== "plugin" || !effect.vst3) continue;
        effect.vst3.state = stateOf(effect.id, effect.plugin.id) ?? effect.vst3.state;
      }
    };
    chain(saved.master.insertChain);
    for (const bus of saved.buses) chain(bus.insertChain);
    for (const track of saved.tracks as Track[]) {
      chain(track.insertChain);
      if (track.kind !== "instrument" || track.instrument.type !== "plugin" || !track.instrument.vst3) continue;
      track.instrument.vst3.state = stateOf(vst3InstrumentKey(track.id), track.instrument.plugin.id) ?? track.instrument.vst3.state;
    }
    return saved;
  }

  /** Open instance `key`'s own window, where it was last. */
  async openEditor(key: string): Promise<void> {
    const one = this.#wanted.get(key);
    const instance = vst3Instance(key);
    if (!one || instance?.status !== "ready") return;
    await this.#host.openEditor(key, one.title, this.#positions.get(key) ?? null);
    const current = vst3Instance(key);
    if (current?.status === "ready") setVst3Instance(key, { ...current, open: true });
  }

  async closeEditor(key: string): Promise<void> {
    const at = await this.#host.closeEditor(key);
    this.#positions.set(key, at);
    const current = vst3Instance(key);
    if (current && "open" in current) setVst3Instance(key, { ...current, open: false });
  }

  /** The Plugin's own words for a setting's value, such as "-6.0 dB", or null if it can't say. */
  async text(key: string, setting: string, value: number): Promise<string | null> {
    const id = Number(setting.slice(1));
    if (!setting.startsWith("p") || !Number.isInteger(id)) return null;
    return this.#host.text(key, id, value).catch(() => null);
  }

  /**
   * Unload every instance: the Project is being replaced, by New or Open, or
   * the app is closing. A Track in the next Project may have the same id and
   * the same Plugin, and must still load from its own state.
   */
  dispose(): void {
    this.#wanted.clear();
    this.#pending.clear();
    for (const key of vst3Instances().keys()) this.#unload(key);
  }
}

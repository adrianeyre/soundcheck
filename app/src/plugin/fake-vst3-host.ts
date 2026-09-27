/**
 * VST3 Plugins for tests, in memory: no Desktop App, no helper process. The
 * host loads every Plugin at once, or holds or fails its loads when told,
 * and hands back whatever notices, crashes and states a test gives it, so
 * the UI built on `Vst3Host` can be tested without either.
 */
import { type Vst3Class, type Vst3Host, type Vst3LoadRequest, vst3Manifest, type Vst3Notice, type Vst3Scanned, type Vst3Setting, type Vst3State } from "./vst3";

export const TILT: Vst3Class = {
  cid: "0123456789ABCDEF0123456789ABCDEF",
  category: "Audio Module Class",
  name: "Tilt",
  vendor: "Tilters",
  version: "1.0.2",
  subCategories: ["Fx|EQ"],
};

export const KEYS: Vst3Class = {
  cid: "FEDCBA9876543210FEDCBA9876543210",
  category: "Audio Module Class",
  name: "Keys",
  vendor: "Keymakers",
  version: "2",
  subCategories: ["Instrument|Synth"],
};

export const TILT_SETTINGS: Vst3Setting[] = [
  { id: 0, name: "p0", label: "Tilt", unit: "dB", default: 0.5, steps: 0, value: 0.5 },
  { id: 7, name: "p7", label: "Mode", unit: "", default: 0, steps: 2, value: 0 },
];

export const tiltManifest = () => vst3Manifest(TILT, { kind: "effect", settings: TILT_SETTINGS });

export class FakeVst3Host implements Vst3Host {
  loads: Vst3LoadRequest[] = [];
  unloads: string[] = [];
  states = new Map<string, Vst3State>();
  stateCalls: string[] = [];
  notices: [string, Vst3Notice][] = [];
  gone: string[] = [];
  settingsNow: Vst3Setting[] = TILT_SETTINGS;
  opened: [string, string, readonly [number, number] | null][] = [];
  failWith: string | null = null;
  #generations = new Map<string, number>();
  #held: (() => void)[] = [];
  hold = false;

  defaultFolders = () => Promise.resolve(["/vst3"]);
  scan = (_folders: readonly string[]): Promise<Vst3Scanned[]> => Promise.resolve([]);

  async load(request: Vst3LoadRequest) {
    this.loads.push(request);
    if (this.hold) await new Promise<void>((resolve) => this.#held.push(resolve));
    if (this.failWith) throw new Error(this.failWith);
    const generation = (this.#generations.get(request.key) ?? 0) + 1;
    this.#generations.set(request.key, generation);
    const instrument = request.cid === KEYS.cid;
    return {
      key: request.key,
      generation,
      kind: instrument ? ("instrument" as const) : ("effect" as const),
      settings: instrument ? [] : TILT_SETTINGS,
      editor: { width: 400, height: 300, resizable: false, platforms: ["HWND"] },
    };
  }

  release() {
    for (const resolve of this.#held.splice(0)) resolve();
  }

  unload(key: string) {
    this.unloads.push(key);
    return Promise.resolve();
  }

  poll() {
    const polled = { notices: this.notices, gone: this.gone };
    this.notices = [];
    this.gone = [];
    return Promise.resolve(polled);
  }

  state(key: string) {
    this.stateCalls.push(key);
    return Promise.resolve(this.states.get(key) ?? { component: "", controller: "" });
  }

  settings = () => Promise.resolve(this.settingsNow);
  text = (_key: string, id: number, value: number) => Promise.resolve(`${id}:${value}`);

  openEditor(key: string, title: string, at: readonly [number, number] | null) {
    this.opened.push([key, title, at]);
    return Promise.resolve();
  }

  closeEditor = () => Promise.resolve([10, 20] as [number, number]);
}


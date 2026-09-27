import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createPluginEffect } from "../effect/effect-table";
import { createPluginInstrument } from "../instrument/instrument-table";
import { createInstrumentTrack, createProject, type PluginEffect, type Project } from "../project/model";
import { FakeVst3Host, KEYS, TILT, tiltManifest } from "./fake-vst3-host";
import { resetVst3, setVst3Scanned, vst3Instance, vst3Instances, vst3Manifest } from "./vst3";
import { STATE_EVERY_MS, Vst3Sync, vst3Wanted } from "./vst3-sync";

const SAVED = { component: "Y29tcA==", controller: "Y3RybA==" };

/** The Keys Track with a Tilt, saved with a state, in its Insert Chain. */
function project(): Project {
  const track = createInstrumentTrack("Keys", "keys");
  const tilt = createPluginEffect(tiltManifest(), "fx") as PluginEffect;
  track.insertChain.push({ ...tilt, settings: { p0: 0.25, p7: 1 }, vst3: { ...tilt.vst3!, state: SAVED } });
  const result = createProject("VST3");
  result.tracks.push(track);
  return result;
}

function withSettings(from: Project, settings: Record<string, number>): Project {
  const track = from.tracks[0]!;
  return { ...from, tracks: [{ ...track, insertChain: [{ ...track.insertChain[0]!, settings } as PluginEffect] }] };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let host: FakeVst3Host;
let now: number;
let sync: Vst3Sync;

beforeEach(() => {
  host = new FakeVst3Host();
  now = 0;
  sync = new Vst3Sync(host, { now: () => now });
  setVst3Scanned([
    { bundle: "/vst3/Tilt.vst3", classes: [TILT], error: null, source: "moduleInfo" },
    { bundle: "/vst3/Keys.vst3", classes: [KEYS], error: null, source: "cache" },
  ]);
});

afterEach(resetVst3);

describe("which VST3 Plugins a Project has", () => {
  test("each Insert Chain's, and each Track's Instrument, with its window's title", () => {
    const keys = createInstrumentTrack("Piano", "piano");
    keys.instrument = createPluginInstrument(vst3Manifest(KEYS, { kind: "instrument", settings: [] }));
    const withKeys = project();
    withKeys.tracks.push(keys);
    withKeys.master.insertChain.push({ ...createPluginEffect(tiltManifest(), "master-fx") });
    expect(vst3Wanted(withKeys).map(({ key, title }) => [key, title])).toEqual([
      ["master-fx", "Master: Tilt"],
      ["fx", "Keys: Tilt"],
      ["instrument:piano", "Piano: Keys"],
    ]);
  });
});

describe("Vst3Sync", () => {
  test("loads each one from the state the Project saved, and it is ready with its exposed settings", async () => {
    sync.update(project());
    expect(vst3Instance("fx")?.status).toBe("loading");
    await settle();
    expect(host.loads).toEqual([
      {
        key: "fx",
        bundle: "/vst3/Tilt.vst3",
        cid: TILT.cid,
        name: "Tilt",
        version: "1.0.2",
        sampleRate: 48_000,
        state: SAVED,
      },
    ]);
    expect(vst3Instance("fx")).toMatchObject({ status: "ready", generation: 1, open: false });
    sync.update(project());
    expect(host.loads).toHaveLength(1);
  });

  test("a Plugin with no state saved yet loads as the Plugin starts", async () => {
    const fresh = project();
    const effect = fresh.tracks[0]!.insertChain[0] as PluginEffect;
    effect.vst3!.state = { component: "", controller: "" };
    sync.update(fresh);
    await settle();
    expect(host.loads[0]?.state).toBeNull();
  });

  test("one the scan didn't find isn't loaded, and stays missing", async () => {
    setVst3Scanned([]);
    sync.update(project());
    await settle();
    expect(host.loads).toEqual([]);
    expect(vst3Instance("fx")).toBeUndefined();
  });

  test("one that won't load has failed, saying why, until Reload", async () => {
    host.failWith = "It needs its licence";
    sync.update(project());
    await settle();
    expect(vst3Instance("fx")).toEqual({ status: "failed", pluginId: "vst3.0123456789abcdef0123456789abcdef", error: "It needs its licence" });
    host.failWith = null;
    await sync.reload("fx");
    expect(vst3Instance("fx")?.status).toBe("ready");
  });

  test("an Effect that goes is unloaded, even while it loads", async () => {
    host.hold = true;
    sync.update(project());
    const empty = { ...project(), tracks: [{ ...project().tracks[0]!, insertChain: [] }] };
    sync.update(empty);
    expect(host.unloads).toEqual(["fx"]);
    host.release();
    await settle();
    expect(vst3Instances().size).toBe(0);
  });

  test("a helper that has gone leaves its instance crashed, and Reload loads it from the last state fetched", async () => {
    sync.update(project());
    await settle();
    host.states.set("fx", { component: "bmV3", controller: "" });
    sync.update(withSettings(project(), { p0: 0.3, p7: 1 }));
    await sync.poll();
    await settle();

    host.gone = ["fx"];
    await sync.poll();
    expect(vst3Instance("fx")).toMatchObject({ status: "crashed", generation: 1 });
    // It isn't loaded again by itself.
    sync.update(withSettings(project(), { p0: 0.3, p7: 1 }));
    expect(host.loads).toHaveLength(1);

    await sync.reload("fx");
    expect(host.loads[1]?.state).toEqual({ component: "bmV3", controller: "" });
    expect(vst3Instance("fx")).toMatchObject({ status: "ready", generation: 2 });
  });

  test("a setting turned in its window is recorded once, when it is let go of", async () => {
    sync.update(project());
    await settle();
    host.notices = [
      ["fx", { type: "begin", id: 0 }],
      ["fx", { type: "edit", id: 0, value: 0.4 }],
    ];
    expect(await sync.poll()).toEqual([]);
    host.notices = [
      ["fx", { type: "edit", id: 0, value: 0.6 }],
      ["fx", { type: "end", id: 0 }],
    ];
    expect(await sync.poll()).toEqual([{ type: "setEffectSettings", effectId: "fx", settings: { p0: 0.6 } }]);
  });

  test("only the settings it exposes are recorded, and none that are already so", async () => {
    sync.update(project());
    await settle();
    host.notices = [
      ["fx", { type: "edit", id: 99, value: 0.4 }],
      ["fx", { type: "edit", id: 7, value: 1 }],
    ];
    expect(await sync.poll()).toEqual([]);
  });

  test("an Instrument's changes are recorded against its Track", async () => {
    const withKeys = project();
    withKeys.tracks[0]!.kind = "instrument";
    Object.assign(withKeys.tracks[0]!, {
      instrument: createPluginInstrument(vst3Manifest(KEYS, { kind: "instrument", settings: [] })),
    });
    host.settingsNow = [{ id: 3, name: "p3", label: "Bright", unit: "", default: 0, steps: 0, value: 0.9 }];
    sync.update(withKeys);
    await settle();
    host.notices = [["instrument:keys", { type: "restart", flags: 4 }]];
    expect(await sync.poll()).toEqual([{ type: "setInstrumentSettings", trackId: "keys", settings: { p3: 0.9 } }]);
    expect(vst3Instance("instrument:keys")).toMatchObject({ manifest: { settings: [{ name: "p3", label: "Bright" }] } });
  });

  test("its state is fetched while it changes, at most every 2 s", async () => {
    sync.update(project());
    await settle();
    await sync.poll();
    expect(host.stateCalls).toEqual([]);

    sync.update(withSettings(project(), { p0: 0.3, p7: 1 }));
    await sync.poll();
    expect(host.stateCalls).toEqual(["fx"]);
    sync.update(withSettings(project(), { p0: 0.35, p7: 1 }));
    now += STATE_EVERY_MS - 1;
    await sync.poll();
    expect(host.stateCalls).toEqual(["fx"]);
    now += 1;
    await sync.poll();
    expect(host.stateCalls).toEqual(["fx", "fx"]);
  });

  test("a saved Project has each Plugin's state as it is now, and the Project itself is left alone", async () => {
    const before = project();
    sync.update(before);
    await settle();
    host.states.set("fx", { component: "bm93", controller: "Y3Rs" });
    const saved = await sync.withStates(before);
    expect((saved.tracks[0]!.insertChain[0] as PluginEffect).vst3!.state).toEqual({ component: "bm93", controller: "Y3Rs" });
    expect((before.tracks[0]!.insertChain[0] as PluginEffect).vst3!.state).toEqual(SAVED);
  });

  test("its window is titled for its Track, and opens again where it was closed", async () => {
    sync.update(project());
    await settle();
    await sync.openEditor("fx");
    expect(vst3Instance("fx")).toMatchObject({ open: true });
    host.notices = [["fx", { type: "closed", x: 30, y: 40 }]];
    await sync.poll();
    expect(vst3Instance("fx")).toMatchObject({ open: false });
    await sync.openEditor("fx");
    await sync.closeEditor("fx");
    await sync.openEditor("fx");
    expect(host.opened).toEqual([
      ["fx", "Keys: Tilt", null],
      ["fx", "Keys: Tilt", [30, 40]],
      ["fx", "Keys: Tilt", [10, 20]],
    ]);
  });

  test("a new Effect is loaded before it is added, so it starts at the Plugin's own settings", async () => {
    const manifest = await sync.createEffect(TILT, "/vst3/Tilt.vst3");
    expect(manifest.settings.map((param) => param.name)).toEqual(["p0", "p7"]);
    expect(host.loads[0]?.state).toBeNull();
    // It isn't in the Project yet, so it is kept until it is, or discarded.
    sync.update(createProject("Empty"));
    expect(vst3Instance(manifest.key)?.status).toBe("ready");
    sync.discard(manifest.key);
    expect(vst3Instance(manifest.key)).toBeUndefined();
    expect(host.unloads).toEqual([manifest.key]);
  });

  test("the Plugin's own words for a setting's value", async () => {
    expect(await sync.text("fx", "p7", 0.5)).toBe("7:0.5");
    expect(await sync.text("fx", "mix", 0.5)).toBeNull();
  });

  test("a Project replaced by one with the same Track and Plugin loads that one's own state, once the old is unloaded", async () => {
    sync.update(project());
    await settle();
    let unloaded: (() => void) | undefined;
    host.unload = (key: string) => {
      host.unloads.push(key);
      return new Promise<void>((resolve) => (unloaded = resolve));
    };
    sync.dispose();
    const next = project();
    (next.tracks[0]!.insertChain[0] as PluginEffect).vst3!.state = { component: "b3du", controller: "" };
    sync.update(next);
    await settle();
    expect(host.loads).toHaveLength(1);
    unloaded?.();
    await settle();
    expect(host.loads[1]?.state).toEqual({ component: "b3du", controller: "" });
    expect(vst3Instance("fx")).toMatchObject({ status: "ready", generation: 2 });
  });

  test("closing unloads every instance", async () => {
    sync.update(project());
    await settle();
    sync.dispose();
    expect(vst3Instances().size).toBe(0);
    expect(host.unloads).toEqual(["fx"]);
  });
});

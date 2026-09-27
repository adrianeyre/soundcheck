// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";

import { InsertChainPanel } from "../effect/InsertChainPanel";
import { createPluginInstrument } from "../instrument/instrument-table";
import { PluginInstrumentPanel } from "../instrument/PluginInstrumentPanel";
import { ProjectHistory } from "../project/history";
import { createInstrumentTrack, createProject, type InstrumentTrack, type PluginEffect, type PluginInstrument } from "../project/model";
import { createPluginEffect } from "../effect/effect-table";
import { FakeVst3Host, KEYS, TILT, tiltManifest } from "./fake-vst3-host";
import { resetVst3, vst3Instance, vst3Manifest, type Vst3Host, type Vst3Scanned } from "./vst3";
import { readVst3Folders, useVst3, Vst3Provider, Vst3Settings, Vst3Unavailable } from "./Vst3Settings";

const FOUND: Vst3Scanned[] = [
  { bundle: "/vst3/Tilt.vst3", classes: [TILT], error: null, source: "moduleInfo" },
  { bundle: "/vst3/Keys.vst3", classes: [KEYS], error: null, source: "cache" },
  { bundle: "/vst3/Broken.vst3", classes: [], error: "Its moduleinfo.json isn't JSON", source: "helper" },
];

class ScanningHost extends FakeVst3Host {
  scanned: (readonly string[])[] = [];
  override scan = (folders: readonly string[]) => {
    this.scanned.push(folders);
    return Promise.resolve(FOUND);
  };
}

let host: ScanningHost;

beforeEach(() => {
  localStorage.clear();
  host = new ScanningHost();
});

afterEach(() => {
  cleanup();
  resetVst3();
});

/** The Keys Track's Insert Chain, its Instrument and the VST3 Settings, as the Song page wires them. */
function show(
  vst3Host: Vst3Host | null = host,
  instrument?: PluginInstrument,
  effect?: PluginEffect,
  unavailable: string | null = null,
): ProjectHistory {
  const start = createProject("VST3");
  const track = createInstrumentTrack("Keys", "keys");
  if (instrument) track.instrument = instrument;
  if (effect) track.insertChain.push(effect);
  start.tracks.push(track);
  const history = new ProjectHistory(start);
  function Harness() {
    const project = useSyncExternalStore(
      (listener) => history.subscribe(listener),
      () => history.project,
    );
    const vst3 = useVst3(vst3Host, project, history);
    const shown = project.tracks[0] as InstrumentTrack;
    return (
      <Vst3Provider vst3={vst3} unavailable={unavailable}>
        <InsertChainPanel
          name="Keys"
          target={{ trackId: "keys" }}
          chain={shown.insertChain}
          onCommand={(command) => history.execute(command)}
        />
        {shown.instrument.type === "plugin" && (
          <PluginInstrumentPanel trackId="keys" trackName="Keys" instrument={shown.instrument} onChange={() => {}} />
        )}
        {vst3 ? <Vst3Settings vst3={vst3} /> : unavailable && <Vst3Unavailable reason={unavailable} />}
      </Vst3Provider>
    );
  }
  render(<Harness />);
  return history;
}

const chain = () => screen.getByRole("region", { name: "Keys Insert Chain" });

async function addTilt(history: ProjectHistory): Promise<PluginEffect> {
  await waitFor(() => expect(within(chain()).getByRole("option", { name: "Tilt (VST3)" })).toBeInTheDocument());
  fireEvent.change(within(chain()).getByLabelText("Effect to add to Keys"), { target: { value: `vst3:${TILT.cid}` } });
  fireEvent.click(within(chain()).getByRole("button", { name: "Add Effect" }));
  await waitFor(() => expect(history.project.tracks[0]!.insertChain).toHaveLength(1));
  return history.project.tracks[0]!.insertChain[0] as PluginEffect;
}

test("Settings lists what the scan found, what it couldn't read and why, and the trademark's owner", async () => {
  show();
  const found = await screen.findByRole("list", { name: "VST3 Plugins found" });
  expect(within(found).getByText("Tilt").parentElement).toHaveTextContent("Tilters 1.0.2, Effect (/vst3/Tilt.vst3)");
  expect(within(found).getByText("Keys").parentElement).toHaveTextContent("Instrument");
  const unreadable = screen.getByRole("list", { name: "VST3 Plugins that couldn't be read" });
  expect(unreadable).toHaveTextContent("/vst3/Broken.vst3 Its moduleinfo.json isn't JSON");
  expect(screen.getByText(/VST is a registered trademark of Steinberg Media Technologies GmbH/)).toBeInTheDocument();
  expect(await screen.findByText("Always scanned: /vst3")).toBeInTheDocument();
});

test("a folder added is kept on this machine and scanned from then on, until it is removed", async () => {
  show();
  await screen.findByRole("list", { name: "VST3 Plugins found" });
  fireEvent.change(screen.getByLabelText("Also scan the folder"), { target: { value: " D:\\Plugins " } });
  fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
  expect(readVst3Folders()).toEqual(["D:\\Plugins"]);
  await waitFor(() => expect(host.scanned).toEqual([[], ["D:\\Plugins"]]));

  fireEvent.click(screen.getByRole("button", { name: "Stop scanning D:\\Plugins" }));
  expect(readVst3Folders()).toEqual([]);
  await waitFor(() => expect(host.scanned.at(-1)).toEqual([]));
});

test("a VST3 Effect is loaded, then added at the Plugin's own settings, with no state until it is saved", async () => {
  const history = show();
  const effect = await addTilt(history);
  expect(effect).toMatchObject({
    type: "plugin",
    plugin: { id: "vst3.0123456789abcdef0123456789abcdef", version: "1.0.2" },
    settings: { p0: 0.5, p7: 0 },
    vst3: { name: "Tilt", vendor: "Tilters", state: { component: "", controller: "" } },
  });
  expect(host.loads).toHaveLength(1);
  expect(vst3Instance(effect.id)?.status).toBe("ready");
  // Its exposed settings are drawn as any Plugin's are.
  expect(within(chain()).getByRole("slider", { name: "Tilt" })).toBeInTheDocument();
  expect(within(chain()).getByRole("button", { name: "Open Tilt's window" })).toBeInTheDocument();

  // Undoing it unloads it.
  act(() => void history.undo());
  await waitFor(() => expect(host.unloads).toEqual([effect.id]));
});

test("one that won't load says why, and isn't added", async () => {
  const history = show();
  host.failWith = "It needs its licence";
  await waitFor(() => expect(within(chain()).getByRole("option", { name: "Tilt (VST3)" })).toBeInTheDocument());
  fireEvent.change(within(chain()).getByLabelText("Effect to add to Keys"), { target: { value: `vst3:${TILT.cid}` } });
  fireEvent.click(within(chain()).getByRole("button", { name: "Add Effect" }));
  expect(await within(chain()).findByRole("alert")).toHaveTextContent("Tilt couldn't be loaded: It needs its licence");
  expect(history.project.tracks[0]!.insertChain).toEqual([]);
});

test("a crashed Effect says the audio passes through it, and Reload starts it again", async () => {
  const history = show();
  const effect = await addTilt(history);
  host.gone = [effect.id];
  const status = await within(chain()).findByRole("status", { name: "Tilt (slot 1) VST3 Plugin" }, { timeout: 2_000 });
  expect(status).toHaveTextContent("Tilt crashed, or stopped answering, and was closed. The audio passes through it untouched");
  fireEvent.click(within(chain()).getByRole("button", { name: "Reload Tilt (slot 1)" }));
  await waitFor(() => expect(vst3Instance(effect.id)).toMatchObject({ status: "ready", generation: 2 }));
});

test("a setting turned in the Plugin's window is recorded in the Project when it is let go of", async () => {
  const history = show();
  const effect = await addTilt(history);
  host.notices = [
    [effect.id, { type: "begin", id: 0 }],
    [effect.id, { type: "edit", id: 0, value: 0.8 }],
    [effect.id, { type: "end", id: 0 }],
  ];
  await waitFor(() => expect((history.project.tracks[0]!.insertChain[0] as PluginEffect).settings.p0).toBe(0.8), { timeout: 2_000 });
  expect(history.undoLabel).not.toBeNull();
});

test("a VST3 Instrument says it is waiting while it loads, and opens its window once it has", async () => {
  host.hold = true;
  show(host, createPluginInstrument(vst3Manifest(KEYS, { kind: "instrument", settings: [] })));
  const panel = screen.getByRole("region", { name: "Keys Keys" });
  expect(await within(panel).findByText(/Waiting for Keys…/)).toBeInTheDocument();
  host.release();
  expect(await within(panel).findByRole("button", { name: "Open Keys's window" })).toBeInTheDocument();
});

test("the Browser Version keeps a VST3 Effect, says only the Desktop App hosts it, and offers none", () => {
  const tilt = { ...createPluginEffect(tiltManifest(), "fx"), settings: { p0: 0.3, p7: 1 } } as PluginEffect;
  const history = show(null, undefined, tilt);
  expect(within(chain()).getByRole("status", { name: "Tilt (slot 1) VST3 Plugin" })).toHaveTextContent(
    "Tilt (Tilters) is a VST3 Plugin, which only the Desktop App hosts. The audio passes through it untouched, and its settings and state are kept exactly.",
  );
  expect(within(chain()).queryByRole("option", { name: /VST3/ })).not.toBeInTheDocument();
  expect(history.project.tracks[0]!.insertChain[0]).toEqual(tilt);
});

test("on macOS the Desktop App keeps a VST3 Effect, says VST3 Plugins aren't supported there yet, and offers none", () => {
  const tilt = { ...createPluginEffect(tiltManifest(), "fx"), settings: { p0: 0.3, p7: 1 } } as PluginEffect;
  const history = show(null, undefined, tilt, "VST3 Plugins aren't supported on macOS yet");
  expect(within(chain()).getByRole("status", { name: "Tilt (slot 1) VST3 Plugin" })).toHaveTextContent(
    "VST3 Plugins aren't supported on macOS yet, so Tilt (Tilters) doesn't run here. The audio passes through it untouched, and its settings and state are kept exactly.",
  );
  expect(within(chain()).queryByRole("option", { name: /VST3/ })).not.toBeInTheDocument();
  // Settings says why, where the Plugins found would be listed.
  expect(screen.getByText(/^VST3 Plugins aren't supported on macOS yet\. A Project that has them opens here too/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Rescan" })).not.toBeInTheDocument();
  expect(history.project.tracks[0]!.insertChain[0]).toEqual(tilt);
});

test("on the Desktop App, one not installed on this machine is missing, and says how to bring it back", async () => {
  const other = { ...tiltManifest(), id: "vst3.00000000000000000000000000000000" };
  show(host, undefined, createPluginEffect(other, "fx") as PluginEffect);
  await screen.findByRole("list", { name: "VST3 Plugins found" });
  expect(within(chain()).getByRole("status", { name: "Tilt (slot 1) VST3 Plugin" })).toHaveTextContent(
    "Missing Plugin: Tilt (Tilters) isn't installed on this machine",
  );
  expect(host.loads).toEqual([]);
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, expect, test } from "vitest";

import { ProjectHistory } from "../project/history";
import {
  createInstrumentTrack,
  createProject,
  type InstrumentTrack,
  type PluginInstrument,
  type Project,
} from "../project/model";
import { setInstalledPlugins, type InstalledPlugin } from "../plugin/plugins";
import { memoryLibraryStorage, type LibraryStorage } from "../preset/library-storage";
import { PresetLibraryProvider } from "../preset/PresetLibraryProvider";
import { createPluginInstrument } from "./instrument-table";
import { PluginInstrumentPanel } from "./PluginInstrumentPanel";

/** The one Track's Plugin Instrument, as the history has it. */
function instrumentOf(history: ProjectHistory): PluginInstrument {
  return (history.project.tracks[0] as InstrumentTrack).instrument as PluginInstrument;
}

afterEach(() => {
  cleanup();
  setInstalledPlugins([]);
});

/** A Plugin as the Plugins folder lists it; the panel never runs its `.wasm`. */
const KEYS: InstalledPlugin = {
  manifest: {
    id: "dev.example.keys",
    version: "0.2.0",
    kind: "instrument",
    name: "Keys",
    settings: [
      { name: "level", label: "Level", unit: "", min: 0, max: 1, default: 0.5, step: 0, choices: [] },
      { name: "attack", label: "Attack", unit: "ms", min: 0, max: 500, default: 10, step: 0, choices: [] },
    ],
  },
  wasm: new Uint8Array(),
};

/** The panel wired to a real history, as the Song page wires it, over the Preset library in `storage` if one is given. */
function show(storage?: LibraryStorage): ProjectHistory {
  const start: Project = createProject("Demo");
  const track = createInstrumentTrack("Keys", "keys");
  track.instrument = createPluginInstrument(KEYS.manifest);
  start.tracks.push(track);
  const history = new ProjectHistory(start);
  function Harness() {
    const project = useSyncExternalStore(
      (listener) => history.subscribe(listener),
      () => history.project,
    );
    const shown = project.tracks[0] as InstrumentTrack;
    return (
      <PluginInstrumentPanel
        trackId={shown.id}
        trackName={shown.name}
        instrument={shown.instrument as PluginInstrument}
        onChange={(settings) => history.execute({ type: "setInstrumentSettings", trackId: shown.id, settings })}
      />
    );
  }
  render(
    storage ? (
      <PresetLibraryProvider storage={storage}>
        <Harness />
      </PresetLibraryProvider>
    ) : (
      <Harness />
    ),
  );
  return history;
}

test("an installed Plugin Instrument has a control for each setting it declares", () => {
  setInstalledPlugins([KEYS]);
  const history = show();
  expect(screen.getByRole("region", { name: "Keys Keys" })).toBeInTheDocument();
  expect(instrumentOf(history)).toEqual({
    type: "plugin",
    plugin: { id: "dev.example.keys", version: "0.2.0" },
    settings: { level: 0.5, attack: 10 },
  });
  fireEvent.change(screen.getByLabelText("Level"), { target: { value: "0.8" } });
  expect(instrumentOf(history).settings).toEqual({ level: 0.8, attack: 10 });
  expect(screen.getByLabelText("Attack")).toBeInTheDocument();
});

test("a Plugin Instrument whose Plugin isn't installed says so, keeps its settings, and comes back when installed", () => {
  setInstalledPlugins([KEYS]);
  const history = show();
  fireEvent.change(screen.getByLabelText("Level"), { target: { value: "0.8" } });
  const settings = instrumentOf(history).settings;

  act(() => setInstalledPlugins([]));
  const status = screen.getByRole("status", { name: "Keys missing Plugin" });
  expect(status).toHaveTextContent("Missing Plugin: dev.example.keys 0.2.0 isn't installed");
  expect(screen.queryByLabelText("Level")).not.toBeInTheDocument();
  expect(instrumentOf(history).settings).toEqual(settings);

  act(() => setInstalledPlugins([KEYS]));
  expect(screen.queryByRole("status", { name: /missing Plugin/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Level")).toHaveValue("0.8");
});

function dialog(): HTMLElement {
  const open = document.querySelector<HTMLElement>("dialog[open]");
  if (!open) throw new Error("No dialog is open");
  return open;
}

test("a Plugin Instrument's settings saved as a User Preset load into another Project, as one undo", async () => {
  setInstalledPlugins([KEYS]);
  const library = memoryLibraryStorage();

  show(library);
  fireEvent.change(screen.getByLabelText("Level"), { target: { value: "0.8" } });
  fireEvent.change(screen.getByLabelText("Attack"), { target: { value: "250" } });
  fireEvent.click(screen.getByRole("button", { name: "Save preset for Keys Keys" }));
  fireEvent.change(within(dialog()).getByLabelText("Preset name"), { target: { value: "Soft" } });
  fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(document.querySelector("dialog[open]")).toBeNull());
  cleanup();

  // Another Project, over the same library: the Preset is listed, and loads whole.
  const second = show(library);
  const picker = screen.getByLabelText("Keys Keys preset");
  await waitFor(() => expect(within(picker).getByRole("option", { name: "Soft" })).toBeInTheDocument());
  fireEvent.change(picker, { target: { value: "Soft" } });
  expect(instrumentOf(second).settings).toEqual({ level: 0.8, attack: 250 });
  expect(second.undo()).toBe(true);
  expect(instrumentOf(second).settings).toEqual({ level: 0.5, attack: 10 });
  expect(second.canUndo).toBe(false);

  // Renamed and deleted from its list, as the Synth's are.
  fireEvent.click(screen.getByRole("button", { name: "Manage Keys Keys presets" }));
  fireEvent.click(within(dialog()).getByRole("button", { name: "Rename Soft" }));
  fireEvent.change(within(dialog()).getByLabelText("New name for Soft"), { target: { value: "Gentle" } });
  fireEvent.click(within(dialog()).getByRole("button", { name: "Rename" }));
  await waitFor(() => expect(within(picker).getByRole("option", { name: "Gentle" })).toBeInTheDocument());
  fireEvent.click(within(dialog()).getByRole("button", { name: "Delete Gentle" }));
  await waitFor(() => expect(within(picker).queryByRole("option", { name: "Gentle" })).not.toBeInTheDocument());
});

test("a Plugin Instrument whose Plugin is missing has no Presets to load or save", () => {
  const history = show(memoryLibraryStorage());
  expect(instrumentOf(history).plugin.id).toBe("dev.example.keys");
  expect(screen.queryByLabelText("Keys dev.example.keys preset")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Save preset/ })).not.toBeInTheDocument();
});

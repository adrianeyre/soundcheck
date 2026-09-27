// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { initSync } from "@engine";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import { defaultEffectSettings } from "../effect/effect-params";
import { InsertChainPanel } from "../effect/InsertChainPanel";
import type { Command } from "../project/commands";
import { ProjectHistory } from "../project/history";
import { createEffect, createProject, type Effect, type InstrumentTrack } from "../project/model";
import { SongPage } from "../song/SongPage";
import { memoryLibraryStorage, type LibraryStorage } from "./library-storage";
import { PresetLibraryProvider } from "./PresetLibraryProvider";

afterEach(cleanup);

beforeAll(() => {
  initSync({ module: readFileSync(resolvePath(import.meta.dirname, "../../../engine/pkg/soundcheck_engine_bg.wasm")) });
});

/** One session of the app: a Project on the Song page, over the library in `storage`. */
function session(storage: LibraryStorage) {
  const history = new ProjectHistory(createProject("Song"));
  render(
    <PresetLibraryProvider storage={storage}>
      <SongPage history={history} openOutput={() => new Promise(() => {})} />
    </PresetLibraryProvider>,
  );
  fireEvent.click(button("Add Instrument Track"));
  // Its Synth's panel shows once a Pattern Clip on it is chosen.
  fireEvent.click(button("Add Pattern Clip"));
  const synth = () => {
    const instrument = (history.project.tracks[0] as InstrumentTrack).instrument;
    if (instrument.type !== "synth") throw new Error("a Synth Track");
    return instrument;
  };
  return { history, synth };
}

// The Song page's grid has hundreds of cells, and role queries over that many
// are slow, so buttons are found by their accessible name directly, and the
// rest within the open dialog.
function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim() === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

function dialog(): HTMLElement {
  const open = document.querySelector<HTMLElement>("dialog[open]");
  if (!open) throw new Error("No dialog is open");
  return open;
}

function userOptions(select: HTMLElement): string[] {
  const group = select.querySelector('optgroup[label="User presets"]');
  return group ? [...group.querySelectorAll("option")].map((option) => option.value) : [];
}

async function savePreset(what: string, name: string) {
  fireEvent.click(button(`Save preset for ${what}`));
  fireEvent.change(within(dialog()).getByLabelText("Preset name"), { target: { value: name } });
  fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(document.querySelector("dialog[open]")).toBeNull());
}

test("a User Preset saved in one Project loads into another, listed after the Factory ones", async () => {
  const library = memoryLibraryStorage();

  const first = session(library);
  act(() => {
    first.history.execute({
      type: "setSynthSettings",
      trackId: first.history.project.tracks[0]!.id,
      settings: { cutoffHz: 1500, osc2Wave: "square" },
    });
  });
  await savePreset("Synth 1 Synth", "Night Lead");
  const saved = first.synth().settings;
  expect(userOptions(screen.getByLabelText("Synth 1 preset"))).toEqual(["Night Lead"]);
  cleanup();

  // The app again, with a new Project: the library is read afresh.
  const second = session(library);
  const picker = screen.getByLabelText("Synth 1 preset");
  await waitFor(() => expect(userOptions(picker)).toEqual(["Night Lead"]));
  expect(picker.querySelector('optgroup[label="bass"]')).not.toBeNull();
  fireEvent.change(picker, { target: { value: "Night Lead" } });
  expect(second.synth()).toEqual({ type: "synth", preset: "Night Lead", settings: saved });
  // Loading it is one undo step, as a Factory Preset's is.
  expect(second.history.undoLabel).toBe("Load Synth preset");
});

test("User Presets are renamed and deleted; Factory Presets can't be changed", async () => {
  session(memoryLibraryStorage());
  await savePreset("Synth 1 Synth", "Mine");
  // A Factory Preset's name can't be saved over.
  fireEvent.click(button("Save preset for Synth 1 Synth"));
  fireEvent.change(within(dialog()).getByLabelText("Preset name"), { target: { value: "Sub Bass" } });
  fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
  expect(await within(dialog()).findByRole("alert")).toHaveTextContent("Factory Presets can't be changed");
  fireEvent.click(within(dialog()).getByRole("button", { name: "Close without saving" }));

  fireEvent.click(button("Manage Synth 1 Synth presets"));
  const list = within(dialog()).getByRole("list", { name: "Synth presets" });
  const factory = within(list).getByText("Sub Bass").closest("li")!;
  expect(factory).toHaveTextContent("Factory");
  expect(within(factory).queryByRole("button")).toBeNull();

  fireEvent.click(within(list).getByRole("button", { name: "Rename Mine" }));
  fireEvent.change(within(list).getByLabelText("New name for Mine"), { target: { value: "Yours" } });
  fireEvent.click(within(list).getByRole("button", { name: "Rename" }));
  await waitFor(() => expect(within(list).getByText("Yours").closest("li")).toHaveTextContent("User"));
  expect(userOptions(screen.getByLabelText("Synth 1 preset"))).toEqual(["Yours"]);

  fireEvent.click(within(list).getByRole("button", { name: "Delete Yours" }));
  await waitFor(() => expect(within(list).queryByText("Yours")).toBeNull());
  expect(userOptions(screen.getByLabelText("Synth 1 preset"))).toEqual([]);
});

test("any Effect saves its settings as a User Preset and loads one in a single command", async () => {
  const onCommand = vi.fn<(command: Command) => void>();
  const eq: Effect = { id: "eq-1", type: "eq", bypassed: false, settings: { ...defaultEffectSettings("eq"), lowShelfGainDb: 6 } };
  render(
    <PresetLibraryProvider storage={memoryLibraryStorage()}>
      <InsertChainPanel name="Band" target={{ busId: "band" }} chain={[eq, createEffect("eq", "eq-2")]} onCommand={onCommand} />
    </PresetLibraryProvider>,
  );
  await savePreset("EQ (slot 1)", "Warm");
  const picker = screen.getByLabelText("EQ (slot 2) preset");
  expect(userOptions(picker)).toEqual(["Warm"]);
  fireEvent.change(picker, { target: { value: "Warm" } });
  expect(onCommand).toHaveBeenCalledWith({ type: "setEffectSettings", effectId: "eq-2", settings: eq.settings });
});

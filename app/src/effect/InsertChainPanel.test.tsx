// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, expect, test } from "vitest";

import { Mixer } from "../mixer/Mixer";
import { ProjectHistory } from "../project/history";
import { createInstrumentTrack, createProject, type Project } from "../project/model";
import { setInstalledPlugins, type InstalledPlugin } from "../plugin/plugins";
import { effectParams } from "./effect-params";
import { effectPreset } from "./effect-presets";

afterEach(() => {
  cleanup();
  setInstalledPlugins([]);
});

/** A Plugin as the Plugins folder lists it; the panel never runs its `.wasm`. */
const DRIVE: InstalledPlugin = {
  manifest: {
    id: "dev.example.drive",
    version: "1.0.0",
    kind: "effect",
    name: "Drive",
    settings: [
      { name: "amount", label: "Amount", unit: "", min: 0, max: 1, default: 0.25, step: 0, choices: [] },
      { name: "tone", label: "Tone", unit: "Hz", min: 200, max: 8000, default: 2000, step: 0, choices: [] },
    ],
  },
  wasm: new Uint8Array(),
};

/** The Mixer wired to a real history, as the Song page wires it. */
function show(): ProjectHistory {
  const start: Project = createProject("Demo");
  start.tracks.push(createInstrumentTrack("Bass", "bass"));
  const history = new ProjectHistory(start);
  function Harness() {
    const project = useSyncExternalStore(
      (listener) => history.subscribe(listener),
      () => history.project,
    );
    return (
      <Mixer
        project={project}
        meters={null}
        onTrackMixer={() => {}}
        onMasterVolume={() => {}}
        onCommand={(command) => history.execute(command)}
      />
    );
  }
  render(<Harness />);
  return history;
}

function add(chain: string, effect: string) {
  const panel = screen.getByRole("region", { name: `${chain} Insert Chain` });
  fireEvent.change(within(panel).getByLabelText(`Effect to add to ${chain}`), { target: { value: effect } });
  fireEvent.click(within(panel).getByRole("button", { name: "Add Effect" }));
}

function slots(chain: string): string[] {
  const panel = screen.getByRole("region", { name: `${chain} Insert Chain` });
  return within(panel)
    .queryAllByRole("listitem")
    .map((item) => item.getAttribute("aria-label")!);
}

test("each channel's FX button opens its Insert Chain, where Effects are added in order", () => {
  const history = show();
  fireEvent.click(screen.getByRole("button", { name: /: Bass Insert Chain$/ }));
  expect(screen.getByText(/No Effects/)).toBeInTheDocument();
  add("Bass", "eq");
  add("Bass", "reverb");
  expect(slots("Bass")).toEqual(["EQ (slot 1)", "Reverb (slot 2)"]);
  expect(history.project.tracks[0]!.insertChain.map((effect) => effect.type)).toEqual(["eq", "reverb"]);
  expect(screen.getByRole("button", { name: /: Bass Insert Chain$/ })).toHaveTextContent("FX (2)");

  fireEvent.click(screen.getByRole("button", { name: /: Master Insert Chain$/ }));
  expect(screen.queryByRole("region", { name: "Bass Insert Chain" })).not.toBeInTheDocument();
  add("Master", "compressor");
  expect(history.project.master.insertChain.map((effect) => effect.type)).toEqual(["compressor"]);
});

test("every setting its table declares has a control, and moving one changes the Project", () => {
  const history = show();
  fireEvent.click(screen.getByRole("button", { name: /: Bass Insert Chain$/ }));
  add("Bass", "eq");
  const slot = screen.getByRole("listitem", { name: "EQ (slot 1)" });
  for (const param of effectParams("eq")) expect(within(slot).getByLabelText(param.label)).toBeInTheDocument();

  const curve = within(slot).getByTestId("eq-curve");
  const flat = curve.getAttribute("d");
  fireEvent.change(within(slot).getByLabelText("Band 2 gain"), { target: { value: "9" } });
  fireEvent.change(within(slot).getByLabelText("High cut"), { target: { value: "on" } });
  const eq = history.project.tracks[0]!.insertChain[0]!;
  expect(eq.settings).toMatchObject({ band2GainDb: 9, highCut: "on" });
  // The curve follows the settings.
  expect(within(slot).getByTestId("eq-curve").getAttribute("d")).not.toBe(flat);
});

test("Effects move, bypass and go, and every edit undoes", () => {
  const history = show();
  fireEvent.click(screen.getByRole("button", { name: /: Bass Insert Chain$/ }));
  add("Bass", "eq");
  add("Bass", "compressor");
  add("Bass", "reverb");
  const built = history.project;

  fireEvent.click(screen.getByRole("button", { name: "Move Reverb (slot 3) up" }));
  expect(slots("Bass")).toEqual(["EQ (slot 1)", "Reverb (slot 2)", "Compressor (slot 3)"]);
  fireEvent.click(screen.getByRole("button", { name: "Move EQ (slot 1) down" }));
  expect(slots("Bass")).toEqual(["Reverb (slot 1)", "EQ (slot 2)", "Compressor (slot 3)"]);
  expect(screen.getByRole("button", { name: "Move Reverb (slot 1) up" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Bypass EQ (slot 2)" }));
  expect(screen.getByRole("button", { name: "Bypass EQ (slot 2)" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Remove Compressor (slot 3)" }));
  expect(slots("Bass")).toEqual(["Reverb (slot 1)", "EQ (slot 2)"]);

  // Four edits, four undos, back to the chain as it was built.
  act(() => {
    for (let step = 0; step < 4; step++) expect(history.undo()).toBe(true);
  });
  expect(history.project).toEqual(built);
  expect(slots("Bass")).toEqual(["EQ (slot 1)", "Compressor (slot 2)", "Reverb (slot 3)"]);
  // And the adds undo too, down to the empty chain the Track started with.
  act(() => {
    for (let step = 0; step < 3; step++) history.undo();
  });
  expect(history.project.tracks[0]!.insertChain).toEqual([]);
});

test("a Delay loads a factory preset in one undoable step, and greys out the time it isn't using", () => {
  const history = show();
  fireEvent.click(screen.getByRole("button", { name: /: Bass Insert Chain$/ }));
  add("Bass", "delay");
  const slot = screen.getByRole("listitem", { name: "Delay (slot 1)" });
  for (const param of effectParams("delay")) expect(within(slot).getByLabelText(param.label)).toBeInTheDocument();
  // Synced to the tempo by default, so the milliseconds do nothing.
  expect(within(slot).getByLabelText("Time")).toBeDisabled();
  expect(within(slot).getByLabelText("Note value")).toBeEnabled();

  const picker = within(slot).getByLabelText("Delay (slot 1) preset");
  expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual([
    "Load a preset…",
    "Slapback",
    "Quarter echo",
    "Dotted-eighth ping-pong",
  ]);
  const added = history.project;
  fireEvent.change(picker, { target: { value: "Slapback" } });
  const delay = history.project.tracks[0]!.insertChain[0]!;
  expect(delay.settings).toEqual(effectPreset("delay", "Slapback")!.settings);
  expect(within(slot).getByLabelText("Time")).toBeEnabled();
  expect(within(slot).getByLabelText("Note value")).toBeDisabled();

  act(() => {
    expect(history.undo()).toBe(true);
  });
  expect(history.project).toEqual(added);
});

test("an installed Plugin Effect is added like a built-in, with a control for each setting it declares", () => {
  setInstalledPlugins([DRIVE]);
  const history = show();
  fireEvent.click(screen.getByRole("button", { name: /: Bass Insert Chain$/ }));
  add("Bass", "plugin:dev.example.drive");
  expect(slots("Bass")).toEqual(["Drive (slot 1)"]);
  const effect = history.project.tracks[0]!.insertChain[0]!;
  expect(effect).toMatchObject({ type: "plugin", plugin: { id: "dev.example.drive", version: "1.0.0" } });
  expect(effect.settings).toEqual({ amount: 0.25, tone: 2000 });

  const slot = screen.getByRole("listitem", { name: "Drive (slot 1)" });
  fireEvent.change(within(slot).getByLabelText("Amount"), { target: { value: "0.8" } });
  expect(history.project.tracks[0]!.insertChain[0]!.settings).toEqual({ amount: 0.8, tone: 2000 });
  expect(within(slot).getByLabelText("Tone")).toBeInTheDocument();
});

test("a Plugin Effect whose Plugin isn't installed says so, keeps its settings, and comes back when installed", () => {
  setInstalledPlugins([DRIVE]);
  const history = show();
  fireEvent.click(screen.getByRole("button", { name: /: Bass Insert Chain$/ }));
  add("Bass", "plugin:dev.example.drive");
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.8" } });
  const settings = history.project.tracks[0]!.insertChain[0]!.settings;

  act(() => setInstalledPlugins([]));
  const status = screen.getByRole("status", { name: "dev.example.drive (slot 1) missing Plugin" });
  expect(status).toHaveTextContent("Missing Plugin: dev.example.drive 1.0.0 isn't installed");
  expect(screen.queryByLabelText("Amount")).not.toBeInTheDocument();
  expect(history.project.tracks[0]!.insertChain[0]!.settings).toEqual(settings);

  act(() => setInstalledPlugins([DRIVE]));
  expect(screen.queryByRole("status", { name: /missing Plugin/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Amount")).toHaveValue("0.8");
});

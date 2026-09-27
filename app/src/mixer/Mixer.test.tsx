// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { applyCommand, type Command } from "../project/commands";
import { type Meters } from "../audio/audio-output";
import {
  createAudioTrack,
  createBus,
  createEffect,
  createInstrumentTrack,
  createProject,
  type Project,
} from "../project/model";
import { Mixer, type MixerProps } from "./Mixer";

afterEach(cleanup);

function project(): Project {
  let current = createProject("Demo");
  for (const name of ["Bass", "Lead"]) {
    const result = applyCommand(current, { type: "addTrack", track: createInstrumentTrack(name) });
    if (!result.ok) throw new Error(result.error);
    current = result.project;
  }
  return current;
}

function show(overrides: { project?: Project; meters?: Meters } = {}) {
  const onTrackMixer = vi.fn<MixerProps["onTrackMixer"]>();
  const onMasterVolume = vi.fn<MixerProps["onMasterVolume"]>();
  const onCommand = vi.fn<MixerProps["onCommand"]>();
  const shown = overrides.project ?? project();
  render(
    <Mixer
      project={shown}
      meters={overrides.meters ?? null}
      onTrackMixer={onTrackMixer}
      onMasterVolume={onMasterVolume}
      onCommand={onCommand}
    />,
  );
  return { project: shown, onTrackMixer, onMasterVolume, onCommand };
}

/** The Mixer on a Project its commands really change, as the Song page has it. */
function Live({ start, errors }: { start: Project; errors: string[] }) {
  const [current, setCurrent] = useState(start);
  const execute = (command: Command) => {
    const result = applyCommand(current, command);
    if (result.ok) setCurrent(result.project);
    else errors.push(result.error);
  };
  return (
    <Mixer
      project={current}
      meters={null}
      onTrackMixer={(trackId, mixer) => execute({ type: "setTrackMixer", trackId, mixer })}
      onMasterVolume={(volume) => execute({ type: "setMasterVolume", volume })}
      onCommand={execute}
    />
  );
}

/** Bass and Lead, and a Bus called Band. */
function withBus(): Project {
  const shown = project();
  shown.buses.push(createBus("Band", "band"));
  return shown;
}

test("there is a channel per Track and one for the Master", () => {
  show();
  expect(screen.getByLabelText("Bass volume")).toBeInTheDocument();
  expect(screen.getByLabelText("Lead volume")).toBeInTheDocument();
  expect(screen.getByLabelText("Master volume")).toBeInTheDocument();
  // The Master goes nowhere else, so it has no pan, mute or solo.
  expect(screen.queryByLabelText("Master pan")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Mute Master")).not.toBeInTheDocument();
});

test("the controls send the Project's own commands", () => {
  const { project: shown, onTrackMixer, onMasterVolume } = show();
  const [bass] = shown.tracks;

  fireEvent.change(screen.getByLabelText("Bass volume"), { target: { value: "0.5" } });
  expect(onTrackMixer).toHaveBeenCalledWith(bass!.id, { volume: 0.5 });

  fireEvent.change(screen.getByLabelText("Bass pan"), { target: { value: "-1" } });
  expect(onTrackMixer).toHaveBeenCalledWith(bass!.id, { pan: -1 });

  fireEvent.click(screen.getByLabelText("Mute Bass"));
  expect(onTrackMixer).toHaveBeenCalledWith(bass!.id, { mute: true });

  fireEvent.click(screen.getByLabelText("Solo Bass"));
  expect(onTrackMixer).toHaveBeenCalledWith(bass!.id, { solo: true });

  fireEvent.change(screen.getByLabelText("Master volume"), { target: { value: "1.5" } });
  expect(onMasterVolume).toHaveBeenCalledWith(1.5);
});

test("mute and solo show what is on, and soloing dims the Tracks it silences", () => {
  const started = project();
  const soloed = applyCommand(started, {
    type: "setTrackMixer",
    trackId: started.tracks[1]!.id,
    mixer: { solo: true },
  });
  if (!soloed.ok) throw new Error(soloed.error);
  show({ project: soloed.project });

  expect(screen.getByLabelText("Solo Lead")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("Solo Bass")).toHaveAttribute("aria-pressed", "false");
  // The Bass isn't soloed while the Lead is, so it isn't in the mix.
  expect(screen.getByLabelText("Bass volume").closest("div")?.parentElement).toHaveStyle({ opacity: "0.5" });
});

test("soloing an Audio Track dims the Instrument Tracks it silences, and its meter is its own", () => {
  // The engine plays Audio Tracks too, in Track-list order, so a solo on one
  // silences the rest and the meters line up with the Track list.
  const started = applyCommand(project(), { type: "addTrack", track: createAudioTrack("Take 1") });
  if (!started.ok) throw new Error(started.error);
  const soloed = applyCommand(started.project, {
    type: "setTrackMixer",
    trackId: started.project.tracks.at(-1)!.id,
    mixer: { solo: true },
  });
  if (!soloed.ok) throw new Error(soloed.error);
  show({ project: soloed.project, meters: { master: 0.5, tracks: [0, 0, 0.5] } });

  expect(screen.getByLabelText("Solo Take 1")).toHaveAttribute("aria-pressed", "true");
  for (const name of ["Bass", "Lead"]) {
    expect(screen.getByLabelText(`${name} volume`).closest("div")?.parentElement).toHaveStyle({ opacity: "0.5" });
  }
  expect(screen.getByLabelText("Take 1 volume").closest("div")?.parentElement).toHaveStyle({ opacity: "1" });
  expect(screen.getByLabelText("Take 1 level")).toHaveAttribute("aria-valuetext", "-6.0 dB");
});

test("the meters show the levels the engine measured, and nothing when it isn't running", () => {
  const meters = { master: 1, tracks: [0.5, 0] };
  show({ meters });

  // Full scale is the top of the scale; half scale is -6 dB of 60.
  expect(screen.getByLabelText("Master level")).toHaveAttribute("aria-valuenow", "1");
  expect(screen.getByLabelText("Master level")).toHaveAttribute("aria-valuetext", "0.0 dB, clipping");
  expect(screen.getByLabelText("Bass level")).toHaveAttribute("aria-valuetext", "-6.0 dB");
  expect(screen.getByLabelText("Lead level")).toHaveAttribute("aria-valuetext", "-∞ dB");

  cleanup();
  show();
  expect(screen.getByLabelText("Master level")).toHaveAttribute("aria-valuenow", "0");
});

test("a Compressor's Insert Chain shows the gain reduction the engine measured, on a Track or the Master", () => {
  const shown = project();
  shown.tracks[1]!.insertChain.push(createEffect("eq", "lead-eq"), createEffect("compressor", "lead-comp"));
  shown.master.insertChain.push(createEffect("compressor", "master-comp"));
  const meters: Meters = {
    master: 0.5,
    tracks: [0, 0.5],
    gainReduction: { master: [3.5], tracks: [[], [0, 6.5]] },
  };
  show({ project: shown, meters });

  fireEvent.click(screen.getByRole("button", { name: /: Lead Insert Chain$/ }));
  const lead = screen.getByRole("meter", { name: "Compressor (slot 2) gain reduction" });
  expect(lead).toHaveAttribute("aria-valuetext", "6.5 dB");
  expect(screen.queryByRole("meter", { name: "EQ (slot 1) gain reduction" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /: Master Insert Chain$/ }));
  expect(screen.getByRole("meter", { name: "Compressor (slot 1) gain reduction" })).toHaveAttribute(
    "aria-valuetext",
    "3.5 dB",
  );

  // With no audio running, the meter rests at nothing.
  cleanup();
  show({ project: shown });
  fireEvent.click(screen.getByRole("button", { name: /: Master Insert Chain$/ }));
  expect(screen.getByRole("meter", { name: "Compressor (slot 1) gain reduction" })).toHaveAttribute(
    "aria-valuenow",
    "0",
  );
});

test("a Bus is added, and gets a channel strip of its own before the Master's", () => {
  const { onCommand } = show();
  fireEvent.click(screen.getByRole("button", { name: "Add Bus" }));
  expect(onCommand).toHaveBeenCalledWith({ type: "addBus", bus: expect.objectContaining({ name: "Bus 1", output: null }) });

  cleanup();
  render(<Live start={project()} errors={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Add Bus" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Bus" }));
  const names = screen.getAllByRole("textbox").map((input) => (input as HTMLInputElement).value);
  expect(names).toEqual(["Bus 1", "Bus 2"]);
  const strips = screen.getAllByRole("slider", { name: / volume$/ }).map((slider) => slider.getAttribute("aria-label"));
  expect(strips).toEqual(["Bass volume", "Lead volume", "Bus 1 volume", "Bus 2 volume", "Master volume"]);
});

test("a Bus's controls send the Bus's own commands, and its meter is the engine's", () => {
  const { onCommand } = show({ project: withBus(), meters: { master: 0.5, tracks: [0, 0], buses: [0.5] } });
  expect(screen.getByLabelText("Band level")).toHaveAttribute("aria-valuetext", "-6.0 dB");

  fireEvent.change(screen.getByLabelText("Band volume"), { target: { value: "0.5" } });
  expect(onCommand).toHaveBeenLastCalledWith({ type: "setBusMixer", busId: "band", mixer: { volume: 0.5 } });
  fireEvent.change(screen.getByLabelText("Band pan"), { target: { value: "1" } });
  expect(onCommand).toHaveBeenLastCalledWith({ type: "setBusMixer", busId: "band", mixer: { pan: 1 } });
  fireEvent.click(screen.getByLabelText("Mute Band"));
  expect(onCommand).toHaveBeenLastCalledWith({ type: "setBusMixer", busId: "band", mixer: { mute: true } });
  fireEvent.click(screen.getByLabelText("Solo Band"));
  expect(onCommand).toHaveBeenLastCalledWith({ type: "setBusMixer", busId: "band", mixer: { solo: true } });

  const name = screen.getByLabelText("Band name");
  fireEvent.change(name, { target: { value: "Drums" } });
  fireEvent.keyDown(name, { key: "Enter" });
  expect(onCommand).toHaveBeenLastCalledWith({ type: "renameBus", busId: "band", name: "Drums" });

  fireEvent.click(screen.getByRole("button", { name: "Delete Band" }));
  expect(onCommand).toHaveBeenLastCalledWith({ type: "deleteBus", busId: "band" });
});

test("each Track and Bus picks its output, and a Bus that would loop can't be picked", () => {
  const shown = withBus();
  shown.buses.push({ ...createBus("Drums", "drums"), output: "band" });
  const { onCommand } = show({ project: shown });

  fireEvent.change(screen.getByLabelText("Bass output"), { target: { value: "drums" } });
  expect(onCommand).toHaveBeenLastCalledWith({ type: "setTrackOutput", trackId: shown.tracks[0]!.id, output: "drums" });
  fireEvent.change(screen.getByLabelText("Drums output"), { target: { value: "" } });
  expect(onCommand).toHaveBeenLastCalledWith({ type: "setBusOutput", busId: "drums", output: null });

  // Band can't feed Drums, which feeds it, nor itself; Drums feeds Band now.
  const band = screen.getByLabelText("Band output");
  expect([...band.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Master", "Drums (would loop)"]);
  expect(band.querySelector('option[value="drums"]')).toBeDisabled();
  expect(band.querySelector('option[value="drums"]')).toHaveAttribute(
    "title",
    "Band can't feed Drums: the signal would go round in a loop (Band → Drums → Band)",
  );
  expect(screen.getByLabelText("Drums output")).toHaveValue("band");
});

test("deleting a Bus sends what fed it to the Master, and muting one dims what feeds it", () => {
  const start = withBus();
  start.tracks[0]!.output = "band";
  start.buses[0]!.mixer.mute = true;
  const errors: string[] = [];
  render(<Live start={start} errors={errors} />);
  expect(screen.getByLabelText("Bass volume").closest("div")?.parentElement).toHaveStyle({ opacity: "0.5" });
  expect(screen.getByLabelText("Lead volume").closest("div")?.parentElement).toHaveStyle({ opacity: "1" });

  fireEvent.click(screen.getByRole("button", { name: "Delete Band" }));
  expect(screen.queryByLabelText("Band volume")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Bass output")).toHaveValue("");
  expect(screen.getByLabelText("Bass volume").closest("div")?.parentElement).toHaveStyle({ opacity: "1" });
  expect(errors).toEqual([]);
});

test("a Bus's Insert Chain opens like any other, with its Compressor's gain reduction", () => {
  const shown = withBus();
  shown.buses[0]!.insertChain.push(createEffect("compressor", "band-comp"));
  const meters: Meters = {
    master: 0,
    tracks: [0, 0],
    buses: [0],
    gainReduction: { master: [], tracks: [[], []], buses: [[4]] },
  };
  const { onCommand } = show({ project: shown, meters });
  fireEvent.click(screen.getByRole("button", { name: /: Band Insert Chain$/ }));
  expect(screen.getByRole("meter", { name: "Compressor (slot 1) gain reduction" })).toHaveAttribute("aria-valuetext", "4.0 dB");
  fireEvent.click(screen.getByRole("button", { name: "Add Effect" }));
  expect(onCommand).toHaveBeenLastCalledWith({ type: "addEffect", target: { busId: "band" }, effect: expect.anything() });
});

test("a strip says which of its settings are automated", () => {
  const shown = project();
  const point = [{ tick: 0, value: 0.5, hold: false }];
  shown.tracks[1]!.automation = [{ setting: "pan", breakpoints: point }];
  shown.master.automation = [{ setting: "volume", breakpoints: point }];
  show({ project: shown });
  const automated = screen.getAllByText("Automated");
  expect(automated).toHaveLength(2);
  expect(automated[0]!.closest("label")).toContainElement(screen.getByLabelText("Lead pan"));
  expect(automated[1]!.closest(".strip")).toContainElement(screen.getByLabelText("Master volume"));
});

test("a Bus's automated settings and an automated Send's level say so too", () => {
  const shown = withBus();
  const point = [{ tick: 0, value: 0.5, hold: false }];
  shown.tracks[0]!.sends = [{ busId: "band", level: 1 }];
  shown.tracks[0]!.automation = [{ setting: "send:band", breakpoints: point }];
  shown.buses[0]!.automation = [{ setting: "volume", breakpoints: point }];
  show({ project: shown });
  const automated = screen.getAllByText("Automated");
  expect(automated).toHaveLength(2);
  expect(automated[0]!.closest(".param")).toContainElement(screen.getByLabelText("Bass Send to Band level"));
  expect(automated[1]!.closest(".strip")).toContainElement(screen.getByLabelText("Band volume"));
});

test("a Track or Bus adds a Send to a Bus, sets its level after the fader and removes it", () => {
  const shown = withBus();
  shown.buses.push(createBus("Reverb", "reverb"));
  const errors: string[] = [];
  render(<Live start={shown} errors={errors} />);

  fireEvent.change(screen.getByLabelText("Bass add Send"), { target: { value: "reverb" } });
  const level = screen.getByLabelText("Bass Send to Reverb level");
  expect(level).toHaveValue("1");
  expect(level).toHaveAttribute("aria-valuetext", "0.0 dB");
  fireEvent.change(level, { target: { value: "0.5" } });
  expect(screen.getByLabelText("Bass Send to Reverb level")).toHaveAttribute("aria-valuetext", "-6.0 dB");

  // A Bus sends to another Bus, and then that one can't send back.
  fireEvent.change(screen.getByLabelText("Band add Send"), { target: { value: "reverb" } });
  const reverb = screen.getByLabelText("Reverb add Send");
  expect([...reverb.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
    "Add Send…",
    "Band (would loop)",
  ]);
  expect(reverb.querySelector('option[value="band"]')).toBeDisabled();
  expect(reverb.querySelector('option[value="band"]')).toHaveAttribute(
    "title",
    "Reverb can't send to Band: the signal would go round in a loop (Reverb → Band → Reverb)",
  );
  // Nor does Bass send twice to one Bus.
  const bass = screen.getByLabelText("Bass add Send");
  expect(bass.querySelector('option[value="reverb"]')).toBeDisabled();
  expect(bass.querySelector('option[value="reverb"]')).toHaveAttribute("title", "Bass already sends to Reverb");

  fireEvent.click(screen.getByRole("button", { name: "Remove Bass Send to Reverb" }));
  expect(screen.queryByLabelText("Bass Send to Reverb level")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Band Send to Reverb level")).toBeInTheDocument();
  expect(errors).toEqual([]);
});

test("the Master has no Sends, and with no Bus there is nothing to send to", () => {
  show();
  expect(screen.queryByLabelText("Master add Send")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Bass add Send")).not.toBeInTheDocument();
});

test("a Send's level control sends the Project's command", () => {
  const shown = withBus();
  shown.tracks[1]!.sends.push({ busId: "band", level: 0.25 });
  const { onCommand } = show({ project: shown });
  fireEvent.change(screen.getByLabelText("Lead Send to Band level"), { target: { value: "0.75" } });
  expect(onCommand).toHaveBeenLastCalledWith({
    type: "setSendLevel",
    from: { trackId: shown.tracks[1]!.id },
    busId: "band",
    level: 0.75,
  });
});

const strips = () => [...document.querySelectorAll(".strip")].map((strip) => strip.querySelector("input, .strip-name")!);
const stripNames = () => strips().map((name) => (name instanceof HTMLInputElement ? name.value : name.textContent));

test("a Bus's strip moves left and right among the Buses, and the Master stays last", () => {
  const start = withBus();
  start.buses.push(createBus("Verb", "verb"));
  render(<Live start={start} errors={[]} />);
  expect(screen.getByRole("button", { name: "Move Band left" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Move Verb right" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Move Band right" }));
  expect(stripNames().slice(-3)).toEqual(["Verb", "Band", "Master"]);
});

const stripOf = (label: string) => screen.getByLabelText(label).closest(".strip")!;

test("each Track's strip has its kind's stripe; a Bus's and the Master's have none", () => {
  const start = withBus();
  render(<Live start={start} errors={[]} />);
  expect(stripOf("Bass volume")).toHaveAttribute("data-track-kind", "instrument");
  expect(stripOf("Band volume")).not.toHaveAttribute("data-track-kind");
  expect(stripOf("Master volume")).not.toHaveAttribute("data-track-kind");
});

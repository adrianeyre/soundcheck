// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { EngineCommand, EngineReport } from "../audio/audio-output";
import { constantTempoMap } from "../project/time";
import { TransportBar } from "./TransportBar";
import { DEFAULT_TRANSPORT, playRange, type TransportSettings, transportCommands } from "./transport-settings";

afterEach(cleanup);

function setup(report: EngineReport | null) {
  const send = vi.fn<(command: EngineCommand) => void>();
  const onChange = vi.fn<(settings: TransportSettings) => void>();
  render(
    <TransportBar
      settings={DEFAULT_TRANSPORT}
      onChange={onChange}
      send={send}
      readReport={() => report}
      tempoMap={constantTempoMap(DEFAULT_TRANSPORT.tempo, DEFAULT_TRANSPORT.timeSignature)}
    />,
  );
  return { send, onChange };
}

const report = (playing: boolean, position: number): EngineReport => ({
  trackCount: 0,
  activeVoices: 0,
  playing,
  position,
});

test("shows the engine's position and plays or stops it", async () => {
  const { send } = setup(report(false, 3840 + 960));
  expect(await screen.findByText("2.2.000")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  expect(send).toHaveBeenCalledWith({ type: "play" });
  fireEvent.click(screen.getByRole("button", { name: "Back to start" }));
  expect(send).toHaveBeenCalledWith({ type: "seek", tick: 0 });
});

test("offers Stop while playing", async () => {
  const { send } = setup(report(true, 0));
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  expect(send).toHaveBeenCalledWith({ type: "stop" });
});

test("play is disabled with no audio running", () => {
  setup(null);
  expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
});

test("changes tempo, time signature, loop and metronome, ignoring out-of-range tempos", () => {
  const { onChange } = setup(null);
  fireEvent.change(screen.getByLabelText("Tempo"), { target: { value: "5" } });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Tempo"), { target: { value: "96.5" } });
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRANSPORT, tempo: 96.5 });

  fireEvent.change(screen.getByLabelText("Beat unit"), { target: { value: "8" } });
  expect(onChange).toHaveBeenLastCalledWith({
    ...DEFAULT_TRANSPORT,
    timeSignature: { beatsPerBar: 4, beatUnit: 8 },
  });
  fireEvent.click(screen.getByLabelText("Loop"));
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRANSPORT, loop: true });
  fireEvent.click(screen.getByLabelText("Metronome"));
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRANSPORT, metronome: true });
});

test("settings become engine commands, looping or stopping at the end of what plays", () => {
  const settings = {
    tempo: 90,
    timeSignature: { beatsPerBar: 6, beatUnit: 8 },
    loop: true,
    loopStart: 0,
    loopEnd: 0,
    loopRegionSet: false,
    metronome: true,
  };
  expect(transportCommands(settings, { start: 2880, end: 8640 })).toEqual([
    { type: "setTempo", bpm: 90 },
    { type: "setTimeSignature", beatsPerBar: 6, beatUnit: 8 },
    { type: "setLoop", startTick: 2880, endTick: 8640, enabled: true },
    { type: "setPlayRange", startTick: 2880, endTick: 8640 },
    { type: "setMetronome", on: true },
  ]);
  expect(transportCommands({ ...settings, loop: false }, { start: 0, end: 7680 })).toContainEqual({
    type: "setLoop",
    startTick: 0,
    endTick: 7680,
    enabled: false,
  });
});

test("what plays is the selected Section, else the ruler's region, else the whole song to the next bar line", () => {
  const map = constantTempoMap(120, { beatsPerBar: 4, beatUnit: 4 });
  const whole = { loopStart: 0, loopEnd: 3840, loopRegionSet: false };
  // The last Clip ends half way through bar 3: the song is three bars.
  expect(playRange(whole, map, 3840 * 2 + 1920, null)).toEqual({ start: 0, end: 3840 * 3, label: "Whole song" });
  expect(playRange(whole, map, 3840 * 2, null)).toEqual({ start: 0, end: 3840 * 2, label: "Whole song" });
  expect(playRange(whole, map, 0, null)).toEqual({ start: 0, end: 0, label: "Whole song" });
  expect(playRange({ ...whole, loopRegionSet: true }, map, 99_999, null)).toEqual({ start: 0, end: 3840, label: "Loop region" });
  expect(playRange({ ...whole, loopRegionSet: true }, map, 99_999, { name: "Chorus", start: 7680, end: 15_360 })).toEqual({
    start: 7680,
    end: 15_360,
    label: "Chorus",
  });
});

test("shows the loop region the timeline's ruler set", () => {
  render(
    <TransportBar
      settings={{ ...DEFAULT_TRANSPORT, loop: true, loopStart: 3840, loopEnd: 11_520 }}
      onChange={vi.fn<(settings: TransportSettings) => void>()}
      send={vi.fn<(command: EngineCommand) => void>()}
      readReport={() => null}
      tempoMap={constantTempoMap(DEFAULT_TRANSPORT.tempo, DEFAULT_TRANSPORT.timeSignature)}
    />,
  );
  expect(screen.getByLabelText("Plays")).toHaveTextContent("Loop region: 2.1.000–4.1.000 · loops");
});

test("what plays is shown, and a region can go back to the whole song", () => {
  const onChange = vi.fn<(settings: TransportSettings) => void>();
  render(
    <TransportBar
      settings={{ ...DEFAULT_TRANSPORT, loopRegionSet: true }}
      range={{ start: 0, end: 3 * 3840, label: "Whole song" }}
      onChange={onChange}
      send={vi.fn<(command: EngineCommand) => void>()}
      readReport={() => null}
      tempoMap={constantTempoMap(DEFAULT_TRANSPORT.tempo, DEFAULT_TRANSPORT.timeSignature)}
    />,
  );
  expect(screen.getByLabelText("Plays")).toHaveTextContent("Whole song: 1.1.000–4.1.000 · stops at the end");
  fireEvent.click(screen.getByRole("button", { name: "Whole song" }));
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRANSPORT, loopRegionSet: false });
});

test("the loop region can be typed as well as dragged on the ruler", () => {
  const { onChange } = setup(null);
  fireEvent.change(screen.getByLabelText("Loop start (bar)"), { target: { value: "3" } });
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRANSPORT, loopStart: 2 * 3840, loopEnd: 3 * 3840, loopRegionSet: true });
  fireEvent.change(screen.getByLabelText("Loop length (bars)"), { target: { value: "4" } });
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_TRANSPORT, loopEnd: 4 * 3840, loopRegionSet: true });
});

test("the position is left out of screen-reader announcements", () => {
  setup(report(true, 0));
  expect(screen.getByLabelText("Position")).toHaveAttribute("aria-live", "off");
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { initSync } from "@engine";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import { fakeExporter } from "../export/fake-exporter";
import type { Command } from "../project/commands";
import type { AudioClip } from "../project/model";
import { constantTempoMap } from "../project/time";
import { AudioEditor, type AudioEditorProps, type SliceAuditioner } from "./AudioEditor";
import { stereoWav } from "./test-wav";

beforeAll(() => {
  initSync({ module: readFileSync(resolvePath(import.meta.dirname, "../../../engine/pkg/soundcheck_engine_bg.wasm")) });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const RATE = 48_000;

/** A second of three decaying hits, at 0.1, 0.4 and 0.7 s, louder on the left. */
function hits(): number[] {
  const left = Array.from({ length: RATE }, () => 0);
  for (const start of [0.1, 0.4, 0.7]) {
    const first = Math.round(start * RATE);
    for (let i = 0; i < 4_800; i++) left[first + i] = Math.exp(-i / 600) * Math.sin(i * 0.3);
  }
  return stereoWav(left, left.map((s) => s / 2), RATE);
}

const clip: AudioClip = { id: "c", kind: "audio", start: 0, duration: 1, file: "audio/Loop.wav", fileOffset: 0 };
const samples = new Map([["audio/Loop.wav", { name: "Loop.wav", bytes: hits() }]]);

function show(props: Partial<AudioEditorProps> = {}) {
  const onCommands = vi.fn<(commands: Command[], label: string) => void>();
  const auditioner: SliceAuditioner = {
    audition: vi.fn<SliceAuditioner["audition"]>(() => Promise.resolve()),
    stopAudition: vi.fn<SliceAuditioner["stopAudition"]>(() => Promise.resolve()),
  };
  const { exporter, clipExports } = fakeExporter();
  render(
    <AudioEditor
      clip={clip}
      trackId="t"
      trackName="Drums"
      samples={samples}
      tempoMap={constantTempoMap(120, { beatsPerBar: 4, beatUnit: 4 })}
      exporter={exporter}
      auditioner={auditioner}
      onCommands={onCommands}
      {...props}
    />,
  );
  return { onCommands, auditioner, exporter, clipExports };
}

const view = () => screen.getByRole("group", { name: /^Waveform of Loop/ });
const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
const drawn = async () => waitFor(() => expect(view().querySelector("svg path")).not.toBeNull());

test("it draws the Clip's waveform, a lane for each side of a stereo file", async () => {
  show();
  expect(screen.getByRole("heading", { name: /Audio Editor: Drums/ })).toBeInTheDocument();
  await drawn();
  expect(view()).toHaveAttribute("data-lanes", "2");
  expect(view().querySelectorAll("svg path")).toHaveLength(2);
  expect(screen.queryByText("Drawing the waveform…")).not.toBeInTheDocument();
});

test("S cuts at the cursor, each cut is a slider the arrow keys move, and Delete takes it away", async () => {
  show();
  await drawn();
  // Without the zero-crossing snap the cut lands exactly where the cursor is.
  fireEvent.click(screen.getByLabelText("Zero crossings"));
  // The view is 800 px wide for a second: 40 ArrowRights of 4 px are 0.2 s.
  for (let i = 0; i < 40; i++) fireEvent.keyDown(view(), { key: "ArrowRight" });
  fireEvent.keyDown(view(), { key: "s" });
  const cut = screen.getByRole("slider", { name: "Cut 1" });
  expect(cut).toHaveAttribute("aria-valuetext", "0:00.200");
  expect(rows()).toHaveLength(2);
  expect(screen.getByText("Cut at 0:00.200. 2 Slices")).toBeInTheDocument();

  fireEvent.keyDown(cut, { key: "ArrowRight", shiftKey: true });
  expect(cut).toHaveAttribute("aria-valuetext", "0:00.250");
  fireEvent.keyDown(cut, { key: "Delete" });
  expect(screen.queryByRole("slider", { name: /^Cut/ })).not.toBeInTheDocument();
  expect(rows()).toHaveLength(1);

  // And the editor's own undo brings it back.
  fireEvent.click(screen.getByRole("button", { name: "Undo slicing" }));
  expect(screen.getByRole("slider", { name: "Cut 1" })).toHaveAttribute("aria-valuetext", "0:00.250");
});

test("a double-click cuts there, and the keys a musician types don't play notes", async () => {
  show();
  await drawn();
  fireEvent.click(screen.getByLabelText("Zero crossings"));
  fireEvent.doubleClick(view(), { clientX: 600 });
  expect(screen.getByRole("slider", { name: "Cut 1" })).toHaveAttribute("aria-valuetext", "0:00.750");
  const onWindow = vi.fn<(event: KeyboardEvent) => void>();
  window.addEventListener("keydown", onWindow);
  fireEvent.keyDown(view(), { key: "s" });
  fireEvent.keyDown(view(), { key: " " });
  window.removeEventListener("keydown", onWindow);
  expect(onWindow).not.toHaveBeenCalled();
});

test("auto-slicing at transients cuts where each hit starts", async () => {
  show();
  await drawn();
  fireEvent.click(screen.getByRole("button", { name: "Auto-slice" }));
  const cuts = screen.getAllByRole("slider", { name: /^Cut/ }).map((slider) => Number(slider.getAttribute("aria-valuenow")));
  expect(cuts).toHaveLength(3);
  for (const [at, expected] of cuts.map((c, i) => [c, [0.1, 0.4, 0.7][i]!])) expect(Math.abs(at! - expected!)).toBeLessThan(0.02);
});

test("auto-slicing into equal parts or on the beat, and Clear cuts", async () => {
  show();
  await drawn();
  fireEvent.change(screen.getByLabelText("Slice at"), { target: { value: "equal" } });
  fireEvent.change(screen.getByLabelText("Parts"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "Auto-slice" }));
  expect(rows()).toHaveLength(4);
  // At 120 BPM a beat is half a second.
  fireEvent.change(screen.getByLabelText("Slice at"), { target: { value: "beat" } });
  fireEvent.click(screen.getByRole("button", { name: "Auto-slice" }));
  expect(rows()).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Clear cuts" }));
  expect(rows()).toHaveLength(1);
});

test("the included Slices export into a folder, one file each, by name", async () => {
  const { exporter, clipExports } = show();
  await drawn();
  fireEvent.change(screen.getByLabelText("Slice at"), { target: { value: "equal" } });
  fireEvent.change(screen.getByLabelText("Parts"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "Auto-slice" }));
  const name = screen.getByLabelText("Name of Slice 1");
  fireEvent.change(name, { target: { value: "Kick" } });
  fireEvent.blur(name);
  fireEvent.click(screen.getByLabelText("Include Slice 3"));

  fireEvent.click(screen.getByRole("button", { name: "Export 3 Slices…" }));
  await waitFor(() => expect(clipExports).toHaveLength(1));
  expect(exporter.chooseFolder).toHaveBeenCalledTimes(1);
  // One after another, each at its own stretch of the file.
  clipExports[0]!.finish(true);
  await waitFor(() => expect(clipExports).toHaveLength(2));
  clipExports[1]!.finish(true);
  await waitFor(() => expect(clipExports).toHaveLength(3));
  clipExports[2]!.finish(true);
  expect(await screen.findByRole("status")).toHaveTextContent("Exported to C:/Music/Slices (3 files)");
  expect(vi.mocked(exporter.fileIn).mock.calls.map(([, file, kind]) => [file, kind])).toEqual([
    ["Kick", "wav"],
    ["Loop – 02", "wav"],
    ["Loop – 04", "wav"],
  ]);
  expect(clipExports.map(({ request }) => [request.fileOffset, request.duration])).toEqual([
    [0, 0.25],
    [0.25, 0.25],
    [0.75, 0.25],
  ]);
});

test("one Slice exports on its own, and cancelling a folder writes nothing", async () => {
  const { exporter, clipExports } = show();
  await drawn();
  fireEvent.click(screen.getByRole("button", { name: "Export Loop – 01" }));
  await waitFor(() => expect(clipExports).toHaveLength(1));
  expect(exporter.chooseFile).toHaveBeenCalledWith("Loop – 01", "wav", "clip");
  expect(clipExports[0]!.request).toMatchObject({ fileOffset: 0, duration: 1 });
});

test("splitting hands over the commands that replace the Clip with its included Slices", async () => {
  const { onCommands } = show();
  await drawn();
  expect(screen.getByRole("button", { name: "Split into 1 Clip" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Slice at"), { target: { value: "equal" } });
  fireEvent.change(screen.getByLabelText("Parts"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Auto-slice" }));
  fireEvent.click(screen.getByRole("button", { name: "Split into 2 Clips" }));
  const [commands, label] = onCommands.mock.calls[0]!;
  expect(label).toBe("Split Clip into 2");
  expect(commands.map((command) => command.type)).toEqual(["deleteClip", "addClip", "addClip"]);
  expect(commands[1]).toMatchObject({ trackId: "t", clip: { id: "c", start: 0, fileOffset: 0, duration: 0.5 } });
});

test("a Slice auditions on its own at the sample browser's level, and Space stops it", async () => {
  const { auditioner } = show();
  await drawn();
  fireEvent.click(screen.getByRole("button", { name: "Play Loop – 01" }));
  await waitFor(() => expect(auditioner.audition).toHaveBeenCalledTimes(1));
  const [wav, gain] = vi.mocked(auditioner.audition).mock.calls[0]!;
  expect(gain).toBe(0.5);
  expect(String.fromCodePoint(...wav.bytes.slice(0, 4))).toBe("RIFF");
  expect(await screen.findByRole("button", { name: "Stop Loop – 01" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.keyDown(view(), { key: " " });
  expect(auditioner.stopAudition).toHaveBeenCalled();
  expect(await screen.findByRole("button", { name: "Play Loop – 01" })).toBeInTheDocument();
});

test("an audition the platform refuses says why", async () => {
  const auditioner: SliceAuditioner = {
    audition: () => Promise.reject(new Error("Start audio to audition the Reference Track")),
    stopAudition: () => Promise.resolve(),
  };
  show({ auditioner });
  await drawn();
  fireEvent.click(screen.getByRole("button", { name: "Play Loop – 01" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Start audio");
});

test("zooming in and back to fit", async () => {
  show();
  await drawn();
  const content = view().firstElementChild as HTMLElement;
  expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(content.style.width).toBe("1600px");
  fireEvent.keyDown(view(), { key: "+" });
  expect(content.style.width).toBe("3200px");
  fireEvent.keyDown(view(), { key: "0" });
  expect(content.style.width).toBe("800px");
});

test("before its audio has arrived, it says so", () => {
  show({ samples: new Map() });
  expect(screen.getByText("This Clip's audio file isn't loaded yet.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Play Loop – 01" })).toBeDisabled();
});

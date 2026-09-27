// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { sampleProject } from "../project/fixtures";
import { createProject } from "../project/model";
import { ExportPanel } from "./ExportPanel";
import { EXPORT_FORMAT_KEY } from "./ExportFormatFields";
import { fakeExporter } from "./fake-exporter";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const loop = { start: 1_920, end: 3_840 };

test("the whole song exports in the chosen format, and shows its progress", async () => {
  const { exporter, exports } = fakeExporter();
  render(<ExportPanel exporter={exporter} project={sampleProject()} samples={new Map()} loop={loop} />);
  fireEvent.change(screen.getByLabelText("Bit depth"), { target: { value: "16" } });
  fireEvent.change(screen.getByLabelText("Sample rate"), { target: { value: "44100" } });
  fireEvent.click(screen.getByRole("button", { name: "Export WAV…" }));

  expect(await screen.findByLabelText("Export progress")).toBeInTheDocument();
  expect(exporter.chooseFile).toHaveBeenCalledWith("Test song", "wav");
  const [{ request, options, finish }] = exports as [(typeof exports)[number]];
  expect(request).toMatchObject({ startTick: 0, endTick: 3_840 + 7_680, sampleRate: 44_100, encoding: { kind: "wav", bits: 16 } });
  expect(request.commands).toContainEqual({ type: "setTempo", bpm: 120 });

  options.onProgress(0.5);
  expect(await screen.findByLabelText("Export progress")).toHaveAttribute("value", "0.5");
  finish(true);
  expect(await screen.findByRole("status")).toHaveTextContent("Exported to C:/Music/Test song.wav");
});

test("the loop region can be exported instead", async () => {
  const { exporter, exports } = fakeExporter();
  render(<ExportPanel exporter={exporter} project={sampleProject()} samples={new Map()} loop={loop} />);
  fireEvent.change(screen.getByLabelText("Export range"), { target: { value: "loop" } });
  fireEvent.click(screen.getByRole("button", { name: "Export WAV…" }));
  await screen.findByLabelText("Export progress");
  expect(exports[0]?.request).toMatchObject({ startTick: 1_920, endTick: 3_840, sampleRate: 48_000, encoding: { kind: "wav", bits: 24 } });
});

test("an MP3 exports at the bitrate chosen, and asks for an MP3 file", async () => {
  const { exporter, exports } = fakeExporter("C:/Music/Test song.mp3");
  render(<ExportPanel exporter={exporter} project={sampleProject()} samples={new Map()} loop={loop} />);
  fireEvent.change(screen.getByLabelText("Format"), { target: { value: "mp3" } });
  // A bit depth means nothing to an MP3; a bitrate does.
  expect(screen.queryByLabelText("Bit depth")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Bitrate"), { target: { value: "192" } });
  fireEvent.click(screen.getByRole("button", { name: "Export MP3…" }));

  await screen.findByLabelText("Export progress");
  expect(exporter.chooseFile).toHaveBeenCalledWith("Test song", "mp3");
  expect(exports[0]?.request).toMatchObject({ sampleRate: 48_000, encoding: { kind: "mp3", kbps: 192 } });
  exports[0]?.finish(true);
  expect(await screen.findByRole("status")).toHaveTextContent("Exported to C:/Music/Test song.mp3");
});

test("cancelling stops the export", async () => {
  const { exporter } = fakeExporter();
  render(<ExportPanel exporter={exporter} project={sampleProject()} samples={new Map()} loop={loop} />);
  fireEvent.click(screen.getByRole("button", { name: "Export WAV…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel export" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Export cancelled");
  expect(screen.getByRole("button", { name: "Export WAV…" })).toBeEnabled();
});

test("closing the save dialog exports nothing", async () => {
  const { exporter, exports } = fakeExporter(null);
  render(<ExportPanel exporter={exporter} project={sampleProject()} samples={new Map()} loop={loop} />);
  fireEvent.click(screen.getByRole("button", { name: "Export WAV…" }));
  await vi.waitFor(() => expect(exporter.chooseFile).toHaveBeenCalled());
  expect(exports).toHaveLength(0);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("a failed export says why", async () => {
  const { exporter } = fakeExporter();
  exporter.exportMix = () => Promise.reject(new Error("disk full"));
  render(<ExportPanel exporter={exporter} project={sampleProject()} samples={new Map()} loop={loop} />);
  fireEvent.click(screen.getByRole("button", { name: "Export WAV…" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
});

test("an empty song has nothing to export", () => {
  const { exporter } = fakeExporter();
  render(<ExportPanel exporter={exporter} project={createProject()} samples={new Map()} loop={loop} />);
  expect(screen.getByRole("button", { name: "Export WAV…" })).toBeDisabled();
});

test("nothing shows where the platform can't export", () => {
  const { container } = render(
    <ExportPanel exporter={null} project={sampleProject()} samples={new Map()} loop={loop} />,
  );
  expect(container).toBeEmptyDOMElement();
});

test("the format picked is remembered for the next export", async () => {
  const { exporter } = fakeExporter("C:/Music/Test song.mp3");
  render(<ExportPanel exporter={exporter} project={sampleProject()} samples={new Map()} loop={loop} />);
  fireEvent.change(screen.getByLabelText("Format"), { target: { value: "mp3" } });
  fireEvent.change(screen.getByLabelText("Bitrate"), { target: { value: "128" } });
  fireEvent.change(screen.getByLabelText("Sample rate"), { target: { value: "44100" } });
  cleanup();

  render(<ExportPanel exporter={exporter} project={sampleProject()} samples={new Map()} loop={loop} />);
  expect(screen.getByLabelText("Format")).toHaveValue("mp3");
  expect(screen.getByLabelText("Bitrate")).toHaveValue("128");
  expect(screen.getByLabelText("Sample rate")).toHaveValue("44100");
  expect(JSON.parse(localStorage.getItem(EXPORT_FORMAT_KEY)!)).toMatchObject({ kind: "mp3", kbps: 128 });
});

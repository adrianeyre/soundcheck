// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { AudioClip } from "../project/model";
import { ClipExportPanel } from "./ClipExportPanel";
import { fakeExporter } from "./fake-exporter";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const clip: AudioClip = { id: "v", kind: "audio", start: 1_920, duration: 12.5, file: "audio/Song vocals.wav", fileOffset: 3 };
const samples = new Map([["audio/Song vocals.wav", { name: "Song vocals.wav", bytes: [82, 73, 70, 70] }]]);

test("a Clip exports its own stretch of its file, named after it, in the format chosen", async () => {
  const { exporter, clipExports } = fakeExporter("C:/Music/Song vocals.wav");
  render(<ClipExportPanel exporter={exporter} clip={clip} samples={samples} />);
  fireEvent.change(screen.getByLabelText("Bit depth"), { target: { value: "32" } });
  fireEvent.change(screen.getByLabelText("Sample rate"), { target: { value: "44100" } });
  fireEvent.click(screen.getByRole("button", { name: "Export WAV…" }));

  expect(await screen.findByLabelText("Export progress")).toBeInTheDocument();
  expect(exporter.chooseFile).toHaveBeenCalledWith("Song vocals", "wav", "clip");
  const [{ request, options, finish }] = clipExports as [(typeof clipExports)[number]];
  expect(request).toEqual({
    audio: new Uint8Array([82, 73, 70, 70]),
    fileOffset: 3,
    duration: 12.5,
    sampleRate: 44_100,
    encoding: { kind: "wav", bits: 32 },
  });
  options.onProgress(0.5);
  expect(await screen.findByLabelText("Export progress")).toHaveAttribute("value", "0.5");
  finish(true);
  expect(await screen.findByRole("status")).toHaveTextContent("Exported to C:/Music/Song vocals.wav");
});

test("an MP3 exports at the bitrate chosen", async () => {
  const { exporter, clipExports } = fakeExporter("C:/Music/Song vocals.mp3");
  render(<ClipExportPanel exporter={exporter} clip={clip} samples={samples} />);
  fireEvent.change(screen.getByLabelText("Format"), { target: { value: "mp3" } });
  fireEvent.change(screen.getByLabelText("Bitrate"), { target: { value: "256" } });
  fireEvent.click(screen.getByRole("button", { name: "Export MP3…" }));
  await screen.findByLabelText("Export progress");
  expect(exporter.chooseFile).toHaveBeenCalledWith("Song vocals", "mp3", "clip");
  expect(clipExports[0]?.request.encoding).toEqual({ kind: "mp3", kbps: 256 });
});

test("it starts on the last format picked, for the mix or a Clip", () => {
  const { exporter } = fakeExporter();
  render(<ClipExportPanel exporter={exporter} clip={clip} samples={samples} />);
  fireEvent.change(screen.getByLabelText("Format"), { target: { value: "mp3" } });
  fireEvent.change(screen.getByLabelText("Bitrate"), { target: { value: "192" } });
  cleanup();
  render(<ClipExportPanel exporter={exporter} clip={clip} samples={samples} />);
  expect(screen.getByLabelText("Format")).toHaveValue("mp3");
  expect(screen.getByLabelText("Bitrate")).toHaveValue("192");
});

test("cancelling stops the export, and closing the save dialog exports nothing", async () => {
  const { exporter, clipExports } = fakeExporter();
  render(<ClipExportPanel exporter={exporter} clip={clip} samples={samples} />);
  fireEvent.click(screen.getByRole("button", { name: "Export WAV…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel export" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Export cancelled");
  expect(clipExports[0]?.options.signal.aborted).toBe(true);
  cleanup();

  const closed = fakeExporter(null);
  render(<ClipExportPanel exporter={closed.exporter} clip={clip} samples={samples} />);
  fireEvent.click(screen.getByRole("button", { name: "Export WAV…" }));
  await vi.waitFor(() => expect(closed.exporter.chooseFile).toHaveBeenCalled());
  expect(closed.clipExports).toHaveLength(0);
});

test("a failed export says why", async () => {
  const { exporter } = fakeExporter();
  exporter.exportClip = () => Promise.reject("This isn't a WAV, FLAC or MP3 file");
  render(<ClipExportPanel exporter={exporter} clip={clip} samples={samples} />);
  fireEvent.click(screen.getByRole("button", { name: "Export WAV…" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Export failed: This isn't a WAV, FLAC or MP3 file");
});

test("a Clip whose audio isn't loaded has nothing to export", () => {
  const { exporter } = fakeExporter();
  render(<ClipExportPanel exporter={exporter} clip={clip} samples={new Map()} />);
  expect(screen.getByRole("button", { name: "Export WAV…" })).toBeDisabled();
  expect(screen.getByText("This Clip's audio file isn't loaded.")).toBeInTheDocument();
});

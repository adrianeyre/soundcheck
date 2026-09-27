/**
 * An exporter for UI tests whose renders the test finishes, and can watch:
 * each export waits until the test calls its `finish`, or is aborted.
 */
import { vi } from "vitest";

import type { ClipExportRequest, ExportOptions, ExportRequest, ExportTarget, MixExporter } from "./mix-exporter";

export interface FakeExport<Request> {
  target: ExportTarget;
  request: Request;
  options: ExportOptions;
  finish: (written: boolean) => void;
}

export function fakeExporter(chosen: string | null = "C:/Music/Test song.wav", folder: string | null = "C:/Music/Slices") {
  const exports: FakeExport<ExportRequest>[] = [];
  const clipExports: FakeExport<ClipExportRequest>[] = [];
  const waiting =
    <Request>(into: FakeExport<Request>[]) =>
    (target: ExportTarget, request: Request, options: ExportOptions) =>
      new Promise<boolean>((finish) => {
        into.push({ target, request, options, finish });
        options.signal.addEventListener("abort", () => finish(false));
      });
  const exporter: MixExporter = {
    chooseFile: vi.fn<MixExporter["chooseFile"]>(() => Promise.resolve(chosen === null ? null : { label: chosen })),
    exportMix: waiting(exports),
    exportClip: waiting(clipExports),
    chooseFolder: vi.fn<MixExporter["chooseFolder"]>(() => Promise.resolve(folder === null ? null : { label: folder })),
    fileIn: vi.fn<MixExporter["fileIn"]>((into, name, kind) => Promise.resolve({ label: `${into.label}/${name}.${kind}` })),
  };
  return { exporter, exports, clipExports };
}

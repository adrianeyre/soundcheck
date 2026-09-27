import { Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ExportOptions, ExportTarget } from "./mix-exporter";

export type ExportStatus =
  | { state: "idle" }
  | { state: "exporting"; progress: number }
  | { state: "done"; label: string }
  | { state: "cancelled" }
  | { state: "failed"; error: string };

export interface ExportRun {
  status: ExportStatus;
  /**
   * Ask where to save, then write there, showing progress: `write` gets the
   * target and the options that report progress and cancel it.
   */
  start: (
    choose: () => Promise<ExportTarget | null>,
    write: (target: ExportTarget, options: ExportOptions) => Promise<boolean>,
  ) => Promise<void>;
  cancel: () => void;
}

/** One export at a time, from choosing the file to its end; one still running when its panel goes is cancelled. */
export function useExportRun(): ExportRun {
  const [status, setStatus] = useState<ExportStatus>({ state: "idle" });
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const start: ExportRun["start"] = async (choose, write) => {
    const controller = new AbortController();
    abort.current = controller;
    try {
      const target = await choose();
      if (!target) return;
      setStatus({ state: "exporting", progress: 0 });
      const written = await write(target, {
        onProgress: (progress) => {
          if (!controller.signal.aborted) setStatus({ state: "exporting", progress });
        },
        signal: controller.signal,
      });
      setStatus(written ? { state: "done", label: target.label } : { state: "cancelled" });
    } catch (reason) {
      setStatus({ state: "failed", error: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  };

  return { status, start, cancel: () => abort.current?.abort() };
}

export interface ExportButtonProps {
  run: ExportRun;
  /** What the button says, such as "Export WAV…". */
  label: string;
  onExport: () => void;
  /** Set to the id of the hint saying why there is nothing to export. */
  emptyHintId?: string;
}

/** The export button, or while it runs, its progress and a Cancel button. */
export function ExportButton({ run, label, onExport, emptyHintId }: ExportButtonProps) {
  if (run.status.state === "exporting") {
    return (
      <>
        <progress aria-label="Export progress" value={run.status.progress} max={1} />
        <button type="button" onClick={run.cancel}>
          <X size={16} aria-hidden />
          Cancel export
        </button>
      </>
    );
  }
  return (
    <button
      type="button"
      className="btn-primary"
      disabled={emptyHintId !== undefined}
      aria-describedby={emptyHintId}
      onClick={onExport}
    >
      <Download size={16} aria-hidden />
      {label}
    </button>
  );
}

/** How the last export ended. */
export function ExportMessages({ status }: { status: ExportStatus }) {
  return (
    <>
      <div aria-live="polite">
        {status.state === "done" && <p role="status">Exported to {status.label}</p>}
        {status.state === "cancelled" && <p role="status">Export cancelled</p>}
      </div>
      {status.state === "failed" && (
        <p role="alert" className="alert">
          Export failed: {status.error}
        </p>
      )}
    </>
  );
}

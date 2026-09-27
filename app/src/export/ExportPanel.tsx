import { useState } from "react";

import type { LoadedSamples } from "../project/engine-sync";
import type { Project } from "../project/model";
import { folderNameFor } from "../storage/useProjectFile";
import { encodingOf, ExportFormatFields, KIND_LABELS, useExportFormat } from "./ExportFormatFields";
import { ExportButton, ExportMessages, useExportRun } from "./ExportRun";
import { exportRequest, type MixExporter, songEndTick } from "./mix-exporter";

export interface ExportPanelProps {
  /** Null where this platform can't export. */
  exporter: MixExporter | null;
  project: Project;
  samples: LoadedSamples;
  /** The transport's loop region, in ticks, offered as the range to export. */
  loop: { start: number; end: number };
}

type Range = "song" | "loop";

/**
 * Export the mix as a WAV or MP3 file: the whole song, or the loop region,
 * in the format chosen, with the tails that ring on past the last Clip.
 */
export function ExportPanel({ exporter, project, samples, loop }: ExportPanelProps) {
  const [range, setRange] = useState<Range>("song");
  const [format, setFormat] = useExportFormat();
  const run = useExportRun();

  if (!exporter) return null;

  const [startTick, endTick] = range === "song" ? [0, songEndTick(project)] : [loop.start, loop.end];
  const empty = endTick <= startTick;
  const exporting = run.status.state === "exporting";

  const onExport = () =>
    void run.start(
      () => exporter.chooseFile(folderNameFor(project.name), format.kind),
      (target, options) => {
        // The Project as it is now: editing on while it renders changes nothing.
        const request = exportRequest(project, samples, { startTick, endTick }, { sampleRate: format.sampleRate, encoding: encodingOf(format) });
        return exporter.exportMix(target, request, options);
      },
    );

  return (
    <div className="stack">
      <div className="row row-end">
        <label className="field">
          Range
          <select
            aria-label="Export range"
            value={range}
            disabled={exporting}
            onChange={(event) => setRange(event.target.value as Range)}
          >
            <option value="song">Whole song</option>
            <option value="loop">Loop region</option>
          </select>
        </label>
        <ExportFormatFields format={format} onChange={setFormat} disabled={exporting} />
        <ExportButton
          run={run}
          label={`Export ${KIND_LABELS[format.kind]}…`}
          onExport={onExport}
          emptyHintId={empty ? "export-empty" : undefined}
        />
      </div>
      {empty && !exporting && (
        <p id="export-empty" className="hint">
          Nothing to export yet.
        </p>
      )}
      <ExportMessages status={run.status} />
    </div>
  );
}

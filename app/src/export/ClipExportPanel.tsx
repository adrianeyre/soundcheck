import type { LoadedSamples } from "../project/engine-sync";
import type { AudioClip } from "../project/model";
import { encodingOf, ExportFormatFields, KIND_LABELS, useExportFormat } from "./ExportFormatFields";
import { ExportButton, ExportMessages, useExportRun } from "./ExportRun";
import { clipExportRequest, clipFileName, type MixExporter } from "./mix-exporter";

export interface ClipExportPanelProps {
  /** Null where this platform can't export. */
  exporter: MixExporter | null;
  clip: AudioClip;
  samples: LoadedSamples;
}

/**
 * Export Clip…: one Audio Clip's own audio as a WAV or MP3 file, the stretch
 * of its file it plays, raw: none of its Track's fader, pan, Effects, Sends
 * or Automation. Such as a Stem, to use elsewhere.
 */
export function ClipExportPanel({ exporter, clip, samples }: ClipExportPanelProps) {
  const [format, setFormat] = useExportFormat();
  const run = useExportRun();

  if (!exporter) return <p className="hint">This version of Soundcheck can&apos;t export files.</p>;

  const name = clipFileName(clip);
  const loaded = samples.has(clip.file);
  const empty = clip.duration <= 0 || !loaded;
  const exporting = run.status.state === "exporting";

  const onExport = () =>
    void run.start(
      () => exporter.chooseFile(name, format.kind, "clip"),
      (target, options) => {
        const request = clipExportRequest(clip, samples, { sampleRate: format.sampleRate, encoding: encodingOf(format) });
        if (!request) throw new Error(`${name}'s audio file isn't loaded`);
        return exporter.exportClip(target, request, options);
      },
    );

  return (
    <div className="stack">
      <p>
        {name}: {clip.duration.toFixed(2)} s from {clip.fileOffset.toFixed(2)} s into its file, as it is, without its Track&apos;s
        fader, Effects or Automation.
      </p>
      <div className="row row-end">
        <ExportFormatFields format={format} onChange={setFormat} disabled={exporting} />
        <ExportButton
          run={run}
          label={`Export ${KIND_LABELS[format.kind]}…`}
          onExport={onExport}
          emptyHintId={empty ? "clip-export-empty" : undefined}
        />
      </div>
      {empty && !exporting && (
        <p id="clip-export-empty" className="hint">
          {loaded ? "This Clip has no audio to export." : "This Clip's audio file isn't loaded."}
        </p>
      )}
      <ExportMessages status={run.status} />
    </div>
  );
}

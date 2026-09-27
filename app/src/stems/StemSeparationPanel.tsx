import { FolderOpen, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Dialog } from "../ui/Dialog";
import { percentText, stageText, timeLeft, timeLeftText } from "./separation-progress";
import type { StemSeparationRun, StemSeparationStatus } from "./useStemSeparation";

/** How often the time left is worked out again. */
const TICK_MS = 1_000;

/**
 * A Stem Separation under way, in the centre of the screen: a spinner, what
 * it is doing, how far it has got and roughly how long is left, and a Cancel.
 * Only the card takes clicks, so the song can still be edited around it.
 */
function SeparationOverlay({
  status,
  onCancel,
}: {
  status: Extract<StemSeparationStatus, { state: "separating" | "installing" }>;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const separating = status.state === "separating";
  useEffect(() => {
    if (!separating) return;
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(tick);
  }, [separating]);

  const left = separating ? timeLeft(status.progress, status.since, now) : null;
  return (
    <div className="separation-overlay">
      <div className="separation-card" role="group" aria-label="Stem Separation" aria-busy="true">
        <LoaderCircle className="spin separation-spinner" size={48} aria-hidden />
        {separating ? (
          <>
            <p className="separation-title">Separating {status.name} into Stems…</p>
            <p className="separation-stage" aria-live="polite">
              {stageText(status.stage)}
            </p>
            <progress aria-label="Stem Separation progress" value={status.progress} max={1} />
            <p className="separation-detail num">
              {percentText(status.progress)}
              {left !== null && ` · ${timeLeftText(left)}`}
            </p>
            <p className="separation-detail">You can keep working while it runs.</p>
            <button type="button" onClick={onCancel}>
              <X size={16} aria-hidden />
              Cancel Stem Separation
            </button>
          </>
        ) : (
          <>
            <p className="separation-title">Installing the Stem Separation model…</p>
            {status.from && <p className="separation-detail">From {status.from}</p>}
            <p className="separation-stage" aria-live="polite">
              Checking it&apos;s htdemucs, then keeping a copy (about 300 MB).
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A Stem Separation as it runs in the background: the overlay while it
 * runs, how it ended, and, where the model isn't installed yet, the offer
 * to install it from a file first.
 */
export function StemSeparationPanel({ run }: { run: StemSeparationRun }) {
  const { status } = run;
  return (
    <>
      <Dialog
        open={status.state === "offerInstall"}
        onClose={run.cancel}
        title="Install the Stem Separation model"
        closeLabel="Close, without installing"
      >
        {status.state === "offerInstall" && status.problem && (
          <p role="alert" className="alert">
            {status.problem}
          </p>
        )}
        <p>
          Stem Separation needs its model, <code>htdemucs.onnx</code>, which you export yourself once with{" "}
          <code>pnpm htdemucs:export</code> (see the README). It writes it to the repo&apos;s <code>model/</code> folder,
          where Soundcheck looks first; it wasn&apos;t there. Install it from the file?
          {run.modelKeptIn && ` It's kept in ${run.modelKeptIn}.`}
        </p>
        <div className="toolbar">
          <button type="button" className="btn-primary" onClick={() => void run.install()}>
            <FolderOpen size={16} aria-hidden />
            Choose the model file…
          </button>
          <button type="button" onClick={run.cancel}>
            Not now
          </button>
        </div>
      </Dialog>
      {(status.state === "separating" || status.state === "installing") && (
        <SeparationOverlay status={status} onCancel={run.cancel} />
      )}
      <div aria-live="polite">
        {status.state === "done" && <p role="status">Separated {status.name} into its Stems</p>}
        {status.state === "cancelled" && <p role="status">Stem Separation of {status.name} cancelled</p>}
      </div>
      {status.state === "failed" && (
        <p role="alert" className="alert">
          {status.error}
        </p>
      )}
    </>
  );
}

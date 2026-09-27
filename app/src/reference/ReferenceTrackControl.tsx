import { Disc3, Play, Square, X } from "lucide-react";
import { useState } from "react";

import type { LoadedSample } from "../project/engine-sync";
import type { ReferenceTrack } from "../project/model";
import { fileName } from "../storage/project-folder";
import { integratedLufs, matchedGain, measureReference, type ReferencePlayer } from "./reference-player";

export interface ReferenceTrackControlProps {
  referenceTrack: ReferenceTrack | null;
  /** Its audio, as the Project folder holds it; undefined when the folder hasn't got it. */
  sample: LoadedSample | undefined;
  player: ReferencePlayer;
  /** The mix's integrated loudness, for matching the reference to it; absent where the mix can't be measured. */
  measureMix?: () => Promise<number | null>;
  /** A file chosen and measured, to copy into the Project as the Reference Track. */
  onChoose: (sample: LoadedSample) => void;
  onRemove: () => void;
  onError: (message: string) => void;
  /** While the Project isn't the musician's to change, such as during a Request. */
  disabled?: boolean;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The Reference Track beside the transport (#106): add or replace it, and
 * audition it on its own, at its own level or turned down to the mix's
 * loudness. It is never in the mix, the meters or an export.
 */
export function ReferenceTrackControl({
  referenceTrack,
  sample,
  player,
  measureMix,
  onChoose,
  onRemove,
  onError,
  disabled = false,
}: ReferenceTrackControlProps) {
  const [matched, setMatched] = useState(false);
  const [auditioning, setAuditioning] = useState(false);
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    try {
      const chosen = await player.chooseFile();
      if (!chosen) return;
      // Measured before it is added, so a file that isn't audio is refused.
      await measureReference(chosen);
      await stop();
      onChoose(chosen);
    } catch (reason) {
      onError(message(reason));
    }
  };

  /** What to play the reference at: its own level, or no louder than the mix. */
  const gainFor = async (reference: LoadedSample, match: boolean) => {
    if (!match || !measureMix) return 1;
    const [mix, measurements] = await Promise.all([measureMix(), measureReference(reference)]);
    return matchedGain(mix, integratedLufs(measurements));
  };

  const audition = async (match: boolean) => {
    if (!sample) return;
    setBusy(true);
    try {
      await player.audition(sample, await gainFor(sample, match));
      setAuditioning(true);
    } catch (reason) {
      onError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setAuditioning(false);
    await player.stopAudition();
  };

  const name = referenceTrack ? fileName(referenceTrack.file) : null;
  return (
    <div className="toolbar-group" role="group" aria-label="Reference Track">
      <button type="button" disabled={disabled} onClick={() => void choose()}>
        <Disc3 size={16} aria-hidden />
        {referenceTrack ? "Replace reference" : "Add reference"}
      </button>
      {referenceTrack && (
        <>
          <output aria-label="Reference Track" className="hint" title={referenceTrack.file}>
            {name}
            {!sample && " (missing)"}
          </output>
          <button
            type="button"
            aria-label={auditioning ? "Stop the reference" : `Audition ${name}`}
            title={auditioning ? "Stop the reference" : `Audition ${name}, on its own`}
            className="btn-icon"
            disabled={!sample || busy}
            onClick={() => void (auditioning ? stop().catch((reason: unknown) => onError(message(reason))) : audition(matched))}
          >
            {auditioning ? <Square size={16} aria-hidden /> : <Play size={16} aria-hidden />}
          </button>
          <label className="field-inline" title={measureMix ? "Turn the reference down to the mix's loudness" : "The mix can't be measured here"}>
            <input
              type="checkbox"
              checked={matched}
              disabled={!measureMix}
              onChange={(event) => {
                setMatched(event.target.checked);
                // Heard at the new level straight away.
                if (auditioning) void audition(event.target.checked);
              }}
            />
            Match loudness
          </label>
          <button
            type="button"
            aria-label="Remove the Reference Track"
            title="Remove the Reference Track"
            className="btn-icon"
            disabled={disabled}
            onClick={() => {
              void stop().catch(() => undefined);
              onRemove();
            }}
          >
            <X size={16} aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}

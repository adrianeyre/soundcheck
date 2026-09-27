import { useEffect, useState } from "react";

import type { Notice, ProjectHistory } from "../project/history";
import { DismissButton } from "../storage/ProjectFile";

/** At most this many at once: the latest, as a Collaborator's edits land. */
const SHOWN = 3;

/**
 * What happened to this person's own Changes among their Collaborators':
 * an undo that left what someone else changed, part of a Change refused, or
 * a Collaborator on another version, which stops everyone until they update.
 */
export function CollaborationNotices({ history }: { history: ProjectHistory }) {
  const [notices, setNotices] = useState<(Notice & { id: number })[]>([]);
  const [stopped, setStopped] = useState(history.stopped);

  // A new history (New, Open) comes with a new component: SongPage keys it by copy.
  useEffect(() => {
    let next = 0;
    return history.onNotice((notice) => {
      if (notice.kind === "update") setStopped(history.stopped);
      else setNotices((shown) => [...shown, { ...notice, id: (next += 1) }].slice(-SHOWN));
    });
  }, [history]);

  if (!stopped && notices.length === 0) return null;
  return (
    <div className="file-alerts">
      {stopped && (
        <p role="alert" className="alert">
          <span>{stopped}</span>
        </p>
      )}
      {notices.map((notice) => (
        <p key={notice.id} role="status" className="notice">
          <span>{notice.text}</span>
          <DismissButton onClick={() => setNotices((shown) => shown.filter((each) => each.id !== notice.id))} />
        </p>
      ))}
    </div>
  );
}

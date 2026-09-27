import { Download } from "lucide-react";

import type { Updates } from "./useUpdates";

/**
 * The notice that a newer version is out, at the top of the page: install
 * it now, which restarts the app, or later, from Settings. Like the cookie
 * notice, it is a labelled region, not a dialog, so nothing waits on it.
 */
export function UpdateNotice({ updates }: { updates: Updates }) {
  const { run } = updates;
  if (!updates.notice || (run.state !== "found" && run.state !== "installing" && run.state !== "failed")) return null;
  const version = run.update?.version;
  return (
    <section className="notice update-notice" aria-label="Update">
      <Download size={18} aria-hidden />
      {run.state === "installing" ? (
        <>
          <span>Downloading Soundcheck {version}; it restarts once it is installed…</span>
          <progress aria-label="Update download" value={run.progress} max={1} />
        </>
      ) : (
        <>
          <span>
            {run.state === "failed" ? run.error : `Soundcheck ${version} is out. You have ${updates.status?.version}.`}
          </span>
          <div className="row">
            <button type="button" className="btn-primary btn-sm" onClick={updates.install}>
              {run.state === "failed" ? "Try again" : "Install and restart"}
            </button>
            <button type="button" className="btn-sm" onClick={updates.later}>
              Later
            </button>
          </div>
        </>
      )}
    </section>
  );
}

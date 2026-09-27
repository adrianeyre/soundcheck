import { DESKTOP_APP_URL } from "../settings/BrowserVersionSettings";
import { UPDATE_OFF } from "./updater";
import type { Updates } from "./useUpdates";

/** The version running, and finding and installing a newer one. */
export function UpdateSettings({ updates }: { updates: Updates }) {
  const { status, run } = updates;
  if (!status) return <p className="hint">Asking which version this is…</p>;
  if (status.off) {
    return (
      <div className="stack">
        <p>You have Soundcheck {status.version}.</p>
        <p className="hint">{UPDATE_OFF[status.off]}</p>
        {status.off !== "development" && (
          <div className="row">
            <a href={DESKTOP_APP_URL} target="_blank" rel="noopener noreferrer">
              Releases
              <span className="visually-hidden"> (on GitHub, opens in a new tab)</span>
            </a>
          </div>
        )}
      </div>
    );
  }
  const busy = run.state === "checking" || run.state === "installing";
  const update = run.state === "found" || run.state === "installing" || run.state === "failed" ? run.update : null;
  return (
    <div className="stack">
      <p>You have Soundcheck {status.version}.</p>
      <label>
        <input
          type="checkbox"
          checked={updates.checkAtStart}
          onChange={(event) => updates.setCheckAtStart(event.target.checked)}
        />{" "}
        Check for a newer version when Soundcheck starts
      </label>
      <div className="row">
        <button type="button" onClick={updates.check} disabled={busy}>
          Check for updates
        </button>
      </div>
      <div aria-live="polite">
        {run.state === "checking" && <p role="status">Checking for a newer version…</p>}
        {run.state === "upToDate" && <p role="status">Soundcheck is up to date.</p>}
      </div>
      {update && (
        <div className="stack">
          <p>
            <strong>Soundcheck {update.version}</strong> is out
            {update.date && <> (released {new Date(update.date).toLocaleDateString()})</>}.
          </p>
          {update.notes && <p className="update-notes">{update.notes}</p>}
          {run.state === "installing" ? (
            <progress aria-label="Update download" value={run.progress} max={1} />
          ) : (
            <div className="row">
              <button type="button" className="btn-primary" onClick={updates.install}>
                Install and restart
              </button>
            </div>
          )}
          <p className="hint">
            Installing closes Soundcheck and opens the new version. On Windows the installer shows its progress;
            on Linux, updating the .deb asks for your password.
          </p>
        </div>
      )}
      {run.state === "failed" && (
        <p role="alert" className="alert">
          {run.error}
        </p>
      )}
    </div>
  );
}

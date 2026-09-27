import { useId, useState } from "react";

import { Dialog } from "../ui/Dialog";
import type { LiveStatus } from "./live-session";
import type { LiveSessionState } from "./useLiveSession";

export interface LiveSessionDialogProps {
  open: boolean;
  onClose: () => void;
  live: LiveSessionState;
  /** An invite link to join, as the Browser Version was opened with. */
  initialLink?: string;
}

/** What the session is doing, in a sentence. */
export function liveStatusText(status: LiveStatus | null, members: readonly string[]): string {
  switch (status?.kind) {
    case undefined:
    case "connecting":
      return "Connecting to the Relay…";
    case "waiting":
      return "Waiting for someone in the session to send you its Project…";
    case "live":
      return members.length > 0 ? `Live with ${members.join(", ")}.` : "Live. Nobody else is here yet.";
    case "reconnecting":
      return `Reconnecting: ${status.reason} Your edits wait here and go once it is back.`;
    case "update":
      return status.reason;
    case "left":
      return "You left the session.";
  }
}

/**
 * Start a Live Session with this Project, or join one from an invite link,
 * and while in one: who else is in it, the link to invite more, and Leave.
 */
export function LiveSessionDialog({ open, onClose, live, initialLink = "" }: LiveSessionDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Live Session" closeLabel="Close Live Session">
      {live.active ? <InSession live={live} /> : <StartOrJoin live={live} initialLink={initialLink} />}
    </Dialog>
  );
}

function InSession({ live }: { live: LiveSessionState }) {
  const [copied, setCopied] = useState(false);
  const help = useId();
  const link = live.link ?? "";
  return (
    <div className="stack">
      <p role="status">{liveStatusText(live.status, live.members)}</p>
      <label className="field">
        Invite link
        <input readOnly value={link} aria-describedby={help} onFocus={(event) => event.target.select()} />
      </label>
      <p id={help} className="hint">
        Anyone with this link can join and edit this Project with you, so send it only to whoever you want to. It opens
        in a browser, or paste it into Join in the Desktop App. Each of you undoes only your own edits.
      </p>
      <div className="row">
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <button type="button" onClick={live.leave}>
          Leave
        </button>
      </div>
    </div>
  );
}

function StartOrJoin({ live, initialLink }: { live: LiveSessionState; initialLink: string }) {
  const [link, setLink] = useState(initialLink);
  return (
    <div className="stack">
      <p className="hint">
        Edit this Project with others at the same time, each on your own machine. Every edit reaches the rest within a
        moment, through a Relay that can't read any of it.
      </p>
      {live.relay ? (
        <div className="row">
          <button type="button" className="btn-primary" onClick={live.start}>
            Start a Live Session
          </button>
        </div>
      ) : (
        <p className="hint">
          To start one, this copy of Soundcheck needs a Relay: type its address in Settings → Collaboration. Joining from
          an invite link needs none, as the link says which Relay to use.
        </p>
      )}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          live.join(link);
        }}
      >
        <label className="field">
          Invite link
          <input value={link} spellCheck={false} placeholder="https://…#live=…" onChange={(event) => setLink(event.target.value)} />
        </label>
        <p className="hint">Joining opens the session's Project in place of this one.</p>
        <div className="row">
          <button type="submit" disabled={link.trim() === ""}>
            Join
          </button>
        </div>
      </form>
      {live.error && (
        <p role="alert" className="alert">
          {live.error}
        </p>
      )}
    </div>
  );
}

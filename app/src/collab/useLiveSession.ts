import { useEffect, useRef, useState } from "react";

import type { LoadedSamples } from "../project/engine-sync";
import type { ProjectHistory } from "../project/history";
import { liveCopyFor, relayFor, rememberLiveCopy } from "./identity";
import { LiveSession, type LiveSocket, type LiveStatus } from "./live-session";
import { type Invite, inviteLink, newInvite, readInvite } from "./live-wire";

export interface LiveSessionHookOptions {
  history: ProjectHistory;
  /** The audio the Project has loaded now, to pass to members who ask. */
  samples: () => LoadedSamples;
  /** Audio a member passed on. */
  onAudio: (samples: LoadedSamples) => void;
  /** The session's Project, taken on joining it, to edit in place of this one. */
  adopt: (history: ProjectHistory) => void;
  /** The Project is a Shared Project, whose base every copy of its folder has already. */
  shared: boolean;
  /** Asks before joining would lose unsaved changes; true to go on. */
  mayDiscard: () => boolean;
  /** Where invite links open: the Browser Version. */
  site: string;
  /** The Relay a new session goes through; Settings' or the built-in one otherwise. */
  relay?: () => string | null;
  /** For tests; a WebSocket otherwise. */
  connect?: (url: string) => LiveSocket;
}

export interface LiveSessionState {
  /** In a Live Session now. */
  active: boolean;
  /** The link that invites someone into it, while in one. */
  link: string | null;
  status: LiveStatus | null;
  /** Who else is in it, by name. */
  members: string[];
  /** What went wrong last, until the next start or join. */
  error: string | null;
  /** The Relay a session started now would go through, or null if there is none. */
  relay: string | null;
  /** Start a Live Session with this Project. */
  start: () => void;
  /** Join the session an invite link is for. */
  join: (link: string) => void;
  leave: () => void;
}

export const NO_RELAY =
  "A Live Session needs a Relay, and this copy of Soundcheck came without one. Type the address of one in Settings → Collaboration.";
export const NOT_AN_INVITE = "That isn't a Live Session's invite link. It is the whole link someone sent you, with #live= in it.";

/**
 * A Live Session for the Project being edited (ADR 0007): started with it,
 * or joined from an invite link, and left when the Project is replaced, as
 * by New or Open, or when the page goes.
 */
export function useLiveSession({
  history,
  samples,
  onAudio,
  adopt,
  shared,
  mayDiscard,
  site,
  relay = relayFor,
  connect,
}: LiveSessionHookOptions): LiveSessionState {
  const [started, setLive] = useState<{ session: LiveSession; invite: Invite } | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Another Project, as from New or Open, isn't the session's.
  const live = started && started.session.history === history ? started : null;

  const latest = useRef({ samples, onAudio, adopt });
  useEffect(() => {
    latest.current = { samples, onAudio, adopt };
  });

  useEffect(() => {
    if (started && !live) started.session.leave();
  }, [started, live]);

  const current = useRef(started);
  useEffect(() => {
    current.current = started;
  }, [started]);
  useEffect(() => () => current.current?.session.leave(), []);

  // Only the latest session says how it is: one left behind still hears its connection close.
  const latestSession = useRef<object | null>(null);
  const begin = (invite: Invite, joining: boolean) => {
    setError(null);
    const token = {};
    latestSession.current = token;
    const session = new LiveSession({
      invite,
      history,
      joining,
      copy: joining ? liveCopyFor(invite.session) : undefined,
      samples: () => latest.current.samples(),
      onAudio: (added) => latest.current.onAudio(added),
      onProject: (taken) => {
        rememberLiveCopy(invite.session, taken.copy);
        latest.current.adopt(taken);
      },
      onStatus: (next) => {
        if (latestSession.current === token) setStatus(next);
      },
      onMembers: (names) => {
        if (latestSession.current === token) setMembers(names);
      },
      connect,
    });
    setLive({ session, invite });
  };

  const start = () => {
    if (live) return;
    started?.session.leave();
    const address = relay();
    if (!address) {
      setError(NO_RELAY);
      return;
    }
    try {
      // A Shared Project's base is the one its folder has, so a copy opened
      // from it joins with what it has; any other starts the log afresh.
      if (!shared) history.rebase();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    setStatus(null);
    setMembers([]);
    begin(newInvite(address), false);
  };

  const join = (link: string) => {
    if (live) return;
    started?.session.leave();
    const invite = readInvite(link);
    if (!invite) {
      setError(NOT_AN_INVITE);
      return;
    }
    if (!mayDiscard()) return;
    setStatus(null);
    setMembers([]);
    begin(invite, true);
  };

  const leave = () => {
    latestSession.current = null;
    live?.session.leave();
    setLive(null);
    setStatus(null);
    setMembers([]);
  };

  return {
    active: live !== null,
    link: live ? inviteLink(live.invite, site) : null,
    status: live ? status : null,
    members: live ? members : [],
    error,
    relay: relay(),
    start,
    join,
    leave,
  };
}

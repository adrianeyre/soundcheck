import { useEffect, useState } from "react";

import { readLocal, writeLocal } from "../settings/local-settings";
import type { FoundUpdate, Updater, UpdateStatus } from "./updater";

/** Whether to ask for a newer version each time the app starts; on unless turned off. */
export const CHECK_AT_START_KEY = "soundcheck.updates.check-at-start";

export type UpdateRun =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate" }
  | { state: "found"; update: FoundUpdate }
  | { state: "installing"; update: FoundUpdate; progress: number }
  /** A check or an install that failed; after an install, the update it was, to try again. */
  | { state: "failed"; error: string; update: FoundUpdate | null };

export interface Updates {
  /** The version running and whether it updates itself; null until the shell says. */
  status: UpdateStatus | null;
  run: UpdateRun;
  checkAtStart: boolean;
  setCheckAtStart: (on: boolean) => void;
  /** Whether to show the notice of a newer version: until it is installed or put off. */
  notice: boolean;
  check: () => void;
  install: () => void;
  /** Puts the notice off until the next start; Settings still has the update. */
  later: () => void;
}

export interface UpdatesOptions {
  /** Asks before an install closes the app on an unsaved Project; true to go on. */
  mayDiscard?: () => boolean;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The app's updates: its status, a check at start unless turned off, a
 * check from Settings, and installing what was found. A check at start that
 * fails (offline, say) shows nothing but in Settings; one that finds a
 * newer version shows the notice.
 */
export function useUpdates(updater: Updater | null, { mayDiscard = () => true }: UpdatesOptions = {}): Updates {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [run, setRun] = useState<UpdateRun>({ state: "idle" });
  const [checkAtStart, setCheckAtStartState] = useState(() => readLocal(CHECK_AT_START_KEY) !== "false");
  const [putOff, setPutOff] = useState(false);

  const check = async () => {
    if (!updater || run.state === "checking" || run.state === "installing") return;
    setRun({ state: "checking" });
    try {
      const update = await updater.check();
      setRun(update ? { state: "found", update } : { state: "upToDate" });
    } catch (error) {
      setRun({ state: "failed", error: message(error), update: null });
    }
  };

  useEffect(() => {
    if (!updater) return;
    let live = true;
    void updater.status().then(
      (found) => {
        if (!live) return;
        setStatus(found);
        if (found.off === null && readLocal(CHECK_AT_START_KEY) !== "false") void check();
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // Once per start, for this platform's updater.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [updater]);

  const install = async () => {
    const update = run.state === "found" || run.state === "failed" ? run.update : null;
    if (!updater || !update || !mayDiscard()) return;
    setRun({ state: "installing", update, progress: 0 });
    try {
      await updater.install((progress) =>
        setRun((now) => (now.state === "installing" ? { ...now, progress } : now)),
      );
    } catch (error) {
      setRun({ state: "failed", error: message(error), update });
    }
  };

  const found = run.state === "found" || run.state === "installing" || (run.state === "failed" && run.update !== null);
  return {
    status,
    run,
    checkAtStart,
    setCheckAtStart: (on) => {
      setCheckAtStartState(on);
      writeLocal(CHECK_AT_START_KEY, String(on));
    },
    notice: found && !putOff,
    check: () => void check(),
    install: () => void install(),
    later: () => setPutOff(true),
  };
}

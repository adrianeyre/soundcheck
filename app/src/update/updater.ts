/**
 * Auto-update (#74, ADR 0011): the installed Desktop App finds a newer
 * version on the latest GitHub Release and, once the musician says so,
 * installs it and restarts into it. The Browser Version has no part here:
 * each visit loads the latest deploy already.
 */

/** Why this copy doesn't update itself, as the shell (`desktop/src/update.rs`) names it. */
export type UpdateOff = "no-key" | "development" | "not-installed";

export interface UpdateStatus {
  /** The version running. */
  version: string;
  /** Why it doesn't update itself, or null when it does. */
  off: UpdateOff | null;
}

/** A newer version, as its Release announces it. */
export interface FoundUpdate {
  version: string;
  /** When it was released, as RFC 3339, if the Release says. */
  date: string | null;
  /** What's new in it, if the Release says. */
  notes: string | null;
}

export interface Updater {
  status(): Promise<UpdateStatus>;
  /** Asks the latest Release for a newer version; null if this is the latest. */
  check(): Promise<FoundUpdate | null>;
  /**
   * Downloads the version the last check found, checks its signature,
   * installs it and restarts into it, so it settles only if that fails.
   */
  install(onProgress: (fraction: number) => void): Promise<void>;
}

/** What Settings says about each reason this copy doesn't update itself. */
export const UPDATE_OFF: Record<UpdateOff, string> = {
  "no-key":
    "This build doesn't update itself: it was built before Soundcheck's releases were signed. Get a newer one from the Releases page.",
  development: "A development build doesn't update itself.",
  "not-installed":
    "This copy wasn't installed from a Release's installer or package, so it can't update itself. Get one from the Releases page.",
};

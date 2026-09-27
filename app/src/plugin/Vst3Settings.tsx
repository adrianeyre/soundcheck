import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { Command, Result } from "../project/commands";
import type { ProjectHistory } from "../project/history";
import type { Project } from "../project/model";
import { readLocal, writeLocal, type LocalStore } from "../settings/local-settings";
import {
  setVst3Scanned,
  setVst3Scanning,
  subscribeToVst3,
  type Vst3Host,
  isVst3Instrument,
  vst3Instances,
  vst3Scanned,
  vst3Scanning,
} from "./vst3";
import { Vst3Sync } from "./vst3-sync";

/** The folders the musician added to the scan, beyond the platform's own. Kept on this machine. */
export const VST3_FOLDERS_KEY = "soundcheck.vst3Folders";

/** How often the Plugins' windows and helpers are heard from, in ms. */
export const VST3_POLL_MS = 250;

export function readVst3Folders(store?: LocalStore | null): string[] {
  const saved = readLocal(VST3_FOLDERS_KEY, store);
  if (!saved) return [];
  try {
    const folders: unknown = JSON.parse(saved);
    return Array.isArray(folders) ? folders.filter((folder): folder is string => typeof folder === "string" && folder !== "") : [];
  } catch {
    return [];
  }
}

export function writeVst3Folders(folders: readonly string[], store?: LocalStore | null): void {
  writeLocal(VST3_FOLDERS_KEY, JSON.stringify(folders), store);
}

/** The Desktop App's VST3 Plugins, for the panels that show them. */
export interface Vst3 {
  host: Vst3Host;
  sync: Vst3Sync;
  /** Scan the default folders and the musician's own again. */
  rescan: () => void;
  /** Why the last scan failed, if it did. */
  scanError: string | null;
  /**
   * Carry out a command in the Project's history, answering whether it was.
   * A new VST3 Plugin is loaded before it is added, and unloaded again if it
   * can't be.
   */
  execute: (command: Command) => Result;
}

export const Vst3Context = createContext<Vst3 | null>(null);

/**
 * Why the Desktop App can't host VST3 Plugins on this machine (macOS, so
 * far), or null where it can or where this is the Browser Version.
 */
export const Vst3UnavailableContext = createContext<string | null>(null);

/** The VST3 Plugins, and why there are none where the Desktop App can't host them, for everything below. */
export function Vst3Provider({ vst3, unavailable, children }: { vst3: Vst3 | null; unavailable: string | null; children: ReactNode }) {
  return (
    <Vst3Context value={vst3}>
      <Vst3UnavailableContext value={unavailable}>{children}</Vst3UnavailableContext>
    </Vst3Context>
  );
}

/** Why VST3 Plugins aren't offered on this machine, in Settings where their list would be. */
export function Vst3Unavailable({ reason }: { reason: string }) {
  return (
    <div>
      <p className="hint" role="status">
        {`${reason}. A Project that has them opens here too, and keeps each one exactly, but bypasses an Effect and silences an Instrument.`}
      </p>
      <p className="hint mt-3">VST is a registered trademark of Steinberg Media Technologies GmbH.</p>
    </div>
  );
}

/** The VST3 Plugins, or null where they can't be hosted: the Browser Version, macOS, and tests without a host. */
export function useVst3Context(): Vst3 | null {
  return useContext(Vst3Context);
}

/** Every instance, drawn again whenever one changes or the scan does. */
export function useVst3Instances() {
  useSyncExternalStore(subscribeToVst3, vst3Scanned);
  return useSyncExternalStore(subscribeToVst3, vst3Instances);
}

/**
 * Keep the VST3 Plugins in step with `project` (ADR 0008): scan once, load
 * and unload as the Project changes, and every 250 ms hear what happened in
 * their windows, recording what the musician turned there in `history`.
 * A Project replaced by New or Open unloads the last one's.
 */
export function useVst3(host: Vst3Host | null | undefined, project: Project, history: ProjectHistory): Vst3 | null {
  const sync = useMemo(() => (host ? new Vst3Sync(host) : null), [host]);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanned = useSyncExternalStore(subscribeToVst3, vst3Scanned);

  const rescan = useCallback(() => {
    if (!host) return;
    setVst3Scanning(true);
    host.scan(readVst3Folders()).then(
      (found) => {
        setScanError(null);
        setVst3Scanned(found);
      },
      (error: unknown) => {
        setScanError(error instanceof Error ? error.message : String(error));
        setVst3Scanning(false);
      },
    );
  }, [host]);
  useEffect(rescan, [rescan]);

  useEffect(() => {
    if (!sync) return;
    // A Project replaced, or the page going, unloads what it had: `history` is here for that.
    return () => sync.dispose();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [sync, history]);

  useEffect(() => {
    sync?.update(project);
    // Vst3Sync reads the scan itself; `scanned` is here so a Plugin installed since loads.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [sync, project, scanned]);

  useEffect(() => {
    if (!sync) return;
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      sync
        .poll()
        // While a Request is carried out the history refuses them: the
        // Plugin keeps the value, and its state still reaches the Project.
        .then((commands) => void (commands.length > 0 && history.execute(commands)))
        .catch(() => {})
        .finally(() => (polling = false));
    }, VST3_POLL_MS);
    return () => clearInterval(timer);
  }, [sync, history]);

  return useMemo(
    () => (host && sync ? { host, sync, rescan, scanError, execute: (command: Command) => history.execute(command) } : null),
    [host, sync, rescan, scanError, history],
  );
}

/**
 * The VST3 Plugins the scan found, what it couldn't read and why, and the
 * folders it looks in beyond the platform's own.
 */
export function Vst3Settings({ vst3 }: { vst3: Vst3 }) {
  const scanned = useSyncExternalStore(subscribeToVst3, vst3Scanned);
  const scanning = useSyncExternalStore(subscribeToVst3, vst3Scanning);
  const [folders, setFolders] = useState(readVst3Folders);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [adding, setAdding] = useState("");

  useEffect(() => {
    let current = true;
    vst3.host.defaultFolders().then(
      (found) => current && setDefaults(found),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [vst3.host]);

  const changeFolders = (next: string[]) => {
    setFolders(next);
    writeVst3Folders(next);
    vst3.rescan();
  };

  const found = scanned.filter((bundle) => bundle.classes.length > 0);
  const unreadable = scanned.filter((bundle) => bundle.error);

  return (
    <div>
      {found.length === 0 ? (
        <p className="hint">{scanning ? "Scanning…" : "No VST3 Plugins found."}</p>
      ) : (
        <ul aria-label="VST3 Plugins found">
          {found.flatMap(({ bundle, classes }) =>
            classes.map((vst3Class) => (
              <li key={`${bundle} ${vst3Class.cid}`}>
                {vst3Class.name}{" "}
                <span className="hint">
                  {`${vst3Class.vendor} ${vst3Class.version}, ${isVst3Instrument(vst3Class) ? "Instrument" : "Effect"} (${bundle})`}
                </span>
              </li>
            )),
          )}
        </ul>
      )}
      {unreadable.length > 0 && (
        <>
          <p className="hint">These couldn't be read, so they aren't offered:</p>
          <ul aria-label="VST3 Plugins that couldn't be read">
            {unreadable.map(({ bundle, error }) => (
              <li key={bundle}>
                {bundle} <span className="hint">{error}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {vst3.scanError && (
        <p className="hint" role="alert">
          {`The scan failed: ${vst3.scanError}`}
        </p>
      )}
      <div className="row mt-3">
        <button type="button" disabled={scanning} onClick={vst3.rescan}>
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </div>
      <p className="hint mt-3">{defaults.length > 0 ? `Always scanned: ${defaults.join(", ")}` : "Only the folders below are scanned."}</p>
      {folders.length > 0 && (
        <ul aria-label="Your VST3 folders">
          {folders.map((folder) => (
            <li key={folder} className="row">
              <span>{folder}</span>
              <button type="button" aria-label={`Stop scanning ${folder}`} onClick={() => changeFolders(folders.filter((other) => other !== folder))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="row mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          const folder = adding.trim();
          if (folder && !folders.includes(folder)) changeFolders([...folders, folder]);
          setAdding("");
        }}
      >
        <label className="row">
          <span>Also scan</span>
          <input type="text" aria-label="Also scan the folder" placeholder="D:\Plugins\VST3" value={adding} onChange={(event) => setAdding(event.target.value)} />
        </label>
        <button type="submit" disabled={adding.trim() === ""}>
          Add folder
        </button>
      </form>
      <p className="hint mt-3">VST is a registered trademark of Steinberg Media Technologies GmbH.</p>
    </div>
  );
}

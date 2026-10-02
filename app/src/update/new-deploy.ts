/**
 * A newer Browser Version, deployed while the page was open. Every deploy
 * to GitHub Pages replaces the site's hashed files (the engine's WASM, the
 * lazily loaded chunks), so a page left open across one can ask for a file
 * that is no longer there, and fail with a 404 the musician can do nothing
 * about but reload. Each build writes its id to `version.json` beside
 * `index.html`; the page compares it with its own, and says when they
 * differ, with a button to reload.
 *
 * The Desktop App has its own Updates (`useUpdates`), and serves its page
 * from inside itself, so none of this runs there.
 */
import { useCallback, useEffect, useState } from "react";

/** Where a build writes its id, beside `index.html`. */
export const VERSION_FILE = "version.json";

/** How often an open page asks whether the site has been deployed since, besides when it is shown again. */
export const CHECK_EVERY_MS = 10 * 60 * 1000;

/** What a build writes to `version.json`. */
export interface DeployStamp {
  /** This build's own id: the commit it was built from, or when, where there was none. */
  build: string;
  /** The app's version, for the notice to name. */
  version: string;
}

/**
 * Whether `reason` looks like a file of this build that the site no longer
 * has: a dynamic import, a worker or the engine's WASM that came back as
 * GitHub Pages' 404 page rather than itself.
 */
export function isMissingAsset(reason: unknown): boolean {
  const text = reason instanceof Error ? `${reason.name} ${reason.message}` : String(reason);
  return [
    /dynamically imported module/i, // Chrome and Firefox: a lazy chunk that isn't there.
    /Importing a module script failed/i, // Safari's.
    /Unable to preload CSS/i, // Vite's, for a chunk's stylesheet.
    /expected magic word/i, // The WASM came back as an HTML page.
    /Incorrect response MIME type/i, // The same, streamed.
    /\.wasm\b.*\b404\b|\b404\b.*\.wasm\b/i,
  ].some((pattern) => pattern.test(text));
}

/** The site's own stamp, fetched past every cache; null where there is none, as under `pnpm dev`. */
export async function deployedStamp(fetchFn: typeof fetch = fetch, url: string = VERSION_FILE): Promise<DeployStamp | null> {
  try {
    const response = await fetchFn(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    const stamp = (await response.json()) as Partial<DeployStamp>;
    return typeof stamp.build === "string" && stamp.build ? { build: stamp.build, version: String(stamp.version ?? "") } : null;
  } catch {
    // Offline, or the page isn't served from the site: nothing to compare.
    return null;
  }
}

export interface NewDeploy {
  /** The version deployed since this page loaded, or null while it is the same. */
  newer: DeployStamp | null;
  /** Whether a file of this build failed to load: then a reload is what fixes it, whatever the stamp says. */
  broken: boolean;
  reload: () => void;
  /** Hide the notice until the next newer deploy. */
  dismiss: () => void;
}

export interface NewDeployOptions {
  /** This build's id; none under tests and `pnpm dev`, where nothing is checked. */
  build: string | undefined;
  /** Off in the Desktop App. */
  enabled: boolean;
  fetch?: typeof fetch;
  reload?: () => void;
}

/**
 * Watches for a newer deploy: when the page starts, when it is shown again,
 * every `CHECK_EVERY_MS`, and at once when a file fails to load (Vite's
 * `vite:preloadError`, or an error that looks like a missing file).
 */
export function useNewDeploy({ build, enabled, fetch: fetchFn = fetch, reload = () => location.reload() }: NewDeployOptions): NewDeploy {
  const [newer, setNewer] = useState<DeployStamp | null>(null);
  const [broken, setBroken] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const on = enabled && build !== undefined && build !== "";

  const check = useCallback(
    () =>
      deployedStamp(fetchFn).then((stamp) => {
        if (stamp && stamp.build !== build) setNewer(stamp);
      }),
    [fetchFn, build],
  );

  useEffect(() => {
    if (!on) return;
    void check();
    const shown = () => document.visibilityState === "visible" && void check();
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    const failed = (reason: unknown) => {
      if (!isMissingAsset(reason)) return;
      setBroken(true);
      void check();
    };
    const preload = (event: Event) => failed((event as Event & { payload?: unknown }).payload ?? new Error("dynamically imported module"));
    const rejected = (event: PromiseRejectionEvent) => failed(event.reason);
    const errored = (event: ErrorEvent) => failed(event.error ?? event.message);
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("vite:preloadError", preload);
    window.addEventListener("unhandledrejection", rejected);
    window.addEventListener("error", errored);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("vite:preloadError", preload);
      window.removeEventListener("unhandledrejection", rejected);
      window.removeEventListener("error", errored);
    };
  }, [on, check]);

  /** For code that catches a load failure itself, as the engine's loading does. */
  useEffect(() => {
    if (!on) return;
    const reported = (event: Event) => {
      setBroken(true);
      void check();
      event.stopPropagation();
    };
    window.addEventListener(MISSING_ASSET_EVENT, reported);
    return () => window.removeEventListener(MISSING_ASSET_EVENT, reported);
  }, [on, check]);

  const shownNewer = newer && newer.build !== dismissed ? newer : null;
  return {
    newer: shownNewer,
    broken: on && broken,
    reload,
    dismiss: () => {
      setDismissed(newer?.build ?? null);
      setBroken(false);
    },
  };
}

/** The event `reportIfMissingAsset` sends, for `useNewDeploy` to hear. */
export const MISSING_ASSET_EVENT = "soundcheck:missing-asset";

/**
 * Tell the page a file of this build failed to load, where the code that
 * caught it would otherwise only show its own error: then the notice to
 * reload shows too. Answers whether it was one.
 */
export function reportIfMissingAsset(reason: unknown): boolean {
  if (!isMissingAsset(reason) || typeof window === "undefined") return false;
  window.dispatchEvent(new Event(MISSING_ASSET_EVENT));
  return true;
}

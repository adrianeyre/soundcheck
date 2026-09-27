/**
 * The few preferences the app keeps in the webview's local storage. Local
 * storage can be missing or refused (a private window, blocked site data),
 * so every read and write here survives that and the app works without it.
 */
export type LocalStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function localStore(): LocalStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readLocal(key: string, store = localStore()): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string, store = localStore()): void {
  try {
    store?.setItem(key, value);
  } catch {
    // Nowhere to keep it: it lasts for this run only.
  }
}

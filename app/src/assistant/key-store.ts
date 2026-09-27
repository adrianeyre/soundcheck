/**
 * Where the user's Claude API key is kept on this machine.
 *
 * The key belongs to the machine, never to a Project: nothing here writes it
 * into Project data, and the Assistant only ever reads it to make a request.
 * Two implementations, as with audio and MIDI: the desktop app hands it to
 * the OS credential store (Windows Credential Manager first, ADR 0002), and
 * the browser dev host keeps it in local storage. `platform.ts` picks one.
 */
import type { Invoke } from "../audio/desktop-audio-output";

export interface KeyStore {
  /** The saved key, or null when the user hasn't entered one. */
  read(): Promise<string | null>;
  write(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** The desktop app: `secrets.rs`, over Tauri IPC. */
export function desktopKeyStore(invoke: Invoke): KeyStore {
  return {
    async read() {
      return (await invoke<string | null>("api_key_read")) ?? null;
    },
    async write(key) {
      await invoke("api_key_write", { key });
    },
    async clear() {
      await invoke("api_key_clear");
    },
  };
}

/** The key under which the browser dev host stores the key. */
export const BROWSER_KEY = "soundcheck.claude-api-key";

/**
 * The browser dev host only. Local storage is not a credential store: the
 * MVP is the desktop app, and this keeps `pnpm dev` usable without it.
 */
export function browserKeyStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">): KeyStore {
  return {
    read: () => Promise.resolve(storage.getItem(BROWSER_KEY)),
    write: (key) => Promise.resolve(storage.setItem(BROWSER_KEY, key)),
    clear: () => Promise.resolve(storage.removeItem(BROWSER_KEY)),
  };
}

/** Keeps the key for this run only, where there is nowhere to save it. */
export function memoryKeyStore(key: string | null = null): KeyStore {
  let saved = key;
  return {
    read: () => Promise.resolve(saved),
    write: (next) => {
      saved = next;
      return Promise.resolve();
    },
    clear: () => {
      saved = null;
      return Promise.resolve();
    },
  };
}

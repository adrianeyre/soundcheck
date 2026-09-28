import { useSyncExternalStore } from "react";

import { checkConnection, readSettings, saveSettings, type Connection, type Settings } from "./connection";
import { DEFAULT_PROVIDER, type ProviderId } from "./catalogue";
import { checkJevConnection, type JevConnection } from "./jev";
import type { KeyStore } from "./key-store";

export interface AssistantSettingsState {
  /** The saved provider and connections, or null when none are. */
  settings: Settings | null;
  /** The key store has been read, so `settings` is what it holds. */
  loaded: boolean;
  /** Why the last read, save or forget failed. */
  error: string | null;
}

/**
 * The Assistant's saved connection, shared by the Request box on the Editor
 * page and the Assistant settings on the Settings page: whatever one saves,
 * the other shows at once. It is read from the platform's key store once,
 * and lives there, never in a Project.
 */
export class AssistantSettingsStore {
  private state: AssistantSettingsState = { settings: null, loaded: false, error: null };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly keyStore: KeyStore) {
    keyStore
      .read()
      .then((saved) => this.set({ settings: saved === null ? null : readSettings(saved), loaded: true }))
      .catch((reason: unknown) =>
        this.set({ loaded: true, error: `The saved API key could not be read: ${String(reason)}` }),
      );
  }

  get snapshot(): AssistantSettingsState {
    return this.state;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Saves `connection` for `provider`, keeping the others for switching back to. True when it was saved. */
  async save(provider: ProviderId, connection: Connection): Promise<boolean> {
    const wrong = checkConnection(connection);
    if (wrong) {
      this.set({ error: wrong });
      return false;
    }
    return this.write({ ...this.state.settings, provider, connections: { ...this.state.settings?.connections, [provider]: connection } });
  }

  /**
   * Makes `provider`, already set up, the one the Assistant uses, as the
   * Request box's picker does; its connection and the others stay as they are.
   */
  async choose(provider: ProviderId): Promise<boolean> {
    const settings = this.state.settings;
    if (!settings?.connections[provider]) {
      this.set({ error: "That provider isn't set up yet: enter its key in Settings." });
      return false;
    }
    if (settings.provider === provider) return true;
    return this.write({ ...settings, provider });
  }

  /** Saves Jev's connection, or, with null, forgets it; the providers' stay as they are. */
  async saveJev(jev: JevConnection | null): Promise<boolean> {
    const wrong = jev && checkJevConnection(jev);
    if (wrong) {
      this.set({ error: wrong });
      return false;
    }
    const { jev: _, ...rest } = this.state.settings ?? { provider: DEFAULT_PROVIDER, connections: {} };
    return this.write(jev ? { ...rest, jev } : rest);
  }

  private async write(next: Settings): Promise<boolean> {
    try {
      await this.keyStore.write(saveSettings(next));
      this.set({ settings: next, error: null });
      return true;
    } catch (reason) {
      this.set({ error: `The API key could not be saved: ${String(reason)}` });
      return false;
    }
  }

  async forget(): Promise<void> {
    try {
      await this.keyStore.clear();
      this.set({ settings: null, error: null });
    } catch (reason) {
      this.set({ error: `The API key could not be forgotten: ${String(reason)}` });
    }
  }

  private set(change: Partial<AssistantSettingsState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}

const stores = new WeakMap<KeyStore, AssistantSettingsStore>();

/** The one store for `keyStore`, so every component using it agrees. */
export function assistantSettingsFor(keyStore: KeyStore): AssistantSettingsStore {
  let store = stores.get(keyStore);
  if (!store) {
    store = new AssistantSettingsStore(keyStore);
    stores.set(keyStore, store);
  }
  return store;
}

const NO_JEV = () => () => {};

/**
 * Jev's saved connection, where `keyStore` has one; null without a key store,
 * or until Jev is set up. For the Widgets beside the Request box that ask Jev.
 */
export function useJevConnection(keyStore: KeyStore | undefined): JevConnection | null {
  const store = keyStore && assistantSettingsFor(keyStore);
  return useSyncExternalStore(store ? store.subscribe : NO_JEV, () => store?.snapshot.settings?.jev ?? null);
}

export function useAssistantSettings(keyStore: KeyStore): [AssistantSettingsState, AssistantSettingsStore] {
  const store = assistantSettingsFor(keyStore);
  const state = useSyncExternalStore(store.subscribe, () => store.snapshot);
  return [state, store];
}

import { useSyncExternalStore } from "react";

import { checkConnection, readSettings, saveSettings, type Connection, type Settings } from "./connection";
import type { ProviderId } from "./catalogue";
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
    const next: Settings = { provider, connections: { ...this.state.settings?.connections, [provider]: connection } };
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

export function useAssistantSettings(keyStore: KeyStore): [AssistantSettingsState, AssistantSettingsStore] {
  const store = assistantSettingsFor(keyStore);
  const state = useSyncExternalStore(store.subscribe, () => store.snapshot);
  return [state, store];
}

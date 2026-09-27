import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { LibraryStorage } from "./library-storage";
import { PresetLibrary, type PresetSettings, type PresetTarget, type UserPreset } from "./preset-library";

/** The Preset library, as every picker, panel and the Assistant see it. */
export interface PresetLibraryValue {
  /** Every User Preset, once the library has been read; none before. */
  userPresets: readonly UserPreset[];
  /** Whether there is a library to save into: not in a test that gives none. */
  available: boolean;
  /** Each rejects with the reason when the change can't be made. Saving resolves to the Preset saved. */
  save: (target: PresetTarget, name: string, settings: PresetSettings) => Promise<UserPreset>;
  rename: (target: PresetTarget, name: string, newName: string) => Promise<void>;
  remove: (target: PresetTarget, name: string) => Promise<void>;
}

const unavailable = () => Promise.reject(new Error("There is no Preset library here"));

const PresetLibraryContext = createContext<PresetLibraryValue>({
  userPresets: [],
  available: false,
  save: unavailable,
  rename: unavailable,
  remove: unavailable,
});

/**
 * Reads the library once and hands it to everything below, keeping them all
 * in step as Presets are saved, renamed and deleted. The library belongs to
 * the app, not the Project, so it outlives New and Open.
 */
export function PresetLibraryProvider({ storage, children }: { storage: LibraryStorage; children: ReactNode }) {
  const library = useMemo(() => new PresetLibrary(storage), [storage]);
  const [userPresets, setUserPresets] = useState<readonly UserPreset[]>([]);

  useEffect(() => {
    let current = true;
    library.load().then(
      (presets) => current && setUserPresets(presets),
      // An unreadable library leaves only the Factory Presets.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [library]);

  const value = useMemo<PresetLibraryValue>(() => {
    const refresh = () => setUserPresets(library.userPresets);
    return {
      userPresets,
      available: true,
      async save(target, name, settings) {
        const preset = await library.save(target, name, settings);
        refresh();
        return preset;
      },
      async rename(target, name, newName) {
        await library.rename(target, name, newName);
        refresh();
      },
      async remove(target, name) {
        await library.delete(target, name);
        refresh();
      },
    };
  }, [library, userPresets]);

  return <PresetLibraryContext.Provider value={value}>{children}</PresetLibraryContext.Provider>;
}

export function usePresetLibrary(): PresetLibraryValue {
  return useContext(PresetLibraryContext);
}

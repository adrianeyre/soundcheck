import { useEffect, useState, useSyncExternalStore } from "react";

import type { PluginFolder } from "./plugin-folder";
import { installedPlugins, setInstalledPlugins, subscribeToPlugins } from "./plugins";

/**
 * Read the Plugins folder once, so every Project finds the Plugins it uses.
 * A folder that can't be read leaves the list empty: a Project using a
 * Plugin then opens with it missing.
 */
export function useInstalledPlugins(folder: PluginFolder | undefined) {
  useEffect(() => {
    if (!folder) return;
    let current = true;
    folder.list().then(
      (plugins) => current && setInstalledPlugins(plugins),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [folder]);
  return useSyncExternalStore(subscribeToPlugins, installedPlugins);
}

/**
 * The installed WASM Plugins, and a way to install another from its
 * `.wasm`. Installing one a Project is missing brings its sound back.
 */
export function PluginSettings({ folder }: { folder: PluginFolder }) {
  const plugins = useSyncExternalStore(subscribeToPlugins, installedPlugins);
  const [status, setStatus] = useState<string | null>(null);

  const install = async (file: File) => {
    try {
      const installed = await folder.install(new Uint8Array(await file.arrayBuffer()));
      const others = installedPlugins().filter((plugin) => plugin.manifest.id !== installed.manifest.id);
      setInstalledPlugins([...others, installed]);
      setStatus(`Installed ${installed.manifest.name} ${installed.manifest.version}.`);
    } catch (error) {
      setStatus(`That Plugin couldn't be installed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div>
      {plugins.length === 0 ? (
        <p className="hint">No Plugins installed.</p>
      ) : (
        <ul aria-label="Installed Plugins">
          {plugins.map(({ manifest }) => (
            <li key={manifest.id}>
              {manifest.name} <span className="hint">{`${manifest.version} (${manifest.id})`}</span>
            </li>
          ))}
        </ul>
      )}
      <label className="field mt-3">
        Install a Plugin
        <input
          type="file"
          accept=".wasm,application/wasm"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void install(file);
          }}
        />
      </label>
      {status && (
        <p className="hint" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

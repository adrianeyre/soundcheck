import { useContext, useState } from "react";

import { isVst3Id } from "../project/model";
import { vst3ClassOf, vst3Instance } from "./vst3";
import { useVst3Context, useVst3Instances, Vst3UnavailableContext } from "./Vst3Settings";

export interface Vst3StatusProps {
  /** Its instance's key: the Effect's id, or `vst3InstrumentKey` of its Track. */
  instanceKey: string;
  pluginId: string;
  /** Its name and vendor, as the Project saved them. */
  name: string;
  vendor: string;
  /** What it is called on screen, such as "Tilt (slot 2)". */
  label: string;
  /** What the musician hears while it isn't running. */
  silence: "bypassed" | "silent";
}

/**
 * Where a VST3 Effect or Instrument is: missing (in the Browser Version, on
 * macOS, or not installed on this machine), loading, crashed or failed, with
 * **Reload** for the last two; and, once it runs, a button to open its own
 * window. Nothing for a WASM Plugin.
 */
export function Vst3Status({ instanceKey, pluginId, name, vendor, label, silence }: Vst3StatusProps) {
  const vst3 = useVst3Context();
  const unavailable = useContext(Vst3UnavailableContext);
  useVst3Instances();
  const [error, setError] = useState<string | null>(null);
  if (!isVst3Id(pluginId)) return null;
  const meanwhile =
    silence === "bypassed"
      ? "The audio passes through it untouched"
      : "The Track is silent";
  const status = (text: string) => (
    <p className="hint mt-3" role="status" aria-label={`${label} VST3 Plugin`}>
      {text}
    </p>
  );

  if (!vst3 && unavailable) {
    return status(`${unavailable}, so ${name} (${vendor}) doesn't run here. ${meanwhile}, and its settings and state are kept exactly.`);
  }
  if (!vst3) {
    return status(
      `${name} (${vendor}) is a VST3 Plugin, which only the Desktop App hosts. ${meanwhile}, and its settings and state are kept exactly.`,
    );
  }
  const instance = vst3Instance(instanceKey);
  if (!instance || instance.pluginId !== pluginId) {
    return status(
      vst3ClassOf(pluginId)
        ? `Waiting for ${name}…`
        : `Missing Plugin: ${name} (${vendor}) isn't installed on this machine. ${meanwhile}, and its settings and state are kept; install it and Rescan in Settings to hear it again.`,
    );
  }
  if (instance.status === "loading") return status(`Waiting for ${name}… A Plugin can take up to a minute to load.`);

  const reload = (
    <button type="button" className="btn-sm" aria-label={`Reload ${label}`} onClick={() => void vst3.sync.reload(instanceKey)}>
      Reload
    </button>
  );
  if (instance.status === "failed") {
    return (
      <div className="row mt-3">
        {status(`${name} couldn't be loaded: ${instance.error}. ${meanwhile}.`)}
        {reload}
      </div>
    );
  }
  if (instance.status === "crashed") {
    return (
      <div className="row mt-3">
        {status(`${name} crashed, or stopped answering, and was closed. ${meanwhile} until you reload it, from its settings as they were last saved or fetched.`)}
        {reload}
      </div>
    );
  }
  if (!instance.editor) return null;
  const toggle = async () => {
    setError(null);
    try {
      if (instance.open) await vst3.sync.closeEditor(instanceKey);
      else await vst3.sync.openEditor(instanceKey);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <div className="row mt-3">
      <button type="button" className="btn-sm" aria-pressed={instance.open} onClick={() => void toggle()}>
        {instance.open ? `Close ${name}'s window` : `Open ${name}'s window`}
      </button>
      {error && (
        <span className="hint" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

import { Puzzle } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Control } from "../effect/InsertChainPanel";
import { installedPlugins, subscribeToPlugins } from "../plugin/plugins";
import { vst3InstrumentKey } from "../plugin/vst3";
import { useVst3Instances } from "../plugin/Vst3Settings";
import { Vst3Status } from "../plugin/Vst3Status";
import { PresetActions, PresetSelect } from "../preset/PresetControls";
import { instrumentPresetTarget } from "../preset/preset-library";
import { isVst3Id, type PluginInstrument } from "../project/model";
import { instrumentName, isMissingInstrument, pluginInstrumentTable } from "./instrument-table";

export interface PluginInstrumentPanelProps {
  trackId: string;
  trackName: string;
  instrument: PluginInstrument;
  onChange: (settings: Record<string, number>) => void;
}

/**
 * A Track's Plugin Instrument: a control for every setting its manifest
 * declares, as an Effect's are drawn, or, while its Plugin is missing, why
 * the Track is silent. A VST3 Instrument also says whether it has loaded,
 * and opens its own window.
 *
 * An installed one loads and saves Presets as a Plugin Effect does: a
 * Preset is its settings by name, and loading one is a single change, so
 * one undo. For a VST3 Instrument those are its automatable settings, as
 * for a VST3 Effect; the state it keeps in the Project isn't in a Preset,
 * and the Plugin's own window has its own presets for that.
 */
export function PluginInstrumentPanel({ trackId, trackName, instrument, onChange }: PluginInstrumentPanelProps) {
  // Drawn again when a Plugin is installed or taken away, or a VST3 instance changes.
  useSyncExternalStore(subscribeToPlugins, installedPlugins);
  useVst3Instances();
  const name = instrumentName(instrument);
  const label = `${trackName} ${name}`;
  const missing = isMissingInstrument(instrument);
  const target = instrumentPresetTarget(instrument);
  return (
    <section aria-label={label} className="panel">
      <div className="panel-head">
        <h2 className="kind-stripe" data-track-kind="instrument">
          <Puzzle size={18} aria-hidden />
          {name} — {trackName}
        </h2>
        {!missing && (
          <div className="row">
            <PresetSelect
              target={target}
              label={`${label} preset`}
              value={null}
              placeholder="Load a preset…"
              onPick={(preset) => onChange({ ...(preset.settings as Record<string, number>) })}
            />
            <PresetActions target={target} label={label} settings={instrument.settings} />
          </div>
        )}
      </div>
      {instrument.vst3 && (
        <Vst3Status
          instanceKey={vst3InstrumentKey(trackId)}
          pluginId={instrument.plugin.id}
          name={instrument.vst3.name}
          vendor={instrument.vst3.vendor}
          label={trackName}
          silence="silent"
        />
      )}
      {missing ? (
        !isVst3Id(instrument.plugin.id) && (
        <p className="hint" role="status" aria-label={`${trackName} missing Plugin`}>
          Missing Plugin: {instrument.plugin.id} {instrument.plugin.version} isn't installed. The Track is silent and its
          settings are kept; install the Plugin to hear it again.
        </p>
        )
      ) : (
        <div className="param-grid">
          {pluginInstrumentTable(instrument).map((param) => (
            <Control key={param.name} param={param} settings={instrument.settings} onChange={onChange} />
          ))}
        </div>
      )}
    </section>
  );
}

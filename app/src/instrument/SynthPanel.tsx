import { KeyboardMusic } from "lucide-react";
import { PresetActions, PresetSelect } from "../preset/PresetControls";
import type { ListedPreset } from "../preset/preset-library";
import { SYNTH_PARAMS, type SynthParam, type SynthSettings } from "./synth-params";

export interface SynthPanelProps {
  trackName: string;
  preset: string | null;
  settings: SynthSettings;
  /** Only the settings given change. */
  onChange: (settings: Partial<SynthSettings>) => void;
}

/**
 * A control for every setting the Synth declares, drawn from its table: a
 * list to pick from where the setting has choices, a slider where it is a
 * number. Nothing here knows what any particular setting means, so a setting
 * added to the engine's table appears here as soon as the table is mirrored.
 */
export function SynthPanel({ trackName, preset, settings, onChange }: SynthPanelProps) {
  return (
    <section aria-label={`${trackName} Synth`} className="panel">
      <div className="panel-head">
        <h2 className="kind-stripe" data-track-kind="instrument">
          <KeyboardMusic size={18} aria-hidden />
          Synth — {trackName}
          {preset ? ` (${preset})` : ""}
        </h2>
        <div className="row">
          <PresetActions target="synth" label={`${trackName} Synth`} settings={settings} />
        </div>
      </div>
      <div className="param-grid">
        {SYNTH_PARAMS.map((param) => (
          <Control key={param.name} param={param} settings={settings} onChange={onChange} />
        ))}
      </div>
    </section>
  );
}

function Control({
  param,
  settings,
  onChange,
}: {
  param: SynthParam;
  settings: SynthSettings;
  onChange: (settings: Partial<SynthSettings>) => void;
}) {
  const value = settings[param.name];
  const set = (next: string | number) => onChange({ [param.name]: next } as Partial<SynthSettings>);

  return (
    <label className="param">
      <span className="num">
        {param.label}
        {param.choices.length === 0 && `: ${round(value as number)}${param.unit && ` ${param.unit}`}`}
      </span>
      {param.choices.length > 0 ? (
        <select value={String(value)} onChange={(event) => set(event.target.value)}>
          {param.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="range"
          min={param.min}
          max={param.max}
          step={param.step > 0 ? param.step : "any"}
          value={value as number}
          onChange={(event) => set(Number(event.target.value))}
        />
      )}
    </label>
  );
}

/** Enough decimals to show a millisecond, without a long tail of them. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface PresetPickerProps {
  trackName: string;
  preset: string | null;
  onPick: (preset: ListedPreset) => void;
}

/** The Synth's Presets for one Track: the Factory ones by category, then the User ones. */
export function PresetPicker({ trackName, preset, onPick }: PresetPickerProps) {
  return (
    <PresetSelect target="synth" label={`${trackName} preset`} value={preset} placeholder="Preset…" onPick={onPick} />
  );
}

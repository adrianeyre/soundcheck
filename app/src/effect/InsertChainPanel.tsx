import { ChevronDown, ChevronUp, Plus, Power, Trash2 } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { installedPlugin, installedPlugins, subscribeToPlugins } from "../plugin/plugins";
import { isVst3Instrument, vst3Classes } from "../plugin/vst3";
import { useVst3Context, useVst3Instances } from "../plugin/Vst3Settings";
import { Vst3Status } from "../plugin/Vst3Status";
import { PresetActions, PresetSelect } from "../preset/PresetControls";
import { presetTargetOf } from "../preset/preset-library";
import type { ChainTarget, Command } from "../project/commands";
import { createEffect, type Effect, type EffectType, type EqSettings, isVst3Id } from "../project/model";
import { LIMITS } from "../project/validate";
import { EFFECT_NAMES, EFFECT_TYPES, eqResponseDb } from "./effect-params";
import { createPluginEffect, effectName, effectTable, isMissingPlugin, type TableParam } from "./effect-table";
import { EffectVisual } from "./effect-visuals";

export interface InsertChainPanelProps {
  /** The Track's name, or "Master". */
  name: string;
  target: ChainTarget;
  chain: readonly Effect[];
  /** Every edit is a Project command, so every edit undoes. */
  onCommand: (command: Command) => void;
  /**
   * The engine's gain-reduction meters for this chain, in dB, one per Effect
   * in chain order; absent when no audio is running.
   */
  gainReduction?: readonly number[];
}

/**
 * One Insert Chain: its Effects in the order the signal meets them, each
 * with buttons to move, bypass and remove it and a control for every setting
 * its table declares, and a way to add another. Every built-in Effect draws
 * a picture of its settings (the EQ its frequency response, the dynamics
 * their level curves, the Reverb its tail and so on), the Compressor, Gate
 * and Limiter show how far the engine is pulling the level down, and every
 * Effect offers its Presets, Factory and User, and saves its settings as a
 * User Preset.
 */
export function InsertChainPanel({ name, target, chain, onCommand, gainReduction }: InsertChainPanelProps) {
  // A built-in by its type, an installed Plugin Effect as `plugin:<id>`, or
  // a VST3 Effect the scan found as `vst3:<class id>`.
  const [adding, setAdding] = useState<string>("eq");
  const plugins = useSyncExternalStore(subscribeToPlugins, installedPlugins).filter(
    (plugin) => plugin.manifest.kind === "effect",
  );
  const vst3 = useVst3Context();
  useVst3Instances();
  const vst3Effects = vst3 ? vst3Classes().filter(({ vst3Class }) => !isVst3Instrument(vst3Class)) : [];
  // Loading a VST3 Effect before it is added, or why it wouldn't.
  const [loading, setLoading] = useState<string | null>(null);
  const [vst3Error, setVst3Error] = useState<string | null>(null);
  const full = chain.length >= LIMITS.effects;
  const toAdd = (): Effect | null => {
    if (!adding.startsWith("plugin:")) return createEffect(adding as EffectType);
    const plugin = installedPlugin(adding.slice("plugin:".length));
    return plugin ? createPluginEffect(plugin.manifest) : null;
  };
  /** A VST3 Effect is loaded first, so it starts at the Plugin's own settings, and then added. */
  const addVst3 = async (cid: string) => {
    const found = vst3Effects.find(({ vst3Class }) => vst3Class.cid === cid);
    if (!vst3 || !found) return;
    setLoading(found.vst3Class.name);
    setVst3Error(null);
    try {
      const manifest = await vst3.sync.createEffect(found.vst3Class, found.bundle);
      const result = vst3.execute({ type: "addEffect", target, effect: createPluginEffect(manifest, manifest.key) });
      if (!result.ok) {
        vst3.sync.discard(manifest.key);
        setVst3Error(result.error);
      }
    } catch (reason) {
      setVst3Error(`${found.vst3Class.name} couldn't be loaded: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setLoading(null);
    }
  };

  return (
    <section aria-label={`${name} Insert Chain`} className="panel mt-3">
      <div className="panel-head">
        <h3>Insert Chain — {name}</h3>
      </div>
      {chain.length === 0 && <p className="hint">No Effects: the signal passes through untouched.</p>}
      <ol className="chain">
        {chain.map((effect, index) => {
          const label = `${effectName(effect)} (slot ${index + 1})`;
          const missing = isMissingPlugin(effect);
          return (
            <li key={effect.id} aria-label={label} className="effect" data-bypassed={effect.bypassed}>
              <div className="row">
                <strong className="effect-name" style={{ marginRight: "auto" }}>
                  {index + 1}. {effectName(effect)}
                  {effect.bypassed && <span className="hint"> (bypassed)</span>}
                </strong>
                <button
                  type="button"
                  aria-label={`Move ${label} up`}
                  className="btn-sm btn-icon"
                  disabled={index === 0}
                  onClick={() => onCommand({ type: "moveEffect", effectId: effect.id, index: index - 1 })}
                >
                  <ChevronUp size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${label} down`}
                  className="btn-sm btn-icon"
                  disabled={index === chain.length - 1}
                  onClick={() => onCommand({ type: "moveEffect", effectId: effect.id, index: index + 1 })}
                >
                  <ChevronDown size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Bypass ${label}`}
                  aria-pressed={effect.bypassed}
                  className="btn-sm btn-mute"
                  onClick={() => onCommand({ type: "setEffectBypassed", effectId: effect.id, bypassed: !effect.bypassed })}
                >
                  <Power size={14} aria-hidden />
                  Bypass
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${label}`}
                  className="btn-sm"
                  onClick={() => onCommand({ type: "removeEffect", effectId: effect.id })}
                >
                  <Trash2 size={14} aria-hidden />
                  Remove
                </button>
              </div>
              {effect.type === "eq" && <EqCurve label={label} settings={effect.settings} />}
              <EffectVisual effect={effect} label={label} />
              {(effect.type === "compressor" || effect.type === "gate" || effect.type === "limiter") && (
                <GainReductionMeter label={label} db={effect.bypassed ? 0 : (gainReduction?.[index] ?? 0)} />
              )}
              {effect.type === "plugin" && effect.vst3 && (
                <Vst3Status
                  instanceKey={effect.id}
                  pluginId={effect.plugin.id}
                  name={effect.vst3.name}
                  vendor={effect.vst3.vendor}
                  label={label}
                  silence="bypassed"
                />
              )}
              {missing && !isVst3Id(effect.plugin.id) && (
                <p className="hint mt-3" role="status" aria-label={`${label} missing Plugin`}>
                  Missing Plugin: {effect.plugin.id} {effect.plugin.version} isn't installed. The audio passes through
                  it untouched and its settings are kept; install the Plugin to hear it again.
                </p>
              )}
              {!missing && (
              <div className="row hint mt-3">
                <span>Preset</span>
                <PresetSelect
                  target={presetTargetOf(effect)}
                  label={`${label} preset`}
                  value={null}
                  placeholder="Load a preset…"
                  onPick={(preset) =>
                    onCommand({
                      type: "setEffectSettings",
                      effectId: effect.id,
                      settings: { ...(preset.settings as Record<string, number>) },
                    })
                  }
                />
                <PresetActions target={presetTargetOf(effect)} label={label} settings={effect.settings} />
              </div>
              )}
              <div className="param-grid mt-3">
                {effectTable(effect).map((param) => (
                  <Control
                    key={param.name}
                    param={param}
                    disabled={unused(effect, param)}
                    settings={effect.settings}
                    onChange={(settings) => onCommand({ type: "setEffectSettings", effectId: effect.id, settings })}
                  />
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="row">
      <select
        aria-label={`Effect to add to ${name}`}
        value={adding}
        onChange={(event) => setAdding(event.target.value)}
      >
        {EFFECT_TYPES.map((type) => (
          <option key={type} value={type}>
            {EFFECT_NAMES[type]}
          </option>
        ))}
        {plugins.map(({ manifest }) => (
          <option key={manifest.id} value={`plugin:${manifest.id}`}>
            {manifest.name} (Plugin)
          </option>
        ))}
        {vst3Effects.map(({ bundle, vst3Class }) => (
          <option key={`${bundle} ${vst3Class.cid}`} value={`vst3:${vst3Class.cid}`}>
            {vst3Class.name} (VST3)
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={full || loading !== null}
        title={full ? `An Insert Chain holds at most ${LIMITS.effects} Effects` : undefined}
        onClick={() => {
          if (adding.startsWith("vst3:")) {
            void addVst3(adding.slice("vst3:".length));
            return;
          }
          const effect = toAdd();
          if (effect) onCommand({ type: "addEffect", target, effect });
        }}
      >
        <Plus size={16} aria-hidden />
        Add Effect
      </button>
      </div>
      {loading && (
        <p className="hint" role="status">
          {`Loading ${loading}…`}
        </p>
      )}
      {vst3Error && (
        <p className="hint" role="alert">
          {vst3Error}
        </p>
      )}
    </section>
  );
}

/**
 * Whether `param` does nothing with the Effect's other settings as they are:
 * a synced Delay ignores its time in milliseconds, an unsynced one its note
 * value.
 */
function unused(effect: Effect, param: TableParam): boolean {
  if (effect.type !== "delay") return false;
  const synced = effect.settings.sync === "on";
  return (param.name === "timeMs" && synced) || (param.name === "note" && !synced);
}

/** A control for one setting, drawn from its table, as the Synth's are. */
export function Control({
  param,
  settings,
  disabled = false,
  onChange,
}: {
  param: TableParam;
  settings: object;
  disabled?: boolean;
  onChange: (settings: Record<string, number>) => void;
}) {
  // A Plugin's setting it has no value for yet is at its default.
  const value = (settings as Record<string, string | number | undefined>)[param.name] ?? param.default;
  // A choice goes by its name, as the table's interface has it.
  const set = (next: string | number) => onChange({ [param.name]: next } as Record<string, number>);

  return (
    <label className="param">
      <span className="num">
        {param.label}
        {param.choices.length === 0 && `: ${round(value as number)}${param.unit && ` ${param.unit}`}`}
      </span>
      {param.choices.length > 0 ? (
        <select
          aria-label={param.label}
          disabled={disabled}
          value={String(value)}
          onChange={(event) => set(event.target.value)}
        >
          {param.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="range"
          aria-label={param.label}
          aria-valuetext={`${round(value as number)}${param.unit && ` ${param.unit}`}`}
          min={param.min}
          max={param.max}
          step={param.step > 0 ? param.step : "any"}
          disabled={disabled}
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

/** The gain-reduction meter's full scale, in dB. */
const GAIN_REDUCTION_DB = 24;
const GAIN_REDUCTION_WIDTH = 240;

/**
 * How far the Compressor is pulling the level down, exactly as the engine
 * measured it: a bar that grows from the left, up to 24 dB.
 */
function GainReductionMeter({ label, db }: { label: string; db: number }) {
  const reduction = Math.max(0, db);
  const fraction = Math.min(1, reduction / GAIN_REDUCTION_DB);
  return (
    <div className="row hint mt-3">
      <span>Gain reduction</span>
      <div
        role="meter"
        aria-label={`${label} gain reduction`}
        aria-valuemin={0}
        aria-valuemax={GAIN_REDUCTION_DB}
        aria-valuenow={Number(reduction.toFixed(1))}
        aria-valuetext={`${reduction.toFixed(1)} dB`}
        className="meter"
        style={{ width: GAIN_REDUCTION_WIDTH, height: 10 }}
      >
        <div
          aria-hidden
          className="meter-fill"
          style={{ left: 0, height: "100%", width: `${fraction * 100}%`, background: "var(--warning)" }}
        />
      </div>
      <span className="num">{reduction > 0 ? `-${reduction.toFixed(1)}` : "0.0"} dB</span>
    </div>
  );
}

const CURVE_WIDTH = 320;
const CURVE_HEIGHT = 120;
const CURVE_POINTS = 160;
const [LOWEST_HZ, HIGHEST_HZ] = [20, 20_000];
/** The display runs from -24 to +24 dB, the gains the EQ's bands reach. */
const CURVE_DB = 24;

/**
 * The frequency points the curve is drawn through, from 20 Hz to 20 kHz on a
 * log scale, with where each lands across the display.
 */
function curveFrequencies(points = CURVE_POINTS): number[] {
  return Array.from({ length: points }, (_, index) => LOWEST_HZ * (HIGHEST_HZ / LOWEST_HZ) ** (index / (points - 1)));
}

/**
 * The EQ's frequency response, worked out from the same filters the engine
 * runs: 20 Hz to 20 kHz across, ±24 dB up and down.
 */
function EqCurve({ label, settings }: { label: string; settings: EqSettings }) {
  const frequencies = curveFrequencies();
  const y = (db: number) => ((CURVE_DB - Math.max(-CURVE_DB, Math.min(CURVE_DB, db))) / (2 * CURVE_DB)) * CURVE_HEIGHT;
  const path = frequencies
    .map((frequency, index) => {
      const x = (index / (frequencies.length - 1)) * CURVE_WIDTH;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y(eqResponseDb(settings, frequency)).toFixed(1)}`;
    })
    .join(" ");
  const decades = [100, 1_000, 10_000].map(
    (frequency) => (Math.log10(frequency / LOWEST_HZ) / Math.log10(HIGHEST_HZ / LOWEST_HZ)) * CURVE_WIDTH,
  );
  return (
    <svg
      role="img"
      aria-label={`${label} frequency response`}
      width={CURVE_WIDTH}
      height={CURVE_HEIGHT}
      viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
      className="eq-curve"
    >
      {decades.map((x) => (
        <line key={x} x1={x} x2={x} y1={0} y2={CURVE_HEIGHT} stroke="var(--lane-line)" />
      ))}
      <line x1={0} x2={CURVE_WIDTH} y1={y(0)} y2={y(0)} stroke="var(--lane-bar)" />
      <path data-testid="eq-curve" d={path} fill="none" stroke="var(--primary)" strokeWidth={2} />
    </svg>
  );
}

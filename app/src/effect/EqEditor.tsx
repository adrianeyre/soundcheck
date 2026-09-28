import { Plus, Power, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useRef, useState } from "react";

import { PresetActions, PresetSelect } from "../preset/PresetControls";
import type { ChainTarget, Command } from "../project/commands";
import { createEffect, type Effect, type EqSettings, type Project } from "../project/model";
import { LIMITS } from "../project/validate";
import { defaultEffectSettings, eqResponseDb } from "./effect-params";

/** One of the EQ's bands, as the display draws and drags it. */
export interface EqBand {
  id: "lowCut" | "lowShelf" | "band1" | "band2" | "band3" | "highShelf" | "highCut";
  label: string;
  /** Its settings' names: a cut has no gain and a shelf no Q. */
  hz: keyof EqSettings;
  gain?: keyof EqSettings;
  q?: keyof EqSettings;
  /** A cut is switched in and out. */
  on?: keyof EqSettings;
  colour: string;
}

export const EQ_BANDS: readonly EqBand[] = [
  { id: "lowCut", label: "Low cut", hz: "lowCutHz", on: "lowCut", colour: "var(--kind-audio)" },
  { id: "lowShelf", label: "Low shelf", hz: "lowShelfHz", gain: "lowShelfGainDb", colour: "var(--kind-drum)" },
  { id: "band1", label: "Band 1", hz: "band1Hz", gain: "band1GainDb", q: "band1Q", colour: "var(--warning)" },
  { id: "band2", label: "Band 2", hz: "band2Hz", gain: "band2GainDb", q: "band2Q", colour: "var(--play)" },
  { id: "band3", label: "Band 3", hz: "band3Hz", gain: "band3GainDb", q: "band3Q", colour: "var(--focus)" },
  { id: "highShelf", label: "High shelf", hz: "highShelfHz", gain: "highShelfGainDb", colour: "var(--kind-instrument)" },
  { id: "highCut", label: "High cut", hz: "highCutHz", on: "highCut", colour: "var(--record)" },
];

const [LOW_HZ, HIGH_HZ] = [20, 20_000];
const MAX_DB = 24;
const [MIN_Q, MAX_Q] = [0.1, 18];
const WIDTH = 800;
const HEIGHT = 260;
const POINTS = 240;
const FREQUENCY_LINES = [20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000];
const DB_LINES = [-24, -18, -12, -6, 0, 6, 12, 18, 24];

/** Where a frequency lands across the display, 0 to `WIDTH`, on a log scale. */
export function hzToX(hz: number): number {
  return (Math.log10(hz / LOW_HZ) / Math.log10(HIGH_HZ / LOW_HZ)) * WIDTH;
}

export function xToHz(x: number): number {
  const fraction = Math.min(1, Math.max(0, x / WIDTH));
  return LOW_HZ * (HIGH_HZ / LOW_HZ) ** fraction;
}

export function dbToY(db: number): number {
  return ((MAX_DB - Math.max(-MAX_DB, Math.min(MAX_DB, db))) / (2 * MAX_DB)) * HEIGHT;
}

export function yToDb(y: number): number {
  return Math.max(-MAX_DB, Math.min(MAX_DB, MAX_DB - (y / HEIGHT) * 2 * MAX_DB));
}

/** The settings with only `band` doing anything: every other gain at 0 and the other cut out. */
export function soloBand(settings: EqSettings, band: EqBand): EqSettings {
  const flat: EqSettings = {
    ...settings,
    lowCut: "off",
    highCut: "off",
    lowShelfGainDb: 0,
    band1GainDb: 0,
    band2GainDb: 0,
    band3GainDb: 0,
    highShelfGainDb: 0,
  };
  const own: Partial<Record<keyof EqSettings, string | number>> = {};
  if (band.gain) own[band.gain] = settings[band.gain];
  if (band.on) own[band.on] = settings[band.on];
  return { ...flat, ...own } as EqSettings;
}

function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10_000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`;
}

function pathOf(settings: EqSettings): string {
  return Array.from({ length: POINTS }, (_, index) => {
    const x = (index / (POINTS - 1)) * WIDTH;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${dbToY(eqResponseDb(settings, xToHz(x))).toFixed(1)}`;
  }).join(" ");
}

/** Every channel with an Insert Chain, as the Mixer names them. */
function channelsOf(project: Project): { key: string; name: string; target: ChainTarget; chain: readonly Effect[] }[] {
  return [
    ...project.tracks.map((track) => ({ key: `track:${track.id}`, name: track.name, target: { trackId: track.id }, chain: track.insertChain })),
    ...project.buses.map((bus) => ({ key: `bus:${bus.id}`, name: `${bus.name} (Bus)`, target: { busId: bus.id }, chain: bus.insertChain })),
    { key: "master", name: "Master", target: "master" as const, chain: project.master.insertChain },
  ];
}

export interface EqEditorProps {
  project: Project;
  /** The channel to start on, such as the selected Clip's Track. */
  preferTrackId?: string | null;
  onCommand: (command: Command, label?: string) => void;
}

interface Drag {
  band: EqBand;
  pointer: number;
  draft: EqSettings;
}

/**
 * A large EQ, as FabFilter's Pro-Q or Logic's Channel EQ draws one: pick a
 * channel and one of its EQs, and see the whole curve and each band's own
 * beneath it, over a grid of frequencies and decibels. Each band is a node to
 * drag, across for its frequency and up and down for its gain; the wheel
 * over a bell changes its Q, and double-clicking a cut switches it in or
 * out. A drag is heard and undone as one change, when it is let go; every
 * band also has sliders, for the keyboard.
 */
export function EqEditor({ project, preferTrackId, onCommand }: EqEditorProps) {
  const channels = channelsOf(project);
  const [chosen, setChosen] = useState<string | null>(null);
  const [chosenEq, setChosenEq] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [focused, setFocused] = useState<EqBand["id"]>("band2");
  const svg = useRef<SVGSVGElement>(null);

  const channel =
    channels.find((c) => c.key === chosen) ??
    channels.find((c) => c.key === `track:${preferTrackId}`) ??
    channels.find((c) => c.chain.some((effect) => effect.type === "eq")) ??
    channels[channels.length - 1]!;
  const eqs = channel.chain.filter((effect): effect is Extract<Effect, { type: "eq" }> => effect.type === "eq");
  const eq = eqs.find((effect) => effect.id === chosenEq) ?? eqs[0] ?? null;
  const settings = drag?.draft ?? eq?.settings ?? null;
  const label = eq ? `${channel.name} EQ` : channel.name;
  const set = (next: Partial<EqSettings>, what = "Change EQ") =>
    eq && onCommand({ type: "setEffectSettings", effectId: eq.id, settings: next }, what);

  const point = (event: React.PointerEvent) => {
    const box = svg.current!.getBoundingClientRect();
    return {
      x: box.width > 0 ? ((event.clientX - box.left) / box.width) * WIDTH : 0,
      y: box.height > 0 ? ((event.clientY - box.top) / box.height) * HEIGHT : 0,
    };
  };
  const dragged = (band: EqBand, from: EqSettings, x: number, y: number): EqSettings => {
    const next: Record<string, string | number> = { ...from, [band.hz]: Math.round(xToHz(x)) };
    if (band.gain) next[band.gain] = Math.round(yToDb(y) * 10) / 10;
    if (band.on) next[band.on] = "on";
    return next as unknown as EqSettings;
  };

  const nodeY = (band: EqBand, of: EqSettings) =>
    band.gain ? dbToY(of[band.gain] as number) : dbToY(eqResponseDb(of, of[band.hz] as number));

  return (
    <section aria-label="EQ" className="panel">
      <div className="panel-head">
        <h2>
          <SlidersHorizontal size={18} aria-hidden />
          EQ: {channel.name}
        </h2>
        <div className="row">
          <label className="field-inline">
            Channel
            <select
              aria-label="EQ channel"
              value={channel.key}
              onChange={(event) => {
                setChosen(event.target.value);
                setChosenEq(null);
              }}
            >
              {channels.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                  {c.chain.some((effect) => effect.type === "eq") ? " ●" : ""}
                </option>
              ))}
            </select>
          </label>
          {eqs.length > 1 && (
            <select aria-label="Which EQ" value={eq?.id} onChange={(event) => setChosenEq(event.target.value)}>
              {eqs.map((effect, index) => (
                <option key={effect.id} value={effect.id}>
                  EQ {index + 1}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {!eq || !settings ? (
        <div className="stack">
          <p className="hint">{channel.name} has no EQ.</p>
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={channel.chain.length >= LIMITS.effects}
              onClick={() => onCommand({ type: "addEffect", target: channel.target, effect: createEffect("eq"), index: 0 }, "Add EQ")}
            >
              <Plus size={16} aria-hidden />
              Add an EQ to {channel.name}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="row hint">
            <button
              type="button"
              className="btn-sm btn-mute"
              aria-pressed={eq.bypassed}
              aria-label={`Bypass ${label}`}
              onClick={() => onCommand({ type: "setEffectBypassed", effectId: eq.id, bypassed: !eq.bypassed })}
            >
              <Power size={14} aria-hidden />
              Bypass
            </button>
            <button type="button" className="btn-sm" onClick={() => set(defaultEffectSettings("eq"), "Reset EQ")}>
              <RotateCcw size={14} aria-hidden />
              Flat
            </button>
            <PresetSelect
              target="eq"
              label={`${label} preset`}
              value={null}
              placeholder="Load a preset…"
              onPick={(preset) => set({ ...(preset.settings as Partial<EqSettings>) }, "Load EQ preset")}
            />
            <PresetActions target="eq" label={label} settings={eq.settings} />
          </div>
          <svg
            ref={svg}
            role="img"
            aria-label={`${label} frequency response`}
            className="eq-display"
            data-bypassed={eq.bypassed}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            onPointerMove={(event) => {
              if (!drag || event.pointerId !== drag.pointer) return;
              const { x, y } = point(event);
              setDrag({ ...drag, draft: dragged(drag.band, drag.draft, x, y) });
            }}
            onPointerUp={() => {
              if (!drag) return;
              const changed = Object.fromEntries(
                Object.entries(drag.draft).filter(([name, value]) => eq.settings[name as keyof EqSettings] !== value),
              ) as Partial<EqSettings>;
              setDrag(null);
              if (Object.keys(changed).length > 0) set(changed, `Move ${drag.band.label}`);
            }}
          >
            {FREQUENCY_LINES.map((hz) => (
              <g key={hz}>
                <line x1={hzToX(hz)} x2={hzToX(hz)} y1={0} y2={HEIGHT} stroke="var(--lane-line)" vectorEffect="non-scaling-stroke" />
                <text x={hzToX(hz) + 3} y={HEIGHT - 4} className="eq-axis">
                  {hz >= 1000 ? `${hz / 1000}k` : hz}
                </text>
              </g>
            ))}
            {DB_LINES.map((db) => (
              <g key={db}>
                <line
                  x1={0}
                  x2={WIDTH}
                  y1={dbToY(db)}
                  y2={dbToY(db)}
                  stroke={db === 0 ? "var(--lane-bar)" : "var(--lane-line)"}
                  vectorEffect="non-scaling-stroke"
                />
                {db !== 24 && db !== -24 && (
                  <text x={4} y={dbToY(db) - 3} className="eq-axis">
                    {db > 0 ? `+${db}` : db}
                  </text>
                )}
              </g>
            ))}
            {EQ_BANDS.filter((band) => (band.gain ? settings[band.gain] !== 0 : settings[band.on!] === "on")).map((band) => (
              <path
                key={band.id}
                d={`${pathOf(soloBand(settings, band))} L${WIDTH},${dbToY(0)} L0,${dbToY(0)} Z`}
                fill={band.colour}
                opacity={focused === band.id ? 0.28 : 0.12}
              />
            ))}
            <path data-testid="eq-display-curve" d={pathOf(settings)} fill="none" stroke="var(--primary)" strokeWidth={3} vectorEffect="non-scaling-stroke" />
            {EQ_BANDS.map((band) => {
              const active = band.gain ? true : settings[band.on!] === "on";
              const x = hzToX(settings[band.hz] as number);
              const y = nodeY(band, settings);
              return (
                <g
                  key={band.id}
                  className="eq-node"
                  data-active={active}
                  data-focused={focused === band.id}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.currentTarget.ownerSVGElement?.setPointerCapture?.(event.pointerId);
                    setFocused(band.id);
                    setDrag({ band, pointer: event.pointerId, draft: settings });
                  }}
                  onDoubleClick={() => band.on && set({ [band.on]: settings[band.on] === "on" ? "off" : "on" }, `Switch ${band.label}`)}
                  onWheel={(event) => {
                    if (!band.q) return;
                    const q = settings[band.q] as number;
                    set({ [band.q]: Math.round(Math.min(MAX_Q, Math.max(MIN_Q, q * (event.deltaY < 0 ? 1.15 : 1 / 1.15))) * 100) / 100 }, `Change ${band.label} Q`);
                  }}
                >
                  <title>{`${band.label}: ${formatHz(settings[band.hz] as number)}${band.gain ? `, ${(settings[band.gain] as number).toFixed(1)} dB` : ""}`}</title>
                  <ellipse cx={x} cy={y} rx={9} ry={9 * (HEIGHT / WIDTH) * 3.1} fill={band.colour} stroke="var(--surface)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                </g>
              );
            })}
          </svg>
          <div className="eq-bands" role="group" aria-label={`${label} bands`}>
            {EQ_BANDS.map((band) => (
              <fieldset
                key={band.id}
                className="eq-band"
                data-focused={focused === band.id}
                style={{ borderTopColor: band.colour }}
                onFocus={() => setFocused(band.id)}
              >
                <legend>{band.label}</legend>
                {band.on && (
                  <label className="field-inline">
                    <input
                      type="checkbox"
                      checked={settings[band.on] === "on"}
                      onChange={(event) => set({ [band.on!]: event.target.checked ? "on" : "off" }, `Switch ${band.label}`)}
                    />
                    On
                  </label>
                )}
                <label className="param">
                  <span className="num">{formatHz(settings[band.hz] as number)}</span>
                  <input
                    type="range"
                    aria-label={`${band.label} frequency`}
                    aria-valuetext={formatHz(settings[band.hz] as number)}
                    min={0}
                    max={WIDTH}
                    step={1}
                    value={Math.round(hzToX(settings[band.hz] as number))}
                    onChange={(event) => set({ [band.hz]: Math.round(xToHz(Number(event.target.value))) })}
                  />
                </label>
                {band.gain && (
                  <label className="param">
                    <span className="num">{(settings[band.gain] as number).toFixed(1)} dB</span>
                    <input
                      type="range"
                      aria-label={`${band.label} gain`}
                      aria-valuetext={`${(settings[band.gain] as number).toFixed(1)} dB`}
                      min={-MAX_DB}
                      max={MAX_DB}
                      step={0.5}
                      value={settings[band.gain] as number}
                      onChange={(event) => set({ [band.gain!]: Number(event.target.value) })}
                    />
                  </label>
                )}
                {band.q && (
                  <label className="param">
                    <span className="num">Q {(settings[band.q] as number).toFixed(2)}</span>
                    <input
                      type="range"
                      aria-label={`${band.label} Q`}
                      min={MIN_Q}
                      max={MAX_Q}
                      step={0.05}
                      value={settings[band.q] as number}
                      onChange={(event) => set({ [band.q!]: Number(event.target.value) })}
                    />
                  </label>
                )}
              </fieldset>
            ))}
          </div>
          <p className="hint">
            Drag a node: across for its frequency, up and down for its gain. The wheel over a band changes its Q;
            double-click a cut to switch it in or out.
          </p>
        </>
      )}
    </section>
  );
}

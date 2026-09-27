import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { formatDb } from "../mixer/level";
import { type AutomatableSetting, lowerFirst } from "../project/automation";
import type { AutomationTarget, Command } from "../project/commands";
import type { AutomatedSetting, Breakpoint } from "../project/model";
import { barsAt, formatPosition, type TempoMap, tickAtBars } from "../project/time";
import type { Grid } from "./timeline-view";

export const AUTOMATION_LANE_HEIGHT = 56;
/** Room above and below the line, so a breakpoint at either end can be grabbed. */
const PAD = 6;
const POINT_PX = 10;
/** How far an arrow key moves a value: a twentieth of its range. */
const VALUE_STEPS = 20;

export interface AutomationLaneProps {
  /** Whose setting it is: "Keys", "Master". */
  owner: string;
  target: AutomationTarget;
  /** The setting shown, with its range and the fixed value it keeps where it isn't automated. */
  setting: AutomatableSetting;
  /** The settings the picker offers: everything the owner can automate. */
  settings: readonly AutomatableSetting[];
  onSetting: (setting: AutomatedSetting) => void;
  /** None when the setting isn't automated. */
  breakpoints: readonly Breakpoint[];
  map: TempoMap;
  grid: Grid;
  width: number;
  labelWidth: number;
  px: (ticks: number) => number;
  ticksAt: (clientX: number, left: number) => number;
  pxToTicks: (px: number) => number;
  /** The playback position in ticks, or null when no audio is running. */
  position: number | null;
  onCommands: (commands: Command[], label: string) => void;
}

interface PointDrag {
  tick: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  free: boolean;
}

/**
 * A setting's Automation, on a lane under its Track, Bus or the Master: a line
 * through its breakpoints. Double-click to add one, or add one at the
 * playhead from the lane's label; drag one, or use the
 * arrow keys, to move it; Delete removes it and H makes it hold. The
 * selected one's fields below do all of that without dragging. Every edit
 * replaces the lane's breakpoints in one command, so each undoes.
 */
export function AutomationLane(props: AutomationLaneProps) {
  const { owner, target, settings, onSetting, breakpoints, map, grid, width, labelWidth } = props;
  const { setting: automated, min, max, fixed, label: settingLabel } = props.setting;
  const { px, ticksAt, pxToTicks, position, onCommands } = props;
  const [selectedTick, setSelectedTick] = useState<number | null>(null);
  // Bumped whenever the selection changes other than by typing in its
  // fields, so they show it afresh without losing what is being typed.
  const [fieldsKey, setFieldsKey] = useState(0);
  const select = (tick: number | null) => {
    setSelectedTick(tick);
    setFieldsKey((key) => key + 1);
  };
  const [drag, setDrag] = useState<PointDrag | null>(null);
  const name = `${owner} ${lowerFirst(settingLabel)}`;
  const usable = AUTOMATION_LANE_HEIGHT - 2 * PAD;
  const y = (value: number) => PAD + (1 - (value - min) / (max - min)) * usable;
  const valueAt = (offsetY: number) => clamp(min + (1 - (offsetY - PAD) / usable) * (max - min), min, max);
  const selected = breakpoints.find((point) => point.tick === selectedTick) ?? null;

  const replace = (next: Breakpoint[], label: string) =>
    onCommands([{ type: "setAutomation", target, setting: automated, breakpoints: next }], label);

  /** `point` moved to `tick` and `value`, kept between its neighbours. */
  const moved = (point: Breakpoint, tick: number, value: number): Breakpoint => {
    const index = breakpoints.indexOf(point);
    const before = breakpoints[index - 1]?.tick ?? -1;
    const after = breakpoints[index + 1]?.tick ?? Number.POSITIVE_INFINITY;
    return { ...point, tick: clamp(Math.round(tick), before + 1, after - 1), value: roundValue(clamp(value, min, max)) };
  };

  const update = (point: Breakpoint, next: Breakpoint, label = "Move breakpoint", typed = false) => {
    if (next.tick === point.tick && next.value === point.value && next.hold === point.hold) return;
    replace(
      breakpoints.map((other) => (other === point ? next : other)),
      label,
    );
    if (typed) setSelectedTick(next.tick);
    else select(next.tick);
  };

  const remove = (point: Breakpoint) => {
    replace(
      breakpoints.filter((other) => other !== point),
      "Delete breakpoint",
    );
    select(null);
  };

  /** Where a drag puts `point`: on the grid unless Alt is held. */
  const dragged = (current: PointDrag, point: Breakpoint): Breakpoint => {
    if (current.toX === current.fromX && current.toY === current.fromY) return point;
    const at = point.tick + pxToTicks(current.toX - current.fromX);
    const value = point.value - ((current.toY - current.fromY) / usable) * (max - min);
    return moved(point, current.free ? at : grid.snap(at), value);
  };

  useEffect(() => {
    if (!drag) return;
    const point = breakpoints.find((candidate) => candidate.tick === drag.tick);
    const onMove = (event: MouseEvent) =>
      setDrag((current) => current && { ...current, toX: event.clientX, toY: event.clientY, free: event.altKey });
    const onUp = (event: MouseEvent) => {
      setDrag(null);
      if (point) update(point, dragged({ ...drag, toX: event.clientX, toY: event.clientY }, point));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  });

  const add = (tick: number, value: number) => {
    if (!breakpoints.some((point) => point.tick === tick)) {
      const point = { tick, value: roundValue(value), hold: false };
      replace([...breakpoints, point].toSorted((a, b) => a.tick - b.tick), "Add breakpoint");
    }
    select(tick);
  };

  /** On the grid at the playhead (the start with no audio running), on the line where it already is. */
  const addAtPlayhead = () => {
    const tick = Math.max(0, grid.snap(position ?? 0));
    add(tick, valueOnLine(breakpoints, fixed, tick));
  };

  const onPointKey = (event: React.KeyboardEvent, point: Breakpoint) => {
    const step = (max - min) / VALUE_STEPS;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const by = event.key === "ArrowLeft" ? -1 : 1;
      update(point, moved(point, Math.max(0, grid.snap(point.tick + by * grid.step)), point.value));
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      update(point, moved(point, point.tick, point.value + (event.key === "ArrowUp" ? step : -step)));
    } else if (event.key === "Delete" || event.key === "Backspace") {
      remove(point);
    } else if (event.key === "h" || event.key === "H") {
      update(point, { ...point, hold: !point.hold }, "Edit breakpoint");
    } else if (event.key === "Enter" || event.key === " ") {
      select(point.tick);
    } else {
      return;
    }
    event.preventDefault();
  };

  const shown = breakpoints.map((point) => (drag?.tick === point.tick ? dragged(drag, point) : point));

  return (
    <>
      <div style={{ display: "flex" }}>
        <div className="lane-label automation-label" style={{ width: labelWidth }}>
          {settings.length > 1 ? (
            <select
              aria-label={`${owner} automated setting`}
              value={automated}
              onChange={(event) => {
                select(null);
                onSetting(event.target.value as AutomatedSetting);
              }}
            >
              {settings.map((option) => (
                <option key={option.setting} value={option.setting}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="lane-name">{settingLabel}</span>
          )}
          <button
            type="button"
            className="btn-sm btn-icon"
            aria-label={`Add ${lowerFirst(settingLabel)} breakpoint at the playhead`}
            title="Add a breakpoint at the playhead"
            onClick={addAtPlayhead}
          >
            <Plus size={14} aria-hidden />
          </button>
        </div>
        <div
          role="group"
          aria-label={`${name} Automation Lane`}
          className="lane automation-lane"
          style={{ width, height: AUTOMATION_LANE_HEIGHT }}
          onDoubleClick={(event) => {
            if (event.target !== event.currentTarget && !(event.target instanceof SVGElement)) return;
            const box = event.currentTarget.getBoundingClientRect();
            const at = ticksAt(event.clientX, box.left);
            add(Math.round(event.altKey ? at : grid.snap(at)), valueAt(event.clientY - box.top));
          }}
          onMouseDown={(event) => event.target === event.currentTarget && select(null)}
        >
          <svg aria-hidden width={width} height={AUTOMATION_LANE_HEIGHT} className="automation-line">
            <polyline
              points={linePoints(shown, fixed, width, px, y)}
              data-automated={shown.length > 0}
              fill="none"
            />
          </svg>
          {shown.map((point, index) => {
            const original = breakpoints[index]!;
            return (
              <div
                key={original.tick}
                role="button"
                tabIndex={0}
                aria-label={`${settingLabel} breakpoint at ${formatPosition(original.tick, map)}: ${valueText(props.setting, original.value)}${original.hold ? ", holds" : ""}`}
                aria-pressed={original.tick === selectedTick}
                aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Delete H"
                className="breakpoint"
                data-hold={point.hold}
                style={{ left: px(point.tick) - POINT_PX / 2, top: y(point.value) - POINT_PX / 2 }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  if (original.tick !== selectedTick) select(original.tick);
                  const at = { fromX: event.clientX, fromY: event.clientY, toX: event.clientX, toY: event.clientY };
                  setDrag({ tick: original.tick, ...at, free: event.altKey });
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => onPointKey(event, original)}
              />
            );
          })}
          {breakpoints.length === 0 && (
            <span className="automation-hint" aria-hidden>
              Double-click to automate {name}
            </span>
          )}
        </div>
      </div>
      {selected && (
        <BreakpointFields
          key={fieldsKey}
          name={name}
          setting={props.setting}
          point={selected}
          map={map}
          onMove={(tick, value) => update(selected, moved(selected, tick, value), "Move breakpoint", true)}
          onHold={(hold) => update(selected, { ...selected, hold }, "Edit breakpoint", true)}
          onDelete={() => remove(selected)}
        />
      )}
    </>
  );
}

/**
 * The line the setting follows across the lane: its fixed value when it
 * isn't automated; otherwise the first breakpoint's value up to it, a ramp
 * or a step from each to the next, and the last's value after it.
 */
function linePoints(
  points: readonly Breakpoint[],
  fixed: number,
  width: number,
  px: (ticks: number) => number,
  y: (value: number) => number,
): string {
  if (points.length === 0) return `0,${y(fixed)} ${width},${y(fixed)}`;
  const line: [number, number][] = [[0, y(points[0]!.value)]];
  points.forEach((point, index) => {
    line.push([px(point.tick), y(point.value)]);
    const next = points[index + 1];
    if (next && point.hold) line.push([px(next.tick), y(point.value)]);
  });
  line.push([width, y(points.at(-1)!.value)]);
  return line.map(([x, top]) => `${x},${top}`).join(" ");
}

/** The line's value at `tick`: the fixed value with no breakpoints, else between them as `linePoints` draws it. */
function valueOnLine(points: readonly Breakpoint[], fixed: number, tick: number): number {
  const after = points.findIndex((point) => point.tick > tick);
  if (points.length === 0) return fixed;
  if (after === 0) return points[0]!.value;
  const before = points[(after < 0 ? points.length : after) - 1]!;
  const next = points[after];
  if (!next || before.hold) return before.value;
  return before.value + ((next.value - before.value) * (tick - before.tick)) / (next.tick - before.tick);
}

function valueText({ setting, unit }: AutomatableSetting, value: number): string {
  if (setting === "volume" || setting.startsWith("send:")) return `${value} (${formatDb(value)})`;
  if (setting !== "pan") return unit ? `${value} ${unit}` : String(value);
  if (value === 0) return "centre";
  return `${Math.round(Math.abs(value) * 100)}% ${value < 0 ? "left" : "right"}`;
}

/** What a breakpoint's value field is called. */
function fieldLabel({ setting, label, unit }: AutomatableSetting): string {
  if (setting === "volume") return "Volume (gain)";
  if (setting === "pan") return "Pan (-1 left, 1 right)";
  if (setting.startsWith("send:")) return "Level (gain)";
  return unit ? `${label} (${unit})` : label;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundValue(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The selected breakpoint's position, value and hold as fields: everything
 * the lane does, without dragging (WCAG 2.5.7).
 */
function BreakpointFields({
  name,
  setting,
  point,
  map,
  onMove,
  onHold,
  onDelete,
}: {
  name: string;
  setting: AutomatableSetting;
  point: Breakpoint;
  map: TempoMap;
  onMove: (tick: number, value: number) => void;
  onHold: (hold: boolean) => void;
  onDelete: () => void;
}) {
  const [barText, setBarText] = useState(String(Number(barsAt(map, point.tick).toFixed(3))));
  const [valueField, setValueField] = useState(String(point.value));
  const { min, max } = setting;

  return (
    <div role="group" aria-label={`Selected breakpoint of ${name}`} className="row row-end mt-3">
      <span className="eyebrow" style={{ alignSelf: "center" }}>
        Breakpoint
      </span>
      <label className="field">
        At (bar)
        <input
          type="number"
          min={1}
          step={0.25}
          value={barText}
          style={{ width: "6em" }}
          onChange={(event) => {
            setBarText(event.target.value);
            const bars = Number(event.target.value);
            if (event.target.value === "" || !(bars >= 1)) return;
            onMove(Math.round(tickAtBars(map, bars)), point.value);
          }}
        />
      </label>
      <label className="field">
        {fieldLabel(setting)}
        <input
          type="number"
          min={min}
          max={max}
          step={max - min <= 2 ? 0.01 : "any"}
          value={valueField}
          style={{ width: "6em" }}
          onChange={(event) => {
            setValueField(event.target.value);
            const value = Number(event.target.value);
            if (event.target.value === "" || !(value >= min && value <= max)) return;
            onMove(point.tick, value);
          }}
        />
      </label>
      <label className="field-inline">
        <input type="checkbox" checked={point.hold} onChange={(event) => onHold(event.target.checked)} />
        Hold until the next
      </label>
      <button type="button" className="btn-sm" onClick={onDelete}>
        <Trash2 size={14} aria-hidden /> Delete breakpoint
      </button>
    </div>
  );
}

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { Command } from "../project/commands";
import { newId, type Project, type TempoChange } from "../project/model";
import {
  BEAT_UNITS,
  barStart,
  barsAt,
  formatPosition,
  isBarLine,
  signatureAt,
  type TempoMap,
  tempoAt,
  tempoMapOf,
  tickAtBars,
  type TimeSignature,
} from "../project/time";
import { LIMITS } from "../project/validate";
import { type Grid, mapGrid } from "./timeline-view";

const LANE_HEIGHT = 26;

export interface TempoLaneProps {
  project: Project;
  map: TempoMap;
  /** The grid positions snap to. */
  grid: Grid;
  width: number;
  labelWidth: number;
  px: (ticks: number) => number;
  /** The tick under `clientX`, on a lane whose left edge is `left`. */
  ticksAt: (clientX: number, left: number) => number;
  /** A distance in pixels as ticks. */
  pxToTicks: (px: number) => number;
  /** The playback position in ticks, or null when no audio is running. */
  position: number | null;
  onCommands: (commands: Command[], label: string) => void;
}

interface ChangeDrag {
  id: string;
  fromX: number;
  toX: number;
  free: boolean;
}

/**
 * The song's Tempo Changes, on a lane under the ruler: each a flag that
 * can be dragged or moved with the arrow keys, and edited or deleted in the
 * fields below once selected. Every edit is a command, so it undoes.
 */
export function TempoLane(props: TempoLaneProps) {
  const { project, map, grid, width, labelWidth, px, ticksAt, pxToTicks, position, onCommands } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<ChangeDrag | null>(null);
  const selected = project.tempoChanges.find((change) => change.id === selectedId) ?? null;

  /** Where `change` lands dragged to `tick`: on the grid, or a bar line if it sets a time signature. */
  const landing = (change: TempoChange, tick: number, free: boolean): number => {
    const snap = change.timeSignature ? mapGrid(mapWithout(project, change), "bar") : free ? null : grid;
    return Math.max(1, Math.round(snap ? snap.snap(tick) : tick));
  };
  // A click without a move leaves it where it is, on the grid or not.
  const dragTo = (current: ChangeDrag, change: TempoChange, toX: number, free: boolean) =>
    toX === current.fromX ? change.tick : landing(change, change.tick + pxToTicks(toX - current.fromX), free);

  const move = (change: TempoChange, tick: number) => {
    if (tick !== change.tick) {
      onCommands([{ type: "moveTempoChange", tempoChangeId: change.id, tick }], "Move Tempo Change");
    }
  };

  useEffect(() => {
    if (!drag) return;
    const change = project.tempoChanges.find((candidate) => candidate.id === drag.id);
    const onMove = (event: MouseEvent) =>
      setDrag((current) => (current ? { ...current, toX: event.clientX, free: event.altKey } : null));
    const onUp = (event: MouseEvent) => {
      setDrag(null);
      if (change) move(change, dragTo(drag, change, event.clientX, event.altKey || drag.free));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  });

  /** A Tempo Change at `tick` keeping the tempo there, ready to edit; or the one already there. */
  const add = (tick: number) => {
    const existing = project.tempoChanges.find((change) => change.tick === tick);
    if (existing) {
      setSelectedId(existing.id);
      return;
    }
    const tempoChange: TempoChange = { id: newId(), tick, tempo: tempoAt(map, tick), timeSignature: null };
    onCommands([{ type: "addTempoChange", tempoChange }], "Add Tempo Change");
    setSelectedId(tempoChange.id);
  };

  /** At the bar the playhead is in, or the second bar when it is in the first. */
  const addAtPlayhead = () => {
    const bar = mapGrid(map, "bar").snap(position ?? 0);
    add(bar > 0 ? bar : barStart(map, 2));
  };

  const onChangeKey = (event: React.KeyboardEvent, change: TempoChange) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const step = change.timeSignature ? mapWithout(project, change) : null;
      const by = event.key === "ArrowLeft" ? -1 : 1;
      const tick = step
        ? barStart(step, Math.max(1, Math.round(barsAt(step, change.tick)) + by))
        : Math.max(1, grid.snap(change.tick + by * grid.step));
      if (tick > 0) move(change, tick);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      onCommands([{ type: "deleteTempoChange", tempoChangeId: change.id }], "Delete Tempo Change");
      setSelectedId(null);
    } else if (event.key === "Enter" || event.key === " ") {
      setSelectedId(change.id);
    } else {
      return;
    }
    event.preventDefault();
  };

  return (
    <>
      <div style={{ display: "flex" }}>
        <div className="lane-label" style={{ width: labelWidth, justifyContent: "space-between" }}>
          Tempo
          <button
            type="button"
            className="btn-sm btn-icon"
            aria-label="Add Tempo Change at the playhead"
            title="Add Tempo Change at the playhead"
            onClick={addAtPlayhead}
          >
            <Plus size={14} aria-hidden />
          </button>
        </div>
        <div
          role="group"
          aria-label="Tempo lane"
          className="lane tempo-lane"
          style={{ width, height: LANE_HEIGHT }}
          onDoubleClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const at = ticksAt(event.clientX, event.currentTarget.getBoundingClientRect().left);
            const tick = Math.round(event.altKey ? at : grid.snap(at));
            if (tick > 0) add(tick);
          }}
          onMouseDown={(event) => event.target === event.currentTarget && setSelectedId(null)}
        >
          {project.tempoChanges.map((change) => {
            const tick = drag?.id === change.id ? dragTo(drag, change, drag.toX, drag.free) : change.tick;
            return (
              <div
                key={change.id}
                role="button"
                tabIndex={0}
                aria-label={`Tempo Change at ${formatPosition(change.tick, map)}: ${describe(change)}`}
                aria-pressed={change.id === selectedId}
                aria-keyshortcuts="ArrowLeft ArrowRight Delete"
                className="tempo-change"
                style={{ left: px(tick), opacity: drag?.id === change.id ? 0.7 : 1 }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  setSelectedId(change.id);
                  setDrag({ id: change.id, fromX: event.clientX, toX: event.clientX, free: event.altKey });
                }}
                onKeyDown={(event) => onChangeKey(event, change)}
              >
                {describe(change)}
              </div>
            );
          })}
        </div>
      </div>
      {selected && (
        <TempoChangeFields
          key={selected.id}
          project={project}
          change={selected}
          onCommands={onCommands}
          onDeleted={() => setSelectedId(null)}
        />
      )}
    </>
  );
}

/** What a Tempo Change changes, as its flag on the lane shows it: "90 BPM 3/4". */
function describe(change: TempoChange): string {
  return [change.tempo === null ? null : `${change.tempo} BPM`, change.timeSignature && signatureText(change.timeSignature)]
    .filter(Boolean)
    .join(" ");
}

function signatureText({ beatsPerBar, beatUnit }: TimeSignature): string {
  return `${beatsPerBar}/${beatUnit}`;
}

/** The song's map without `change`: the bar lines it can be moved onto. */
function mapWithout(project: Project, change: TempoChange): TempoMap {
  return tempoMapOf({ ...project, tempoChanges: project.tempoChanges.filter((other) => other !== change) });
}

/**
 * The selected Tempo Change's position, tempo and time signature as fields:
 * everything the lane does, without dragging (WCAG 2.5.7).
 */
function TempoChangeFields({
  project,
  change,
  onCommands,
  onDeleted,
}: {
  project: Project;
  change: TempoChange;
  onCommands: (commands: Command[], label: string) => void;
  onDeleted: () => void;
}) {
  const others = mapWithout(project, change);
  const [tempoText, setTempoText] = useState(change.tempo === null ? "" : String(change.tempo));
  const [barText, setBarText] = useState(String(Number(barsAt(others, change.tick).toFixed(3))));
  const set = (fields: { tempo?: number | null; timeSignature?: TimeSignature | null }) =>
    onCommands([{ type: "setTempoChange", tempoChangeId: change.id, ...fields }], "Edit Tempo Change");
  const [min, max] = LIMITS.tempo;
  const signature = change.timeSignature;

  return (
    <div role="group" aria-label={`Selected Tempo Change: ${describe(change)}`} className="row row-end mt-3">
      <span className="eyebrow" style={{ alignSelf: "center" }}>
        Tempo Change
      </span>
      <label className="field">
        At (bar)
        <input
          type="number"
          min={1}
          step={signature ? 1 : 0.25}
          value={barText}
          style={{ width: "6em" }}
          onChange={(event) => {
            setBarText(event.target.value);
            const bars = Number(event.target.value);
            if (event.target.value === "" || bars < 1) return;
            const tick = Math.round(tickAtBars(others, signature ? Math.round(bars) : bars));
            if (tick > 0 && tick !== change.tick) {
              onCommands([{ type: "moveTempoChange", tempoChangeId: change.id, tick }], "Move Tempo Change");
            }
          }}
        />
      </label>
      <label className="field">
        Tempo (BPM)
        <input
          type="number"
          min={min}
          max={max}
          value={tempoText}
          placeholder="Unchanged"
          style={{ width: "6em" }}
          onChange={(event) => {
            setTempoText(event.target.value);
            const tempo = Number(event.target.value);
            if (event.target.value === "") {
              if (signature) set({ tempo: null });
            } else if (tempo >= min && tempo <= max && tempo !== change.tempo) {
              set({ tempo });
            }
          }}
        />
      </label>
      <label className="field-inline">
        <input
          type="checkbox"
          checked={signature !== null}
          // A time signature changes only on a bar line.
          disabled={signature === null && !isBarLine(others, change.tick)}
          onChange={(event) => set({ timeSignature: event.target.checked ? signatureAt(others, change.tick) : null })}
        />
        New time signature
      </label>
      {signature && (
        <>
          <label className="field">
            Beats per bar
            <input
              type="number"
              min={LIMITS.beatsPerBar[0]}
              max={LIMITS.beatsPerBar[1]}
              value={signature.beatsPerBar}
              style={{ width: "4em" }}
              onChange={(event) => {
                const beatsPerBar = Number(event.target.value);
                if (Number.isInteger(beatsPerBar) && beatsPerBar >= LIMITS.beatsPerBar[0] && beatsPerBar <= LIMITS.beatsPerBar[1]) {
                  set({ timeSignature: { ...signature, beatsPerBar } });
                }
              }}
            />
          </label>
          <label className="field">
            Beat unit
            <select
              value={signature.beatUnit}
              onChange={(event) => set({ timeSignature: { ...signature, beatUnit: Number(event.target.value) } })}
            >
              {BEAT_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <button
        type="button"
        className="btn-sm"
        onClick={() => {
          onCommands([{ type: "deleteTempoChange", tempoChangeId: change.id }], "Delete Tempo Change");
          onDeleted();
        }}
      >
        <Trash2 size={14} aria-hidden />
        Delete Tempo Change
      </button>
    </div>
  );
}

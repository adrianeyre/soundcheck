import { Piano } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Instrument, Note, PatternClip } from "../project/model";
import { barTicks, beatTicks, constantTempoMap, formatPosition, type TimeSignature } from "../project/time";
import {
  type Clipboard,
  copyNotes,
  DEFAULT_PIANO_SNAP,
  deleteNotes,
  drawLength,
  drawNote,
  type Edit,
  moveNotes,
  noteKey,
  PIANO_SNAPS,
  type PianoSnapId,
  pasteNotes,
  pianoRows,
  quantiseNotes,
  resizeNotes,
  setVelocity,
  snapTicksOf,
} from "./piano-roll";

const ROW_HEIGHT = 18;
const LABEL_WIDTH = 96;
/** A beat is this wide, so a 1/16 is 16px. */
const PX_PER_BEAT = 64;
const PX_PER_TICK = PX_PER_BEAT / 960;
const VELOCITY_HEIGHT = 64;
/** How wide a note's resize handle is. */
const HANDLE_PX = 6;
/** Where the Synth's rows start scrolled to when the Clip is empty: C5 at the top. */
const EMPTY_TOP_PITCH = 72;

type DragMode = "draw" | "move" | "resize" | "velocity";

/** A drag in progress. Pixels, because that is what the mouse gives. */
interface NoteDrag {
  mode: DragMode;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** The grid's (or, for velocity, the lane's) top-left at the start. */
  left: number;
  top: number;
  /** The note grabbed, or for a draw the note being drawn. */
  anchor: Note;
  selection: ReadonlySet<string>;
  /** Alt bypasses the snap grid. */
  free: boolean;
}

const LABELS: Record<DragMode, string> = {
  draw: "Draw note",
  move: "Move notes",
  resize: "Resize notes",
  velocity: "Change velocity",
};

export interface PianoRollProps {
  clip: PatternClip;
  trackName: string;
  /** Whose notes these are: the Drum Sampler's rows are its Pads. */
  instrument: Instrument;
  timeSignature: TimeSignature;
  /** Every edit is the Clip's new notes, applied as one undo step called `label`. */
  onNotes: (notes: Note[], label: string) => void;
}

/**
 * Notes as bars on rows of pitch, with their velocities in a lane below.
 * Draw on an empty spot (drag for a longer note); drag a note to move it and
 * its right edge to resize it; Shift-click to select several; right-click
 * or Delete removes. A drag previews here and becomes one edit when the
 * mouse is let go.
 */
export function PianoRoll({ clip, trackName, instrument, timeSignature, onNotes }: PianoRollProps) {
  const [snap, setSnap] = useState<PianoSnapId>(DEFAULT_PIANO_SNAP);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [clipboard, setClipboard] = useState<{ copied: Clipboard; at: number } | null>(null);
  const [drag, setDrag] = useState<NoteDrag | null>(null);
  /** The note to give focus to once it is drawn. */
  const focusKey = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const grid = snapTicksOf(snap);
  const keyStep = drawLength(grid);
  const rows = pianoRows(instrument, clip.notes);
  const pitches = rows.map((row) => row.pitch);
  const rowOf = new Map(rows.map((row, index) => [row.pitch, index]));
  const labelOf = (pitch: number) => rows[rowOf.get(pitch) ?? -1]?.label ?? String(pitch);
  const map = constantTempoMap(120, timeSignature);
  const width = Math.max(1, clip.length * PX_PER_TICK);
  const px = (ticks: number) => ticks * PX_PER_TICK;
  const chosen = clip.notes.filter((note) => selection.has(noteKey(note)));

  // Open with the notes in view: the highest one near the top, or C5. Once,
  // when the Clip is opened; the component is keyed by the Clip.
  const scrolled = useRef(false);
  const scrollRef = (scroll: HTMLDivElement | null) => {
    if (!scroll || scrolled.current) return;
    scrolled.current = true;
    const top = Math.max(-1, ...clip.notes.map((note) => note.pitch));
    const row = rowOf.get(top >= 0 ? top : EMPTY_TOP_PITCH) ?? 0;
    scroll.scrollTop = Math.max(0, (row - 2) * ROW_HEIGHT);
  };

  // A keyboard move gives the note a new key, so it is drawn anew; give it focus back.
  useEffect(() => {
    if (!focusKey.current) return;
    gridRef.current?.querySelector<HTMLElement>(`[data-key="${focusKey.current}"]`)?.focus();
    focusKey.current = null;
  });

  const apply = (edit: Edit | Note[], label: string) => {
    const next = Array.isArray(edit) ? { notes: edit, selection } : edit;
    if (!sameNotes(next.notes, clip.notes)) onNotes(next.notes, label);
    setSelection(next.selection);
    return next;
  };

  /** What a drag would do if the mouse were let go now. */
  const dragResult = (d: NoteDrag): Edit => {
    // A click on a note selects it; only a drag moves or resizes it.
    const still = d.toX === d.fromX && d.toY === d.fromY;
    if (still && (d.mode === "move" || d.mode === "resize")) return { notes: clip.notes, selection: d.selection };
    const g = d.free ? 1 : grid;
    const ticks = (d.toX - d.fromX) / PX_PER_TICK;
    switch (d.mode) {
      case "draw": {
        const end = (d.toX - d.left) / PX_PER_TICK;
        const drawn = Math.ceil((end - d.anchor.start) / g) * g;
        return drawNote(clip.notes, d.anchor.pitch, d.anchor.start, Math.max(drawLength(g), drawn), g, clip.length);
      }
      case "move":
        return moveNotes(
          clip.notes,
          d.selection,
          d.anchor,
          ticks,
          Math.round((d.toY - d.fromY) / ROW_HEIGHT),
          pitches,
          g,
          clip.length,
        );
      case "resize":
        return { notes: resizeNotes(clip.notes, d.selection, d.anchor, ticks, g), selection: new Set(d.selection) };
      case "velocity": {
        const velocity = Math.round((1 - (d.toY - d.top) / VELOCITY_HEIGHT) * 100) / 100;
        return { notes: setVelocity(clip.notes, d.selection, velocity), selection: new Set(d.selection) };
      }
    }
  };

  // The mouse leaves the note long before the drag ends, so the rest of the
  // drag is followed on the window. No dependency list, as on the Timeline:
  // each render re-subscribes, so the handlers see the drag and notes as they are.
  useEffect(() => {
    if (!drag) return;
    const move = (event: MouseEvent) =>
      setDrag((current) =>
        current ? { ...current, toX: event.clientX, toY: event.clientY, free: event.altKey } : null,
      );
    const up = (event: MouseEvent) => {
      setDrag(null);
      const done = { ...drag, toX: event.clientX, toY: event.clientY, free: event.altKey || drag.free };
      apply(dragResult(done), LABELS[drag.mode]);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  });

  const shown = drag ? dragResult(drag) : { notes: clip.notes, selection };

  /** What a press on `note` works on: Shift adds it to (or takes it from) the selection. */
  const pressed = (event: React.MouseEvent | React.KeyboardEvent, note: Note): Set<string> => {
    const key = noteKey(note);
    if (event.shiftKey) {
      const next = new Set(selection);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    }
    return selection.has(key) ? new Set(selection) : new Set([key]);
  };

  const startDrag = (event: React.MouseEvent, mode: DragMode, note: Note, box: DOMRect, keys: Set<string>) => {
    event.stopPropagation();
    event.preventDefault();
    setSelection(keys);
    // Shift-clicking a note off the selection only deselects it.
    if (!keys.has(noteKey(note))) return;
    setDrag({
      mode,
      fromX: event.clientX,
      fromY: event.clientY,
      toX: event.clientX,
      toY: event.clientY,
      left: box.left,
      top: box.top,
      anchor: note,
      selection: keys,
      free: event.altKey,
    });
  };

  const onGridDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const row = rows[Math.floor((event.clientY - box.top) / ROW_HEIGHT)];
    if (!row) return;
    const g = event.altKey ? 1 : grid;
    const at = Math.max(0, (event.clientX - box.left) / PX_PER_TICK);
    const start = Math.min(clip.length - 1, Math.floor(at / g) * g);
    if (start < 0) return;
    const anchor = { pitch: row.pitch, start, length: drawLength(g), velocity: 0 };
    startDrag(event, "draw", anchor, box, new Set([noteKey(anchor)]));
  };

  const copy = () => {
    const copied = copyNotes(clip.notes, selection, grid);
    if (!copied) return;
    const earliest = Math.min(...chosen.map((note) => note.start));
    setClipboard({ copied, at: earliest + copied.span });
  };

  const paste = () => {
    if (!clipboard) return;
    apply(pasteNotes(clip.notes, clipboard.copied, clipboard.at, clip.length), "Paste notes");
    setClipboard({ ...clipboard, at: clipboard.at + clipboard.copied.span });
  };

  const remove = (keys: ReadonlySet<string>) =>
    apply({ notes: deleteNotes(clip.notes, keys), selection: new Set() }, "Delete notes");

  const onNoteKey = (event: React.KeyboardEvent, note: Note) => {
    const key = noteKey(note);
    const keys = selection.has(key) ? selection : new Set([key]);
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-keyStep, 0],
      ArrowRight: [keyStep, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const arrow = arrows[event.key];
    if (event.key === "Enter" || event.key === " ") {
      setSelection(pressed(event, note));
    } else if (arrow && event.shiftKey && arrow[1] === 0) {
      apply({ notes: resizeNotes(clip.notes, keys, note, arrow[0], grid), selection: new Set(keys) }, "Resize notes");
    } else if (arrow) {
      const edit = apply(
        moveNotes(clip.notes, keys, note, arrow[0], arrow[1], pitches, grid, clip.length),
        "Move notes",
      );
      const index = clip.notes.filter((n) => keys.has(noteKey(n))).indexOf(note);
      const moved = [...edit.selection][index];
      focusKey.current = moved ?? null;
    } else if (event.key === "Delete" || event.key === "Backspace") {
      remove(keys);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onKey = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, select, textarea")) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "a") setSelection(new Set(clip.notes.map(noteKey)));
    else if (key === "c") copy();
    else if (key === "x") {
      copy();
      remove(selection);
    } else if (key === "v") paste();
    else return;
    event.preventDefault();
  };

  const velocities = chosen.map((note) => note.velocity);
  const velocity = velocities.length > 0 ? Math.round(velocities[0]! * 100) : "";
  const bar = barTicks(timeSignature);
  const beat = beatTicks(timeSignature);
  const lines = Array.from({ length: Math.ceil(clip.length / beat) }, (_, index) => index * beat).filter(
    (tick) => tick > 0,
  );

  return (
    <section
      aria-label="Piano Roll"
      className="panel"
      onKeyDown={onKey}
      aria-keyshortcuts="Control+A Control+C Control+X Control+V"
    >
      <div className="panel-head">
        <h2 className="kind-stripe" data-track-kind={instrument.type === "drumSampler" ? "drum" : "instrument"}>
          <Piano size={18} aria-hidden />
          Piano Roll: {trackName}
        </h2>
        <label className="field-inline">
          Note snap
          <select value={snap} onChange={(event) => setSnap(event.target.value as PianoSnapId)}>
            {PIANO_SNAPS.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-sm" onClick={() => setSelection(new Set(clip.notes.map(noteKey)))}>
          Select all
        </button>
        <button type="button" className="btn-sm" disabled={chosen.length === 0} onClick={copy}>
          Copy
        </button>
        <button type="button" className="btn-sm" disabled={!clipboard} onClick={paste}>
          Paste
        </button>
        <button type="button" className="btn-sm" disabled={chosen.length === 0} onClick={() => remove(selection)}>
          Delete notes
        </button>
        <button
          type="button"
          className="btn-sm"
          disabled={chosen.length === 0 || grid <= 1}
          title={grid <= 1 ? "Choose a snap grid to quantise to" : undefined}
          onClick={() => apply(quantiseNotes(clip.notes, selection, grid, clip.length), "Quantise notes")}
        >
          Quantise
        </button>
        <label className="field-inline">
          Velocity (%)
          <input
            type="number"
            min={0}
            max={100}
            disabled={chosen.length === 0}
            value={velocity}
            style={{ width: "4.5em" }}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (event.target.value === "" || !(value >= 0 && value <= 100)) return;
              apply(setVelocity(clip.notes, selection, value / 100), "Change velocity");
            }}
          />
        </label>
      </div>
      <p className="hint">
        {chosen.length} of {clip.notes.length} notes selected. Draw on an empty spot; drag a note or its right edge;
        Shift-click selects several; right-click or Delete removes; arrows move and Shift+arrows resize.
      </p>
      <div ref={scrollRef} className="pr-scroll">
        <div style={{ width: LABEL_WIDTH + width }}>
          <div style={{ display: "flex" }}>
            <div className="pr-keys" style={{ width: LABEL_WIDTH }} aria-hidden>
              {rows.map((row) => (
                <div key={row.pitch} className="pr-key" data-shaded={row.shaded} style={{ height: ROW_HEIGHT }}>
                  {row.label}
                </div>
              ))}
            </div>
            <div
              ref={gridRef}
              className="pr-grid"
              aria-label={`Notes of ${trackName}`}
              role="group"
              onMouseDown={onGridDown}
              style={{ width, height: rows.length * ROW_HEIGHT }}
            >
              {rows.map((row, index) =>
                row.shaded ? (
                  <div
                    key={row.pitch}
                    aria-hidden
                    className="pr-row"
                    style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                  />
                ) : null,
              )}
              {lines.map((tick) => (
                <span
                  key={tick}
                  aria-hidden
                  className="pr-line"
                  data-bar={tick % bar === 0}
                  style={{ left: px(tick) }}
                />
              ))}
              {shown.notes.map((note) => {
                const key = noteKey(note);
                const row = rowOf.get(note.pitch);
                if (row === undefined) return null;
                const name = `${labelOf(note.pitch)} at ${formatPosition(note.start, map)}`;
                return (
                  <div
                    key={key}
                    data-key={key}
                    role="button"
                    tabIndex={0}
                    aria-label={name}
                    aria-pressed={shown.selection.has(key)}
                    aria-keyshortcuts="Enter ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Delete"
                    title={name}
                    className="pr-note"
                    onMouseDown={(event) => {
                      if (event.button !== 0) return;
                      const box = gridRef.current!.getBoundingClientRect();
                      startDrag(event, "move", note, box, pressed(event, note));
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      remove(new Set([key]));
                    }}
                    onKeyDown={(event) => onNoteKey(event, note)}
                    style={{
                      top: row * ROW_HEIGHT + 1,
                      height: ROW_HEIGHT - 2,
                      left: px(note.start),
                      width: Math.max(4, px(note.length)),
                    }}
                  >
                    <span
                      // Mouse only: Shift+arrows resize from the keyboard.
                      aria-hidden
                      title={`Resize ${name}`}
                      className="pr-handle"
                      onMouseDown={(event) => {
                        if (event.button !== 0) return;
                        const box = gridRef.current!.getBoundingClientRect();
                        startDrag(event, "resize", note, box, pressed(event, note));
                      }}
                      style={{ width: HANDLE_PX }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          <div className="pr-velocity-row">
            <div className="pr-keys pr-velocity-label" style={{ width: LABEL_WIDTH, height: VELOCITY_HEIGHT }}>
              Velocity
            </div>
            <div
              className="pr-velocity"
              aria-label={`Velocities of ${trackName}`}
              role="group"
              style={{ width, height: VELOCITY_HEIGHT }}
            >
              {shown.notes.map((note) => {
                const key = noteKey(note);
                const name = `Velocity of ${labelOf(note.pitch)} at ${formatPosition(note.start, map)}`;
                return (
                  <span
                    key={key}
                    // Mouse only: the Velocity field sets it from the keyboard.
                    aria-hidden
                    title={`${name}: ${Math.round(note.velocity * 100)}%`}
                    data-testid={name}
                    className="pr-bar"
                    data-selected={shown.selection.has(key)}
                    onMouseDown={(event) => {
                      if (event.button !== 0) return;
                      const box = event.currentTarget.parentElement!.getBoundingClientRect();
                      startDrag(event, "velocity", note, box, pressed(event, note));
                    }}
                    style={{ left: px(note.start), height: Math.max(2, note.velocity * VELOCITY_HEIGHT) }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function inOrder(notes: readonly Note[]): string {
  return JSON.stringify(notes.toSorted((a, b) => a.start - b.start || a.pitch - b.pitch));
}

/** Whether two lists hold the same notes, in any order. */
function sameNotes(a: readonly Note[], b: readonly Note[]): boolean {
  return inOrder(a) === inOrder(b);
}

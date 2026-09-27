import { ArrowLeft, ArrowRight, Copy, Plus, Scissors, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { arrange, type ArrangementEdit, arrangementProblem } from "../project/arrangement";
import type { Command } from "../project/commands";
import { newId, type Project, type Section } from "../project/model";
import { sectionBarsText, sectionEndBar, type SectionRange, sectionTicks } from "../project/sections";
import { barBeatTick, barsAt, type TempoMap } from "../project/time";
import { LIMITS } from "../project/validate";

const LANE_HEIGHT = 26;

/** How many bars a new Section spans, when there is room. */
export const NEW_SECTION_BARS = 8;

export interface SectionLaneProps {
  project: Project;
  map: TempoMap;
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
  /** The Section selected, kept by the Timeline so it can copy and paste it; null for none. */
  selectedId: string | null;
  onSelect: (sectionId: string | null) => void;
}

interface EdgeDrag {
  id: string;
  /** An edge resizes the Section; its body moves it, with everything in its bars. */
  edge: "start" | "end" | "body";
  fromX: number;
  toX: number;
  /** Made with the right button, by its body: it copies the Section, with everything in its bars, where it is dropped. */
  copy: boolean;
}

/**
 * The song's Sections, on a lane above the ruler: each a named block of
 * bars whose edges drag to bar lines, and which is renamed, resized or
 * deleted in the fields below once selected. An edge stops at the next
 * Section, so none can overlap; every edit is a command, so it undoes.
 *
 * A Section dragged by its body moves with everything in its bars, as
 * move_section moves it; dragged with the right button, a copy of it goes
 * where it is dropped, as duplicate_section puts one, and the fields duplicate it, move it past a
 * neighbour or delete its bars, as the Assistant's arrangement tools do.
 */
export function SectionLane(props: SectionLaneProps) {
  const { project, map, width, labelWidth, px, ticksAt, pxToTicks, position, onCommands, selectedId, onSelect: setSelectedId } = props;
  const { sections } = project;
  const [drag, setDrag] = useState<EdgeDrag | null>(null);
  const selected = sections.find((section) => section.id === selectedId) ?? null;

  /** Where `section` would be with `edge` moved to the bar line nearest `tick`, stopping short of its neighbours. */
  const withEdgeAt = (section: Section, edge: EdgeDrag["edge"], tick: number): SectionRange => {
    const bar = Math.round(barsAt(map, tick));
    if (edge === "body") return { startBar: Math.max(1, bar), bars: section.bars };
    const { first, last } = room(sections, section);
    const end = sectionEndBar(section);
    if (edge === "start") {
      const startBar = clamp(bar, first, end - 1);
      return { startBar, bars: end - startBar };
    }
    return { startBar: section.startBar, bars: clamp(bar, section.startBar + 1, last + 1) - section.startBar };
  };
  const dragged = (current: EdgeDrag, section: Section, toX: number): SectionRange => {
    const { start, end } = sectionTicks(section, map);
    return withEdgeAt(section, current.edge, (current.edge === "end" ? end : start) + pxToTicks(toX - current.fromX));
  };

  /** One edit to the whole song, as one command; one the lane can't make (a move to where it is) does nothing. */
  const rearrange = (edit: ArrangementEdit, label: string) => {
    if (arrangementProblem(project, edit)) return;
    onCommands([{ type: "rearrange", arrangement: arrange(project, edit).arrangement }], label);
  };
  const move = (section: Section, to: number | null) => {
    if (to !== null) rearrange({ kind: "moveSection", sectionId: section.id, to }, "Move Section");
  };

  /** A copy of `section`, and everything in its bars, before bar `at` as the song is now; dropped on itself, none. */
  const copyTo = (section: Section, at: number | null) => {
    if (at === null) return;
    const edit: ArrangementEdit = { kind: "duplicateSection", sectionId: section.id, at };
    if (arrangementProblem(project, edit)) return;
    const arranged = arrange(project, edit);
    onCommands([{ type: "rearrange", arrangement: arranged.arrangement }], "Copy Section");
    setSelectedId(arranged.section?.id ?? null);
  };

  const resize = (section: Section, range: SectionRange) => {
    if (range.startBar !== section.startBar || range.bars !== section.bars) {
      onCommands([{ type: "resizeSection", sectionId: section.id, ...range }], "Resize Section");
    }
  };

  useEffect(() => {
    if (!drag) return;
    const section = sections.find((candidate) => candidate.id === drag.id);
    const onMove = (event: MouseEvent) => setDrag((current) => (current ? { ...current, toX: event.clientX } : null));
    const onUp = (event: MouseEvent) => {
      setDrag(null);
      if (!section) return;
      const range = dragged(drag, section, event.clientX);
      if (drag.copy) copyTo(section, copyTarget(sections, section, range.startBar));
      else if (drag.edge === "body") move(section, moveTarget(sections, section, range.startBar));
      else resize(section, range);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  });

  /** A Section from `bar`, as long as there is room for, ready to rename; or the one already there. */
  const add = (bar: number) => {
    const existing = sections.find((section) => section.startBar <= bar && bar < sectionEndBar(section));
    if (existing) {
      setSelectedId(existing.id);
      return;
    }
    const next = sections.find((section) => section.startBar > bar);
    const bars = Math.min(NEW_SECTION_BARS, next ? next.startBar - bar : NEW_SECTION_BARS);
    const section: Section = { id: newId(), name: `Section ${sections.length + 1}`, startBar: bar, bars };
    onCommands([{ type: "addSection", section }], "Add Section");
    setSelectedId(section.id);
  };

  const onSectionKey = (event: React.KeyboardEvent, section: Section) => {
    const by = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (by !== 0 && (event.ctrlKey || event.metaKey)) {
      move(section, by < 0 ? earlierTarget(sections, section) : laterTarget(sections, section));
    } else if (by !== 0 && (event.shiftKey || event.altKey)) {
      // As on a Clip: Shift moves the end, Alt the start.
      const { first, last } = room(sections, section);
      const end = sectionEndBar(section);
      if (event.shiftKey) {
        resize(section, { startBar: section.startBar, bars: clamp(end + by, section.startBar + 1, last + 1) - section.startBar });
      } else {
        const startBar = clamp(section.startBar + by, first, end - 1);
        resize(section, { startBar, bars: end - startBar });
      }
    } else if (event.key === "Delete" || event.key === "Backspace") {
      onCommands([{ type: "deleteSection", sectionId: section.id }], "Delete Section");
      setSelectedId(null);
    } else if (event.key === "Enter" || event.key === " ") {
      setSelectedId(section.id);
    } else {
      return;
    }
    event.preventDefault();
  };

  return (
    <>
      <div style={{ display: "flex" }}>
        <div className="lane-label" style={{ width: labelWidth, justifyContent: "space-between" }}>
          Sections
          <button
            type="button"
            className="btn-sm btn-icon"
            aria-label="Add Section at the playhead"
            title="Add Section at the playhead"
            onClick={() => add(barBeatTick(map, position ?? 0).bar)}
          >
            <Plus size={14} aria-hidden />
          </button>
        </div>
        <div
          role="group"
          aria-label="Section lane"
          className="lane section-lane"
          style={{ width, height: LANE_HEIGHT }}
          onDoubleClick={(event) => {
            if (event.target !== event.currentTarget) return;
            add(barBeatTick(map, ticksAt(event.clientX, event.currentTarget.getBoundingClientRect().left)).bar);
          }}
          onMouseDown={(event) => event.target === event.currentTarget && setSelectedId(null)}
        >
          {sections.map((section) => {
            const range = drag?.id === section.id ? dragged(drag, section, drag.toX) : section;
            const { start, end } = sectionTicks(range, map);
            const grab = (edge: EdgeDrag["edge"]) => (event: React.MouseEvent) => {
              event.stopPropagation();
              // The right button copies it by its body, wherever it is pressed; the middle one does nothing.
              const copy = event.button === 2;
              if (event.button !== 0 && !copy) return;
              setSelectedId(section.id);
              setDrag({ id: section.id, edge: copy ? "body" : edge, fromX: event.clientX, toX: event.clientX, copy });
            };
            return (
              <div
                key={section.id}
                role="button"
                tabIndex={0}
                aria-label={`Section ${section.name}, ${sectionBarsText(range)}`}
                aria-pressed={section.id === selectedId}
                aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight Alt+ArrowLeft Alt+ArrowRight Control+ArrowLeft Control+ArrowRight Control+C Control+V Delete"
                className="section"
                data-section-id={section.id}
                title={`${section.name}: ${sectionBarsText(range)}`}
                style={{ left: px(start), width: px(end - start), opacity: drag?.id === section.id ? 0.7 : 1 }}
                onMouseDown={grab("body")}
                // A Section has no menu: the right button drags a copy.
                onContextMenu={(event) => event.preventDefault()}
                onKeyDown={(event) => onSectionKey(event, section)}
              >
                <span aria-hidden className="section-handle" style={{ left: 0 }} onMouseDown={grab("start")} />
                <span className="section-name">{section.name}</span>
                <span aria-hidden className="section-handle" style={{ right: 0 }} onMouseDown={grab("end")} />
              </div>
            );
          })}
        </div>
      </div>
      {selected && (
        <SectionFields
          key={selected.id}
          section={selected}
          onCommands={onCommands}
          onDeleted={() => setSelectedId(null)}
          onDuplicate={() => rearrange({ kind: "duplicateSection", sectionId: selected.id, at: sectionEndBar(selected) }, "Duplicate Section")}
          onDeleteBars={() => {
            rearrange({ kind: "deleteBars", startBar: selected.startBar, bars: selected.bars }, "Delete bars");
            setSelectedId(null);
          }}
          onMoveEarlier={earlierTarget(sections, selected) === null ? undefined : () => move(selected, earlierTarget(sections, selected))}
          onMoveLater={() => move(selected, laterTarget(sections, selected))}
        />
      )}
    </>
  );
}

/** The first bar `section` can start on and the last it can end on, between its neighbours. */
function room(sections: readonly Section[], section: Section): { first: number; last: number } {
  const before = sections.findLast((other) => other.startBar < section.startBar);
  const after = sections.find((other) => other.startBar > section.startBar);
  return { first: before ? sectionEndBar(before) : 1, last: after ? after.startBar - 1 : Infinity };
}

/**
 * The bar to move `section` before so that it starts at `startBar`, as the
 * song is now; or null to leave it. Past its own bars, that is the bar after
 * where it would end. One landing inside another Section goes to that
 * Section's nearer edge, as a Section can only move between others.
 */
export function moveTarget(sections: readonly Section[], section: Section, startBar: number): number | null {
  if (startBar === section.startBar) return null;
  const bar = startBar < section.startBar ? startBar : startBar + section.bars;
  const inside = sections.find((other) => other.id !== section.id && other.startBar < bar && bar < sectionEndBar(other));
  const to = inside ? (bar - inside.startBar <= sectionEndBar(inside) - bar ? inside.startBar : sectionEndBar(inside)) : bar;
  return section.startBar <= to && to <= sectionEndBar(section) ? null : to;
}

/**
 * The bar to put a copy of `section` before, dropped to start at
 * `startBar`, as the song is now; or null, dropped where it is. Unlike a
 * move, the Section stays, so the bar is where it was dropped; one inside
 * another Section, or inside itself, goes to that Section's nearer edge.
 */
export function copyTarget(sections: readonly Section[], section: Section, startBar: number): number | null {
  if (startBar === section.startBar) return null;
  const inside = sections.find((other) => other.startBar < startBar && startBar < sectionEndBar(other));
  if (!inside) return startBar;
  return startBar - inside.startBar <= sectionEndBar(inside) - startBar ? inside.startBar : sectionEndBar(inside);
}

/** Where to move `section` to swap it with the Section before it, or a bar earlier with none; null at bar 1. */
function earlierTarget(sections: readonly Section[], section: Section): number | null {
  const before = sections.findLast((other) => other.startBar < section.startBar);
  if (before) return before.startBar;
  return section.startBar > 1 ? section.startBar - 1 : null;
}

/** Where to move `section` to swap it with the Section after it, or a bar later with none. */
function laterTarget(sections: readonly Section[], section: Section): number {
  const after = sections.find((other) => other.startBar > section.startBar);
  return after ? sectionEndBar(after) : sectionEndBar(section) + 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The selected Section's name and bars as fields: everything the lane does,
 * without dragging (WCAG 2.5.7). A range that would overlap another Section
 * is refused by the command, and the refusal shown as any other is. Its
 * buttons change the song itself: duplicating, moving or deleting the
 * Section's bars with everything in them.
 */
function SectionFields({
  section,
  onCommands,
  onDeleted,
  onDuplicate,
  onDeleteBars,
  onMoveEarlier,
  onMoveLater,
}: {
  section: Section;
  onCommands: (commands: Command[], label: string) => void;
  onDeleted: () => void;
  onDuplicate: () => void;
  onDeleteBars: () => void;
  /** Left out when it is already first, at bar 1. */
  onMoveEarlier?: () => void;
  onMoveLater: () => void;
}) {
  const [name, setName] = useDraft(section.name);
  const [startText, setStartText] = useDraft(String(section.startBar));
  const [barsText, setBarsText] = useDraft(String(section.bars));
  const rename = () => {
    if (name.trim() === "") setName(section.name);
    else if (name.trim() !== section.name) {
      onCommands([{ type: "renameSection", sectionId: section.id, name: name.trim() }], "Rename Section");
    }
  };
  const resize = (range: SectionRange) => {
    if (!Number.isInteger(range.startBar) || !Number.isInteger(range.bars) || range.startBar < 1 || range.bars < 1) return;
    if (range.startBar === section.startBar && range.bars === section.bars) return;
    onCommands([{ type: "resizeSection", sectionId: section.id, ...range }], "Resize Section");
  };

  return (
    <div role="group" aria-label={`Selected Section: ${section.name}`} className="row row-end mt-3">
      <span className="eyebrow" style={{ alignSelf: "center" }}>
        Section
      </span>
      <label className="field">
        Name
        <input
          type="text"
          value={name}
          maxLength={LIMITS.nameLength}
          style={{ width: "12em" }}
          onChange={(event) => setName(event.target.value)}
          onBlur={rename}
          onKeyDown={(event) => {
            if (event.key === "Enter") rename();
            if (event.key === "Escape") setName(section.name);
          }}
        />
      </label>
      <label className="field">
        Start (bar)
        <input
          type="number"
          min={1}
          step={1}
          value={startText}
          style={{ width: "6em" }}
          onChange={(event) => {
            setStartText(event.target.value);
            if (event.target.value !== "") resize({ startBar: Number(event.target.value), bars: section.bars });
          }}
        />
      </label>
      <label className="field">
        Bars
        <input
          type="number"
          min={1}
          step={1}
          value={barsText}
          style={{ width: "6em" }}
          onChange={(event) => {
            setBarsText(event.target.value);
            if (event.target.value !== "") resize({ startBar: section.startBar, bars: Number(event.target.value) });
          }}
        />
      </label>
      <span className="hint" style={{ alignSelf: "center" }}>
        {sectionBarsText(section)}
      </span>
      <button
        type="button"
        className="btn-sm"
        onClick={() => {
          onCommands([{ type: "deleteSection", sectionId: section.id }], "Delete Section");
          onDeleted();
        }}
      >
        <Trash2 size={14} aria-hidden />
        Delete Section
      </button>
      <button type="button" className="btn-sm" title="Put a copy of it, with everything in its bars, right after it" onClick={onDuplicate}>
        <Copy size={14} aria-hidden />
        Duplicate
      </button>
      <button type="button" className="btn-sm" aria-label="Move Section earlier" title="Swap it, with everything in its bars, with the Section before" disabled={!onMoveEarlier} onClick={onMoveEarlier}>
        <ArrowLeft size={14} aria-hidden />
        Earlier
      </button>
      <button type="button" className="btn-sm" aria-label="Move Section later" title="Swap it, with everything in its bars, with the Section after" onClick={onMoveLater}>
        <ArrowRight size={14} aria-hidden />
        Later
      </button>
      <button type="button" className="btn-sm" title="Delete its bars and everything in them, closing up the song" onClick={onDeleteBars}>
        <Scissors size={14} aria-hidden />
        Delete bars
      </button>
    </div>
  );
}

/** A field's text while it is typed in, which a change from elsewhere (undo, a drag, the Assistant) replaces. */
function useDraft(value: string): [string, (text: string) => void] {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  return [draft, setDraft];
}

import { Activity, CopyPlus, GripVertical, Rows3, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

import { arrange, arrangementProblem } from "../project/arrangement";
import { type AutomationOwner, automatableSettings, lowerFirst } from "../project/automation";
import type { AutomationTarget, Command } from "../project/commands";
import {
  type AudioClip,
  type AutomatedSetting,
  type Clip,
  clipEnd,
  type Mixer,
  newId,
  type PatternClip,
  type Project,
  type Track,
  trackKind,
  type TrackKind,
} from "../project/model";
import {
  barLines,
  barsAt,
  barTicks,
  secondsBetween,
  signatureAt,
  type TempoMap,
  tempoMapOf,
  tickAtBars,
} from "../project/time";
import { isSampleDrag } from "../samples/sample-drag";
import { ContextMenu, type ContextMenuAnchor, contextMenuAnchor } from "../ui/ContextMenu";
import type { MenuItem } from "../ui/Menu";
import { readLocal, writeLocal } from "../settings/local-settings";
import { AUDIO_FILE_TYPES, type Waveform } from "./import-audio";
import { AutomationLane } from "./AutomationLane";
import { SectionLane } from "./SectionLane";
import { clipPasteTarget, editsText, sectionPaste, type TimelineClipboard } from "./timeline-clipboard";
import { TempoLane } from "./TempoLane";
import {
  accepts,
  copyOf,
  DEFAULT_SNAP,
  DEFAULT_ZOOM,
  type DragMode,
  dragged,
  fixedGrid,
  type Grid,
  loopRegion,
  mapGrid,
  newPatternClip,
  pxToTicks,
  SNAP_CHOICES,
  type SnapId,
  type Span,
  spanOf,
  ticksToPx,
  timelineEnd,
  zoomedBy,
} from "./timeline-view";

/** The timeline is always at least this long, so there is room to drop into. */
const MIN_BARS = 8;
const LANE_HEIGHT = 34;
/** How wide the column of names starts, and how narrow and wide it can be dragged. */
export const LABEL_WIDTH = { initial: 190, min: 140, max: 480 } as const;
/** Where the width the musician gave the column of names is kept between runs. */
const LABEL_WIDTH_KEY = "soundcheck.timeline.labelWidth";

/** The column's width as it was kept, or where it starts. */
function keptLabelWidth(): number {
  const kept = Number(readLocal(LABEL_WIDTH_KEY));
  return Number.isFinite(kept) && kept >= LABEL_WIDTH.min && kept <= LABEL_WIDTH.max ? kept : LABEL_WIDTH.initial;
}
/** What a Track or Bus header dragged to another place carries, so no other drop takes it. */
const ROW_DRAG_TYPE = "application/x-soundcheck-row";
/** How wide a Clip's trim handles are. */
const HANDLE_PX = 8;

/** A drag in progress on a Clip. Pixels, because that is what the mouse gives. */
interface ClipDrag {
  mode: DragMode;
  clipId: string;
  fromX: number;
  toX: number;
  /** The Track the pointer is over, for a move. */
  targetTrackId: string;
  /** Ctrl (or ⌘) makes a move a copy. */
  copy: boolean;
  /** Alt bypasses the snap grid. */
  free: boolean;
  /** Made with the right button: it copies, and without moving opens the Clip's menu instead. */
  right: boolean;
  fromY: number;
  /** The Clip pressed, for its menu to give focus back to. */
  opener: HTMLElement | null;
}

/** How far a right-button drag must go to copy, rather than open the menu, in pixels. */
const RIGHT_DRAG_PX = 4;

interface LoopDrag {
  left: number;
  fromTicks: number;
  toTicks: number;
  free: boolean;
}

export interface TimelineProps {
  project: Project;
  selectedClipId: string | null;
  /** The playback position in ticks, or null when no audio is running. */
  position: number | null;
  loop: { start: number; end: number; enabled: boolean };
  /** How many bars a Clip placed on the timeline is. */
  clipBars: number;
  onSelectClip: (clipId: string | null) => void;
  /** Every edit is commands, applied as one undo step called `label`. */
  onCommands: (commands: Command[], label: string) => void;
  onLoopRegion: (start: number, end: number) => void;
  /** The Section selected on the Section Lane, which is what Play plays, or null for the whole song. */
  onSelectSection?: (sectionId: string | null) => void;
  /** Which Section is selected, when the page keeps it (so its Whole song button can clear it); without it the Timeline keeps its own. */
  selectedSectionId?: string | null;
  /** The waveform of each audio file, by the path Audio Clips name it with. */
  waveforms?: ReadonlyMap<string, Waveform>;
  /**
   * The audio files the Project names that aren't here, by path: on their
   * way from Collaborators (ADR 0007), or missing. Their Clips play silence
   * and say so.
   */
  absentAudio?: ReadonlyMap<string, AbsentAudio>;
  /**
   * A sample from the sample browser dropped on an Audio Track's lane, at
   * the tick it landed on, snapped to the grid. Without it, lanes take none.
   */
  onDropSample?: (trackId: string, at: number, transfer: DataTransfer) => void;
  /**
   * An audio file chosen by double-clicking an Audio Track's lane, to go on
   * it at the tick clicked, snapped to the grid. Without it, those lanes
   * take no double-click.
   */
  onImportAudio?: (trackId: string, file: File, at: number) => void;
  /**
   * What a Clip's context menu offers, opened by a right-click or the
   * keyboard's Menu key on it, such as Export Clip…. With none, it has no
   * menu of its own.
   */
  clipMenuItems?: (clip: Clip, track: Track) => readonly MenuItem[];
}

/** Which list a row's header reorders it in. */
type RowKind = "track" | "bus";

/**
 * The arrangement: a ruler and one lane per Track, where Clips are placed,
 * moved, copied, trimmed and deleted, snapping to the grid. Every edit goes
 * out as a command, so it undoes; the maths lives in `timeline-view.ts`.
 *
 * Ctrl+C (⌘C) copies the selected Clip or Section, whichever has focus, and
 * Ctrl+V pastes it straight after the one selected (`timeline-clipboard.ts`).
 * The clipboard is the Timeline's own: a Clip isn't text, so the system's is
 * left alone, as it is in the Timeline's fields.
 */
export function Timeline(props: TimelineProps) {
  const {
    project,
    selectedClipId,
    position,
    loop,
    clipBars,
    onSelectClip,
    onCommands,
    onLoopRegion,
    waveforms,
    absentAudio,
    onDropSample,
    onImportAudio,
    clipMenuItems,
  } = props;
  // Where a double-clicked Audio lane's file goes, while its picker is open.
  const importAt = useRef<{ trackId: string; at: number } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [snap, setSnap] = useState<SnapId>(DEFAULT_SNAP);
  const [pxPerBar, setPxPerBar] = useState<number>(DEFAULT_ZOOM);
  const [drag, setDrag] = useState<ClipDrag | null>(null);
  const [loopDrag, setLoopDrag] = useState<LoopDrag | null>(null);
  // The Audio Track a sample is being dragged over, to show it will land there.
  const [sampleOver, setSampleOver] = useState<string | null>(null);
  // The column of names, as wide as the musician dragged it, so a long name fits.
  const [labelWidth, setLabelWidthState] = useState(keptLabelWidth);
  const setLabelWidth = (next: number) => {
    const clamped = Math.round(Math.min(LABEL_WIDTH.max, Math.max(LABEL_WIDTH.min, next)));
    setLabelWidthState(clamped);
    writeLocal(LABEL_WIDTH_KEY, String(clamped));
  };
  const [labelDrag, setLabelDrag] = useState<{ fromX: number; fromWidth: number } | null>(null);
  // The Track or Bus whose header is being dragged to another place, and the row it is over.
  const [rowDrag, setRowDrag] = useState<{ kind: RowKind; id: string; over: number | null } | null>(null);
  // The setting each open Automation Lane shows, by trackId or "master".
  const [automationOpen, setAutomationOpen] = useState<Record<string, AutomatedSetting>>({});
  // The Clip whose context menu is open, and where.
  const [clipMenu, setClipMenu] = useState<{ clipId: string; anchor: ContextMenuAnchor } | null>(null);
  const [ownSectionId, setSectionId] = useState<string | null>(null);
  const selectedSectionId = props.selectedSectionId !== undefined ? props.selectedSectionId : ownSectionId;
  const setSelectedSectionId = (sectionId: string | null) => {
    setSectionId(sectionId);
    props.onSelectSection?.(sectionId);
  };
  const [clipboard, setClipboard] = useState<TimelineClipboard | null>(null);
  // When the last right-button press on a Clip ended, so the browser's own
  // contextmenu event, which comes on the press on macOS and on the release
  // on Windows, doesn't open the menu over a copy just dropped.
  const rightPress = useRef<{ at: number; pressed: boolean }>({ at: -Infinity, pressed: false });

  const map = tempoMapOf(project);
  // Drawn in ticks, a bar of the song's starting time signature to `pxPerBar`.
  const bar = barTicks(project.timeSignature);
  const grid = mapGrid(map, snap);
  const free = fixedGrid(1);
  const end = timelineEnd(project.tracks, map, MIN_BARS, project.sections);
  const width = ticksToPx(end, pxPerBar, bar);
  const px = (ticks: number) => ticksToPx(ticks, pxPerBar, bar);
  const toTicks = (distance: number) => pxToTicks(distance, pxPerBar, bar);
  const ticksAt = (clientX: number, left: number) => Math.max(0, toTicks(clientX - left));
  /** The grid; with snapping off, the keyboard still moves by a beat. */
  const keyGrid = snap === "off" ? mapGrid(map, "beat") : grid;
  const bars = barLines(map, 0, end);

  const finishClipDrag = (current: ClipDrag, event: MouseEvent) => {
    const found = findClip(project, current.clipId);
    if (!found) return;
    const { track, clip } = found;
    const span = spanOf(clip, map);
    const next = dragged(span, current.mode, toTicks(event.clientX - current.fromX), event.altKey || current.free ? free : grid);
    if (current.mode !== "move") {
      if (next.start !== span.start || next.length !== span.length) {
        onCommands([trimCommand(clip, next, map)], "Trim Clip");
      }
      return;
    }
    const trackId = current.targetTrackId;
    if (current.right && Math.hypot(event.clientX - current.fromX, event.clientY - current.fromY) < RIGHT_DRAG_PX && trackId === track.id) {
      // A right-click, not a drag: the Clip's menu, where it has one.
      if (current.opener && clipMenuItems?.(clip, track).length) {
        setClipMenu({ clipId: clip.id, anchor: { x: event.clientX, y: event.clientY, opener: current.opener } });
      }
      return;
    }
    if (current.copy || event.ctrlKey || event.metaKey) {
      const id = newId();
      onCommands([{ type: "addClip", trackId, clip: copyOf(clip, next.start, id) }], "Copy Clip");
      onSelectClip(id);
    } else if (next.start !== clip.start || trackId !== track.id) {
      onCommands([{ type: "moveClip", clipId: clip.id, start: next.start, trackId }], "Move Clip");
    }
  };

  // The mouse leaves the Clip long before the drag ends, so the rest of the
  // drag is followed on the window. These two have no dependency list on
  // purpose: each render re-subscribes, so the handlers always see the drag
  // and the Project as they are now.
  useEffect(() => {
    if (!drag) return;
    const move = (event: MouseEvent) =>
      setDrag((current) =>
        current
          ? {
              ...current,
              toX: event.clientX,
              free: event.altKey,
              copy: current.mode === "move" && (current.right || current.copy || event.ctrlKey || event.metaKey),
            }
          : null,
      );
    const up = (event: MouseEvent) => {
      setDrag(null);
      if (drag.right) rightPress.current = { at: event.timeStamp, pressed: false };
      finishClipDrag(drag, event);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  });

  useEffect(() => {
    if (!loopDrag) return;
    const move = (event: MouseEvent) =>
      setLoopDrag((current) =>
        current ? { ...current, toTicks: ticksAt(event.clientX, current.left), free: event.altKey } : null,
      );
    const up = (event: MouseEvent) => {
      setLoopDrag(null);
      const to = ticksAt(event.clientX, loopDrag.left);
      const region = loopRegion(loopDrag.fromTicks, to, event.altKey || loopDrag.free ? free : grid);
      // A region dragged on the ruler is what plays, in place of a selected Section.
      setSelectedSectionId(null);
      onLoopRegion(region.start, region.end);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  });

  const startClipDrag = (event: React.MouseEvent, mode: DragMode, clip: Clip, track: Track) => {
    event.stopPropagation();
    // The right button drags a copy by its body, from wherever it is pressed; any other opens nothing.
    const right = event.button === 2;
    if (event.button !== 0 && !right) return;
    if (right) {
      rightPress.current = { at: event.timeStamp, pressed: true };
      onSelectClip(clip.id);
    }
    setDrag({
      mode: right ? "move" : mode,
      clipId: clip.id,
      fromX: event.clientX,
      toX: event.clientX,
      fromY: event.clientY,
      targetTrackId: track.id,
      copy: right || (mode === "move" && (event.ctrlKey || event.metaKey)),
      free: event.altKey,
      right,
      opener: (event.currentTarget as HTMLElement).closest<HTMLElement>(".clip"),
    });
  };

  /** Where a Clip is drawn: while it is being dragged, where it would land. */
  const shownSpan = (clip: Clip): Span => {
    const span = spanOf(clip, map);
    if (!drag || drag.clipId !== clip.id) return span;
    const next = dragged(span, drag.mode, toTicks(drag.toX - drag.fromX), drag.free ? free : grid);
    // Audio moved under a different tempo spans a different number of ticks.
    return drag.mode === "move" ? spanOf({ ...clip, start: next.start }, map) : next;
  };

  const placeClip = (event: React.MouseEvent, track: Track) => {
    // Only on the empty part of the lane. An Audio Clip needs a file to
    // play (#17), so an Audio lane asks for one, to go where it was clicked.
    if (event.target !== event.currentTarget) return;
    const left = event.currentTarget.getBoundingClientRect().left;
    const start = (event.altKey ? free : grid).snap(ticksAt(event.clientX, left));
    if (track.kind === "audio") {
      if (!onImportAudio) return;
      importAt.current = { trackId: track.id, at: start };
      importInput.current?.click();
      return;
    }
    if (track.kind !== "instrument") return;
    const length = clipBars * barTicks(signatureAt(map, start));
    const id = newId();
    onCommands([{ type: "addClip", trackId: track.id, clip: newPatternClip(start, length, id) }], "Add Clip");
    onSelectClip(id);
  };

  const onClipKey = (event: React.KeyboardEvent, clip: Clip, track: Track) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const mode: DragMode = event.shiftKey ? "trimEnd" : event.altKey ? "trimStart" : "move";
      const span = spanOf(clip, map);
      const next = dragged(span, mode, event.key === "ArrowLeft" ? -keyGrid.step : keyGrid.step, keyGrid);
      if (next.start === span.start && next.length === span.length) return;
      if (mode === "move") onCommands([{ type: "moveClip", clipId: clip.id, start: next.start }], "Move Clip");
      else onCommands([trimCommand(clip, next, map)], "Trim Clip");
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const to = project.tracks[project.tracks.indexOf(track) + (event.key === "ArrowUp" ? -1 : 1)];
      if (!to) return;
      onCommands([{ type: "moveClip", clipId: clip.id, start: clip.start, trackId: to.id }], "Move Clip");
    } else if (event.key === "Delete" || event.key === "Backspace") {
      onCommands([{ type: "deleteClip", clipId: clip.id }], "Delete Clip");
      onSelectClip(null);
    } else if ((event.key === "d" || event.key === "D") && (event.ctrlKey || event.metaKey)) {
      const id = newId();
      const copy = copyOf(clip, Math.ceil(clipEnd(clip, map)), id);
      onCommands([{ type: "addClip", trackId: track.id, clip: copy }], "Copy Clip");
      onSelectClip(id);
    } else {
      return;
    }
    event.preventDefault();
  };

  /** Ctrl+C and Ctrl+V anywhere in the Timeline but its text fields. */
  const onClipboardKey = (event: React.KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || editsText(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === "c") {
      // The Section with focus, then the selected Clip, then the selected Section.
      const focused = (event.target as HTMLElement).closest<HTMLElement>("[data-section-id]")?.dataset.sectionId;
      const sectionId = focused ?? (selected ? null : selectedSectionId);
      const section = project.sections.find((candidate) => candidate.id === sectionId);
      if (section) setClipboard({ kind: "section", sectionId: section.id, name: section.name });
      else if (selected) setClipboard({ kind: "clip", clip: structuredClone(selected.clip), trackId: selected.track.id });
      else return;
    } else if (key === "v") {
      if (!clipboard) return;
      if (clipboard.kind === "clip") {
        const to = clipPasteTarget(project, map, clipboard, selected);
        if (!to) return;
        const id = newId();
        onCommands([{ type: "addClip", trackId: to.trackId, clip: copyOf(clipboard.clip, to.start, id) }], "Paste Clip");
        onSelectClip(id);
      } else {
        const paste = sectionPaste(project, clipboard, selectedSectionId);
        if (!paste || arrangementProblem(project, paste)) return;
        const arranged = arrange(project, paste);
        onCommands([{ type: "rearrange", arrangement: arranged.arrangement }], "Paste Section");
        setSelectedSectionId(arranged.section?.id ?? null);
      }
    } else {
      return;
    }
    event.preventDefault();
  };

  const region = loopDrag
    ? loopRegion(loopDrag.fromTicks, loopDrag.toTicks, loopDrag.free ? free : grid)
    : { start: loop.start, end: loop.end };

  const selected = selectedClipId ? findClip(project, selectedClipId) : null;
  // Gone with its Clip, as after an undo.
  const menuFor = clipMenu ? findClip(project, clipMenu.clipId) : null;

  /** The button that opens and closes an Automation Lane, marked when anything is automated. */
  const automationToggle = (key: string, name: string, owner: AutomationOwner) => {
    const open = key in automationOpen;
    const { automation } = owner;
    const labels = new Map(automatableSettings(project, owner).map((option) => [option.setting, option.label]));
    const automated = automation.map((lane) => lowerFirst(labels.get(lane.setting) ?? lane.setting)).join(" and ");
    return (
      <button
        type="button"
        className="btn-sm btn-icon"
        aria-expanded={open}
        aria-label={`${name} Automation${automated ? ` (${automated} automated)` : ""}`}
        title={automated ? `Automation: ${automated}` : "Automation"}
        data-automated={automated !== ""}
        onClick={() =>
          setAutomationOpen((current) => {
            const others = Object.fromEntries(Object.entries(current).filter(([other]) => other !== key));
            return open ? others : { ...others, [key]: automation[0]?.setting ?? "volume" };
          })
        }
      >
        <Activity size={14} aria-hidden />
      </button>
    );
  };

  /** A row's place in its list moved to `index`: Tracks among the Tracks, Buses among the Buses. */
  const moveRow = (kind: RowKind, id: string, index: number) => {
    const count = kind === "track" ? project.tracks.length : project.buses.length;
    if (index < 0 || index >= count) return;
    onCommands([kind === "track" ? { type: "moveTrack", trackId: id, index } : { type: "moveBus", busId: id, index }], kind === "track" ? "Move Track" : "Move Bus");
  };

  /**
   * A Track's or Bus's header: a grip that drags it, or moves it with the
   * up and down arrows, to another place among its kind; its name; Mute and
   * Solo, as on its mixer strip; and its Automation button. The Master has
   * no grip, so it stays last.
   */
  const laneHead = (
    kind: RowKind,
    id: string,
    name: string,
    index: number,
    owner: AutomationOwner & { mixer: Mixer },
    key: string,
    trackKindOf?: TrackKind,
  ) => {
    const count = kind === "track" ? project.tracks.length : project.buses.length;
    const setMixer = (mixer: Partial<Mixer>, label: string) =>
      onCommands([kind === "track" ? { type: "setTrackMixer", trackId: id, mixer } : { type: "setBusMixer", busId: id, mixer }], label);
    // Where the dragged row would land: above this one if it comes from below, under it if from above.
    const from = rowDrag?.kind === kind ? (kind === "track" ? project.tracks : project.buses).findIndex((row) => row.id === rowDrag.id) : -1;
    const drop = from >= 0 && from !== index && rowDrag?.over === index ? (from < index ? "after" : "before") : undefined;
    return (
      <div
        className={kind === "track" ? "lane-label lane-head kind-stripe" : "lane-label lane-head"}
        data-track-kind={trackKindOf}
        data-drop={drop}
        style={{ width: labelWidth }}
        onDragOver={(event) => {
          if (rowDrag?.kind !== kind) return;
          event.preventDefault();
          if (rowDrag.over !== index) setRowDrag({ ...rowDrag, over: index });
        }}
        onDrop={(event) => {
          if (rowDrag?.kind !== kind) return;
          event.preventDefault();
          if (rowDrag.id !== id) moveRow(kind, rowDrag.id, index);
          setRowDrag(null);
        }}
      >
        <button
          type="button"
          className="btn-sm btn-icon lane-grip"
          draggable
          aria-label={`Move ${name}`}
          aria-description={`${index + 1} of ${count}. The up and down arrows move it.`}
          aria-keyshortcuts="ArrowUp ArrowDown"
          title="Drag to reorder, or use the up and down arrows"
          onDragStart={(event) => {
            event.dataTransfer?.setData(ROW_DRAG_TYPE, id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            setRowDrag({ kind, id, over: null });
          }}
          onDragEnd={() => setRowDrag(null)}
          onKeyDown={(event) => {
            const by = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
            if (by === 0) return;
            event.preventDefault();
            moveRow(kind, id, index + by);
          }}
        >
          <GripVertical size={14} aria-hidden />
        </button>
        <span className="lane-name" title={name}>
          {name}
        </span>
        <span className="lane-head-buttons">
          <button
            type="button"
            className="btn-sm btn-icon btn-mute"
            aria-label={`Mute ${name}`}
            title="Mute"
            aria-pressed={owner.mixer.mute}
            onClick={() => setMixer({ mute: !owner.mixer.mute }, owner.mixer.mute ? "Unmute" : "Mute")}
          >
            M
          </button>
          <button
            type="button"
            className="btn-sm btn-icon btn-solo"
            aria-label={`Solo ${name}`}
            title="Solo"
            aria-pressed={owner.mixer.solo}
            onClick={() => setMixer({ solo: !owner.mixer.solo }, owner.mixer.solo ? "Unsolo" : "Solo")}
          >
            S
          </button>
          {automationToggle(key, name, owner)}
        </span>
      </div>
    );
  };

  const automationLane = (key: string, name: string, target: AutomationTarget, owner: AutomationOwner) => {
    const open = automationOpen[key];
    if (!open) return null;
    const settings = automatableSettings(project, owner);
    // A setting that went away while its lane was open (its Effect removed,
    // say) gives the lane back to the volume.
    const setting = settings.find((option) => option.setting === open) ?? settings[0]!;
    return (
      <AutomationLane
        key={`${key}-${setting.setting}`}
        owner={name}
        target={target}
        setting={setting}
        settings={settings}
        onSetting={(next) => setAutomationOpen((current) => ({ ...current, [key]: next }))}
        breakpoints={owner.automation.find((lane) => lane.setting === setting.setting)?.breakpoints ?? []}
        map={map}
        grid={grid}
        width={width}
        labelWidth={labelWidth}
        px={px}
        ticksAt={ticksAt}
        pxToTicks={toTicks}
        position={position}
        onCommands={onCommands}
      />
    );
  };

  return (
    <section aria-labelledby="timeline-heading" className="panel" onKeyDown={onClipboardKey}>
      <div className="panel-head">
        <h2 id="timeline-heading">
          <Rows3 size={18} aria-hidden />
          Timeline
        </h2>
        <label className="field-inline">
          Snap
          <select value={snap} onChange={(event) => setSnap(event.target.value as SnapId)}>
            {SNAP_CHOICES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <div className="row" role="group" aria-label="Zoom controls">
          <button type="button" className="btn-sm btn-icon" aria-label="Zoom out" onClick={() => setPxPerBar(zoomedBy(pxPerBar, -1))}>
            <ZoomOut size={14} aria-hidden />
          </button>
          <output aria-label="Zoom" className="hint num">
            {pxPerBar} px/bar
          </output>
          <button type="button" className="btn-sm btn-icon" aria-label="Zoom in" onClick={() => setPxPerBar(zoomedBy(pxPerBar, 1))}>
            <ZoomIn size={14} aria-hidden />
          </button>
        </div>
      </div>
      <details style={{ marginBottom: 12 }}>
        <summary className="hint">Mouse and keyboard controls</summary>
        <p className="hint">
          Drag a Clip to move it, or drag it with the right button to copy it, its edges to trim it, and the ruler to set the loop region. Double-click the
          Section lane above the ruler to name a part of the song, and drag a Section&apos;s edges to resize it. Hold Ctrl to copy, Alt
          to ignore the grid. On the selected Clip: arrow keys move it, Shift+arrow trims its end, Alt+arrow trims its
          start, Ctrl+D copies it and Delete removes it. Ctrl+C copies the selected Clip or Section and Ctrl+V pastes it
          straight after the one selected, a Section with everything in its bars. Double-click a lane to place a Clip, or an Audio Track&apos;s to choose a file to put there. Everything dragging does
          can also be typed into the selected Clip&apos;s fields below and the loop fields in the transport bar.
        </p>
      </details>
      <input
        ref={importInput}
        type="file"
        hidden
        accept={AUDIO_FILE_TYPES}
        aria-label="Audio file to place on the Timeline"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const target = importAt.current;
          importAt.current = null;
          // The same file can be chosen again, for a second Clip.
          event.target.value = "";
          if (file && target) onImportAudio?.(target.trackId, file, target.at);
        }}
      />

      <div className="timeline-scroll">
        <div style={{ width: labelWidth + width, position: "relative" }}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Width of the names"
            aria-valuenow={labelWidth}
            aria-valuemin={LABEL_WIDTH.min}
            aria-valuemax={LABEL_WIDTH.max}
            aria-keyshortcuts="ArrowLeft ArrowRight"
            tabIndex={0}
            title="Drag to widen the names, or use the left and right arrows"
            className="label-resize"
            data-dragging={labelDrag ? true : undefined}
            style={{ left: labelWidth - 3 }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture?.(event.pointerId);
              setLabelDrag({ fromX: event.clientX, fromWidth: labelWidth });
            }}
            onPointerMove={(event) => labelDrag && setLabelWidth(labelDrag.fromWidth + event.clientX - labelDrag.fromX)}
            onPointerUp={() => setLabelDrag(null)}
            onPointerCancel={() => setLabelDrag(null)}
            onKeyDown={(event) => {
              const by = event.key === "ArrowLeft" ? -20 : event.key === "ArrowRight" ? 20 : 0;
              if (by === 0) return;
              event.preventDefault();
              setLabelWidth(labelWidth + by);
            }}
          />
          <SectionLane
            project={project}
            map={map}
            width={width}
            labelWidth={labelWidth}
            px={px}
            ticksAt={ticksAt}
            pxToTicks={toTicks}
            position={position}
            onCommands={onCommands}
            selectedId={selectedSectionId}
            onSelect={setSelectedSectionId}
          />

          <div style={{ display: "flex" }}>
            <div style={{ width: labelWidth, flex: "none" }} className="lane-label" />
            <div
              role="group"
              aria-label="Ruler"
              className="ruler"
              onMouseDown={(event) => {
                const left = event.currentTarget.getBoundingClientRect().left;
                const at = ticksAt(event.clientX, left);
                setLoopDrag({ left, fromTicks: at, toTicks: at, free: event.altKey });
              }}
              style={{ width }}
            >
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  left: px(region.start),
                  width: px(region.end - region.start),
                  top: 0,
                  bottom: 0,
                  background: loop.enabled || loopDrag ? "var(--loop)" : "var(--loop-off)",
                }}
              />
              {barNumbers(bars, pxPerBar).map(({ tick, bar: number }) => (
                <span key={number} aria-hidden className="ruler-number" style={{ left: px(tick) + 4 }}>
                  {number}
                </span>
              ))}
            </div>
          </div>

          <TempoLane
            project={project}
            map={map}
            grid={grid}
            width={width}
            labelWidth={labelWidth}
            px={px}
            ticksAt={ticksAt}
            pxToTicks={toTicks}
            position={position}
            onCommands={onCommands}
          />

          {project.tracks.map((track, trackAt) => (
            <Fragment key={track.id}>
              <div style={{ display: "flex", alignItems: "stretch" }}>
                {laneHead("track", track.id, track.name, trackAt, track, track.id, trackKind(track))}
                <div
                  role="group"
                  aria-label={`${track.name} lane`}
                  className="lane"
                  onMouseMove={() => drag?.mode === "move" && setDrag({ ...drag, targetTrackId: track.id })}
                  onDoubleClick={(event) => placeClip(event, track)}
                  onMouseDown={(event) => event.target === event.currentTarget && onSelectClip(null)}
                  onDragOver={(event) => {
                    if (!onDropSample || track.kind !== "audio" || !isSampleDrag(event.dataTransfer)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    setSampleOver(track.id);
                  }}
                  onDragLeave={() => setSampleOver(null)}
                  onDrop={(event) => {
                    setSampleOver(null);
                    if (!onDropSample || track.kind !== "audio" || !isSampleDrag(event.dataTransfer)) return;
                    event.preventDefault();
                    const left = event.currentTarget.getBoundingClientRect().left;
                    const at = (event.altKey ? free : grid).snap(ticksAt(event.clientX, left));
                    onDropSample(track.id, at, event.dataTransfer);
                  }}
                  style={{
                    width,
                    height: LANE_HEIGHT,
                    outline: sampleOver === track.id ? "3px dashed var(--focus)" : laneOutline(drag, track, project),
                    outlineOffset: -2,
                  }}
                >
                  {bars.map(({ tick }) => (
                    <span key={tick} aria-hidden className="bar-line" style={{ left: px(tick) - 1 }} />
                  ))}
                  {(track.clips as Clip[]).map((clip, index) => {
                    const name = `${track.name} Clip ${index + 1}`;
                    const shown = shownSpan(clip);
                    const isSelected = clip.id === selectedClipId;
                    return (
                      <div
                        key={clip.id}
                        role="button"
                        tabIndex={0}
                        aria-label={name}
                        aria-describedby={clip.kind === "audio" && absentAudio?.has(clip.file) ? `${clip.id}-absent` : undefined}
                        aria-pressed={isSelected}
                        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Alt+ArrowLeft Alt+ArrowRight Control+D Control+C Control+V Delete"
                        className="clip"
                        data-kind={clip.kind}
                        onMouseDown={(event) => startClipDrag(event, "move", clip, track)}
                        onClick={() => onSelectClip(clip.id)}
                        onContextMenu={(event) => {
                          // A right-button press opens the menu as it is released, unless it dragged a copy.
                          const { at, pressed } = rightPress.current;
                          if (pressed || event.timeStamp - at < 1000) {
                            event.preventDefault();
                            return;
                          }
                          if (!clipMenuItems?.(clip, track).length) return;
                          event.preventDefault();
                          onSelectClip(clip.id);
                          setClipMenu({ clipId: clip.id, anchor: contextMenuAnchor(event) });
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onSelectClip(clip.id);
                          } else onClipKey(event, clip, track);
                        }}
                        style={{
                          left: px(shown.start),
                          width: px(shown.length),
                          opacity: drag?.clipId === clip.id ? 0.7 : 1,
                        }}
                      >
                        <span
                          // Mouse only: the keyboard and the Clip fields trim without it.
                          aria-hidden
                          title={`Trim the start of ${name}`}
                          className="clip-handle"
                          onMouseDown={(event) => startClipDrag(event, "trimStart", clip, track)}
                          style={{ left: 0, width: HANDLE_PX }}
                        />
                        <span
                          aria-hidden
                          title={`Trim the end of ${name}`}
                          className="clip-handle"
                          onMouseDown={(event) => startClipDrag(event, "trimEnd", clip, track)}
                          style={{ right: 0, width: HANDLE_PX }}
                        />
                        {clip.kind === "pattern" ? (
                          <ClipNotes clip={clip} px={px} />
                        ) : (
                          <>
                            <ClipWaveform
                              waveform={waveforms?.get(clip.file)}
                              // Trimming the start moves where in the file it plays from.
                              from={
                                clip.fileOffset +
                                (drag?.mode === "trimStart" ? secondsBetween(map, clip.start, shown.start) : 0)
                              }
                              seconds={secondsBetween(map, shown.start, shown.start + shown.length)}
                            />
                            <span className="clip-label" style={{ paddingLeft: HANDLE_PX + 2 }}>
                              {fileName(clip)}
                            </span>
                            <ClipAudioAbsent id={`${clip.id}-absent`} absent={absentAudio?.get(clip.file)} />
                          </>
                        )}
                      </div>
                    );
                  })}
                  {position !== null && <div aria-hidden className="playhead" style={{ left: px(position) }} />}
                </div>
              </div>
              {automationLane(track.id, track.name, { trackId: track.id }, track)}
            </Fragment>
          ))}
          {project.buses.map((bus, busAt) => (
            <Fragment key={bus.id}>
              <div style={{ display: "flex" }}>
                {laneHead("bus", bus.id, bus.name, busAt, bus, `bus:${bus.id}`)}
                <div aria-hidden className="lane master-lane" style={{ width }} />
              </div>
              {automationLane(`bus:${bus.id}`, bus.name, { busId: bus.id }, bus)}
            </Fragment>
          ))}
          <div style={{ display: "flex" }}>
            <div className="lane-label" style={{ width: labelWidth, justifyContent: "space-between" }}>
              Master
              {automationToggle("master", "Master", project.master)}
            </div>
            <div aria-hidden className="lane master-lane" style={{ width }} />
          </div>
          {automationLane("master", "Master", "master", project.master)}
        </div>
      </div>
      {project.tracks.length === 0 && <p className="hint mt-3">No Tracks yet.</p>}
      {clipMenu && menuFor && clipMenuItems && (
        <ContextMenu
          anchor={clipMenu.anchor}
          ariaLabel={`${menuFor.track.name} Clip ${(menuFor.track.clips as Clip[]).indexOf(menuFor.clip) + 1}`}
          items={clipMenuItems(menuFor.clip, menuFor.track)}
          onClose={() => setClipMenu(null)}
        />
      )}
      {selected && (
        <ClipFields
          key={selected.clip.id}
          project={project}
          track={selected.track}
          clip={selected.clip}
          map={map}
          grid={keyGrid}
          onCommands={onCommands}
          onSelectClip={onSelectClip}
        />
      )}
    </section>
  );
}

/** Bars as a field shows them: to three places, without trailing zeros. */
function roundedBars(bars: number): number {
  return Number(bars.toFixed(3));
}

/**
 * The selected Clip's position, length and Track as fields: everything a
 * drag on the Timeline does, without dragging (WCAG 2.5.7).
 */
function ClipFields({
  project,
  track,
  clip,
  map,
  grid,
  onCommands,
  onSelectClip,
}: {
  project: Project;
  track: Track;
  clip: Clip;
  map: TempoMap;
  grid: Grid;
  onCommands: (commands: Command[], label: string) => void;
  onSelectClip: (clipId: string | null) => void;
}) {
  const bar = barTicks(signatureAt(map, clip.start));
  const name = `${track.name} Clip ${(track.clips as Clip[]).indexOf(clip) + 1}`;
  const step = Number((grid.step / bar).toFixed(4));
  const startBars = barsAt(map, clip.start);
  const end = clipEnd(clip, map);
  return (
    <div role="group" aria-label={`Selected Clip: ${name}`} className="row row-end mt-3">
      <span className="eyebrow" style={{ alignSelf: "center" }}>
        {name}
      </span>
      <label className="field">
        Clip start (bar)
        <input
          type="number"
          min={1}
          step={step}
          value={roundedBars(startBars)}
          style={{ width: "6em" }}
          onChange={(event) => {
            const start = Math.round(tickAtBars(map, Number(event.target.value)));
            if (event.target.value !== "" && start >= 0 && start !== clip.start) {
              onCommands([{ type: "moveClip", clipId: clip.id, start }], "Move Clip");
            }
          }}
        />
      </label>
      <label className="field">
        Clip length (bars)
        <input
          type="number"
          min={step}
          step={step}
          value={roundedBars(barsAt(map, end) - startBars)}
          style={{ width: "6em" }}
          onChange={(event) => {
            const length = Math.round(tickAtBars(map, startBars + Number(event.target.value))) - clip.start;
            if (event.target.value !== "" && length > 0 && length !== Math.round(end - clip.start)) {
              onCommands([trimCommand(clip, { start: clip.start, length }, map)], "Trim Clip");
            }
          }}
        />
      </label>
      <label className="field">
        Clip Track
        <select
          value={track.id}
          onChange={(event) =>
            onCommands([{ type: "moveClip", clipId: clip.id, start: clip.start, trackId: event.target.value }], "Move Clip")
          }
        >
          {project.tracks
            .filter((candidate) => candidate.id === track.id || accepts(candidate, clip))
            .map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
        </select>
      </label>
      <button
        type="button"
        className="btn-sm"
        onClick={() => {
          const id = newId();
          onCommands([{ type: "addClip", trackId: track.id, clip: copyOf(clip, Math.ceil(end), id) }], "Copy Clip");
          onSelectClip(id);
        }}
      >
        <CopyPlus size={14} aria-hidden />
        Duplicate
      </button>
      <button
        type="button"
        className="btn-sm"
        onClick={() => {
          onCommands([{ type: "deleteClip", clipId: clip.id }], "Delete Clip");
          onSelectClip(null);
        }}
      >
        <Trash2 size={14} aria-hidden />
        Delete
      </button>
    </div>
  );
}


/** Trimming an Audio Clip's start moves where in its file it plays from. */
function trimCommand(clip: Clip, next: Span, map: TempoMap): Command {
  if (clip.kind !== "audio") return { type: "trimClip", clipId: clip.id, ...next };
  const fileOffset = Math.max(0, clip.fileOffset + secondsBetween(map, clip.start, next.start));
  return { type: "trimClip", clipId: clip.id, ...next, fileOffset };
}

function findClip(project: Project, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of project.tracks) {
    const clip = (track.clips as Clip[]).find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

/** The lane a Clip would be dropped on, green when it can hold it, red when not. */
function laneOutline(drag: ClipDrag | null, track: Track, project: Project): string | undefined {
  if (!drag || drag.mode !== "move" || drag.targetTrackId !== track.id) return undefined;
  const found = findClip(project, drag.clipId);
  if (!found || found.track.id === track.id) return undefined;
  return accepts(track, found.clip) ? "3px solid var(--play)" : "3px dashed var(--record)";
}

/** Bar numbers thin out as the timeline is zoomed out, so they stay readable. */
function barNumbers(bars: { tick: number; bar: number }[], pxPerBar: number): { tick: number; bar: number }[] {
  const every = pxPerBar >= 48 ? 1 : pxPerBar >= 24 ? 2 : 4;
  return bars.filter(({ bar }) => (bar - 1) % every === 0);
}

function fileName(clip: AudioClip): string {
  return clip.file.split("/").at(-1) ?? clip.file;
}

/** Why an Audio Clip's file isn't here: it is on its way from a Collaborator, or it is missing. */
export type AbsentAudio = "arriving" | "missing";

/** What an Audio Clip whose file isn't here says, while it plays silence. */
export const ABSENT_AUDIO_TEXT: Record<AbsentAudio, string> = {
  arriving: "Waiting for its audio: silent until it arrives",
  missing: "Its audio is missing, so it is silent",
};

/** Says, on the Clip, that its audio isn't here, and so it is silent. Nothing once it is. */
function ClipAudioAbsent({ id, absent }: { id: string; absent: AbsentAudio | undefined }) {
  if (!absent) return null;
  return (
    <span id={id} className="clip-label clip-absent" data-absent={absent} style={{ paddingLeft: HANDLE_PX + 2 }}>
      {ABSENT_AUDIO_TEXT[absent]}
    </span>
  );
}

/**
 * The part of an Audio Clip's file it plays, `seconds` of it from `from`
 * seconds in, drawn as its peaks. Nothing until the file has been measured.
 */
function ClipWaveform({ waveform, from, seconds }: { waveform: Waveform | undefined; from: number; seconds: number }) {
  if (!waveform || waveform.peaks.length === 0 || waveform.seconds <= 0 || seconds <= 0) return null;
  const step = waveform.seconds / waveform.peaks.length;
  const first = Math.max(0, Math.floor(from / step));
  const last = Math.min(waveform.peaks.length, Math.ceil((from + seconds) / step));
  const path = waveform.peaks
    .slice(first, last)
    .map((peak, index) => {
      const x = (first + index + 0.5) * step - from;
      const height = Math.max(peak, 0.01);
      return `M${x.toFixed(4)} ${-height}V${height}`;
    })
    .join("");
  return (
    <svg
      role="img"
      aria-label="Waveform"
      viewBox={`0 -1 ${seconds} 2`}
      preserveAspectRatio="none"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    >
      <path d={path} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" fill="none" />
    </svg>
  );
}

/** A thumbnail of the Clip's notes, so it is clear what plays. */
function ClipNotes({ clip, px }: { clip: PatternClip; px: (ticks: number) => number }) {
  if (clip.notes.length === 0) return null;
  const pitches = clip.notes.map((n) => n.pitch);
  const low = Math.min(...pitches);
  const range = Math.max(1, Math.max(...pitches) - low);
  return (
    <>
      {clip.notes.map((note, index) => (
        <span
          key={index}
          aria-hidden
          className="clip-note"
          style={{
            left: px(note.start),
            width: Math.max(1, px(Math.min(note.length, clip.length - note.start))),
            bottom: `${((note.pitch - low) / range) * 70 + 10}%`,
          }}
        />
      ))}
    </>
  );
}

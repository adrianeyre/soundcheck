import { ArrowDownToLine, ArrowUpToLine, GripVertical, X } from "lucide-react";
import { createPortal } from "react-dom";
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  fitToContent,
  GRID,
  moveWidget,
  pinWidget,
  resizeWidget,
  rowsFor,
  setWidgetHidden,
  unfitted,
  specsOf,
  widgetSpec,
  widgetsIn,
  withoutWidgets,
  ZONES,
  type Cell,
  type WidgetId,
  type WidgetLayout,
  type Zone,
} from "./layout";

export interface WidgetGridProps {
  layout: WidgetLayout;
  onLayout: (layout: WidgetLayout) => void;
  /** What each Widget shows. One left out isn't on this page at all, and the Grid leaves its place alone. */
  widgets: Partial<Record<WidgetId, ReactNode>>;
  /**
   * The Widgets with nothing to show just now, such as the Step Sequencer
   * with no Pattern Clip selected. They are off the Grid, and their rows
   * closed up, until they have something, when they come back where they
   * were. Their content stays mounted, and whether the musician hid them is
   * kept as it was.
   */
  empty?: readonly WidgetId[];
  /**
   * Where the pinned Zones are drawn: slots between the title bar and the page, and between the
   * page and the footer, so they sit flush against both and never cover what has focus. Without
   * one, a Zone is drawn in place.
   */
  pinned?: Partial<Record<"top" | "bottom", HTMLElement | null>>;
}

/** Whether two measurements of the Widgets' rows are the same, Widget for Widget: those of this Grid's page. */
function sameRows(a: Partial<Record<WidgetId, number>>, b: Partial<Record<WidgetId, number>>): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<WidgetId>;
  return [...ids].every((id) => a[id] === b[id]);
}

/** How far the pointer must go before a press becomes a drag, so a click stays a click. */
const DRAG_THRESHOLD = 4;

interface Gesture {
  id: WidgetId;
  kind: "move" | "resize";
  pointerId: number;
  from: { x: number; y: number };
  /** The width and height of one cell plus its gap, in pixels. */
  pitch: { x: number; y: number };
  /** Where the pointer is now. */
  last: { x: number; y: number };
  /** What the Grid scrolls in, and how far it had scrolled when the press began: scrolling mid-drag carries the Widget along. */
  scroller: HTMLElement | null;
  scrollStart: number;
  started: boolean;
}

interface Drag {
  id: WidgetId;
  kind: "move" | "resize";
  offset: { x: number; y: number };
  /** The layout as it will be drawn once dropped, which the placeholder and the others show. */
  preview: WidgetLayout;
  /** The same layout as it will be kept: what dropping it saves, so it lands exactly where the placeholder is. */
  saved: WidgetLayout;
}

/** How close to the top or bottom of what the Grid scrolls in the pointer must be for a drag to scroll it. */
const EDGE = 48;

const describe = (title: string, cell: Cell) =>
  `${title}: column ${cell.x + 1}, row ${cell.y + 1}, ${cell.w} wide by ${cell.h} tall.`;

/**
 * A page's Widgets on their Grid (ADR 0004): the Editor's, or the Mixer page's. Each is dragged by its bar
 * and resized by its corner, snapping to whole cells; from the keyboard, its
 * grip moves it with the arrow keys and resizes it with Shift and the arrow
 * keys. Pinned Widgets are full-width bands under the title bar or above
 * the footer, outside the page that scrolls; they are resized by the edge
 * that faces the page.
 */
export function WidgetGrid({ layout: given, onLayout: save, widgets, pinned, empty = [] }: WidgetGridProps) {
  const present = (id: WidgetId) => widgets[id] !== undefined;
  // A Widget this page leaves out, or with nothing to show, takes no rows on it, and keeps whether
  // the musician hid it for when it is drawn.
  // This page's Widgets are the ones its layout holds.
  const specs = specsOf(given);
  const absent = specs.map((spec) => spec.id).filter((id) => !present(id) || empty.includes(id));
  const kept = withoutWidgets(given, absent);
  // How many rows each Widget's content needs, measured as it is drawn: none is drawn taller.
  const [needed, setNeeded] = useState<Partial<Record<WidgetId, number>>>({});
  const layout = fitToContent(kept, needed);
  // A change is made to the layout as drawn, and kept with each Widget's own height, but `resized`'s.
  const toKept = (drawn: WidgetLayout, resized: WidgetId | null = null) => {
    const next = unfitted(drawn, kept, resized);
    for (const id of absent) next[id] = { ...next[id], hidden: given[id].hidden };
    return next;
  };
  const onLayout = (drawn: WidgetLayout, resized: WidgetId | null = null) => save(toKept(drawn, resized));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const gesture = useRef<Gesture | null>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);
  // Each Widget's content is drawn once, into a node of its own that moves with it between
  // Zones and is only detached while it is hidden: it is never unmounted, so a take being
  // recorded or a Request running carries on wherever the Widget goes.
  const [hosts] = useState(() => new Map<WidgetId, HTMLDivElement>());
  const hostFor = (id: WidgetId) => {
    let host = hosts.get(id);
    if (!host) {
      host = document.createElement("div");
      host.className = "widget-content";
      hosts.set(id, host);
    }
    return host;
  };
  // Ref callbacks made once per element, so React doesn't detach and reattach them on every render.
  const [stable] = useState(() => {
    const made = new Map<string, (element: HTMLElement | null) => void>();
    return (key: string, make: () => (element: HTMLElement | null) => void) => {
      if (!made.has(key)) made.set(key, make());
      return made.get(key)!;
    };
  });
  const hintId = useId();
  const shown = drag?.preview ?? layout;

  // Each Widget's height as its content needs it: its bar and frame, and its content's own height,
  // which doesn't stretch to fill it, except in one the musician sized. Measured again whenever the content changes size.
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next: Partial<Record<WidgetId, number>> = {};
      for (const [id, host] of hosts) {
        const body = host.parentElement;
        const frame = body?.closest<HTMLElement>(".widget");
        const zone = frame?.closest<HTMLElement>(".widget-zone")?.dataset.zone as Zone | undefined;
        if (!body || !frame || !zone || host.offsetHeight === 0) continue;
        next[id] = rowsFor(frame.offsetHeight - body.clientHeight + host.offsetHeight, zone);
      }
      // The Widgets measured are this Grid's own, so the measurements are compared on theirs.
      setNeeded((before) => (sameRows(before, next) ? before : next));
    };
    observer.current = new ResizeObserver(measure);
    return () => observer.current?.disconnect();
  }, [hosts]);
  // A Widget drawn for the first time is watched from then on; watching one twice changes nothing.
  useEffect(() => {
    for (const host of hosts.values()) observer.current?.observe(host);
  });

  // A Widget moved by the keyboard or pinned moves in the DOM too, which drops focus: the control used takes it back.
  useLayoutEffect(() => {
    if (refocus.current) controls.current.get(refocus.current)?.focus();
    refocus.current = null;
  });

  const cancel = () => {
    gesture.current = null;
    setDrag(null);
  };


  const begin = (event: PointerEvent<HTMLElement>, id: WidgetId, kind: Gesture["kind"]) => {
    if (event.button !== 0) return;
    // The bar's own buttons are clicked, not dragged; the grip is the exception.
    const button = (event.target as HTMLElement).closest("button");
    if (kind === "move" && button && !button.classList.contains("widget-grip")) return;
    const grid = event.currentTarget.closest<HTMLElement>(".widget-grid");
    if (!grid) return;
    const cell = (grid.clientWidth - GRID.gap * (GRID.columns - 1)) / GRID.columns;
    const scroller = scrollParent(grid);
    gesture.current = {
      id,
      kind,
      pointerId: event.pointerId,
      from: { x: event.clientX, y: event.clientY },
      pitch: { x: cell + GRID.gap, y: GRID.rowHeight + GRID.gap },
      last: { x: event.clientX, y: event.clientY },
      scroller,
      scrollStart: scroller?.scrollTop ?? 0,
      started: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  /** Where the Widget being dragged would land, with the pointer where it is and the page scrolled as it is. */
  const follow = () => {
    const current = gesture.current;
    if (!current?.started) return;
    const scrolled = current.scroller ? current.scroller.scrollTop - current.scrollStart : 0;
    const offset = { x: current.last.x - current.from.x, y: current.last.y - current.from.y + scrolled };
    const start = layout[current.id];
    const cols = Math.round(offset.x / current.pitch.x);
    // A Widget pinned to the bottom is resized by its top edge, so dragging up makes it taller.
    const rows = Math.round(offset.y / current.pitch.y) * (current.kind === "resize" && start.zone === "bottom" ? -1 : 1);
    const moved =
      current.kind === "move"
        ? moveWidget(layout, current.id, start.x + cols, start.y + rows)
        : resizeWidget(layout, current.id, start.w + cols, start.h + rows);
    // Shown as it will be drawn once saved, so what the placeholder shows is where it lands.
    const saved = toKept(moved, current.kind === "resize" ? current.id : null);
    const preview = fitToContent(withoutWidgets(saved, absent), needed);
    setDrag({ id: current.id, kind: current.kind, offset, preview, saved });
  };

  const track = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.last = { x: event.clientX, y: event.clientY };
    const moved = { x: event.clientX - current.from.x, y: event.clientY - current.from.y };
    if (!current.started && Math.hypot(moved.x, moved.y) < DRAG_THRESHOLD) return;
    current.started = true;
    event.preventDefault();
    follow();
  };

  // Also when the pointer's capture is lost, which a Widget moved in the page can cause: the drag
  // ends where it was, rather than being left hanging with nothing to end it.
  const end = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (drag) {
      save(drag.saved);
      setAnnouncement(describe(widgetSpec(drag.id).title, drag.preview[drag.id]));
    }
    cancel();
  };

  const change = (id: WidgetId, next: WidgetLayout, resized = false) => {
    onLayout(next, resized ? id : null);
    setAnnouncement(describe(widgetSpec(id).title, next[id]));
  };

  const onGripKey = (event: KeyboardEvent, id: WidgetId) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!step) return;
    event.preventDefault();
    const [dx, dy] = step as [number, number];
    const at = layout[id];
    refocus.current = `${id}:grip`;
    // As with its edge, Shift and Up make a Widget pinned to the bottom taller.
    const grow = event.shiftKey && at.zone === "bottom" ? -dy : dy;
    change(
      id,
      event.shiftKey ? resizeWidget(layout, id, at.w + dx, at.h + grow) : moveWidget(layout, id, at.x + dx, at.y + dy),
      event.shiftKey,
    );
  };

  const pin = (id: WidgetId, zone: Zone) => {
    const title = widgetSpec(id).title;
    refocus.current = `${id}:${zone === "main" ? layout[id].zone : zone}`;
    onLayout(pinWidget(layout, id, zone));
    setAnnouncement(
      zone === "main" ? `${title} unpinned.` : `${title} pinned to the ${zone === "top" ? "top" : "bottom"}.`,
    );
  };

  const hide = (id: WidgetId) => {
    onLayout(setWidgetHidden(layout, id, true));
    setAnnouncement(`${widgetSpec(id).title} hidden. Show it again from the Grid menu.`);
  };

  // The frames get handlers that never change and call the latest ones, so a frame re-renders
  // only when its own place does, not on every meter or playhead update of the page.
  const latest = useRef({ begin, track, follow, end, cancel, onGripKey, pin, hide });
  useLayoutEffect(() => {
    latest.current = { begin, track, follow, end, cancel, onGripKey, pin, hide };
  });

  const isDragging = drag !== null;
  useEffect(() => {
    if (!isDragging) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      gesture.current = null;
      setDrag(null);
    };
    window.addEventListener("keydown", onKey);
    // Scrolled mid-drag, by the wheel or by holding the pointer near an edge, the Widget stays under the pointer.
    const scroller = gesture.current?.scroller;
    const onScroll = () => latest.current.follow();
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    let frame = 0;
    const edgeScroll = () => {
      const current = gesture.current;
      if (current?.scroller) {
        const box = current.scroller.getBoundingClientRect();
        const by =
          current.last.y < box.top + EDGE
            ? current.last.y - (box.top + EDGE)
            : current.last.y > box.bottom - EDGE
              ? current.last.y - (box.bottom - EDGE)
              : 0;
        if (by !== 0) current.scroller.scrollTop += Math.round(by / 3);
      }
      frame = requestAnimationFrame(edgeScroll);
    };
    if (typeof requestAnimationFrame !== "undefined") frame = requestAnimationFrame(edgeScroll);
    return () => {
      window.removeEventListener("keydown", onKey);
      scroller?.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
    // The refs are the same objects for the Grid's life; listed, the effect still runs only when a drag starts or ends.
  }, [isDragging, gesture, latest]);
  const [actions] = useState<FrameActions>(() => ({
    begin: (event, id, kind) => latest.current.begin(event, id, kind),
    track: (event) => latest.current.track(event),
    end: (event) => latest.current.end(event),
    cancel: () => latest.current.cancel(),
    gripKey: (event, id) => latest.current.onGripKey(event, id),
    pin: (id, zone) => latest.current.pin(id, zone),
    hide: (id) => latest.current.hide(id),
    control: (key) =>
      stable(`control:${key}`, () => (element) => {
        if (element) controls.current.set(key, element as HTMLButtonElement);
        else controls.current.delete(key);
      }),
    body: (id) =>
      stable(`body:${id}`, () => (element) => {
        const host = hostFor(id);
        if (element && host.parentNode !== element) element.appendChild(host);
      }),
  }));

  const renderWidget = (id: WidgetId) => {
    const dragging = drag?.id === id;
    // A Widget being dragged follows the pointer from where it was; the placeholder shows where it will land.
    const moving = dragging && drag.kind === "move";
    const at = moving ? layout[id] : shown[id];
    return (
      <WidgetFrame
        key={id}
        id={id}
        x={at.x}
        y={at.y}
        w={at.w}
        h={at.h}
        zone={layout[id].zone}
        sized={at.sized === true || at.tucked === true}
        stretched={widgetSpec(id).extra !== undefined}
        dragging={dragging}
        offsetX={moving ? drag.offset.x : 0}
        offsetY={moving ? drag.offset.y : 0}
        hintId={hintId}
        actions={actions}
      />
    );
  };

  return (
    <>
      <p id={hintId} className="visually-hidden">
        Arrow keys move it; Shift and the arrow keys resize it.
      </p>
      {ZONES.map((zone) => {
        // In the order they were before a drag began, while it lasts: moving a Widget in the page
        // would lose the pointer's capture, and with it the end of the drag.
        const ids = widgetsIn(drag ? layout : shown, zone).filter(present);
        if (ids.length === 0 && zone !== "main") return null;
        const placeholder = drag?.kind === "move" && shown[drag.id].zone === zone ? shown[drag.id] : null;
        // Pinned bands touch, so a pinned Zone's rows take in the gap and keep the same pitch.
        const rows =
          zone === "main"
            ? { gridAutoRows: `${GRID.rowHeight}px`, gap: `${GRID.gap}px` }
            : { gridAutoRows: `${GRID.rowHeight + GRID.gap}px`, gap: 0 };
        const element = (
          <div
            key={zone}
            className="widget-zone"
            data-zone={zone}
            role={zone === "main" ? undefined : "group"}
            aria-label={zone === "top" ? "Pinned to the top" : zone === "bottom" ? "Pinned to the bottom" : undefined}
          >
            <div
              className="widget-grid"
              style={{
                gridTemplateColumns: `repeat(${GRID.columns}, minmax(0, 1fr))`,
                ...rows,
              }}
            >
              {placeholder && (
                <div
                  className="widget-placeholder"
                  aria-hidden
                  style={{
                    gridColumn: `${placeholder.x + 1} / span ${placeholder.w}`,
                    gridRow: `${placeholder.y + 1} / span ${placeholder.h}`,
                  }}
                />
              )}
              {ids.map(renderWidget)}
            </div>
          </div>
        );
        const slot = zone === "main" ? null : pinned?.[zone];
        return slot ? createPortal(element, slot, zone) : element;
      })}
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {specs.filter((spec) => present(spec.id)).map((spec) => createPortal(widgets[spec.id], hostFor(spec.id), spec.id))}
    </>
  );
}

interface FrameActions {
  begin: (event: PointerEvent<HTMLElement>, id: WidgetId, kind: Gesture["kind"]) => void;
  track: (event: PointerEvent<HTMLElement>) => void;
  end: (event: PointerEvent<HTMLElement>) => void;
  cancel: () => void;
  gripKey: (event: KeyboardEvent, id: WidgetId) => void;
  pin: (id: WidgetId, zone: Zone) => void;
  hide: (id: WidgetId) => void;
  control: (key: string) => (element: HTMLElement | null) => void;
  body: (id: WidgetId) => (element: HTMLElement | null) => void;
}

interface WidgetFrameProps extends Cell {
  id: WidgetId;
  zone: Zone;
  /** Made this tall by the musician, or tucked, so its content fills it rather than it being fitted to its content. */
  sized: boolean;
  /** Drawn taller than its content (`extra`): its frame fills its rows, its content keeps its own height. */
  stretched: boolean;
  dragging: boolean;
  offsetX: number;
  offsetY: number;
  hintId: string;
  actions: FrameActions;
}

/** One Widget's frame: its bar of controls, the slot its content is moved into, and its resize corner. */
const WidgetFrame = memo(function WidgetFrame({
  id,
  x,
  y,
  w,
  h,
  zone,
  sized,
  stretched,
  dragging,
  offsetX,
  offsetY,
  hintId,
  actions,
}: WidgetFrameProps) {
  const { title } = widgetSpec(id);
  const style: CSSProperties = {
    gridColumn: `${x + 1} / span ${w}`,
    gridRow: `${y + 1} / span ${h}`,
    transform: offsetX || offsetY ? `translate(${offsetX}px, ${offsetY}px)` : undefined,
  };
  return (
    <div
      className="widget"
      data-widget={id}
      data-sized={sized || undefined}
      data-stretched={stretched || undefined}
      data-dragging={dragging || undefined}
      style={style}
    >
      <div
        className="widget-bar"
        onPointerDown={(event) => actions.begin(event, id, "move")}
        onPointerMove={actions.track}
        onPointerUp={actions.end}
        onLostPointerCapture={actions.end}
        onPointerCancel={actions.cancel}
      >
        <button
          ref={actions.control(`${id}:grip`)}
          type="button"
          className="btn-icon widget-grip"
          aria-label={`Move ${title}`}
          aria-describedby={hintId}
          title={`Move ${title}`}
          onKeyDown={(event) => actions.gripKey(event, id)}
        >
          <GripVertical size={16} aria-hidden />
        </button>
        <span className="visually-hidden">{title}</span>
        <button
          ref={actions.control(`${id}:top`)}
          type="button"
          className="btn-icon"
          aria-label={`Pin ${title} to top`}
          title={zone === "top" ? `Unpin ${title}` : `Pin ${title} to top`}
          aria-pressed={zone === "top"}
          onClick={() => actions.pin(id, zone === "top" ? "main" : "top")}
        >
          <ArrowUpToLine size={16} aria-hidden />
        </button>
        <button
          ref={actions.control(`${id}:bottom`)}
          type="button"
          className="btn-icon"
          aria-label={`Pin ${title} to bottom`}
          title={zone === "bottom" ? `Unpin ${title}` : `Pin ${title} to bottom`}
          aria-pressed={zone === "bottom"}
          onClick={() => actions.pin(id, zone === "bottom" ? "main" : "bottom")}
        >
          <ArrowDownToLine size={16} aria-hidden />
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label={`Hide ${title}`}
          title={`Hide ${title}`}
          onClick={() => actions.hide(id)}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="widget-body" ref={actions.body(id)} />
      <div
        className="widget-resize"
        data-edge={zone === "main" ? undefined : zone === "top" ? "bottom" : "top"}
        aria-hidden
        onPointerDown={(event) => actions.begin(event, id, "resize")}
        onPointerMove={actions.track}
        onPointerUp={actions.end}
        onLostPointerCapture={actions.end}
        onPointerCancel={actions.cancel}
      />
    </div>
  );
});

/** The nearest ancestor that scrolls, or null when it is the page itself. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

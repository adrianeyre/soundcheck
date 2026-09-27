/**
 * Where each Widget of the Editor sits on its Grid: a pure model, so moving,
 * resizing, pinning and hiding can be tested without a browser. ADR 0004
 * says how a new Widget joins it.
 *
 * The Grid is `GRID.columns` wide and as many rows tall as it needs. A
 * Widget covers whole cells, so everything snaps. It sits in one of three
 * Zones: `main` scrolls with the page, `top` is pinned under the title bar
 * and `bottom` above the footer. Widgets never overlap within a Zone: one
 * dropped onto others pushes them down. A Zone never has a row with nothing
 * in it: whatever is below an empty row moves up into it, so the page has no
 * bands of blank space. A gap beside a Widget is kept, so a Widget stays in
 * its column where the musician put it. Pinned Widgets are full-width bands,
 * stacked one above the other; only their height changes.
 */

export const GRID = { columns: 24, rowHeight: 24, gap: 16 } as const;

export type Zone = "top" | "main" | "bottom";

export const ZONES: readonly Zone[] = ["top", "main", "bottom"];

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WidgetPlacement extends Cell {
  zone: Zone;
  hidden: boolean;
  /**
   * Made this tall by the musician's own resize: kept at that height, with
   * space below its content, rather than fitted to its content. "Reset
   * layout" fits it again.
   */
  sized?: boolean;
}

/** Every Widget there is. A new one is added here and in `WIDGETS` below (ADR 0004). */
export type WidgetId =
  | "transport"
  | "assistant"
  | "tracks"
  | "timeline"
  | "audioEditor"
  | "stepSequencer"
  | "pianoRoll"
  | "instrument"
  | "recordAudio"
  | "samples"
  | "mixer";

export interface WidgetSpec {
  id: WidgetId;
  /** What the Grid menu, and the Widget's own controls, call it. */
  title: string;
  /** Where it starts, and where "Reset layout" puts it back. */
  initial: Cell;
  /** The smallest it can be made, in cells. */
  min: { w: number; h: number };
  /**
   * For a Widget whose content grows as it is used, such as the Assistant's
   * transcript: the most rows it grows to by itself, past the height it was
   * made, pushing down what is below it. Made taller than this, it grows to
   * that height instead. Past it, its content scrolls.
   */
  grows?: number;
}

const MIN = { w: 4, h: 3 };

/** In Grid menu order, which is also their order for keyboards, screen readers and narrow windows. */
export const WIDGETS: readonly WidgetSpec[] = [
  { id: "transport", title: "Transport", initial: { x: 0, y: 0, w: 24, h: 7 }, min: MIN },
  // 20 rows is about 800 pixels: a long Conversation's latest Requests, and the prompt, stay on a laptop's screen.
  { id: "assistant", title: "Assistant", initial: { x: 0, y: 7, w: 24, h: 5 }, min: MIN, grows: 20 },
  { id: "tracks", title: "Tracks", initial: { x: 0, y: 12, w: 7, h: 12 }, min: MIN },
  { id: "timeline", title: "Timeline", initial: { x: 7, y: 12, w: 17, h: 12 }, min: MIN },
  // Under the Timeline, where the Clip clicked on it opens; wide and tall enough to cut a waveform by eye.
  { id: "audioEditor", title: "Audio Editor", initial: { x: 0, y: 24, w: 24, h: 20 }, min: { w: 8, h: 8 } },
  { id: "stepSequencer", title: "Step Sequencer", initial: { x: 0, y: 44, w: 24, h: 10 }, min: MIN },
  { id: "pianoRoll", title: "Piano Roll", initial: { x: 0, y: 54, w: 24, h: 12 }, min: MIN },
  { id: "instrument", title: "Instrument", initial: { x: 0, y: 66, w: 24, h: 12 }, min: MIN },
  { id: "recordAudio", title: "Record audio", initial: { x: 0, y: 78, w: 12, h: 6 }, min: MIN },
  { id: "samples", title: "Samples", initial: { x: 12, y: 78, w: 12, h: 6 }, min: MIN },
  { id: "mixer", title: "Mixer", initial: { x: 0, y: 84, w: 24, h: 14 }, min: MIN },
];

export type WidgetLayout = Record<WidgetId, WidgetPlacement>;

const SPECS = new Map(WIDGETS.map((spec) => [spec.id, spec]));

export function widgetSpec(id: WidgetId): WidgetSpec {
  return SPECS.get(id)!;
}

export function defaultLayout(): WidgetLayout {
  return Object.fromEntries(
    WIDGETS.map((spec) => [spec.id, { ...spec.initial, zone: "main", hidden: false }]),
  ) as WidgetLayout;
}

const overlaps = (a: Cell, b: Cell) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The Widgets shown in `zone`, top to bottom, then left to right. */
export function widgetsIn(layout: WidgetLayout, zone: Zone): WidgetId[] {
  return WIDGETS.map((spec) => spec.id)
    .filter((id) => layout[id].zone === zone && !layout[id].hidden)
    .toSorted((a, b) => layout[a].y - layout[b].y || layout[a].x - layout[b].x);
}

/** How many rows `zone` needs to show all its Widgets. */
export function zoneRows(layout: WidgetLayout, zone: Zone): number {
  return Math.max(0, ...widgetsIn(layout, zone).map((id) => layout[id].y + layout[id].h));
}

const pinned = (zone: Zone) => zone !== "main";

/** `cell` made whole, at least the Widget's minimum and inside the Grid's width; pinned, the Grid's whole width. */
function fit(id: WidgetId, cell: Cell, zone: Zone): Cell {
  const { min } = widgetSpec(id);
  const w = pinned(zone) ? GRID.columns : Math.min(GRID.columns, Math.max(min.w, Math.round(cell.w)));
  return {
    w,
    h: Math.max(min.h, Math.round(cell.h)),
    x: Math.min(GRID.columns - w, Math.max(0, Math.round(cell.x))),
    y: Math.max(0, Math.round(cell.y)),
  };
}

/** Push whatever `id` now covers down below it, and whatever that covers below that, and so on. */
function settle(layout: WidgetLayout, id: WidgetId): WidgetLayout {
  const next = { ...layout };
  const queue: WidgetId[] = [id];
  while (queue.length > 0) {
    const mover = next[queue.shift()!];
    for (const other of widgetsIn(next, mover.zone)) {
      if (other === id || next[other] === mover || !overlaps(mover, next[other])) continue;
      next[other] = { ...next[other], y: mover.y + mover.h };
      queue.push(other);
    }
  }
  return next;
}

/**
 * Take out every row of `zone` that no shown Widget covers, moving what is
 * below it up. A hidden Widget moves with the rows above it, so it comes
 * back beside the same neighbours.
 */
function closeRowGaps(layout: WidgetLayout, zone: Zone): WidgetLayout {
  const shown = widgetsIn(layout, zone);
  const covered = new Set(shown.flatMap((id) => Array.from({ length: layout[id].h }, (_, row) => layout[id].y + row)));
  const emptyAbove = (y: number) => {
    let empty = 0;
    for (let row = 0; row < y; row++) if (!covered.has(row)) empty++;
    return empty;
  };
  const next = { ...layout };
  for (const spec of WIDGETS) {
    const at = next[spec.id];
    const up = at.zone === zone ? emptyAbove(at.y) : 0;
    if (up > 0) next[spec.id] = { ...at, y: at.y - up };
  }
  return next;
}

const closeAllRowGaps = (layout: WidgetLayout) => ZONES.reduce(closeRowGaps, layout);

/**
 * The layout as a page that doesn't draw `absent` shows it: without them,
 * and without the rows they leave empty. A Widget that was away, such as
 * one with nothing to show, comes back where the layout last kept it,
 * which the others may have moved into since: going down each Zone, each
 * Widget pushes down whatever it overlaps, as one shown again does.
 */
export function withoutWidgets(layout: WidgetLayout, absent: readonly WidgetId[]): WidgetLayout {
  const next = { ...layout };
  for (const id of absent) next[id] = { ...next[id], hidden: true };
  const shown = ZONES.flatMap((zone) => widgetsIn(next, zone));
  const clashes = shown.some((id, index) => shown.slice(index + 1).some((other) => next[id].zone === next[other].zone && overlaps(next[id], next[other])));
  if (absent.length === 0 && !clashes) return layout;
  return closeAllRowGaps(clashes ? shown.reduce(settle, next) : next);
}

/**
 * How many rows a Widget in `zone` needs to show `px` of itself, bar and
 * frame included: in the page a Widget spans the gaps between its rows,
 * and a pinned band's rows take in the gap.
 */
export function rowsFor(px: number, zone: Zone): number {
  const pitch = GRID.rowHeight + GRID.gap;
  return Math.ceil(((pinned(zone) ? px : px + GRID.gap) - 0.5) / pitch);
}

/**
 * The layout as the Grid draws it: each shown Widget no taller than its
 * content needs, `needed` rows, and no shorter than its minimum, so none has
 * blank space at its bottom, unless the musician made it that tall
 * (`sized`), when the space is theirs and it keeps it. Its own height is the
 * most it takes, or, for one that `grows`, that or its `grows`, whichever is
 * more: content taller than that scrolls inside it. One that grew pushes
 * down what is below it; the rows a smaller one frees are closed up, so
 * what is below moves up rather than leaving a band of blank space.
 */
export function fitToContent(layout: WidgetLayout, needed: Partial<Record<WidgetId, number>>): WidgetLayout {
  let next = { ...layout };
  let changed = false;
  const grown: WidgetId[] = [];
  for (const spec of WIDGETS) {
    const rows = needed[spec.id];
    const at = next[spec.id];
    if (rows === undefined || at.hidden) continue;
    const most = Math.max(at.h, spec.grows ?? 0);
    const fitted = Math.max(spec.min.h, Math.min(most, rows));
    const h = at.sized ? Math.max(at.h, fitted) : fitted;
    if (h === at.h) continue;
    next[spec.id] = { ...at, h };
    if (h > at.h) grown.push(spec.id);
    changed = true;
  }
  if (!changed) return layout;
  next = grown.reduce(settle, next);
  return closeAllRowGaps(next);
}

/**
 * A layout changed as it is drawn (`fitToContent`) back as it is kept: where
 * each Widget now is, with the height each had in `kept`, the most it
 * takes, except `resized`'s, which is the one given it. Taller again, each
 * pushes down what it now overlaps, which drawing it fitted closes up again.
 * One that grew with its content is kept at its own height, not the one it
 * grew to, so it shrinks again when its content does.
 */
export function unfitted(next: WidgetLayout, kept: WidgetLayout, resized: WidgetId | null): WidgetLayout {
  const layout = { ...next };
  for (const spec of WIDGETS) {
    if (spec.id === resized) continue;
    const h = spec.grows === undefined ? Math.max(next[spec.id].h, kept[spec.id].h) : kept[spec.id].h;
    layout[spec.id] = { ...next[spec.id], h };
  }
  const order = ZONES.flatMap((zone) => widgetsIn(layout, zone));
  return closeAllRowGaps(order.reduce(settle, layout));
}

function place(layout: WidgetLayout, id: WidgetId, changes: Partial<WidgetPlacement>): WidgetLayout {
  const placed = { ...layout[id], ...changes };
  return closeAllRowGaps(settle({ ...layout, [id]: { ...placed, ...fit(id, placed, placed.zone) } }, id));
}

/**
 * Moved down onto the Widgets below it, a Widget swaps with them: they rise
 * into the rows it left and it goes under them. Without that, closing the
 * rows it left would put it straight back, and the arrow keys could never
 * move a Widget past the one under it. If they can't rise, it pushes them
 * down instead.
 */
export function moveWidget(layout: WidgetLayout, id: WidgetId, x: number, y: number): WidgetLayout {
  const from = layout[id];
  const to = { ...from, ...fit(id, { ...from, x, y }, from.zone) };
  if (to.y <= from.y) return place(layout, id, to);
  const below = widgetsIn(layout, from.zone).filter(
    (other) => other !== id && layout[other].y >= from.y + from.h && overlaps(to, layout[other]),
  );
  if (below.length === 0) return place(layout, id, to);
  const rise = Math.min(...below.map((other) => layout[other].y)) - from.y;
  const risen = { ...layout };
  for (const other of below) risen[other] = { ...layout[other], y: layout[other].y - rise };
  const blocked = widgetsIn(layout, from.zone).some(
    (other) => other !== id && !below.includes(other) && below.some((b) => overlaps(risen[b], layout[other])),
  );
  if (blocked) return place(layout, id, to);
  const under = Math.max(to.y, ...below.filter((b) => overlaps({ ...to, y: 0, h: Infinity }, risen[b])).map((b) => risen[b].y + risen[b].h));
  return place(risen, id, { ...to, y: under });
}

/** Made taller or shorter, a Widget keeps the height given it, blank space and all (`sized`). */
export function resizeWidget(layout: WidgetLayout, id: WidgetId, w: number, h: number): WidgetLayout {
  const at = layout[id];
  const sized = at.sized === true || fit(id, { ...at, w, h }, at.zone).h !== at.h;
  return place(layout, id, sized ? { w, h, sized } : { w, h });
}

/** Hidden, a Widget's rows close up; shown again, it goes back where it was and pushes down whatever is there now. */
export function setWidgetHidden(layout: WidgetLayout, id: WidgetId, hidden: boolean): WidgetLayout {
  return hidden ? closeAllRowGaps({ ...layout, [id]: { ...layout[id], hidden } }) : place(layout, id, { hidden });
}

/**
 * Move a Widget to another Zone. Pinned, it spans the Grid's width and goes
 * under whatever is pinned there already; unpinned from the top it goes to
 * the top of the page, and from the bottom to the bottom, which is where it
 * was on screen. Unpinned, it stays full width until it is resized.
 */
export function pinWidget(layout: WidgetLayout, id: WidgetId, zone: Zone): WidgetLayout {
  const from = layout[id].zone;
  if (from === zone) return layout;
  const without = { ...layout, [id]: { ...layout[id], hidden: true } };
  const y = zone === "main" && from === "top" ? 0 : zoneRows(without, zone);
  return place(layout, id, { zone, y, hidden: false });
}

/** Where the Grid is kept between runs. */
export const GRID_KEY = "soundcheck.grid";

export function serialiseLayout(layout: WidgetLayout): string {
  return JSON.stringify({ version: 1, widgets: layout });
}

/**
 * A saved layout, as far as it can be trusted. A Widget missing from it
 * (one added since it was saved) or saved wrongly gets its starting place.
 */
export function parseLayout(saved: string | null): WidgetLayout {
  const layout = defaultLayout();
  if (!saved) return layout;
  let widgets: unknown;
  try {
    widgets = (JSON.parse(saved) as { widgets?: unknown }).widgets;
  } catch {
    return layout;
  }
  if (typeof widgets !== "object" || widgets === null) return layout;
  for (const spec of WIDGETS) {
    const entry = (widgets as Record<string, unknown>)[spec.id] as Partial<WidgetPlacement> | undefined;
    if (!entry || !ZONES.includes(entry.zone as Zone)) continue;
    const cell = [entry.x, entry.y, entry.w, entry.h];
    if (!cell.every((value) => typeof value === "number" && Number.isFinite(value))) continue;
    layout[spec.id] = {
      ...fit(spec.id, entry as Cell, entry.zone!),
      zone: entry.zone!,
      hidden: entry.hidden === true,
      ...(entry.sized === true && { sized: true }),
    };
  }
  // Saved by hand or by an older version, it may overlap or leave empty rows: settle each in order, then close them.
  return closeAllRowGaps(
    WIDGETS.reduce((settled, spec) => (settled[spec.id].hidden ? settled : settle(settled, spec.id)), layout),
  );
}

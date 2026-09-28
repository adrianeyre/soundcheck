import { expect, test } from "vitest";

import {
  defaultLayout,
  fitToContent,
  GRID,
  GRID_KEY,
  gridKey,
  MIXING_WIDGETS,
  moveWidget,
  parseLayout,
  pinWidget,
  resizeWidget,
  rowsFor,
  serialiseLayout,
  setWidgetHidden,
  specsOf,
  unfitted,
  WIDGETS,
  widgetSpec,
  widgetsIn,
  withoutWidgets,
  ZONES,
  type WidgetLayout,
} from "./layout";

/** No two Widgets shown in one Zone share a cell. */
function expectNoOverlaps(layout: WidgetLayout) {
  for (const zone of ZONES) {
    const ids = widgetsIn(layout, zone);
    for (const a of ids)
      for (const b of ids) {
        if (a === b) continue;
        const [p, q] = [layout[a], layout[b]];
        const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
        expect(overlap, `${a} overlaps ${b}`).toBe(false);
      }
  }
}

/** Every row of every Zone, down to its last Widget, has a Widget in it. */
function expectNoEmptyRows(layout: WidgetLayout) {
  for (const zone of ZONES) {
    const ids = widgetsIn(layout, zone);
    const rows = Math.max(0, ...ids.map((id) => layout[id].y + layout[id].h));
    for (let row = 0; row < rows; row++)
      expect(ids.some((id) => layout[id].y <= row && row < layout[id].y + layout[id].h), `${zone} row ${row} is empty`).toBe(true);
  }
}

test("every Widget starts shown, in the page, inside the Grid and clear of the others", () => {
  const layout = defaultLayout();
  expect(widgetsIn(layout, "main")).toHaveLength(WIDGETS.length);
  for (const spec of WIDGETS) expect(layout[spec.id].x + layout[spec.id].w).toBeLessThanOrEqual(GRID.columns);
  expectNoOverlaps(layout);
  expectNoEmptyRows(layout);
});

test("the Mixer page's Widgets start clear of each other, in a layout of their own", () => {
  const layout = defaultLayout("mixing");
  expect(specsOf(layout).map((spec) => spec.id)).toEqual(MIXING_WIDGETS.map((spec) => spec.id));
  expect(Object.keys(layout)).not.toContain("transport");
  for (const spec of MIXING_WIDGETS) expect(layout[spec.id].x + layout[spec.id].w).toBeLessThanOrEqual(GRID.columns);
  expectNoOverlaps(layout);
  expectNoEmptyRows(layout);
  // Each page is kept under a key of its own; the Editor's keeps the one it always had.
  expect(gridKey("editor")).toBe(GRID_KEY);
  expect(gridKey("mixing")).not.toBe(GRID_KEY);
  // Moving one page's Widget never touches the other page's layout.
  const moved = moveWidget(layout, "djMixer", 0, 0);
  expect(Object.keys(moved).toSorted()).toEqual(Object.keys(layout).toSorted());
  expectNoOverlaps(moved);
  // A saved Mixing layout comes back, and one saved wrongly falls back to the starting places.
  expect(parseLayout(serialiseLayout(moved), "mixing")).toEqual(moved);
  expect(parseLayout("not json", "mixing")).toEqual(layout);
});

test("a Widget dropped onto others pushes them down, and the rest stay put", () => {
  const before = defaultLayout();
  const after = moveWidget(before, "mixer", 0, 0);
  expect(after.mixer).toMatchObject({ x: 0, y: 0 });
  expect(after.transport.y).toBe(after.mixer.h);
  expectNoOverlaps(after);
  expectNoEmptyRows(after);
  // Nothing floats up into the gap the Mixer left.
  expect(after.samples.y).toBeGreaterThanOrEqual(before.samples.y);
});

test("the rows a change frees close up by themselves, though a gap beside a Widget stays", () => {
  const layout = defaultLayout();
  // Moved down past the end, the last Widget stays where it was dropped: the blank space is the musician's.
  expect(moveWidget(layout, "eq", 0, 200).eq.y).toBe(200);
  // Shorter, the Transport's rows close up under it.
  const short = resizeWidget(layout, "transport", 24, 4);
  expect(short.assistant.y).toBe(4);
  expectNoEmptyRows(short);
  // Hidden, the Assistant's rows close up; shown again, it comes back between the same neighbours.
  const hidden = setWidgetHidden(layout, "assistant", true);
  expect(hidden.tracks.y).toBe(layout.transport.h);
  expectNoEmptyRows(hidden);
  const shown = setWidgetHidden(hidden, "assistant", false);
  expect(shown).toEqual(layout);
  // Shorter beside the Timeline, the Tracks leave the cells under them empty: the row isn't.
  const beside = resizeWidget(layout, "tracks", 7, 4);
  expect(beside.stepSequencer.y).toBe(layout.stepSequencer.y);
  // Pinned away, a Widget's rows close up behind it.
  expectNoEmptyRows(pinWidget(layout, "stepSequencer", "top"));
});

test("moved down onto the Widgets under it, a Widget swaps with them", () => {
  const layout = defaultLayout();
  const once = moveWidget(layout, "transport", 0, 1);
  expect(once.assistant.y).toBe(0);
  expect(once.transport.y).toBe(layout.assistant.h);
  expect(once.tracks.y).toBe(layout.tracks.y);
  // Two side by side rise together.
  const past = moveWidget(layout, "assistant", 0, layout.assistant.y + 1);
  expect(past).toMatchObject({ tracks: { y: 7 }, timeline: { y: 7 }, assistant: { y: 19 } });
  // Where they can't rise, because the Timeline is beside it, they are pushed down.
  const pushed = moveWidget(layout, "tracks", 0, layout.tracks.y + 1);
  expect(pushed.tracks.y).toBe(layout.tracks.y + 1);
  expect(pushed.audioEditor.y).toBe(pushed.tracks.y + pushed.tracks.h);
  for (const next of [once, past, pushed]) {
    expectNoOverlaps(next);
    expectNoEmptyRows(next);
  }
});

test("a pinned Widget spans the Grid, and only its height changes", () => {
  let layout = pinWidget(defaultLayout(), "tracks", "top");
  expect(layout.tracks).toMatchObject({ zone: "top", x: 0, w: GRID.columns, y: 0 });
  layout = resizeWidget(layout, "tracks", 5, 20);
  expect(layout.tracks).toMatchObject({ x: 0, w: GRID.columns, h: 20 });
  expect(moveWidget(layout, "tracks", 6, 0).tracks.x).toBe(0);
});

test("moves and resizes snap to whole cells and stay inside the Grid", () => {
  const layout = defaultLayout();
  expect(moveWidget(layout, "tracks", 30.4, -3).tracks).toMatchObject({ x: GRID.columns - 7, y: 0 });
  expect(resizeWidget(layout, "tracks", 2.6, 1).tracks).toMatchObject({ w: 4, h: 3 });
  const wide = resizeWidget(layout, "tracks", 40, 20);
  expect(wide.tracks).toMatchObject({ w: GRID.columns, h: 20 });
  expect(wide.tracks.x).toBe(0);
  expectNoOverlaps(wide);
});

test("a hidden Widget is out of the way, and comes back where it was", () => {
  const hidden = setWidgetHidden(defaultLayout(), "tracks", true);
  expect(widgetsIn(hidden, "main")).not.toContain("tracks");
  const covered = resizeWidget(hidden, "timeline", 24, 14);
  expect(covered.timeline.x).toBe(0);

  const shown = setWidgetHidden(covered, "tracks", false);
  expect(shown.tracks).toMatchObject(defaultLayout().tracks);
  expectNoOverlaps(shown);
});

test("pinned Widgets stack in their Zone, and unpinned go back to where they were on screen", () => {
  let layout = pinWidget(defaultLayout(), "transport", "top");
  layout = pinWidget(layout, "timeline", "top");
  expect(widgetsIn(layout, "top")).toEqual(["transport", "timeline"]);
  expect(layout.timeline.y).toBe(layout.transport.h);

  layout = pinWidget(layout, "mixer", "bottom");
  expect(layout.mixer).toMatchObject({ zone: "bottom", y: 0 });

  layout = pinWidget(layout, "timeline", "main");
  expect(layout.timeline).toMatchObject({ zone: "main", y: 0 });
  layout = pinWidget(layout, "mixer", "main");
  expect(layout.mixer.y).toBeGreaterThan(Math.max(...widgetsIn(layout, "main").filter((id) => id !== "mixer").map((id) => layout[id].y)));
  expectNoOverlaps(layout);
});

test("a saved layout comes back as it was, and anything wrong in it falls back", () => {
  const layout = pinWidget(setWidgetHidden(moveWidget(defaultLayout(), "samples", 3, 90), "tracks", true), "mixer", "top");
  expect(parseLayout(serialiseLayout(layout))).toEqual(layout);

  expect(parseLayout(null)).toEqual(defaultLayout());
  expect(parseLayout("not json")).toEqual(defaultLayout());
  const broken = parseLayout(JSON.stringify({ version: 1, widgets: { mixer: { x: "a", zone: "top" }, tracks: { x: 0, y: 0, w: 24, h: 4, zone: "main" } } }));
  const { y: _, ...mixer } = defaultLayout().mixer;
  expect(broken.mixer).toMatchObject(mixer);
  // Saved on top of the Transport, the Tracks are settled clear of it, and the rows left empty close.
  expectNoOverlaps(broken);
  expectNoEmptyRows(broken);
  // Blank rows the musician left above a Widget are theirs, and are kept.
  expect(parseLayout(JSON.stringify({ version: 1, widgets: { mixer: { ...defaultLayout().mixer, y: 200 } } })).mixer.y).toBe(200);
});

test("Widgets that were away come back where they were kept, pushing down what moved into their rows", () => {
  const away = ["stepSequencer", "pianoRoll", "instrument"] as const;
  // While they are away the page shows the rest closed up, and the musician moves the Mixer there.
  const shown = withoutWidgets(defaultLayout(), away);
  expect(shown.recordAudio.y).toBe(defaultLayout().stepSequencer.y);
  const kept = moveWidget(shown, "mixer", 0, shown.recordAudio.y);
  const saved = { ...kept };
  for (const id of away) saved[id] = { ...kept[id], hidden: false };

  const back = withoutWidgets(saved, []);
  expectNoOverlaps(back);
  // Down the page they are in the order they were in, above what moved into their rows.
  expect(widgetsIn(back, "main").slice(5)).toEqual([
    "stepSequencer",
    "pianoRoll",
    "instrument",
    "mixer",
    "recordAudio",
    "samples",
    "keyboard",
    "chords",
    "noteTools",
    "meters",
    "overview",
    "eq",
  ]);
  // A layout with nothing away and nothing overlapping is left as it is.
  expect(withoutWidgets(back, [])).toBe(back);
});

test("a Widget needs the rows its height in pixels spans, gaps and all", () => {
  const pitch = GRID.rowHeight + GRID.gap;
  // In the page, h rows are h * rowHeight + (h - 1) * gap tall.
  expect(rowsFor(3 * GRID.rowHeight + 2 * GRID.gap, "main")).toBe(3);
  expect(rowsFor(3 * GRID.rowHeight + 2 * GRID.gap + 1, "main")).toBe(4);
  // A pinned band's rows take in the gap.
  expect(rowsFor(3 * pitch, "top")).toBe(3);
  expect(rowsFor(3 * pitch + 1, "top")).toBe(4);
});

test("drawn, a Widget is no taller than its content, nor than it was made, and what is below it moves up", () => {
  const layout = defaultLayout();
  // The Transport needs 4 of its 7 rows; the Mixer's content is taller than the 14 it was given.
  const drawn = fitToContent(layout, { transport: 4, mixer: 40 });
  expect(drawn.transport.h).toBe(4);
  expect(drawn.mixer.h).toBe(layout.mixer.h);
  expect(drawn.assistant.y).toBe(4);
  expectNoOverlaps(drawn);
  expectNoEmptyRows(drawn);
  // Never under its minimum.
  expect(fitToContent(layout, { transport: 1 }).transport.h).toBe(WIDGETS[0]!.min.h);
  // Nothing measured, nothing changes.
  expect(fitToContent(layout, {})).toBe(layout);
});

test("a Widget the musician makes taller keeps its height, blank space and all, until the layout is reset", () => {
  const layout = defaultLayout();
  // The Samples widget is made 16 rows tall, though its content needs 8.
  const sized = resizeWidget(layout, "samples", layout.samples.w, 16);
  expect(sized.samples).toMatchObject({ h: 16, sized: true });
  expect(fitToContent(sized, { samples: 8 }).samples.h).toBe(16);
  // Content taller than that still scrolls inside it, and one that grows still grows.
  expect(fitToContent(sized, { samples: 30 }).samples.h).toBe(16);
  const assistant = resizeWidget(layout, "assistant", 24, 6);
  expect(fitToContent(assistant, { assistant: 12 }).assistant.h).toBe(12);
  expect(fitToContent(assistant, { assistant: 2 }).assistant.h).toBe(6);
  // Made narrower only, it is still fitted to its content.
  expect(resizeWidget(layout, "samples", 8, layout.samples.h).samples.sized).toBeUndefined();
  // Remembered between runs.
  expect(parseLayout(serialiseLayout(sized)).samples.sized).toBe(true);
  expect(parseLayout(serialiseLayout(layout)).samples.sized).toBeUndefined();
  expectNoEmptyRows(fitToContent(sized, { samples: 8 }));
});

test("a change made as drawn is kept at the heights drawn, with the most each takes beside them, but the one resized", () => {
  const layout = defaultLayout();
  const drawn = fitToContent(layout, { transport: 4, tracks: 5, timeline: 6 });
  // The Assistant is moved above the Transport, as drawn.
  const kept = unfitted(moveWidget(drawn, "assistant", 0, 0), layout, null);
  expect(kept.assistant.y).toBe(0);
  expect(kept.transport).toMatchObject({ h: 4, room: layout.transport.h });
  expect(kept.tracks).toMatchObject({ h: 5, room: layout.tracks.h });
  // Drawn again with more to show, each grows back into its room, and no further.
  expect(fitToContent(kept, { transport: 100 }).transport.h).toBe(layout.transport.h);
  expectNoOverlaps(kept);
  expectNoEmptyRows(kept);
  // Resized, a Widget keeps the height it was given.
  expect(unfitted(resizeWidget(drawn, "tracks", 7, 4), layout, "tracks").tracks.h).toBe(4);
});

test("drawn, the Assistant grows with its content, up to its most, and pushes down what is below it", () => {
  const layout = defaultLayout();
  const { grows } = widgetSpec("assistant");
  // Its transcript needs 12 rows of the 5 it was made.
  const drawn = fitToContent(layout, { assistant: 12 });
  expect(drawn.assistant.h).toBe(12);
  expect(drawn.tracks.y).toBe(drawn.assistant.y + 12);
  expect(drawn.timeline.y).toBe(drawn.assistant.y + 12);
  expectNoOverlaps(drawn);
  expectNoEmptyRows(drawn);
  // Past its most, it scrolls.
  expect(fitToContent(layout, { assistant: 100 }).assistant.h).toBe(grows);
  // Made taller than that, it grows to the height it was made.
  const tall = resizeWidget(layout, "assistant", 24, grows! + 6);
  expect(fitToContent(tall, { assistant: 100 }).assistant.h).toBe(grows! + 6);
  // Other Widgets still never grow past the height they were made.
  expect(fitToContent(layout, { mixer: 40 }).mixer.h).toBe(layout.mixer.h);
});

test("a change made while the Assistant has grown keeps it at its own height, to shrink with its content", () => {
  const layout = defaultLayout();
  const drawn = fitToContent(layout, { assistant: 12 });
  const kept = unfitted(moveWidget(drawn, "transport", 0, drawn.transport.y), layout, null);
  expect(kept.assistant.h).toBe(layout.assistant.h);
  expectNoOverlaps(kept);
  expectNoEmptyRows(kept);
  // Resized, it keeps the height it was given, as any Widget does.
  expect(unfitted(resizeWidget(drawn, "assistant", 24, 8), layout, "assistant").assistant.h).toBe(8);
});

test("on the Mixer page, the Track browser fits under a Deck shorter than the mixer beside it, with blank space between if wanted", () => {
  const layout = defaultLayout("mixing");
  // The Decks' content is 30 rows, the mixer's 40: each is drawn no taller.
  const needed = { djWaveforms: 6, deck1: 30, djMixer: 40, deck2: 30, djBrowser: 14 };
  const drawn = fitToContent(withoutWidgets(layout, ["deck3", "deck4"]), needed);
  const under = drawn.deck1.y + drawn.deck1.h;
  expect(under).toBeLessThan(drawn.djMixer.y + drawn.djMixer.h);

  // Dropped right under Deck 1, as wide as it, beside the taller mixer.
  const moved = moveWidget(resizeWidget(drawn, "djBrowser", 8, 14), "djBrowser", 0, under);
  const kept = unfitted(moved, layout, null);
  expect(kept.djBrowser).toMatchObject({ x: 0, y: under });
  expectNoOverlaps(kept);
  // Drawn again, it is still there, and so are the Decks and the mixer.
  const again = fitToContent(withoutWidgets(kept, ["deck3", "deck4"]), needed);
  expect(again.djBrowser).toMatchObject({ x: 0, y: under });
  expect(again.djMixer.y).toBe(drawn.djMixer.y);

  // Dropped lower, with blank space between it and Deck 1, it stays there too.
  const lower = unfitted(moveWidget(again, "djBrowser", 0, under + 3), kept, null);
  expect(fitToContent(withoutWidgets(lower, ["deck3", "deck4"]), needed).djBrowser.y).toBe(under + 3);

  // If Deck 1's content grows back into its room, it pushes the browser down rather than overlapping it.
  const grown = fitToContent(withoutWidgets(lower, ["deck3", "deck4"]), { ...needed, deck1: 40 });
  expect(grown.deck1.h).toBe(40);
  expect(grown.djBrowser.y).toBe(grown.deck1.y + 40);
  expectNoOverlaps(grown);
});

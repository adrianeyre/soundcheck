// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { defaultLayout, GRID, pinWidget, setWidgetHidden, type WidgetLayout } from "./layout";
import { WidgetGrid, type WidgetGridProps } from "./WidgetGrid";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let latest: WidgetLayout = defaultLayout();

function Harness({
  initial = defaultLayout(),
  pinned,
  empty,
}: {
  initial?: WidgetLayout;
  pinned?: WidgetGridProps["pinned"];
  empty?: WidgetGridProps["empty"];
}) {
  const [layout, setLayout] = useState(initial);
  useEffect(() => {
    latest = layout;
  }, [layout]);
  return (
    <WidgetGrid
      layout={layout}
      onLayout={setLayout}
      pinned={pinned}
      empty={empty}
      widgets={{
        transport: <p>Transport content</p>,
        tracks: <Counter />,
        mixer: <p>Mixer content</p>,
      }}
    />
  );
}

/** Tracks content that remembers how often it was clicked, to show it is never remounted. */
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <p>
      Tracks content <button onClick={() => setCount(count + 1)}>Clicked {count}</button>
    </p>
  );
}

/** The Widgets in the order they are in the page. */
const order = () => [...document.querySelectorAll<HTMLElement>(".widget")].map((element) => element.dataset.widget);

const widget = (name: string) => screen.getByText(new RegExp(`${name} content`)).closest<HTMLElement>(".widget")!;

test("only the Widgets given are drawn, each placed on the Grid, and those left out leave no empty rows", () => {
  render(<Harness />);
  expect(document.querySelectorAll(".widget")).toHaveLength(3);
  expect(widget("Tracks").style.gridColumn).toBe("1 / span 7");
  // The Assistant's rows, above the Tracks, aren't on this page.
  expect(widget("Tracks").style.gridRow).toBe("8 / span 12");
  expect(widget("Mixer").style.gridRow).toBe("20 / span 14");
});

test("moving a Widget keeps the place of one the page leaves out", () => {
  const initial = setWidgetHidden(defaultLayout(), "assistant", true);
  render(<Harness initial={initial} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Move Tracks" }), { key: "ArrowRight" });
  expect(latest.assistant.hidden).toBe(true);
  expect(latest.timeline.hidden).toBe(false);
});

test("the cross hides a Widget", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Hide Tracks" }));
  expect(screen.queryByText(/Tracks content/)).not.toBeInTheDocument();
  expect(latest.tracks.hidden).toBe(true);
  expect(screen.getByText(/Tracks hidden/)).toBeInTheDocument();
});

test("the grip moves a Widget with the arrow keys and resizes it with Shift, keeping focus", () => {
  render(<Harness />);
  const grip = screen.getByRole("button", { name: "Move Tracks" });
  expect(grip).toHaveAccessibleDescription(/Arrow keys move it/);
  grip.focus();
  fireEvent.keyDown(grip, { key: "ArrowRight" });
  expect(latest.tracks).toMatchObject({ x: 1, y: 7 });
  // Down onto the Mixer, the Tracks swap with it.
  fireEvent.keyDown(grip, { key: "ArrowDown" });
  expect(latest.mixer.y).toBe(7);
  expect(latest.tracks).toMatchObject({ x: 1, y: 21 });
  fireEvent.keyDown(grip, { key: "ArrowRight", shiftKey: true });
  fireEvent.keyDown(grip, { key: "ArrowUp", shiftKey: true });
  expect(latest.tracks).toMatchObject({ w: 8, h: 11 });
  expect(screen.getByRole("button", { name: "Move Tracks" })).toHaveFocus();
  expect(screen.getByText("Tracks: column 2, row 22, 8 wide by 11 tall.")).toBeInTheDocument();
});

test("a pinned Widget moves into its own Zone, and unpins from there", () => {
  render(<Harness />);
  const pinTop = screen.getByRole("button", { name: "Pin Mixer to top" });
  fireEvent.click(pinTop);
  const top = screen.getByRole("group", { name: "Pinned to the top" });
  expect(within(top).getByText("Mixer content")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pin Mixer to top" })).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(screen.getByRole("button", { name: "Pin Mixer to bottom" }));
  expect(screen.queryByRole("group", { name: "Pinned to the top" })).not.toBeInTheDocument();
  expect(within(screen.getByRole("group", { name: "Pinned to the bottom" })).getByText("Mixer content")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Pin Mixer to bottom" }));
  expect(latest.mixer.zone).toBe("main");
  expect(screen.queryByRole("group", { name: /Pinned/ })).not.toBeInTheDocument();
});

test("dragging the bar snaps a Widget to the cell it is dropped on; Escape cancels", () => {
  // A Grid 24 columns of 24px plus the gaps between them: one cell is 40px across and 40px down.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(24 * 24 + GRID.gap * (GRID.columns - 1));
  render(<Harness />);
  const bar = widget("Tracks").querySelector<HTMLElement>(".widget-bar")!;

  fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 181, clientY: 110 });
  expect(widget("Tracks")).toHaveAttribute("data-dragging");
  expect(document.querySelector<HTMLElement>(".widget-placeholder")!.style.gridColumn).toBe("3 / span 7");
  fireEvent.pointerUp(bar, { pointerId: 1, clientX: 181, clientY: 110 });
  expect(latest.tracks).toMatchObject({ x: 2, y: 7 });

  fireEvent.pointerDown(bar, { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(bar, { pointerId: 2, clientX: 300, clientY: 100 });
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerUp(bar, { pointerId: 2, clientX: 300, clientY: 100 });
  expect(latest.tracks).toMatchObject({ x: 2, y: 7 });
});

test("dragging the corner resizes a Widget, pushing what it grows over down", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(24 * 24 + GRID.gap * (GRID.columns - 1));
  render(<Harness />);
  const corner = widget("Transport").querySelector<HTMLElement>(".widget-resize")!;
  fireEvent.pointerDown(corner, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(corner, { pointerId: 1, clientX: -200, clientY: 400 });
  fireEvent.pointerUp(corner, { pointerId: 1 });
  expect(latest.transport).toMatchObject({ w: 19, h: 17 });
  expect(latest.tracks.y).toBeGreaterThanOrEqual(17);
});

test("the Widgets keep their order in the page while one is dragged past them, so the drag is never lost", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(24 * 24 + GRID.gap * (GRID.columns - 1));
  render(<Harness />);
  const before = order();
  const bar = widget("Transport").querySelector<HTMLElement>(".widget-bar")!;
  // Dragged down onto the Tracks and the Mixer, the Transport goes under both, after them in reading order.
  fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 0, clientY: 40 * 14 });
  expect(order()).toEqual(before);
  fireEvent.pointerUp(bar, { pointerId: 1, clientX: 0, clientY: 40 * 14 });
  expect(latest.transport.y).toBeGreaterThan(latest.mixer.y);
  // Dropped, they take their new order.
  expect(order()).toEqual(["tracks", "mixer", "transport"]);
});

test("a drag whose pointer capture is lost ends where it was, rather than hanging", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(24 * 24 + GRID.gap * (GRID.columns - 1));
  render(<Harness />);
  const bar = widget("Tracks").querySelector<HTMLElement>(".widget-bar")!;
  fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 181, clientY: 110 });
  fireEvent.lostPointerCapture(bar, { pointerId: 1 });
  expect(widget("Tracks")).not.toHaveAttribute("data-dragging");
  expect(document.querySelector(".widget-placeholder")).toBeNull();
  expect(latest.tracks).toMatchObject({ x: 2, y: 7 });
});

test("a small press on the bar is not a drag", () => {
  render(<Harness />);
  const bar = widget("Tracks").querySelector<HTMLElement>(".widget-bar")!;
  fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 102, clientY: 101 });
  fireEvent.pointerUp(bar, { pointerId: 1 });
  expect(widget("Tracks")).not.toHaveAttribute("data-dragging");
  expect(latest.tracks).toEqual(defaultLayout().tracks);
});

test("a Widget's content keeps its state when it is pinned, hidden and shown again", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Clicked 0" }));
  fireEvent.click(screen.getByRole("button", { name: "Pin Tracks to top" }));
  expect(screen.getByRole("button", { name: "Pin Tracks to top" })).toHaveFocus();
  expect(within(screen.getByRole("group", { name: "Pinned to the top" })).getByRole("button", { name: "Clicked 1" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Hide Tracks" }));
  expect(screen.queryByRole("button", { name: /Clicked/ })).not.toBeInTheDocument();
});

test("pinned Zones are drawn into the slots they are given, as full-width bands", () => {
  const top = document.body.appendChild(document.createElement("div"));
  const bottom = document.body.appendChild(document.createElement("div"));
  render(<Harness initial={pinWidget(defaultLayout(), "tracks", "top")} pinned={{ top, bottom }} />);
  expect(within(top).getByText(/Tracks content/)).toBeInTheDocument();
  expect(widget("Tracks").style.gridColumn).toBe(`1 / span ${GRID.columns}`);

  fireEvent.click(screen.getByRole("button", { name: "Pin Mixer to bottom" }));
  expect(within(bottom).getByText("Mixer content")).toBeInTheDocument();
  top.remove();
  bottom.remove();
});

test("a pinned Widget is resized by the edge facing the page, in height only", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(24 * 24 + GRID.gap * (GRID.columns - 1));
  render(<Harness initial={pinWidget(pinWidget(defaultLayout(), "transport", "top"), "mixer", "bottom")} />);
  const topEdge = widget("Transport").querySelector<HTMLElement>(".widget-resize")!;
  expect(topEdge).toHaveAttribute("data-edge", "bottom");
  fireEvent.pointerDown(topEdge, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(topEdge, { pointerId: 1, clientX: -200, clientY: 80 });
  fireEvent.pointerUp(topEdge, { pointerId: 1 });
  expect(latest.transport).toMatchObject({ x: 0, w: GRID.columns, h: 9 });

  // Pinned to the bottom, its top edge faces the page: dragging it up makes it taller.
  const bottomEdge = widget("Mixer").querySelector<HTMLElement>(".widget-resize")!;
  expect(bottomEdge).toHaveAttribute("data-edge", "top");
  fireEvent.pointerDown(bottomEdge, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(bottomEdge, { pointerId: 2, clientX: 0, clientY: -80 });
  fireEvent.pointerUp(bottomEdge, { pointerId: 2 });
  expect(latest.mixer).toMatchObject({ w: GRID.columns, h: 16 });

  const grip = screen.getByRole("button", { name: "Move Mixer" });
  fireEvent.keyDown(grip, { key: "ArrowUp", shiftKey: true });
  expect(latest.mixer.h).toBe(17);
});

test("a Widget with nothing to show is off the Grid, still mounted, until it has something", () => {
  const { rerender } = render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Clicked 0" }));
  const rows = widget("Mixer").style.gridRow;

  rerender(<Harness empty={["tracks"]} />);
  expect(screen.queryByRole("button", { name: "Move Tracks" })).not.toBeInTheDocument();
  // Its rows close up, but it keeps its place and isn't counted as hidden by the musician.
  expect(widget("Mixer").style.gridRow).toBe("8 / span 14");
  fireEvent.keyDown(screen.getByRole("button", { name: "Move Mixer" }), { key: "ArrowRight" });
  expect(latest.tracks.hidden).toBe(false);

  rerender(<Harness empty={[]} />);
  expect(screen.getByRole("button", { name: "Clicked 1" })).toBeInTheDocument();
  expect(widget("Tracks").style.gridRow).toBe("8 / span 12");
  expect(widget("Mixer").style.gridRow).toBe(rows);
});

test("a Widget the musician hid stays hidden when it has something to show again", () => {
  const { rerender } = render(<Harness initial={setWidgetHidden(defaultLayout(), "tracks", true)} empty={["tracks"]} />);
  rerender(<Harness empty={[]} />);
  expect(screen.queryByRole("button", { name: "Move Tracks" })).not.toBeInTheDocument();
});

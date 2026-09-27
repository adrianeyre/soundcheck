// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";

import { type Instrument, type Note, type PatternClip, STARTER_KIT, DEFAULT_SYNTH } from "../project/model";
import { PianoRoll } from "./PianoRoll";

afterEach(cleanup);

// jsdom lays nothing out: the grid and the velocity lane both sit at 0, 0.
const ROW = 18;
const BEAT_PX = 64;
const SYNTH: Instrument = { type: "synth", preset: null, settings: DEFAULT_SYNTH };
const DRUMS: Instrument = { type: "drumSampler", preset: null, pads: [...STARTER_KIT] };
const note = (pitch: number, start: number, length = 240, velocity = 0.8): Note => ({ pitch, start, length, velocity });

/** The Piano Roll over notes it owns, recording each edit it makes: each is one undo step on the Song page. */
function setUp(notes: Note[] = [], instrument = SYNTH) {
  const edits: { notes: Note[]; label: string }[] = [];
  function Harness() {
    const [clip, setClip] = useState<PatternClip>({ id: "c", kind: "pattern", start: 0, length: 3840, notes });
    return (
      <PianoRoll
        clip={clip}
        trackName="Keys"
        instrument={instrument}
        timeSignature={{ beatsPerBar: 4, beatUnit: 4 }}
        onNotes={(next, label) => {
          edits.push({ notes: next, label });
          setClip({ ...clip, notes: next.toSorted((a, b) => a.start - b.start || a.pitch - b.pitch) });
        }}
      />
    );
  }
  render(<Harness />);
  return { edits, last: () => edits.at(-1)! };
}

/** The y of the middle of a Synth row. */
const rowY = (pitch: number) => (127 - pitch) * ROW + ROW / 2;
const grid = () => screen.getByRole("group", { name: "Notes of Keys" });
const noteButton = (name: string) => screen.getByRole("button", { name });
const sorted = (notes: Note[]) => notes.toSorted((a, b) => a.start - b.start || a.pitch - b.pitch);

function drag(target: Element, from: { x: number; y: number }, to: { x: number; y: number }, init = {}) {
  fireEvent.mouseDown(target, { clientX: from.x, clientY: from.y, ...init });
  fireEvent.mouseMove(window, { clientX: to.x, clientY: to.y });
  fireEvent.mouseUp(window, { clientX: to.x, clientY: to.y });
}

test("a click draws a note one grid step long, snapped down; a drag draws a longer one", () => {
  const { edits, last } = setUp();
  drag(grid(), { x: BEAT_PX + 5, y: rowY(60) }, { x: BEAT_PX + 5, y: rowY(60) });
  expect(edits).toHaveLength(1);
  expect(last()).toEqual({ notes: [note(60, 960)], label: "Draw note" });
  expect(noteButton("C4 at 1.2.000")).toHaveAttribute("aria-pressed", "true");

  // A drag to the third beat draws a note two beats long, at any pitch.
  drag(grid(), { x: 0, y: rowY(100) }, { x: 2 * BEAT_PX - 3, y: rowY(100) });
  expect(edits).toHaveLength(2);
  expect(sorted(last().notes)).toEqual([note(100, 0, 1920), note(60, 960)]);
});

test("the snap grid can be off or a triplet", () => {
  const { last } = setUp();
  fireEvent.change(screen.getByLabelText("Note snap"), { target: { value: "1/8T" } });
  drag(grid(), { x: 50, y: rowY(60) }, { x: 50, y: rowY(60) });
  // 50px is 750 ticks; the 1/8 triplet grid is 320.
  expect(last().notes).toEqual([note(60, 640, 320)]);

  fireEvent.change(screen.getByLabelText("Note snap"), { target: { value: "off" } });
  drag(grid(), { x: 50, y: rowY(62) }, { x: 50, y: rowY(62) });
  expect(last().notes).toContainEqual(note(62, 750, 240));
});

test("a note is moved in time and pitch, and resized by its right edge, each as one edit", () => {
  const { edits, last } = setUp([note(60, 960)]);
  // A beat later and a row (a semitone) up.
  drag(noteButton("C4 at 1.2.000"), { x: BEAT_PX, y: rowY(60) }, { x: 2 * BEAT_PX, y: rowY(60) - ROW });
  expect(edits).toHaveLength(1);
  expect(last()).toEqual({ notes: [note(61, 1920)], label: "Move notes" });

  drag(screen.getByTitle("Resize C♯4 at 1.3.000"), { x: 0, y: 0 }, { x: BEAT_PX, y: 0 });
  expect(edits).toHaveLength(2);
  expect(last()).toEqual({ notes: [note(61, 1920, 1200)], label: "Resize notes" });

  // A click without a drag only selects.
  drag(noteButton("C♯4 at 1.3.000"), { x: 0, y: 0 }, { x: 0, y: 0 });
  expect(edits).toHaveLength(2);
});

test("notes are deleted by right-click, by Delete, and by the button", () => {
  const { edits, last } = setUp([note(60, 0), note(62, 0), note(64, 0)]);
  fireEvent.contextMenu(noteButton("C4 at 1.1.000"));
  expect(last()).toEqual({ notes: [note(62, 0), note(64, 0)], label: "Delete notes" });

  fireEvent.keyDown(noteButton("D4 at 1.1.000"), { key: "Delete" });
  expect(last().notes).toEqual([note(64, 0)]);

  fireEvent.mouseDown(noteButton("E4 at 1.1.000"));
  fireEvent.mouseUp(window);
  fireEvent.click(screen.getByRole("button", { name: "Delete notes" }));
  expect(last().notes).toEqual([]);
  expect(edits).toHaveLength(3);
});

test("several notes are selected, moved together, copied and pasted after themselves", () => {
  const { edits, last } = setUp([note(60, 0), note(64, 480), note(67, 0)]);
  fireEvent.mouseDown(noteButton("C4 at 1.1.000"));
  fireEvent.mouseUp(window);
  fireEvent.mouseDown(noteButton("E4 at 1.1.480"), { shiftKey: true });
  fireEvent.mouseUp(window);
  expect(screen.getByText(/2 of 3 notes selected/)).toBeInTheDocument();

  drag(noteButton("E4 at 1.1.480"), { x: 0, y: 0 }, { x: BEAT_PX, y: 0 });
  expect(sorted(last().notes)).toEqual([note(67, 0), note(60, 960), note(64, 1440)]);

  fireEvent.keyDown(noteButton("C4 at 1.2.000"), { key: "c", ctrlKey: true });
  fireEvent.keyDown(noteButton("C4 at 1.2.000"), { key: "v", ctrlKey: true });
  // Pasted straight after the copied notes, and selected.
  expect(last().label).toBe("Paste notes");
  expect(sorted(last().notes)).toEqual([note(67, 0), note(60, 960), note(64, 1440), note(60, 1680), note(64, 2160)]);
  expect(noteButton("C4 at 1.2.720")).toHaveAttribute("aria-pressed", "true");
  expect(noteButton("C4 at 1.2.000")).toHaveAttribute("aria-pressed", "false");

  // The button pastes again, after the last paste.
  fireEvent.click(screen.getByRole("button", { name: "Paste" }));
  expect(sorted(last().notes).map((n) => n.start)).toEqual([0, 960, 1440, 1680, 2160, 2400, 2880]);

  fireEvent.keyDown(noteButton("G4 at 1.1.000"), { key: "a", ctrlKey: true });
  expect(screen.getByText(/7 of 7 notes selected/)).toBeInTheDocument();
  expect(edits).toHaveLength(3);
});

test("velocity is set in the lane and in the field", () => {
  const { edits, last } = setUp([note(60, 0), note(62, 480)]);
  // A quarter of the way up the 64px lane.
  drag(screen.getByTestId("Velocity of C4 at 1.1.000"), { x: 0, y: 48 }, { x: 0, y: 48 });
  expect(last()).toEqual({ notes: [note(60, 0, 240, 0.25), note(62, 480)], label: "Change velocity" });
  expect(screen.getByLabelText("Velocity (%)")).toHaveValue(25);

  fireEvent.keyDown(noteButton("C4 at 1.1.000"), { key: "a", ctrlKey: true });
  fireEvent.change(screen.getByLabelText("Velocity (%)"), { target: { value: "90" } });
  expect(last().notes.map((n) => n.velocity)).toEqual([0.9, 0.9]);
  expect(edits).toHaveLength(2);
});

test("quantise snaps the selected notes' starts to the grid", () => {
  const { last } = setUp([note(60, 130), note(62, 350), note(64, 10)]);
  expect(screen.getByRole("button", { name: "Quantise" })).toBeDisabled();
  fireEvent.mouseDown(noteButton("C4 at 1.1.130"));
  fireEvent.mouseUp(window);
  fireEvent.mouseDown(noteButton("D4 at 1.1.350"), { shiftKey: true });
  fireEvent.mouseUp(window);
  fireEvent.click(screen.getByRole("button", { name: "Quantise" }));
  expect(last().label).toBe("Quantise notes");
  expect(sorted(last().notes)).toEqual([note(64, 10), note(60, 240), note(62, 240)]);
});

test("the keyboard moves and resizes a note, and focus follows it", () => {
  const { edits, last } = setUp([note(60, 0)]);
  const first = noteButton("C4 at 1.1.000");
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowRight" });
  expect(last().notes).toEqual([note(60, 240)]);
  expect(noteButton("C4 at 1.1.240")).toHaveFocus();
  fireEvent.keyDown(noteButton("C4 at 1.1.240"), { key: "ArrowUp" });
  expect(last().notes).toEqual([note(61, 240)]);
  fireEvent.keyDown(noteButton("C♯4 at 1.1.240"), { key: "ArrowRight", shiftKey: true });
  expect(last().notes).toEqual([note(61, 240, 480)]);
  expect(edits).toHaveLength(3);
});

test("a drum Clip's rows are named by Pad", () => {
  setUp([note(36, 0), note(42, 480)], DRUMS);
  expect(noteButton("Kick at 1.1.000")).toBeInTheDocument();
  expect(noteButton("Closed Hat at 1.1.480")).toBeInTheDocument();
  const keys = document.querySelectorAll(".pr-key");
  expect([...keys].map((key) => key.textContent)).toEqual(STARTER_KIT.map((pad) => pad.name));
});

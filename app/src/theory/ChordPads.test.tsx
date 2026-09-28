// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { Note } from "../project/model";
import { ChordPads, type ChordTarget } from "./ChordPads";

afterEach(cleanup);

const TARGET: ChordTarget = { trackName: "Keys", clipLength: 4 * 3840, notes: [], beatTicks: 960, barTicks: 3840 };

function pads(target: ChordTarget | null = TARGET) {
  const noteOn = vi.fn<(note: number, velocity: number) => void>();
  const noteOff = vi.fn<(note: number) => void>();
  const onNotes = vi.fn<(notes: Note[], label: string) => void>();
  render(
    <ChordPads
      songKey={{ root: 0, scale: "major" }}
      onSongKey={() => {}}
      canPlay
      noteOn={noteOn}
      noteOff={noteOff}
      target={target}
      onNotes={onNotes}
    />,
  );
  return { noteOn, noteOff, onNotes };
}

test("the pads are the chords of the key, and the ones borrowed from its parallel key", () => {
  pads();
  const own = within(screen.getByRole("group", { name: "Chords of C Major" })).getAllByRole("button");
  expect(own.map((pad) => pad.getAttribute("aria-label"))).toEqual([
    "C, I",
    "Dm, ii",
    "Em, iii",
    "F, IV",
    "G, V",
    "Am, vi",
    "B°, vii°",
  ]);
  const borrowed = within(screen.getByRole("group", { name: /borrowed/ })).getAllByRole("button");
  expect(borrowed.length).toBeGreaterThan(0);
});

test("holding a pad plays its chord and letting go stops it", () => {
  const { noteOn, noteOff } = pads(null);
  const am = screen.getByRole("button", { name: "Am, vi" });
  fireEvent.pointerDown(am);
  expect(noteOn.mock.calls.map(([note]) => note)).toEqual([69, 72, 76]);
  fireEvent.pointerUp(am);
  expect(noteOff.mock.calls.map(([note]) => note)).toEqual([69, 72, 76]);
  expect(screen.getByText(/Select a Pattern Clip/)).toBeInTheDocument();
});

test("a progression is built from the pads and written into the Clip", () => {
  const { onNotes } = pads();
  for (const name of ["C, I", "G, V", "Am, vi", "F, IV"]) fireEvent.click(screen.getByRole("button", { name }));
  expect(within(screen.getByRole("list", { name: "Progression chords" })).getAllByRole("listitem")).toHaveLength(4);
  fireEvent.click(screen.getByRole("button", { name: "Replace the Clip's notes" }));
  const [notes, label] = onNotes.mock.calls[0]!;
  expect(label).toBe("Write chords");
  // Four chords of three notes, each with its bass note.
  expect(notes).toHaveLength(16);
});

test("a named progression fills the list", () => {
  pads();
  fireEvent.change(screen.getByRole("combobox", { name: "Progression" }), { target: { value: "Jazz turnaround (ii–V–I)" } });
  const chords = within(screen.getByRole("list", { name: "Progression chords" })).getAllByRole("listitem");
  expect(chords.map((chord) => chord.textContent)).toEqual(["Dm", "G", "C", "C"]);
  fireEvent.click(screen.getByRole("button", { name: "Remove chord 4, C" }));
  expect(within(screen.getByRole("list", { name: "Progression chords" })).getAllByRole("listitem")).toHaveLength(3);
});

test("with Jev set up, it picks the next chord of the progression from the pads", async () => {
  const nextChord = vi.fn<NonNullable<Parameters<typeof ChordPads>[0]["nextChord"]>>(async (_key, _progression, candidates) => ({
    chord: candidates.find(({ chord }) => chord.numeral === "IV")!.chord,
    confidence: 0.72,
  }));
  render(
    <ChordPads songKey={{ root: 0, scale: "major" }} onSongKey={() => {}} canPlay noteOn={() => {}} noteOff={() => {}} target={TARGET} onNotes={() => {}} nextChord={nextChord} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "C, I" }));
  fireEvent.click(screen.getByRole("button", { name: "Next chord from Jev" }));

  expect(await screen.findByRole("status")).toHaveTextContent("Jev picked F, 72% confident.");
  expect(within(screen.getByRole("list", { name: "Progression chords" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["C", "F"]);
  const [, progression, candidates] = nextChord.mock.calls[0]!;
  expect(progression.map((chord) => chord.numeral)).toEqual(["I"]);
  expect(candidates.some(({ borrowed }) => borrowed)).toBe(true);
});

test("without Jev there is no button to ask it", () => {
  pads();
  expect(screen.queryByRole("button", { name: "Next chord from Jev" })).not.toBeInTheDocument();
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { Note, PatternClip } from "../project/model";
import { NoteTools } from "./NoteTools";

afterEach(cleanup);

const CLIP: PatternClip = {
  id: "c",
  kind: "pattern",
  start: 0,
  length: 3840,
  notes: [
    { pitch: 60, start: 0, length: 960, velocity: 0.8 },
    { pitch: 64, start: 0, length: 960, velocity: 0.8 },
    { pitch: 67, start: 0, length: 960, velocity: 0.8 },
  ],
};

function tools(clip = CLIP) {
  const onNotes = vi.fn<(notes: Note[], label: string) => void>();
  render(
    <NoteTools clip={clip} trackName="Keys" songKey={{ root: 0, scale: "major" }} onSongKey={() => {}} barTicks={3840} onNotes={onNotes} />,
  );
  return onNotes;
}

test("each tool is one named edit of the whole Clip", () => {
  const onNotes = tools();
  expect(screen.getByRole("status", { name: "Clip notes" })).toHaveTextContent("3 notes · C4–G4 · velocity 102");
  fireEvent.click(screen.getByRole("button", { name: "Octave up" }));
  expect(onNotes).toHaveBeenLastCalledWith(
    CLIP.notes.map((note) => ({ ...note, pitch: note.pitch + 12 })),
    "Octave up",
  );
  fireEvent.click(screen.getByRole("button", { name: "Arpeggiate" }));
  const [arpeggio, label] = onNotes.mock.calls.at(-1)!;
  expect(label).toBe("Arpeggiate");
  expect(arpeggio.map((note: { pitch: number }) => note.pitch)).toEqual([60, 64, 67, 60]);
});

test("with no notes the tools are off", () => {
  tools({ ...CLIP, notes: [] });
  expect(screen.getByRole("button", { name: "Humanise" })).toBeDisabled();
  expect(screen.getByRole("status", { name: "Clip notes" })).toHaveTextContent("No notes");
});

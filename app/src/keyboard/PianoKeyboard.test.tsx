// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { createInstrumentTrack, type PatternClip } from "../project/model";
import { MiniPiano } from "./MiniPiano";
import { PianoKeyboard } from "./PianoKeyboard";
import { soundingInClip, soundingOnTrack } from "./sounding";

afterEach(cleanup);

const C_MAJOR = { root: 0, scale: "major" };
const keyOf = (pitch: number) => document.querySelector<HTMLElement>(`[data-pitch="${pitch}"]`)!;

function keyboard(props: Partial<Parameters<typeof PianoKeyboard>[0]> = {}) {
  const noteOn = vi.fn<(note: number, velocity: number) => void>();
  const noteOff = vi.fn<(note: number) => void>();
  render(
    <PianoKeyboard
      trackName="Keys"
      canPlay
      songKey={C_MAJOR}
      onSongKey={() => {}}
      held={new Set()}
      noteOn={noteOn}
      noteOff={noteOff}
      {...props}
    />,
  );
  return { noteOn, noteOff };
}

test("pressing a key plays its note and letting go stops it", () => {
  const { noteOn, noteOff } = keyboard();
  fireEvent.pointerDown(keyOf(60), { pointerId: 1 });
  expect(noteOn).toHaveBeenCalledWith(60, expect.any(Number));
  fireEvent.pointerUp(keyOf(60), { pointerId: 1 });
  expect(noteOff).toHaveBeenCalledWith(60);
});

test("dragging across the keys moves the note", () => {
  const { noteOn, noteOff } = keyboard();
  fireEvent.pointerDown(keyOf(60), { pointerId: 1 });
  fireEvent.pointerEnter(keyOf(62), { pointerId: 1, buttons: 1 });
  expect(noteOff).toHaveBeenCalledWith(60);
  expect(noteOn).toHaveBeenLastCalledWith(62, expect.any(Number));
});

test("in chord mode a key plays the chord of the key built on it", () => {
  const { noteOn } = keyboard();
  fireEvent.change(screen.getByRole("combobox", { name: "Keyboard plays" }), { target: { value: "triad" } });
  fireEvent.pointerDown(keyOf(62), { pointerId: 1 });
  expect(noteOn.mock.calls.map(([note]) => note)).toEqual([62, 65, 69]);
});

test("without audio the keys are silent and say why", () => {
  const { noteOn } = keyboard({ canPlay: false });
  fireEvent.pointerDown(keyOf(60), { pointerId: 1 });
  expect(noteOn).not.toHaveBeenCalled();
  expect(screen.getByText("Start audio to play the keys.")).toBeInTheDocument();
});

test("held and played notes light up, and are named as a chord", () => {
  keyboard({ held: new Set([60, 64, 67]), playing: new Set([72]) });
  expect(keyOf(60)).toHaveAttribute("data-held", "true");
  expect(keyOf(72)).toHaveAttribute("data-playing", "true");
  expect(keyOf(61)).not.toHaveAttribute("data-in-key");
  expect(keyOf(62)).toHaveAttribute("data-in-key", "true");
  expect(screen.getByRole("status", { name: "Chord held" })).toHaveTextContent("C");
});

test("the small piano lights what the song plays and says so", () => {
  render(<MiniPiano label="Keys of Lead" low={60} high={72} playing={new Set([64])} held={new Set([67])} />);
  const picture = screen.getByRole("img", { name: /Keys of Lead/ });
  expect(picture).toHaveAccessibleName("Keys of Lead: E4, G4 sounding");
  expect(within(picture as unknown as HTMLElement).getAllByText(/C\d/).length).toBeGreaterThan(0);
  expect(picture.querySelectorAll('[data-state="playing"]')).toHaveLength(1);
});

test("what is sounding is worked out from the notes and the playhead", () => {
  const clip: PatternClip = {
    id: "c",
    kind: "pattern",
    start: 960,
    length: 3840,
    notes: [
      { pitch: 60, start: 0, length: 480, velocity: 1 },
      { pitch: 64, start: 240, length: 480, velocity: 1 },
    ],
  };
  expect([...soundingInClip(clip, 960 + 300)]).toEqual([60, 64]);
  expect([...soundingInClip(clip, 960 + 480)]).toEqual([64]);
  expect([...soundingInClip(clip, 100)]).toEqual([]);
  const track = { ...createInstrumentTrack("Keys"), clips: [clip] };
  expect([...soundingOnTrack(track, 1000)]).toEqual([60]);
  expect([...soundingOnTrack({ ...track, mixer: { ...track.mixer, mute: true } }, 1000)]).toEqual([]);
});

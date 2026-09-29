// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { createInstrumentTrack, type Instrument, type PatternClip, STARTER_KIT } from "../project/model";
import { PianoRoll } from "../song/PianoRoll";
import { StepSequencer } from "../song/StepSequencer";
import { MiniPiano } from "./MiniPiano";

afterEach(cleanup);

const CLIP: PatternClip = { id: "c", kind: "pattern", start: 0, length: 3840, notes: [{ pitch: 64, start: 0, length: 240, velocity: 0.8 }] };
const SYNTH = createInstrumentTrack("Keys").instrument;
const DRUMS: Instrument = { type: "drumSampler", preset: null, pads: [...STARTER_KIT] };
const SIGNATURE = { beatsPerBar: 4, beatUnit: 4 };

test("a key of the small piano plays when clicked, and lets go", () => {
  const onPlay = vi.fn<(note: number, on: boolean) => void>();
  render(<MiniPiano label="Keys" low={60} high={72} playing={new Set()} onPlay={onPlay} />);
  const e4 = screen.getByRole("button", { name: "Play E4" });
  fireEvent.pointerDown(e4);
  fireEvent.pointerUp(e4);
  expect(onPlay.mock.calls).toEqual([
    [64, true],
    [64, false],
  ]);
});

test("the small piano is one keyboard stop: arrows move along it and Enter plays", () => {
  const onPlay = vi.fn<(note: number, on: boolean) => void>();
  render(<MiniPiano label="Keys" low={60} high={72} playing={new Set()} onPlay={onPlay} />);
  const c4 = screen.getByRole("button", { name: "Play C4" });
  expect(c4).toHaveAttribute("tabindex", "0");
  expect(screen.getByRole("button", { name: "Play D4" })).toHaveAttribute("tabindex", "-1");
  fireEvent.keyDown(c4, { key: "ArrowRight" });
  const cSharp = screen.getByRole("button", { name: "Play C♯4" });
  expect(cSharp).toHaveAttribute("tabindex", "0");
  fireEvent.keyDown(cSharp, { key: "Enter" });
  fireEvent.keyUp(cSharp, { key: "Enter" });
  expect(onPlay.mock.calls).toEqual([
    [61, true],
    [61, false],
  ]);
});

test("without audio the small piano is only a picture", () => {
  render(<MiniPiano label="Keys" low={60} high={72} playing={new Set()} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByRole("img", { name: /Keys/ })).toBeInTheDocument();
});

function sequencer(instrument: Instrument, onPlay: (note: number, on: boolean) => void) {
  render(
    <StepSequencer
      clip={CLIP}
      trackName="Track"
      instrument={instrument}
      timeSignature={SIGNATURE}
      stepTicks={240}
      onStepTicks={() => {}}
      onNotes={() => {}}
      onLength={() => {}}
      onDelete={() => {}}
      onPlay={onPlay}
    />,
  );
}

test("the Step Sequencer's piano and a drum Track's kit play what is clicked", () => {
  const onPlay = vi.fn<(note: number, on: boolean) => void>();
  sequencer(SYNTH, onPlay);
  fireEvent.pointerDown(screen.getAllByRole("button", { name: /^Play / })[0]!);
  expect(onPlay).toHaveBeenLastCalledWith(expect.any(Number), true);
  cleanup();
  sequencer(DRUMS, onPlay);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Hit Snare" }));
  expect(onPlay).toHaveBeenLastCalledWith(38, true);
});

test("the Piano Roll's piano, and the key beside each row, play their note", () => {
  const onPlay = vi.fn<(note: number, on: boolean) => void>();
  const { container } = render(
    <PianoRoll clip={CLIP} trackName="Keys" instrument={SYNTH} timeSignature={SIGNATURE} onNotes={() => {}} onPlay={onPlay} />,
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: "Play E4" }));
  expect(onPlay).toHaveBeenLastCalledWith(64, true);
  const rowKey = [...container.querySelectorAll<HTMLElement>(".pr-key")].find((key) => key.textContent === "E4")!;
  fireEvent.pointerDown(rowKey);
  fireEvent.pointerUp(rowKey);
  expect(onPlay.mock.calls.slice(-2)).toEqual([
    [64, true],
    [64, false],
  ]);
});

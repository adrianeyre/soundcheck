// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { DjAnalysis } from "../audio/audio-output";
import { EMPTY_REPORT } from "./dj-report";
import { scrubbedTo, type StackLane, WaveformStack } from "./WaveformStack";

afterEach(cleanup);

const ANALYSIS: DjAnalysis = { seconds: 60, bpm: 120, firstBeat: 0, key: null, waveformRate: 100, waveform: Array.from({ length: 24_000 }, () => 0.2) };

function lane(change: Partial<StackLane["report"]> = {}, vinyl = true): StackLane {
  return {
    deck: 0,
    report: { ...EMPTY_REPORT.decks[0]!, loaded: true, duration: 60, bpm: 120, effectiveBpm: 120, position: 10, ...change },
    analysis: ANALYSIS,
    hotCues: [],
    title: "Night Drive",
    syncMaster: false,
    vinyl,
  };
}

function stack(l: StackLane) {
  const onDeck = vi.fn<(deck: number, name: string, value: number) => void>();
  render(<WaveformStack lanes={[l]} span={4} onSpan={() => {}} onDeck={onDeck} />);
  const scrub = screen.getByRole("slider", { name: /Deck 1 waveform/ });
  // jsdom lays nothing out: the lane is 800 pixels wide, 8 seconds across.
  scrub.getBoundingClientRect = () => ({ width: 800, height: 60, left: 0, top: 0, right: 800, bottom: 60, x: 0, y: 0, toJSON: () => {} });
  return { onDeck, scrub, calls: (name: string) => onDeck.mock.calls.filter(([, n]) => n === name).map(([, , v]) => v) };
}

test("dragging the waveform right takes the playhead back", () => {
  expect(scrubbedTo(10, 100, 800, 4, 60)).toBe(9);
  expect(scrubbedTo(10, -100, 800, 4, 60)).toBe(11);
  expect(scrubbedTo(0.5, 800, 800, 4, 60)).toBe(0);
});

test("dragging a paused lane seeks, and lets go on a beat with Quantize", () => {
  const { scrub, calls } = stack(lane({ quantize: true }));
  fireEvent.pointerDown(scrub, { pointerId: 1, clientX: 400 });
  fireEvent.pointerMove(scrub, { pointerId: 1, clientX: 330 });
  expect(calls("seek").at(-1)).toBeCloseTo(10.7, 6);
  fireEvent.pointerUp(scrub, { pointerId: 1, clientX: 330 });
  // A beat at 120 BPM is half a second.
  expect(calls("seek").at(-1)).toBe(10.5);
  expect(calls("touch")).toEqual([]);
});

test("dragging a playing lane in vinyl mode scratches", () => {
  const { scrub, calls } = stack(lane({ playing: true }));
  fireEvent.pointerDown(scrub, { pointerId: 1, clientX: 400, timeStamp: 0 });
  fireEvent.pointerMove(scrub, { pointerId: 1, clientX: 500, timeStamp: 500 });
  fireEvent.pointerUp(scrub, { pointerId: 1, clientX: 500 });
  expect(calls("touch")).toEqual([1, 0]);
  expect(calls("scratch").at(-1)).toBeLessThan(0);
  expect(calls("seek")).toEqual([]);
});

test("the arrow keys move a beat, a bar with Shift, and the strip under it jumps", () => {
  const { scrub, calls } = stack(lane({ quantize: false }, false));
  fireEvent.keyDown(scrub, { key: "ArrowRight" });
  fireEvent.keyDown(scrub, { key: "ArrowLeft", shiftKey: true });
  expect(calls("seek")).toEqual([10.5, 8]);
  const strip = screen.getByRole("slider", { name: "Deck 1 whole track: click to move there" });
  strip.getBoundingClientRect = () => ({ width: 600, height: 14, left: 0, top: 0, right: 600, bottom: 14, x: 0, y: 0, toJSON: () => {} });
  fireEvent.click(strip, { clientX: 300 });
  expect(calls("seek").at(-1)).toBe(30);
});

test("without a way to tell the engine, the lanes only show", () => {
  render(<WaveformStack lanes={[lane()]} span={4} onSpan={() => {}} />);
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
});

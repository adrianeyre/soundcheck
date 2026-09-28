// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { defaultSynthSettings, type SynthSettings } from "./synth-params";
import { envelopeLayout, envelopePoints, fromLogFraction, logFraction, SynthVisuals, wave } from "./SynthVisuals";

afterEach(cleanup);

// jsdom lays nothing out and has no pointer capture: each picture is 240 × 90 pixels, as its own units.
beforeEach(() => {
  const captured = new Set<number>();
  Object.assign(Element.prototype, {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 240,
    height: 90,
    right: 240,
    bottom: 90,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

test("the waves run from -1 to 1 over a cycle", () => {
  expect(wave("saw", 0)).toBe(-1);
  expect(wave("square", 0.25)).toBe(1);
  expect(wave("square", 0.75)).toBe(-1);
  expect(wave("triangle", 0.5)).toBe(1);
  expect(wave("sine", 0.25)).toBeCloseTo(1, 9);
});

test("an envelope rises, settles, holds and falls", () => {
  expect(envelopePoints({ attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.4 }, 1)).toEqual([
    [0, 0],
    [0.1, 1],
    [0.30000000000000004, 0.5],
    [1.3, 0.5],
    [1.7000000000000002, 0],
  ]);
});

test("log scales go both ways, and an envelope's corners each keep to their own zone", () => {
  expect(fromLogFraction(logFraction(440, 20, 20_000), 20, 20_000)).toBeCloseTo(440, 6);
  expect(logFraction(1, 20, 20_000)).toBe(0);
  const short = envelopeLayout({ attack: 0.001, decay: 0.001, sustain: 1, release: 0.001 });
  expect(short.attackX).toBe(0);
  const long = envelopeLayout({ attack: 10, decay: 10, sustain: 1, release: 10 });
  expect(long.releaseX).toBeLessThanOrEqual(240);
  // Lengthening the attack moves the decay's corner along with it, not its own time.
  const a = envelopeLayout({ attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.1 });
  const b = envelopeLayout({ attack: 0.1, decay: 0.1, sustain: 0.5, release: 0.1 });
  expect(b.decayX - b.attackX).toBeCloseTo(a.decayX - a.attackX, 9);
});

test("the Synth's display draws its oscillators, envelopes, filter and LFO", () => {
  render(<SynthVisuals settings={defaultSynthSettings()} />);
  expect(screen.getByRole("img", { name: /^Oscillators: saw and saw/ })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /^Amp envelope: attack 0.005 s/ })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /^Filter: low-pass at 2400 Hz/ })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "LFO: off" })).toBeInTheDocument();
  // Without a way to change the Synth, they are only pictures.
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
});

function editable(settings: SynthSettings = defaultSynthSettings()) {
  const onChange = vi.fn<(change: Partial<SynthSettings>) => void>();
  render(<SynthVisuals settings={settings} onChange={onChange} />);
  return onChange;
}

function drag(handle: HTMLElement, to: [number, number]) {
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(handle, { pointerId: 1 });
}

test("dragging the filter's handle sets its cutoff across and its resonance up, as one change", () => {
  const onChange = editable();
  const handle = screen.getByRole("slider", { name: "Filter cutoff and resonance" });
  // Half way across is 632 Hz on 20 Hz to 20 kHz; near the top is a high Q.
  fireEvent.pointerDown(handle, { pointerId: 1 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 60, clientY: 50 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 120, clientY: 10 });
  expect(onChange).not.toHaveBeenCalled();
  // The picture follows the drag before it is let go.
  expect(screen.getByRole("group", { name: /^Filter: low-pass at 632 Hz/ })).toBeInTheDocument();
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(onChange).toHaveBeenCalledTimes(1);
  const change = onChange.mock.calls[0]![0];
  expect(change.cutoffHz).toBe(632);
  expect(change.resonance).toBeGreaterThan(10);
});

test("an envelope's corners drag its attack, decay and sustain, and release", () => {
  const onChange = editable();
  drag(screen.getByRole("slider", { name: "Amp envelope attack" }), [0, 0]);
  expect(onChange).toHaveBeenLastCalledWith({ attack: 0.001 });
  const decay = screen.getByRole("slider", { name: "Amp envelope decay and sustain" });
  drag(decay, [200, 86]);
  expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ sustain: 0 });
  drag(screen.getByRole("slider", { name: "Filter envelope release" }), [240, 86]);
  expect(onChange.mock.calls.at(-1)![0]).toEqual({ filterRelease: expect.any(Number) });
});

test("the LFO and the oscillator mix drag too", () => {
  const onChange = editable();
  drag(screen.getByRole("slider", { name: "LFO rate and depth" }), [240, 6]);
  expect(onChange).toHaveBeenLastCalledWith({ lfoRateHz: 20, lfoDepth: 1 });
  drag(screen.getByRole("slider", { name: "Oscillator mix" }), [232, 6]);
  expect(onChange).toHaveBeenLastCalledWith({ oscMix: 1 });
});

test("a focused handle moves with the arrow keys, one change each", () => {
  const onChange = editable();
  const filter = screen.getByRole("slider", { name: "Filter cutoff and resonance" });
  fireEvent.keyDown(filter, { key: "ArrowRight" });
  expect(onChange.mock.calls[0]![0].cutoffHz).toBeGreaterThan(2400);
  fireEvent.keyDown(filter, { key: "ArrowUp" });
  expect(onChange.mock.calls[1]![0].resonance).toBeGreaterThan(1.2);
  fireEvent.keyDown(screen.getByRole("slider", { name: "Amp envelope decay and sustain" }), { key: "ArrowDown" });
  expect(onChange.mock.calls[2]![0]).toEqual({ sustain: 0.55 });
});

test("a drag that ends where it started changes nothing", () => {
  const onChange = editable();
  const handle = screen.getByRole("slider", { name: "Filter cutoff and resonance" });
  fireEvent.pointerDown(handle, { pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(onChange).not.toHaveBeenCalled();
});

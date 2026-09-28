// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { defaultSynthSettings } from "./synth-params";
import { envelopePoints, SynthVisuals, wave } from "./SynthVisuals";

afterEach(cleanup);

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

test("the Synth's display draws its oscillators, envelopes, filter and LFO", () => {
  render(<SynthVisuals settings={defaultSynthSettings()} />);
  expect(screen.getByRole("img", { name: /^Oscillators: saw and saw/ })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /^Amp envelope: attack 0.005 s/ })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /^Filter: low-pass at 2400 Hz/ })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "LFO: off" })).toBeInTheDocument();
});

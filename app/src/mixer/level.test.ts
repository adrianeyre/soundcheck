import { describe, expect, test } from "vitest";

import { formatDb, gainToDb, levelFraction } from "./level";

describe("levels", () => {
  test("gain reads as decibels, with silence at minus infinity", () => {
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(2)).toBeCloseTo(6.02, 2);
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  });

  test("a level is written the way a fader is labelled", () => {
    expect(formatDb(1)).toBe("0.0 dB");
    expect(formatDb(2)).toBe("+6.0 dB");
    expect(formatDb(0.5)).toBe("-6.0 dB");
    expect(formatDb(0)).toBe("-∞ dB");
    expect(formatDb(0.0001)).toBe("-∞ dB");
  });

  test("a meter fills on a decibel scale from the floor to full scale", () => {
    expect(levelFraction(1)).toBe(1);
    expect(levelFraction(2)).toBe(1);
    expect(levelFraction(0)).toBe(0);
    expect(levelFraction(0.5)).toBeCloseTo(0.9, 2);
    // Half the scale is half of the 60 dB it covers.
    expect(levelFraction(10 ** (-30 / 20))).toBeCloseTo(0.5, 6);
  });
});

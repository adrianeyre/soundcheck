import { expect, test } from "vitest";

import { BEAT_FX } from "./dj-logic";
import { SAMPLER_SLOTS } from "./dj-report";
import { DEFAULT_PAGE, dim, halfDeck, PAD_FX, padAction, padCaption, pagesOf } from "./pad-controller";
import { defaultSampler } from "./sampler-library";

test("each PAD MODE button has a mode, and with SHIFT a second, with the hardware's pages", () => {
  expect(pagesOf("hotCue")).toBe(1);
  expect(pagesOf("beatJump")).toBe(3);
  expect(pagesOf("keyboard")).toBe(5);
  expect(pagesOf("keyShift")).toBe(5);
  expect(DEFAULT_PAGE.beatJump).toBe(1);
});

test("Hot Cue mode's pads are Hot Cues A to P, and Pad FX 1 and 2 are A to AF", () => {
  expect(padAction("hotCue", 0, 15)).toEqual({ kind: "hotCue", index: 15 });
  expect(padCaption(padAction("hotCue", 0, 15))).toBe("P");
  expect(PAD_FX.map((fx) => fx.letter)).toHaveLength(32);
  expect(PAD_FX.at(-1)!.letter).toBe("AF");
  expect(PAD_FX.every((fx) => fx.type >= 0 && fx.type < BEAT_FX.length)).toBe(true);
  expect(padAction("padFx2", 0, 0)).toMatchObject({ kind: "padFx", fx: { letter: "Q" } });
});

test("Beat Jump's pages pair back and forward, and the third has only four pairs' worth", () => {
  expect(padAction("beatJump", 0, 0)).toEqual({ kind: "beatJump", beats: -1 / 32, label: "FINE" });
  expect(padAction("beatJump", 0, 11)).toEqual({ kind: "beatJump", beats: 8, label: "2 bars" });
  expect(padAction("beatJump", 1, 15)).toEqual({ kind: "beatJump", beats: 128, label: "32 bars" });
  expect(padAction("beatJump", 2, 7)).toEqual({ kind: "beatJump", beats: 128, label: "128 beats" });
  expect(padAction("beatJump", 2, 8)).toEqual({ kind: "none" });
});

test("Beat Loop runs from 1/64 of a beat to 128 bars", () => {
  expect(padAction("beatLoop", 0, 0)).toMatchObject({ beats: 1 / 64, label: "1/64 beat" });
  expect(padAction("beatLoop", 0, 15)).toMatchObject({ beats: 512, label: "128 bars" });
});

test("the Keyboard's and Key Shift's five pages hold semitones and the key controls", () => {
  expect(padAction("keyboard", 0, 0)).toEqual({ kind: "keyboard", semitones: 12 });
  expect(padAction("keyboard", 0, 1)).toEqual({ kind: "none" });
  expect(padAction("keyboard", 0, 12)).toEqual({ kind: "keyboard", semitones: 0 });
  expect(padAction("keyShift", 1, 15)).toEqual({ kind: "keyShift", semitones: -5 });
  expect(padAction("keyShift", 3, 8)).toEqual({ kind: "keySync" });
  expect(padAction("keyShift", 4, 4)).toEqual({ kind: "keyReset" });
  expect(padAction("keyboard", 4, 1)).toEqual({ kind: "keyStep", by: 1 });
  expect(padAction("keyboard", 4, 5)).toEqual({ kind: "keyStep", by: -1 });
  expect(padCaption(padAction("keyShift", 1, 12))).toBe("−8");
});

test("the left half drives Deck 1 or 3, the right 2 or 4", () => {
  expect([halfDeck(0, false), halfDeck(0, true), halfDeck(1, false), halfDeck(1, true)]).toEqual([0, 2, 1, 3]);
  expect(dim("#ffffff", 0.5)).toBe("#808080");
});

test("the Sampler opens with the Starter Kit across its first bank and into its second", () => {
  const setup = defaultSampler((index) => (index < 22 ? { name: `S${index}`, bytes: new Uint8Array([index]) } : null));
  expect(setup.slots).toHaveLength(SAMPLER_SLOTS);
  expect(setup.slots[15]).toMatchObject({ name: "S15", bundled: 15, mode: 0, gain: 1 });
  expect(setup.slots[21]).toMatchObject({ name: "S21" });
  expect(setup.slots[22]).toBeNull();
});

import { expect, test } from "vitest";

import { parseMidiMessage } from "./midi-input";

test("reads note-on and note-off on any channel", () => {
  expect(parseMidiMessage(new Uint8Array([0x90, 60, 127]))).toEqual({
    type: "noteOn",
    note: 60,
    velocity: 1,
  });
  expect(parseMidiMessage(new Uint8Array([0x8f, 61, 40]))).toEqual({ type: "noteOff", note: 61 });
});

test("treats note-on with velocity 0 as note-off", () => {
  expect(parseMidiMessage(new Uint8Array([0x93, 62, 0]))).toEqual({ type: "noteOff", note: 62 });
});

test("ignores everything that isn't a note", () => {
  expect(parseMidiMessage(new Uint8Array([0xb0, 64, 127]))).toBeNull(); // sustain pedal
  expect(parseMidiMessage(new Uint8Array([0xf8]))).toBeNull(); // clock
});

// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";

import type { NoteEvent } from "../midi/midi-input";
import { keyToNote, listenToComputerKeyboard } from "./computer-keyboard";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

function listen() {
  const onNote = vi.fn<(event: NoteEvent) => void>();
  const onOctave = vi.fn<(octave: number) => void>();
  stop = listenToComputerKeyboard(window, onNote, onOctave);
  return { onNote, onOctave };
}

const press = (code: string, init: KeyboardEventInit = {}, target: EventTarget = window) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, ...init }));
const release = (code: string) => window.dispatchEvent(new KeyboardEvent("keyup", { code }));

test("the home row plays a C major scale from middle C, the row above the sharps", () => {
  expect(["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK"].map((k) => keyToNote(k, 4))).toEqual([
    60, 62, 64, 65, 67, 69, 71, 72,
  ]);
  expect(keyToNote("KeyW", 4)).toBe(61);
  expect(keyToNote("KeyQ", 4)).toBeNull();
});

test("a key plays its note while held and stops when released", () => {
  const { onNote } = listen();
  press("KeyH");
  release("KeyH");
  expect(onNote.mock.calls).toEqual([
    [{ type: "noteOn", note: 69, velocity: 0.8 }],
    [{ type: "noteOff", note: 69 }],
  ]);
});

test("auto-repeat and shortcuts don't play notes", () => {
  const { onNote } = listen();
  press("KeyA", { repeat: true });
  press("KeyS", { ctrlKey: true });
  press("KeyD", { metaKey: true });
  expect(onNote).not.toHaveBeenCalled();
});

test("typing in a number field doesn't play, but a focused checkbox does", () => {
  const { onNote } = listen();
  const field = document.body.appendChild(document.createElement("input"));
  field.type = "number";
  press("KeyA", {}, field);
  expect(onNote).not.toHaveBeenCalled();

  const box = document.body.appendChild(document.createElement("input"));
  box.type = "checkbox";
  press("KeyA", {}, box);
  expect(onNote).toHaveBeenCalledWith({ type: "noteOn", note: 60, velocity: 0.8 });
  document.body.replaceChildren();
});

test("Z and X change octave, and a key held across the change ends its own note", () => {
  const { onNote, onOctave } = listen();
  press("KeyA");
  press("KeyX");
  expect(onOctave).toHaveBeenLastCalledWith(5);
  release("KeyA");
  expect(onNote).toHaveBeenLastCalledWith({ type: "noteOff", note: 60 });

  press("KeyA");
  expect(onNote).toHaveBeenLastCalledWith({ type: "noteOn", note: 72, velocity: 0.8 });
});

test("the octave stops at the ends of the MIDI range", () => {
  const { onOctave } = listen();
  for (let n = 0; n < 10; n++) press("KeyZ");
  expect(onOctave).toHaveBeenLastCalledWith(0);
});

test("leaving the window, or stopping, releases held keys", () => {
  const { onNote } = listen();
  press("KeyA");
  window.dispatchEvent(new Event("blur"));
  expect(onNote).toHaveBeenLastCalledWith({ type: "noteOff", note: 60 });

  press("KeyS");
  stop?.();
  stop = undefined;
  expect(onNote).toHaveBeenLastCalledWith({ type: "noteOff", note: 62 });
});

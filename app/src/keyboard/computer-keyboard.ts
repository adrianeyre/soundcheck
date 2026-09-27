/**
 * Playing notes from the computer keyboard, for when there is no MIDI
 * keyboard. The layout is the usual DAW one: the home row is white keys, the
 * row above is black keys, and Z / X shift down / up an octave.
 *
 * Keys are matched by physical position (`KeyboardEvent.code`), so the layout
 * is the same on QWERTY, AZERTY and the rest.
 */
import type { NoteEvent } from "../midi/midi-input";

/** Semitones above the octave's C, for each key. */
const KEY_SEMITONES: Record<string, number> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
  KeyO: 13,
  KeyL: 14,
  KeyP: 15,
  Semicolon: 16,
};

const OCTAVE_DOWN = "KeyZ";
const OCTAVE_UP = "KeyX";
const VELOCITY = 0.8;

/** Middle C (C4) on the A key to start with. */
export const DEFAULT_OCTAVE = 4;
const LOWEST_OCTAVE = 0;
const HIGHEST_OCTAVE = 8;

/** The MIDI note a key plays in `octave`, or null if it isn't a note key. */
export function keyToNote(code: string, octave: number): number | null {
  const semitone = KEY_SEMITONES[code];
  return semitone === undefined ? null : (octave + 1) * 12 + semitone;
}

/** Typing in a text field shouldn't play notes. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(target.type);
}

/**
 * Listen for note keys on `target`. Returns a function that stops listening
 * and releases any keys still held.
 */
export function listenToComputerKeyboard(
  target: Window,
  onNote: (event: NoteEvent) => void,
  onOctave: (octave: number) => void = () => {},
): () => void {
  let octave = DEFAULT_OCTAVE;
  // The note each held key started, so releasing it after an octave change
  // still ends the right note.
  const held = new Map<string, number>();

  const releaseAll = () => {
    for (const note of held.values()) onNote({ type: "noteOff", note });
    held.clear();
  };

  const keyDown = (event: KeyboardEvent) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTyping(event.target)) return;

    if (event.code === OCTAVE_DOWN || event.code === OCTAVE_UP) {
      const step = event.code === OCTAVE_UP ? 1 : -1;
      octave = Math.min(HIGHEST_OCTAVE, Math.max(LOWEST_OCTAVE, octave + step));
      onOctave(octave);
      return;
    }

    const note = keyToNote(event.code, octave);
    if (note === null || held.has(event.code)) return;
    held.set(event.code, note);
    onNote({ type: "noteOn", note, velocity: VELOCITY });
  };

  const keyUp = (event: KeyboardEvent) => {
    const note = held.get(event.code);
    if (note === undefined) return;
    held.delete(event.code);
    onNote({ type: "noteOff", note });
  };

  target.addEventListener("keydown", keyDown);
  target.addEventListener("keyup", keyUp);
  // Keys released while the window is in the background never send keyup.
  target.addEventListener("blur", releaseAll);
  return () => {
    target.removeEventListener("keydown", keyDown);
    target.removeEventListener("keyup", keyUp);
    target.removeEventListener("blur", releaseAll);
    releaseAll();
  };
}

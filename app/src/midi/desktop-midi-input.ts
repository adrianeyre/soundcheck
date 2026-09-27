/**
 * MIDI keyboards on the desktop: read natively (`desktop/src/midi.rs`), with
 * notes going straight from the MIDI thread into the engine. The UI only
 * learns which keyboards are connected, so `onNote` is never called.
 */
import type { Invoke } from "../audio/desktop-audio-output";
import type { OpenMidiInput } from "./midi-input";

/** Keyboards plugged in later are picked up this often. */
const DEVICES_MS = 2_000;

export function desktopMidiInput(invoke: Invoke): OpenMidiInput {
  return async (_onNote, onDevices) => {
    const refresh = () => invoke<string[]>("midi_devices").then(onDevices);
    await refresh();
    const timer = setInterval(() => void refresh().catch(() => {}), DEVICES_MS);
    return { close: () => clearInterval(timer) };
  };
}

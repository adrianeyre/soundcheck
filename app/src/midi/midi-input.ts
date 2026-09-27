/**
 * The seam between the UI and MIDI keyboards. Web MIDI is the first
 * implementation.
 */

export type NoteEvent =
  | { type: "noteOn"; note: number; velocity: number }
  | { type: "noteOff"; note: number };

export interface MidiInput {
  close(): void;
}

/**
 * Start listening. `onNote` gets every key from every connected keyboard;
 * `onDevices` gets the keyboards' names now and whenever one comes or goes.
 */
export type OpenMidiInput = (
  onNote: (event: NoteEvent) => void,
  onDevices: (names: string[]) => void,
) => Promise<MidiInput>;

const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;

/** Read a note from a raw MIDI message, on any channel. Velocity is 0..=1. */
export function parseMidiMessage(data: Uint8Array): NoteEvent | null {
  const [status = 0, note = 0, velocity = 0] = data;
  const kind = status & 0xf0;
  // A note-on with velocity 0 is how many keyboards send note-off.
  if (kind === NOTE_ON && velocity > 0) return { type: "noteOn", note, velocity: velocity / 127 };
  if (kind === NOTE_OFF || kind === NOTE_ON) return { type: "noteOff", note };
  return null;
}

export const openWebMidiInput: OpenMidiInput = async (onNote, onDevices) => {
  if (!("requestMIDIAccess" in navigator)) {
    throw new Error("This browser has no Web MIDI");
  }
  const access = await navigator.requestMIDIAccess();

  const listen = (message: MIDIMessageEvent) => {
    const event = message.data && parseMidiMessage(message.data);
    if (event) onNote(event);
  };
  // Adding the same listener twice is a no-op, so re-attaching on every
  // device change only reaches the keyboards that are new.
  const attach = () => {
    for (const input of access.inputs.values()) input.addEventListener("midimessage", listen);
    onDevices([...access.inputs.values()].map((input) => input.name ?? input.id));
  };

  attach();
  access.addEventListener("statechange", attach);
  return {
    close() {
      access.removeEventListener("statechange", attach);
      for (const input of access.inputs.values()) input.removeEventListener("midimessage", listen);
    },
  };
};

import type { EngineCommand } from "../audio/audio-output";
import { barTicks, type TimeSignature } from "../project/time";

/** What the transport bar controls, apart from play and stop. */
export interface TransportSettings {
  /** Quarter notes per minute. */
  tempo: number;
  timeSignature: TimeSignature;
  loop: boolean;
  /** The loop region, in ticks; set by dragging on the timeline's ruler. */
  loopStart: number;
  loopEnd: number;
  metronome: boolean;
}

export const MIN_TEMPO = 20;
export const MAX_TEMPO = 999;

export const DEFAULT_TRANSPORT: TransportSettings = {
  tempo: 120,
  timeSignature: { beatsPerBar: 4, beatUnit: 4 },
  loop: false,
  loopStart: 0,
  loopEnd: barTicks({ beatsPerBar: 4, beatUnit: 4 }),
  metronome: false,
};

/** The commands that put the engine's transport into `settings`. */
export function transportCommands(settings: TransportSettings): EngineCommand[] {
  const { tempo, timeSignature, loop, loopStart, loopEnd, metronome } = settings;
  return [
    { type: "setTempo", bpm: tempo },
    { type: "setTimeSignature", ...timeSignature },
    {
      type: "setLoop",
      startTick: loopStart,
      endTick: loopEnd,
      enabled: loop,
    },
    { type: "setMetronome", on: metronome },
  ];
}

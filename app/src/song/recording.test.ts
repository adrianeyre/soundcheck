import { expect, test } from "vitest";

import type { RecordedNoteEvent } from "../audio/audio-output";
import { createInstrumentTrack, type InstrumentTrack, type PatternClip } from "../project/model";
import { TICKS_PER_BEAT } from "../project/time";
import { pairRecordedNotes, quantiseStarts, recordingCommands, type RecordingOptions } from "./recording";

const BAR = 4 * TICKS_PER_BEAT;

function on(tick: number, pitch: number, velocity = 0.8): RecordedNoteEvent {
  return { tick, pitch, velocity, on: true };
}
function off(tick: number, pitch: number): RecordedNoteEvent {
  return { tick, pitch, velocity: 0, on: false };
}

function clipOf(notes: PatternClip["notes"] = [], start = 0): PatternClip {
  return { id: "clip-1", kind: "pattern", start, length: BAR, notes };
}

function options(over: Partial<RecordingOptions> = {}): RecordingOptions {
  const track: InstrumentTrack = createInstrumentTrack("Synth 1");
  return {
    track,
    clip: null,
    startTick: 0,
    stopTick: BAR,
    newClipLength: BAR,
    quantiseTicks: null,
    newClipId: () => "new-clip",
    ...over,
  };
}

test("pairs note-ons with note-offs, in the order played", () => {
  const events = [on(0, 60), on(480, 64), off(960, 60), off(1_200, 64)];
  expect(pairRecordedNotes(events, 1_920)).toEqual([
    { pitch: 60, start: 0, length: 960, velocity: 0.8 },
    { pitch: 64, start: 480, length: 720, velocity: 0.8 },
  ]);
});

test("a note still held when recording stops ends at the stop position", () => {
  expect(pairRecordedNotes([on(240, 67)], 1_000)).toEqual([
    { pitch: 67, start: 240, length: 760, velocity: 0.8 },
  ]);
});

test("playing a pitch again before releasing it ends the first note there", () => {
  const notes = pairRecordedNotes([on(0, 60), on(480, 60), off(600, 60)], 960);
  expect(notes).toEqual([
    { pitch: 60, start: 0, length: 480, velocity: 0.8 },
    { pitch: 60, start: 480, length: 120, velocity: 0.8 },
  ]);
});

test("ticks and lengths come out as whole ticks, and a stab is still a note", () => {
  const notes = pairRecordedNotes([on(100.4, 60), off(100.6, 60)], 960);
  expect(notes).toEqual([{ pitch: 60, start: 100, length: 1, velocity: 0.8 }]);
});

test("quantising snaps starts to the nearest step and leaves lengths alone", () => {
  const notes = [
    { pitch: 60, start: 13, length: 200, velocity: 0.8 },
    { pitch: 64, start: 230, length: 200, velocity: 0.8 },
  ];
  expect(quantiseStarts(notes, 240)).toEqual([
    { pitch: 60, start: 0, length: 200, velocity: 0.8 },
    { pitch: 64, start: 240, length: 200, velocity: 0.8 },
  ]);
});

test("recording into no Clip makes one where recording started", () => {
  const commands = recordingCommands(
    [on(BAR + 240, 60), off(BAR + 480, 60)],
    options({ startTick: BAR, stopTick: 2 * BAR }),
  );
  expect(commands).toEqual([
    {
      type: "addClip",
      trackId: expect.any(String),
      clip: {
        id: "new-clip",
        kind: "pattern",
        start: BAR,
        length: BAR,
        notes: [{ pitch: 60, start: 240, length: 240, velocity: 0.8 }],
      },
    },
  ]);
});

test("recording into a Clip places notes relative to it and keeps what was there", () => {
  const existing = { pitch: 48, start: 0, length: 240, velocity: 0.6 };
  const clip = clipOf([existing], BAR);
  const commands = recordingCommands(
    [on(BAR + 960, 72), off(BAR + 1_200, 72)],
    options({ clip, startTick: BAR, stopTick: 2 * BAR }),
  );
  expect(commands).toEqual([
    {
      type: "setPatternNotes",
      clipId: "clip-1",
      notes: [existing, { pitch: 72, start: 960, length: 240, velocity: 0.8 }],
    },
  ]);
});

test("notes outside the Clip are dropped and a note running past its end is cut", () => {
  const clip = clipOf([], 0);
  const commands = recordingCommands(
    [on(BAR + 10, 60), off(BAR + 20, 60), on(BAR - 120, 64)],
    options({ clip, stopTick: 2 * BAR }),
  );
  expect(commands).toEqual([
    {
      type: "setPatternNotes",
      clipId: "clip-1",
      notes: [{ pitch: 64, start: BAR - 120, length: 120, velocity: 0.8 }],
    },
  ]);
});

test("recording nothing changes nothing", () => {
  expect(recordingCommands([], options())).toEqual([]);
  // Only a note-off, from a key that went down before recording started.
  expect(recordingCommands([off(240, 60)], options())).toEqual([]);
});

test("a new Clip starts on a whole tick, wherever the transport was", () => {
  const commands = recordingCommands([on(500.75, 60), off(700, 60)], options({ startTick: 500.75 }));
  expect(commands[0]).toMatchObject({ clip: { start: 501, notes: [{ start: 0, length: 199 }] } });
});

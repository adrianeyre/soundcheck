/**
 * A Request that builds a song from nothing: "a 4-bar drum beat and a
 * bassline", as the tool calls a model would make for it. The model is a
 * script that reads the ids the tools report, and the Project it leaves is
 * played on the real WASM engine to show it makes sound.
 */
import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import type { EngineCommand } from "../audio/audio-output";
import { EngineSync } from "../project/engine-sync";
import { ProjectHistory } from "../project/history";
import { createProject, type Project } from "../project/model";
import { TICKS_PER_BEAT } from "../project/time";
import { validateProject } from "../project/validate";
import { runRequest, type Conversation, type ModelReply, type StartConversation, type ToolResult } from "./assistant";
import type { ToolCall } from "./tools";

const BAR = TICKS_PER_BEAT * 4;
const EIGHTH = TICKS_PER_BEAT / 2;

/** Each turn of the script sees the results of the one before. */
function scripted(...turns: ((results: readonly ToolResult[]) => ModelReply)[]) {
  const sent: (readonly ToolResult[])[] = [];
  const start: StartConversation = () => {
    let turn = 0;
    const conversation: Conversation = {
      next(results) {
        sent.push(results);
        const reply = turns[turn++];
        if (!reply) throw new Error("the Assistant asked for more turns than the script has");
        return Promise.resolve(reply(results));
      },
    };
    return conversation;
  };
  return { start, sent };
}

function call(id: string, name: string, input: unknown): ToolCall {
  return { id, name, input };
}

/** The id a tool reported back, as a model would read it. */
function reported(results: readonly ToolResult[], callId: string, what: "trackId" | "clipId"): string {
  const content = results.find((result) => result.callId === callId)?.content ?? "";
  const id = new RegExp(`${what} is (\\S+)\\.`).exec(content)?.[1];
  if (!id) throw new Error(`no ${what} in ${JSON.stringify(content)}`);
  return id;
}

/** Four bars of kick on 1 and 3, snare on 2 and 4, and closed hats on the eighths. */
function drumBeat() {
  const notes = [];
  for (let bar = 0; bar < 4; bar++) {
    for (let eighth = 0; eighth < 8; eighth++) {
      const start = bar * BAR + eighth * EIGHTH;
      notes.push({ pitch: 42, start, length: EIGHTH, velocity: 0.6 });
      if (eighth === 0 || eighth === 4) notes.push({ pitch: 36, start, length: EIGHTH });
      if (eighth === 2 || eighth === 6) notes.push({ pitch: 38, start, length: EIGHTH });
    }
  }
  return notes;
}

/** A, C, G, E: one root note a bar, in A minor. */
const BASSLINE = [33, 36, 31, 28].map((pitch, bar) => ({ pitch, start: bar * BAR, length: BAR - EIGHTH }));

let drums = "";
let bass = "";
let bassClip = "";
const { start, sent } = scripted(
  () => ({
    text: "",
    toolCalls: [
      call("t1", "create_track", { name: "Drums", kind: "instrument" }),
      call("t2", "create_track", { name: "Bass", kind: "instrument" }),
      // Setting the tempo, the Instruments and the notes are grouped tools.
      call("g1", "load_tools", { group: "time" }),
      call("g2", "load_tools", { group: "sounds" }),
      call("g3", "load_tools", { group: "notes" }),
    ],
  }),
  (results) => {
    drums = reported(results, "t1", "trackId");
    bass = reported(results, "t2", "trackId");
    return {
      text: "",
      toolCalls: [
        call("t3", "set_tempo", { tempo: 110 }),
        call("i1", "set_instrument", { trackId: drums, instrument: "drumSampler", preset: "Starter Kit" }),
        // A preset the Synth doesn't have: refused, and the model told why.
        call("i2", "set_instrument", { trackId: bass, instrument: "synth", preset: "Wobble Bass" }),
        call("c1", "place_clip", { trackId: drums, start: 0, length: 4 * BAR, notes: drumBeat() }),
        call("c2", "place_clip", { trackId: bass, start: 0, length: 4 * BAR }),
      ],
    };
  },
  (results) => {
    bassClip = reported(results, "c2", "clipId");
    return {
      text: "",
      toolCalls: [
        call("i3", "set_instrument", { trackId: bass, instrument: "synth", preset: "Sub Bass" }),
        // A note above the top of MIDI: refused, and nothing written.
        call("n1", "set_pattern_notes", { clipId: bassClip, notes: [{ pitch: 133, start: 0, length: BAR }] }),
        call("n2", "set_pattern_notes", { clipId: bassClip, notes: BASSLINE }),
      ],
    };
  },
  () => ({ text: "Added a 4-bar drum beat and a Sub Bass line in A minor, at 110 BPM.", toolCalls: [] }),
);

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

test("a drum beat and a bassline, built by tool calls, is a playable Project that undoes in one step", async () => {
  const history = new ProjectHistory(createProject("Demo"));
  const before = history.project;

  const outcome = await runRequest({ history, request: "a 4-bar drum beat and a bassline in A minor", start });

  expect(outcome.error).toBeNull();
  const project = history.project;
  expect(validateProject(project)).toBeNull();
  expect(project.tempo).toBe(110);
  const [drumTrack, bassTrack] = project.tracks;
  if (drumTrack?.kind !== "instrument" || bassTrack?.kind !== "instrument") throw new Error("no Instrument Tracks");
  expect(drumTrack.instrument).toMatchObject({ type: "drumSampler", preset: "Starter Kit" });
  expect(drumTrack.clips[0]!.notes).toHaveLength(48);
  expect(bassTrack.instrument).toMatchObject({ type: "synth", preset: "Sub Bass" });
  expect(bassTrack.clips).toEqual([
    {
      id: bassClip,
      kind: "pattern",
      start: 0,
      length: 4 * BAR,
      notes: BASSLINE.map((note) => ({ ...note, velocity: 0.8 })),
    },
  ]);

  // The two bad calls went back to the model as errors and changed nothing.
  const errors = sent.flat().filter((result) => result.isError);
  expect(errors.map((result) => result.callId)).toEqual(["i2", "n1"]);
  expect(errors[0]!.content).toMatch(/no preset called "Wobble Bass".*Sub Bass.*Nothing was changed\./);
  expect(errors[1]!.content).toMatch(/pitch must be a MIDI note number from 0 to 127.*Nothing was changed\./);
  expect(outcome.changes).toHaveLength(10 - errors.length);

  // Each Track makes sound on its own, and the song plays for all 4 bars.
  expect(peak(render(soloed(project, "neither"), BAR))).toBe(0);
  expect(peak(render(soloed(project, drums), BAR))).toBeGreaterThan(0.05);
  expect(peak(render(soloed(project, bass), BAR))).toBeGreaterThan(0.05);
  const song = render(project, 4 * BAR);
  const lastBar = song.subarray(Math.floor((song.length * 3) / 4));
  expect(peak(lastBar)).toBeGreaterThan(0.05);

  // The whole Request is one undo step.
  expect(history.undoLabel).toBe("Request");
  expect(history.undo()).toBe(true);
  expect(history.project).toBe(before);
  expect(history.canUndo).toBe(false);
});

function soloed(project: Project, trackId: string): Project {
  const copy = structuredClone(project);
  for (const track of copy.tracks) track.mixer.mute = track.id !== trackId;
  return copy;
}

function peak(samples: Float32Array): number {
  return samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
}

/** `project` rendered offline on the real engine, from the top to `endTick`: the left channel. */
function render(project: Project, endTick: number): Float32Array {
  const engine = new Engine(48_000);
  try {
    for (const command of new EngineSync().update(project)) send(engine, command);
    return engine.render_range(0, endTick).filter((_: number, index: number) => index % 2 === 0);
  } finally {
    engine.free();
  }
}

/** The commands a Project of Synths and Drum Samplers needs, as the UI sends them. */
function send(engine: Engine, command: EngineCommand) {
  switch (command.type) {
    case "setTrackCount":
      return engine.set_track_count(command.count);
    case "setTrackNotes":
      return engine.set_track_notes(command.track, new Float64Array(command.notes));
    case "setSynthSettings":
      return engine.set_track_synth(command.track, new Float32Array(command.settings));
    case "setTempo":
      return engine.set_tempo(command.bpm);
    case "setTimeSignature":
      return engine.set_time_signature(command.beatsPerBar, command.beatUnit);
    case "setMasterVolume":
      return engine.set_master_volume(command.volume);
    case "setTrackMixer":
      return engine.set_track_mixer(command.track, command.volume, command.pan, command.mute, command.solo);
    case "setTrackInstrument":
      return engine.set_track_instrument(command.track, command.instrument, command.pads ?? undefined);
    case "setPad":
      return engine.set_track_pad(
        command.track,
        command.pad,
        command.note,
        command.volume,
        command.pan,
        command.pitch,
        command.chokeGroup,
      );
    default:
      throw new Error(`this test doesn't send ${command.type}`);
  }
}

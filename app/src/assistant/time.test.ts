/**
 * The Tempo Change story of the v3 PRD, as the tool calls a model would make
 * for it: "slow down to 90 for the bridge, then back to 120" is one Request
 * that adds two Tempo Changes at the bridge's bars, which the Audio Engine
 * plays and one undo takes back; and a time signature off a bar line is
 * refused, changing nothing.
 */
import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import { applyEngineCommand } from "../audio/apply-engine-command";
import type { EngineCommand } from "../audio/audio-output";
import { EngineSync } from "../project/engine-sync";
import { ProjectHistory } from "../project/history";
import { createInstrumentTrack, createProject, type Project } from "../project/model";
import { secondsAt, tempoMapOf, TICKS_PER_BEAT } from "../project/time";
import { runRequest, type Conversation, type ModelReply, type StartConversation, type ToolResult } from "./assistant";
import { projectSummary } from "./read";
import type { ToolCall } from "./tools";

const BAR = TICKS_PER_BEAT * 4;
const RATE = 48_000;

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

/** Each turn of the script sees the results of the one before. */
function scripted(...turns: ((results: readonly ToolResult[]) => ModelReply)[]): StartConversation {
  return () => {
    let turn = 0;
    const conversation: Conversation = {
      next(results) {
        const reply = turns[turn++];
        if (!reply) throw new Error("the Assistant asked for more turns than the script has");
        return Promise.resolve(reply(results));
      },
    };
    return conversation;
  };
}

function call(id: string, name: string, input: unknown): ToolCall {
  return { id, name, input };
}

function succeeded(results: readonly ToolResult[]): void {
  const failed = results.filter((result) => result.isError);
  if (failed.length > 0) throw new Error(`a call failed: ${failed.map((result) => result.content).join(" ")}`);
}

/**
 * Sixteen bars at 120 in 4/4, named Verse, Bridge (bars 9 to 12) and
 * Chorus, with a short note at the top of the chorus.
 */
function song(): Project {
  const project = createProject("Bridge");
  const keys = createInstrumentTrack("Keys", "keys");
  keys.clips.push({ id: "chorus-note", kind: "pattern", start: 12 * BAR, length: BAR, notes: [{ pitch: 60, start: 0, length: 480, velocity: 1 }] });
  project.tracks.push(keys);
  project.sections.push(
    { id: "verse", name: "Verse", startBar: 1, bars: 8 },
    { id: "bridge", name: "Bridge", startBar: 9, bars: 4 },
    { id: "chorus", name: "Chorus", startBar: 13, bars: 4 },
  );
  return project;
}

/** When the first sound comes, in seconds, from the real engine driven by the commands the UI sends. */
function firstSound(project: Project, bars: number): number {
  const engine = new Engine(RATE);
  try {
    for (const command of new EngineSync().update(project)) applyEngineCommand(engine, command as EngineCommand);
    const samples = engine.render_range(0, bars * BAR);
    // Interleaved stereo: two samples a frame.
    return samples.findIndex((sample) => Math.abs(sample) > 1e-4) / 2 / RATE;
  } finally {
    engine.free();
  }
}

test("“slow down to 90 for the bridge, then back to 120” adds two Tempo Changes at the bridge's bars, plays so, and undoes in one step", async () => {
  const history = new ProjectHistory(song());
  const before = history.project;
  // The bridge's bars, as the summary lists them.
  const bridge = projectSummary(before).sections!.find((section) => section.name === "Bridge")!;
  const start = scripted(
    () => ({ text: "", toolCalls: [call("g1", "load_tools", { group: "time" })] }),
    (results) => {
      succeeded(results);
      return {
        text: "",
        toolCalls: [
          call("t1", "add_tempo_change", { bar: bridge.startBar, tempo: 90 }),
          call("t2", "add_tempo_change", { bar: bridge.startBar + bridge.bars, tempo: before.tempo }),
        ],
      };
    },
    (results) => {
      succeeded(results);
      return { text: "The bridge now drops to 90 BPM and the chorus comes back at 120.", toolCalls: [] };
    },
  );

  const outcome = await runRequest({ history, request: "slow down to 90 for the bridge, then back to 120", start });
  expect(outcome.error).toBeNull();
  expect(outcome.changes).toEqual(["Changed the tempo to 90 BPM at 9.1.000", "Changed the tempo to 120 BPM at 13.1.000"]);
  const after = history.project;
  expect(after.tempo).toBe(120);
  expect(after.tempoChanges.map(({ tick, tempo, timeSignature }) => ({ tick, tempo, timeSignature }))).toEqual([
    { tick: 8 * BAR, tempo: 90, timeSignature: null },
    { tick: 12 * BAR, tempo: 120, timeSignature: null },
  ]);
  // The Sections and Clips keep their bars.
  expect(after.sections).toEqual(before.sections);
  expect(after.tracks).toEqual(before.tracks);

  // Eight bars at 120 are 16 s, and the bridge's sixteen beats at 90 are
  // 10.667 s more, so the chorus's note comes 2.667 s later than it did.
  const chorus = 12 * BAR;
  expect(secondsAt(tempoMapOf(before), chorus)).toBe(24);
  expect(secondsAt(tempoMapOf(after), chorus)).toBeCloseTo(16 + 16 * (60 / 90), 6);
  expect(firstSound(before, 13)).toBeCloseTo(24, 2);
  expect(firstSound(after, 13)).toBeCloseTo(16 + 16 * (60 / 90), 2);

  expect(history.undoLabel).toBe("Request");
  expect(history.undo()).toBe(true);
  expect(history.project).toEqual(before);
  expect(history.canUndo).toBe(false);
});

test("a time signature off a bar line is refused, and nothing changes", async () => {
  const history = new ProjectHistory(song());
  const before = history.project;
  let refusal = "";
  const start = scripted(
    () => ({ text: "", toolCalls: [call("g1", "load_tools", { group: "time" })] }),
    () => ({ text: "", toolCalls: [call("s1", "set_time_signature", { bar: 9.5, beatsPerBar: 3, beatUnit: 4 })] }),
    (results) => {
      refusal = results[0]!.content;
      expect(results[0]!.isError).toBe(true);
      return { text: "A time signature can only change at a bar line.", toolCalls: [] };
    },
  );

  const outcome = await runRequest({ history, request: "make it 3/4 from half way through bar 9", start });
  expect(refusal).toBe(
    "A time signature can only change at a bar line, and bar 9.5 is part way through bar 9: give a whole bar. Nothing was changed.",
  );
  expect(outcome.changes).toEqual([]);
  expect(history.project).toBe(before);
  expect(history.canUndo).toBe(false);
});

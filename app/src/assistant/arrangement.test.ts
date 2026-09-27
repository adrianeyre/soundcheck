/**
 * The arrangement stories of the v3 PRD, as the tool calls a model would
 * make for them: "repeat the chorus", "swap the second verse and the
 * bridge" and "add two bars before the drop" each move every Track's Clips,
 * the Automation and the Tempo Changes with their Sections, and undo in one
 * step; "build up into the chorus" is notes, Automation and an Effect in one
 * Request. The Audio Engine plays a duplicated Section as it plays the
 * original.
 */
import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import { applyEngineCommand } from "../audio/apply-engine-command";
import type { EngineCommand } from "../audio/audio-output";
import { valueAt } from "../project/arrangement";
import { EngineSync } from "../project/engine-sync";
import { ProjectHistory } from "../project/history";
import { createDrumTrack, createInstrumentTrack, createProject, type PatternClip, type Project } from "../project/model";
import { barStart, tempoMapOf, TICKS_PER_BEAT } from "../project/time";
import { runRequest, type Conversation, type ModelReply, type StartConversation, type ToolResult } from "./assistant";
import { projectSummary } from "./read";
import type { ToolCall } from "./tools";

const BEAT = TICKS_PER_BEAT;
const BAR = BEAT * 4;
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

/** A one-bar Clip of short notes at `pitch`, one a beat, from `bar`. */
function riff(id: string, bar: number, pitch: number): PatternClip {
  return {
    id,
    kind: "pattern",
    start: (bar - 1) * BAR,
    length: BAR,
    notes: [0, 1, 2, 3].map((beat) => ({ pitch: pitch + beat, start: beat * BEAT, length: BEAT / 4, velocity: 0.8 })),
  };
}

/**
 * Twenty bars at 120 in 4/4: Verse, Chorus, Verse, a Bridge at 90 and the
 * Drop back at 120, four bars each, with a Keys riff at the top of each and
 * the Keys dipping to 0.2 for the bridge and rising back through it.
 */
function song(): Project {
  const project = createProject("Arranged");
  const keys = createInstrumentTrack("Keys", "keys");
  keys.clips.push(riff("verse-riff", 1, 60), riff("chorus-riff", 5, 67), riff("verse-2-riff", 9, 62), riff("bridge-riff", 13, 55));
  keys.automation.push({
    setting: "volume",
    breakpoints: [
      { tick: 0, value: 1, hold: true },
      { tick: 12 * BAR, value: 0.2, hold: false },
      { tick: 16 * BAR, value: 1, hold: false },
    ],
  });
  const bass = createInstrumentTrack("Bass", "bass");
  bass.clips.push(riff("drop-bass", 17, 36));
  project.tracks.push(keys, bass);
  project.tempoChanges.push(
    { id: "slow", tick: 12 * BAR, tempo: 90, timeSignature: null },
    { id: "back", tick: 16 * BAR, tempo: 120, timeSignature: null },
  );
  project.sections.push(
    { id: "verse-1", name: "Verse", startBar: 1, bars: 4 },
    { id: "chorus", name: "Chorus", startBar: 5, bars: 4 },
    { id: "verse-2", name: "Verse", startBar: 9, bars: 4 },
    { id: "bridge", name: "Bridge", startBar: 13, bars: 4 },
    { id: "drop", name: "Drop", startBar: 17, bars: 4 },
  );
  return project;
}

/** Each Section as its name and first bar. */
function layout(project: Project): [string, number][] {
  return project.sections.map((section) => [section.name, section.startBar]);
}

/** Each Clip on a Track as its first note's pitch and the bar it starts on. */
function riffs(project: Project, trackId: string): [number, number][] {
  const map = tempoMapOf(project);
  const track = project.tracks.find((candidate) => candidate.id === trackId)!;
  return track.clips.map((clip) => {
    const bar = [...Array(40).keys()].find((index) => barStart(map, index + 1) === clip.start);
    return [(clip as PatternClip).notes[0]!.pitch, bar === undefined ? NaN : bar + 1];
  });
}

/** The Keys volume at the top of each bar, from 1 to `bars`. */
function keysVolume(project: Project, bars: number): number[] {
  const map = tempoMapOf(project);
  const lane = project.tracks[0]!.automation.find((automation) => automation.setting === "volume")!;
  return [...Array(bars).keys()].map((index) => Math.round(valueAt(lane.breakpoints, barStart(map, index + 1)) * 1000) / 1000);
}

/** The tempo of each bar, from 1 to `bars`. */
function tempos(project: Project, bars: number): number[] {
  const map = tempoMapOf(project);
  return [...Array(bars).keys()].map((index) => {
    const tick = barStart(map, index + 1);
    return map.segments.findLast((segment) => segment.tick <= tick)!.tempo;
  });
}

/** Runs one scripted Request to the end, checking it went through and undoes in one step. */
async function request(history: ProjectHistory, text: string, calls: (before: Project) => ToolCall[], group = "arrangement") {
  const start = scripted(
    () => ({ text: "", toolCalls: [call("g1", "load_tools", { group })] }),
    (results) => {
      succeeded(results);
      return { text: "", toolCalls: calls(history.project) };
    },
    (results) => {
      succeeded(results);
      return { text: "Done.", toolCalls: [] };
    },
  );
  const outcome = await runRequest({ history, request: text, start });
  expect(outcome.error).toBeNull();
  return outcome;
}

function undoesInOneStep(history: ProjectHistory, before: Project): void {
  expect(history.undoLabel).toBe("Request");
  expect(history.undo()).toBe(true);
  expect(history.project).toEqual(before);
  expect(history.canUndo).toBe(false);
}

test("“repeat the chorus” copies it, with its Clips, after itself, and moves everything later on by its bars", async () => {
  const history = new ProjectHistory(song());
  const before = history.project;
  const outcome = await request(history, "repeat the chorus", () => [call("d1", "duplicate_section", { section: "Chorus" })]);
  expect(outcome.changes).toEqual(["Duplicated the Section “Chorus” (bars 5–8) to bars 9–12"]);

  const after = history.project;
  expect(layout(after)).toEqual([
    ["Verse", 1],
    ["Chorus", 5],
    ["Chorus", 9],
    ["Verse", 13],
    ["Bridge", 17],
    ["Drop", 21],
  ]);
  expect(riffs(after, "keys")).toEqual([
    [60, 1],
    [67, 5],
    [67, 9],
    [62, 13],
    [55, 17],
  ]);
  expect(riffs(after, "bass")).toEqual([[36, 21]]);
  // The copy is a new Clip with the chorus's notes.
  const [chorus, copy] = after.tracks[0]!.clips.slice(1, 3) as PatternClip[];
  expect(chorus!.id).toBe("chorus-riff");
  expect(copy!.id).not.toBe("chorus-riff");
  expect(copy!.notes).toEqual(chorus!.notes);
  // The bridge's tempo and its dip in volume come four bars later.
  expect(after.tempoChanges.map(({ id, tick, tempo }) => ({ id, tick, tempo }))).toEqual([
    { id: "slow", tick: 16 * BAR, tempo: 90 },
    { id: "back", tick: 20 * BAR, tempo: 120 },
  ]);
  expect(keysVolume(after, 22)).toEqual([...Array(16).fill(1), 0.2, 0.4, 0.6, 0.8, 1, 1]);

  undoesInOneStep(history, before);
});

test("“swap the second verse and the bridge” moves the bridge, with its tempo and Automation, to the verse's bars", async () => {
  const history = new ProjectHistory(song());
  const before = history.project;
  // Two Sections are called Verse, so the model takes the second by its id, as the summary lists them.
  const sections = projectSummary(before).sections!;
  const verse = sections.filter((section) => section.name === "Verse")[1]!;
  const outcome = await request(history, "swap the second verse and the bridge", () => [
    call("m1", "move_section", { section: "Bridge", to: verse.startBar }),
  ]);
  expect(outcome.changes).toEqual(["Moved the Section “Bridge” (bars 13–16) to bars 9–12"]);

  const after = history.project;
  expect(layout(after)).toEqual([
    ["Verse", 1],
    ["Chorus", 5],
    ["Bridge", 9],
    ["Verse", 13],
    ["Drop", 17],
  ]);
  expect(after.sections.map((section) => section.id)).toEqual(["verse-1", "chorus", "bridge", "verse-2", "drop"]);
  expect(riffs(after, "keys")).toEqual([
    [60, 1],
    [67, 5],
    [55, 9],
    [62, 13],
  ]);
  expect(riffs(after, "bass")).toEqual([[36, 17]]);
  // The bridge is at 90 wherever it is, and the verse after it back at 120.
  expect(tempos(after, 20)).toEqual([...Array(8).fill(120), 90, 90, 90, 90, ...Array(8).fill(120)]);
  expect(after.tempoChanges.map(({ tick, tempo }) => ({ tick, tempo }))).toEqual([
    { tick: 8 * BAR, tempo: 90 },
    { tick: 12 * BAR, tempo: 120 },
  ]);
  expect(keysVolume(after, 20)).toEqual([...Array(8).fill(1), 0.2, 0.4, 0.6, 0.8, ...Array(8).fill(1)]);

  undoesInOneStep(history, before);
});

test("“add two bars before the drop” makes room at its bar, and the bars take the bridge's tempo", async () => {
  const history = new ProjectHistory(song());
  const before = history.project;
  const drop = projectSummary(before).sections!.find((section) => section.name === "Drop")!;
  const outcome = await request(history, "add two bars before the drop", () => [call("i1", "insert_bars", { at: drop.startBar, count: 2 })]);
  expect(outcome.changes).toEqual(["Inserted 2 bars before bar 17"]);

  const after = history.project;
  expect(layout(after)).toEqual([
    ["Verse", 1],
    ["Chorus", 5],
    ["Verse", 9],
    ["Bridge", 13],
    ["Drop", 19],
  ]);
  expect(riffs(after, "keys")).toEqual(riffs(before, "keys"));
  expect(riffs(after, "bass")).toEqual([[36, 19]]);
  // The new bars carry on at the bridge's 90, and the drop still comes back to 120.
  expect(tempos(after, 20)).toEqual([...Array(12).fill(120), 90, 90, 90, 90, 90, 90, 120, 120]);
  expect(after.tempoChanges.map(({ id, tick, tempo }) => ({ id, tick, tempo }))).toEqual([
    { id: "slow", tick: 12 * BAR, tempo: 90 },
    { id: "back", tick: 18 * BAR, tempo: 120 },
  ]);
  // The Keys hold the volume they had risen to.
  expect(keysVolume(after, 20)).toEqual([...Array(12).fill(1), 0.2, 0.4, 0.6, 0.8, 1, 1, 1, 1]);

  undoesInOneStep(history, before);
});

test("a scripted “build up into the chorus” adds notes, Automation and an Effect as one undo step", async () => {
  const project = song();
  const drums = createDrumTrack("Drums", "drums");
  drums.clips.push({ id: "build", kind: "pattern", start: 3 * BAR, length: BAR, notes: [] });
  project.tracks.push(drums);
  const history = new ProjectHistory(project);
  const before = history.project;
  const chorus = projectSummary(before).sections!.find((section) => section.name === "Chorus")!;
  const snare = 38;
  let effectId = "";
  const start = scripted(
    () => ({
      text: "",
      toolCalls: [
        call("g1", "load_tools", { group: "notes" }),
        call("g2", "load_tools", { group: "automation" }),
        call("g3", "load_tools", { group: "sounds" }),
      ],
    }),
    (results) => {
      succeeded(results);
      return { text: "", toolCalls: [call("e1", "add_effect", { channel: "drums", effect: "reverb", settings: { mix: 0 } })] };
    },
    (results) => {
      succeeded(results);
      effectId = /effectId is ([\w-]+)/.exec(results[0]!.content)![1]!;
      // A snare roll in the bar before the chorus, eighths then sixteenths, getting louder.
      const hits = [0, 480, 960, 1440, 1920, 2160, 2400, 2640, 2880, 3120, 3360, 3600];
      return {
        text: "",
        toolCalls: [
          call("n1", "add_notes", {
            clipId: "build",
            notes: hits.map((tick, index) => ({ pitch: snare, start: tick, length: 120, velocity: 0.5 + index / 24 })),
          }),
          call("a1", "set_automation", {
            channel: "drums",
            setting: `effect:${effectId}:mix`,
            start: chorus.start - BAR,
            end: chorus.start,
            breakpoints: [
              { tick: chorus.start - BAR, value: 0 },
              { tick: chorus.start - 1, value: 0.6, hold: true },
              { tick: chorus.start, value: 0 },
            ],
          }),
        ],
      };
    },
    (results) => {
      succeeded(results);
      return { text: "A snare roll with rising reverb now builds into the chorus.", toolCalls: [] };
    },
  );

  const outcome = await runRequest({ history, request: "build up into the chorus", start });
  expect(outcome.error).toBeNull();
  expect(outcome.changes).toHaveLength(3);

  const after = history.project;
  const track = after.tracks.find((candidate) => candidate.id === "drums")!;
  expect((track.clips[0] as PatternClip).notes).toHaveLength(12);
  expect(track.insertChain.map((effect) => [effect.id, effect.type])).toEqual([[effectId, "reverb"]]);
  expect(track.automation).toEqual([
    {
      setting: `effect:${effectId}:mix`,
      breakpoints: [
        { tick: 3 * BAR, value: 0, hold: false },
        { tick: 4 * BAR - 1, value: 0.6, hold: true },
        { tick: 4 * BAR, value: 0, hold: false },
      ],
    },
  ]);
  // Nothing outside the drums changed.
  expect(after.tracks.slice(0, 2)).toEqual(before.tracks.slice(0, 2));

  undoesInOneStep(history, before);
});

/** The real engine's samples, interleaved stereo, over `bars` bars of `project`. */
function render(project: Project, bars: number): Float32Array {
  const engine = new Engine(RATE);
  try {
    for (const command of new EngineSync().update(project)) applyEngineCommand(engine, command as EngineCommand);
    return engine.render_range(0, barStart(tempoMapOf(project), bars + 1));
  } finally {
    engine.free();
  }
}

/** Where `bar` starts in interleaved stereo samples: at 120 a bar is 2 s. */
function frames(bar: number): number {
  return (bar - 1) * 2 * RATE * 2;
}

test("a duplicated Section sounds the same as the original", async () => {
  const history = new ProjectHistory(song());
  await request(history, "repeat the chorus", () => [call("d1", "duplicate_section", { section: "chorus" })]);
  const samples = render(history.project, 12);
  // The chorus is bars 5 to 8, its copy 9 to 12.
  const original = samples.slice(frames(5), frames(9));
  const copy = samples.slice(frames(9), frames(13));
  expect(original.some((sample) => Math.abs(sample) > 1e-3)).toBe(true);
  expect(copy.length).toBe(original.length);
  let largest = 0;
  for (let index = 0; index < copy.length; index++) largest = Math.max(largest, Math.abs(copy[index]! - original[index]!));
  expect(largest).toBeLessThan(1e-4);
});

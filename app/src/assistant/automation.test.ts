/**
 * The Automation story of the v3 PRD, as the tool calls a model would make
 * for it: "fade the pad in over the first four bars" and "open the filter
 * through the build-up", each one Request that draws breakpoints the Audio
 * Engine plays and that one undo takes back.
 */
import { readFileSync } from "node:fs";

import { Engine, initSync } from "@engine";
import { beforeAll, expect, test } from "vitest";

import { applyEngineCommand } from "../audio/apply-engine-command";
import type { EngineCommand } from "../audio/audio-output";
import { EngineSync } from "../project/engine-sync";
import { ProjectHistory } from "../project/history";
import { createDrumTrack, createInstrumentTrack, createProject, type InstrumentTrack, type Project } from "../project/model";
import { sectionTicks } from "../project/sections";
import { tempoMapOf, TICKS_PER_BEAT } from "../project/time";
import { runRequest, type Conversation, type ModelReply, type StartConversation, type ToolResult } from "./assistant";
import type { ToolCall } from "./tools";

const BAR = TICKS_PER_BEAT * 4;
/** At 120 bpm and 48 kHz a bar is 96 000 frames, two samples each. */
const BAR_SAMPLES = 96_000 * 2;

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

/** A Synth Track holding one note for `bars` bars. */
function heldNote(name: string, id: string, bars: number): InstrumentTrack {
  const track = createInstrumentTrack(name, id);
  track.clips.push({ id: `${id}-1`, kind: "pattern", start: 0, length: bars * BAR, notes: [{ pitch: 48, start: 0, length: bars * BAR, velocity: 1 }] });
  return track;
}

/** `bars` bars of `song` from the real engine, driven by the commands the UI sends. */
function render(song: Project, bars: number): Float32Array {
  const engine = new Engine(48_000);
  try {
    for (const command of new EngineSync().update(song)) applyEngineCommand(engine, command as EngineCommand);
    return engine.render_range(0, bars * BAR);
  } finally {
    engine.free();
  }
}

/** A tenth of a bar of samples from `bar` on, counting from 0. */
function window(samples: Float32Array, bar: number): Float32Array {
  const start = Math.round(bar * BAR_SAMPLES);
  return samples.subarray(start, start + BAR_SAMPLES / 10);
}

function rms(samples: Float32Array): number {
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
}

/**
 * How bright a stretch of sound is: the energy of its change from one frame
 * to the next against its energy, which a higher cutoff raises.
 */
function brightness(samples: Float32Array): number {
  let change = 0;
  let energy = 0;
  // Interleaved stereo: the same channel's previous sample is two back.
  for (let index = 2; index < samples.length; index++) {
    change += (samples[index]! - samples[index - 2]!) ** 2;
    energy += samples[index]! ** 2;
  }
  return change / energy;
}

test("“fade the pad in over the first four bars” ramps its volume up to where it was, plays so, and undoes in one step", async () => {
  const song = createProject("Fade");
  const pad = heldNote("Pad", "pad", 6);
  pad.mixer.volume = 0.8;
  song.tracks.push(pad);
  const history = new ProjectHistory(song);
  const before = history.project;
  const start = scripted(
    () => ({
      text: "",
      toolCalls: [call("g1", "load_tools", { group: "automation" }), call("r1", "read_channel", { channel: "pad" })],
    }),
    (results) => {
      succeeded(results);
      // The fade ends where the Pad's fader is.
      const volume = Number(/"volume":([\d.]+)/.exec(results.find((result) => result.callId === "r1")!.content)![1]);
      return {
        text: "",
        toolCalls: [
          call("a1", "set_automation", {
            channel: "pad",
            setting: "volume",
            start: 0,
            end: 4 * BAR,
            breakpoints: [
              { tick: 0, value: 0 },
              { tick: 4 * BAR, value: volume },
            ],
          }),
        ],
      };
    },
    (results) => {
      succeeded(results);
      return { text: "The pad now fades in over the first four bars.", toolCalls: [] };
    },
  );

  const outcome = await runRequest({ history, request: "fade the pad in over the first four bars", start });
  expect(outcome.error).toBeNull();
  expect(outcome.changes).toEqual(["Automated “Pad”'s Volume from 1.1.000 to 5.1.000"]);
  const after = history.project;
  expect(after.tracks[0]!.automation).toEqual([
    {
      setting: "volume",
      breakpoints: [
        { tick: 0, value: 0, hold: false },
        { tick: 4 * BAR, value: 0.8, hold: false },
      ],
    },
  ]);

  // Silent at the top, a quarter, half and three quarters of the way up
  // over the four bars, then at the fader, as it was without the fade.
  const faded = render(after, 5);
  const fixed = render(before, 5);
  expect(rms(faded.subarray(0, 20))).toBeLessThan(1e-6);
  for (const bar of [1, 2, 3]) {
    expect(rms(window(faded, bar)) / rms(window(fixed, bar))).toBeCloseTo(bar / 4, 1);
  }
  for (let index = 4 * BAR_SAMPLES; index < 5 * BAR_SAMPLES; index += 101) {
    expect(faded[index]).toBeCloseTo(fixed[index]!, 6);
  }

  expect(history.undoLabel).toBe("Request");
  expect(history.undo()).toBe(true);
  expect(history.project).toEqual(before);
  expect(history.canUndo).toBe(false);
});

test("“open the filter through the build-up” sweeps the lead's cutoff over the Section, plays so, and undoes in one step", async () => {
  // A dark lead, held through a verse, the build-up and the drop.
  const song = createProject("Build");
  const lead = heldNote("Lead", "lead", 6);
  if (lead.instrument.type !== "synth") throw new Error("the lead should play the Synth");
  lead.instrument.settings.cutoffHz = 300;
  song.tracks.push(lead);
  song.sections.push(
    { id: "verse", name: "Verse", startBar: 1, bars: 2 },
    { id: "build", name: "Build-up", startBar: 3, bars: 2 },
    { id: "drop", name: "Drop", startBar: 5, bars: 2 },
  );
  const history = new ProjectHistory(song);
  const before = history.project;
  // The Section's ticks, as the summary lists them.
  const build = sectionTicks(song.sections[1]!, tempoMapOf(song));
  const start = scripted(
    () => ({
      text: "",
      toolCalls: [call("g1", "load_tools", { group: "automation" }), call("r1", "read_channel", { channel: "lead" })],
    }),
    (results) => {
      succeeded(results);
      // From the cutoff it has now, so the verse stays as it was, to wide open at the drop.
      const cutoff = Number(/"cutoffHz":([\d.]+)/.exec(results.find((result) => result.callId === "r1")!.content)![1]);
      return {
        text: "",
        toolCalls: [
          call("a1", "set_automation", {
            channel: "lead",
            setting: "instrument:cutoffHz",
            start: build.start,
            end: build.end,
            breakpoints: [
              { tick: build.start, value: cutoff },
              { tick: build.end, value: 12_000 },
            ],
          }),
        ],
      };
    },
    (results) => {
      succeeded(results);
      return { text: "The lead's filter now opens through the build-up.", toolCalls: [] };
    },
  );

  const outcome = await runRequest({ history, request: "open the filter through the build-up", start });
  expect(outcome.error).toBeNull();
  expect(outcome.changes).toEqual(["Automated “Lead”'s Synth: Cutoff from 3.1.000 to 5.1.000"]);
  const after = history.project;
  expect(after.tracks[0]!.automation).toEqual([
    {
      setting: "instrument:cutoffHz",
      breakpoints: [
        { tick: 2 * BAR, value: 300, hold: false },
        { tick: 4 * BAR, value: 12_000, hold: false },
      ],
    },
  ]);

  const swept = render(after, 6);
  const dark = render(before, 6);
  const open = (() => {
    const opened = structuredClone(before);
    const opener = opened.tracks[0]!;
    if (opener.kind === "instrument" && opener.instrument.type === "synth") opener.instrument.settings.cutoffHz = 12_000;
    return render(opened, 6);
  })();
  // The verse is as it was.
  expect(Array.from(swept.subarray(0, 2 * BAR_SAMPLES))).toEqual(Array.from(dark.subarray(0, 2 * BAR_SAMPLES)));
  // The build-up gets brighter all the way through.
  const through = [2, 2.5, 3, 3.5, 3.9].map((bar) => brightness(window(swept, bar)));
  for (let index = 1; index < through.length; index++) expect(through[index]!).toBeGreaterThan(through[index - 1]!);
  expect(through.at(-1)!).toBeGreaterThan(through[0]! * 4);
  // And the drop is as bright as the filter left wide open.
  const drop = brightness(window(swept, 5));
  expect(drop / brightness(window(open, 5))).toBeCloseTo(1, 1);

  expect(history.undo()).toBe(true);
  expect(history.project).toEqual(before);
  expect(history.canUndo).toBe(false);
});

test("“fade the kick out through bar 2” ramps its Pad's volume to 0, leaves the hats, plays so, and undoes in one step", async () => {
  // The Starter Kit's kick on every beat and its closed hat on every
  // off-beat, for three bars.
  const song = createProject("Drums");
  const drums = createDrumTrack("Drums", "drums");
  const hits = Array.from({ length: 12 }, (_, beat) => [
    { pitch: 36, start: beat * TICKS_PER_BEAT, length: TICKS_PER_BEAT / 4, velocity: 1 },
    { pitch: 42, start: beat * TICKS_PER_BEAT + TICKS_PER_BEAT / 2, length: TICKS_PER_BEAT / 4, velocity: 1 },
  ]).flat();
  drums.clips.push({ id: "beat", kind: "pattern", start: 0, length: 3 * BAR, notes: hits });
  song.tracks.push(drums);
  const history = new ProjectHistory(song);
  const before = history.project;
  const start = scripted(
    () => ({ text: "", toolCalls: [call("g1", "load_tools", { group: "automation" })] }),
    (results) => {
      succeeded(results);
      return {
        text: "",
        toolCalls: [
          call("a1", "set_automation", {
            channel: "drums",
            setting: "instrument:pad36.volume",
            start: BAR,
            end: 2 * BAR,
            breakpoints: [
              { tick: BAR, value: 1 },
              { tick: 2 * BAR, value: 0 },
            ],
          }),
        ],
      };
    },
    (results) => {
      succeeded(results);
      return { text: "The kick now fades out through bar 2.", toolCalls: [] };
    },
  );

  const outcome = await runRequest({ history, request: "fade the kick out through bar 2", start });
  expect(outcome.error).toBeNull();
  expect(outcome.changes).toEqual(["Automated “Drums”'s Kick: Volume from 2.1.000 to 3.1.000"]);
  const after = history.project;

  const faded = render(after, 3);
  const fixed = render(before, 3);
  const hatsOnly = (() => {
    const edited = structuredClone(before);
    const track = edited.tracks[0]!;
    if (track.kind === "instrument" && track.instrument.type === "drumSampler") track.instrument.pads[0]!.volume = 0;
    return render(edited, 3);
  })();
  // Bar 1 is as it was, and bar 3 is the hats alone, sample for sample.
  expect(Array.from(faded.subarray(0, BAR_SAMPLES))).toEqual(Array.from(fixed.subarray(0, BAR_SAMPLES)));
  expect(Array.from(faded.subarray(2 * BAR_SAMPLES))).toEqual(Array.from(hatsOnly.subarray(2 * BAR_SAMPLES)));
  expect(rms(fixed.subarray(2 * BAR_SAMPLES))).toBeGreaterThan(rms(hatsOnly.subarray(2 * BAR_SAMPLES)) * 1.5);
  // Half way through bar 2 the kick hit there is at about half its level.
  const hit = (samples: Float32Array, at: number) => rms(samples.subarray(at, at + 4_000));
  const middle = 1.5 * BAR_SAMPLES;
  expect(hit(faded, middle) / hit(fixed, middle)).toBeGreaterThan(0.3);
  expect(hit(faded, middle) / hit(fixed, middle)).toBeLessThan(0.7);

  expect(history.undo()).toBe(true);
  expect(history.project).toEqual(before);
  expect(history.canUndo).toBe(false);
});

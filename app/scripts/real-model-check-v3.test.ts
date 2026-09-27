/**
 * The v3 scenarios' checks (#107), on the Projects the Assistant's own tools
 * make when a scripted model does each story as asked, and on a Request
 * that does nothing. No model is called.
 */
import { readFileSync } from "node:fs";

import { initSync } from "@engine";
import { beforeAll, describe, expect, it } from "vitest";

import { runRequest, type Conversation, type FinishedRequest, type ModelReply, type StartConversation, type ToolResult } from "../src/assistant/assistant";
import { listenWith } from "../src/assistant/listen";
import type { ToolCall } from "../src/assistant/tools";
import { wasmAudioAnalyser } from "../src/audio/audio-analyser";
import { songEndTick } from "../src/export/mix-exporter";
import { ProjectHistory } from "../src/project/history";
import type { Project } from "../src/project/model";
import { TICKS_PER_BEAT } from "../src/project/time";
import { validateProject } from "../src/project/validate";
import {
  checkScenario,
  SAVED_KIT,
  scenarioWorld,
  songNotes,
  TRACKS,
  V3_SCENARIOS,
  V3_WAIVERS,
  v3Song,
  VOCAL,
  type Sent,
  type V3Scenario,
  type V3ScenarioName,
} from "./real-model-check-v3";
import { SCENARIOS } from "./real-model-check-api";

const BEAT = TICKS_PER_BEAT;
const BAR = 4 * BEAT;
const analyse = wasmAudioAnalyser(() => Promise.resolve());
const listen = listenWith(analyse);

beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

/** Each turn's calls, made from the Project as the turns before left it; then a last reply with none. */
function scripted(history: ProjectHistory, ...turns: ((project: Project) => ToolCall[])[]): StartConversation {
  return () => {
    let turn = 0;
    const conversation: Conversation = {
      next(): Promise<ModelReply> {
        const calls = turns[turn++];
        return Promise.resolve(calls ? { text: "", toolCalls: calls(history.project) } : { text: "Done.", toolCalls: [] });
      },
    };
    return conversation;
  };
}

let ids = 0;
function call(name: string, input: unknown): ToolCall {
  return { id: `c${++ids}`, name, input };
}

function loadTools(...groups: string[]): ToolCall[] {
  return groups.map((group) => call("load_tools", { group }));
}

/** Records every call and its result, as the real-model check does. */
function recorded(start: StartConversation, sent: Sent & { toolCalls: ToolCall[]; toolResults: ToolResult[] }): StartConversation {
  return (...args) => {
    const conversation = start(...args);
    return {
      async next(results, turnsLeft, tools) {
        sent.toolResults.push(...results);
        const reply = await conversation.next(results, turnsLeft, tools);
        sent.toolCalls.push(...reply.toolCalls);
        return reply;
      },
    };
  };
}

/** Runs a scenario's Requests with one script each, and returns its checks. */
async function run(name: V3ScenarioName, ...scripts: ((project: Project) => ToolCall[])[][]) {
  const scenario: V3Scenario = V3_SCENARIOS[name];
  const world = await scenarioWorld(scenario, analyse);
  const history = new ProjectHistory(scenario.song());
  const projects = [history.project];
  const sent: Sent[] = [];
  const finished: FinishedRequest[] = [];
  for (const [index, request] of scenario.prompts.entries()) {
    const record = { toolCalls: [] as ToolCall[], toolResults: [] as ToolResult[], changes: [] as string[], error: null as string | null };
    const suggestion = "suggestion" in scenario;
    const outcome = await runRequest({
      history,
      request,
      start: recorded(scripted(history, ...(scripts[index] ?? [])), record),
      listen: world.listen,
      hearReference: world.hearReference,
      library: world.library,
      conversation: finished,
      mode: { smallCore: suggestion, suggestion, hearsAudio: scenario.hearsAudio === true },
    });
    await outcome.suggestion?.apply();
    finished.push({ request, outcome });
    sent.push({ ...record, changes: outcome.changes, error: outcome.error });
    projects.push(history.project);
  }
  return checkScenario(scenario, projects, sent);
}

function failed(checks: Record<string, boolean>): string[] {
  return Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([check]) => check);
}

function trackOf(project: Project, id: string) {
  return project.tracks.find((track) => track.id === id)!;
}

interface Measured {
  sample_peak_db: number;
  true_peak_dbtp: number;
  clipping: { clipped_samples: number };
}

/** The whole song, or one Track of it alone, as `analyse_audio` measures it. */
async function measure(song: Project, track: number | null): Promise<Measured> {
  const { measurements } = await listen(song, { start: 0, end: songEndTick(song), track });
  return JSON.parse(measurements) as Measured;
}

function busId(project: Project, name: string): string {
  return project.buses.find((bus) => bus.name === name)!.id;
}

function effect(project: Project, type: string): string {
  return trackOf(project, TRACKS.lead).insertChain.find((each) => each.type === type)!.id;
}

// Rendering the whole song once per Track takes seconds of CPU, and more
// while every other test file runs beside it.
describe("the v3 song", { timeout: 20_000 }, () => {
  it("is four Tracks in four Sections, and valid", () => {
    const song = v3Song();
    expect(validateProject(song)).toBeNull();
    expect(song.tracks.map((track) => track.name)).toEqual(["Drums", "Bass", "Pad", "Lead"]);
    expect(song.sections.map((section) => [section.name, section.startBar])).toEqual([
      ["Intro", 1],
      ["Verse", 5],
      ["Chorus", 9],
      ["Outro", 13],
    ]);
    expect(songEndTick(song)).toBe(16 * BAR);
    // The Bass's last two notes can be made longer inside their Clip.
    const lastBass = songNotes(trackOf(song, TRACKS.bass)).at(-1)!;
    expect(lastBass.start + lastBass.length).toBeLessThan(16 * BAR);
  });

  it("is heard, with room to spare below the true-peak ceiling", async () => {
    const measured = await measure(v3Song(), null);
    expect(measured.sample_peak_db).toBeGreaterThan(-24);
    expect(measured.true_peak_dbtp).toBeLessThan(-6);
    expect(measured.clipping.clipped_samples).toBe(0);
  });

  it("clips with its loudest Track and the Master pushed to 2, as the clipping scenario pushes them", async () => {
    const song = v3Song();
    const solo = await Promise.all(song.tracks.map(async (_, index) => (await measure(song, index)).sample_peak_db));
    expect(solo.indexOf(Math.max(...solo))).toBe(0);
    song.tracks[0]!.mixer.volume = 2;
    song.master.volume = 2;
    expect((await measure(song, null)).clipping.clipped_samples).toBeGreaterThan(0);
  });

  it("has a Bass louder than anything else when the compare scenario pushes it", async () => {
    const song = V3_SCENARIOS.compare.song();
    const solo = await Promise.all(song.tracks.map(async (_, index) => (await measure(song, index)).sample_peak_db));
    expect(solo.indexOf(Math.max(...solo))).toBe(1);
    expect(solo[1]! - Math.max(solo[0]!, solo[2]!, solo[3]!)).toBeGreaterThan(3);
  });
});

/** A script that adds each Tempo Change. */
function slower(...changes: { bar: number; tempo: number }[]) {
  return [() => [...loadTools("time"), ...changes.map((change) => call("add_tempo_change", change))]];
}

/** A script that saves the Pad as a Preset and the Drums as a Kit, then loads the Kit `preset` onto the Drums. */
function loads(preset: string) {
  return [
    () => [
      ...loadTools("sounds"),
      call("save_preset", { source: TRACKS.pad, name: "Dream Pad" }),
      call("save_kit", { trackId: TRACKS.drums, name: "Old Drums" }),
      call("set_instrument", { trackId: TRACKS.drums, instrument: "drumSampler", preset }),
    ],
  ];
}

/** A script that places the vocal take at `start` and trims the Verse's to its first two seconds. */
function placed(start: number) {
  return [
    () => [
      ...loadTools("audio_clips"),
      call("place_audio_clip", { trackId: TRACKS.vocals, source: VOCAL, start }),
      call("trim_audio_clip", { clipId: "vocals-verse", endOffset: 2 }),
    ],
  ];
}

/** A script that names the four parts, the Chorus from `chorusBar`. */
function named(chorusBar: number) {
  return [
    () => [
      ...loadTools("arrangement"),
      call("add_section", { name: "Intro", startBar: 1, bars: 4 }),
      call("add_section", { name: "Verse", startBar: 5, bars: 4 }),
      call("add_section", { name: "Chorus", startBar: chorusBar, bars: 4 }),
      call("add_section", { name: "Outro", startBar: 13, bars: 4 }),
    ],
  ];
}

// A scenario with audio renders its files and the song, and the reference
// is measured whole: seconds of CPU while every other test file runs beside it.
describe("the v3 scenarios' checks", { timeout: 30_000 }, () => {
  it("fail every scenario whose Request changes nothing", async () => {
    const names = Object.keys(V3_SCENARIOS) as V3ScenarioName[];
    const outcomes = await Promise.all(names.map((name) => run(name, ...V3_SCENARIOS[name].prompts.map(() => []))));
    expect(outcomes.map((checks) => checks.noError)).toEqual(names.map(() => true));
    expect(outcomes.filter((checks) => failed(checks).length === 0)).toEqual([]);
  });

  it("pass the last two Bass notes made longer, and fail the whole bassline made longer", async () => {
    const lastTwo = ["13440:43", "14400:43"];
    expect(failed(await run("notes", [() => [...loadTools("notes"), call("resize_notes", { clipId: "bass-outro", noteIds: lastTwo, by: BEAT / 4 })]]))).toEqual([]);
    const everyNote = songNotes(trackOf(v3Song(), TRACKS.bass)).filter((note) => note.start >= 12 * BAR);
    const checks = await run("notes", [
      () => [
        ...loadTools("notes"),
        call("resize_notes", { clipId: "bass-outro", noteIds: everyNote.map((note) => `${note.start - 12 * BAR}:${note.pitch}`), by: BEAT / 4 }),
      ],
    ]);
    expect(failed(checks)).toEqual(["otherNotesUnchanged"]);
  });

  it("pass the rhythm section on a Bus turned down and the Pad sent to another", async () => {
    const checks = await run("routing", [
      () => [...loadTools("routing"), call("add_bus", { name: "Rhythm" }), call("add_bus", { name: "Space" })],
      (project) => [
        call("set_output", { channel: TRACKS.drums, target: busId(project, "Rhythm") }),
        call("set_output", { channel: TRACKS.bass, target: busId(project, "Rhythm") }),
        call("set_bus_volume", { busId: busId(project, "Rhythm"), volume: 0.8 }),
        call("add_send", { channel: TRACKS.pad, busId: busId(project, "Space"), level: 0.3 }),
      ],
    ]);
    expect(failed(checks)).toEqual([]);
  });

  it("pass a fade in over four bars, and fail one that ends early and falls back", async () => {
    const fade = (breakpoints: { tick: number; value: number }[]) => [
      () => [...loadTools("automation"), call("set_automation", { channel: TRACKS.pad, setting: "volume", start: 0, end: 4 * BAR, breakpoints })],
    ];
    expect(failed(await run("automation", fade([{ tick: 0, value: 0 }, { tick: 4 * BAR, value: 0.8 }])))).toEqual([]);
    const dips = fade([{ tick: 0, value: 0 }, { tick: 2 * BAR, value: 0.8 }, { tick: 4 * BAR, value: 0.1 }]);
    expect(failed(await run("automation", dips))).toEqual(["neverFalls", "reachesItsLevelByBar5"]);
  });

  it("pass the chorus duplicated, and fail it moved to the end", async () => {
    expect(failed(await run("arrangement", [() => [...loadTools("arrangement"), call("duplicate_section", { section: "Chorus" })]]))).toEqual([]);
    const moved = await run("arrangement", [() => [...loadTools("arrangement"), call("move_section", { section: "Chorus", to: 17 })]]);
    expect(failed(moved)).toContain("twoChoruses");
    expect(failed(moved)).toContain("chorusClipsKept");
  });

  it("pass a build-up of notes, Automation and an Effect, and name what a build-up leaves out", async () => {
    const snareRoll = [...Array(16).keys()].map((index) => ({ pitch: 38, start: 3 * BAR + (index * BEAT) / 4, length: 120, velocity: 0.5 + index / 40 }));
    const notesAndAutomation = [
      ...loadTools("notes", "automation", "sounds"),
      call("add_notes", { clipId: "drums-verse", notes: snareRoll }),
      call("set_automation", {
        channel: TRACKS.pad,
        setting: "volume",
        start: 4 * BAR,
        end: 8 * BAR,
        breakpoints: [
          { tick: 4 * BAR, value: 0.2 },
          { tick: 8 * BAR, value: 0.4 },
        ],
      }),
    ];
    const full = await run("buildup", [() => [...notesAndAutomation, call("add_effect", { channel: TRACKS.pad, effect: "reverb" })]]);
    expect(failed(full)).toEqual([]);
    expect(failed(await run("buildup", [() => notesAndAutomation]))).toEqual(["effectsChanged"]);
  });

  it("pass a follow-up that takes the reverb away and keeps the delay", async () => {
    const first = [() => [...loadTools("sounds"), call("add_effect", { channel: TRACKS.lead, effect: "reverb" }), call("add_effect", { channel: TRACKS.lead, effect: "delay" })]];
    expect(failed(await run("conversation", first, [(project) => [call("remove_effect", { effectId: effect(project, "reverb") })]]))).toEqual([]);
    // A follow-up that forgot the first Request, and took everything away.
    const both = await run("conversation", first, [
      (project) => [call("remove_effect", { effectId: effect(project, "reverb") }), call("remove_effect", { effectId: effect(project, "delay") })],
    ]);
    expect(failed(both)).toEqual(["followUpKeptTheDelay"]);
  });

  it("pass a Suggestion that mutes the Pad and turns the Bass up once applied", async () => {
    const checks = await run("suggestion", [
      () => [call("set_track_mute", { trackId: TRACKS.pad, mute: true }), call("set_track_volume", { trackId: TRACKS.bass, volume: 1 })],
    ]);
    expect(failed(checks)).toEqual([]);
  });

  it("pass the loud Bass turned down between two analyses that are compared", async () => {
    const listened = await run("compare", [
      () => [call("analyse_audio", {})],
      () => [call("set_track_volume", { trackId: TRACKS.bass, volume: 0.8 }), call("analyse_audio", {})],
      () => [call("compare_audio", {})],
    ]);
    expect(failed(listened)).toEqual([]);
    const unheard = await run("compare", [() => [call("set_track_volume", { trackId: TRACKS.bass, volume: 0.8 })]]);
    expect(failed(unheard)).toEqual(["analysedBeforeAndAfter", "comparedBeforeAndAfter"]);
  });

  it("pass the Chorus slowed to 100 and the Outro back at 120, and fail a tempo left slow to the end", async () => {
    expect(failed(await run("tempo", slower({ bar: 9, tempo: 100 }, { bar: 13, tempo: 120 })))).toEqual([]);
    expect(failed(await run("tempo", slower({ bar: 9, tempo: 100 })))).toEqual(["outroBackAt120"]);
  });

  it("pass a Preset and a Kit saved and the saved Kit loaded, and fail the Starter Kit loaded instead", async () => {
    expect(failed(await run("sounds", loads(SAVED_KIT)))).toEqual([]);
    expect(failed(await run("sounds", loads("Starter Kit")))).toEqual(["drumsPlayTheSavedKit", "itsKickCopiedIn"]);
  });

  it("pass the vocal placed at the Chorus and the Verse's trimmed, and fail it placed a bar late", async () => {
    expect(failed(await run("audioclips", placed(8 * BAR)))).toEqual([]);
    expect(failed(await run("audioclips", placed(9 * BAR)))).toEqual(["placedAtTheChorus"]);
  });

  it("pass the four parts named as Sections, and fail a chorus named over the wrong bars", async () => {
    expect(V3_SCENARIOS.sections.song().sections).toEqual([]);
    expect(failed(await run("sections", named(9)))).toEqual([]);
    // Bars 10 to 13 overlap the Outro's first bar, so the Outro is refused.
    expect(failed(await run("sections", named(10)))).toEqual(["fourSections", "chorus", "outro"]);
  });

  it("pass the Lead listened to with its audio sent, and fail the numbers read without listening", async () => {
    const chorus = { trackId: TRACKS.lead, start: 8 * BAR, end: 12 * BAR };
    expect(failed(await run("listening", [() => [call("analyse_audio", { ...chorus, listen: true })]]))).toEqual([]);
    expect(failed(await run("listening", [() => [call("analyse_audio", chorus)]]))).toEqual(["askedToHearIt", "wasSentTheAudio"]);
  });

  it("pass the mix compared with the reference, changed and compared again, and fail it changed without comparing", async () => {
    const bassUp = call("set_track_volume", { trackId: TRACKS.bass, volume: 1.6 });
    const compared = await run("reference", [
      () => [call("compare_to_reference", {})],
      () => [bassUp],
      () => [call("compare_to_reference", {})],
    ]);
    expect(failed(compared)).toEqual([]);
    expect(failed(await run("reference", [() => [bassUp]]))).toEqual(["comparedWithTheReference", "comparedAgainAfter"]);
  });
});

describe("the v3 stories", () => {
  it("each have a scenario or a waiver saying why not", () => {
    const covered = [...Object.values(V3_SCENARIOS).map(({ story }) => story), ...Object.keys(V3_WAIVERS)];
    // Story 16, the clipping fix, is the `clipping` scenario v3 shares with the MVP.
    const numbers = [...covered.map((story) => Number.parseInt(story, 10)), 16].toSorted((a, b) => a - b);
    expect(numbers).toEqual([...Array(16).keys()].map((index) => index + 1));
    // And the real-model check can be asked for every scenario by its name.
    expect(SCENARIOS).toEqual(expect.arrayContaining(Object.keys(V3_SCENARIOS)));
  });
});

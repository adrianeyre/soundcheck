import { readFileSync } from "node:fs";

import { encode_wav, initSync } from "@engine";
import { beforeAll, expect, test, vi } from "vitest";

import { wasmAudioAnalyser, type AnalyseAudio } from "../audio/audio-analyser";
import { EngineSync } from "../project/engine-sync";
import { ProjectHistory } from "../project/history";
import { createAudioTrack, createEffect, createInstrumentTrack, createProject, type Project } from "../project/model";
import { stereoWav } from "../song/test-wav";
import { DIRECT, MAX_TURNS, runRequest, type Conversation, type Listen, type ModelReply, type ToolResult } from "./assistant";
import { projectSummary } from "./read";
import { listenWith } from "./listen";
import { AUDIO_ATTACHED, TRUE_PEAK_CEILING_DBTP, type ToolCall, type ToolDefinition } from "./tools";

// The real WASM engine renders and measures, so these hear actual clipping.
beforeAll(() => {
  initSync({ module: readFileSync(new URL("../../../engine/pkg/soundcheck_engine_bg.wasm", import.meta.url)) });
});

const listen: Listen = listenWith(wasmAudioAnalyser(() => Promise.resolve()));

/** Claude, replaced by a script. What the Assistant sent back is kept. */
function scripted(...replies: ModelReply[]) {
  const sent: (readonly ToolResult[])[] = [];
  const offered: (readonly ToolDefinition[])[] = [];
  let turn = 0;
  const conversation: Conversation = {
    next(results, _turnsLeft, tools) {
      sent.push(results);
      offered.push(tools);
      const reply = replies[turn++];
      if (!reply) throw new Error("the Assistant asked for more turns than the script has");
      return Promise.resolve(reply);
    },
  };
  return { start: () => conversation, sent, offered };
}

function calls(...toolCalls: ToolCall[]): ModelReply {
  return { text: "", toolCalls };
}

function says(text: string): ModelReply {
  return { text, toolCalls: [] };
}

/** One Synth Track, "Lead", holding a ten-note chord for a bar at twice unity: it clips. */
function clippingProject(): Project {
  const project = createProject("Too loud");
  const lead = createInstrumentTrack("Lead", "lead");
  lead.mixer.volume = 2;
  lead.clips.push({
    id: "lead-1",
    kind: "pattern",
    start: 0,
    length: 3840,
    notes: [36, 43, 48, 52, 55, 60, 64, 67, 72, 76].map((pitch) => ({ pitch, start: 0, length: 3840, velocity: 1 })),
  });
  project.tracks.push(lead);
  return project;
}

/**
 * A silent Instrument Track, then an Audio Track, "Vocals", playing a
 * near-full-scale tone for a bar at twice unity into a Master at twice
 * unity: it clips. The tone's file is in `samples`, as an import leaves it.
 */
function loudVocals(): { project: Project; samples: Map<string, { name: string; bytes: number[] }> } {
  const project = createProject("Too loud");
  project.master.volume = 2;
  const vocals = createAudioTrack("Vocals", "vocals");
  vocals.mixer.volume = 2;
  vocals.clips.push({ id: "vocals-1", kind: "audio", start: 0, duration: 2, file: "audio/tone.wav", fileOffset: 0 });
  project.tracks.push(createInstrumentTrack("Lead", "lead"), vocals);
  const tone = Array.from({ length: 96_000 }, (_, i) => 0.9 * Math.sin((2 * Math.PI * 220 * i) / 48_000));
  return { project, samples: new Map([["audio/tone.wav", { name: "tone.wav", bytes: stereoWav(tone, tone, 48_000) }]]) };
}

/** A listener whose render fails, as a lost IPC call would. */
const brokenListener: Listen = () => Promise.reject(new Error("the render thread went away"));

interface Measured {
  source: string;
  sample_peak_db: number | null;
  true_peak_dbtp: number | null;
  clipping: { clipped_samples: number };
}

/** The measurements in an `analyse_audio` result, between its heading and its note on the true peak. */
function measured<T = Measured>(result: ToolResult): T {
  expect(result.isError).toBe(false);
  return JSON.parse(result.content.slice(result.content.indexOf("{"), result.content.lastIndexOf("}") + 1)) as T;
}

/** What an `analyse_audio` result says of its true peak against the ceiling: its last line. */
function peakNote(result: ToolResult): string {
  return result.content.slice(result.content.lastIndexOf("\n") + 1);
}

test("the Assistant hears a Track clip, turns it down, and hears that it no longer clips", async () => {
  const history = new ProjectHistory(clippingProject());
  const { start, sent } = scripted(
    calls({ id: "before", name: "analyse_audio", input: {} }),
    calls({ id: "fix", name: "set_track_volume", input: { trackId: "lead", volume: 0.1 } }),
    calls({ id: "after", name: "analyse_audio", input: {} }),
    says("Lead was clipping the mix, so I turned it down; it doesn't clip now."),
  );

  const outcome = await runRequest({ history, request: "the mix is clipping — fix it", start, listen });

  expect(outcome.error).toBeNull();
  const before = sent[1]![0]!;
  expect(before.callId).toBe("before");
  expect(before.content).toMatch(/^The whole mix, from 1\.1\.000 \(0 s\) to 2\.1\.000 \(2 s\), measured:\n/);
  expect(measured(before)).toMatchObject({ source: "mix" });
  expect(measured(before).clipping.clipped_samples).toBeGreaterThan(0);

  // The second analysis hears the Request's own change.
  const after = sent[3]![0]!;
  expect(after.callId).toBe("after");
  expect(measured(after).clipping.clipped_samples).toBe(0);

  // Listening is not a change: the summary and the undo step are the fix alone.
  expect(outcome.changes).toEqual(["Set “Lead” to -20.0 dB"]);
  history.undo();
  expect(history.project.tracks[0]!.mixer.volume).toBe(2);
});

test("the Assistant hears an Audio Track clip, on its own and in the mix, and hears the fix", async () => {
  const { project, samples } = loudVocals();
  const history = new ProjectHistory(project);
  const { start, sent } = scripted(
    calls({ id: "alone", name: "analyse_audio", input: { trackId: "vocals" } }),
    calls({ id: "fix", name: "set_track_volume", input: { trackId: "vocals", volume: 0.25 } }),
    calls({ id: "after", name: "analyse_audio", input: {} }),
    says("Vocals were clipping, so I turned them down."),
  );

  const outcome = await runRequest({
    history,
    request: "the vocals are clipping",
    start,
    listen: listenWith(wasmAudioAnalyser(() => Promise.resolve()), samples),
  });

  expect(outcome.error).toBeNull();
  // Vocals are the engine's second Track, as they are the Track list's.
  const alone = sent[1]![0]!;
  expect(alone.content).toMatch(/^Track vocals \(“Vocals”\) on its own, from 1\.1\.000 \(0 s\) to 2\.1\.000 \(2 s\)/);
  expect(measured(alone)).toMatchObject({ source: "track 1" });
  expect(measured(alone).clipping.clipped_samples).toBeGreaterThan(0);

  const after = sent[3]![0]!;
  expect(measured(after)).toMatchObject({ source: "mix" });
  expect(measured(after).clipping.clipped_samples).toBe(0);
  // The mix still has the Vocals in it, turned down, not silence.
  expect(measured(after).sample_peak_db).toBeGreaterThan(-24);
  expect(outcome.changes).toEqual(["Set “Vocals” to -12.0 dB"]);
});

/**
 * Four Synth Tracks into a Master at twice unity. "Lead" holds a ten-note
 * chord at twice unity as well, so the mix clips, and so does Lead alone.
 */
function fourTracksClipping(): Project {
  const project = clippingProject();
  project.master.volume = 2;
  for (const [id, pitch] of [["bass", 36], ["pad", 60], ["keys", 72]] as const) {
    const track = createInstrumentTrack(id[0]!.toUpperCase() + id.slice(1), id);
    track.clips.push({ id: `${id}-1`, kind: "pattern", start: 0, length: 3840, notes: [{ pitch, start: 0, length: 3840, velocity: 0.5 }] });
    project.tracks.push(track);
  }
  return project;
}

const TRACK_IDS = ["lead", "bass", "pad", "keys"];

test("several Tracks analysed in one turn are each heard on their own, in the order asked", async () => {
  const history = new ProjectHistory(fourTracksClipping());
  const { start, sent } = scripted(
    calls(...TRACK_IDS.slice(0, 3).map((trackId) => ({ id: trackId, name: "analyse_audio", input: { trackId } }))),
    says("Lead clips on its own; Bass and Pad don't."),
  );

  const outcome = await runRequest({ history, request: "which Track is clipping?", start, listen });

  expect(outcome.error).toBeNull();
  expect(sent).toHaveLength(2);
  expect(sent[1]!.map((result) => [result.callId, measured(result).source])).toEqual([
    ["lead", "track 0"],
    ["bass", "track 1"],
    ["pad", "track 2"],
  ]);
  expect(measured(sent[1]![0]!).clipping.clipped_samples).toBeGreaterThan(0);
  expect(measured(sent[1]![1]!).clipping.clipped_samples).toBe(0);
  expect(outcome.changes).toEqual([]);
});

/**
 * A per-Track clipping fix, as the turn limit is measured: hear the mix
 * and each Track on its own, turn Lead down, check, bring the Master back
 * to unity, and check again. Made one call per turn, as a model that
 * doesn't batch its calls does, it takes 9 turns with tools; with each
 * step's independent calls together, as the system prompt asks, it takes 5.
 * Either way the summary follows, in the turn without tools.
 */
const PER_TRACK_FIX: ToolCall[][] = [
  [{ id: "mix", name: "analyse_audio", input: {} }, ...TRACK_IDS.map((trackId) => ({ id: trackId, name: "analyse_audio", input: { trackId } }))],
  [{ id: "lead-down", name: "set_track_volume", input: { trackId: "lead", volume: 0.25 } }],
  [{ id: "check", name: "analyse_audio", input: {} }],
  [{ id: "master", name: "set_master_volume", input: { volume: 1 } }],
  [{ id: "final", name: "analyse_audio", input: {} }],
];

test.each([
  ["one call per turn", PER_TRACK_FIX.flatMap((step) => step.map((call) => [call])), 9],
  ["each step's calls together", PER_TRACK_FIX, 5],
])("a per-Track clipping fix made %s fits in the turn limit, and ends with a summary", async (_, turns, count) => {
  const history = new ProjectHistory(fourTracksClipping());
  const { start, sent } = scripted(...turns.map((toolCalls) => calls(...toolCalls)), says("Lead was clipping the mix: I turned it and the Master down."));

  const outcome = await runRequest({ history, request: "the mix is clipping — fix it", start, listen });

  expect(turns).toHaveLength(count);
  expect(count).toBeLessThanOrEqual(MAX_TURNS);
  expect(outcome.error).toBeNull();
  expect(outcome.message).toBe("Lead was clipping the mix: I turned it and the Master down.");
  const results = sent.flat();
  const heard = (id: string) => measured(results.find((result) => result.callId === id)!);
  expect(heard("mix").clipping.clipped_samples).toBeGreaterThan(0);
  expect(heard("lead").clipping.clipped_samples).toBeGreaterThan(0);
  expect(heard("final").clipping.clipped_samples).toBe(0);
  expect(outcome.changes).toHaveLength(2);
  history.undo();
  expect(history.project).toEqual(fourTracksClipping());
});

test("a mix with no clipped samples but a true peak above the ceiling is told it is over", async () => {
  // The Master at 1.5 rather than twice unity puts the Vocals' tone just under full scale: nothing clips.
  const { project, samples } = loudVocals();
  project.master.volume = 1.5;
  const history = new ProjectHistory(project);
  const { start, sent } = scripted(calls({ id: "heard", name: "analyse_audio", input: {} }), says("Nothing clips, but it peaks over the ceiling."));

  await runRequest({ history, request: "is it too loud?", start, listen: listenWith(wasmAudioAnalyser(() => Promise.resolve()), samples) });

  const heard = sent[1]![0]!;
  expect(measured(heard).clipping.clipped_samples).toBe(0);
  expect(measured(heard).true_peak_dbtp).toBeGreaterThan(TRUE_PEAK_CEILING_DBTP);
  expect(measured(heard).true_peak_dbtp).toBeLessThan(0);
  expect(peakNote(heard)).toMatch(/^No samples clip, but the true peak, -0\.\d dBTP, is above the ceiling of -1 dBTP/);
});

test("the one loud Track of a clipping mix is the one turned down, and the mix ends within the ceiling", async () => {
  // As real-model-check's one-loud-Track setup: the loudest Track and the Master pushed to twice unity.
  const history = new ProjectHistory(fourTracksClipping());
  const { start, sent } = scripted(
    calls({ id: "mix", name: "analyse_audio", input: {} }, ...TRACK_IDS.map((trackId) => ({ id: trackId, name: "analyse_audio", input: { trackId } }))),
    // The summary has no volumes: the model reads Lead's before turning it down.
    calls({ id: "lead-volume", name: "read_channel", input: { channel: "lead" } }),
    calls({ id: "lead-down", name: "set_track_volume", input: { trackId: "lead", volume: 0.25 } }),
    calls({ id: "check", name: "analyse_audio", input: {} }),
    says("Lead was too loud: I turned it down, and the mix now peaks under -1 dBTP."),
  );

  const outcome = await runRequest({ history, request: "the mix is clipping — fix it", start, listen });

  expect(outcome.error).toBeNull();
  const results = new Map(sent.flat().map((result) => [result.callId, result]));
  expect(peakNote(results.get("mix")!)).toMatch(/samples clip, and the true peak, .* is above the ceiling/);
  // Heard on their own, Lead is over the ceiling and the others are well within it.
  expect(peakNote(results.get("lead")!)).toMatch(/is above the ceiling/);
  for (const trackId of ["bass", "pad", "keys"]) expect(peakNote(results.get(trackId)!)).toMatch(/is within the ceiling/);

  expect(results.get("lead-volume")!.content).toMatch(/^Track lead \(“Lead”\), in full:\n\{"trackId":"lead","name":"Lead","kind":"instrument",.*"volume":2,/);

  const check = results.get("check")!;
  expect(measured(check).clipping.clipped_samples).toBe(0);
  expect(measured(check).true_peak_dbtp).toBeLessThanOrEqual(TRUE_PEAK_CEILING_DBTP);
  expect(peakNote(check)).toMatch(/is within the ceiling of -1 dBTP\.$/);
  // Only Lead came down: the other Tracks and the Master are as they were.
  expect(outcome.changes).toEqual(["Set “Lead” to -12.0 dB"]);
  expect(history.project.master.volume).toBe(2);
  history.undo();
  expect(history.project).toEqual(fourTracksClipping());
});

test("a Request that doesn't need listening makes no analysis", async () => {
  const history = new ProjectHistory(clippingProject());
  const spy = vi.fn<Listen>(listen);
  const { start } = scripted(
    calls({ id: "load", name: "load_tools", input: { group: "time" } }),
    calls({ id: "tempo", name: "set_tempo", input: { tempo: 120 } }),
    says("Set to 120 BPM."),
  );

  const outcome = await runRequest({ history, request: "set tempo to 120", start, listen: spy });

  expect(outcome.changes).toEqual(["Set the tempo to 120 BPM"]);
  expect(spy).not.toHaveBeenCalled();
});

test("one Track can be heard on its own, over a range of the song", async () => {
  const history = new ProjectHistory(clippingProject());
  const { start, sent } = scripted(
    calls({ id: "lead", name: "analyse_audio", input: { trackId: "lead", start: 960, end: 1920 } }),
    says("Heard it."),
  );

  await runRequest({ history, request: "how does the lead sound in beat 2?", start, listen });

  const result = sent[1]![0]!;
  expect(result.content).toMatch(/^Track lead \(“Lead”\) on its own, from 1\.2\.000 \(0\.5 s\) to 1\.3\.000 \(1 s\)/);
  expect(measured(result)).toMatchObject({ source: "track 0" });
});

/** A take recorded onto beat 1 of an Audio Track, and an Effect of `type` on `chain`. */
function takeThrough(chain: "track" | "master" | null, type: "compressor" | "reverb", settings: Record<string, number>) {
  const project = createProject("Take");
  const vocals = createAudioTrack("Vocals", "vocals");
  vocals.clips.push({ id: "take", kind: "audio", start: 0, duration: 0.25, file: "audio/Vocals take.wav", fileOffset: 0 });
  project.tracks.push(vocals);
  const effect = createEffect(type, "fx");
  Object.assign(effect.settings, settings);
  if (chain === "track") vocals.insertChain.push(effect);
  if (chain === "master") project.master.insertChain.push(effect);
  return project;
}

test("the analysis hears a recorded take through a Compressor, and a Reverb ringing on after it", async () => {
  // A quarter-second take at 44.1 kHz, saved as 24 bits as the desktop saves one.
  const rate = 44_100;
  const take = Float32Array.from({ length: rate / 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * (i >> 1)) / rate));
  const samples = new Map([["audio/Vocals take.wav", { name: "Vocals take.wav", bytes: [...encode_wav(take, rate, 24)!] }]]);
  const peakDb = async (project: Project, start: number, end: number) => {
    const { measurements } = await listenWith(wasmAudioAnalyser(() => Promise.resolve()), samples)(project, {
      start,
      end,
      track: null,
    });
    return (JSON.parse(measurements) as Measured).sample_peak_db;
  };

  const dry = takeThrough(null, "reverb", {});
  const loud = (await peakDb(dry, 0, 960))!;
  expect(loud).toBeGreaterThan(-20);
  // Beat 3: the take ended a beat and a half before.
  expect(await peakDb(dry, 1920, 2880)).toBeNull();
  for (const chain of ["track", "master"] as const) {
    const squashed = takeThrough(chain, "compressor", { thresholdDb: -40, ratio: 20, attack: 0.1, makeupDb: 0, kneeDb: 0 });
    expect(await peakDb(squashed, 0, 960)).toBeLessThan(loud - 12);
    const wet = takeThrough(chain, "reverb", { decay: 4, preDelay: 0, mix: 1 });
    expect(await peakDb(wet, 1920, 2880)).toBeGreaterThan(-80);
  }
});

test("the analysis hears the Project as the engine that plays it is sent it", async () => {
  const analyse = vi.fn<AnalyseAudio>(() => Promise.resolve({ measurements: "{}" }));
  const project = clippingProject();

  await listenWith(analyse)(project, { start: 0, end: 3840, track: null });

  expect(analyse).toHaveBeenCalledWith(new EngineSync().update(project), { start: 0, end: 3840, track: null });
});

test("asked for, a spectrogram of the same render comes back with the measurements, as a PNG", async () => {
  const history = new ProjectHistory(clippingProject());
  const { start, sent } = scripted(
    calls({ id: "plain", name: "analyse_audio", input: {} }),
    calls({ id: "seen", name: "analyse_audio", input: { spectrogram: true } }),
    says("It clips all the way through."),
  );

  await runRequest({ history, request: "where does it clip?", start, listen });

  const [plain, seen] = [sent[1]![0]!, sent[2]![0]!];
  expect(plain.image).toBeUndefined();
  expect(seen.content).toMatch(/^The whole mix, from 1\.1\.000 \(0 s\) to 2\.1\.000 \(2 s\), measured \(the spectrogram is attached\):\n/);
  expect(measured(seen)).toEqual(measured(plain));
  const png = Uint8Array.from(atob(seen.image!), (c) => c.charCodeAt(0));
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // The IHDR chunk: 800 by 400 pixels.
  const header = new DataView(png.buffer, 16, 8);
  expect([header.getUint32(0), header.getUint32(4)]).toEqual([800, 400]);
});

/** A WAV's channels, rate and length in seconds, from its header. */
function wavHeader(base64: string): { channels: number; rate: number; seconds: number } {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
  const [channels, rate, bits] = [view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)];
  return { channels, rate, seconds: view.getUint32(40, true) / (channels * (bits / 8) * rate) };
}

const HEARING = { ...DIRECT, hearsAudio: true };

test("a model that is sent audio hears the same render as a mono WAV, with the measurements", async () => {
  const history = new ProjectHistory(clippingProject());
  const { start, sent, offered } = scripted(
    calls({ id: "plain", name: "analyse_audio", input: {} }),
    calls({ id: "heard", name: "analyse_audio", input: { listen: true } }),
    says("It clips all the way through."),
  );

  await runRequest({ history, request: "does it sound harsh?", start, listen, mode: HEARING });

  const listens = offered[0]!.find((tool) => tool.name === "analyse_audio")!.input_schema.properties;
  expect(listens).toHaveProperty("listen");
  const [plain, heard] = [sent[1]![0]!, sent[2]![0]!];
  expect(plain.audio).toBeUndefined();
  expect(heard.content).toMatch(/^The whole mix, from 1\.1\.000 \(0 s\) to 2\.1\.000 \(2 s\), measured \(the audio is attached\):\n/);
  expect(heard.content).toContain("The audio attached is all of it, a WAV file, mono at 16 kHz");
  expect(measured(heard)).toEqual(measured(plain));
  expect(wavHeader(heard.audio!)).toEqual({ channels: 1, rate: 16_000, seconds: 2 });
});

test("a render longer than the listening cap is cut to it, and the result says so", async () => {
  const history = new ProjectHistory(clippingProject());
  const { start, sent } = scripted(
    calls({ id: "long", name: "analyse_audio", input: { listen: true, end: 20 * 3840 } }),
    says("Heard the first 30 seconds."),
  );

  await runRequest({ history, request: "how does the whole thing sound?", start, listen, mode: HEARING });

  const long = sent[1]![0]!;
  expect(wavHeader(long.audio!)).toEqual({ channels: 1, rate: 16_000, seconds: 30 });
  expect(long.content).toContain("The audio attached is cut to the first 30 s of the 40 s, to 16.1.000 (30 s): listening is capped at 30 s.");
  // The measurements are still of the whole 40 s.
  expect(long.content).toContain("from 1.1.000 (0 s) to 21.1.000 (40 s)");
});

test("a model that isn't sent audio isn't offered listen, and a call that asks anyway gets the numbers, told why", async () => {
  const history = new ProjectHistory(clippingProject());
  const { start, sent, offered } = scripted(calls({ id: "heard", name: "analyse_audio", input: { listen: true } }), says("It clips."));

  await runRequest({ history, request: "does it sound harsh?", start, listen });

  expect(offered[0]!.find((tool) => tool.name === "analyse_audio")!.input_schema.properties).not.toHaveProperty("listen");
  const heard = sent[1]![0]!;
  expect(heard.audio).toBeUndefined();
  expect(heard.content).not.toContain(AUDIO_ATTACHED);
  expect(heard.content).not.toContain("The audio attached is");
  expect(heard.content).toContain("No audio is attached: this model isn't sent audio here, so read the measurements instead.");
  expect(measured(heard).clipping.clipped_samples).toBeGreaterThan(0);
});

test("where the Assistant can't listen, or the analysis fails, it is told and nothing stops", async () => {
  const history = new ProjectHistory(clippingProject());
  for (const [with_, expected] of [
    [undefined, "Listening isn't available here."],
    [brokenListener, "The audio couldn't be analysed: the render thread went away"],
  ] as const) {
    const { start, sent } = scripted(calls({ id: "listen", name: "analyse_audio", input: {} }), says("I couldn't listen."));
    const outcome = await runRequest({ history, request: "is it clipping?", start, listen: with_ });
    expect(sent[1]).toEqual([{ callId: "listen", content: expected, isError: true }]);
    expect(outcome.error).toBeNull();
  }
});

/**
 * Two bars of 4/4 at 120, then 3/4 at 60 from bar 3, with "Lead" playing a
 * note on every beat of bars 4 and 5 only.
 */
function slowingDown(): Project {
  const project = createProject("Slowing down");
  project.tempoChanges.push({ id: "slow", tick: 7680, tempo: 60, timeSignature: { beatsPerBar: 3, beatUnit: 4 } });
  const lead = createInstrumentTrack("Lead", "lead");
  lead.clips.push({
    id: "lead-1",
    kind: "pattern",
    start: 10_560,
    length: 5760,
    notes: Array.from({ length: 6 }, (_, beat) => ({ pitch: 60, start: beat * 960, length: 240, velocity: 0.8 })),
  });
  project.tracks.push(lead);
  return project;
}

interface Placed {
  start: { s: number; at: string };
  end: { s: number; at: string };
  onsets: { count: number; at: { s: number; at: string }[] };
}

test("analysing bars after a Tempo Change hears the seconds those bars play at", async () => {
  const project = slowingDown();
  // Bar 4 from the context, as the system prompt says to count it.
  const [change] = projectSummary(project).tempoChanges!;
  const barTick = (bar: number) => change!.barTick + (bar - change!.bar) * change!.ticksPerBar;
  expect([barTick(4), barTick(6)]).toEqual([10_560, 16_320]);

  const history = new ProjectHistory(project);
  const { start, sent } = scripted(
    calls({ id: "bars", name: "analyse_audio", input: { start: barTick(4), end: barTick(6) } }),
    calls({ id: "before", name: "analyse_audio", input: { start: barTick(3), end: barTick(4) } }),
    says("Bars 4 and 5 have a note on every beat; bar 3 is silent."),
  );
  await runRequest({ history, request: "what plays in bars 4 and 5?", start, listen });

  const [bars, before] = [sent[1]![0]!, sent[2]![0]!];
  // Bar 4 starts 4 s + a bar of 3/4 at 60 in, and two bars of it last 6 s.
  expect(bars.content).toMatch(/^The whole mix, from 4\.1\.000 \(7 s\) to 6\.1\.000 \(13 s\), measured:\n/);
  const heard = measured<Placed>(bars);
  expect([heard.start, heard.end]).toEqual([
    { s: 7, at: "4.1" },
    { s: 13, at: "6.1" },
  ]);
  expect(heard.onsets.count).toBe(6);
  heard.onsets.at.forEach((onset, beat) => {
    expect(onset.s).toBeCloseTo(7 + beat, 1);
    expect(onset.at).toBe(`${4 + Math.floor(beat / 3)}.${(beat % 3) + 1}`);
  });
  const silent = measured<Placed>(before);
  expect([silent.start.s, silent.end.s, silent.onsets.count]).toEqual([4, 7, 0]);
});

test("asked to fix clipping and check, the Assistant analyses, turns the Track down, analyses again and compares: the clipping is gone", async () => {
  const history = new ProjectHistory(clippingProject());
  const { start, sent } = scripted(
    calls({ id: "before", name: "analyse_audio", input: {} }),
    calls({ id: "fix", name: "set_track_volume", input: { trackId: "lead", volume: 0.1 } }),
    // Compared in the same turn, straight after the analysis it compares.
    calls({ id: "after", name: "analyse_audio", input: {} }, { id: "compare", name: "compare_audio", input: {} }),
    says("Lead was clipping the mix, so I turned it down; the comparison shows the clipping gone."),
  );

  const outcome = await runRequest({ history, request: "the mix is clipping, fix it and check", start, listen });

  expect(outcome.error).toBeNull();
  const results = new Map(sent.flat().map((result) => [result.callId, result]));
  expect(results.get("before")!.content).toMatch(/^The whole mix, .*, measured:\nIts analysisId is a1, which compare_audio takes\.\n\{/);
  expect(results.get("after")!.content).toMatch(/\nIts analysisId is a2, which compare_audio takes\.\n\{/);

  const comparison = results.get("compare")!;
  expect(comparison.isError).toBe(false);
  const [heading, json, verdict] = comparison.content.split("\n");
  expect(heading).toBe("a1 and a2 compared, the whole mix from 1.1.000 (0 s) to 2.1.000 (2 s), before and after:");
  const compared = JSON.parse(json!) as Record<string, { before: number; after: number; change: number }>;
  expect(compared.clipped_samples!.before).toBeGreaterThan(0);
  expect(compared.clipped_samples!.after).toBe(0);
  expect(compared.true_peak_dbtp!.change).toBeLessThan(0);
  // Turned down by 26 dB, from twice unity to a tenth.
  expect(compared.integrated_lufs!.change).toBeCloseTo(-26, 0);
  expect(verdict).toMatch(/^Better: clipping is gone \(\d+ samples clipped before, none after\); the true peak is within the ceiling of -1 dBTP now/);
  expect(verdict).toMatch(/Worse: nothing\. Also: \d+(\.\d)? LU quieter overall/);

  // Comparing is not a change: the summary and the undo step are the fix alone.
  expect(outcome.changes).toEqual(["Set “Lead” to -20.0 dB"]);
  history.undo();
  expect(history.project).toEqual(clippingProject());
});

test("comparing analyses of different targets or ranges is refused, saying why", async () => {
  const history = new ProjectHistory(clippingProject());
  const { start, sent } = scripted(
    calls(
      { id: "mix", name: "analyse_audio", input: {} },
      { id: "lead", name: "analyse_audio", input: { trackId: "lead" } },
      { id: "first-beat", name: "analyse_audio", input: { end: 960 } },
      { id: "only-one", name: "compare_audio", input: {} },
      { id: "targets", name: "compare_audio", input: { before: "a1", after: "a2" } },
      { id: "ranges", name: "compare_audio", input: { before: "a1", after: "a3" } },
    ),
    says("Those can't be compared."),
  );

  await runRequest({ history, request: "compare them", start, listen });

  const results = new Map(sent.flat().map((result) => [result.callId, result]));
  const onlyOne = results.get("only-one")!;
  expect(onlyOne.isError).toBe(true);
  expect(onlyOne.content).toMatch(/^a3 is the only analysis of the whole mix from 1\.1\.000 \(0 s\) to 1\.2\.000 \(0\.5 s\) so far/);
  const targets = results.get("targets")!;
  expect(targets.isError).toBe(true);
  expect(targets.content).toMatch(/^a1 heard the whole mix and a2 heard Track lead \(“Lead”\) on its own: only two analyses of the same thing over the same range compare/);
  const ranges = results.get("ranges")!;
  expect(ranges.isError).toBe(true);
  expect(ranges.content).toMatch(
    /^a1 heard from 1\.1\.000 \(0 s\) to 2\.1\.000 \(2 s\) and a3 from 1\.1\.000 \(0 s\) to 1\.2\.000 \(0\.5 s\): only two analyses of the same thing over the same range compare/,
  );
});

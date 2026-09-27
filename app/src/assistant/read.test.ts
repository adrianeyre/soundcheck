/**
 * The Project summary of a real-sized song, and the read tools that return
 * what it leaves out.
 *
 * The reference song is 5 minutes at 120 BPM (150 bars of 4/4) on 16
 * Instrument Tracks, each an 8-bar Clip after another, all with notes: four
 * drum Tracks feeding a Drums Bus, and twelve Synths, every one with two
 * Effects. Automation moves the Pad's volume, the Lead's cutoff and reverb
 * mix, the Keys' pan, a Send, the Bus's volume and the Master's.
 */
import { expect, test } from "vitest";

import { createBus, createDrumTrack, createEffect, createInstrumentTrack, createProject, newId, type Automation, type Note, type Project } from "../project/model";
import { TICKS_PER_BEAT } from "../project/time";
import { validateProject } from "../project/validate";
import { estimatedTokens, requestMessage, SUMMARY_TOKEN_BUDGET } from "./context";
import { noteIds, projectSummary } from "./read";
import { InvalidToolCall, planToolCall } from "./tools";

const BAR = TICKS_PER_BEAT * 4;
const BARS = 150;

const DRUMS: [string, number][] = [
  ["Kick", 36],
  ["Snare", 38],
  ["Hats", 42],
  ["Perc", 39],
];
const SYNTHS = ["Bass", "Sub", "Pad", "Strings", "Lead", "Arp", "Keys", "Pluck", "Choir", "Brass", "FX", "Riser"];

/** An 8-bar Clip's notes: one every `step` ticks, on `pitch`, at velocities that vary as a musician's do. */
function notes(pitch: number, step: number, length: number): Note[] {
  return Array.from({ length: (8 * BAR) / step }, (_, index) => ({
    pitch: pitch + (index % 3 === 2 ? 7 : 0),
    start: index * step,
    length,
    velocity: 0.5 + ((index * 37) % 50) / 100,
  }));
}

/** Breakpoints every 8 bars through the song, ramping between `low` and `high`. */
function lane(setting: Automation["setting"], low: number, high: number): Automation {
  return {
    setting,
    breakpoints: Array.from({ length: BARS / 8 + 1 }, (_, index) => ({
      tick: index * 8 * BAR,
      value: index % 2 === 0 ? low : high,
      hold: index % 4 === 3,
    })),
  };
}

/** The reference song's Sections, end to end from bar 1: 142 of its 150 bars. */
const SECTIONS = [
  ["Intro", 8],
  ["Verse 1", 16],
  ["Pre-chorus 1", 8],
  ["Chorus 1", 16],
  ["Verse 2", 16],
  ["Pre-chorus 2", 8],
  ["Chorus 2", 16],
  ["Bridge", 8],
  ["Breakdown", 8],
  ["Build-up", 8],
  ["Chorus 3", 16],
  ["Outro", 14],
] as const;

function referenceSong(): Project {
  const project = createProject("Reference Song");
  project.tempo = 120;
  const bus = createBus("Drums");
  bus.insertChain.push(createEffect("compressor"));
  bus.automation.push(lane("volume", 0.8, 1));
  project.buses.push(bus);

  const drums = DRUMS.map(([name, pitch]) => {
    const track = createDrumTrack(name);
    track.output = bus.id;
    track.insertChain.push(createEffect("eq"), createEffect("compressor"));
    return { track, pitch, step: name === "Hats" ? TICKS_PER_BEAT / 4 : TICKS_PER_BEAT, length: TICKS_PER_BEAT / 4 };
  });
  const synths = SYNTHS.map((name, index) => {
    const track = createInstrumentTrack(name);
    track.insertChain.push(createEffect("eq"), createEffect(index % 2 === 0 ? "reverb" : "delay"));
    return { track, pitch: 36 + index * 3, step: TICKS_PER_BEAT / 2, length: TICKS_PER_BEAT / 2 };
  });
  for (const { track, pitch, step, length } of [...drums, ...synths]) {
    for (let bar = 0; bar < BARS; bar += 8) {
      const bars = Math.min(8, BARS - bar);
      const clipNotes = notes(pitch, step, length).filter((note) => note.start < bars * BAR);
      track.clips.push({ id: newId(), kind: "pattern", start: bar * BAR, length: bars * BAR, notes: clipNotes });
    }
    project.tracks.push(track);
  }

  const [pad, lead, keys] = ["Pad", "Lead", "Keys"].map((name) => project.tracks.find((track) => track.name === name)!);
  pad!.automation.push(lane("volume", 0.2, 0.9));
  lead!.automation.push(lane("instrument:cutoffHz", 400, 6000), lane(`effect:${lead!.insertChain[1]!.id}:mix`, 0, 0.5));
  keys!.sends.push({ busId: bus.id, level: 0.3 });
  keys!.automation.push(lane("pan", -0.5, 0.5), lane(`send:${bus.id}`, 0, 0.6));
  project.master.insertChain.push(createEffect("eq"), createEffect("compressor"));
  project.master.automation.push(lane("volume", 1, 0.9));
  let startBar = 1;
  for (const [name, bars] of SECTIONS) {
    project.sections.push({ id: newId(), name, startBar, bars });
    startBar += bars;
  }
  return project;
}

function read(name: string, input: unknown, project: Project) {
  const { report, commands } = planToolCall({ id: "read", name, input }, project);
  expect(commands).toEqual([]);
  return JSON.parse(report.slice(report.indexOf("\n") + 1)) as unknown;
}

test("the reference song is the size it says", () => {
  const song = referenceSong();
  expect(validateProject(song)).toBeNull();
  expect(song.tracks).toHaveLength(16);
  expect(song.tracks.reduce((clips, track) => clips + track.clips.length, 0)).toBe(16 * 19);
  // 150 bars of 4/4 at 120 BPM: 5 minutes.
  expect((BARS * 4 * 60) / song.tempo).toBe(300);
  expect(song.tracks.every((track) => track.clips.every((clip) => clip.kind === "pattern" && clip.notes.length > 0))).toBe(true);
});

test("the summary of a 5-minute, 16-Track song is under its token budget", () => {
  const song = referenceSong();
  const message = requestMessage("Make the chorus hit harder", song);
  expect(estimatedTokens(message)).toBeLessThan(SUMMARY_TOKEN_BUDGET);
  // It leaves out the settings, breakpoints and notes it summarises.
  expect(message).not.toContain('"breakpoints"');
  expect(message).not.toContain('"velocity"');
  expect(message).not.toContain('"settings"');
  expect(message).not.toContain('"volume":');
});

test("the summary lists every Track, Bus, Effect and Clip, and what is automated", () => {
  const song = referenceSong();
  const summary = projectSummary(song);
  expect(summary.tracks.map((track) => track.trackId)).toEqual(song.tracks.map((track) => track.id));
  expect(summary.tracks.flatMap((track) => track.clips.map((clip) => clip.clipId))).toEqual(
    song.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  expect(summary.tracks[0]).toMatchObject({ instrument: "drumSampler", preset: "Starter Kit", output: song.buses[0]!.id });
  expect(summary.tracks[0]!.clips[0]).toEqual({ clipId: song.tracks[0]!.clips[0]!.id, start: 0, length: 8 * BAR, notes: 32 });
  expect(summary.tracks.find((track) => track.name === "Keys")).toMatchObject({ sends: [song.buses[0]!.id], automated: ["pan", `send:${song.buses[0]!.id}`] });
  expect(summary.buses).toEqual([{ busId: song.buses[0]!.id, name: "Drums", insertChain: [{ effectId: song.buses[0]!.insertChain[0]!.id, effect: "compressor" }], automated: ["volume"], output: "master" }]);
  expect(summary.master.automated).toEqual(["volume"]);
  expect(summary.sections).toHaveLength(SECTIONS.length);
  expect(summary.sections![3]).toEqual({
    sectionId: song.sections[3]!.id,
    name: "Chorus 1",
    startBar: 33,
    bars: 16,
    start: 32 * BAR,
    end: 48 * BAR,
  });
});

test("the summary names the Reference Track when there is one, and leaves it out when there isn't", () => {
  const project = { ...createProject(), referenceTrack: { file: "audio/finished.wav" } };
  expect(projectSummary(project).referenceTrack).toEqual({ file: "audio/finished.wav" });
  expect(projectSummary(createProject())).not.toHaveProperty("referenceTrack");
});

test("a song without Sections leaves them out of the summary", () => {
  expect(projectSummary(createProject())).not.toHaveProperty("sections");
});

test("every setting of the reference song is reachable through read_channel", () => {
  const song = referenceSong();
  for (const track of song.tracks) {
    const instrument = track.kind === "instrument" ? track.instrument : null;
    expect(read("read_channel", { channel: track.id }, song)).toEqual({
      trackId: track.id,
      name: track.name,
      kind: track.kind,
      instrument: instrument?.type,
      preset: instrument && "preset" in instrument ? instrument.preset : undefined,
      ...(instrument?.type === "synth" && { settings: instrument.settings }),
      ...(instrument?.type === "drumSampler" && { pads: instrument.pads }),
      ...track.mixer,
      insertChain: track.insertChain.map((effect) => ({ effectId: effect.id, effect: effect.type, bypassed: effect.bypassed, settings: effect.settings })),
      output: track.output ?? "master",
      sends: track.sends,
      ...(track.automation.length > 0 && { automated: track.automation.map(({ setting }) => setting) }),
    });
  }
  const [bus] = song.buses;
  expect(read("read_channel", { channel: bus!.id }, song)).toMatchObject({
    busId: bus!.id,
    ...bus!.mixer,
    insertChain: [{ effectId: bus!.insertChain[0]!.id, settings: bus!.insertChain[0]!.settings }],
    output: "master",
  });
  expect(read("read_channel", { channel: "master" }, song)).toEqual({
    channel: "master",
    volume: song.master.volume,
    insertChain: song.master.insertChain.map((effect) => ({ effectId: effect.id, effect: effect.type, bypassed: false, settings: effect.settings })),
    automated: ["volume"],
  });
});

test("every breakpoint of the reference song is reachable through read_automation, whole or a range at a time", () => {
  const song = referenceSong();
  const channels = [...song.tracks, ...song.buses].map((channel) => ({ id: channel.id, automation: channel.automation }));
  channels.push({ id: "master", automation: song.master.automation });
  for (const { id, automation } of channels) {
    if (automation.length === 0) continue;
    expect(read("read_automation", { channel: id }, song)).toEqual(automation);
    for (const { setting, breakpoints } of automation) {
      expect(read("read_automation", { channel: id, setting }, song)).toEqual([{ setting, breakpoints }]);
      // Read 32 bars at a time, the ranges together give back every breakpoint once.
      const pieces = [0, 32, 64, 96, 128].map((bar) => read("read_automation", { channel: id, setting, start: bar * BAR, end: (bar + 32) * BAR }, song) as Automation[]);
      expect(pieces.flatMap(([piece]) => piece!.breakpoints)).toEqual(breakpoints);
    }
  }
  const pad = song.tracks.find((track) => track.name === "Pad")!;
  expect(() => planToolCall({ id: "read", name: "read_automation", input: { channel: pad.id, setting: "pan" } }, song)).toThrow(
    /has no Automation of "pan"\. Its automated settings are: volume\./,
  );
});

test("every note of the reference song is reachable through read_notes, with an id of its own", () => {
  const song = referenceSong();
  for (const track of song.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "pattern") continue;
      const listed = read("read_notes", { clipId: clip.id }, song) as (Note & { id: string })[];
      expect(listed.map(({ pitch, start, length, velocity }) => ({ pitch, start, length, velocity }))).toEqual(clip.notes);
      expect(new Set(listed.map((note) => note.id)).size).toBe(clip.notes.length);
    }
  }
  // A range reads the notes that start in it, from the start of the Clip.
  const clip = song.tracks[0]!.clips[0]!;
  const firstBar = read("read_notes", { clipId: clip.id, start: 0, end: BAR }, song) as Note[];
  expect(firstBar.map((note) => note.start)).toEqual([0, 960, 1920, 2880]);
  expect(planToolCall({ id: "read", name: "read_notes", input: { clipId: clip.id, start: BAR, end: 2 * BAR } }, song).report).toMatch(
    /^Clip \S+ on Track \S+ \(“Kick”\), 4 of its 32 notes, from tick 3840 up to tick 7680:\n/,
  );
});

function noteAt(start: number, pitch: number): Note {
  return { pitch, start, length: 120, velocity: 0.8 };
}

test("a note's id is its start and pitch, and stays the same while the others change", () => {
  expect(noteIds([noteAt(0, 36), noteAt(0, 42), noteAt(480, 36)])).toEqual(["0:36", "0:42", "480:36"]);
  // Taking out the first leaves the others' ids as they were.
  expect(noteIds([noteAt(0, 42), noteAt(480, 36)])).toEqual(["0:42", "480:36"]);
  // Two notes on the same pitch at the same tick are told apart.
  expect(noteIds([noteAt(0, 36), noteAt(0, 36)])).toEqual(["0:36", "0:36:2"]);
});

test("the read tools say what they can't read, and change nothing", () => {
  const song = referenceSong();
  const reading = (name: string, input: unknown) => () => planToolCall({ id: "read", name, input }, song);
  expect(reading("read_channel", { channel: "nope" })).toThrow(InvalidToolCall);
  expect(reading("read_channel", { channel: "nope" })).toThrow(/There is no Track or Bus nope/);
  expect(reading("read_notes", { clipId: "nope" })).toThrow(/There is no Clip nope/);
  expect(reading("read_notes", { clipId: song.tracks[0]!.clips[0]!.id, start: 960, end: 480 })).toThrow("end must be after start");
  expect(reading("read_automation", { channel: "master", start: -1 })).toThrow(/start must be a whole number of ticks/);
});

import { expect, test } from "vitest";

import { applyCommands } from "../project/commands";
import { EngineSync } from "../project/engine-sync";
import { deepFreeze, sampleProject } from "../project/fixtures";
import { defaultEffectSettings, EFFECT_TYPES, effectParams } from "../effect/effect-params";
import type { UserPreset } from "../preset/preset-library";
import { createInstrumentTrack, createProject, DEFAULT_SYNTH, STARTER_KIT, type InstrumentTrack } from "../project/model";
import { synthPreset, synthPresetNames } from "../instrument/synth-presets";
import { DEFAULT_SEND_LEVEL, routingProblem, sendProblem } from "../project/routing";
import { stereoWav } from "../song/test-wav";
import { requestMessage, SYSTEM_PROMPT } from "./context";
import { channelDetail, projectSummary } from "./read";
import {
  CORE_TOOL_DEFINITIONS,
  groupToolNames,
  InvalidToolCall,
  loadedReport,
  planToolCall,
  SMALL_CORE_TOOL_DEFINITIONS,
  TOOL_DEFINITIONS,
  TOOL_GROUPS,
  toolDefinitions,
  toolGroupOf,
  TRUE_PEAK_CEILING_DBTP,
  truePeakNote,
  type ToolDefinition,
  type ToolGroup,
} from "./tools";

function plan(name: string, input: unknown, project = sampleProject()) {
  return planToolCall({ id: "call-1", name, input }, project);
}

function planned(name: string, input: unknown, project = sampleProject()) {
  const result = applyCommands(project, plan(name, input, project).commands);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

test("every tool is described to the model with a closed schema", () => {
  expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
    "read_channel",
    "read_automation",
    "read_notes",
    "create_track",
    "rename_track",
    "delete_track",
    "set_instrument",
    "set_instrument_settings",
    "place_clip",
    "set_pattern_notes",
    "add_notes",
    "delete_notes",
    "move_notes",
    "resize_notes",
    "set_note_velocity",
    "quantise_notes",
    "transpose_notes",
    "move_clip",
    "delete_clip",
    "list_samples",
    "place_audio_clip",
    "trim_audio_clip",
    "copy_audio_clip",
    "separate_stems",
    "set_tempo",
    "add_tempo_change",
    "move_tempo_change",
    "delete_tempo_change",
    "set_time_signature",
    "add_section",
    "rename_section",
    "delete_section",
    "copy_clips",
    "insert_bars",
    "delete_bars",
    "duplicate_section",
    "move_section",
    "set_track_volume",
    "set_track_pan",
    "set_track_mute",
    "set_track_solo",
    "set_master_volume",
    "add_bus",
    "rename_bus",
    "delete_bus",
    "set_output",
    "add_send",
    "remove_send",
    "set_send_level",
    "set_bus_volume",
    "set_bus_pan",
    "set_bus_mute",
    "set_bus_solo",
    "set_automation",
    "clear_automation",
    "add_effect",
    "remove_effect",
    "move_effect",
    "set_effect_settings",
    "load_preset",
    "save_preset",
    "save_kit",
    "load_tools",
    "analyse_audio",
    "compare_audio",
    "compare_to_reference",
  ]);
  for (const tool of TOOL_DEFINITIONS) {
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.input_schema.additionalProperties).toBe(false);
  }
});

test("the core is reading, Tracks, Clips, the mixer basics, listening and load_tools; the rest are in groups", () => {
  expect(CORE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
    "read_channel",
    "read_automation",
    "read_notes",
    "create_track",
    "rename_track",
    "delete_track",
    "place_clip",
    "move_clip",
    "delete_clip",
    "set_track_volume",
    "set_track_pan",
    "set_track_mute",
    "set_track_solo",
    "set_master_volume",
    "load_tools",
    "analyse_audio",
    "compare_audio",
    "compare_to_reference",
  ]);
  const groups = Object.fromEntries(Object.keys(TOOL_GROUPS).map((group) => [group, groupToolNames(group as ToolGroup)]));
  expect(groups).toEqual({
    notes: [
      "set_pattern_notes",
      "add_notes",
      "delete_notes",
      "move_notes",
      "resize_notes",
      "set_note_velocity",
      "quantise_notes",
      "transpose_notes",
    ],
    routing: [
      "add_bus",
      "rename_bus",
      "delete_bus",
      "set_output",
      "add_send",
      "remove_send",
      "set_send_level",
      "set_bus_volume",
      "set_bus_pan",
      "set_bus_mute",
      "set_bus_solo",
    ],
    automation: ["set_automation", "clear_automation"],
    time: ["set_tempo", "add_tempo_change", "move_tempo_change", "delete_tempo_change", "set_time_signature"],
    sounds: ["set_instrument", "set_instrument_settings", "add_effect", "remove_effect", "move_effect", "set_effect_settings", "load_preset", "save_preset", "save_kit"],
    audio_clips: ["list_samples", "place_audio_clip", "trim_audio_clip", "copy_audio_clip", "separate_stems"],
    arrangement: ["add_section", "rename_section", "delete_section", "copy_clips", "insert_bars", "delete_bars", "duplicate_section", "move_section"],
  });
  // Every tool is in the core or in exactly one group.
  expect([...CORE_TOOL_DEFINITIONS.map((tool) => tool.name), ...Object.values(groups).flat()].toSorted()).toEqual(
    TOOL_DEFINITIONS.map((tool) => tool.name).toSorted(),
  );
  for (const [group, names] of Object.entries(groups)) {
    for (const name of names) expect(toolGroupOf(name)).toBe(group);
  }
  expect(toolGroupOf("create_track")).toBeUndefined();
});

/** How much of the model's context tool definitions take, as the JSON sent. */
function size(definitions: readonly unknown[]): number {
  return JSON.stringify(definitions).length;
}

test("the core's definitions are smaller than every tool's, and loading groups adds theirs in the fixed order", () => {
  // Every tool as it stood before the groups, when all of them went on every turn.
  const everyTool = TOOL_DEFINITIONS.filter((tool) => tool.name !== "load_tools");
  // About 12,000 characters of JSON against 22,000: the groups' tools are
  // what the v3 slices add, so the gap grows with each.
  expect(size(CORE_TOOL_DEFINITIONS)).toBeLessThan(size(everyTool));

  expect(toolDefinitions([])).toEqual(CORE_TOOL_DEFINITIONS);
  expect(toolDefinitions(Object.keys(TOOL_GROUPS) as ToolGroup[])).toEqual(TOOL_DEFINITIONS);
  const loaded = toolDefinitions(["time", "notes"]).map((tool) => tool.name);
  expect(loaded.filter((name) => toolGroupOf(name) !== undefined)).toEqual([...groupToolNames("notes"), ...groupToolNames("time")]);
});

test("load_tools takes one of the groups, and says which tools it loads", () => {
  const schema = TOOL_DEFINITIONS.find((tool) => tool.name === "load_tools")!.input_schema;
  expect(schema.properties.group).toMatchObject({ enum: Object.keys(TOOL_GROUPS) });
  expect(plan("load_tools", { group: "arrangement" }, createProject())).toMatchObject({ commands: [], load: "arrangement" });
  expect(loadedReport("arrangement")).toContain("add_section, rename_section, delete_section");
  expect(loadedReport("audio_clips")).toContain("list_samples, place_audio_clip, trim_audio_clip, copy_audio_clip");
  expect(() => plan("load_tools", { group: "effects" }, createProject())).toThrow(InvalidToolCall);
});

function toolNames(definitions: readonly ToolDefinition[]): string[] {
  return definitions.map((tool) => tool.name);
}

test("the smaller core leaves read_automation, set_track_solo, set_master_volume and compare_to_reference to their groups", () => {
  const moved = ["read_automation", "set_track_solo", "set_master_volume", "compare_to_reference"];
  expect(toolNames(SMALL_CORE_TOOL_DEFINITIONS)).toEqual(toolNames(CORE_TOOL_DEFINITIONS).filter((name) => !moved.includes(name)));
  expect(toolNames(toolDefinitions(["automation"], true))).toContain("read_automation");
  expect(toolNames(toolDefinitions(["routing"], true))).toEqual(expect.arrayContaining(["set_track_solo", "set_master_volume"]));
  expect(toolGroupOf("read_automation", true)).toBe("automation");
  expect(toolGroupOf("read_automation")).toBeUndefined();
  expect(toolGroupOf("compare_to_reference", true)).toBe("sounds");
  expect(groupToolNames("routing", true)).toEqual([...groupToolNames("routing"), "set_track_solo", "set_master_volume"].toSorted(
    (a, b) => toolNames(TOOL_DEFINITIONS).indexOf(a) - toolNames(TOOL_DEFINITIONS).indexOf(b),
  ));
  expect(loadedReport("automation", true)).toContain("read_automation, set_automation, clear_automation");
  // Every tool is still there to load, whichever core a Request starts with.
  expect(toolNames(toolDefinitions(Object.keys(TOOL_GROUPS) as ToolGroup[], true))).toEqual(toolNames(TOOL_DEFINITIONS));
  // A smaller core, sent on every turn: about a sixth less than the whole one.
  expect(JSON.stringify(SMALL_CORE_TOOL_DEFINITIONS).length).toBeLessThan(JSON.stringify(CORE_TOOL_DEFINITIONS).length * 0.85);
});

test("creating a Track makes one with the Synth, and tells the model its id", () => {
  const project = planned("create_track", { name: "Kick", kind: "instrument" }, createProject());
  const track = project.tracks[0]!;
  expect(track).toMatchObject({ name: "Kick", kind: "instrument" });
  expect(plan("create_track", { name: "Kick", kind: "instrument" }, createProject()).report).toMatch(/trackId is /);
});

test("a Track can be created anywhere in the list", () => {
  const project = planned("create_track", { name: "Pad", kind: "audio", index: 0 });
  expect(project.tracks.map((track) => track.name)).toEqual(["Pad", "Keys", "Bass", "Vocals", "Drums"]);
  expect(project.tracks[0]!.kind).toBe("audio");
});

test("Tracks are renamed and deleted by the id the Project lists", () => {
  expect(planned("rename_track", { trackId: "bass", name: "Sub Bass" }).tracks[1]!.name).toBe("Sub Bass");
  expect(planned("delete_track", { trackId: "keys" }).tracks.map((track) => track.id)).toEqual([
    "bass",
    "vocals",
    "drums",
  ]);
});

test("Sections are added, renamed and deleted, and the model is told each one's id and ticks", () => {
  const added = plan("add_section", { name: "Chorus", startBar: 9, bars: 8 });
  const project = planned("add_section", { name: "Chorus", startBar: 9, bars: 8 });
  expect(project.sections).toMatchObject([{ name: "Chorus", startBar: 9, bars: 8 }]);
  expect(added.report).toMatch(/at bars 9–16, ticks 30720 up to 61440, whose sectionId is /);
  expect(added.change).toBe("Named bars 9–16 “Chorus”");

  const id = project.sections[0]!.id;
  expect(planned("rename_section", { sectionId: id, name: "Last chorus" }, project).sections[0]!.name).toBe("Last chorus");
  expect(planned("delete_section", { sectionId: id }, project).sections).toEqual([]);
  expect(plan("delete_section", { sectionId: id }, project).report).toMatch(/nothing in its bars changed/);
  expect(() => plan("rename_section", { sectionId: "nope", name: "X" }, project)).toThrow(/The Sections are: .*Chorus/);
});

test("a Section that would overlap another is refused, naming the one in the way", () => {
  const project = planned("add_section", { name: "Verse", startBar: 5, bars: 8 });
  for (const [startBar, bars] of [
    [1, 5],
    [12, 1],
    [6, 2],
  ]) {
    expect(() => plan("add_section", { name: "Chorus", startBar, bars }, project)).toThrow(
      /would overlap the Section “Verse” \(bars 5–12\)/,
    );
  }
  expect(planned("add_section", { name: "Chorus", startBar: 13, bars: 8 }, project).sections.map((s) => s.name)).toEqual([
    "Verse",
    "Chorus",
  ]);
  for (const input of [
    { name: "X", startBar: 0, bars: 4 },
    { name: "X", startBar: 1, bars: 0 },
    { name: "X", startBar: 1.5, bars: 4 },
    { name: " ", startBar: 1, bars: 4 },
  ]) {
    expect(() => plan("add_section", input)).toThrow(InvalidToolCall);
  }
});

/** The sample song named in three 2-bar Sections: Verse, Chorus and Verse again. */
function sectioned() {
  const result = applyCommands(sampleProject(), [
    { type: "addSection", section: { id: "verse-1", name: "Verse", startBar: 1, bars: 2 } },
    { type: "addSection", section: { id: "chorus", name: "Chorus", startBar: 3, bars: 2 } },
    { type: "addSection", section: { id: "verse-2", name: "Verse", startBar: 5, bars: 2 } },
  ]);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

test("Clips are copied by an offset, onto their own Tracks or all onto another", () => {
  const project = sampleProject();
  const copied = plan("copy_clips", { clipIds: ["keys-1"], offset: 7680 }, project);
  expect(copied.change).toBe("Copied a Clip on “Keys” to 3.1.000");
  const result = applyCommands(project, copied.commands);
  if (!result.ok) throw new Error(result.error);
  const keys = result.project.tracks[0]!.clips;
  expect(keys.map((clip) => clip.start)).toEqual([0, 7680]);
  expect(keys[1]).toEqual({ ...project.tracks[0]!.clips[0]!, id: keys[1]!.id, start: 7680 });
  expect(copied.report).toContain(`whose clipId is ${keys[1]!.id}`);

  const onBass = planned("copy_clips", { clipIds: ["keys-1"], offset: 0, trackId: "bass" }, project);
  expect(onBass.tracks[1]!.clips).toHaveLength(1);
  expect(onBass.tracks[0]!.clips).toHaveLength(1);

  const both = plan("copy_clips", { clipIds: ["keys-1", "vocals-1"], offset: 3840 }, project);
  expect(both.commands).toHaveLength(2);
  expect(both.change).toBe("Copied 2 Clips on “Keys”, “Vocals” from 1.1.000 to 2.1.000");

  expect(() => plan("copy_clips", { clipIds: ["vocals-1"], offset: 0, trackId: "keys" }, project)).toThrow(/another Audio Track/i);
  expect(() => plan("copy_clips", { clipIds: ["vocals-1"], offset: -3841 }, project)).toThrow(/no less than -3840/);
  expect(() => plan("copy_clips", { clipIds: ["keys-1", "keys-1"], offset: 0 }, project)).toThrow(/listed twice/);
  expect(() => plan("copy_clips", { clipIds: [], offset: 0 }, project)).toThrow(InvalidToolCall);
  expect(() => plan("copy_clips", { clipIds: ["keys-1"], offset: 0.5 }, project)).toThrow(InvalidToolCall);
});

test("bars are inserted and deleted on everything at once, as one command, and the model is told the Sections after", () => {
  const project = sectioned();
  const inserted = plan("insert_bars", { at: 3, count: 2 }, project);
  expect(inserted.commands).toMatchObject([{ type: "rearrange" }]);
  expect(inserted.change).toBe("Inserted 2 bars before bar 3");
  expect(inserted.report).toMatch(/read them again/);
  expect(inserted.report).toContain("“Chorus” (bars 5–6, ticks 15360 up to 23040, sectionId chorus)");
  const after = planned("insert_bars", { at: 3, count: 2 }, project);
  expect(after.tracks[2]!.clips[0]!.start).toBe(3840);
  expect(after.tracks[2]!.automation[0]!.breakpoints.map((point) => point.tick)).toContain(7680 + 7680);

  const deleted = plan("delete_bars", { startBar: 1, bars: 2 }, project);
  expect(deleted.change).toBe("Deleted bars 1–2");
  // The Keys Clip is all in them; the Vocals Clip from bar 2 is split at bar 3.
  expect(deleted.report).toMatch(/1 Clip was split at its edges, and 1 Clip was deleted with the bars/);
  expect(deleted.report).toContain("“Chorus” (bars 1–2, ticks 0 up to 7680, sectionId chorus)");
  const closed = planned("delete_bars", { startBar: 1, bars: 2 }, project);
  expect(closed.tracks[0]!.clips).toEqual([]);
  expect(closed.tracks[2]!.clips[0]).toMatchObject({ id: expect.any(String), start: 0 });
  expect(closed.sections.map((section) => section.id)).toEqual(["chorus", "verse-2"]);

  expect(() => plan("insert_bars", { at: 0, count: 1 }, project)).toThrow(InvalidToolCall);
  expect(() => plan("delete_bars", { startBar: 1, bars: 1.5 }, project)).toThrow(InvalidToolCall);
});

test("a Section is duplicated and moved by its id or its name, and a name two Sections share is refused", () => {
  const project = sectioned();
  const repeated = plan("duplicate_section", { section: "chorus" }, project);
  expect(repeated.change).toBe("Duplicated the Section “Chorus” (bars 3–4) to bars 5–6");
  expect(planned("duplicate_section", { section: "CHORUS" }, project).sections.map((section) => [section.name, section.startBar])).toEqual([
    ["Verse", 1],
    ["Chorus", 3],
    ["Chorus", 5],
    ["Verse", 7],
  ]);
  expect(planned("duplicate_section", { section: "chorus", at: 1 }, project).sections[0]).toMatchObject({ name: "Chorus", startBar: 1 });

  const moved = plan("move_section", { section: "Chorus", to: 1 }, project);
  expect(moved.change).toBe("Moved the Section “Chorus” (bars 3–4) to bars 1–2");
  expect(planned("move_section", { section: "Chorus", to: 7 }, project).sections.map((section) => section.id)).toEqual([
    "verse-1",
    "verse-2",
    "chorus",
  ]);

  expect(() => plan("move_section", { section: "Verse", to: 7 }, project)).toThrow(/2 Sections are called “Verse”: give the sectionId/);
  expect(planned("move_section", { section: "verse-1", to: 7 }, project).sections.map((section) => section.id)).toEqual([
    "chorus",
    "verse-2",
    "verse-1",
  ]);
  expect(() => plan("duplicate_section", { section: "Bridge" }, project)).toThrow(/no Section with id or name Bridge. The Sections are: verse-1/);
  expect(() => plan("move_section", { section: "chorus", to: 6 }, project)).toThrow(/Bar 6 is inside the Section “Verse” \(bars 5–6\)/);
  expect(() => plan("move_section", { section: "chorus", to: 3 }, project)).toThrow(/already there/);
  expect(() => plan("duplicate_section", { section: "chorus", at: 6 }, project)).toThrow(/Bar 6 is inside the Section “Verse”/);
});

test("the model is told what Sections are, and the summary lists them", () => {
  const project = planned("add_section", { name: "Intro", startBar: 1, bars: 4 });
  expect(SYSTEM_PROMPT).toMatch(/Sections never overlap/);
  expect(requestMessage("Make the intro quieter", project)).toContain(`"sections":[{"sectionId":"${project.sections[0]!.id}","name":"Intro"`);
  expect(projectSummary(project).sections).toEqual([
    { sectionId: project.sections[0]!.id, name: "Intro", startBar: 1, bars: 4, start: 0, end: 15360 },
  ]);
});

test("the tempo is set in quarter notes per minute", () => {
  expect(planned("set_tempo", { tempo: 128 }).tempo).toBe(128);
});

function instrumentTrack(project: ReturnType<typeof sampleProject>, id: string): InstrumentTrack {
  const track = project.tracks.find((candidate) => candidate.id === id);
  if (track?.kind !== "instrument") throw new Error(`${id} is not an Instrument Track`);
  return track;
}

test("a Track can be given the Synth with a factory preset, settings and all", () => {
  const project = planned("set_instrument", { trackId: "drums", instrument: "synth", preset: "Sub Bass" });
  expect(instrumentTrack(project, "drums").instrument).toEqual({
    type: "synth",
    preset: "Sub Bass",
    settings: synthPreset("Sub Bass")!.settings,
  });
});

test("a Track can be given the Drum Sampler, and the model is told which pitch plays which Pad", () => {
  const input = { trackId: "keys", instrument: "drumSampler" };
  const project = planned("set_instrument", input);
  const { instrument, clips } = instrumentTrack(project, "keys");
  expect(instrument).toMatchObject({ type: "drumSampler", preset: "Starter Kit", pads: STARTER_KIT });
  // Its Pattern Clips stay, to be played by the new Instrument.
  expect(clips).toHaveLength(1);
  expect(plan("set_instrument", input).report).toContain("Kick 36");
});

test("a preset the Instrument doesn't have is refused, and its real ones are named", () => {
  expect(() => plan("set_instrument", { trackId: "bass", instrument: "synth", preset: "Wobble Bass" })).toThrow(
    /no preset called "Wobble Bass".*Sub Bass/,
  );
  // The Synth's presets are not Kits.
  expect(() => plan("set_instrument", { trackId: "drums", instrument: "drumSampler", preset: "Sub Bass" })).toThrow(
    /Starter Kit/,
  );
  expect(() => plan("set_instrument", { trackId: "vocals", instrument: "synth" })).toThrow(/Audio Track/);
});

test("a Pattern Clip is placed with its notes, and the model is told its id", () => {
  const input = { trackId: "bass", start: 3840, length: 3840, notes: [{ pitch: 33, start: 0, length: 960 }] };
  const project = planned("place_clip", input);
  const [clip] = instrumentTrack(project, "bass").clips;
  expect(clip).toMatchObject({ kind: "pattern", start: 3840, length: 3840 });
  expect(clip!.notes).toEqual([{ pitch: 33, start: 0, length: 960, velocity: 0.8 }]);
  expect(plan("place_clip", input).report).toMatch(/clipId is \S+\.$/);
});

test("a Pattern Clip's notes are replaced, not added to", () => {
  const notes = [
    { pitch: 67, start: 480, length: 240, velocity: 0.5 },
    { pitch: 62, start: 0, length: 240 },
  ];
  const project = planned("set_pattern_notes", { clipId: "keys-1", notes });
  expect(instrumentTrack(project, "keys").clips[0]!.notes).toEqual([
    { pitch: 62, start: 0, length: 240, velocity: 0.8 },
    { pitch: 67, start: 480, length: 240, velocity: 0.5 },
  ]);
  expect(
    instrumentTrack(planned("set_pattern_notes", { clipId: "keys-1", notes: [] }), "keys").clips[0]!.notes,
  ).toEqual([]);
});

function keysClipNotes(project: ReturnType<typeof sampleProject>) {
  return instrumentTrack(project, "keys").clips[0]!.notes;
}

// keys-1 holds 60 at 0 (id 0:60) and 64 at 960 (id 960:64), each 480 long.
test("notes are added to a Clip, keeping the rest, and reported with their ids", () => {
  const input = { clipId: "keys-1", notes: [{ pitch: 67, start: 480, length: 240, velocity: 0.5 }] };
  expect(keysClipNotes(planned("add_notes", input))).toEqual([
    { pitch: 60, start: 0, length: 480, velocity: 0.8 },
    { pitch: 67, start: 480, length: 240, velocity: 0.5 },
    { pitch: 64, start: 960, length: 480, velocity: 0.7 },
  ]);
  const result = plan("add_notes", input);
  expect(result.commands).toHaveLength(1);
  expect(result.report).toContain('"id":"480:67"');
  // One on another's pitch and start replaces it, as the Piano Roll's drawing does.
  const over = planned("add_notes", { clipId: "keys-1", notes: [{ pitch: 60, start: 0, length: 960 }] });
  expect(keysClipNotes(over)).toEqual([
    { pitch: 60, start: 0, length: 960, velocity: 0.8 },
    { pitch: 64, start: 960, length: 480, velocity: 0.7 },
  ]);
});

test("notes are deleted, moved, resized and softened by id, and the others stay as they were", () => {
  expect(keysClipNotes(planned("delete_notes", { clipId: "keys-1", noteIds: ["960:64"] }))).toEqual([
    { pitch: 60, start: 0, length: 480, velocity: 0.8 },
  ]);
  const moved = plan("move_notes", { clipId: "keys-1", noteIds: ["0:60"], ticks: 240, semitones: 12 });
  expect(keysClipNotes(planned("move_notes", { clipId: "keys-1", noteIds: ["0:60"], ticks: 240, semitones: 12 }))).toEqual([
    { pitch: 72, start: 240, length: 480, velocity: 0.8 },
    { pitch: 64, start: 960, length: 480, velocity: 0.7 },
  ]);
  // The model is told the moved note's new id.
  expect(moved.report).toContain('"id":"240:72"');
  expect(moved.change).toBe("Moved 1 note in a Clip on “Keys” 240 ticks later and 12 semitones up");
  expect(keysClipNotes(planned("move_notes", { clipId: "keys-1", noteIds: ["960:64"], semitones: -4 }))).toEqual([
    { pitch: 60, start: 0, length: 480, velocity: 0.8 },
    { pitch: 60, start: 960, length: 480, velocity: 0.7 },
  ]);

  expect(keysClipNotes(planned("resize_notes", { clipId: "keys-1", noteIds: ["0:60", "960:64"], by: 240 }))).toEqual([
    { pitch: 60, start: 0, length: 720, velocity: 0.8 },
    { pitch: 64, start: 960, length: 720, velocity: 0.7 },
  ]);
  expect(keysClipNotes(planned("resize_notes", { clipId: "keys-1", noteIds: ["960:64"], length: 1920 }))).toEqual([
    { pitch: 60, start: 0, length: 480, velocity: 0.8 },
    { pitch: 64, start: 960, length: 1920, velocity: 0.7 },
  ]);
  expect(keysClipNotes(planned("set_note_velocity", { clipId: "keys-1", noteIds: ["960:64"], velocity: 0.2 }))).toEqual([
    { pitch: 60, start: 0, length: 480, velocity: 0.8 },
    { pitch: 64, start: 960, length: 480, velocity: 0.2 },
  ]);
});

test("a note moved onto another's pitch and start replaces it, as in the Piano Roll, and the model is told", () => {
  const result = plan("move_notes", { clipId: "keys-1", noteIds: ["0:60"], ticks: 960, semitones: 4 });
  expect(result.change).toContain("replacing 1 note they landed on");
  expect(keysClipNotes(planned("move_notes", { clipId: "keys-1", noteIds: ["0:60"], ticks: 960, semitones: 4 }))).toEqual([
    { pitch: 64, start: 960, length: 480, velocity: 0.8 },
  ]);
});

test("an unknown note id is refused, naming it, and none of the call is applied", () => {
  const project = deepFreeze(sampleProject());
  const call = { clipId: "keys-1", noteIds: ["0:60", "480:61"], velocity: 0.1 };
  expect(() => plan("set_note_velocity", call, project)).toThrow(InvalidToolCall);
  expect(() => plan("set_note_velocity", call, project)).toThrow("Clip keys-1 has no note with id 480:61.");
  expect(() => plan("delete_notes", { clipId: "keys-1", noteIds: ["1:2", "3:4"] }, project)).toThrow(
    "Clip keys-1 has no notes with ids 1:2, 3:4",
  );
  expect(() => plan("move_notes", { clipId: "vocals-1", noteIds: ["0:60"], ticks: 1 }, project)).toThrow(/Audio Clip/);
});

test("a move out of the Clip or past MIDI, or a resize to nothing, is refused", () => {
  const project = deepFreeze(sampleProject());
  expect(() => plan("move_notes", { clipId: "keys-1", noteIds: ["0:60"], ticks: -1 }, project)).toThrow(
    /note 0:60 by -1 ticks would start it at -1, outside its Clip/,
  );
  expect(() => plan("move_notes", { clipId: "keys-1", noteIds: ["960:64"], ticks: 2880 }, project)).toThrow(/outside its Clip/);
  expect(() => plan("move_notes", { clipId: "keys-1", noteIds: ["960:64"], semitones: 64 }, project)).toThrow(
    /would take it to 128, past the MIDI notes 0 to 127/,
  );
  expect(() => plan("move_notes", { clipId: "keys-1", noteIds: ["960:64"] }, project)).toThrow(/ticks, semitones or both/);
  expect(() => plan("resize_notes", { clipId: "keys-1", noteIds: ["960:64"], by: -480 }, project)).toThrow(/leave nothing/);
  expect(() => plan("resize_notes", { clipId: "keys-1", noteIds: ["960:64"], by: 1, length: 2 }, project)).toThrow(
    /either length or by/,
  );
  expect(() => plan("set_note_velocity", { clipId: "keys-1", noteIds: ["960:64"], velocity: 2 }, project)).toThrow(/velocity/);
});

function withKeysNotes(notes: { pitch: number; start: number; length: number; velocity: number }[]) {
  const project = sampleProject();
  instrumentTrack(project, "keys").clips[0]!.notes = notes;
  return project;
}

test("quantising at 50% moves each note halfway to the grid, and a range quantises only the notes starting in it", () => {
  const project = withKeysNotes([
    { pitch: 60, start: 20, length: 240, velocity: 0.8 },
    { pitch: 62, start: 260, length: 240, velocity: 0.8 },
    { pitch: 64, start: 1000, length: 240, velocity: 0.8 },
  ]);
  // A 1/16 is 240 ticks: 20 goes halfway to 0, 260 halfway to 240, 1000 halfway to 960.
  expect(keysClipNotes(planned("quantise_notes", { clipId: "keys-1", grid: "1/16", strength: 50 }, project))).toEqual([
    { pitch: 60, start: 10, length: 240, velocity: 0.8 },
    { pitch: 62, start: 250, length: 240, velocity: 0.8 },
    { pitch: 64, start: 980, length: 240, velocity: 0.8 },
  ]);
  expect(keysClipNotes(planned("quantise_notes", { clipId: "keys-1", grid: "1/4", start: 960 }, project))).toEqual([
    { pitch: 60, start: 20, length: 240, velocity: 0.8 },
    { pitch: 62, start: 260, length: 240, velocity: 0.8 },
    { pitch: 64, start: 960, length: 240, velocity: 0.8 },
  ]);
  // Triplets: a 1/8 triplet is 320 ticks.
  expect(keysClipNotes(planned("quantise_notes", { clipId: "keys-1", grid: "1/8T", end: 960 }, project))).toEqual([
    { pitch: 60, start: 0, length: 240, velocity: 0.8 },
    { pitch: 62, start: 320, length: 240, velocity: 0.8 },
    { pitch: 64, start: 1000, length: 240, velocity: 0.8 },
  ]);
  expect(() => plan("quantise_notes", { clipId: "keys-1", grid: "off" }, project)).toThrow(/grid/);
  expect(() => plan("quantise_notes", { clipId: "keys-1", grid: "1/16", start: 2000 }, project)).toThrow(
    "Clip keys-1 has no notes, from tick 2000 to the end of the Clip",
  );
});

test("the quantise grids are the Piano Roll's, 1/4 to 1/32 with triplets, and the note tools say how bars become ticks", () => {
  const schema = TOOL_DEFINITIONS.find((tool) => tool.name === "quantise_notes")!.input_schema;
  expect(schema.properties.grid).toMatchObject({ enum: ["1/4", "1/8", "1/16", "1/32", "1/4T", "1/8T", "1/16T", "1/32T"] });
  for (const name of ["add_notes", "move_notes", "resize_notes", "quantise_notes", "transpose_notes"]) {
    expect(TOOL_DEFINITIONS.find((tool) => tool.name === name)!.description).toContain("3840 to a bar of 4/4");
  }
});

test("transposing moves every note of a Clip, or of a range, by semitones; on drums only onto a Pad", () => {
  expect(keysClipNotes(planned("transpose_notes", { clipId: "keys-1", semitones: -12 }))).toEqual([
    { pitch: 48, start: 0, length: 480, velocity: 0.8 },
    { pitch: 52, start: 960, length: 480, velocity: 0.7 },
  ]);
  expect(keysClipNotes(planned("transpose_notes", { clipId: "keys-1", semitones: 2, start: 480 }))).toEqual([
    { pitch: 60, start: 0, length: 480, velocity: 0.8 },
    { pitch: 66, start: 960, length: 480, velocity: 0.7 },
  ]);
  const project = sampleProject();
  const drums = instrumentTrack(project, "drums");
  drums.clips.push({ id: "drums-1", kind: "pattern", start: 0, length: 3840, notes: [{ pitch: 36, start: 0, length: 240, velocity: 1 }] });
  // The first pitch past an octave up that no Starter Kit Pad plays.
  const pads = drums.instrument.type === "drumSampler" ? drums.instrument.pads.map((pad) => pad.note) : [];
  const off = [12, 13, 14, 15].find((semitones) => !pads.includes(36 + semitones))!;
  expect(() => plan("transpose_notes", { clipId: "drums-1", semitones: off }, project)).toThrow(
    new RegExp(`Note 0:36's pitch ${36 + off} plays no Pad on “Drums”`),
  );
  expect(() => plan("move_notes", { clipId: "drums-1", noteIds: ["0:36"], semitones: off }, project)).toThrow(/plays no Pad/);
});

test("Clips are moved, onto another Track too, and deleted", () => {
  const moved = planned("move_clip", { clipId: "keys-1", start: 7680, trackId: "bass" });
  expect(instrumentTrack(moved, "keys").clips).toEqual([]);
  expect(instrumentTrack(moved, "bass").clips[0]).toMatchObject({ id: "keys-1", start: 7680 });
  expect(planned("move_clip", { clipId: "vocals-1", start: 0 }).tracks[2]!.clips[0]!.start).toBe(0);
  expect(planned("delete_clip", { clipId: "vocals-1" }).tracks[2]!.clips).toEqual([]);
});

test("moving or deleting an Audio Clip moves or silences it in the engine", () => {
  const samples = new Map([["audio/take1.wav", { name: "take1.wav", bytes: stereoWav([0.5], [0.5], 48_000) }]]);
  const sync = new EngineSync();
  const audioClips = (project: ReturnType<typeof sampleProject>) =>
    sync.update(project, samples).filter((command) => command.type === "setTrackAudioClips");
  // Vocals are the third Track, and the engine's third: it plays every Track.
  const project = sampleProject();
  expect(audioClips(project)).toEqual([{ type: "setTrackAudioClips", track: 2, clips: [3840, 4, 1, 0.5] }]);
  const moved = planned("move_clip", { clipId: "vocals-1", start: 960 }, project);
  expect(audioClips(moved)).toEqual([{ type: "setTrackAudioClips", track: 2, clips: [960, 4, 1, 0.5] }]);
  const deleted = planned("delete_clip", { clipId: "vocals-1" }, moved);
  expect(audioClips(deleted)).toEqual([{ type: "setTrackAudioClips", track: 2, clips: [] }]);
});

test("the model sees an Audio Clip's file and where in it the Clip starts", () => {
  const vocals = projectSummary(sampleProject()).tracks[2]!;
  expect(vocals).toMatchObject({ trackId: "vocals", kind: "audio" });
  expect(vocals.clips).toEqual([
    { clipId: "vocals-1", start: 3840, length: 7680, duration: 4, file: "audio/take1.wav", fileOffset: 0.5 },
  ]);  // It has no notes to read.
  expect(() => plan("read_notes", { clipId: "vocals-1" })).toThrow("Clip vocals-1 is an Audio Clip: it has no notes");
});

function keysNotes(notes: unknown) {
  return { clipId: "keys-1", notes };
}

test("a note out of range, outside its Clip, or on no Pad is refused with the reason", () => {
  const project = deepFreeze(sampleProject());
  expect(() => plan("set_pattern_notes", keysNotes([{ pitch: 128, start: 0, length: 1 }]), project)).toThrow(
    /Note 1's pitch must be a MIDI note number from 0 to 127/,
  );
  expect(() =>
    plan(
      "set_pattern_notes",
      keysNotes([
        { pitch: 60, start: 0, length: 1 },
        { pitch: 60, start: 3840, length: 1 },
      ]),
      project,
    ),
  ).toThrow(/Note 2's start must be .* 0 to 3839/);
  // The Drums play the Starter Kit, which has no Pad on 50.
  expect(() =>
    plan(
      "place_clip",
      { trackId: "drums", start: 0, length: 3840, notes: [{ pitch: 50, start: 0, length: 1 }] },
      project,
    ),
  ).toThrow(/pitch 50 plays no Pad.*Kick 36/);
  expect(() => plan("move_clip", { clipId: "keys-1", start: 0, trackId: "drums" }, project)).toThrow(/plays no Pad/);
});

test("a Track's volume is set as a linear gain, and the summary reads it in decibels", () => {
  expect(planned("set_track_volume", { trackId: "bass", volume: 0.5 }).tracks[1]!.mixer).toMatchObject({
    volume: 0.5,
    pan: 0,
  });
  expect(plan("set_track_volume", { trackId: "bass", volume: 0.5 }).change).toBe("Set “Bass” to -6.0 dB");
});

test("setting an automated volume or pan says its Automation overrides it", () => {
  // In the sample song the Vocals' volume and the Master's are automated.
  expect(plan("set_track_volume", { trackId: "vocals", volume: 0.5 }).report).toBe(
    "Track vocals (“Vocals”) is at volume 0.5 (-6.0 dB). But its volume is automated, and its Automation overrides this value while the song plays: the musician hears the Automation, not this, until its Automation is cleared with clear_automation.",
  );
  expect(plan("set_master_volume", { volume: 0.5 }).report).toMatch(/But its volume is automated, and its Automation overrides this value/);
  // Not the settings that aren't.
  expect(plan("set_track_pan", { trackId: "vocals", pan: 0.5 }).report).not.toMatch(/automated/);
  expect(plan("set_track_volume", { trackId: "bass", volume: 0.5 }).report).not.toMatch(/automated/);
  const panned = sampleProject();
  panned.tracks[2]!.automation.push({ setting: "pan", breakpoints: [{ tick: 0, value: 1, hold: false }] });
  expect(plan("set_track_pan", { trackId: "vocals", pan: 0.5 }, panned).report).toMatch(/But its pan is automated/);
});

test("the Assistant is told which settings are automated, reads their breakpoints, and knows Automation overrides them", () => {
  const model = projectSummary(sampleProject());
  expect(model.tracks[2]).toMatchObject({ trackId: "vocals", automated: ["volume"] });
  expect(model.tracks[0]).not.toHaveProperty("automated");
  expect(model.master.automated).toEqual(["volume"]);
  expect(plan("read_automation", { channel: "vocals" }).report).toBe(
    'Track vocals (“Vocals”)\'s Automation:\n[{"setting":"volume","breakpoints":[{"tick":3840,"value":0,"hold":false},{"tick":7680,"value":1,"hold":true}]}]',
  );
  expect(plan("read_automation", { channel: "master" }).report).toBe(
    'the Master\'s Automation:\n[{"setting":"volume","breakpoints":[{"tick":0,"value":0.8,"hold":false}]}]',
  );
  expect(plan("read_automation", { channel: "keys" }).report).toBe("Track keys (“Keys”) has no Automation: none of its settings is automated.");
  expect(SYSTEM_PROMPT).toMatch(/An automated setting's fixed value is overridden while it is automated/);
});

/** The sample song with an EQ gain, a Synth cutoff, a Send and a Bus volume automated. */
function widelyAutomated() {
  const result = applyCommands(sampleProject(), [
    { type: "setAutomation", target: { trackId: "keys" }, setting: "effect:keys-eq:lowShelfGainDb", breakpoints: [{ tick: 0, value: 6, hold: false }] },
    { type: "setAutomation", target: { trackId: "keys" }, setting: "instrument:cutoffHz", breakpoints: [{ tick: 0, value: 500, hold: false }] },
    { type: "setAutomation", target: { trackId: "vocals" }, setting: "send:band", breakpoints: [{ tick: 0, value: 1, hold: false }] },
    { type: "setAutomation", target: { busId: "band" }, setting: "volume", breakpoints: [{ tick: 0, value: 0.5, hold: false }] },
  ]);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

test("the Assistant sees the Automation of Sends, Buses, Effects and the Synth, keyed by what they move", () => {
  const model = projectSummary(widelyAutomated());
  expect(model.tracks[0]!.automated).toEqual(["effect:keys-eq:lowShelfGainDb", "instrument:cutoffHz"]);
  expect(model.tracks[2]!.automated).toEqual(["volume", "send:band"]);
  expect(model.buses![0]!.automated).toEqual(["volume"]);
  expect(plan("read_automation", { channel: "band" }, widelyAutomated()).report).toMatch(/:\n\[\{"setting":"volume","breakpoints":\[\{"tick":0,"value":0\.5,"hold":false\}\]\}\]$/);
  expect(SYSTEM_PROMPT).toMatch(/send:<busId>.*effect:<effectId>:<setting>.*instrument:<setting>/);
  expect(SYSTEM_PROMPT).toMatch(/Mute, solo, bypass and settings that pick from a list or switch on and off are never automated/);
  expect(SYSTEM_PROMPT).toMatch(/set_automation draws a setting's Automation over a range of ticks, replacing the breakpoints there and keeping the rest, and clear_automation/);
});

test("changing an automated Effect or Synth setting says its Automation overrides it", () => {
  const song = widelyAutomated();
  expect(plan("set_effect_settings", { effectId: "keys-eq", settings: { lowShelfGainDb: 3 } }, song).report).toMatch(
    /But its lowShelfGainDb is automated, and its Automation overrides this value/,
  );
  expect(plan("set_effect_settings", { effectId: "keys-eq", settings: { highShelfGainDb: 3 } }, song).report).not.toMatch(/automated/);
  // The same setting of another Effect isn't the automated one.
  expect(plan("set_effect_settings", { effectId: "band-eq", settings: { lowShelfGainDb: 3 } }, song).report).not.toMatch(/automated/);
  expect(plan("load_preset", { trackId: "keys", preset: synthPresetNameWith("cutoffHz") }, song).report).toMatch(
    /But its cutoffHz is automated/,
  );
  expect(plan("set_instrument", { trackId: "keys", instrument: "synth" }, song).report).toMatch(/But its cutoffHz is automated/);
});

test("removing an automated Effect or swapping away the Synth takes their Automation, and says so", () => {
  const song = widelyAutomated();
  const removal = plan("remove_effect", { effectId: "keys-eq" }, song);
  expect(removal.report).toBe("Effect keys-eq (EQ) is gone from Track keys (“Keys”). Its Automation, of lowShelfGainDb, went with it.");
  const removed = planned("remove_effect", { effectId: "keys-eq" }, song);
  expect(removed.tracks[0]!.automation.map((lane) => lane.setting)).toEqual(["instrument:cutoffHz"]);
  expect(plan("remove_effect", { effectId: "keys-reverb" }, song).report).not.toMatch(/Automation/);

  const moved = planned("move_effect", { effectId: "keys-eq", index: 1 }, song);
  expect(moved.tracks[0]!.automation).toEqual(song.tracks[0]!.automation);

  const kit = plan("set_instrument", { trackId: "keys", instrument: "drumSampler" }, song);
  expect(kit.report).toMatch(/The Synth's Automation, of cutoffHz, went with it\.$/);
  expect(planned("set_instrument", { trackId: "keys", instrument: "drumSampler" }, song).tracks[0]!.automation.map((lane) => lane.setting)).toEqual([
    "effect:keys-eq:lowShelfGainDb",
  ]);
});

/** set_automation's input for one breakpoint of the sample song's Drums at the top of the song. */
function drawAtTop(setting: string, value: number) {
  return { channel: "drums", setting, start: 0, end: 0, breakpoints: [{ tick: 0, value }] };
}

test("a Drum Sampler Pad's volume, pan and pitch are automated by its note, and loading a Kit says what its Automation does", () => {
  expect(SYSTEM_PROMPT).toMatch(/instrument:pad<note>\.volume, instrument:pad<note>\.pan or instrument:pad<note>\.pitch/);
  expect(TOOL_DEFINITIONS.find((tool) => tool.name === "set_automation")!.description).toMatch(
    /A Pad's: volume \(0 to 2\), pan \(-1 to 1\), pitch \(-24 st to 24 st\), so a Kick on note 36 has instrument:pad36\.volume/,
  );
  const volume = plan("set_automation", drawAtTop("instrument:pad36.volume", 0.5));
  expect(volume.change).toBe("Automated “Drums”'s Kick: Volume from 1.1.000 to 1.1.000");
  expect(plan("set_automation", drawAtTop("instrument:pad42.pitch", -12)).commands).toEqual([
    { type: "setAutomation", target: { trackId: "drums" }, setting: "instrument:pad42.pitch", breakpoints: [{ tick: 0, value: -12, hold: false }] },
  ]);
  expect(() => plan("set_automation", drawAtTop("instrument:pad36.volume", 3))).toThrow(/0 to 2/);
  // A Pad's note and choke group pick; a note no Pad plays has nothing to automate.
  for (const setting of ["instrument:pad36.note", "instrument:pad36.chokeGroup", "instrument:pad99.volume"]) {
    expect(() => plan("set_automation", drawAtTop(setting, 0))).toThrow(/instrument:pad36\.volume \(Kick: Volume, 0 to 2\)/);
  }

  const song = planned("set_automation", drawAtTop("instrument:pad36.volume", 0.5));
  expect(projectSummary(song).tracks[3]!.automated).toEqual(["instrument:pad36.volume"]);
  // Loading a Kit sets the Pads: the Kick keeps its Automation, which overrides it.
  const reloaded = plan("set_instrument", { trackId: "drums", instrument: "drumSampler" }, song);
  expect(reloaded.report).toMatch(/But its pad36\.volume is automated, and its Automation overrides this value while the song plays/);
  expect(planned("set_instrument", { trackId: "drums", instrument: "drumSampler" }, song).tracks[3]!.automation).toEqual(song.tracks[3]!.automation);
  const noKick = { id: "k", name: "No Kick", pads: STARTER_KIT.filter((pad) => pad.note !== 36).map((pad) => ({ ...pad })) };
  const library = { userPresets: [], savedKits: [noKick], sampleFolders: null, audioFiles: [] };
  const swapped = planToolCall({ id: "call-1", name: "set_instrument", input: { trackId: "drums", instrument: "drumSampler", preset: "No Kick" } }, song, library);
  expect(swapped.report).toMatch(/The Automation of pad36\.volume went with the Pads the Kit hasn't got\.$/);
  expect(plan("save_kit", { trackId: "drums", name: "Mine" }, song).report).toMatch(/pad36\.volume is automated: the Kit keeps its fixed value, not the Automation\.$/);

  // Another Instrument takes the Pads' Automation with them.
  expect(plan("set_instrument", { trackId: "drums", instrument: "synth" }, song).report).toMatch(/The Drum Sampler's Automation, of pad36\.volume, went with it\.$/);
  expect(planned("set_instrument", { trackId: "drums", instrument: "synth" }, song).tracks[3]!.automation).toEqual([]);
  expect(planned("clear_automation", { channel: "drums", setting: "instrument:pad36.volume" }, song).tracks[3]!.automation).toEqual([]);
});

test("deleting a Track takes all its Automation, and nothing else's", () => {
  const song = widelyAutomated();
  const without = planned("delete_track", { trackId: "keys" }, song);
  expect(without.buses[0]!.automation).toEqual(song.buses[0]!.automation);
  expect(without.tracks.find((track) => track.id === "vocals")!.automation).toEqual(song.tracks[2]!.automation);
});

test("analysing audio changes nothing, and by default hears the whole mix to the end of the last Clip", () => {
  const listening = plan("analyse_audio", {});
  expect(listening.commands).toEqual([]);
  expect(listening.change).toBeUndefined();
  // The last Clip is the Vocals' Audio Clip, which ends after bar 3.
  expect(listening.listen).toEqual({ start: 0, end: 3840 + 7680, track: null, spectrogram: false });
  expect(listening.report).toBe("The whole mix, from 1.1.000 (0 s) to 4.1.000 (6 s), measured:");
});

test("an empty trackId or \"master\" hears the whole mix, as the effect tools name the Master", () => {
  // The real model fills in every argument, so it asks for the whole mix
  // with an empty trackId or "master" as often as it leaves trackId out (#27).
  for (const trackId of ["", "master"]) {
    const listening = plan("analyse_audio", { trackId });
    expect(listening.listen).toEqual({ start: 0, end: 3840 + 7680, track: null, spectrogram: false });
    expect(listening.report).toBe("The whole mix, from 1.1.000 (0 s) to 4.1.000 (6 s), measured:");
  }
});

test("one Track is heard by its place in the Track list, which is how the engine numbers them", () => {
  // Drums is the fourth Track, after Vocals, an Audio Track the engine plays too.
  const listening = plan("analyse_audio", { trackId: "drums", start: 960, end: 1920 });
  expect(listening.listen).toEqual({ start: 960, end: 1920, track: 3, spectrogram: false });
  expect(listening.report).toMatch(/^Track drums \(“Drums”\) on its own, from 1\.2\.000 \(0\.5 s\) to 1\.3\.000 \(1 s\)/);
});

test("an Audio Track can be heard on its own", () => {
  const listening = plan("analyse_audio", { trackId: "vocals" });
  expect(listening.listen).toEqual({ start: 0, end: 3840 + 7680, track: 2, spectrogram: false });
  expect(listening.report).toMatch(/^Track vocals \(“Vocals”\) on its own/);
});

test("a spectrogram is drawn only when asked for, so the text-only analysis stays cheap", () => {
  const seeing = plan("analyse_audio", { spectrogram: true });
  expect(seeing.listen).toMatchObject({ spectrogram: true });
  expect(seeing.report).toBe("The whole mix, from 1.1.000 (0 s) to 4.1.000 (6 s), measured (the spectrogram is attached):");
  expect(plan("analyse_audio", { spectrogram: false }).listen).toMatchObject({ spectrogram: false });

  const schema = TOOL_DEFINITIONS.find((tool) => tool.name === "analyse_audio")!.input_schema;
  expect(schema.properties).toHaveProperty("spectrogram.type", "boolean");
  expect(schema.required).not.toContain("spectrogram");
});

test("listen asks for the audio too, and the result says what the audio is of", () => {
  const hearing = plan("analyse_audio", { listen: true });
  expect(hearing.listen).toEqual({ start: 0, end: 3840 + 7680, track: null, spectrogram: false, audio: true });
  expect(hearing.report).toBe("The whole mix, from 1.1.000 (0 s) to 4.1.000 (6 s), measured (the audio is attached):");
  expect(hearing.audioNote).toBe("The audio attached is all of it, a WAV file, mono at 16 kHz, of at most the first 30 s of the range.");
  expect(plan("analyse_audio", { listen: true, spectrogram: true }).report).toMatch(
    /measured \(the spectrogram is attached\) \(the audio is attached\):$/,
  );
  // Left out or false, nothing is heard.
  expect(plan("analyse_audio", {}).audioNote).toBeUndefined();
  expect(plan("analyse_audio", { listen: false }).listen).not.toHaveProperty("audio");
});

test("a range longer than the listening cap is cut to it, and the result says where and how to hear the rest", () => {
  // 20 bars at 120 BPM are 40 s; the first 30 s are 15 bars.
  const hearing = plan("analyse_audio", { listen: true, start: 0, end: 20 * 3840 });
  expect(hearing.listen).toMatchObject({ start: 0, end: 20 * 3840, audio: true });
  expect(hearing.audioNote).toBe(
    "The audio attached is cut to the first 30 s of the 40 s, to 16.1.000 (30 s): listening is capped at 30 s. " +
      "The measurements are of the whole range; to hear the rest, call analyse_audio with listen again from start 57600.",
  );
});

/** Every tool but `analyse_audio`. */
function others(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => tool.name !== "analyse_audio");
}

test("only a model that is sent audio is offered listen, and the others are told they get the numbers", () => {
  const heard = toolDefinitions([], false, true).find((tool) => tool.name === "analyse_audio")!;
  expect(heard.input_schema.properties).toHaveProperty("listen.type", "boolean");
  expect(heard.input_schema.required).not.toContain("listen");
  // The cap and the encoding are in the description.
  expect(heard.description).toMatch(/a WAV file, mono at 16 kHz, of at most the first 30 s of the range/);
  expect(heard.description).toMatch(/A range longer than 30 s is cut to its first 30 s, and the result says so/);

  for (const unheard of [toolDefinitions([]), toolDefinitions([], true), TOOL_DEFINITIONS]) {
    const tool = unheard.find((each) => each.name === "analyse_audio")!;
    expect(tool.input_schema.properties).not.toHaveProperty("listen");
    expect(tool.description).toMatch(/You are not sent the audio itself: this model doesn't take audio here/);
    expect(tool.description).not.toMatch(/Set listen/);
  }
  // Every other tool is the same either way.
  expect(others(toolDefinitions([], false, true))).toEqual(others(toolDefinitions([])));
});

test("an analysis says what it heard, so the Request can keep it and compare it with another", () => {
  expect(plan("analyse_audio", {}).heard).toEqual({ trackId: null, what: "the whole mix", span: "from 1.1.000 (0 s) to 4.1.000 (6 s)" });
  expect(plan("analyse_audio", { trackId: "drums", start: 960, end: 1920 }).heard).toEqual({
    trackId: "drums",
    what: "Track drums (“Drums”) on its own",
    span: "from 1.2.000 (0.5 s) to 1.3.000 (1 s)",
  });
});

test("comparing with the Reference Track hears the whole mix, or a range of it, against the reference, and changes nothing", () => {
  const project = { ...sampleProject(), referenceTrack: { file: "audio/Finished Song.wav" } };
  const comparing = plan("compare_to_reference", {}, project);
  expect(comparing.commands).toEqual([]);
  expect(comparing.change).toBeUndefined();
  expect(comparing.listen).toEqual({ start: 0, end: 11_520, track: null, spectrogram: false });
  expect(comparing.heard).toEqual({ trackId: null, what: "the whole mix", span: "from 1.1.000 (0 s) to 4.1.000 (6 s)" });
  expect(comparing.reference).toEqual({ file: "audio/Finished Song.wav", name: "Finished Song.wav" });
  expect(plan("compare_to_reference", { start: 960, end: 1920 }, project).listen).toMatchObject({ start: 960, end: 1920 });
  expect(() => plan("compare_to_reference", { start: 1920, end: 960 }, project)).toThrow(/end must be after start/);
  expect(() => plan("compare_to_reference", {})).toThrow(/no Reference Track/);
  expect(SYSTEM_PROMPT).toContain("compare_to_reference measures it against the mix");
});

test("comparing audio changes nothing, and names the two analyses by id or leaves them to the defaults", () => {
  const comparing = plan("compare_audio", {});
  expect(comparing.commands).toEqual([]);
  expect(comparing.change).toBeUndefined();
  expect(comparing.compare).toEqual({ before: undefined, after: undefined });
  expect(plan("compare_audio", { before: "a1", after: " a3 " }).compare).toEqual({ before: "a1", after: "a3" });
  expect(() => plan("compare_audio", { before: 1 })).toThrow(/before must be an analysisId/);
  expect(() => plan("compare_audio", { after: "" })).toThrow(/after must be an analysisId/);
  expect(SYSTEM_PROMPT).toMatch(/analyse before you change anything, then .* call compare_audio/);
});

test("there is nothing to analyse in a Project without Clips", () => {
  expect(() => plan("analyse_audio", {}, createProject())).toThrow(/nothing to hear/);
});

test("the model is told to listen only when a Request needs it", () => {
  const description = TOOL_DEFINITIONS.find((tool) => tool.name === "analyse_audio")!.description;
  expect(description).toMatch(/only when the Request needs to hear the song/);
  expect(description).toMatch(/Do not call it for a Request the Project's data already answers, such as setting the tempo/);
});

test("the system prompt and analyse_audio give the same true-peak ceiling, and say to lower the loud Track", () => {
  expect(TRUE_PEAK_CEILING_DBTP).toBe(-1);
  const ceiling = `${TRUE_PEAK_CEILING_DBTP} dBTP`;
  const description = TOOL_DEFINITIONS.find((tool) => tool.name === "analyse_audio")!.description;
  for (const told of [SYSTEM_PROMPT, description]) {
    expect(told).toContain(`the ceiling of ${ceiling}`);
    expect(told).toMatch(/the Track that is too loud rather than the Master/);
  }
});

/** Measurements as the engine writes them, cut down to what the note reads. */
function measurementsWith(truePeak: number | null, clipped: number): string {
  return JSON.stringify({ source: "mix", true_peak_dbtp: truePeak, clipping: { clipped_samples: clipped, region_count: 0, regions: [] } });
}

test("each analysis says where its true peak is against the ceiling, clipping or not", () => {
  expect(truePeakNote(measurementsWith(-0.4, 0))).toBe(
    "No samples clip, but the true peak, -0.4 dBTP, is above the ceiling of -1 dBTP: it would still overshoot once the song is converted.",
  );
  expect(truePeakNote(measurementsWith(0.3, 808))).toBe("808 samples clip, and the true peak, 0.3 dBTP, is above the ceiling of -1 dBTP.");
  expect(truePeakNote(measurementsWith(-1, 0))).toBe("The true peak, -1 dBTP, is within the ceiling of -1 dBTP.");
  expect(truePeakNote(measurementsWith(-12.5, 0))).toBe("The true peak, -12.5 dBTP, is within the ceiling of -1 dBTP.");
  // Silence has no peak to judge.
  expect(truePeakNote(measurementsWith(null, 0))).toBeNull();
});

test("a tool the Assistant doesn't have is refused, and the real ones are named", () => {
  expect(() => plan("set_reverb", {})).toThrow(InvalidToolCall);
  expect(() => plan("set_reverb", {})).toThrow(/set_tempo/);
});

test("an argument that is missing, unknown or out of range changes nothing", () => {
  const project = deepFreeze(sampleProject());
  const bad: [string, unknown][] = [
    ["create_track", { kind: "instrument" }],
    ["create_track", { name: "Kick", kind: "drums" }],
    ["create_track", { name: "  ", kind: "instrument" }],
    ["create_track", { name: "Kick", kind: "instrument", colour: "red" }],
    ["create_track", { name: "Kick", kind: "instrument", index: 9 }],
    ["rename_track", { trackId: "keys", name: "" }],
    ["delete_track", { trackId: "nothing-like-it" }],
    ["set_tempo", { tempo: 0 }],
    ["set_tempo", { tempo: "fast" }],
    ["set_tempo", "128"],
    ["set_instrument", { trackId: "bass", instrument: "organ" }],
    ["set_instrument", { trackId: "bass", instrument: "synth", preset: 3 }],
    ["place_clip", { trackId: "vocals", start: 0, length: 3840 }],
    ["place_clip", { trackId: "bass", start: -1, length: 3840 }],
    ["place_clip", { trackId: "bass", start: 0, length: 0 }],
    ["place_clip", { trackId: "bass", start: 0.5, length: 3840 }],
    ["place_clip", { trackId: "bass", start: 0, length: 3840, notes: "C E G" }],
    ["place_clip", { trackId: "bass", start: 0, length: 3840, notes: [{ pitch: 60, start: 0 }] }],
    [
      "place_clip",
      { trackId: "bass", start: 0, length: 3840, notes: [{ pitch: 60, start: 0, length: 1, velocity: 2 }] },
    ],
    ["place_clip", { trackId: "bass", start: 0, length: 3840, notes: [{ pitch: 60, start: 0, length: 1, note: "C" }] }],
    ["place_clip", { trackId: "bass", start: 0, length: 3840, notes: [{ pitch: 60.5, start: 0, length: 1 }] }],
    ["set_pattern_notes", { clipId: "vocals-1", notes: [] }],
    ["set_pattern_notes", { clipId: "nothing-like-it", notes: [] }],
    ["move_clip", { clipId: "vocals-1", start: 0, trackId: "keys" }],
    ["move_clip", { clipId: "keys-1", start: -960 }],
    ["delete_clip", { clipId: "nothing-like-it" }],
    ["set_track_volume", { trackId: "keys", volume: 3 }],
    ["set_track_volume", { trackId: "keys", volume: -0.5 }],
    ["set_track_volume", { volume: 0.5 }],
    ["set_track_pan", { trackId: "keys", pan: 1.5 }],
    ["set_track_pan", { trackId: "keys", pan: "left" }],
    ["set_track_mute", { trackId: "keys", mute: "yes" }],
    ["set_track_solo", { trackId: "keys", solo: 1 }],
    ["set_master_volume", { volume: 2.5 }],
    ["add_effect", { channel: "keys", effect: "vocoder" }],
    ["add_effect", { channel: "guitar", effect: "eq" }],
    ["add_effect", { channel: "keys", effect: "eq", index: 3 }],
    ["add_effect", { channel: "keys", effect: "eq", settings: { band1GainDb: 30 } }],
    ["add_effect", { effect: "eq" }],
    ["remove_effect", { effectId: "nothing-like-it" }],
    ["move_effect", { effectId: "keys-eq", index: 2 }],
    ["move_effect", { effectId: "keys-eq", index: -1 }],
    ["set_effect_settings", { effectId: "keys-eq", settings: {} }],
    ["set_effect_settings", { effectId: "keys-eq", settings: [] }],
    ["set_effect_settings", { effectId: "keys-eq", settings: { lowCut: true } }],
    ["set_effect_settings", { effectId: "keys-eq", settings: { band1Hz: "1k" } }],
    ["analyse_audio", { start: -1 }],
    ["analyse_audio", { start: 960, end: 960 }],
    ["analyse_audio", { trackId: "guitar" }],
    ["analyse_audio", { bars: 4 }],
    ["analyse_audio", { spectrogram: "yes" }],
    ["analyse_audio", { listen: "yes" }],
  ];
  for (const [name, input] of bad) {
    expect(() => plan(name, input, project), `${name} ${JSON.stringify(input)}`).toThrow(InvalidToolCall);
  }
});

test("naming a Track that isn't there lists the ones that are", () => {
  expect(() => plan("delete_track", { trackId: "guitar" })).toThrow(/keys \(“Keys”\)/);
});

test("a Track is panned, muted and soloed, and the rest of its mixer stays as it was", () => {
  const panned = planned("set_track_pan", { trackId: "bass", pan: -0.3 });
  expect(panned.tracks[1]!.mixer).toEqual({ volume: 1, pan: -0.3, mute: false, solo: false });
  expect(plan("set_track_pan", { trackId: "bass", pan: -0.3 }).change).toBe("Panned “Bass” 30% left");
  expect(plan("set_track_pan", { trackId: "bass", pan: 0 }).change).toBe("Panned “Bass” to the centre");

  const muted = planned("set_track_mute", { trackId: "bass", mute: true }, panned);
  expect(muted.tracks[1]!.mixer).toEqual({ volume: 1, pan: -0.3, mute: true, solo: false });
  expect(planned("set_track_mute", { trackId: "bass", mute: false }, muted).tracks[1]!.mixer.mute).toBe(false);

  const soloed = planned("set_track_solo", { trackId: "keys", solo: true }, muted);
  expect(soloed.tracks[0]!.mixer.solo).toBe(true);
  expect(plan("set_track_solo", { trackId: "keys", solo: true }).change).toBe("Soloed “Keys”");
});

test("the Master's volume is set as a linear gain", () => {
  expect(planned("set_master_volume", { volume: 0.5 }).master.volume).toBe(0.5);
  expect(plan("set_master_volume", { volume: 0.5 }).change).toBe("Set the Master to -6.0 dB");
});

test("the summary names every Track's Effects and the Master's, and read_channel has their mixers and settings", () => {
  const project = sampleProject();
  const model = projectSummary(project);
  expect(model.tracks[0]).not.toHaveProperty("volume");
  expect(model.tracks[0]!.insertChain).toEqual([
    { effectId: "keys-eq", effect: "eq" },
    { effectId: "keys-reverb", effect: "reverb" },
  ]);
  expect(model.master).toEqual({ insertChain: [{ effectId: "master-comp", effect: "compressor" }], automated: ["volume"] });

  const keys = channelDetail(project, project.tracks[0]!);
  expect(keys).toMatchObject({ volume: 1, pan: 0, mute: false, solo: false });
  expect(keys.insertChain.map((effect) => [effect.effectId, effect.effect])).toEqual([
    ["keys-eq", "eq"],
    ["keys-reverb", "reverb"],
  ]);
  expect(keys.insertChain[0]!.settings).toMatchObject({ lowCut: "off", band1Hz: 250 });
  expect(channelDetail(project, "master")).toMatchObject({ volume: 1, insertChain: [{ effectId: "master-comp", effect: "compressor" }] });
  expect(plan("read_channel", { channel: "master" }).report).toMatch(/^the Master, in full:\n\{"channel":"master","volume":1,/);
});

test("an Effect is added to a Track's Insert Chain, at its defaults, and the model is told its id", () => {
  const input = { channel: "bass", effect: "eq" };
  const project = planned("add_effect", input);
  const [eq] = project.tracks[1]!.insertChain;
  expect(eq).toMatchObject({ type: "eq", bypassed: false, settings: { band1GainDb: 0, lowCut: "off" } });
  expect(plan("add_effect", input).change).toBe("Added an EQ to “Bass”");
  expect(plan("add_effect", input).report).toMatch(/whose effectId is \S+\. Its settings: \{"lowCut":"off"/);
});

test("an Effect is added to the Master, anywhere in the chain, with settings of its own", () => {
  const input = { channel: "master", effect: "eq", index: 0, settings: { band2GainDb: -3, highCut: "on" } };
  const project = planned("add_effect", input);
  expect(project.master.insertChain.map((effect) => effect.type)).toEqual(["eq", "compressor"]);
  expect(project.master.insertChain[0]!.settings).toMatchObject({ band2GainDb: -3, highCut: "on", band1GainDb: 0 });
  expect(plan("add_effect", input).change).toBe("Added an EQ to the Master, with band 2 gain -3 dB, high cut on");
});

test("Effects are reordered within their chain and removed", () => {
  const moved = planned("move_effect", { effectId: "keys-reverb", index: 0 });
  expect(moved.tracks[0]!.insertChain.map((effect) => effect.id)).toEqual(["keys-reverb", "keys-eq"]);
  expect(plan("move_effect", { effectId: "keys-reverb", index: 0 }).change).toBe(
    "Moved the Reverb on “Keys” to 1st of 2",
  );
  expect(plan("move_effect", { effectId: "keys-reverb", index: 0 }).report).toMatch(
    /runs: keys-reverb \(Reverb\), keys-eq \(EQ\)/,
  );

  const removed = planned("remove_effect", { effectId: "master-comp" }, moved);
  expect(removed.master.insertChain).toEqual([]);
  expect(plan("remove_effect", { effectId: "master-comp" }).change).toBe("Removed the Compressor from the Master");
});

test("setting an Effect changes only the settings given", () => {
  const input = { effectId: "keys-eq", settings: { band1Hz: 320, band1GainDb: -4.5, lowCut: "on" } };
  const eq = planned("set_effect_settings", input).tracks[0]!.insertChain[0]!;
  expect(eq.settings).toMatchObject({ band1Hz: 320, band1GainDb: -4.5, lowCut: "on", band2Hz: 1000, lowCutHz: 30 });
  expect(plan("set_effect_settings", input).change).toBe(
    "Set the EQ on “Keys”: band 1 frequency 320 Hz, band 1 gain -4.5 dB, low cut on",
  );
});

function setEq(settings: Record<string, unknown>) {
  return () => plan("set_effect_settings", { effectId: "keys-eq", settings });
}

test("an Effect setting out of its declared range is refused, and the model is told the range", () => {
  expect(setEq({ band1GainDb: 30 })).toThrow("The EQ's band1GainDb must be a number from -24 to 24 dB");
  expect(setEq({ lowCutHz: 10 })).toThrow(/from 20 to 20000 Hz/);
  expect(setEq({ lowCut: "maybe" })).toThrow("The EQ's lowCut must be one of off, on");
  expect(setEq({ wet: 0.5 })).toThrow(/The EQ has no setting called wet\. Its settings are: lowCut, lowCutHz/);
  expect(() => plan("set_effect_settings", { effectId: "keys-reverb", settings: { mix: 1.5 } })).toThrow(
    "The Reverb's mix must be a number from 0 to 1",
  );
});

test("every Effect's settings are checked against its own table, whatever the Effect", () => {
  for (const type of EFFECT_TYPES) {
    const project = planned("add_effect", { channel: "bass", effect: type });
    const effectId = project.tracks[1]!.insertChain[0]!.id;
    for (const param of effectParams(type)) {
      const set = (value: unknown) => plan("set_effect_settings", { effectId, settings: { [param.name]: value } }, project);
      const [low, high] = param.choices.length > 0 ? [param.choices[0], param.choices.at(-1)] : [param.min, param.max];
      expect(set(low).commands, `${type} ${param.name}`).toHaveLength(1);
      expect(set(high).commands, `${type} ${param.name}`).toHaveLength(1);
      const outside = param.choices.length > 0 ? "neither" : param.max + Math.max(param.step, 1);
      expect(() => set(outside), `${type} ${param.name}`).toThrow(InvalidToolCall);
    }
  }
});

test("the model is told every Effect's settings and ranges, from the Effects' own tables", () => {
  const description = TOOL_DEFINITIONS.find((tool) => tool.name === "set_effect_settings")!.description;
  expect(description).toContain("band1GainDb (-24 to 24 dB)");
  expect(description).toContain("lowCut (off or on)");
  for (const type of EFFECT_TYPES) {
    for (const param of effectParams(type)) expect(description).toContain(`${param.name} (`);
  }
});

test("an Effect the Assistant adds reaches the engine's Insert Chain", () => {
  const sync = new EngineSync();
  sync.update(sampleProject(), new Map());
  const project = planned("add_effect", { channel: "bass", effect: "eq", settings: { band1GainDb: 6 } });
  const sent = sync.update(project, new Map());
  // Bass is the second Track, so its Insert Chain is the engine's chain 1.
  expect(sent).toContainEqual({ type: "insertEffect", chain: 1, index: 0, effect: "eq" });
  expect(sent).toContainEqual(expect.objectContaining({ type: "setEffectSettings", chain: 1, index: 0 }));
});

test("a Compressor and a Reverb are added to any Insert Chain, set within their ranges, and reach the engine", () => {
  const sync = new EngineSync();
  sync.update(sampleProject(), new Map());
  let project = sampleProject();
  const steps: [string, Record<string, unknown>][] = [
    ["add_effect", { channel: "bass", effect: "compressor", settings: { thresholdDb: -30, ratio: 8, kneeDb: 0 } }],
    ["add_effect", { channel: "master", effect: "reverb", index: 0, settings: { decay: 4, preDelay: 40, mix: 0.1 } }],
  ];
  for (const [name, input] of steps) project = planned(name, input, project);

  const [compressor] = project.tracks[1]!.insertChain;
  expect(compressor).toMatchObject({ type: "compressor", settings: { thresholdDb: -30, ratio: 8, kneeDb: 0, attack: 5 } });
  const [reverb] = project.master.insertChain;
  expect(reverb).toMatchObject({ type: "reverb", settings: { decay: 4, preDelay: 40, mix: 0.1, size: 0.5 } });
  expect(plan(...steps[1]!).change).toBe("Added a Reverb to the Master, with decay 4 s, pre-delay 40 ms, mix 0.1");

  const set = (effectId: string, settings: Record<string, unknown>) =>
    planned("set_effect_settings", { effectId, settings }, project);
  project = set(compressor!.id, { makeupDb: 6, release: 300 });
  project = set(reverb!.id, { size: 0.9, damping: 0.2, width: 0.5 });
  expect(project.tracks[1]!.insertChain[0]!.settings).toMatchObject({ makeupDb: 6, release: 300, kneeDb: 0 });
  expect(project.master.insertChain[0]!.settings).toMatchObject({ size: 0.9, damping: 0.2, width: 0.5, decay: 4 });

  // Bass is the engine's chain 1 and the Master is chain -1; the settings go
  // in each Effect's own order.
  const sent = sync.update(project, new Map());
  expect(sent).toContainEqual({ type: "insertEffect", chain: 1, index: 0, effect: "compressor" });
  expect(sent).toContainEqual({ type: "setEffectSettings", chain: 1, index: 0, settings: [-30, 8, 5, 300, 6, 0] });
  expect(sent).toContainEqual({ type: "insertEffect", chain: -1, index: 0, effect: "reverb" });
  expect(sent).toContainEqual({ type: "setEffectSettings", chain: -1, index: 0, settings: [0.9, 4, 0.2, 40, 0.5, 0.1] });
});

function setEffect(effectId: string, settings: Record<string, unknown>) {
  return () => plan("set_effect_settings", { effectId, settings });
}

test("a Compressor or Reverb setting outside the range its Effect declares is refused, with the range", () => {
  expect(setEffect("master-comp", { kneeDb: 30 })).toThrow("The Compressor's kneeDb must be a number from 0 to 24 dB");
  expect(setEffect("master-comp", { ratio: 0.5 })).toThrow("The Compressor's ratio must be a number from 1 to 20:1");
  expect(setEffect("master-comp", { attack: 0 })).toThrow("The Compressor's attack must be a number from 0.1 to 200 ms");
  expect(setEffect("keys-reverb", { decay: 20 })).toThrow("The Reverb's decay must be a number from 0.1 to 10 s");
  expect(setEffect("keys-reverb", { preDelay: 250 })).toThrow("The Reverb's preDelay must be a number from 0 to 200 ms");
  // #15 renamed the old settings: they are refused, and the real ones named.
  expect(setEffect("keys-reverb", { wet: 0.5 })).toThrow(
    "The Reverb has no setting called wet. Its settings are: size, decay, damping, preDelay, width, mix.",
  );
  expect(() =>
    plan("add_effect", { channel: "master", effect: "compressor", settings: { thresholdDb: -70 } }),
  ).toThrow("The Compressor's thresholdDb must be a number from -60 to 0 dB");
});

test("the model is told it can add a Compressor or a Reverb, and every one of their settings", () => {
  const add = TOOL_DEFINITIONS.find((tool) => tool.name === "add_effect")!;
  expect((add.input_schema as unknown as { properties: { effect: { description: string } } }).properties.effect.description).toContain(
    "eq, compressor, reverb, delay, saturator, chorus, phaser, filter, gate, limiter, bitcrusher, utility, or plugin:<id> for one of the installed Plugins",
  );
  for (const description of [add.description, TOOL_DEFINITIONS.find((tool) => tool.name === "set_effect_settings")!.description]) {
    expect(description).toContain(
      "Compressor (compressor): thresholdDb (-60 to 0 dB), ratio (1 to 20:1), attack (0.1 to 200 ms), release (10 to 2000 ms), makeupDb (0 to 24 dB), kneeDb (0 to 24 dB).",
    );
    expect(description).toContain(
      "Reverb (reverb): size (0 to 1), decay (0.1 to 10 s), damping (0 to 1), preDelay (0 to 200 ms), width (0 to 1), mix (0 to 1).",
    );
  }
});

test("a Delay is added to a Bus from a factory preset, set, and reaches the engine in its table's order", () => {
  const sync = new EngineSync();
  sync.update(sampleProject(), new Map());
  const input = {
    channel: "band",
    effect: "delay",
    preset: "Dotted-eighth ping-pong",
    settings: { feedback: 0.6 },
  };
  expect(plan("add_effect", input).change).toBe(
    "Added a Delay to the Bus “Band” from its “Dotted-eighth ping-pong” preset, with feedback 0.6",
  );
  let project = planned("add_effect", input);
  const delay = project.buses[0]!.insertChain.at(-1);
  expect(delay).toMatchObject({
    type: "delay",
    settings: { sync: "on", note: "1/8 dotted", pingPong: "on", feedback: 0.6, highCutHz: 5000, mix: 0.35 },
  });

  project = planned("set_effect_settings", { effectId: delay!.id, settings: { sync: "off", timeMs: 90 } }, project);
  expect(project.buses[0]!.insertChain.at(-1)!.settings).toMatchObject({ sync: "off", timeMs: 90, pingPong: "on" });

  // The Band Bus is the engine's chain -2, and its EQ comes first. Sync,
  // note, time, feedback, high cut, ping-pong, mix; "1/8 dotted" is the
  // seventh note value.
  const sent = sync.update(project, new Map());
  expect(sent).toContainEqual({ type: "insertEffect", chain: -2, index: 1, effect: "delay" });
  expect(sent).toContainEqual({ type: "setEffectSettings", chain: -2, index: 1, settings: [0, 6, 90, 0.6, 5000, 1, 0.35] });
});

test("a Delay's preset, note value and feedback are checked against what it offers", () => {
  expect(() => plan("add_effect", { channel: "master", effect: "delay", preset: "Tape" })).toThrow(
    "The Delay has no preset called \"Tape\". Its presets are: Slapback, Quarter echo, Dotted-eighth ping-pong.",
  );
  expect(() => plan("add_effect", { channel: "master", effect: "eq", preset: "Slapback" })).toThrow(
    "The EQ has no preset called \"Slapback\". Its presets are: Vocal presence, Low-end cleanup, Kick punch, Telephone.",
  );
  expect(() => plan("add_effect", { channel: "master", effect: "delay", settings: { note: "1/3" } })).toThrow(
    "The Delay's note must be one of 1/16 triplet, 1/16,",
  );
  expect(() => plan("add_effect", { channel: "master", effect: "delay", settings: { feedback: 1 } })).toThrow(
    "The Delay's feedback must be a number from 0 to 0.95",
  );
  const add = TOOL_DEFINITIONS.find((tool) => tool.name === "add_effect")!;
  expect(add.description).toContain("Delay (delay): sync (off or on), note (1/16 triplet or 1/16 or");
  expect(JSON.stringify(add.input_schema)).toContain("“Quarter echo” (Repeats a quarter note apart");
});

test("the model sees a Compressor's and a Reverb's settings, and a recorded take's Clip", () => {
  const project = sampleProject();
  const vocals = project.tracks.find((track) => track.kind === "audio")!;
  // A take lands where it was played, with no offset into its file.
  vocals.clips.push({ id: "take", kind: "audio", start: 1920, duration: 2, file: "audio/Vocals take.wav", fileOffset: 0 });
  const model = projectSummary(project);
  expect(channelDetail(project, "master").insertChain[0]!.settings).toMatchObject({ thresholdDb: -18, ratio: 4, kneeDb: 6, makeupDb: 3 });
  expect(channelDetail(project, project.tracks[0]!).insertChain[1]!.settings).toMatchObject({ size: 0.5, decay: 2, preDelay: 0, mix: 0.25 });
  expect(model.tracks.find((track) => track.trackId === vocals.id)!.clips).toContainEqual({
    clipId: "take",
    start: 1920,
    length: 3840,
    duration: 2,
    file: "audio/Vocals take.wav",
    fileOffset: 0,
  });
});

test("the model sees each Bus, and where every Track and Bus sends its signal", () => {
  const project = sampleProject();
  project.buses.push({ ...project.buses[0]!, id: "drum-bus", name: "Drum Bus", insertChain: [], output: "band" });
  project.tracks[3]!.output = "drum-bus";
  const model = projectSummary(project);
  expect(model.tracks.map((track) => track.output)).toEqual(["master", "band", "master", "drum-bus"]);
  expect(model.buses).toEqual([
    { busId: "band", name: "Band", insertChain: [{ effectId: "band-eq", effect: "eq" }], output: "master" },
    { busId: "drum-bus", name: "Drum Bus", insertChain: [], output: "band" },
  ]);
  expect(channelDetail(project, project.buses[1]!)).toEqual({
    busId: "drum-bus",
    name: "Drum Bus",
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    insertChain: [],
    output: "band",
    sends: [],
  });

  // A song with no Buses says nothing about them: everything feeds the Master.
  const plain = projectSummary({
    ...project,
    buses: [],
    tracks: project.tracks.map((track) => ({ ...track, output: null, sends: [] })),
  });
  expect(plain).not.toHaveProperty("buses");
  expect(plain.tracks[0]).not.toHaveProperty("output");
});

test("the effect tools work on a Bus's Insert Chain as on any other", () => {
  const added = planned("add_effect", { channel: "band", effect: "compressor", index: 0 });
  expect(added.buses[0]!.insertChain.map((effect) => effect.type)).toEqual(["compressor", "eq"]);
  expect(plan("add_effect", { channel: "band", effect: "reverb" }).change).toBe("Added a Reverb to the Bus “Band”");

  const set = planned("set_effect_settings", { effectId: "band-eq", settings: { band1GainDb: -3 } });
  expect(set.buses[0]!.insertChain[0]!.settings).toMatchObject({ band1GainDb: -3 });
  expect(plan("set_effect_settings", { effectId: "band-eq", settings: { band1GainDb: -3 } }).report).toMatch(
    /on Bus band \(“Band”\)/,
  );
  expect(planned("move_effect", { effectId: "band-eq", index: 1 }, added).buses[0]!.insertChain[1]!.id).toBe("band-eq");
  expect(planned("remove_effect", { effectId: "band-eq" }).buses[0]!.insertChain).toEqual([]);
});

test("the Track tools don't take a Bus, and say what there is", () => {
  expect(() => plan("set_track_volume", { trackId: "band", volume: 0.5 })).toThrow("There is no Track band");
  expect(() => plan("analyse_audio", { trackId: "band" })).toThrow("There is no Track band");
  expect(() => plan("add_effect", { channel: "nope", effect: "eq" })).toThrow(
    /There is no Track or Bus nope\. The Project has: .*band \(“Band”\)/,
  );
});

test("deleting a Track that feeds a Bus leaves the Bus, and the rest of the routing, as it was", () => {
  const project = planned("delete_track", { trackId: "bass" });
  expect(project.buses.map((bus) => bus.id)).toEqual(["band"]);
  expect(project.tracks.map((track) => track.output)).toEqual([null, null, null]);
});

test("a Track heard on its own is found by its place in the Track list, whatever it feeds", () => {
  // Bass feeds Band; the engine hears it straight from its fader.
  expect(plan("analyse_audio", { trackId: "bass", start: 0, end: 960 }).listen).toEqual({
    start: 0,
    end: 960,
    track: 1,
    spectrogram: false,
  });
});

test("the model sees each Track's and Bus's Sends: the Bus each goes to and its level", () => {
  const project = sampleProject();
  project.buses.push({ ...project.buses[0]!, id: "reverb", name: "Reverb", insertChain: [], sends: [] });
  project.buses[0]!.sends.push({ busId: "reverb", level: 0.25 });
  project.tracks[0]!.sends.push({ busId: "reverb", level: 1 }, { busId: "band", level: 0.5 });
  const model = projectSummary(project);
  // The fixture's Vocals send to Band.
  expect(model.tracks.map((track) => track.sends)).toEqual([["reverb", "band"], undefined, ["band"], undefined]);
  expect(model.buses!.map((bus) => bus.sends)).toEqual([["reverb"], undefined]);
  expect(model.tracks[1]).not.toHaveProperty("sends");
  // Their levels are read_channel's.
  expect(channelDetail(project, project.tracks[0]!)).toMatchObject({
    sends: [
      { busId: "reverb", level: 1 },
      { busId: "band", level: 0.5 },
    ],
  });
  expect(channelDetail(project, project.buses[0]!)).toMatchObject({ sends: [{ busId: "reverb", level: 0.25 }] });
  expect(channelDetail(project, project.tracks[1]!)).toMatchObject({ sends: [] });
  expect(SYSTEM_PROMPT).toMatch(/Sends/);
  expect(SYSTEM_PROMPT).toMatch(/after its volume and pan/);
});

test("the Assistant is told which Kit a Drum Sampler's Pads were loaded from, and what a saved Kit is", () => {
  const project = createProject();
  const pads = STARTER_KIT.map((pad, index) => ({ ...pad, sample: index === 0 ? "audio/kick.wav" : null, pitch: index === 0 ? -3 : 0 }));
  const result = applyCommands(project, [
    { type: "addTrack", track: { ...createInstrumentTrack("Drums", "drums"), instrument: { type: "drumSampler", preset: "My Kit", pads } } },
  ]);
  if (!result.ok) throw new Error(result.error);
  expect(projectSummary(result.project).tracks[0]).toMatchObject({ instrument: "drumSampler", preset: "My Kit" });
  expect(SYSTEM_PROMPT).toMatch(/A Drum Sampler's preset is the Kit its Pads were loaded from/);
});

/** A tool as the model is told of it. */
function described(name: string): string {
  return JSON.stringify(TOOL_DEFINITIONS.find((tool) => tool.name === name));
}

test("the tools that mute, solo and hear a Track say what they do to its Sends", () => {
  expect(described("set_track_mute")).toMatch(/its Sends/);
  expect(described("set_track_solo")).toMatch(/the Buses they feed or send to/);
  expect(described("set_track_volume")).toMatch(/Its Sends come after it/);
  expect(described("analyse_audio")).toMatch(/not through any Bus it feeds or sends to/);
});

test("the mixer tools leave a Track's Sends as they were, and a Track heard on its own is heard without them", () => {
  // Vocals send to Band.
  const muted = planned("set_track_mute", { trackId: "vocals", mute: true });
  expect(muted.tracks[2]!.sends).toEqual([{ busId: "band", level: 0.5 }]);
  const louder = planned("set_track_volume", { trackId: "vocals", volume: 0.5 });
  expect(louder.tracks[2]!.sends).toEqual([{ busId: "band", level: 0.5 }]);
  expect(plan("analyse_audio", { trackId: "vocals", start: 0, end: 960 }).listen).toMatchObject({ track: 2 });
});

test("deleting a Track that sends to a Bus leaves the Bus and every other Send as they were", () => {
  const project = sampleProject();
  project.tracks[0]!.sends.push({ busId: "band", level: 0.75 });
  const deleted = planned("delete_track", { trackId: "vocals" }, project);
  expect(deleted.buses.map((bus) => bus.id)).toEqual(["band"]);
  expect(deleted.tracks.map((track) => track.sends)).toEqual([[{ busId: "band", level: 0.75 }], [], []]);
});

/** The musician's User Presets, as the library hands them to the Assistant. */
const USER_PRESETS: UserPreset[] = [
  { id: "u1", name: "Glass Keys", target: "synth", settings: { ...DEFAULT_SYNTH, osc1Wave: "square", cutoffHz: 2500 } },
  { id: "u2", name: "Huge Hall", target: "reverb", settings: { ...defaultEffectSettings("reverb"), size: 0.95, mix: 0.6 } },
];

function plannedWithPresets(name: string, input: unknown, project = sampleProject()) {
  const result = applyCommands(project, planToolCall({ id: "call-1", name, input }, project, { userPresets: USER_PRESETS, savedKits: [], sampleFolders: null, audioFiles: [] }).commands);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

test("load_preset loads a User Preset by name into a Track's Synth and into an Effect", () => {
  const synth = plannedWithPresets("load_preset", { trackId: "keys", preset: "Glass Keys" });
  expect(instrumentTrack(synth, "keys").instrument).toEqual({
    type: "synth",
    preset: "Glass Keys",
    settings: USER_PRESETS[0]!.settings,
  });

  const input = { effectId: "keys-reverb", preset: "huge hall" };
  const reverb = plannedWithPresets("load_preset", input);
  expect(reverb.tracks[0]!.insertChain[1]!.settings).toEqual(USER_PRESETS[1]!.settings);
  const { change } = planToolCall({ id: "call-1", name: "load_preset", input }, sampleProject(), { userPresets: USER_PRESETS, savedKits: [], sampleFolders: null, audioFiles: [] });
  expect(change).toBe("Loaded the “Huge Hall” User Preset into the Reverb on “Keys”");
});

test("load_preset loads a factory Preset too, and refuses what it can't load", () => {
  const project = planned("load_preset", { trackId: "bass", preset: "Warm Pad" });
  expect(instrumentTrack(project, "bass").instrument).toMatchObject({ preset: "Warm Pad", settings: synthPreset("Warm Pad")!.settings });

  expect(() => plan("load_preset", { trackId: "keys", preset: "Glass Keys" })).toThrow(
    /The Synth has no preset called "Glass Keys". Its presets are: Sub Bass/,
  );
  expect(() => plan("load_preset", { effectId: "keys-eq", preset: "Huge Hall" })).toThrow(
    'The EQ has no preset called "Huge Hall". Its presets are: Vocal presence',
  );
  expect(() => plan("load_preset", { preset: "Warm Pad" })).toThrow("one of them");
  expect(() => plan("load_preset", { trackId: "keys", effectId: "keys-eq", preset: "Warm Pad" })).toThrow("one of them");
  expect(() => plan("load_preset", { trackId: "drums", preset: "Warm Pad" })).toThrow("set_instrument");
});

test("set_instrument and add_effect start from a User Preset by name", () => {
  const synth = plannedWithPresets("set_instrument", { trackId: "drums", instrument: "synth", preset: "Glass Keys" });
  expect(instrumentTrack(synth, "drums").instrument).toMatchObject({ preset: "Glass Keys", settings: USER_PRESETS[0]!.settings });

  const reverb = plannedWithPresets("add_effect", { channel: "master", effect: "reverb", preset: "Huge Hall", settings: { mix: 0.2 } });
  expect(reverb.master.insertChain[1]!.settings).toEqual({ ...USER_PRESETS[1]!.settings, mix: 0.2 });
});

/**
 * The sample song at 120 until bar 2, 60 from there, 3/4 from bar 3, and 90
 * from bar 3's third beat: a tempo-only change part way through a bar.
 */
function slowingDown() {
  const project = sampleProject();
  project.tempoChanges.push(
    { id: "slow", tick: 3840, tempo: 60, timeSignature: null },
    { id: "waltz", tick: 7680, tempo: null, timeSignature: { beatsPerBar: 3, beatUnit: 4 } },
    { id: "lift", tick: 9600, tempo: 90, timeSignature: null },
  );
  return deepFreeze(project);
}

test("the model sees each Tempo Change: where it is in ticks, bars and seconds, and what it sets", () => {
  expect(projectSummary(sampleProject())).not.toHaveProperty("tempoChanges");
  const model = projectSummary(slowingDown());
  expect(model).toMatchObject({ tempo: 120, timeSignature: "4/4", ticksPerBar: 3840 });
  expect(model.tempoChanges).toEqual([
    { tempoChangeId: "slow", tick: 3840, bar: 2, barTick: 3840, seconds: 2, tempo: 60, timeSignature: "4/4", ticksPerBar: 3840 },
    { tempoChangeId: "waltz", tick: 7680, bar: 3, barTick: 7680, seconds: 6, tempo: 60, timeSignature: "3/4", ticksPerBar: 2880 },
    // Part way through bar 3, so its bar starts before it.
    { tempoChangeId: "lift", tick: 9600, bar: 3, barTick: 7680, seconds: 8, tempo: 90, timeSignature: "3/4", ticksPerBar: 2880 },
  ]);
  // The Audio Clip from bar 2 plays its 4 s at 60: four beats.
  expect(model.tracks[2]!.clips[0]).toMatchObject({ start: 3840, duration: 4, length: 3840 });
  expect(SYSTEM_PROMPT).toContain("bar n starts at barTick + (n - bar) * ticksPerBar");
});

test("set_tempo sets the starting tempo, and says the Tempo Changes keep theirs", () => {
  const project = slowingDown();
  const setting = plan("set_tempo", { tempo: 100 }, project);
  expect(setting.change).toBe("Set the starting tempo to 100 BPM");
  expect(setting.report).toBe(
    "The song starts at 100 BPM. It has Tempo Changes, so that tempo lasts until 2.1.000, where a Tempo Change sets 60 BPM; the Tempo Changes kept their tempos.",
  );
  const result = applyCommands(project, setting.commands);
  if (!result.ok) throw new Error(result.error);
  expect(result.project.tempo).toBe(100);
  expect(result.project.tempoChanges).toEqual(project.tempoChanges);
  // Now bar 2 comes at 2.4 s, and every change after it with it.
  expect(projectSummary(result.project).tempoChanges!.map((change) => change.seconds)).toEqual([2.4, 6.4, 8.4]);

  // A change of time signature alone leaves the tempo the same throughout.
  const waltz = deepFreeze({ ...sampleProject(), tempoChanges: [slowingDown().tempoChanges[1]!] });
  expect(plan("set_tempo", { tempo: 100 }, waltz).report).toBe("The tempo is now 100 BPM.");
  expect(TOOL_DEFINITIONS.find((tool) => tool.name === "set_tempo")!.description).toMatch(/Tempo Changes/);
});

test("Clips placed and moved after Tempo Changes land on the bar the map puts there", () => {
  const project = slowingDown();
  // Bar 4 is a bar of 3/4 after bar 3.
  const bar4 = 7680 + 2880;
  expect(plan("place_clip", { trackId: "keys", start: bar4, length: 2880 }, project).change).toBe(
    "Placed a Pattern Clip on “Keys” at 4.1.000",
  );
  const moved = plan("move_clip", { clipId: "vocals-1", start: bar4 }, project);
  expect(moved.change).toBe("Moved a Clip on “Vocals” to 4.1.000");
  const result = applyCommands(project, moved.commands);
  if (!result.ok) throw new Error(result.error);
  // Its 4 s now play at 90: six beats, and still 4 s.
  expect(projectSummary(result.project).tracks[2]!.clips[0]).toMatchObject({ start: bar4, duration: 4, length: 5760 });
});

test("analyse_audio over bars after Tempo Changes hears the seconds they play at", () => {
  const project = slowingDown();
  const [bar4, bar5] = [7680 + 2880, 7680 + 2 * 2880];
  const listening = plan("analyse_audio", { start: bar4, end: bar5 }, project);
  expect(listening.listen).toEqual({ start: bar4, end: bar5, track: null, spectrogram: false });
  // 8 s to the change to 90, then two thirds of a second to bar 4, and a
  // bar of three beats at 90 lasts 2 s.
  expect(listening.report).toBe("The whole mix, from 4.1.000 (8.667 s) to 5.1.000 (10.667 s), measured:");
  // Left out, the end is where the Audio Clip's 4 s run out under the map.
  expect(plan("analyse_audio", {}, project).listen).toMatchObject({ start: 0, end: 3840 + 3840 });
});

test("add_tempo_change changes the tempo from a bar on: Pattern Clips follow it, and Audio Clips keep their start and natural speed", () => {
  const project = sampleProject();
  const adding = plan("add_tempo_change", { bar: 2, tempo: 60 }, project);
  expect(adding.change).toBe("Changed the tempo to 60 BPM at 2.1.000");
  const [command] = adding.commands;
  expect(command).toMatchObject({ type: "addTempoChange", tempoChange: { tick: 3840, tempo: 60, timeSignature: null } });
  const id = command!.type === "addTempoChange" ? command.tempoChange.id : "";
  expect(adding.report).toBe(`Added Tempo Change ${id} at 2.1.000 (tick 3840, 2 s): 60 BPM from there.`);
  const result = applyCommands(project, adding.commands);
  if (!result.ok) throw new Error(result.error);
  const model = projectSummary(result.project);
  expect(model.tempoChanges).toEqual([
    { tempoChangeId: id, tick: 3840, bar: 2, barTick: 3840, seconds: 2, tempo: 60, timeSignature: "4/4", ticksPerBar: 3840 },
  ]);
  // Every Clip keeps its tick. The Pattern Clips' notes play at 60 from bar
  // 2; the Audio Clip still starts at bar 2 and plays its 4 s, now 4 beats.
  expect(result.project.tracks.map((track) => track.clips)).toEqual(project.tracks.map((track) => track.clips));
  expect(model.tracks[2]!.clips[0]).toMatchObject({ start: 3840, duration: 4, length: 3840 });

  // Part way through a bar, counting bars from 1.
  expect(plan("add_tempo_change", { bar: 2.5, tempo: 90 }, project).commands[0]).toMatchObject({ tempoChange: { tick: 5760 } });
  // Where a Tempo Change already is, it sets that one's tempo.
  const waltz = plan("add_tempo_change", { bar: 3, tempo: 100 }, slowingDown());
  expect(waltz.commands).toEqual([{ type: "setTempoChange", tempoChangeId: "waltz", tempo: 100 }]);
  expect(waltz.change).toBe("Set the Tempo Change at 3.1.000 to 100 BPM");
  expect(waltz.report).toBe("Tempo Change waltz, at 3.1.000 (tick 7680), now sets 100 BPM, and still 3/4.");

  expect(() => plan("add_tempo_change", { bar: 1, tempo: 90 })).toThrow(/bar 1 is the song's start, whose tempo set_tempo sets/);
  expect(() => plan("add_tempo_change", { bar: "9", tempo: 90 })).toThrow(InvalidToolCall);
  expect(() => plan("add_tempo_change", { bar: 9, tempo: 5 })).toThrow(/tempo must be a number from 20 to 999/);
  const description = TOOL_DEFINITIONS.find((tool) => tool.name === "add_tempo_change")!.description;
  expect(description).toMatch(/Pattern Clips follow the change/);
  expect(description).toMatch(/Audio Clips keep their start and play at their natural speed/);
});

test("move_tempo_change moves one to another bar, a time signature only to a bar line", () => {
  const project = slowingDown();
  // Without “lift”, bar 3 is 3/4 from tick 7680, so half way is 1440 on.
  const lift = plan("move_tempo_change", { tempoChangeId: "lift", bar: 3.5 }, project);
  expect(lift.commands).toEqual([{ type: "moveTempoChange", tempoChangeId: "lift", tick: 9120 }]);
  expect(lift.change).toBe("Moved the Tempo Change at 3.3.000 to 3.2.480");
  expect(lift.report).toBe("Tempo Change lift is now at 3.2.480 (tick 9120).");

  // Without “waltz”, the song is 4/4 throughout, so bar 4 is at 11520.
  const waltz = planned("move_tempo_change", { tempoChangeId: "waltz", bar: 4 }, project);
  expect(waltz.tempoChanges.map(({ id, tick }) => [id, tick])).toEqual([
    ["slow", 3840],
    ["lift", 9600],
    ["waltz", 11520],
  ]);

  expect(() => plan("move_tempo_change", { tempoChangeId: "waltz", bar: 2.5 }, project)).toThrow(
    "A time signature can only change at a bar line, and bar 2.5 is part way through bar 2: give a whole bar",
  );
  expect(() => plan("move_tempo_change", { tempoChangeId: "lift", bar: 2 }, project)).toThrow(
    "Tempo Change slow is already at 2.1.000: move or delete that one first",
  );
  expect(() => plan("move_tempo_change", { tempoChangeId: "slow", bar: 2 }, project)).toThrow("Tempo Change slow is already at 2.1.000");
  expect(() => plan("move_tempo_change", { tempoChangeId: "slow", bar: 1 }, project)).toThrow(/song's start/);
  expect(() => plan("move_tempo_change", { tempoChangeId: "fast", bar: 4 }, project)).toThrow(
    "There's no Tempo Change with id fast. The Tempo Changes are: slow (at 2.1.000), waltz (at 3.1.000), lift (at 3.3.000).",
  );
  expect(() => plan("move_tempo_change", { tempoChangeId: "fast", bar: 4 })).toThrow("The song has no Tempo Changes.");
});

/** The sample song in 3/4 from bar 3 and back in 4/4 from bar 5. */
function waltzBars() {
  const project = sampleProject();
  project.tempoChanges.push(
    { id: "waltz", tick: 7680, tempo: null, timeSignature: { beatsPerBar: 3, beatUnit: 4 } },
    { id: "back", tick: 7680 + 2 * 2880, tempo: null, timeSignature: { beatsPerBar: 4, beatUnit: 4 } },
  );
  return deepFreeze(project);
}

test("delete_tempo_change takes one away, and refuses to leave a later time signature off a bar line", () => {
  const deleting = plan("delete_tempo_change", { tempoChangeId: "slow" }, slowingDown());
  expect(deleting.commands).toEqual([{ type: "deleteTempoChange", tempoChangeId: "slow" }]);
  expect(deleting.change).toBe("Deleted the Tempo Change at 2.1.000");
  expect(deleting.report).toBe("Tempo Change slow is gone: from tick 3840 the song is at 120 BPM in 4/4.");
  expect(planned("delete_tempo_change", { tempoChangeId: "back" }, waltzBars()).tempoChanges.map(({ id }) => id)).toEqual(["waltz"]);

  // Without the 3/4, tick 13440 is half way through bar 4.
  expect(() => plan("delete_tempo_change", { tempoChangeId: "waltz" }, waltzBars())).toThrow(
    "Deleting Tempo Change waltz would leave Tempo Change back's time signature, 4/4 at tick 13440, part way through bar 4, and a time signature can only change at a bar line. Delete that Tempo Change first and set its time signature again at the bar you want",
  );
  expect(() => plan("delete_tempo_change", { tempoChangeId: "gone" }, waltzBars())).toThrow(/no Tempo Change with id gone/);
});

test("set_time_signature sets it at a bar line: the song's own at bar 1, and a Tempo Change later", () => {
  const start = plan("set_time_signature", { bar: 1, beatsPerBar: 6, beatUnit: 8 });
  expect(start.commands).toEqual([{ type: "setTimeSignature", timeSignature: { beatsPerBar: 6, beatUnit: 8 } }]);
  expect(start.change).toBe("Set the time signature to 6/8");
  expect(start.report).toBe("The song starts in 6/8, 2880 ticks to a bar.");

  const later = plan("set_time_signature", { bar: 5, beatsPerBar: 3, beatUnit: 4 });
  expect(later.commands[0]).toMatchObject({
    type: "addTempoChange",
    tempoChange: { tick: 15360, tempo: null, timeSignature: { beatsPerBar: 3, beatUnit: 4 } },
  });
  expect(later.change).toBe("Set the time signature to 3/4 at 5.1.000");
  const result = applyCommands(sampleProject(), later.commands);
  if (!result.ok) throw new Error(result.error);
  expect(projectSummary(result.project).tempoChanges).toMatchObject([{ bar: 5, tempo: 120, timeSignature: "3/4", ticksPerBar: 2880 }]);

  // At a Tempo Change that sets only the tempo, it adds the time signature
  // to it: two bars of 2/4 keep the 3/4 after it on its bar line.
  const slow = plan("set_time_signature", { bar: 2, beatsPerBar: 2, beatUnit: 4 }, slowingDown());
  expect(slow.commands).toEqual([{ type: "setTempoChange", tempoChangeId: "slow", timeSignature: { beatsPerBar: 2, beatUnit: 4 } }]);
  expect(slow.report).toBe("Tempo Change slow, at 2.1.000 (tick 3840), now sets 2/4, 1920 ticks to a bar, and still 60 BPM.");
  expect(applyCommands(slowingDown(), slow.commands).ok).toBe(true);
  // 7/8 wouldn't.
  expect(() => plan("set_time_signature", { bar: 2, beatsPerBar: 7, beatUnit: 8 }, slowingDown())).toThrow(
    /^Setting 7\/8 at bar 2 would leave Tempo Change waltz's time signature, 3\/4 at tick 7680, part way through bar 3/,
  );

  // Off a bar line, it is refused.
  expect(() => plan("set_time_signature", { bar: 5.5, beatsPerBar: 3, beatUnit: 4 })).toThrow(
    "A time signature can only change at a bar line, and bar 5.5 is part way through bar 5: give a whole bar",
  );
  expect(() => plan("set_time_signature", { bar: 5, beatsPerBar: 4, beatUnit: 4 })).toThrow("The time signature at bar 5 is already 4/4");
  expect(() => plan("set_time_signature", { bar: 5, beatsPerBar: 3, beatUnit: 3 })).toThrow("beatUnit must be one of 1, 2, 4, 8, 16, 32");
  expect(() => plan("set_time_signature", { bar: 5, beatsPerBar: 0, beatUnit: 4 })).toThrow("beatsPerBar must be a whole number from 1 to 32");
  expect(() => plan("set_time_signature", { bar: 0, beatsPerBar: 3, beatUnit: 4 })).toThrow("bar must be a bar number, 1 or more");
  // 5/4 from the start would put the 3/4 at tick 7680 part way through bar 2.
  expect(() => plan("set_time_signature", { bar: 1, beatsPerBar: 5, beatUnit: 4 }, waltzBars())).toThrow(
    /^Setting 5\/4 at bar 1 would leave Tempo Change waltz's time signature, 3\/4 at tick 7680, part way through bar 2/,
  );
  const description = TOOL_DEFINITIONS.find((tool) => tool.name === "set_time_signature")!.description;
  expect(description).toMatch(/only at a bar line/);
  expect(SYSTEM_PROMPT).toMatch(/add_tempo_change, move_tempo_change and delete_tempo_change, which name a Tempo Change by its tempoChangeId, and set_time_signature, only at a bar line/);
});

/** A factory Synth preset that sets `setting`: every one does. */
function synthPresetNameWith(setting: string): string {
  const name = synthPresetNames()[0]!;
  expect(synthPreset(name)!.settings).toHaveProperty(setting);
  return name;
}

/** The fixture with a second Bus, Drum Bus, that outputs to Band. */
function twoBuses() {
  const project = sampleProject();
  project.buses.push({ ...project.buses[0]!, id: "drum-bus", name: "Drum Bus", insertChain: [], output: "band", sends: [] });
  project.tracks[3]!.output = "drum-bus";
  return project;
}

test("a Bus is added, renamed and deleted, and the model is told its id", () => {
  const added = plan("add_bus", { name: "Reverb" });
  const bus = added.commands[0]!.type === "addBus" ? added.commands[0]!.bus : null;
  expect(bus).toMatchObject({ name: "Reverb", output: null, sends: [], insertChain: [], mixer: { volume: 1, pan: 0 } });
  expect(added.change).toBe("Added the Bus “Reverb”");
  expect(added.report).toContain(`whose busId is ${bus!.id}`);
  expect(planned("add_bus", { name: "Reverb" }).buses.map((each) => each.name)).toEqual(["Band", "Reverb"]);

  expect(planned("rename_bus", { busId: "band", name: "Keys Bus" }).buses[0]!.name).toBe("Keys Bus");
  expect(plan("rename_bus", { busId: "band", name: "Keys Bus" }).change).toBe("Renamed the Bus “Band” to “Keys Bus”");
  expect(() => plan("rename_bus", { busId: "nope", name: "X" })).toThrow("There is no Bus nope. The Project's Buses are: band (“Band”).");
  expect(() => plan("add_send", { channel: "keys", busId: "band" }, createProject())).toThrow(InvalidToolCall);
});

test("deleting a Bus re-routes what fed it as the mixer does: to the Master, its Sends and their Automation gone", () => {
  const project = twoBuses();
  // Keys sends to Drum Bus too, and the level of Vocals' Send to Band is automated.
  project.tracks[0]!.sends.push({ busId: "band", level: 0.3 });
  project.tracks[2]!.automation.push({ setting: "send:band", breakpoints: [{ tick: 0, value: 0.2, hold: false }] });
  const deleted = planned("delete_bus", { busId: "band" }, project);
  // Exactly what the mixer's Delete button does.
  const byHand = applyCommands(project, [{ type: "deleteBus", busId: "band" }]);
  expect(byHand.ok && byHand.project).toEqual(deleted);
  expect(deleted.buses.map((bus) => bus.id)).toEqual(["drum-bus"]);
  expect(deleted.buses[0]!.output).toBeNull();
  expect(deleted.tracks.map((track) => track.output)).toEqual([null, null, null, "drum-bus"]);
  expect(deleted.tracks.map((track) => track.sends)).toEqual([[], [], [], []]);
  expect(deleted.tracks[2]!.automation.map((lane) => lane.setting)).toEqual(["volume"]);

  const report = plan("delete_bus", { busId: "band" }, project).report;
  expect(report).toBe(
    "Bus band (“Band”) is gone. Track bass (“Bass”), Bus drum-bus (“Drum Bus”) now output to the Master. The Sends to it from Track keys (“Keys”), Track vocals (“Vocals”) are gone, and so is the Automation of the Send from Track vocals (“Vocals”).",
  );
  expect(plan("delete_bus", { busId: "band" }, project).change).toBe("Deleted the Bus “Band”");
});

test("set_output routes a Track or a Bus to a Bus or the Master, with the mixer's commands", () => {
  const project = twoBuses();
  const keys = plan("set_output", { channel: "keys", target: "drum-bus" }, project);
  expect(keys.commands).toEqual([{ type: "setTrackOutput", trackId: "keys", output: "drum-bus" }]);
  expect(keys.change).toBe("Routed “Keys” to the Bus “Drum Bus”");
  expect(keys.report).toBe("Track keys (“Keys”) outputs to Bus drum-bus (“Drum Bus”).");
  const bus = plan("set_output", { channel: "drum-bus", target: "master" }, project);
  expect(bus.commands).toEqual([{ type: "setBusOutput", busId: "drum-bus", output: null }]);
  expect(bus.change).toBe("Routed the Bus “Drum Bus” to the Master");
  expect(planned("set_output", { channel: "bass", target: "master" }, project).tracks[1]!.output).toBeNull();

  expect(() => plan("set_output", { channel: "master", target: "band" }, project)).toThrow(/The Master has no output or Sends/);
  expect(() => plan("set_output", { channel: "keys", target: "nope" }, project)).toThrow(/There is no Bus nope/);
});

test("a cycle by output or by Send is refused with the message the mixer gives, and nothing changes", () => {
  const project = twoBuses();
  // Drum Bus outputs to Band, so Band can't feed Drum Bus either way.
  const byOutput = routingProblem(project, { busId: "band" }, "drum-bus");
  expect(byOutput).toBe("Band can't feed Drum Bus: the signal would go round in a loop (Band → Drum Bus → Band)");
  expect(() => plan("set_output", { channel: "band", target: "drum-bus" }, project)).toThrow(new InvalidToolCall(`${byOutput}.`));
  expect(() => plan("set_output", { channel: "band", target: "band" }, project)).toThrow("Band can't feed itself.");

  const bySend = sendProblem(project, { busId: "band" }, "drum-bus");
  expect(bySend).toBe("Band can't send to Drum Bus: the signal would go round in a loop (Band → Drum Bus → Band)");
  expect(() => plan("add_send", { channel: "band", busId: "drum-bus" }, project)).toThrow(new InvalidToolCall(`${bySend}.`));
  // A loop through a Send is one too: once Band sends to Reverb, Reverb can't output to Band.
  project.buses.push({ ...project.buses[0]!, id: "reverb", name: "Reverb", insertChain: [], output: null, sends: [] });
  const sending = planned("add_send", { channel: "band", busId: "reverb" }, project);
  expect(() => plan("set_output", { channel: "reverb", target: "band" }, sending)).toThrow(
    "Reverb can't feed Band: the signal would go round in a loop (Reverb → Band → Reverb).",
  );
  // A Track can't loop, but sends to each Bus once.
  expect(() => plan("add_send", { channel: "vocals", busId: "band" }, project)).toThrow("Vocals already sends to Band.");
});

test("Sends are added, set and removed from a Track or a Bus, with the mixer's commands", () => {
  const project = twoBuses();
  const added = plan("add_send", { channel: "keys", busId: "drum-bus" }, project);
  expect(added.commands).toEqual([{ type: "addSend", from: { trackId: "keys" }, busId: "drum-bus", level: DEFAULT_SEND_LEVEL }]);
  expect(added.change).toBe("Added a Send from “Keys” to the Bus “Drum Bus” at 0.0 dB");
  expect(planned("add_send", { channel: "drum-bus", busId: "band", level: 0.5 }, project).buses[1]!.sends).toEqual([
    { busId: "band", level: 0.5 },
  ]);
  expect(() => plan("add_send", { channel: "keys", busId: "band", level: 5 }, project)).toThrow(/level must be a number from 0/);

  const set = planned("set_send_level", { channel: "vocals", busId: "band", level: 0.25 }, project);
  expect(set.tracks[2]!.sends).toEqual([{ busId: "band", level: 0.25 }]);
  expect(plan("set_send_level", { channel: "vocals", busId: "band", level: 0.25 }, project).change).toBe(
    "Set the Send from “Vocals” to the Bus “Band” to -12.0 dB",
  );
  project.tracks[2]!.automation.push({ setting: "send:band", breakpoints: [{ tick: 0, value: 0.2, hold: false }] });
  expect(plan("set_send_level", { channel: "vocals", busId: "band", level: 0.25 }, project).report).toMatch(
    /But its Send's level is automated/,
  );

  const removed = plan("remove_send", { channel: "vocals", busId: "band" }, project);
  expect(removed.commands).toEqual([{ type: "removeSend", from: { trackId: "vocals" }, busId: "band" }]);
  expect(removed.report).toBe("Track vocals (“Vocals”) no longer sends to Bus band (“Band”), and the Automation of its level is gone.");
  const gone = planned("remove_send", { channel: "vocals", busId: "band" }, project);
  expect(gone.tracks[2]!.sends).toEqual([]);
  expect(gone.tracks[2]!.automation.map((lane) => lane.setting)).toEqual(["volume"]);

  expect(() => plan("remove_send", { channel: "keys", busId: "band" }, project)).toThrow(
    "Track keys (“Keys”) has no Send to Bus band (“Band”). It has no Sends: add_send adds one.",
  );
  expect(() => plan("set_send_level", { channel: "master", busId: "band", level: 1 }, project)).toThrow(/The Master has no output or Sends/);
});

test("a Bus's volume, pan, mute and solo are set on its own, leaving the rest of its mixer", () => {
  const project = sampleProject();
  project.buses[0]!.automation.push({ setting: "volume", breakpoints: [{ tick: 0, value: 1, hold: false }] });
  const volume = plan("set_bus_volume", { busId: "band", volume: 0.5 }, project);
  expect(volume.commands).toEqual([{ type: "setBusMixer", busId: "band", mixer: { volume: 0.5 } }]);
  expect(volume.change).toBe("Set the Bus “Band” to -6.0 dB");
  expect(volume.report).toMatch(/its Automation overrides this value/);
  expect(planned("set_bus_pan", { busId: "band", pan: -0.5 }, project).buses[0]!.mixer).toEqual({ volume: 1, pan: -0.5, mute: false, solo: false });
  expect(plan("set_bus_pan", { busId: "band", pan: -0.5 }, project).change).toBe("Panned the Bus “Band” 50% left");
  expect(planned("set_bus_mute", { busId: "band", mute: true }, project).buses[0]!.mixer.mute).toBe(true);
  expect(plan("set_bus_mute", { busId: "band", mute: true }, project).change).toBe("Muted the Bus “Band”");
  expect(planned("set_bus_solo", { busId: "band", solo: true }, project).buses[0]!.mixer.solo).toBe(true);
  expect(() => plan("set_bus_volume", { busId: "keys", volume: 1 }, project)).toThrow("There is no Bus keys.");
});

test("the model is told how to route with the routing tools, and that a loop is refused", () => {
  expect(SYSTEM_PROMPT).not.toMatch(/The musician adds, sets and removes Sends on the mixer/);
  expect(SYSTEM_PROMPT).toMatch(/set_output for where a Track or Bus outputs/);
  expect(SYSTEM_PROMPT).toMatch(/go round in a loop is refused/);
  expect(described("delete_bus")).toMatch(/outputs to the Master instead/);
});

test("set_automation replaces a lane's breakpoints over a range, both ends included, and keeps those outside it", () => {
  // The fixture's Vocals fade in from 3840 to 7680, where they hold.
  const song = sampleProject();
  const input = {
    channel: "vocals",
    setting: "volume",
    start: 3000,
    end: 5000,
    breakpoints: [
      { tick: 5000, value: 0.6, hold: true },
      { tick: 3000, value: 0.2 },
    ],
  };
  const drawn = plan("set_automation", input, song);
  expect(drawn.commands).toEqual([
    {
      type: "setAutomation",
      target: { trackId: "vocals" },
      setting: "volume",
      breakpoints: [
        { tick: 3000, value: 0.2, hold: false },
        { tick: 5000, value: 0.6, hold: true },
        { tick: 7680, value: 1, hold: true },
      ],
    },
  ]);
  expect(drawn.change).toBe("Automated “Vocals”'s Volume from 1.4.120 to 2.2.200");
  expect(drawn.report).toBe(
    "Track vocals (“Vocals”)'s volume (“Volume”) is automated from tick 3000 to tick 5000 by 2 breakpoints, in place of the 1 there; the 1 breakpoint outside that range is kept. Its Automation overrides its fixed value while the song plays.",
  );
  // The ends are in the range: from 3840 to 7680 replaces both breakpoints.
  const whole = planned("set_automation", { ...input, start: 3840, end: 7680, breakpoints: [{ tick: 7680, value: 0.5 }] }, song);
  expect(whole.tracks[2]!.automation).toEqual([{ setting: "volume", breakpoints: [{ tick: 7680, value: 0.5, hold: false }] }]);
  // Beyond the lane, it adds to it.
  const later = planned("set_automation", { ...input, start: 9000, end: 9600, breakpoints: [{ tick: 9600, value: 0 }] }, song);
  expect(later.tracks[2]!.automation[0]!.breakpoints.map((point) => point.tick)).toEqual([3840, 7680, 9600]);
});

test("set_automation draws any automatable setting, named as the summary and read_automation name it", () => {
  const song = widelyAutomated();
  // Every setting the summary lists as automated, redrawn by its own name.
  const summary = projectSummary(song);
  const owners = [
    ...summary.tracks.map((track) => [track.trackId, track.automated ?? []] as const),
    ...summary.buses!.map((bus) => [bus.busId, bus.automated ?? []] as const),
    ["master", summary.master.automated ?? []] as const,
  ];
  let drawn = 0;
  for (const [channel, settings] of owners) {
    for (const setting of settings) {
      const read = plan("read_automation", { channel, setting }, song).report;
      const [first] = JSON.parse(read.slice(read.indexOf("\n") + 1))[0].breakpoints as { tick: number }[];
      const redrawn = planned("set_automation", { channel, setting, start: first!.tick, end: first!.tick, breakpoints: [first] }, song);
      expect(redrawn).toEqual(song);
      drawn++;
    }
  }
  expect(drawn).toBe(6);

  // And settings not yet automated: a Track's pan, a Send, an Effect's and the Synth's numbers, a Bus's and the Master's.
  const fresh = sampleProject();
  const draw = (channel: string, setting: string, value: number) =>
    planned("set_automation", { channel, setting, start: 0, end: 960, breakpoints: [{ tick: 960, value }] }, fresh);
  expect(draw("keys", "pan", -1).tracks[0]!.automation).toEqual([{ setting: "pan", breakpoints: [{ tick: 960, value: -1, hold: false }] }]);
  expect(draw("vocals", "send:band", 2).tracks[2]!.automation[1]).toEqual({ setting: "send:band", breakpoints: [{ tick: 960, value: 2, hold: false }] });
  expect(draw("keys", "effect:keys-eq:lowShelfGainDb", -12).tracks[0]!.automation[0]!.setting).toBe("effect:keys-eq:lowShelfGainDb");
  expect(draw("keys", "instrument:cutoffHz", 20000).tracks[0]!.automation[0]!.setting).toBe("instrument:cutoffHz");
  expect(draw("band", "pan", 0.5).buses[0]!.automation[0]!.setting).toBe("pan");
  expect(draw("master", "effect:master-comp:thresholdDb", -30).master.automation.map((lane) => lane.setting)).toEqual([
    "volume",
    "effect:master-comp:thresholdDb",
  ]);
  expect(plan("set_automation", { channel: "keys", setting: "instrument:cutoffHz", start: 0, end: 0, breakpoints: [{ tick: 0, value: 400 }] }).change).toBe(
    "Automated “Keys”'s Synth: Cutoff from 1.1.000 to 1.1.000",
  );
});

/** A set_automation of the Keys' volume over two beats, with `input` changed, to call later. */
function drawing(input: Record<string, unknown>) {
  return () =>
    plan("set_automation", { channel: "keys", setting: "volume", start: 0, end: 1920, breakpoints: [{ tick: 0, value: 1 }], ...input });
}

test("an unknown channel or setting, or a value out of the setting's range, is an InvalidToolCall saying which", () => {
  expect(drawing({ channel: "strings" })).toThrow(/There is no Track or Bus strings/);
  expect(drawing({ setting: "mute" })).toThrow(InvalidToolCall);
  expect(drawing({ setting: "mute" })).toThrow(
    /^Track keys \(“Keys”\) has no setting "mute" to automate: mute, solo, bypass and settings that pick from a list or switch on and off never are\. It can automate: volume \(Volume, 0 to 2\); pan \(Pan, -1 to 1\); effect:keys-eq:/,
  );
  expect(drawing({ setting: "mute" })).toThrow(/instrument:cutoffHz \(Synth: Cutoff, 20 Hz to 20000 Hz\)/);
  expect(drawing({ setting: "effect:keys-eq:nonsense" })).toThrow(/has no setting "effect:keys-eq:nonsense" to automate/);
  expect(drawing({ setting: "send:band" })).toThrow(/Track keys \(“Keys”\) has no setting "send:band"/);
  expect(drawing({ channel: "master", setting: "pan" })).toThrow(/^the Master has no setting "pan" to automate/);
  expect(drawing({ channel: "drums", setting: "instrument:cutoffHz" })).toThrow(/Track drums \(“Drums”\) has no setting "instrument:cutoffHz"/);

  expect(drawing({ breakpoints: [{ tick: 0, value: 1 }, { tick: 960, value: 2.5 }] })).toThrow(
    "breakpoints[1].value, 2.5, is out of range: Track keys (“Keys”)'s volume (“Volume”) takes a number from 0 to 2",
  );
  expect(drawing({ setting: "instrument:cutoffHz", breakpoints: [{ tick: 0, value: 30000 }] })).toThrow(
    "breakpoints[0].value, 30000, is out of range: Track keys (“Keys”)'s instrument:cutoffHz (“Synth: Cutoff”) takes a number from 20 Hz to 20000 Hz",
  );
  expect(drawing({ setting: "pan", breakpoints: [{ tick: 0, value: "left" }] })).toThrow(/breakpoints\[0\]\.value, "left", is out of range/);
  expect(drawing({ breakpoints: [{ tick: 1921, value: 1 }] })).toThrow(/breakpoints\[0\]\.tick, 1921, is outside the range: every breakpoint must be from start \(0\) to end \(1920\)/);
  expect(drawing({ breakpoints: [{ tick: 0, value: 1 }, { tick: 0, value: 0 }] })).toThrow(/a second breakpoint at tick 0/);
  expect(drawing({ breakpoints: [{ tick: 0, value: 1, curve: "exp" }] })).toThrow(/breakpoints\[0\] has no field called curve/);
  expect(drawing({ breakpoints: [{ tick: 0, value: 1, hold: "yes" }] })).toThrow(/breakpoints\[0\]\.hold must be true or false/);
  expect(drawing({ breakpoints: [] })).toThrow(/clear_automation takes breakpoints away/);
  expect(drawing({ start: 960, end: 0 })).toThrow(/end must not be before start/);
  expect(drawing({ start: -1 })).toThrow(/start must be a whole number of ticks/);
});

test("clear_automation takes away a lane, or its breakpoints in a range, keeping the rest", () => {
  const song = sampleProject();
  const all = plan("clear_automation", { channel: "vocals", setting: "volume" }, song);
  expect(all.commands).toEqual([{ type: "setAutomation", target: { trackId: "vocals" }, setting: "volume", breakpoints: [] }]);
  expect(all.change).toBe("Cleared “Vocals”'s Volume Automation");
  expect(all.report).toBe("Track vocals (“Vocals”)'s volume (“Volume”) is no longer automated: its 2 breakpoints are gone, and it is back at its fixed value, 1.");
  expect(planned("clear_automation", { channel: "vocals", setting: "volume" }, song).tracks[2]!.automation).toEqual([]);

  const part = plan("clear_automation", { channel: "vocals", setting: "volume", start: 7680 }, song);
  expect(part.change).toBe("Cleared “Vocals”'s Volume Automation from 3.1.000 on");
  expect(part.report).toBe("Track vocals (“Vocals”)'s volume (“Volume”) lost its 1 breakpoint from tick 7680 on; the 1 breakpoint outside that range is kept.");
  expect(planned("clear_automation", { channel: "vocals", setting: "volume", start: 0, end: 3840 }, song).tracks[2]!.automation).toEqual([
    { setting: "volume", breakpoints: [{ tick: 7680, value: 1, hold: true }] },
  ]);
  // A range that takes every breakpoint takes the lane.
  expect(planned("clear_automation", { channel: "master", setting: "volume", end: 0 }, song).master.automation).toEqual([]);

  const clearing = (input: Record<string, unknown>) => () => plan("clear_automation", { channel: "vocals", setting: "volume", ...input }, song);
  expect(clearing({ setting: "pan" })).toThrow("Track vocals (“Vocals”)'s pan (“Pan”) isn't automated, so there is nothing to clear. Its automated settings are: volume.");
  expect(clearing({ channel: "keys" })).toThrow(/isn't automated, so there is nothing to clear\. None of its settings is automated\./);
  expect(clearing({ setting: "solo" })).toThrow(/has no setting "solo" to automate/);
  expect(clearing({ start: 4000, end: 7000 })).toThrow("Track vocals (“Vocals”)'s volume (“Volume”) has no breakpoints from tick 4000 to tick 7000. read_automation reads where they are.");
  expect(clearing({ start: 10, end: 0 })).toThrow(/end must not be before start/);
});

test("a set_automation that would leave more breakpoints than an Automation holds is refused", () => {
  const song = sampleProject();
  // The two the Vocals have are kept, outside the range.
  const breakpoints = Array.from({ length: 4095 }, (_, index) => ({ tick: 10_000 + index, value: 0.5 }));
  expect(() => plan("set_automation", { channel: "vocals", setting: "volume", start: 10_000, end: 20_000, breakpoints }, song)).toThrow(
    "An Automation holds at most 4096 breakpoints, and this would leave 4097",
  );
});

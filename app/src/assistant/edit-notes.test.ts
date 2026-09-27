/**
 * The note-editing stories of the v3 PRD, as the tool calls a model would
 * make for them: each reads the notes it needs, changes them by id, and
 * leaves every other note as it was, all as one Request that one undo takes
 * back.
 */
import { expect, test } from "vitest";

import { ProjectHistory } from "../project/history";
import { createDrumTrack, createInstrumentTrack, createProject, type Note, type Project } from "../project/model";
import { TICKS_PER_BEAT } from "../project/time";
import { runRequest, type Conversation, type ModelReply, type StartConversation, type ToolResult } from "./assistant";
import type { ToolCall } from "./tools";

const BAR = TICKS_PER_BEAT * 4;
const EIGHTH = TICKS_PER_BEAT / 2;
const SIXTEENTH = TICKS_PER_BEAT / 4;

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

interface ReadNote extends Note {
  id: string;
}

/** The notes a read_notes call returned, as a model would read them. */
function readNotes(results: readonly ToolResult[], callId: string): ReadNote[] {
  const result = results.find((candidate) => candidate.callId === callId);
  if (!result || result.isError) throw new Error(`read_notes failed: ${result?.content}`);
  return JSON.parse(result.content.slice(result.content.indexOf("\n") + 1)) as ReadNote[];
}

function note(pitch: number, start: number, length: number, velocity = 0.8): Note {
  return { pitch, start, length, velocity };
}

const BASSLINE = [note(33, 0, EIGHTH), note(36, BAR, EIGHTH), note(31, 2 * BAR, EIGHTH), note(28, 3 * BAR, EIGHTH)];
const HATS = Array.from({ length: 8 }, (_, eighth) => note(78, eighth * EIGHTH, SIXTEENTH, 0.6));
/** Played in by hand: each a few ticks off the 1/16 grid, one of them late enough to go to the next step. */
const MELODY = [note(69, 7, 230), note(72, 236, 230), note(76, 490, 460), note(74, 1080, 240)];
/** Kick and snare, with two ghost snares between. */
const BEAT = [
  note(36, 0, SIXTEENTH, 1),
  note(38, TICKS_PER_BEAT, SIXTEENTH, 0.9),
  note(38, TICKS_PER_BEAT + 3 * SIXTEENTH, SIXTEENTH, 0.3),
  note(36, 2 * TICKS_PER_BEAT, SIXTEENTH, 1),
  note(38, 2 * TICKS_PER_BEAT + 2 * SIXTEENTH, SIXTEENTH, 0.25),
  note(38, 3 * TICKS_PER_BEAT, SIXTEENTH, 0.9),
];

function song(): Project {
  const project = createProject("Notes");
  const parts: [string, string, Note[], number][] = [
    ["bass", "Bassline", BASSLINE, 4 * BAR],
    ["hats", "Hi-hats", HATS, BAR],
    ["melody", "Melody", MELODY, BAR],
  ];
  for (const [id, name, notes, length] of parts) {
    const track = createInstrumentTrack(name, id);
    track.clips.push({ id: `${id}-1`, kind: "pattern", start: 0, length, notes });
    project.tracks.push(track);
  }
  const drums = createDrumTrack("Drums", "drums");
  drums.clips.push({ id: "drums-1", kind: "pattern", start: 0, length: BAR, notes: BEAT });
  project.tracks.push(drums);
  return project;
}

function notesOf(project: Project, clipId: string): Note[] {
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip?.kind === "pattern") return clip.notes;
  }
  throw new Error(`no Pattern Clip ${clipId}`);
}

/** A Request that loads the notes tools and reads one Clip, then edits it with what `edit` makes of the notes. */
function editing(clipId: string, edit: (notes: ReadNote[]) => ToolCall[], summary: string): StartConversation {
  return scripted(
    () => ({
      text: "",
      toolCalls: [call("g1", "load_tools", { group: "notes" }), call("r1", "read_notes", { clipId })],
    }),
    (results) => ({ text: "", toolCalls: edit(readNotes(results, "r1")) }),
    (results) => {
      const failed = results.filter((result) => result.isError);
      if (failed.length > 0) throw new Error(`a call failed: ${failed.map((result) => result.content).join(" ")}`);
      return { text: summary, toolCalls: [] };
    },
  );
}

async function run(request: string, start: StartConversation) {
  const history = new ProjectHistory(song());
  const before = history.project;
  const outcome = await runRequest({ history, request, start });
  expect(outcome.error).toBeNull();
  const after = history.project;
  // Every Request is one undo step, whatever it did.
  expect(history.undoLabel).toBe("Request");
  expect(history.undo()).toBe(true);
  expect(history.project).toEqual(before);
  expect(history.canUndo).toBe(false);
  return { before, after, outcome };
}

/** Every Clip but `clipId` is untouched. */
function onlyChanged(before: Project, after: Project, clipId: string) {
  for (const clip of ["bass-1", "hats-1", "melody-1", "drums-1"].filter((id) => id !== clipId)) {
    expect(notesOf(after, clip)).toEqual(notesOf(before, clip));
  }
}

test("“make the last two notes of the bassline longer” lengthens those two and no others", async () => {
  const start = editing(
    "bass-1",
    (notes) => {
      const lastTwo = notes.toSorted((a, b) => a.start - b.start).slice(-2);
      return [call("e1", "resize_notes", { clipId: "bass-1", noteIds: lastTwo.map((n) => n.id), by: 3 * EIGHTH })];
    },
    "Made the last two notes of the bassline a dotted quarter longer.",
  );
  const { before, after, outcome } = await run("make the last two notes of the bassline longer", start);
  expect(notesOf(after, "bass-1")).toEqual([
    BASSLINE[0],
    BASSLINE[1],
    { ...BASSLINE[2], length: 4 * EIGHTH },
    { ...BASSLINE[3], length: 4 * EIGHTH },
  ]);
  onlyChanged(before, after, "bass-1");
  expect(outcome.changes).toEqual(["Resized 2 notes in a Clip on “Bassline” by 1440 ticks"]);
});

test("“move the hi-hats up an octave” moves every hi-hat note up 12 semitones", async () => {
  const start = editing(
    "hats-1",
    () => [call("e1", "transpose_notes", { clipId: "hats-1", semitones: 12 })],
    "Moved the hi-hats up an octave.",
  );
  const { before, after } = await run("move the hi-hats up an octave", start);
  expect(notesOf(after, "hats-1")).toEqual(HATS.map((n) => ({ ...n, pitch: 90 })));
  onlyChanged(before, after, "hats-1");
});

test("“quantise the melody to 1/16” puts every melody note on the 1/16 grid, keeping its length", async () => {
  const start = editing(
    "melody-1",
    () => [call("e1", "quantise_notes", { clipId: "melody-1", grid: "1/16" })],
    "Quantised the melody to 1/16.",
  );
  const { before, after } = await run("quantise the melody to 1/16", start);
  expect(notesOf(after, "melody-1")).toEqual([
    { ...MELODY[0], start: 0 },
    { ...MELODY[1], start: SIXTEENTH },
    { ...MELODY[2], start: 2 * SIXTEENTH },
    { ...MELODY[3], start: 5 * SIXTEENTH },
  ]);
  onlyChanged(before, after, "melody-1");
});

test("“soften the ghost notes” lowers only the quiet snares", async () => {
  const start = editing(
    "drums-1",
    (notes) => {
      const ghosts = notes.filter((n) => n.velocity < 0.5);
      return [call("e1", "set_note_velocity", { clipId: "drums-1", noteIds: ghosts.map((n) => n.id), velocity: 0.15 })];
    },
    "Softened the two ghost snares.",
  );
  const { before, after } = await run("soften the ghost notes", start);
  expect(notesOf(after, "drums-1")).toEqual([
    BEAT[0],
    BEAT[1],
    { ...BEAT[2], velocity: 0.15 },
    BEAT[3],
    { ...BEAT[4], velocity: 0.15 },
    BEAT[5],
  ]);
  onlyChanged(before, after, "drums-1");
});

test("an unknown note id is refused, naming it, and the rest of the call is not applied", async () => {
  const start = scripted(
    () => ({ text: "", toolCalls: [call("g1", "load_tools", { group: "notes" })] }),
    () => ({
      text: "",
      toolCalls: [call("e1", "delete_notes", { clipId: "bass-1", noteIds: ["0:33", "480:40"] })],
    }),
    (results) => {
      expect(results[0]).toMatchObject({ isError: true });
      expect(results[0]!.content).toContain("Clip bass-1 has no note with id 480:40.");
      expect(results[0]!.content).toContain("Nothing was changed.");
      return { text: "That note isn't in the bassline.", toolCalls: [] };
    },
  );
  const history = new ProjectHistory(song());
  const before = history.project;
  const outcome = await runRequest({ history, request: "delete the first note of the bassline", start });
  expect(outcome.changes).toEqual([]);
  expect(history.project).toEqual(before);
});

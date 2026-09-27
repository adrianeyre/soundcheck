import { expect, test } from "vitest";

import { applyChange, type Change, compareChanges, compose, inverse } from "./change";
import { applyCommands, type Command } from "./commands";
import { sampleProject } from "./fixtures";
import { diffProjects, type Flat, flatten, presenceKey, unflatten, write } from "./flat";
import { createInstrumentTrack, type Project } from "./model";

const key = (...path: string[]) => JSON.stringify(path);

function run(project: Project, commands: Command[]): Project {
  const result = applyCommands(project, commands);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

/** Apply `commands` to the Project `flat` holds, as an edit, and say what it did. */
function edit(flat: Flat, commands: Command[]) {
  const before = unflatten(flat);
  return applyChange(flat, { kind: "edit", writes: diffProjects(before, run(before, commands)) });
}

test("writes compose into one per key, and one that ends where it began is none", () => {
  const first = [write(key("keys", "name"), "Keys", "Piano"), write(key("", "tempo"), 120, 90)];
  const then = [write(key("keys", "name"), "Piano", "Organ"), write(key("", "tempo"), 90, 120)];
  expect(compose(first, then)).toEqual([write(key("keys", "name"), "Keys", "Organ")]);
  expect(inverse(compose(first, then))).toEqual([write(key("keys", "name"), "Organ", "Keys")]);
});

const change = (copy: string, seq: number, clock: number) =>
  ({ id: `${copy}:${seq}`, copy, seq, clock, kind: "edit", sync: "1", writes: [] }) satisfies Change;

test("Changes are ordered by clock, then by copy, the same on every copy", () => {
  const changes = [change("b", 1, 2), change("a", 2, 2), change("b", 2, 3), change("a", 1, 1)];
  expect(changes.toSorted(compareChanges).map((each) => each.id)).toEqual(["a:1", "a:2", "b:1", "b:2"]);
});

test("an edit leaves what applying it did, and applying it never changes the flat form it was given", () => {
  const flat = flatten(sampleProject());
  const copy = new Map(flat);
  const { flat: after, outcome } = edit(flat, [{ type: "setTempo", tempo: 90 }]);
  expect(flat).toEqual(copy);
  expect(after.get(key("", "tempo"))).toBe(90);
  expect(outcome).toEqual({ applied: [write(key("", "tempo"), 120, 90)], left: [], refused: [], reason: null });
});

test("an undo puts back only what still holds what the step left, and says what it left", () => {
  const flat = flatten(sampleProject());
  const mine = edit(flat, [
    { type: "renameTrack", trackId: "keys", name: "Piano" },
    { type: "setTempo", tempo: 90 },
  ]);
  // A Collaborator renames the Track again.
  const theirs = edit(mine.flat, [{ type: "renameTrack", trackId: "keys", name: "Organ" }]);

  const undone = applyChange(theirs.flat, { kind: "undo", writes: inverse(mine.outcome.applied) });
  expect(unflatten(undone.flat).tracks[0]!.name).toBe("Organ");
  expect(unflatten(undone.flat).tempo).toBe(120);
  expect(undone.outcome.left).toEqual([write(key("keys", "name"), "Piano", "Keys")]);
  expect(undone.outcome.applied).toEqual([write(key("", "tempo"), 90, 120)]);
});

test("undoing an added Track that a Collaborator has changed since leaves the whole Track", () => {
  const flat = flatten(sampleProject());
  const mine = edit(flat, [{ type: "addTrack", track: createInstrumentTrack("Lead", "lead") }]);
  const theirs = edit(mine.flat, [{ type: "renameTrack", trackId: "lead", name: "Solo" }]);

  const undone = applyChange(theirs.flat, { kind: "undo", writes: inverse(mine.outcome.applied) });
  const tracks = unflatten(undone.flat).tracks;
  // Never half taken away: it is all still there, with their name.
  expect(tracks.find((track) => track.id === "lead")?.name).toBe("Solo");
  expect(undone.outcome.left.some((each) => each.key === presenceKey("lead"))).toBe(true);
});

test("undoing a deleted Track brings it back with what a Collaborator changed in it meanwhile", () => {
  const flat = flatten(sampleProject());
  const mine = edit(flat, [{ type: "deleteTrack", trackId: "bass" }]);
  // Their copy hadn't seen the delete when they turned the Track down.
  const theirs = applyChange(mine.flat, { kind: "edit", writes: [write(key("bass", "mixer", "volume"), 0.8, 0.3)] });

  const undone = applyChange(theirs.flat, { kind: "undo", writes: inverse(mine.outcome.applied) });
  const bass = unflatten(undone.flat).tracks.find((track) => track.id === "bass");
  expect(bass?.mixer.volume).toBe(0.3);
  expect(unflatten(undone.flat).tracks.map((track) => track.id)).toEqual(sampleProject().tracks.map((track) => track.id));
});

test("an undo that needs what a Collaborator has deleted since lands the rest, and the Project stays valid", () => {
  const flat = flatten(sampleProject());
  const mine = edit(flat, [{ type: "deleteBus", busId: "band" }]);
  // Meanwhile a Collaborator deletes Vocals, whose Send fed the Bus.
  const theirs = edit(mine.flat, [{ type: "deleteTrack", trackId: "vocals" }]);

  const undone = applyChange(theirs.flat, { kind: "undo", writes: inverse(mine.outcome.applied) });
  const project = unflatten(undone.flat);
  expect(project.buses.map((bus) => bus.id)).toContain("band");
  expect(project.tracks.map((track) => track.id)).not.toContain("vocals");
  expect(undone.project).not.toBeNull();
});

test("an edit that would leave the Project invalid is refused, says why, and changes nothing", () => {
  const flat = flatten(sampleProject());
  // A Send from Keys to a Bus that another copy has already deleted.
  const gone = edit(flat, [{ type: "deleteBus", busId: "band" }]);
  const send = applyChange(gone.flat, {
    kind: "edit",
    writes: [
      write(presenceKey("keys/sends/band"), undefined, { parent: "keys", slot: ["sends"] }),
      write(key("keys/sends/band", "busId"), undefined, "band"),
      write(key("keys/sends/band", "level"), undefined, 1),
      write(key("#", "keys", "sends"), [], ["keys/sends/band"]),
    ],
  });
  expect(send.outcome.applied).toEqual([]);
  expect(send.outcome.refused).toHaveLength(4);
  expect(send.outcome.reason).toMatch(/Send must feed a Bus/);
  expect(send.flat).toEqual(gone.flat);
});

test("an edit that makes an object anew clears what a Collaborator left under it while it was gone", () => {
  const keys = sampleProject().tracks[0]!;
  if (keys.kind !== "instrument") throw new Error("Keys is an Instrument Track");
  const synth = keys.instrument;
  const pads = [{ name: "Kick", note: 36, sample: null, volume: 1, pan: 0, pitch: 0, chokeGroup: 0 }];
  const drums = edit(flatten(sampleProject()), [
    { type: "setInstrument", trackId: "keys", instrument: { type: "drumSampler", preset: null, pads } },
  ]);
  // A Collaborator who hadn't seen that set a synth setting, and one it doesn't have.
  const theirs = new Map(drums.flat);
  const settings = key("keys", "instrument", "settings");
  theirs.set(JSON.stringify([...JSON.parse(settings), "stray"]), 1);
  expect(unflatten(theirs)).toEqual(unflatten(drums.flat));

  const back = edit(theirs, [{ type: "setInstrument", trackId: "keys", instrument: synth }]);
  expect(back.outcome.refused).toEqual([]);
  expect([...back.flat.keys()].some((each) => each.includes('"stray"'))).toBe(false);
  expect(unflatten(back.flat).tracks[0]).toMatchObject({ instrument: synth });
});

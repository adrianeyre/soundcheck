import { expect, test } from "vitest";

import { applyCommands, type Command } from "./commands";
import { deepFreeze, sampleProject } from "./fixtures";
import { diffProjects, type Flat, flatten, keep, presenceKey, same, unflatten, type Write } from "./flat";
import { createBus, createInstrumentTrack, type Project } from "./model";

/** Every key that differs, found the slow way: both Projects flattened whole. */
function fullDiff(before: Project, after: Project): Write[] {
  const a = flatten(before);
  const b = flatten(after);
  return [...new Set([...a.keys(), ...b.keys()])]
    .toSorted()
    .filter((key) => !same(a.get(key), b.get(key)))
    .map((key) => {
      const each: Write = { key };
      if (a.has(key)) each.from = a.get(key)!;
      if (b.has(key)) each.to = b.get(key)!;
      return each;
    });
}

function run(project: Project, commands: Command[]): Project {
  const result = applyCommands(project, commands);
  if (!result.ok) throw new Error(result.error);
  return result.project;
}

test("a Project flattens and builds back exactly as it was", () => {
  const project = sampleProject();
  expect(unflatten(flatten(project))).toEqual(project);
});

test("every item is keyed by its id, and a list's order is an entry of its own", () => {
  const flat = flatten(sampleProject());
  expect(flat.get(presenceKey("vocals"))).toEqual({ parent: "", slot: ["tracks"] });
  expect(flat.get(presenceKey("keys-1"))).toEqual({ parent: "keys", slot: ["clips"] });
  expect(flat.get(presenceKey("master-comp"))).toEqual({ parent: "", slot: ["master", "insertChain"] });
  // A Send is known by the Bus it feeds, an Automation by its setting.
  expect(flat.get(presenceKey("vocals/sends/band"))).toEqual({ parent: "vocals", slot: ["sends"] });
  expect(flat.get(presenceKey("vocals/automation/volume"))).toBeDefined();
  expect(flat.get(JSON.stringify(["#", "", "tracks"]))).toEqual(["keys", "bass", "vocals", "drums"]);
  expect(flat.get(JSON.stringify(["vocals", "mixer", "volume"]))).toBe(1);
  // Notes are one value: two edits to one Clip's notes don't merge.
  expect(flat.get(JSON.stringify(["keys-1", "notes"]))).toHaveLength(2);
});

test("the diff of a command is what flattening both Projects whole finds, however it got there", () => {
  const before = deepFreeze(sampleProject());
  const cases: Command[][] = [
    [{ type: "setTempo", tempo: 90 }],
    [{ type: "renameTrack", trackId: "keys", name: "Piano" }],
    [{ type: "deleteTrack", trackId: "vocals" }],
    [{ type: "addTrack", track: createInstrumentTrack("Lead", "lead") }],
    [{ type: "addBus", bus: createBus("Verb", "verb") }],
    [{ type: "moveClip", clipId: "keys-1", trackId: "bass", start: 960 }],
    [{ type: "setTrackMixer", trackId: "bass", mixer: { volume: 0.5 } }],
    [{ type: "setInstrument", trackId: "keys", instrument: { type: "drumSampler", preset: null, pads: [{ name: "Kick", note: 36, sample: null, volume: 1, pan: 0, pitch: 0, chokeGroup: 0 }] } }],
    [{ type: "deleteBus", busId: "band" }],
  ];
  for (const commands of cases) {
    const after = run(before, commands);
    expect(diffProjects(before, after)).toEqual(fullDiff(before, after));
  }
});

test("a Clip moved to another Track is the same Clip: only where it is changes", () => {
  const before = sampleProject();
  const after = run(before, [{ type: "moveClip", clipId: "keys-1", trackId: "bass", start: 0 }]);
  const keys = diffProjects(before, after).map((each) => each.key);
  expect(keys).toContain(presenceKey("keys-1"));
  expect(keys.some((key) => key.includes('"notes"'))).toBe(false);
});

test("a Project built back from a flat form keeps the objects that didn't change", () => {
  const before = sampleProject();
  const flat: Flat = flatten(before);
  flat.set(JSON.stringify(["bass", "name"]), "Sub");
  const after = keep(before, unflatten(flat));
  expect(after.tracks[1]!.name).toBe("Sub");
  expect(after.tracks[0]).toBe(before.tracks[0]);
  expect(after.tracks[1]!.clips).toBe(before.tracks[1]!.clips);
  expect(after.master).toBe(before.master);
  expect(keep(before, unflatten(flatten(before)))).toBe(before);
});

test("Sections and Tempo Changes added by two people at once are put in order", () => {
  const flat = flatten(sampleProject());
  for (const [id, startBar] of [["late", 9], ["early", 1]] as const) {
    flat.set(presenceKey(id), { parent: "", slot: ["sections"] });
    for (const [field, value] of Object.entries({ id, name: id, startBar, bars: 4 })) {
      flat.set(JSON.stringify([id, field]), value);
    }
  }
  // Each one's order knows only its own.
  flat.set(JSON.stringify(["#", "", "sections"]), ["late"]);
  expect(unflatten(flat).sections.map((section) => section.id)).toEqual(["early", "late"]);
});

test("an item whose owner has gone is left out, and comes back with it", () => {
  const flat = flatten(sampleProject());
  const presence = flat.get(presenceKey("keys"))!;
  flat.delete(presenceKey("keys"));
  expect(unflatten(flat).tracks.map((track) => track.id)).toEqual(["bass", "vocals", "drums"]);
  flat.set(presenceKey("keys"), presence);
  expect(unflatten(flat)).toEqual(sampleProject());
});

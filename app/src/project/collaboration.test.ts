/**
 * Several people's copies of one Project, passing Changes between them the
 * way live sync does (after every step) and the way offline sync does (days
 * later, in any order, some twice). ADR 0007's spike proved the model on a
 * small Project; these prove the app's own history, commands and rules.
 */
import { describe, expect, test } from "vitest";

import { type Change, SYNC_VERSION } from "./change";
import type { Command } from "./commands";
import { sampleProject } from "./fixtures";
import { ProjectHistory, type Notice } from "./history";
import { createBus, createEffect, createInstrumentTrack } from "./model";
import { validateProject } from "./validate";

interface Copy {
  history: ProjectHistory;
  notices: Notice[];
}

/** One copy each of the same Project, named in the order the log puts them. */
function copies(...names: string[]): Copy[] {
  const project = sampleProject();
  return names.map((name) => {
    const history = new ProjectHistory(project, { copy: name.toLowerCase(), by: name });
    const notices: Notice[] = [];
    history.onNotice((notice) => notices.push(notice));
    return { history, notices };
  });
}

/** Everyone gets everything anyone has. */
function syncAll(...all: Copy[]) {
  const everything = all.flatMap((each) => each.history.log);
  for (const each of all) each.history.receive(everything);
}

function converged(...all: Copy[]) {
  for (const each of all.slice(1)) expect(each.history.project).toEqual(all[0]!.history.project);
  expect(validateProject(all[0]!.history.project)).toBeNull();
}

function run(copy: Copy, commands: Command | Command[]) {
  const result = copy.history.execute(commands);
  if (!result.ok) throw new Error(result.error);
}

const track = (copy: Copy, id: string) => copy.history.project.tracks.find((each) => each.id === id);

describe("undoing your own Request while someone else edits", () => {
  test("undoes only the Request, even when their edits land while it runs", () => {
    const [alice, bob] = copies("Alice", "Bob");
    const request = alice!.history.beginGroup("Make it brighter");
    request.execute({ type: "renameTrack", trackId: "keys", name: "Piano" });
    run(bob!, { type: "renameTrack", trackId: "bass", name: "Sub" });
    alice!.history.receive(bob!.history.log);
    // What the Request has done so far stays on top of Bob's edit.
    expect(track(alice!, "keys")!.name).toBe("Piano");
    expect(track(alice!, "bass")!.name).toBe("Sub");
    request.execute({ type: "setTempo", tempo: 90 });
    request.end();
    syncAll(alice!, bob!);
    converged(alice!, bob!);

    expect(alice!.history.undo()).toBe(true);
    syncAll(alice!, bob!);
    converged(alice!, bob!);
    expect(track(bob!, "keys")!.name).toBe("Keys");
    expect(bob!.history.project.tempo).toBe(sampleProject().tempo);
    expect(track(bob!, "bass")!.name).toBe("Sub");
    expect(request.undone).toBe(true);
  });

  test("leaves a value someone else changed since, and says who", () => {
    const [alice, bob] = copies("Alice", "Bob");
    run(alice!, [
      { type: "renameTrack", trackId: "keys", name: "Piano" },
      { type: "setTempo", tempo: 90 },
    ]);
    syncAll(alice!, bob!);
    run(bob!, { type: "renameTrack", trackId: "keys", name: "Organ" });
    syncAll(alice!, bob!);

    alice!.history.undo();
    syncAll(alice!, bob!);
    converged(alice!, bob!);
    expect(track(alice!, "keys")!.name).toBe("Organ");
    expect(alice!.history.project.tempo).toBe(sampleProject().tempo);
    expect(alice!.notices).toEqual([{ kind: "left", text: "Undo of “Rename Track and more” left “Organ” as Bob changed it since." }]);
  });

  test("brings back a deleted Bus and its Sends, around what others did", () => {
    const [alice, bob] = copies("Alice", "Bob");
    run(alice!, { type: "deleteBus", busId: "band" });
    syncAll(alice!, bob!);
    run(bob!, { type: "setTempo", tempo: 100 });
    syncAll(alice!, bob!);

    alice!.history.undo();
    syncAll(alice!, bob!);
    converged(alice!, bob!);
    expect(alice!.history.project.buses.map((bus) => bus.id)).toEqual(["band"]);
    expect(track(alice!, "vocals")!.sends).toEqual([{ busId: "band", level: 0.5 }]);
    expect(track(alice!, "bass")!.output).toBe("band");
    expect(alice!.history.project.tempo).toBe(100);
  });

  test("redo brings the step back, after others' edits, and theirs never clear it", () => {
    const [alice, bob] = copies("Alice", "Bob");
    run(alice!, { type: "renameTrack", trackId: "keys", name: "Piano" });
    alice!.history.undo();
    run(bob!, { type: "setTempo", tempo: 100 });
    syncAll(alice!, bob!);
    expect(alice!.history.redoLabel).toBe("Rename Track");

    alice!.history.redo();
    syncAll(alice!, bob!);
    converged(alice!, bob!);
    expect(track(bob!, "keys")!.name).toBe("Piano");
    expect(bob!.history.project.tempo).toBe(100);
  });

  test("never undoes a step of someone else's", () => {
    const [alice, bob] = copies("Alice", "Bob");
    run(bob!, { type: "setTempo", tempo: 100 });
    syncAll(alice!, bob!);
    expect(alice!.history.canUndo).toBe(false);
  });
});

describe("syncing", () => {
  test("offline edits merge into the same Project whichever order they arrive in", () => {
    const [alice, bob, carol] = copies("Alice", "Bob", "Carol");
    run(alice!, { type: "setTempo", tempo: 90 });
    run(alice!, { type: "renameTrack", trackId: "keys", name: "Piano" });
    run(bob!, { type: "setTempo", tempo: 100 });
    run(bob!, { type: "deleteClip", clipId: "keys-1" });
    run(carol!, { type: "setTrackMixer", trackId: "bass", mixer: { volume: 0.3 } });

    const everything = [alice!, bob!, carol!].flatMap((each) => each.history.log);
    alice!.history.receive(everything);
    bob!.history.receive(everything.toReversed());
    for (const change of everything.toReversed()) carol!.history.receive([change, change]);
    converged(alice!, bob!, carol!);
    // Alice's tempo and Bob's are each their first Change: at the same clock
    // the copy that sorts last goes last, and its value stands.
    expect(alice!.history.project.tempo).toBe(100);
    expect(track(alice!, "keys")!.clips).toEqual([]);
  });

  test("a Change arriving late is put in its place, and what follows is applied again", () => {
    const [alice, bob] = copies("Alice", "Bob");
    run(bob!, { type: "setTempo", tempo: 100 });
    for (let tempo = 60; tempo < 60 + 150; tempo += 1) run(alice!, { type: "setTempo", tempo });
    run(alice!, { type: "renameTrack", trackId: "keys", name: "Piano" });
    alice!.history.receive(bob!.history.log);
    bob!.history.receive(alice!.history.log);
    converged(alice!, bob!);
    // Bob's clock 1 goes near the start, so Alice's later tempos win.
    expect(alice!.history.project.tempo).toBe(209);
  });

  test("two edits that are each fine but make a loop together: the later is refused on every copy, and its author told", () => {
    const [alice, bob] = copies("Alice", "Bob");
    run(alice!, { type: "addBus", bus: createBus("Verb", "verb") });
    syncAll(alice!, bob!);
    run(alice!, { type: "addSend", from: { busId: "band" }, busId: "verb", level: 1 });
    run(bob!, { type: "addSend", from: { busId: "verb" }, busId: "band", level: 1 });
    syncAll(alice!, bob!);

    converged(alice!, bob!);
    expect(alice!.history.project.buses.flatMap((bus) => bus.sends)).toEqual([{ busId: "verb", level: 1 }]);
    expect(alice!.notices).toEqual([]);
    expect(bob!.notices).toHaveLength(1);
    expect(bob!.notices[0]!.kind).toBe("refused");
    expect(bob!.notices[0]!.text).toMatch(/^“Add Send” couldn't change/);
  });

  test("a Track two people add at once keeps both, in the same order everywhere", () => {
    const [alice, bob] = copies("Alice", "Bob");
    run(alice!, { type: "addTrack", track: createInstrumentTrack("Lead", "lead") });
    run(bob!, { type: "addTrack", track: createInstrumentTrack("Pad", "pad") });
    syncAll(alice!, bob!);
    converged(alice!, bob!);
    expect(alice!.history.project.tracks.map((each) => each.id).toSorted()).toEqual(["bass", "drums", "keys", "lead", "pad", "vocals"]);
  });

  test("an edit to a Clip moved to another Track at the same time follows it", () => {
    const [alice, bob] = copies("Alice", "Bob");
    run(alice!, { type: "moveClip", clipId: "keys-1", trackId: "bass", start: 0 });
    run(bob!, { type: "setPatternNotes", clipId: "keys-1", notes: [] });
    syncAll(alice!, bob!);
    converged(alice!, bob!);
    expect(track(alice!, "bass")!.clips).toMatchObject([{ id: "keys-1", notes: [] }]);
  });

  test("a copy that applies Changes by other rules stops everyone editing until they update, and says who", () => {
    const [alice, bob] = copies("Alice", "Bob");
    run(bob!, { type: "setTempo", tempo: 100 });
    const newer: Change = { ...bob!.history.log[0]!, id: "bob:2", seq: 2, clock: 2, sync: "9.0" };
    alice!.history.receive([newer, bob!.history.log[0]!]);

    // Everything before it still lands.
    expect(alice!.history.project.tempo).toBe(100);
    expect(alice!.history.stopped).toBe("Bob is using a newer Soundcheck. Update Soundcheck to keep editing this Project together.");
    expect(alice!.notices).toEqual([{ kind: "update", text: alice!.history.stopped }]);
    expect(alice!.history.execute({ type: "setTempo", tempo: 80 })).toEqual({ ok: false, error: alice!.history.stopped });
    expect(alice!.history.canUndo).toBe(false);
    expect(SYNC_VERSION).not.toBe("9.0");
  });

  test("a Shared Project opened again is its Project and every Change, and this copy's own go on from where they were", () => {
    const [alice, bob] = copies("Alice", "Bob");
    run(alice!, { type: "setTempo", tempo: 90 });
    run(bob!, { type: "renameTrack", trackId: "keys", name: "Piano" });
    const changes = [...bob!.history.log, ...alice!.history.log];

    const reopened = new ProjectHistory(sampleProject(), { copy: "alice", changes });
    expect(reopened.project.tempo).toBe(90);
    expect(reopened.project.tracks[0]!.name).toBe("Piano");
    expect(reopened.canUndo).toBe(false);
    reopened.execute({ type: "setTempo", tempo: 95 });
    expect(reopened.log.at(-1)).toMatchObject({ id: "alice:2", clock: 2 });
  });

  test("sharing a Project makes it the base, and undo still reaches back past it", () => {
    const solo = new ProjectHistory(sampleProject(), { copy: "alice", by: "Alice" });
    solo.execute({ type: "setTempo", tempo: 90 });
    solo.rebase();
    expect(solo.log).toEqual([]);
    // Bob opens the base the folder was written with.
    const bob = new ProjectHistory(solo.project, { copy: "bob", by: "Bob" });
    bob.execute({ type: "renameTrack", trackId: "keys", name: "Piano" });
    solo.receive(bob.log);

    expect(solo.undo()).toBe(true);
    expect(solo.project.tempo).toBe(120);
    expect(solo.project.tracks[0]!.name).toBe("Piano");
    bob.receive(solo.log);
    expect(bob.project).toEqual(solo.project);
    expect(solo.log.map((change) => change.id)).toEqual(["bob:1", "alice:2"]);
  });

  test("a whole Project taken as it is lands as a Change that isn't on the undo stack", () => {
    const [alice, bob] = copies("Alice", "Bob");
    run(alice!, { type: "setTempo", tempo: 90 });
    const withState = { ...alice!.history.project, name: "Plugin state" };
    expect(alice!.history.record(withState, "Save")).toBe(true);
    expect(alice!.history.project).toBe(withState);
    expect(alice!.history.undoLabel).toBe("Set tempo");
    expect(alice!.history.record(withState, "Save")).toBe(false);
    bob!.history.receive(alice!.history.log);
    converged(alice!, bob!);
  });
});

describe("random sessions", () => {
  for (const seed of [1, 2, 3, 4]) {
    test(`three people, seed ${seed}: every copy stays valid, and all end the same`, () => {
      const random = mulberry32(seed);
      const all = copies("Alice", "Bob", "Carol");
      for (let turn = 0; turn < 150; turn++) {
        const who = all[Math.floor(random() * all.length)]!;
        const roll = random();
        if (roll < 0.55) {
          who.history.execute(randomEdit(random, who, turn));
        } else if (roll < 0.68) {
          who.history.undo();
        } else if (roll < 0.75) {
          who.history.redo();
        } else {
          // Some of someone's Changes reach someone else, in any order, some twice.
          const from = all[Math.floor(random() * all.length)]!;
          const some = from.history.log.filter(() => random() < 0.5);
          who.history.receive(shuffle(random, [...some, ...some.slice(0, 2)]));
        }
        expect(validateProject(who.history.project)).toBeNull();
      }
      syncAll(...all);
      converged(...all);
    });
  }
});

function randomEdit(random: () => number, copy: Copy, turn: number): Command | Command[] {
  const project = copy.history.project;
  const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(random() * list.length)];
  const id = `n${turn}-${Math.floor(random() * 1e9)}`;
  const aTrack = pick(project.tracks);
  const aBus = pick(project.buses);
  const aClip = pick(project.tracks.flatMap((each) => each.clips.filter((clip) => clip.kind === "pattern")));
  const choices: (Command | null)[] = [
    { type: "addTrack", track: createInstrumentTrack(`Track ${id}`, `t-${id}`), index: Math.floor(random() * (project.tracks.length + 1)) },
    aTrack ? { type: "deleteTrack", trackId: aTrack.id } : null,
    aTrack ? { type: "setTrackMixer", trackId: aTrack.id, mixer: { volume: Math.round(random() * 200) / 100 } } : null,
    aTrack ? { type: "renameTrack", trackId: aTrack.id, name: `Track ${id}` } : null,
    aTrack ? { type: "moveTrack", trackId: aTrack.id, index: Math.floor(random() * project.tracks.length) } : null,
    { type: "addBus", bus: createBus(`Bus ${id}`, `b-${id}`) },
    aBus ? { type: "deleteBus", busId: aBus.id } : null,
    aTrack && aBus ? { type: "addSend", from: { trackId: aTrack.id }, busId: aBus.id, level: 1 } : null,
    aBus && pick(project.buses) ? { type: "addSend", from: { busId: aBus.id }, busId: pick(project.buses)!.id, level: 1 } : null,
    aTrack && aTrack.sends[0] ? { type: "removeSend", from: { trackId: aTrack.id }, busId: aTrack.sends[0].busId } : null,
    aTrack?.kind === "instrument"
      ? { type: "addClip", trackId: aTrack.id, clip: { id: `c-${id}`, kind: "pattern", start: Math.floor(random() * 16) * 960, length: 960, notes: [] } }
      : null,
    aClip && aTrack?.kind === "instrument" ? { type: "moveClip", clipId: aClip.id, trackId: aTrack.id, start: 0 } : null,
    aClip
      ? { type: "setPatternNotes", clipId: aClip.id, notes: [...aClip.notes, { pitch: 36 + Math.floor(random() * 24), start: 0, length: 240, velocity: 1 }] }
      : null,
    { type: "setTempo", tempo: 60 + Math.floor(random() * 120) },
    { type: "addSection", section: { id: `s-${id}`, name: "Part", startBar: 1 + Math.floor(random() * 32), bars: 1 } },
    aTrack ? { type: "addEffect", target: { trackId: aTrack.id }, effect: createEffect("reverb", `fx-${id}`) } : null,
    { type: "setReferenceTrack", referenceTrack: project.referenceTrack ? null : { file: `audio/${id}.wav` } },
  ];
  return pick(choices) ?? { type: "setTempo", tempo: 120 };
}

function shuffle<T>(random: () => number, list: T[]): T[] {
  for (let index = list.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [list[index], list[other]] = [list[other]!, list[index]!];
  }
  return list;
}

/** A small seeded random number generator, so a failing seed fails again. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

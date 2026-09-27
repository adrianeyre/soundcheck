import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Write } from "./change.ts";
import { canonical, type Flat, flatten, isPresence, type Json, ownerOf, presenceKey, unflatten } from "./flat.ts";
import {
  asJson,
  asProject,
  bus,
  deleteBus,
  edit,
  findBus,
  findTrack,
  type Project,
  reverb,
  startingProject,
  track,
  validate,
} from "./project.ts";
import { Replica } from "./replica.ts";

/** One replica each, all starting from the same Project. */
function replicas<const Peers extends readonly string[]>(...peers: Peers): { [Index in keyof Peers]: Replica } {
  const made = peers.map((peer) => new Replica(peer, asJson(startingProject()), validate));
  return made as { [Index in keyof Peers]: Replica };
}

/** Everyone gets everything anyone has: live, or a synced folder catching up. */
function syncAll(...all: Replica[]) {
  const everything = all.flatMap((replica) => replica.changes);
  for (const replica of all) replica.receive(everything);
}

const project = (replica: Replica) => asProject(replica.doc);
const same = (a: Replica, b: Replica) => canonical(a.doc) === canonical(b.doc);

function converged(...all: Replica[]) {
  for (const replica of all.slice(1)) assert.equal(canonical(replica.doc), canonical(all[0]!.doc));
}

describe("the flat form", () => {
  test("gives the same Project back", () => {
    const start = startingProject();
    start.master.insertChain = [reverb("fx-master")];
    start.referenceTrack = { file: "audio/ref.wav" };
    assert.equal(canonical(unflatten(flatten(asJson(start)))), canonical(asJson(start)));
  });

  test("keys an item by its id, not its place in the list", () => {
    const keys = [...flatten(asJson(startingProject())).keys()];
    assert.ok(keys.includes(JSON.stringify(["t-bass", "mixer", "volume"])));
    assert.ok(keys.includes(JSON.stringify(["t-drums/sends/b-verb", "level"])));
  });
});

describe("undoing your own Request while someone else edits", () => {
  test("undoes only the Request, and leaves the other person's edits", () => {
    const [alice, bob] = replicas("alice", "bob");
    const request = alice.beginRequest();
    request.edit(edit((p) => findTrack(p, "t-drums")!.insertChain.push(reverb("fx-1"))));
    // Bob's edit arrives while the Request runs.
    bob.edit(edit((p) => (findTrack(p, "t-drums")!.name = "Kit")));
    syncAll(alice, bob);
    request.edit(edit((p) => (findTrack(p, "t-drums")!.mixer.volume = 0.5)));
    request.end();
    bob.edit(edit((p) => (findTrack(p, "t-bass")!.mixer.volume = 0.8)));
    syncAll(alice, bob);

    const undone = alice.undo();
    syncAll(alice, bob);

    assert.deepEqual(undone!.outcome.left, []);
    const drums = findTrack(project(bob), "t-drums")!;
    assert.deepEqual(drums.insertChain, []);
    assert.equal(drums.mixer.volume, 1);
    assert.equal(drums.name, "Kit");
    assert.equal(findTrack(project(bob), "t-bass")!.mixer.volume, 0.8);
    converged(alice, bob);
  });

  test("with nobody else editing, is one step back to exactly where it was", () => {
    const [alice] = replicas("alice");
    const before = canonical(alice.doc);
    const request = alice.beginRequest();
    request.edit(edit((p) => p.buses.push(bus("b-new"))));
    request.edit(edit((p) => findTrack(p, "t-bass")!.sends.push({ busId: "b-new", level: 1 })));
    request.edit(edit((p) => p.tracks.splice(0, 1)));
    request.end();
    alice.undo();
    assert.equal(canonical(alice.doc), before);
  });

  test("leaves a value someone else changed since, and says so", () => {
    const [alice, bob] = replicas("alice", "bob");
    alice.edit(edit((p) => (p.tempo = 90)));
    syncAll(alice, bob);
    bob.edit(edit((p) => (p.tempo = 140)));
    syncAll(alice, bob);

    const undone = alice.undo();
    syncAll(alice, bob);

    assert.equal(project(alice).tempo, 140);
    assert.deepEqual(undone!.outcome.applied, []);
    assert.deepEqual(undone!.outcome.left.map((write) => write.key), [JSON.stringify(["root", "tempo"])]);
    converged(alice, bob);
  });

  test("brings back a deleted Bus and its Sends, around what others did", () => {
    const [alice, bob] = replicas("alice", "bob");
    alice.edit(edit((p) => deleteBus(p, "b-verb")));
    syncAll(alice, bob);
    bob.edit(edit((p) => findTrack(p, "t-bass")!.insertChain.push(reverb("fx-bob"))));
    syncAll(alice, bob);

    alice.undo();
    syncAll(alice, bob);

    assert.deepEqual(project(bob).buses.map((each) => each.id), ["b-verb", "b-delay"]);
    assert.deepEqual(findTrack(project(bob), "t-drums")!.sends, [{ busId: "b-verb", level: 0.5 }]);
    assert.equal(findTrack(project(bob), "t-bass")!.insertChain[0]!.id, "fx-bob");
    converged(alice, bob);
  });

  test("puts back what it still validly can when someone deleted what the rest needs", () => {
    const [alice, bob] = replicas("alice", "bob");
    const request = alice.beginRequest();
    request.edit(edit((p) => (findTrack(p, "t-drums")!.sends = [])));
    request.edit(edit((p) => (p.tempo = 100)));
    request.end();
    syncAll(alice, bob);
    bob.edit(edit((p) => deleteBus(p, "b-verb")));
    syncAll(alice, bob);

    const undone = alice.undo();
    syncAll(alice, bob);

    // The tempo comes back; the Send can't, because its Bus has gone.
    assert.equal(project(alice).tempo, 120);
    assert.deepEqual(findTrack(project(alice), "t-drums")!.sends, []);
    assert.ok(undone!.outcome.refused.length > 0);
    assert.equal(validate(alice.doc), null);
    converged(alice, bob);
  });

  test("redo brings the Request back and still leaves what others did in between", () => {
    const [alice, bob] = replicas("alice", "bob");
    alice.edit(edit((p) => p.tracks.push(track("t-keys", "Keys"))));
    syncAll(alice, bob);
    alice.undo();
    syncAll(alice, bob);
    bob.edit(edit((p) => (findTrack(p, "t-bass")!.name = "Sub")));
    syncAll(alice, bob);

    assert.ok(alice.canRedo, "someone else's edit doesn't clear your redo");
    alice.redo();
    syncAll(alice, bob);

    assert.deepEqual(project(bob).tracks.map((each) => each.name), ["Drums", "Sub", "Keys"]);
    converged(alice, bob);
  });

  test("never undoes a step of someone else's", () => {
    const [alice, bob] = replicas("alice", "bob");
    bob.edit(edit((p) => (p.name = "Bob's song")));
    syncAll(alice, bob);
    assert.equal(alice.canUndo, false);
    assert.equal(alice.undo(), null);
    assert.equal(project(alice).name, "Bob's song");
  });
});

describe("syncing", () => {
  test("offline edits merge into the same Project whichever order they arrive in", () => {
    const [alice, bob, carol] = replicas("alice", "bob", "carol");
    alice.edit(edit((p) => (findTrack(p, "t-drums")!.mixer.volume = 0.7)));
    alice.edit(edit((p) => p.tracks.push(track("t-gtr", "Guitar"))));
    bob.edit(edit((p) => p.tracks.push(track("t-vox", "Vocals"))));
    bob.edit(edit((p) => (findTrack(p, "t-drums")!.name = "Beat")));
    carol.edit(edit((p) => p.sections.push({ id: "s-verse", name: "Verse", startBar: 5, bars: 8 })));

    // Each one's Changes, as the files a synced folder would carry, read in different orders.
    const files = [alice, bob, carol].map((replica) => [...replica.changes]);
    alice.receive([...files[2]!, ...files[1]!]);
    bob.receive(files[0]!.toReversed());
    bob.receive(files[2]!);
    carol.receive([...files[1]!, ...files[0]!]);

    converged(alice, bob, carol);
    const merged = project(alice);
    assert.deepEqual(merged.tracks.map((each) => each.name).toSorted(), ["Bass", "Beat", "Guitar", "Vocals"]);
    assert.equal(findTrack(merged, "t-drums")!.mixer.volume, 0.7);
    assert.equal(merged.sections.length, 2);
  });

  test("a Change arriving late is put in its place, and a Request undone offline still undoes only its own", () => {
    const [alice, bob] = replicas("alice", "bob");
    bob.edit(edit((p) => (findTrack(p, "t-bass")!.mixer.pan = -0.5)));
    // Alice, not yet having Bob's Change, makes a Request and undoes it.
    alice.edit(edit((p) => (findTrack(p, "t-bass")!.mixer.pan = 0.5)));
    alice.undo();
    syncAll(alice, bob);

    converged(alice, bob);
    // Whichever of the two pans comes later in the order, Alice's undo leaves Bob's.
    assert.equal(findTrack(project(alice), "t-bass")!.mixer.pan, -0.5);
  });

  test("two edits that are each fine but break a rule together: the later one is refused on every copy", () => {
    const [alice, bob] = replicas("alice", "bob");
    alice.edit(edit((p) => findBus(p, "b-verb")!.sends.push({ busId: "b-delay", level: 1 })));
    bob.edit(edit((p) => findBus(p, "b-delay")!.sends.push({ busId: "b-verb", level: 1 })));
    syncAll(alice, bob);

    converged(alice, bob);
    assert.equal(validate(alice.doc), null);
    const sends = project(alice).buses.flatMap((each) => each.sends);
    assert.equal(sends.length, 1, "exactly one of the two Sends stands");
  });

  test("a Track two people add at once keeps both, in the same order everywhere", () => {
    const [alice, bob] = replicas("alice", "bob");
    alice.edit(edit((p) => p.tracks.push(track("t-a"))));
    bob.edit(edit((p) => p.tracks.push(track("t-b"))));
    syncAll(alice, bob);
    converged(alice, bob);
    assert.deepEqual(project(alice).tracks.map((each) => each.id).toSorted(), ["t-a", "t-b", "t-bass", "t-drums"]);
  });

  test("an edit to a Clip moved to another Track at the same time follows it", () => {
    const [alice, bob] = replicas("alice", "bob");
    alice.edit(
      edit((p) => {
        const drums = findTrack(p, "t-drums")!;
        const clip = drums.clips.pop()!;
        findTrack(p, "t-bass")!.clips.push(clip);
      }),
    );
    bob.edit(edit((p) => (findTrack(p, "t-drums")!.clips[0]!.notes = [])));
    syncAll(alice, bob);
    converged(alice, bob);
    assert.deepEqual(findTrack(project(alice), "t-bass")!.clips[0]!.notes, []);
  });
});

describe("random sessions", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`three people, seed ${seed}: every copy ends the same and valid`, () => {
      const random = mulberry32(seed);
      const peers = replicas("alice", "bob", "carol");
      let made = 0;
      for (let turn = 0; turn < 250; turn++) {
        const who = peers[Math.floor(random() * peers.length)]!;
        const roll = random();
        if (roll < 0.55) {
          made += who.edit(randomEdit(random, made)) ? 1 : 0;
        } else if (roll < 0.68) {
          const before = flatten(who.doc);
          const undone = who.undo();
          if (undone) assertOnlyOwnItems(before, flatten(who.doc), undone.change.writes);
        } else if (roll < 0.75) {
          who.redo();
        } else {
          // Some of someone's Changes reach someone else, in any order, some twice.
          const from = peers[Math.floor(random() * peers.length)]!;
          const some = from.changes.filter(() => random() < 0.5);
          who.receive(shuffle(random, [...some, ...some.slice(0, 2)]));
        }
        assert.equal(validate(who.doc), null);
      }
      syncAll(...peers);
      converged(...peers);
      assert.equal(validate(peers[0]!.doc), null);
      assert.ok(same(peers[1]!, peers[2]!));
    });
  }
});

/**
 * An undo changes nothing outside the items it writes to and the lists they
 * are in: bringing an item back brings back its fields, its place, and what
 * is in it, such as a Clip someone added to a Track as it was deleted.
 */
function assertOnlyOwnItems(before: Flat, after: Flat, writes: readonly Write[]) {
  const items = new Set(writes.map((write) => ownerOf(write.key)));
  for (const write of writes.filter((each) => isPresence(each.key))) {
    for (const presence of [write.from, write.to]) if (presence) items.add((presence as { parent: string }).parent);
  }
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (canonical(before.get(key)) === canonical(after.get(key))) continue;
    let owner: string | undefined = ownerOf(key);
    while (owner && !items.has(owner)) {
      const presence: Json | undefined = after.get(presenceKey(owner)) ?? before.get(presenceKey(owner));
      owner = (presence as { parent: string } | undefined)?.parent;
    }
    assert.ok(owner, key);
  }
}

function randomEdit(random: () => number, made: number) {
  const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(random() * list.length)];
  const id = `n${made}-${Math.floor(random() * 1e9)}`;
  const choices: ((p: Project) => void)[] = [
    (p) => p.tracks.splice(Math.floor(random() * (p.tracks.length + 1)), 0, track(`t-${id}`)),
    (p) => p.tracks.splice(Math.floor(random() * p.tracks.length), 1),
    (p) => {
      const one = pick(p.tracks);
      if (one) one.mixer.volume = Math.round(random() * 200) / 100;
    },
    (p) => {
      const one = pick(p.tracks);
      if (one) one.name = `Track ${id}`;
    },
    (p) => p.buses.push(bus(`b-${id}`)),
    (p) => {
      const one = pick(p.buses);
      if (one) deleteBus(p, one.id);
    },
    (p) => {
      const from = pick([...p.tracks, ...p.buses]);
      const to = pick(p.buses);
      if (from && to && !from.sends.some((send) => send.busId === to.id)) from.sends.push({ busId: to.id, level: 1 });
    },
    (p) => {
      const one = pick([...p.tracks, ...p.buses]);
      if (one) one.sends.pop();
    },
    (p) => {
      const one = pick(p.tracks);
      if (one) one.clips.push({ id: `c-${id}`, start: Math.floor(random() * 16) * 960, length: 960, notes: [] });
    },
    (p) => {
      const from = pick(p.tracks);
      const to = pick(p.tracks);
      const clip = from?.clips.pop();
      if (clip) to!.clips.push(clip);
    },
    (p) => {
      const clip = pick(p.tracks.flatMap((each) => each.clips));
      const pitch = 36 + Math.floor(random() * 24);
      if (clip) clip.notes = [...clip.notes, { pitch, start: 0, length: 240, velocity: 1 }];
    },
    (p) => (p.tracks = p.tracks.toReversed()),
    (p) => (p.tempo = 60 + Math.floor(random() * 120)),
    (p) => p.sections.push({ id: `s-${id}`, name: "Part", startBar: 1 + Math.floor(random() * 32), bars: 4 }),
    (p) => {
      const one = pick([...p.tracks, ...p.buses]);
      if (one) one.insertChain.splice(Math.floor(random() * (one.insertChain.length + 1)), 0, reverb(`fx-${id}`));
    },
    (p) => (p.referenceTrack = p.referenceTrack ? null : { file: `audio/${id}.wav` }),
  ];
  return edit(pick(choices)!);
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

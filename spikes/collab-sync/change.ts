/**
 * Changes: what one step did to the flat Project, and how one is applied.
 *
 * A write names a key, the value it had (`from`) and the value it gets
 * (`to`); a missing `from` or `to` means the key wasn't there or goes. An
 * edit's writes land whatever is there now: the last one in the order wins.
 * An undo's or a redo's land only where the key still holds `from`, so
 * undoing never overwrites what someone else has changed since.
 *
 * Whatever lands must leave a valid Project. If the whole Change doesn't, it
 * is applied item by item, each item kept only if the Project stays valid,
 * until no more can be; the rest is refused. Every replica does the same, so
 * they all refuse the same writes.
 */
import { type Flat, isPresence, type Json, type JsonObject, ownerOf, same, unflatten } from "./flat.ts";

export interface Write {
  key: string;
  from?: Json;
  to?: Json;
}

export type ChangeKind = "edit" | "undo" | "redo";

export interface Change {
  /** `peer:seq`: unique, and the same on every replica. */
  id: string;
  peer: string;
  seq: number;
  /** A Lamport clock: higher than every clock its author had seen. */
  clock: number;
  kind: ChangeKind;
  writes: Write[];
}

/** The order every replica puts Changes in: by clock, then by peer. */
export function compareChanges(a: Change, b: Change): number {
  return a.clock - b.clock || (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0);
}

export type Validate = (doc: JsonObject) => string | null;

/** What applying a Change did: the writes that landed, with what they replaced, and those that didn't. */
export interface Outcome {
  applied: Write[];
  /** An undo's or redo's writes to keys someone else had changed since. */
  left: Write[];
  /** Writes that would have left the Project invalid. */
  refused: Write[];
}

/** Every key whose value differs, in key order. */
export function diff(before: Flat, after: Flat): Write[] {
  const keys = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  const writes: Write[] = [];
  for (const key of keys) {
    const from = before.get(key);
    const to = after.get(key);
    if (!same(from, to)) writes.push(write(key, from, to));
  }
  return writes;
}

/** One write per key: the first `from` and the last `to`, and none that ends where it began. */
export function compose(first: readonly Write[], then: readonly Write[]): Write[] {
  const byKey = new Map<string, Write>();
  for (const next of [...first, ...then]) {
    const earlier = byKey.get(next.key);
    byKey.set(next.key, earlier ? write(next.key, earlier.from, next.to) : next);
  }
  return [...byKey.values()].filter((each) => !same(each.from, each.to));
}

/** The writes that put back what `writes` changed, each only where it is still what they left. */
export function inverse(writes: readonly Write[]): Write[] {
  return writes.map((each) => write(each.key, each.to, each.from));
}

export function applyChange(flat: Flat, change: Change, validate: Validate): { flat: Flat; outcome: Outcome } {
  const left = change.kind === "edit" ? [] : stale(flat, change.writes);
  const candidates = change.writes.filter((each) => !left.includes(each));

  const attempt = (writes: readonly Write[]) => {
    const next = new Map(flat);
    for (const each of writes) set(next, each.key, each.to);
    return validate(unflatten(next)) === null ? next : null;
  };

  const whole = attempt(candidates);
  if (whole) return { flat: whole, outcome: { applied: landed(flat, candidates), left, refused: [] } };

  // Item by item, as many passes as it takes: an item can need one that
  // comes after it, as a Send needs the Bus it feeds.
  const groups = new Map<string, Write[]>();
  for (const each of candidates) groups.set(ownerOf(each.key), [...(groups.get(ownerOf(each.key)) ?? []), each]);
  let accepted: Write[] = [];
  let pending = [...groups.values()];
  for (let progress = true; progress; ) {
    progress = false;
    for (const group of pending) {
      if (attempt([...accepted, ...group])) {
        accepted = [...accepted, ...group];
        pending = pending.filter((other) => other !== group);
        progress = true;
      }
    }
  }
  return {
    flat: attempt(accepted) ?? flat,
    outcome: { applied: landed(flat, accepted), left, refused: pending.flat() },
  };
}

/**
 * An undo's or redo's writes that someone else has overtaken: each whose key
 * no longer holds `from`, and every write to an item it would add or take
 * away if any of that item's is overtaken, so an item someone else has moved
 * or changed since is never half taken away, and never taken away at all.
 */
function stale(flat: Flat, writes: readonly Write[]): Write[] {
  const overtaken = new Set(writes.filter((each) => !same(flat.get(each.key), each.from)));
  const touched = new Set([...overtaken].map((each) => ownerOf(each.key)));
  const whole = new Set(
    writes.filter((each) => isPresence(each.key) && touched.has(ownerOf(each.key))).map((each) => ownerOf(each.key)),
  );
  return writes.filter((each) => overtaken.has(each) || whole.has(ownerOf(each.key)));
}

/** The writes as they landed on `flat`: `from` is what was really there. */
function landed(flat: Flat, writes: readonly Write[]): Write[] {
  return writes
    .map((each) => write(each.key, flat.get(each.key), each.to))
    .filter((each) => !same(each.from, each.to));
}

function set(flat: Flat, key: string, value: Json | undefined) {
  if (value === undefined) flat.delete(key);
  else flat.set(key, value);
}

function write(key: string, from: Json | undefined, to: Json | undefined): Write {
  const made: Write = { key };
  if (from !== undefined) made.from = from;
  if (to !== undefined) made.to = to;
  return made;
}

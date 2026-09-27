/**
 * Changes (ADR 0007): what one step did to the flat Project, and how one is
 * applied.
 *
 * A Change is a list of writes, each naming a key, the value it had (`from`)
 * and the value it gets (`to`). An edit's writes land whatever is there now,
 * so where two people set the same value the later in the order wins. An
 * undo's or a redo's land only where the key still holds `from`, so undoing
 * never overwrites what a Collaborator has changed since.
 *
 * Whatever lands must leave a valid Project. If the whole Change doesn't, it
 * is applied item by item, each item kept only if the Project stays valid,
 * until no more can be, and the rest is refused. Every copy does the same, so
 * they all refuse the same writes.
 */
import { describeKey, type Flat, isPresence, isUnder, type Json, ownerOf, same, unflatten, write, type Write } from "./flat";
import { SCHEMA_VERSION, type Project } from "./model";
import { validateProject } from "./validate";

export type { Write } from "./flat";

/**
 * The version of the rules for applying a Change, with the Project's schema:
 * bumped whenever applying or validating changes what a Change does. Copies
 * only apply each other's Changes when theirs is the same.
 */
export const SYNC_VERSION = `1.${SCHEMA_VERSION}`;

export type ChangeKind = "edit" | "undo" | "redo";

export interface Change {
  /** `copy:seq`: unique, and the same on every copy. */
  id: string;
  /** Which copy of the Project made it. */
  copy: string;
  /** Its place among its copy's own Changes, from 1. */
  seq: number;
  /** A Lamport clock: higher than every clock its copy had seen. */
  clock: number;
  kind: ChangeKind;
  /** `SYNC_VERSION` where it was made. */
  sync: string;
  /** Whose it is, as their Collaborators are told. */
  by?: string;
  writes: Write[];
}

/** The order every copy puts Changes in: by clock, then by copy. */
export function compareChanges(a: Change, b: Change): number {
  return a.clock - b.clock || (a.copy < b.copy ? -1 : a.copy > b.copy ? 1 : a.seq - b.seq);
}

/** What applying a Change did. */
export interface Outcome {
  /** The writes that landed, with what they replaced. */
  applied: Write[];
  /** An undo's or redo's writes to keys a Collaborator had changed since. */
  left: Write[];
  /** Writes that would have left the Project invalid, and why the first of them would. */
  refused: Write[];
  reason: string | null;
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

/** The writes that put back what `writes` changed, each only where it still holds what they left. */
export function inverse(writes: readonly Write[]): Write[] {
  return writes.map((each) => write(each.key, each.to, each.from));
}

/**
 * Apply `change` to `flat`, leaving `flat` as it was. Where it all lands and
 * `trusted` says the result is already known to be valid (a command checked
 * it), the Project isn't built to be checked again.
 */
export function applyChange(
  flat: Flat,
  change: Pick<Change, "kind" | "writes">,
  { validate = validateProject, trusted = false }: { validate?: (project: Project) => string | null; trusted?: boolean } = {},
): { flat: Flat; project: Project | null; outcome: Outcome } {
  const left = change.kind === "edit" ? [] : stale(flat, change.writes);
  const candidates = change.writes.filter((each) => !left.includes(each));

  let reason: string | null = null;
  const attempt = (writes: readonly Write[]) => {
    const next = new Map(flat);
    if (change.kind === "edit") for (const each of writes) clearUnder(next, each);
    for (const each of writes) set(next, each);
    if (trusted) return { flat: next, project: null };
    const project = unflatten(next);
    const problem = validate(project);
    reason ??= problem;
    return problem === null ? { flat: next, project } : null;
  };

  const whole = attempt(candidates);
  if (whole) return { ...whole, outcome: { applied: landed(flat, candidates), left, refused: [], reason: null } };

  // Item by item, as many passes as it takes: an item can need one that
  // comes after it, as a Send needs the Bus it feeds.
  let accepted: Write[] = [];
  let pending = byItem(candidates);
  reason = null;
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
  const kept = attempt(accepted) ?? { flat, project: unflatten(flat) };
  return { ...kept, outcome: { applied: landed(flat, accepted), left, refused: pending.flat(), reason } };
}

/**
 * The writes grouped by the item they are about. A list's order goes with
 * the items it puts in or takes out, so no list names an item that didn't
 * land, nor loses one that stayed.
 */
function byItem(writes: readonly Write[]): Write[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const up = parent.get(id) ?? id;
    if (up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  for (const each of writes) {
    const { kind } = describeKey(each.key);
    if (kind !== "order") continue;
    const from = ids(each.from);
    const to = ids(each.to);
    const moved = [...from.filter((id) => !to.includes(id)), ...to.filter((id) => !from.includes(id))];
    for (const id of moved) parent.set(find(id), find(orderGroup(each.key)));
  }
  const groups = new Map<string, Write[]>();
  for (const each of writes) {
    const root = find(describeKey(each.key).kind === "order" ? orderGroup(each.key) : ownerOf(each.key));
    groups.set(root, [...(groups.get(root) ?? []), each]);
  }
  return [...groups.values()];
}

/** A list's order is grouped apart from its owner's fields, which can land without it. */
const orderGroup = (key: string) => `#${key}`;

const ids = (value: Json | undefined): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

/**
 * An undo's or redo's writes that a Collaborator has overtaken: each whose
 * key no longer holds `from`, and every write to an item it would take away
 * if any of that item's is overtaken, so an item someone has moved or changed
 * since is never half taken away, nor taken away at all. An item it brings
 * back comes back with what they changed.
 */
function stale(flat: Flat, writes: readonly Write[]): Write[] {
  const overtaken = new Set(writes.filter((each) => !same(flat.get(each.key), each.from)));
  const touched = new Set([...overtaken].map((each) => ownerOf(each.key)));
  const kept = new Set(
    writes
      .filter((each) => isPresence(each.key) && each.to === undefined && touched.has(ownerOf(each.key)))
      .map((each) => ownerOf(each.key)),
  );
  return writes.filter((each) => overtaken.has(each) || kept.has(ownerOf(each.key)));
}

/** The writes as they landed on `flat`: `from` is what was really there. */
function landed(flat: Flat, writes: readonly Write[]): Write[] {
  return writes.map((each) => write(each.key, flat.get(each.key), each.to)).filter((each) => !same(each.from, each.to));
}

/**
 * An edit that makes a nested object where there was none clears whatever a
 * Collaborator left under it while it was gone, so the object is exactly the
 * one the edit made. Before any of the edit's writes land: a field's key
 * sorts before its object's.
 */
function clearUnder(flat: Flat, each: Write) {
  if (isPresence(each.key) || !isMarker(each.to) || isMarker(flat.get(each.key))) return;
  for (const key of flat.keys()) if (isUnder(key, each.key)) flat.delete(key);
}

function set(flat: Flat, each: Write) {
  if (each.to === undefined) flat.delete(each.key);
  else flat.set(each.key, each.to);
}

function isMarker(value: Json | undefined): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

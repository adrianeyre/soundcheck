/**
 * A Project as a flat map of keys to values, so that two people's changes
 * can be told apart and merged one value at a time (ADR 0007).
 *
 * Anything with an identity is an item: a Track, Bus, Clip, Effect (in any
 * Insert Chain, the Master's too), Section or Tempo Change by its id, a Send
 * by the Bus it feeds and an Automation by its setting. An item is a presence
 * entry saying which list of which owner it is in, and one entry per field,
 * keyed by its id and never by its place in a list, so a Clip moved to
 * another Track is still the same Clip. Each list's order is one more entry.
 * Nested objects (a mixer, an Instrument, a time signature) are flattened
 * field by field, each marked by an entry of its own, so an empty one
 * survives and one that goes takes its fields with it. Any other array (a
 * Pattern Clip's notes, an Automation's breakpoints, a Drum Sampler's Pads)
 * is one value.
 *
 * `unflatten` builds the Project back, deterministically, from whatever is in
 * the map: an item whose owner has gone is left out, and an item missing from
 * its list's order goes at the end, in id order.
 */
import type { Project } from "./model";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Arrays under these field names are lists of items; the value is the field that identifies one. */
const COLLECTIONS: Readonly<Record<string, string>> = {
  tracks: "id",
  buses: "id",
  clips: "id",
  insertChain: "id",
  sections: "id",
  tempoChanges: "id",
  sends: "busId",
  automation: "setting",
};

/**
 * Lists the rules keep in order of a field, whatever order they were added
 * in: two Sections added at once go where their bars say, not one after the
 * other.
 */
const SORTED: Readonly<Record<string, string>> = { sections: "startBar", tempoChanges: "tick" };

/** The owner of everything that isn't inside an item. No item's id is empty. */
export const ROOT = "";

/** Every entry of a Project, by key. */
export type Flat = Map<string, Json>;

interface Presence {
  parent: string;
  slot: string[];
}

export const presenceKey = (id: string): string => JSON.stringify(["@", id]);
const orderKey = (owner: string, slot: readonly string[]) => JSON.stringify(["#", owner, ...slot]);
const fieldKey = (owner: string, path: readonly string[]) => JSON.stringify([owner, ...path]);

/** Which item a key belongs to, for applying a Change item by item: a list's order is its owner's. */
export function ownerOf(key: string): string {
  const parts = JSON.parse(key) as string[];
  return parts[0] === "@" || parts[0] === "#" ? parts[1]! : parts[0]!;
}

export function isPresence(key: string): boolean {
  return key.startsWith('["@",');
}

/**
 * What a key names, for saying what a Change did: an item's presence, a
 * list's order, or a field of an item or of the Project, by its path.
 */
export function describeKey(key: string): { owner: string; kind: "presence" | "order" | "field"; path: string[] } {
  const parts = JSON.parse(key) as string[];
  if (parts[0] === "@") return { owner: parts[1]!, kind: "presence", path: [] };
  if (parts[0] === "#") return { owner: parts[1]!, kind: "order", path: parts.slice(2) };
  return { owner: parts[0]!, kind: "field", path: parts.slice(1) };
}

/** The keys under a field's own key, which a nested object's fields have. */
export function isUnder(key: string, parent: string): boolean {
  return key.length > parent.length && key.startsWith(`${parent.slice(0, -1)},`);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The id an item has in the flat form: its own, or its owner's and its list's with what identifies it. */
function itemId(owner: string, slot: readonly string[], identity: string, item: JsonObject): string {
  return identity === "id" ? String(item.id) : `${owner}/${slot.join("/")}/${String(item[identity])}`;
}

export function flatten(project: Project): Flat {
  const flat: Flat = new Map();
  flattenObject(flat, ROOT, [], project as unknown as JsonObject);
  return flat;
}

function flattenObject(flat: Flat, owner: string, path: readonly string[], object: JsonObject) {
  for (const [field, value] of Object.entries(object)) flattenField(flat, owner, [...path, field], value);
}

function flattenField(flat: Flat, owner: string, slot: readonly string[], value: Json | undefined) {
  if (value === undefined) return;
  const identity = COLLECTIONS[slot.at(-1)!];
  if (identity !== undefined && Array.isArray(value)) {
    const ids: string[] = [];
    for (const item of value as JsonObject[]) {
      const id = itemId(owner, slot, identity, item);
      ids.push(id);
      flat.set(presenceKey(id), { parent: owner, slot: [...slot] });
      flattenObject(flat, id, [], item);
    }
    flat.set(orderKey(owner, slot), ids);
  } else if (isObject(value)) {
    flat.set(fieldKey(owner, slot), {});
    flattenObject(flat, owner, slot, value);
  } else {
    flat.set(fieldKey(owner, slot), value);
  }
}

/** One key's value before and after, where it differs. A missing side means the key wasn't there, or goes. */
export interface Write {
  key: string;
  from?: Json;
  to?: Json;
}

export function write(key: string, from: Json | undefined, to: Json | undefined): Write {
  const made: Write = { key };
  if (from !== undefined) made.from = from;
  if (to !== undefined) made.to = to;
  return made;
}

/**
 * Every key whose value differs between two Projects, in key order. Projects
 * are never changed in place, so every part of the tree that is still the
 * same object is skipped: the cost is what a command touched, not the song.
 */
export function diffProjects(before: Project, after: Project): Write[] {
  const from: Flat = new Map();
  const to: Flat = new Map();
  walkObject(from, to, ROOT, [], before as unknown as JsonObject, after as unknown as JsonObject);
  const writes: Write[] = [];
  for (const key of [...new Set([...from.keys(), ...to.keys()])].toSorted()) {
    const was = from.get(key);
    const is = to.get(key);
    if (!same(was, is)) writes.push(write(key, was, is));
  }
  return writes;
}

function walkObject(from: Flat, to: Flat, owner: string, path: readonly string[], a: JsonObject, b: JsonObject) {
  if (a === b) return;
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    walkField(from, to, owner, [...path, field], a[field], b[field]);
  }
}

function walkField(from: Flat, to: Flat, owner: string, slot: readonly string[], a: Json | undefined, b: Json | undefined) {
  if (a === b) return;
  const identity = COLLECTIONS[slot.at(-1)!];
  if (identity !== undefined && (Array.isArray(a) || Array.isArray(b))) {
    const items = (list: Json | undefined) =>
      new Map(Array.isArray(list) ? (list as JsonObject[]).map((item) => [itemId(owner, slot, identity, item), item]) : []);
    const was = items(a);
    const is = items(b);
    if (Array.isArray(a)) from.set(orderKey(owner, slot), [...was.keys()]);
    if (Array.isArray(b)) to.set(orderKey(owner, slot), [...is.keys()]);
    const presence = { parent: owner, slot: [...slot] };
    // An item only one side has is written whole on that side: one moved to
    // another list is whole on both, and only its presence differs.
    for (const [id, item] of was) {
      const other = is.get(id);
      if (other === item) continue;
      from.set(presenceKey(id), presence);
      if (other === undefined) flattenObject(from, id, [], item);
      else {
        to.set(presenceKey(id), presence);
        walkObject(from, to, id, [], item, other);
      }
    }
    for (const [id, item] of is) {
      if (was.has(id)) continue;
      to.set(presenceKey(id), presence);
      flattenObject(to, id, [], item);
    }
  } else if (isObject(a) && isObject(b)) {
    from.set(fieldKey(owner, slot), {});
    to.set(fieldKey(owner, slot), {});
    walkObject(from, to, owner, slot, a, b);
  } else {
    flattenField(from, owner, slot, a);
    flattenField(to, owner, slot, b);
  }
}

export function unflatten(flat: Flat): Project {
  const objects = new Map<string, JsonObject>();
  const fields: [string, string[], Json][] = [];
  const members = new Map<string, Map<string, { slot: string[]; ids: Set<string>; order: string[] }>>();
  const list = (owner: string, slot: string[]) => {
    const lists = members.get(owner) ?? new Map();
    members.set(owner, lists);
    const name = JSON.stringify(slot);
    const found = lists.get(name) ?? { slot, ids: new Set<string>(), order: [] };
    lists.set(name, found);
    return found;
  };

  for (const [key, value] of flat) {
    const parts = JSON.parse(key) as string[];
    if (parts[0] === "@") {
      const presence = value as unknown as Presence;
      list(presence.parent, presence.slot).ids.add(parts[1]!);
    } else if (parts[0] === "#") {
      list(parts[1]!, parts.slice(2)).order = value as string[];
    } else {
      fields.push([parts[0]!, parts.slice(1), value]);
    }
  }

  // Parents before children, so an object's marker makes it before its fields land.
  fields.sort((a, b) => a[1].length - b[1].length);
  for (const [owner, path, value] of fields) {
    const object = objects.get(owner) ?? {};
    objects.set(owner, object);
    const parent = at(object, path.slice(0, -1));
    if (parent) parent[path.at(-1)!] = isObject(value) ? {} : value;
  }

  const build = (owner: string, seen: Set<string>): JsonObject => {
    const object = objects.get(owner) ?? {};
    for (const { slot, ids, order } of members.get(owner)?.values() ?? []) {
      const parent = at(object, slot.slice(0, -1));
      if (!parent) continue;
      const placed = order.filter((id) => ids.has(id));
      const rest = [...ids].filter((id) => !placed.includes(id)).toSorted();
      const items = [...new Set([...placed, ...rest])]
        .filter((id) => !seen.has(id))
        .map((id) => build(id, new Set([...seen, id])));
      const by = SORTED[slot.at(-1)!];
      parent[slot.at(-1)!] = by === undefined ? items : items.toSorted((x, y) => Number(x[by]) - Number(y[by]));
    }
    return object;
  };
  return build(ROOT, new Set([ROOT])) as unknown as Project;
}

function at(object: JsonObject, path: readonly string[]): JsonObject | null {
  let here: Json = object;
  for (const part of path) {
    if (!isObject(here)) return null;
    here = here[part] ?? null;
  }
  return isObject(here) ? here : null;
}

/**
 * `next`, but made of `previous`'s objects wherever they are equal, so what
 * didn't change is still the same object: the Audio Engine's sync and the UI
 * skip it, as they do after a command.
 */
export function keep<T>(previous: T, next: T): T {
  return keepValue(previous as Json, next as Json) as T;
}

function keepValue(previous: Json | undefined, next: Json): Json {
  if (previous === next || previous === undefined) return next;
  if (previous === null || next === null || typeof previous !== "object" || typeof next !== "object") return next;
  if (Array.isArray(previous)) {
    if (!Array.isArray(next)) return next;
    let byId: Map<unknown, Json> | null = null;
    if (next.some((item) => isObject(item) && typeof item.id === "string")) {
      byId = new Map();
      for (const item of previous) if (isObject(item) && typeof item.id === "string") byId.set(item.id, item);
    }
    let unchanged = next.length === previous.length;
    const kept = next.map((item, index) => {
      const earlier = byId && isObject(item) && typeof item.id === "string" ? byId.get(item.id) : previous[index];
      const each = keepValue(earlier, item);
      unchanged &&= each === previous[index];
      return each;
    });
    return unchanged ? previous : kept;
  }
  if (Array.isArray(next)) return next;
  const fields = Object.keys(next);
  let unchanged = fields.length === Object.keys(previous).length;
  const values = fields.map((field) => {
    const each = keepValue(previous[field], next[field]!);
    unchanged &&= each === previous[field] && field in previous;
    return each;
  });
  if (unchanged) return previous;
  // In the order `previous` had them, so a Project saved again reads the same.
  const byField = new Map(fields.map((field, index) => [field, values[index]!]));
  const kept: JsonObject = {};
  for (const field of Object.keys(previous)) if (byField.has(field)) kept[field] = byField.get(field)!;
  for (const [field, value] of byField) if (!(field in kept)) kept[field] = value;
  return kept;
}

/** Two values are equal when their JSON is, whatever order their keys came in. */
export function same(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]));
  if (Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && same(a[key], b[key]));
}

export function canonical(value: Json | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).toSorted();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

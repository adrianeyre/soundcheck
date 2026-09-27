/**
 * A Project as a flat map of keys to values, so that two people's changes
 * can be told apart and merged one value at a time.
 *
 * Anything with an identity (a Track, Bus, Clip, Effect or Section, or a
 * Send, which is known by the Bus it feeds) becomes an item: a presence entry
 * saying which list of which owner it is in, and one entry per field, keyed
 * by its id rather than its place in a list. Each list's order is one more
 * entry. Any other array (a Pattern Clip's notes) is one value.
 *
 * `unflatten` builds the Project back, deterministically, from whatever is in
 * the map: an item whose owner has gone is left out, and an item missing from
 * its list's order goes at the end, in id order.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Arrays under these field names are lists of items; the value is the field that identifies one. */
export const COLLECTIONS: Readonly<Record<string, string>> = {
  tracks: "id",
  buses: "id",
  clips: "id",
  insertChain: "id",
  sections: "id",
  sends: "busId",
};

export const ROOT = "root";

export type Flat = Map<string, Json>;

interface Presence {
  parent: string;
  slot: string[];
}

export const presenceKey = (id: string) => JSON.stringify(["@", id]);
const orderKey = (owner: string, slot: readonly string[]) => JSON.stringify(["#", owner, ...slot]);
const fieldKey = (owner: string, path: readonly string[]) => JSON.stringify([owner, ...path]);

/** Which item a key belongs to, for applying a Change item by item: its lists' order is its own. */
export function ownerOf(key: string): string {
  const parts = JSON.parse(key) as string[];
  return parts[0] === "@" || parts[0] === "#" ? parts[1]! : parts[0]!;
}

export function isPresence(key: string): boolean {
  return key.startsWith('["@",');
}

export function flatten(doc: JsonObject): Flat {
  const flat: Flat = new Map();
  flattenObject(flat, ROOT, [], doc);
  return flat;
}

function flattenObject(flat: Flat, owner: string, path: string[], object: JsonObject) {
  for (const [field, value] of Object.entries(object)) {
    const slot = [...path, field];
    const identity = COLLECTIONS[field];
    if (identity !== undefined && Array.isArray(value)) {
      const ids: string[] = [];
      for (const item of value as JsonObject[]) {
        const id = identity === "id" ? String(item.id) : `${owner}/${slot.join("/")}/${String(item[identity])}`;
        ids.push(id);
        flat.set(presenceKey(id), { parent: owner, slot });
        flattenObject(flat, id, [], item);
      }
      flat.set(orderKey(owner, slot), ids);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // An object is marked, so an empty one survives and one set to null is gone.
      flat.set(fieldKey(owner, slot), {});
      flattenObject(flat, owner, slot, value);
    } else {
      flat.set(fieldKey(owner, slot), value);
    }
  }
}

export function unflatten(flat: Flat): JsonObject {
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
    const marker = value !== null && typeof value === "object" && !Array.isArray(value);
    if (parent) parent[path.at(-1)!] = marker ? {} : value;
  }

  const build = (owner: string, seen: Set<string>): JsonObject => {
    const object = objects.get(owner) ?? {};
    for (const { slot, ids, order } of members.get(owner)?.values() ?? []) {
      const parent = at(object, slot.slice(0, -1));
      if (!parent) continue;
      const placed = order.filter((id) => ids.has(id));
      const rest = [...ids].filter((id) => !placed.includes(id)).toSorted();
      parent[slot.at(-1)!] = [...new Set([...placed, ...rest])]
        .filter((id) => !seen.has(id))
        .map((id) => build(id, new Set([...seen, id])));
    }
    return object;
  };
  return build(ROOT, new Set([ROOT]));
}

function at(object: JsonObject, path: readonly string[]): JsonObject | null {
  let here: Json = object;
  for (const part of path) {
    if (here === null || typeof here !== "object" || Array.isArray(here)) return null;
    here = here[part] ?? null;
  }
  return here !== null && typeof here === "object" && !Array.isArray(here) ? here : null;
}

/** Two values are equal when their JSON is, whatever order their keys came in. */
export function same(a: Json | undefined, b: Json | undefined): boolean {
  return canonical(a) === canonical(b);
}

export function canonical(value: Json | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).toSorted();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

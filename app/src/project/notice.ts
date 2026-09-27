/**
 * Words for what a Change's writes were about, for telling someone what
 * their undo left or what of theirs was refused: "Keys", "a Clip on Keys",
 * "the tempo".
 */
import { describeKey, type Flat, presenceKey, ROOT } from "./flat";

const FIELDS: Readonly<Record<string, string>> = {
  name: "the Project's name",
  tempo: "the tempo",
  timeSignature: "the time signature",
  master: "the Master",
  referenceTrack: "the Reference Track",
  tracks: "the order of the Tracks",
  buses: "the order of the Buses",
  sections: "the Sections",
  tempoChanges: "the Tempo Changes",
};

/** What `key` is about, named from `flat` or, for an item that has gone, from `also`. */
export function whatKeyNames(key: string, flat: Flat, also?: Flat): string {
  const { owner, path } = describeKey(key);
  if (owner === ROOT) return FIELDS[path[0] ?? ""] ?? "the Project";
  const own = nameOf(owner, flat, also);
  if (own) return `“${own}”`;
  for (let id = parentOf(owner, flat, also); id !== null && id !== ROOT; id = parentOf(id, flat, also)) {
    const name = nameOf(id, flat, also);
    if (name) return `part of “${name}”`;
  }
  return "part of the Project";
}

/** Several keys' words, each once, as a list: "“Keys”, “Bass” and the tempo". */
export function whatKeysName(keys: readonly string[], flat: Flat, also?: Flat): string {
  return listed([...new Set(keys.map((key) => whatKeyNames(key, flat, also)))]);
}

/** "a", "a and b", "a, b and c". */
export function listed(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function nameOf(id: string, flat: Flat, also?: Flat): string | null {
  const key = JSON.stringify([id, "name"]);
  const name = flat.get(key) ?? also?.get(key);
  return typeof name === "string" && name !== "" ? name : null;
}

function parentOf(id: string, flat: Flat, also?: Flat): string | null {
  const presence = flat.get(presenceKey(id)) ?? also?.get(presenceKey(id));
  if (presence && typeof presence === "object" && !Array.isArray(presence) && typeof presence.parent === "string") {
    return presence.parent;
  }
  return null;
}

/**
 * Memoising a Widget's content against the Song page's frequent re-renders
 * (the meters and the playhead redraw it twenty times a second).
 *
 * The page hands its Widgets fresh arrow functions on every render, all of
 * which do the same thing: run a command on the history, or send a note to
 * the engine, for whatever the Widget's data props say. So a Widget is drawn
 * again only when a prop that isn't a function changes; the functions it
 * holds from the last render still act on the current Project, because the
 * data they close over is in the props compared.
 *
 * A Set is compared by the values it holds, and a plain object by its
 * fields' identities, so a prop the page builds afresh each render, such as
 * the notes sounding now or the Clip a Widget writes into, counts as the
 * same while what it holds is.
 */
import { memo, type ComponentType } from "react";

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

function sameValue(a: unknown, b: unknown, deep: boolean): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((item) => b.has(item));
  return deep && isPlain(a) && isPlain(b) && sameFields(a, b, false);
}

function sameFields(before: Record<string, unknown>, after: Record<string, unknown>, deep: boolean): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const [a, b] = [before[key], after[key]];
    if (typeof a === "function" && typeof b === "function") continue;
    if (!sameValue(a, b, deep)) return false;
  }
  return true;
}

/** Whether every prop but the functions is the same: by identity, a Set by its values, a plain object by its fields. */
export function sameData<P extends object>(before: P, after: P): boolean {
  return sameFields(before as Record<string, unknown>, after as Record<string, unknown>, true);
}

/** `component`, drawn again only when its data props change. */
export function memoWidget<P extends object>(component: ComponentType<P>) {
  return memo(component, sameData);
}

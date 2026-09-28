import { expect, test } from "vitest";

import { sameData } from "./memo";

test("props are the same when all but their functions are", () => {
  const data = [1];
  expect(sameData({ data, on: () => 1 }, { data, on: () => 2 })).toBe(true);
  expect(sameData({ data }, { data: [1] })).toBe(false);
  expect(sameData({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  // A Set by what it holds, a plain object by its fields.
  expect(sameData({ held: new Set([60, 64]) }, { held: new Set([64, 60]) })).toBe(true);
  expect(sameData({ held: new Set([60]) }, { held: new Set([61]) })).toBe(false);
  const notes: number[] = [];
  expect(sameData({ target: { notes, length: 4 } }, { target: { notes, length: 4 } })).toBe(true);
  expect(sameData({ target: { notes, length: 4 } }, { target: { notes: [], length: 4 } })).toBe(false);
  expect(sameData({ target: null }, { target: { notes } })).toBe(false);
});

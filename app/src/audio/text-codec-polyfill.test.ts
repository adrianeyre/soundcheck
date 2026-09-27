import { expect, test } from "vitest";

import { Utf8Decoder, Utf8Encoder } from "./text-codec-polyfill";

test("decodes the same as the platform's TextDecoder", () => {
  const text = "Audio Engine 0.1.0 — café ♫ 🎹";
  const bytes = new TextEncoder().encode(text);
  expect(new Utf8Decoder().decode(bytes)).toBe(text);
  expect(new Utf8Decoder().decode(bytes.buffer)).toBe(text);
});

test("decodes a view into part of a larger buffer, and nothing as empty", () => {
  const bytes = new TextEncoder().encode("xxhello");
  expect(new Utf8Decoder().decode(bytes.subarray(2))).toBe("hello");
  expect(new Utf8Decoder().decode()).toBe("");
});

test("encodes the same as the platform's TextEncoder", () => {
  for (const text of ["", "eq", "Audio Engine 0.1.0 — café ♫ 🎹", "lone \ud800 surrogate"]) {
    expect(new Utf8Encoder().encode(text)).toEqual(new TextEncoder().encode(text));
  }
});

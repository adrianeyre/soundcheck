/**
 * Where `pnpm htdemucs:export` writes the model. `pnpm test` and CI run it:
 *
 *   node --test scripts/export-htdemucs.test.ts
 */
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { test } from "node:test";

import { outputFolder } from "./export-htdemucs.ts";

test("on Windows, a leading ~ is the home folder, as PowerShell and cmd pass it unexpanded", () => {
  const home = "C:\\Users\\musician";
  const cwd = "C:\\work\\soundcheck";
  assert.equal(outputFolder("~/Models", cwd, home, win32), "C:\\Users\\musician\\Models");
  assert.equal(outputFolder("~\\Models", cwd, home, win32), "C:\\Users\\musician\\Models");
  assert.equal(outputFolder("~", cwd, home, win32), home);
  assert.equal(outputFolder("Models", cwd, home, win32), "C:\\work\\soundcheck\\Models");
  assert.equal(outputFolder("~Models", cwd, home, win32), "C:\\work\\soundcheck\\~Models");
});

test("elsewhere, a quoted ~/ is the home folder too, and a backslash is part of a name", () => {
  const home = "/home/musician";
  const cwd = "/work/soundcheck";
  assert.equal(outputFolder("~/Models", cwd, home, posix), "/home/musician/Models");
  assert.equal(outputFolder("~", cwd, home, posix), home);
  assert.equal(outputFolder("~\\Models", cwd, home, posix), "/work/soundcheck/~\\Models");
  assert.equal(outputFolder("Models", cwd, home, posix), "/work/soundcheck/Models");
  assert.equal(outputFolder("/data/Models", cwd, home, posix), "/data/Models");
});

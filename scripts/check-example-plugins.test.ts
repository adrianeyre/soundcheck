/**
 * The example Plugins check, on the repository's examples and on example
 * Plugins made for each test in a workspace of their own. `pnpm test` and CI
 * run it:
 *
 *   node --test scripts/check-example-plugins.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkExamplePlugins } from "./check-example-plugins.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SDK = join(ROOT, "sdk");
/** A TOML literal string, which has no escapes, so a Windows path is safe in it. */
const SDK_DEPENDENCY = `soundcheck-sdk = { version = "1.0.0", path = '${SDK}' }`;
const PLUGIN = `use soundcheck_sdk::{Effect, Manifest};

pub struct Thru;

impl Effect for Thru {
    const MANIFEST: Manifest = Manifest { id: "dev.test.thru", version: "1", name: "Thru", settings: &[] };
    fn new(_: f32, _: usize) -> Self { Thru }
    fn set(&mut self, _: usize, _: f32) {}
    fn process(&mut self, _: &mut [f32], _: &mut [f32]) {}
}

soundcheck_sdk::export_effect!(Thru);
`;

const workspaces: string[] = [];
after(() => workspaces.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface Example {
  /** More of its Cargo.toml, after its dependency on the SDK. */
  manifest?: string;
  /** Its `src/lib.rs`. */
  source?: string;
  /** Other files, by their path in the example. */
  files?: Record<string, string>;
}

/** The problems the check finds with one example Plugin, `plugin`, in a workspace of its own. */
function check(example: Example, members = '["examples/plugins/*"]'): string[] {
  const workspace = mkdtempSync(join(tmpdir(), "example-plugins-"));
  workspaces.push(workspace);
  writeFileSync(join(workspace, "Cargo.toml"), `[workspace]\nresolver = "3"\nmembers = ${members}\n`);
  const dir = join(workspace, "examples/plugins/plugin");
  mkdirSync(join(dir, "src"), { recursive: true });
  const manifest = `[package]
name = "plugin"
version = "1.0.0"
edition = "2024"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
${SDK_DEPENDENCY}
${example.manifest ?? ""}`;
  writeFileSync(join(dir, "Cargo.toml"), manifest);
  writeFileSync(join(dir, "src/lib.rs"), example.source ?? PLUGIN);
  for (const [path, contents] of Object.entries(example.files ?? {})) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return checkExamplePlugins(workspace, join(workspace, "examples/plugins"), SDK);
}

function assertFails(problems: string[], why: RegExp) {
  assert.ok(
    problems.some((problem) => why.test(problem)),
    `expected a problem matching ${why}, got ${JSON.stringify(problems)}`,
  );
}

describe("the example Plugins check", () => {
  test("passes the repository's examples", () => {
    assert.deepEqual(checkExamplePlugins(ROOT, join(ROOT, "examples/plugins"), SDK), []);
  });

  test("passes an example that uses only the SDK, the standard library and its own files", () => {
    const source = `extern crate alloc;\n#[path = "dsp/gain.rs"]\nmod gain;\nconst TABLE: &[u8] = include_bytes!("../table.bin");\n${PLUGIN}`;
    const files = { "src/dsp/gain.rs": "pub fn gain() -> f32 { 1.0 }\n", "table.bin": "\u0000" };
    assert.deepEqual(check({ source, files }), []);
  });

  test("fails on an import of another crate", () => {
    const problems = check({
      manifest: `soundcheck-engine = { path = '${join(ROOT, "engine")}' }\n`,
      source: `use soundcheck_engine::Engine;\n${PLUGIN}`,
    });
    assertFails(problems, /plugin: has a dependency on soundcheck-engine at .*; it may depend only on the SDK/);
  });

  test("fails on a crate from crates.io, and on dev- and build-dependencies", () => {
    const problems = check({
      manifest: `libm = "0.2"\n\n[dev-dependencies]\nfastrand = "2"\n\n[build-dependencies]\ncc = "1"\n`,
    });
    assertFails(problems, /a dependency on libm/);
    assertFails(problems, /a dev-dependency on fastrand/);
    assertFails(problems, /a build-dependency on cc/);
  });

  test("fails on the SDK from anywhere but sdk/", () => {
    const problems = check({ manifest: `sdk = { package = "soundcheck-sdk", version = "1" }\n` });
    assertFails(problems, /a dependency on soundcheck-sdk; it may depend only on the SDK/);
  });

  test("fails on a build script", () => {
    assertFails(check({ files: { "build.rs": "fn main() {}\n" } }), /has a build script/);
  });

  test("fails on a module, an include or a target from outside the example", () => {
    const outside = `#[path = "../../../../engine/src/lib.rs"]\nmod engine;\ninclude!("../../../outside.rs");\nconst X: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../x"));\n`;
    const problems = check({ source: `${outside}${PLUGIN}` });
    assertFails(problems, /src\/lib\.rs has a #\[path\] module outside the example/);
    assertFails(problems, /src\/lib\.rs may include! a file outside the example/);
    assertFails(problems, /src\/lib\.rs may include_str! a file outside the example/);
    assertFails(check({ manifest: `\n[[bin]]\nname = "x"\npath = "../../../main.rs"\n` }), /builds .*main\.rs, from outside/);
  });

  test("fails on extern crate of anything but the SDK and the standard library", () => {
    assertFails(check({ source: `extern crate proc_macro;\n${PLUGIN}` }), /imports proc_macro with extern crate/);
  });

  test("fails on an example that isn't in the workspace, so would go unchecked", () => {
    assertFails(check({}, "[]"), /plugin: not a member of the Cargo workspace/);
  });
});

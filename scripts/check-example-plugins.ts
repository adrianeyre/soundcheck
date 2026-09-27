/**
 * Check that every example Plugin in `examples/plugins/` is built only
 * against the SDK (the v2 PRD, #56). `pnpm lint` and CI run it:
 *
 *   node scripts/check-example-plugins.ts
 *
 * Cargo is the source of truth for what a crate can use: Rust can only name
 * a crate its manifest depends on (and the standard library's), so each
 * example may depend on `soundcheck-sdk` at `sdk/` and nothing else, in any
 * kind of dependency. Its sources are then checked for the ways around that:
 * a build script, a target or `#[path]` module outside the example,
 * `include!` of a file outside it, and `extern crate` of anything but the
 * SDK and the standard library.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface Dependency {
  name: string;
  kind: string | null;
  path?: string;
}

interface Package {
  name: string;
  manifest_path: string;
  dependencies: Dependency[];
  targets: { kind: string[]; src_path: string }[];
}

const SDK = "soundcheck-sdk";
/** The crates `extern crate` may name: the SDK, and the standard library's. */
const CRATES = new Set(["soundcheck_sdk", "std", "core", "alloc"]);

/**
 * What is wrong with the examples in `examples`, members of the Cargo
 * workspace at `workspace`, whose SDK is at `sdk`: one line each, or none.
 */
export function checkExamplePlugins(workspace: string, examples: string, sdk: string): string[] {
  const metadata = execFileSync(
    "cargo",
    ["metadata", "--no-deps", "--offline", "--format-version", "1", "--manifest-path", join(workspace, "Cargo.toml")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const packages: Package[] = JSON.parse(metadata).packages;
  const problems: string[] = [];
  const found = readdirSync(examples).filter((name) => existsSync(join(examples, name, "Cargo.toml")));
  if (found.length === 0) problems.push(`${examples} has no example Plugins`);
  for (const name of found) {
    const dir = resolve(examples, name);
    const example = packages.find((candidate) => resolve(candidate.manifest_path) === join(dir, "Cargo.toml"));
    if (!example) {
      problems.push(`${name}: not a member of the Cargo workspace, so it is neither built nor checked`);
      continue;
    }
    problems.push(...checkManifest(name, dir, example, resolve(sdk)), ...checkSources(name, dir));
  }
  return problems;
}

function checkManifest(name: string, dir: string, example: Package, sdk: string): string[] {
  const problems: string[] = [];
  for (const dependency of example.dependencies) {
    const kind = dependency.kind ? `${dependency.kind}-` : "";
    if (dependency.name !== SDK || !dependency.path || resolve(dependency.path) !== sdk) {
      const from = dependency.path ? ` at ${dependency.path}` : "";
      problems.push(`${name}: has a ${kind}dependency on ${dependency.name}${from}; it may depend only on the SDK`);
    }
  }
  for (const target of example.targets) {
    if (target.kind.includes("custom-build")) {
      problems.push(`${name}: has a build script, which could reach past the SDK`);
    } else if (!inside(dir, target.src_path)) {
      problems.push(`${name}: builds ${target.src_path}, from outside the example`);
    }
  }
  return problems;
}

function checkSources(name: string, dir: string): string[] {
  const problems: string[] = [];
  for (const file of rustFiles(dir)) {
    const where = `${name}: ${relative(dir, file).split(sep).join("/")}`;
    const source = readFileSync(file, "utf8");
    for (const [, crate] of source.matchAll(/\bextern\s+crate\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!CRATES.has(crate!)) problems.push(`${where} imports ${crate} with extern crate; only the SDK is allowed`);
    }
    for (const [, path] of source.matchAll(/#\s*\[\s*path\s*=\s*"([^"]*)"/g)) {
      if (!inside(dir, resolve(dirname(file), path!))) problems.push(`${where} has a #[path] module outside the example: ${path}`);
    }
    for (const [call, macro, argument] of source.matchAll(/\b(include(?:_str|_bytes)?)!\s*\(\s*([^)]*)\)/g)) {
      const literal = /^"([^"]*)"$/.exec(argument!.trim());
      if (!literal || !inside(dir, resolve(dirname(file), literal[1]!))) {
        problems.push(`${where} may ${macro}! a file outside the example: ${call}`);
      }
    }
  }
  return problems;
}

/** Every `.rs` file in `dir`, leaving out a build's `target/`. */
function rustFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "target" ? [] : rustFiles(path);
    return entry.endsWith(".rs") ? [path] : [];
  });
}

/**
 * Whether `path` is in `dir`. A `#[path]` or `include!` is resolved from its
 * file's folder: a module's `#[path]` can resolve one folder deeper, so this
 * is the stricter reading.
 */
function inside(dir: string, path: string): boolean {
  const from = relative(dir, resolve(path));
  return from !== "" && !from.startsWith("..") && !isAbsolute(from);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const problems = checkExamplePlugins(root, join(root, "examples/plugins"), join(root, "sdk"));
  if (problems.length > 0) {
    console.error(`The example Plugins must be built only against the SDK:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("The example Plugins depend on and import only the SDK.");
}

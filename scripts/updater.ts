/**
 * The updater's side of the build (#74). `pnpm desktop:build` runs through it:
 *
 *   node scripts/updater.ts build [tauri build's options]   build, with update packages if the key is set
 *   node scripts/updater.ts --how                           print whether it would sign them, and build nothing
 *   node scripts/updater.ts manifest <dir> <url> [notes]    check a release's packages and write its latest.json
 *
 * The installed Desktop App updates itself through Tauri's updater, which
 * downloads a package and installs it only if it is signed by the updater's
 * key: the private half is the `TAURI_SIGNING_PRIVATE_KEY` secret, and the
 * public half, `plugins.updater.pubkey` in `desktop/tauri.conf.json`, is
 * built into the app. Tauri signs the packages (the NSIS installer, the
 * app's `.tar.gz` on macOS, the AppImage and the .deb) when
 * `bundle.createUpdaterArtifacts` is on, but then fails the build without
 * the private key. So it is off in the config, and this turns it on when:
 *
 * - the key and the public key are both there: the packages are **signed**;
 * - otherwise they are **unsigned**, and the build goes on without them, so
 *   a fork, a pull request and a developer's machine still build. With the
 *   public key committed but no secret, installed copies still update, just
 *   not to this build.
 *
 * The private key without the public key, or its password without the key,
 * is half a set, and fails, naming what is missing and never a value.
 *
 * It bundles the VST3 helper too (#70, ADR 0008), on Windows and Linux: Tauri
 * installs a sidecar beside the app, where the app looks for it. `pnpm
 * vst3:build` builds it first; this copies it to the name Tauri wants, with
 * the target's triple, and fails, saying so, if it isn't built. Not on macOS,
 * where the helper isn't built yet (ADR 0008's slice 6).
 *
 * `manifest` is the release's side: the app asks the Release for
 * `latest.json`, which names the version, and each platform's package and
 * signature. It checks every signature against the committed public key and
 * the version being released first, as the app will, so a release can't
 * announce a package no installed copy would take.
 */
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Env = Record<string, string | undefined>;

export type Signing =
  | { kind: "signed" }
  | { kind: "unsigned"; publicKey: boolean }
  | { kind: "incomplete"; missing: string[] };

const PRIVATE_KEY = "TAURI_SIGNING_PRIVATE_KEY";
const PASSWORD = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD";
/** Where the public key goes, named as the maintainer would look for it. */
export const PUBLIC_KEY = "plugins.updater.pubkey in desktop/tauri.conf.json";

export const CONFIG = fileURLToPath(new URL("../desktop/tauri.conf.json", import.meta.url));
const PACKAGE = fileURLToPath(new URL("../package.json", import.meta.url));

/** What `tauri build` is given, when the packages are signed, to make them. */
export const UPDATER_ARTIFACTS = JSON.stringify({ bundle: { createUpdaterArtifacts: true } });

/**
 * The VST3 helper as a sidecar, from `desktop/`: Tauri reads it with the
 * target's triple on the end, and installs it beside the app without.
 */
export const HELPER_SIDECAR = "vst3-host/build/sidecar/soundcheck-vst3-host";
const DESKTOP = fileURLToPath(new URL("../desktop/", import.meta.url));

/** GitHub sets a secret it doesn't have to an empty string. */
function set(env: Env, name: string): boolean {
  return (env[name] ?? "") !== "";
}

/** The public key the app is built with, or "" until the maintainer has made the key. */
export function publicKey(config: string): string {
  const parsed = JSON.parse(config) as { plugins?: { updater?: { pubkey?: string } } };
  return parsed.plugins?.updater?.pubkey?.trim() ?? "";
}

/** Whether to sign the update packages, with the secrets in `env` and the app's public key. */
export function signing(env: Env, pubkey: string): Signing {
  const key = set(env, PRIVATE_KEY);
  if (key && pubkey === "") return { kind: "incomplete", missing: [PUBLIC_KEY] };
  if (!key && set(env, PASSWORD)) return { kind: "incomplete", missing: [PRIVATE_KEY] };
  if (key) return { kind: "signed" };
  return { kind: "unsigned", publicKey: pubkey !== "" };
}

export function summary(how: Signing): string {
  switch (how.kind) {
    case "signed":
      return "Signing the update packages with the updater's key.";
    case "unsigned":
      return how.publicKey
        ? `Not making update packages: ${PRIVATE_KEY} isn't set here, so installed copies won't update to this build.`
        : `Not making update packages: the updater has no key yet (see the README's "Releases and updates"), so this build won't update itself.`;
    case "incomplete":
      return `The updater's key is half set up: ${how.missing.join(", ")} ${how.missing.length === 1 ? "isn't" : "aren't"} set.`;
  }
}

/** Whether a build on `platform` bundles the VST3 helper: not on macOS yet. */
export function bundlesHelper(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

/**
 * `tauri build`'s arguments for `args`, with the update packages turned on
 * when they are signed, and the VST3 helper bundled when `helper` says. In
 * one `--config`, before any `--`, since what follows goes to Cargo.
 */
export function tauriArgs(args: string[], how: Exclude<Signing, { kind: "incomplete" }>, helper: boolean): string[] {
  const bundle = {
    ...(how.kind === "signed" && { createUpdaterArtifacts: true }),
    ...(helper && { externalBin: [HELPER_SIDECAR] }),
  };
  if (Object.keys(bundle).length === 0) return ["build", ...args];
  const end = args.indexOf("--");
  const [ours, cargo] = end === -1 ? [args, []] : [args.slice(0, end), args.slice(end)];
  return ["build", ...ours, "--config", JSON.stringify({ bundle }), ...cargo];
}

/**
 * The target a build is for: its own `--target` (or `-t`), or else the
 * host's, from `rustc -vV`'s output.
 */
export function targetTriple(args: string[], rustc: string): string | null {
  const end = args.indexOf("--");
  const ours = end === -1 ? args : args.slice(0, end);
  for (const [index, arg] of ours.entries()) {
    if (arg.startsWith("--target=")) return arg.slice("--target=".length);
    if ((arg === "--target" || arg === "-t") && ours[index + 1]) return ours[index + 1]!;
  }
  return /^host: (\S+)$/m.exec(rustc)?.[1] ?? null;
}

/**
 * Copies the helper `pnpm vst3:build` built, in `desktop`, to where
 * `HELPER_SIDECAR` says for `triple`; or says why it can't.
 */
export function placeHelper(desktop: string, triple: string): { ok: true } | { ok: false; why: string } {
  const exe = triple.includes("windows") ? ".exe" : "";
  const built = join(desktop, "vst3-host/build/bin", `soundcheck-vst3-host${exe}`);
  if (!existsSync(built)) {
    return { ok: false, why: `The VST3 helper isn't built (no ${built}): run pnpm vst3:build first.` };
  }
  const sidecar = join(desktop, `${HELPER_SIDECAR}-${triple}${exe}`);
  mkdirSync(dirname(sidecar), { recursive: true });
  copyFileSync(built, sidecar);
  return { ok: true };
}

/** `env` without the empty variables GitHub gives for secrets it doesn't have, which Tauri would take for set. */
export function cleanEnv(env: Env): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value !== "") vars[name] = value;
  }
  return vars;
}

/** A minisign key or signature: base64 of text lines, as Tauri writes them. */
function lines(base64: string): string[] {
  return Buffer.from(base64.trim(), "base64").toString("utf8").split("\n");
}

/** Node reads a raw Ed25519 public key only wrapped in this DER header. */
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const TRUSTED = "trusted comment: ";

export type Verdict = { ok: true; version: string | undefined } | { ok: false; why: string };

/**
 * Checks `signature`, the contents of a `.sig`, over `data` with `pubkey`,
 * as the updater does: minisign's Ed25519 signature over the data (or, as
 * Tauri signs, over its BLAKE2b-512 hash), and the global signature over
 * that and the trusted comment, which holds the version it was signed for.
 */
export function verify(pubkey: string, data: Buffer, signature: string): Verdict {
  const key = Buffer.from(lines(pubkey)[1] ?? "", "base64");
  if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed") {
    return { ok: false, why: "the public key isn't a minisign key" };
  }
  const [, sigLine = "", trustedLine = "", globalLine = ""] = lines(signature);
  const sig = Buffer.from(sigLine, "base64");
  const global = Buffer.from(globalLine, "base64");
  const alg = sig.subarray(0, 2).toString();
  if (sig.length !== 74 || (alg !== "Ed" && alg !== "ED") || global.length !== 64 || !trustedLine.startsWith(TRUSTED)) {
    return { ok: false, why: "it isn't a minisign signature" };
  }
  if (!sig.subarray(2, 10).equals(key.subarray(2, 10))) return { ok: false, why: "it is signed by another key" };

  const der = Buffer.concat([ED25519_SPKI, key.subarray(10)]);
  const ed25519 = createPublicKey({ key: der, format: "der", type: "spki" });
  const signed = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verifyEd25519(null, signed, ed25519, sig.subarray(10))) {
    return { ok: false, why: "the file isn't what was signed" };
  }
  const trusted = trustedLine.slice(TRUSTED.length);
  if (!verifyEd25519(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), ed25519, global)) {
    return { ok: false, why: "its trusted comment isn't what was signed" };
  }
  const version = trusted.split("\t").find((field) => field.startsWith("version:"));
  return { ok: true, version: version?.slice("version:".length) };
}

/** Each kind of update package, by the end of its name, and the updater's names for the platform it updates. */
const PLATFORMS: [suffix: string, targets: string[]][] = [
  ["-setup.exe", ["windows-x86_64-nsis", "windows-x86_64"]],
  [".app.tar.gz", ["darwin-aarch64-app", "darwin-aarch64"]],
  [".AppImage", ["linux-x86_64-appimage", "linux-x86_64"]],
  [".deb", ["linux-x86_64-deb"]],
];

/** The updater's names for the platform `file` updates, or none if it isn't an update package. */
export function targets(file: string): string[] {
  return PLATFORMS.find(([suffix]) => file.endsWith(suffix))?.[1] ?? [];
}

export interface Package {
  file: string;
  /** The contents of its `.sig`. */
  signature: string;
}

export interface Manifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

/** The `latest.json` that announces `version`'s `packages`, each downloaded from `url` followed by its name. */
export function manifest(version: string, packages: Package[], url: string, notes: string, date: Date): Manifest {
  const platforms: Manifest["platforms"] = {};
  for (const { file, signature } of packages) {
    for (const target of targets(file)) {
      if (platforms[target]) throw new Error(`Two update packages for ${target}: ${file} and another.`);
      platforms[target] = { signature: signature.trim(), url: `${url.replace(/\/$/, "")}/${encodeURIComponent(file)}` };
    }
  }
  return { version, notes, pub_date: date.toISOString().replace(/\.\d{3}Z$/, "Z"), platforms };
}

/**
 * The update packages in `files` (names in one folder) and the problems
 * with them: a package without its `.sig`, or a `.sig` without its package.
 */
export function pair(files: string[]): { packages: string[]; problems: string[] } {
  const names = new Set(files);
  const packages = files.filter((file) => targets(file).length > 0).toSorted();
  const problems = [
    ...packages.filter((file) => !names.has(`${file}.sig`)).map((file) => `${file} has no signature.`),
    ...files
      .filter((file) => file.endsWith(".sig") && !packages.includes(file.slice(0, -4)))
      .map((file) => `${file} signs no update package.`),
  ];
  return { packages, problems };
}

export type Release =
  | { kind: "none" }
  | { kind: "problems"; problems: string[] }
  | { kind: "signed"; packages: Package[] };

/**
 * The update packages in `dir` for `version`, each checked against
 * `pubkey`, or what is wrong with them. With no key yet and no signature,
 * there is nothing to announce, which is no failure.
 */
export function release(dir: string, pubkey: string, version: string): Release {
  const files = readdirSync(dir);
  const { packages, problems } = pair(files);
  const signatures = files.filter((file) => file.endsWith(".sig"));

  if (signatures.length === 0 && pubkey === "") return { kind: "none" };
  if (pubkey === "") problems.unshift(`The packages are signed, but ${PUBLIC_KEY} isn't set.`);
  else if (signatures.length === 0) {
    problems.unshift(`${PUBLIC_KEY} is set, but no package is signed: is ${PRIVATE_KEY} set?`);
  }
  if (problems.length > 0) return { kind: "problems", problems };

  const signed: Package[] = [];
  for (const file of packages) {
    const signature = readFileSync(join(dir, `${file}.sig`), "utf8");
    const verdict = verify(pubkey, readFileSync(join(dir, file)), signature);
    if (!verdict.ok) problems.push(`${file}: ${verdict.why}.`);
    else if (verdict.version !== version) {
      problems.push(`${file} is signed for version ${verdict.version ?? "(none)"}, not ${version}.`);
    } else signed.push({ file, signature });
  }
  return problems.length > 0 ? { kind: "problems", problems } : { kind: "signed", packages: signed };
}

/** Writes `latest.json` into `dir` for this version's packages there, downloaded from `url`; its exit status. */
function writeManifest(dir: string, url: string, notesFile: string | undefined): number {
  const version = (JSON.parse(readFileSync(PACKAGE, "utf8")) as { version: string }).version;
  const found = release(dir, publicKey(readFileSync(CONFIG, "utf8")), version);
  if (found.kind === "none") {
    console.log(`No update packages: the updater has no key yet (see the README's "Releases and updates"), so no latest.json.`);
    return 0;
  }
  if (found.kind === "problems") {
    console.error(found.problems.join("\n"));
    return 1;
  }
  const notes = notesFile ? readFileSync(notesFile, "utf8").trim() : "";
  const latest = manifest(version, found.packages, url, notes, new Date());
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`Wrote latest.json for ${version}: ${Object.keys(latest.platforms).join(", ")}.`);
  return 0;
}

/** Runs `tauri build` with `args`, making signed update packages if it can; its exit status. */
function build(args: string[], env: Env): number {
  const how = signing(env, publicKey(readFileSync(CONFIG, "utf8")));
  if (how.kind === "incomplete") {
    console.error(summary(how));
    return 1;
  }
  console.log(summary(how));
  const helper = bundlesHelper(process.platform);
  if (helper) {
    const rustc = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
    const triple = targetTriple(args, rustc.stdout ?? "");
    if (!triple) {
      console.error("Couldn't tell which target this builds for: rustc -vV didn't say, and there is no --target.");
      return 1;
    }
    const placed = placeHelper(DESKTOP, triple);
    if (!placed.ok) {
      console.error(placed.why);
      return 1;
    }
    console.log(`Bundling the VST3 helper for ${triple}.`);
  }
  // The CLI's own script, run by this Node: Windows can't spawn the `.cmd`
  // shim without a shell, and a shell would mangle the JSON.
  const tauri = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
  const result = spawnSync(process.execPath, [tauri, ...tauriArgs(args, how, helper)], { stdio: "inherit", env: cleanEnv(env) });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--how") {
    const how = signing(process.env, publicKey(readFileSync(CONFIG, "utf8")));
    if (how.kind === "incomplete") {
      console.error(summary(how));
      process.exitCode = 1;
    } else {
      console.log(how.kind);
    }
  } else if (args[0] === "build") {
    process.exitCode = build(args.slice(1), process.env);
  } else if (args[0] === "manifest" && (args.length === 3 || args.length === 4)) {
    process.exitCode = writeManifest(args[1]!, args[2]!, args[3]);
  } else {
    console.error("usage: node scripts/updater.ts build [options] | --how | manifest <dir> <url> [notes-file]");
    process.exitCode = 2;
  }
}

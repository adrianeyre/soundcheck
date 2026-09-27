/**
 * The macOS sign command (#72, ADR 0010). It runs the macOS build with the
 * environment Tauri signs and notarises from:
 *
 *   node scripts/sign-macos.ts -- pnpm desktop:build   build, signed as the secrets allow
 *   node scripts/sign-macos.ts --notarise <file>       notarise and staple the disk image too
 *   node scripts/sign-macos.ts --how                   print how it would sign, and build nothing
 *
 * Tauri signs and notarises by itself, from `APPLE_*` variables, but takes an
 * empty one for set, and GitHub gives a secret it doesn't have as an empty
 * string; and it reads an App Store Connect API key only from a file. So this
 * drops the empty ones, writes the key to a file for the length of the build,
 * and chooses:
 *
 * - a **Developer ID**, notarised, when the certificate (or an identity in
 *   this Mac's keychain) and one way of notarising are set: an App Store
 *   Connect API key, or else an Apple ID;
 * - otherwise **ad hoc**, as `desktop/tauri.macos.conf.json` says, so a
 *   build with no secret (a fork, a pull request, a developer's Mac) still
 *   makes an app that runs on Apple silicon.
 *
 * Half a set of secrets is a mistake, so that fails, naming what is missing.
 * A certificate with no way to notarise is half a set: Gatekeeper turns a
 * Developer ID app away unless it is notarised.
 *
 * Tauri notarises the app, but not the disk image it then puts it in, which
 * Gatekeeper checks first when a downloaded one is opened; `--notarise` does
 * that with the same secrets, and nothing when the app is signed ad hoc.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Env = Record<string, string | undefined>;

export type Notarise = "api-key" | "apple-id";

export type Signing =
  | { kind: "developer-id"; notarise: Notarise }
  | { kind: "ad-hoc" }
  | { kind: "incomplete"; missing: string[]; or?: string[] };

/** The Developer ID Application certificate and its private key, as a base64 `.p12`, and its password. */
const CERTIFICATE = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD"];
/** Names a certificate: one already in this Mac's keychain, or which of those in `APPLE_CERTIFICATE`. */
const IDENTITY = "APPLE_SIGNING_IDENTITY";
/** An App Store Connect API key: its ID, its issuer, and the key itself (or, on a Mac, the path to its `.p8`). */
const API_KEY = ["APPLE_API_KEY", "APPLE_API_ISSUER"];
const API_PRIVATE_KEY = "APPLE_API_PRIVATE_KEY";
const API_KEY_PATH = "APPLE_API_KEY_PATH";
/** An Apple ID, an app-specific password for it, and the team that owns the certificate. */
const APPLE_ID = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];

/**
 * Accepted by Tauri as the identity when `APPLE_CERTIFICATE` is set if the
 * certificate's name contains it, so it refuses any certificate but a
 * Developer ID Application one: not an Apple Development one, which
 * Gatekeeper doesn't trust, nor a Developer ID Installer one.
 */
const DEVELOPER_ID_APPLICATION = "Developer ID Application";

/** GitHub sets a secret it doesn't have to an empty string. */
function set(env: Env, name: string): boolean {
  return (env[name] ?? "") !== "";
}

/** How to sign and notarise with the secrets in `env`. */
export function signing(env: Env): Signing {
  const unset = (names: string[]) => names.filter((name) => !set(env, name));
  const any = (names: string[]) => names.some((name) => set(env, name));

  const apiKey = [...API_KEY, API_PRIVATE_KEY, API_KEY_PATH];
  const started = any([...CERTIFICATE, IDENTITY, ...apiKey, ...APPLE_ID]);
  if (!started) return { kind: "ad-hoc" };

  const missing: string[] = [];
  if (any(CERTIFICATE) || !set(env, IDENTITY)) missing.push(...unset(CERTIFICATE));

  const apiKeyMissing = [...unset(API_KEY), ...(any([API_PRIVATE_KEY, API_KEY_PATH]) ? [] : [API_PRIVATE_KEY])];
  const appleIdMissing = unset(APPLE_ID);
  if (any(apiKey)) missing.push(...apiKeyMissing);
  if (any(APPLE_ID)) missing.push(...appleIdMissing);
  if (!any(apiKey) && !any(APPLE_ID)) {
    return { kind: "incomplete", missing: [...missing, ...apiKeyMissing], or: appleIdMissing };
  }

  if (missing.length > 0) return { kind: "incomplete", missing };
  return { kind: "developer-id", notarise: any(apiKey) ? "api-key" : "apple-id" };
}

export interface TauriEnv {
  /** The environment for `tauri build`. */
  vars: Record<string, string>;
  /** Files to write before it runs, into the folder given, and delete after. */
  files: { path: string; contents: string }[];
}

/** The environment Tauri signs and notarises from, for `how`, with any file it needs put in `folder`. */
export function tauriEnv(env: Env, how: Exclude<Signing, { kind: "incomplete" }>, folder: string): TauriEnv {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value !== "") vars[name] = value;
  }
  const files: TauriEnv["files"] = [];
  if (how.kind === "ad-hoc") return { vars, files };

  if (set(env, "APPLE_CERTIFICATE") && !set(env, IDENTITY)) vars[IDENTITY] = DEVELOPER_ID_APPLICATION;

  if (how.notarise === "api-key") {
    // Tauri notarises with the Apple ID whenever it is complete.
    for (const name of APPLE_ID) delete vars[name];
    if (set(env, API_PRIVATE_KEY)) {
      const path = join(folder, `AuthKey_${env.APPLE_API_KEY}.p8`);
      files.push({ path, contents: env[API_PRIVATE_KEY]! });
      vars[API_KEY_PATH] = path;
      delete vars[API_PRIVATE_KEY];
    }
  }
  return { vars, files };
}

function summary(how: Signing): string {
  switch (how.kind) {
    case "ad-hoc":
      return `Signing ad hoc: no Apple signing secret is set (see the README's "Signing and notarising the Mac app").`;
    case "developer-id":
      return `Signing with the Developer ID and notarising with the ${how.notarise === "api-key" ? "App Store Connect API key" : "Apple ID"}.`;
    case "incomplete": {
      const names = how.missing.join(", ") + (how.or ? ` (or ${how.or.join(", ")})` : "");
      return `macOS signing is half set up: ${names} ${how.missing.length === 1 && !how.or ? "isn't" : "aren't"} set.`;
    }
  }
}

export interface Command {
  command: string;
  args: string[];
}

/** Submits `file` to Apple's notary service with the credentials in Tauri's environment, and waits for its answer. */
export function notarytoolCommand(vars: Record<string, string>, notarise: Notarise, file: string): Command {
  const credentials =
    notarise === "api-key"
      ? ["--key", vars[API_KEY_PATH]!, "--key-id", vars.APPLE_API_KEY!, "--issuer", vars.APPLE_API_ISSUER!]
      : ["--apple-id", vars.APPLE_ID!, "--password", vars.APPLE_PASSWORD!, "--team-id", vars.APPLE_TEAM_ID!];
  return { command: "xcrun", args: ["notarytool", "submit", file, ...credentials, "--wait", "--output-format", "json"] };
}

/** Whether notarytool's JSON says Apple accepted the submission; if not, its ID, for `xcrun notarytool log`. */
export function notarised(output: string): { accepted: boolean; id?: string; status?: string } {
  const line = output.trim().split("\n").findLast((text) => text.startsWith("{"));
  if (!line) return { accepted: false };
  const { id, status } = JSON.parse(line) as { id?: string; status?: string };
  return { accepted: status === "Accepted", id, status };
}

/** Runs `command` with Tauri's environment for the secrets in `env`; its exit status. */
function build([command, ...args]: string[], env: Env): number {
  const how = signing(env);
  if (how.kind === "incomplete") {
    console.error(summary(how));
    return 1;
  }
  console.log(summary(how));
  const folder = mkdtempSync(join(tmpdir(), "soundcheck-sign-"));
  try {
    const { vars, files } = tauriEnv(env, how, folder);
    for (const { path, contents } of files) writeFileSync(path, contents, { mode: 0o600 });
    const result = spawnSync(command!, args, { stdio: "inherit", env: vars });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Notarises `file` and staples the ticket to it, so it opens offline too; its exit status. */
function notariseFile(file: string, env: Env): number {
  const how = signing(env);
  if (how.kind === "incomplete") {
    console.error(summary(how));
    return 1;
  }
  if (how.kind === "ad-hoc") {
    console.log(`Not notarising ${file}: the app is signed ad hoc.`);
    return 0;
  }
  const folder = mkdtempSync(join(tmpdir(), "soundcheck-sign-"));
  try {
    const { vars, files } = tauriEnv(env, how, folder);
    for (const { path, contents } of files) writeFileSync(path, contents, { mode: 0o600 });
    console.log(`Notarising ${file}; Apple usually answers within a few minutes.`);
    const { command, args } = notarytoolCommand(vars, how.notarise, file);
    const submitted = spawnSync(command, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", env: vars });
    if (submitted.error) throw submitted.error;
    const answer = notarised(submitted.stdout);
    if (!answer.accepted) {
      const log = answer.id ? ` \`xcrun notarytool log ${answer.id}\` says why.` : "";
      console.error(`Apple didn't notarise ${file} (${answer.status ?? `notarytool exited with ${submitted.status}`}).${log}`);
      return 1;
    }
    const stapled = spawnSync("xcrun", ["stapler", "staple", file], { stdio: "inherit" });
    if (stapled.error) throw stapled.error;
    return stapled.status ?? 1;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--how") {
    const how = signing(process.env);
    if (how.kind === "incomplete") {
      console.error(summary(how));
      process.exitCode = 1;
    } else {
      console.log(how.kind);
    }
  } else if (args[0] === "--" && args.length > 1) {
    process.exitCode = build(args.slice(1), process.env);
  } else if (args[0] === "--notarise" && args.length === 2) {
    process.exitCode = notariseFile(args[1]!, process.env);
  } else {
    console.error("usage: node scripts/sign-macos.ts -- <command> | --notarise <file> | --how");
    process.exitCode = 2;
  }
}

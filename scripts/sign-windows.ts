/**
 * The Windows sign command (#73, ADR 0009). Tauri runs it on each file of the
 * Windows build it signs, the app, the NSIS installer and its uninstaller
 * (`bundle.windows.signCommand` in `desktop/tauri.windows.conf.json`):
 *
 *   node scripts/sign-windows.ts <file>   sign one file
 *   node scripts/sign-windows.ts --how    print how it would sign, and sign nothing
 *
 * It signs through Azure Artifact Signing when every `AZURE_ARTIFACT_SIGNING_*`
 * secret and Azure's sign-in are set, else with a PFX certificate when
 * `WINDOWS_CERTIFICATE` and its password are, and otherwise leaves the file
 * unsigned and succeeds, so a build with no secret (a fork, a pull request,
 * a developer's machine) still makes an installer. Half a set of secrets is
 * a mistake, so that fails, naming what is missing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Env = Record<string, string | undefined>;

export type Signing =
  | { kind: "artifact-signing" }
  | { kind: "pfx" }
  | { kind: "unsigned" }
  | { kind: "incomplete"; missing: string[] };

/** Azure's sign-in: an app registration allowed to sign with the account's certificate profile. */
const AZURE_SIGN_IN = ["AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID"];
const ARTIFACT_SIGNING_ONLY = [
  "AZURE_ARTIFACT_SIGNING_ENDPOINT",
  "AZURE_ARTIFACT_SIGNING_ACCOUNT",
  "AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE",
];
const ARTIFACT_SIGNING = [...AZURE_SIGN_IN, ...ARTIFACT_SIGNING_ONLY];
const PFX = ["WINDOWS_CERTIFICATE", "WINDOWS_CERTIFICATE_PASSWORD"];

const DESCRIPTION = "Soundcheck";
const TIMESTAMP_URL = "http://timestamp.digicert.com";

/** GitHub sets a secret it doesn't have to an empty string. */
function set(env: Env, name: string): boolean {
  return (env[name] ?? "") !== "";
}

/**
 * How to sign with the secrets in `env`. Azure's sign-in alone doesn't start
 * Artifact Signing, since a machine can use Azure for other things; any of
 * its own three does.
 */
export function signing(env: Env): Signing {
  const missing = (names: string[]) => names.filter((name) => !set(env, name));
  if (ARTIFACT_SIGNING_ONLY.some((name) => set(env, name))) {
    const unset = missing(ARTIFACT_SIGNING);
    return unset.length === 0 ? { kind: "artifact-signing" } : { kind: "incomplete", missing: unset };
  }
  if (PFX.some((name) => set(env, name))) {
    const unset = missing(PFX);
    return unset.length === 0 ? { kind: "pfx" } : { kind: "incomplete", missing: unset };
  }
  return { kind: "unsigned" };
}

function version(name: string): number[] {
  return name.split(".").map(Number);
}

/** The newest Windows 10 SDK among the folder names in a Windows Kits `bin` folder. */
export function newestSdk(names: string[]): string | undefined {
  return names
    .filter((name) => /^10\.\d+\.\d+\.\d+$/.test(name))
    .toSorted((a, b) => {
      const [x, y] = [version(a), version(b)];
      const i = x.findIndex((part, j) => part !== y[j]);
      return i === -1 ? 0 : y[i]! - x[i]!;
    })[0];
}

/** `SIGNTOOL_PATH`, else the newest SDK's signtool for this machine, as Tauri finds it. */
function signtool(env: Env): string {
  if (set(env, "SIGNTOOL_PATH")) return env.SIGNTOOL_PATH!;
  const bin = join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const sdk = existsSync(bin) ? newestSdk(readdirSync(bin)) : undefined;
  const path = sdk && join(bin, sdk, arch, "signtool.exe");
  if (!path || !existsSync(path)) {
    throw new Error(`signtool.exe isn't in ${bin}: install the Windows SDK, or set SIGNTOOL_PATH`);
  }
  return path;
}

export interface Command {
  command: string;
  args: string[];
}

/**
 * Levminer's `artifact-signing-cli` signs through Azure's signtool plugin. It
 * reads Azure's sign-in from the environment, so no secret is an argument here.
 */
export function artifactSigningCommand(env: Env, file: string): Command {
  return {
    command: "artifact-signing-cli",
    args: [
      "-e",
      env.AZURE_ARTIFACT_SIGNING_ENDPOINT!,
      "-a",
      env.AZURE_ARTIFACT_SIGNING_ACCOUNT!,
      "-c",
      env.AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE!,
      "-d",
      DESCRIPTION,
      file,
    ],
  };
}

export function pfxCommand(signtoolPath: string, certificate: string, password: string, file: string, env: Env): Command {
  const timestamp = set(env, "WINDOWS_TIMESTAMP_URL") ? env.WINDOWS_TIMESTAMP_URL! : TIMESTAMP_URL;
  return {
    command: signtoolPath,
    args: ["sign", "/fd", "SHA256", "/tr", timestamp, "/td", "SHA256", "/f", certificate, "/p", password, "/d", DESCRIPTION, file],
  };
}

/** Runs `command`, its output going where the script's does; its exit status. */
function run({ command, args }: Command, env: Env): number {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function sign(file: string, env: Env): number {
  const how = signing(env);
  switch (how.kind) {
    case "unsigned":
      console.log(`Not signing ${file}: no Windows signing secret is set (see the README's "Signing the installer").`);
      return 0;
    case "incomplete":
      console.error(`Can't sign ${file}: ${how.missing.join(", ")} ${how.missing.length === 1 ? "isn't" : "aren't"} set.`);
      return 1;
    case "artifact-signing":
      // The CLI's own default is one SDK version's signtool; this finds the newest there is.
      return run(artifactSigningCommand(env, file), { ...env, SIGNTOOL_PATH: signtool(env) });
    case "pfx": {
      const folder = mkdtempSync(join(tmpdir(), "soundcheck-sign-"));
      try {
        const certificate = join(folder, "certificate.pfx");
        writeFileSync(certificate, Buffer.from(env.WINDOWS_CERTIFICATE!, "base64"));
        return run(pfxCommand(signtool(env), certificate, env.WINDOWS_CERTIFICATE_PASSWORD!, file, env), env);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [arg] = process.argv.slice(2);
  if (arg === "--how") {
    const how = signing(process.env);
    if (how.kind === "incomplete") {
      console.error(`Windows signing is half set up: ${how.missing.join(", ")} ${how.missing.length === 1 ? "isn't" : "aren't"} set.`);
      process.exitCode = 1;
    } else {
      console.log(how.kind);
    }
  } else if (arg) {
    process.exitCode = sign(arg, process.env);
  } else {
    console.error("usage: node scripts/sign-windows.ts <file> | --how");
    process.exitCode = 2;
  }
}

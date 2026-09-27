/**
 * The Windows sign command's choice of how to sign, the commands it runs,
 * the script itself run with no secret set, and the Tauri config that runs
 * it. `pnpm test` and CI run it:
 *
 *   node --test scripts/sign-windows.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { artifactSigningCommand, newestSdk, pfxCommand, signing } from "./sign-windows.ts";

const SCRIPT = fileURLToPath(new URL("./sign-windows.ts", import.meta.url));
const DESKTOP = fileURLToPath(new URL("../desktop", import.meta.url));

const ARTIFACT_SIGNING = {
  AZURE_CLIENT_ID: "client",
  AZURE_CLIENT_SECRET: "secret",
  AZURE_TENANT_ID: "tenant",
  AZURE_ARTIFACT_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
  AZURE_ARTIFACT_SIGNING_ACCOUNT: "soundcheck",
  AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE: "public",
};
const PFX = { WINDOWS_CERTIFICATE: "MIIK", WINDOWS_CERTIFICATE_PASSWORD: "hunter2" };

describe("signing", () => {
  test("with no secret, it doesn't sign", () => {
    assert.deepEqual(signing({}), { kind: "unsigned" });
  });

  test("a secret GitHub doesn't have is an empty string, which is no secret", () => {
    const empty = Object.fromEntries(Object.keys({ ...ARTIFACT_SIGNING, ...PFX }).map((name) => [name, ""]));
    assert.deepEqual(signing(empty), { kind: "unsigned" });
  });

  test("with every Artifact Signing secret, it signs through Artifact Signing", () => {
    assert.deepEqual(signing(ARTIFACT_SIGNING), { kind: "artifact-signing" });
  });

  test("with the certificate and its password, it signs with the PFX", () => {
    assert.deepEqual(signing(PFX), { kind: "pfx" });
  });

  test("with both, Artifact Signing wins", () => {
    assert.deepEqual(signing({ ...PFX, ...ARTIFACT_SIGNING }), { kind: "artifact-signing" });
  });

  test("Azure's own sign-in alone, as on a machine that uses Azure for something else, isn't Artifact Signing", () => {
    const { AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID } = ARTIFACT_SIGNING;
    assert.deepEqual(signing({ AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID }), { kind: "unsigned" });
  });

  test("some Artifact Signing secrets and not others name the missing ones, rather than quietly not signing", () => {
    const { AZURE_CLIENT_SECRET: _, AZURE_ARTIFACT_SIGNING_ENDPOINT: __, ...some } = ARTIFACT_SIGNING;
    assert.deepEqual(signing(some), {
      kind: "incomplete",
      missing: ["AZURE_CLIENT_SECRET", "AZURE_ARTIFACT_SIGNING_ENDPOINT"],
    });
  });

  test("a certificate without its password names the password", () => {
    assert.deepEqual(signing({ WINDOWS_CERTIFICATE: "MIIK" }), {
      kind: "incomplete",
      missing: ["WINDOWS_CERTIFICATE_PASSWORD"],
    });
  });

  test("a half-set Artifact Signing is named even when the PFX is complete", () => {
    assert.deepEqual(signing({ ...PFX, AZURE_ARTIFACT_SIGNING_ACCOUNT: "soundcheck" }).kind, "incomplete");
  });
});

describe("newestSdk", () => {
  test("picks the newest Windows 10 SDK by number, not by spelling", () => {
    assert.equal(newestSdk(["10.0.19041.0", "10.0.26100.0", "10.0.22621.0", "arm64", "x64"]), "10.0.26100.0");
    assert.equal(newestSdk(["10.0.9999.0", "10.0.10240.0"]), "10.0.10240.0");
  });

  test("is undefined when there is none", () => {
    assert.equal(newestSdk(["x86", "x64"]), undefined);
  });
});

describe("the commands", () => {
  test("Artifact Signing names the endpoint, account and profile, and leaves the credentials in the environment", () => {
    const { command, args } = artifactSigningCommand(ARTIFACT_SIGNING, "C:\\build\\Soundcheck.exe");
    assert.equal(command, "artifact-signing-cli");
    assert.deepEqual(args, [
      "-e",
      "https://weu.codesigning.azure.net",
      "-a",
      "soundcheck",
      "-c",
      "public",
      "-d",
      "Soundcheck",
      "C:\\build\\Soundcheck.exe",
    ]);
    assert.ok(!args.includes("secret"));
  });

  test("the PFX is signed with SHA-256 and an RFC 3161 timestamp", () => {
    const { command, args } = pfxCommand("C:\\sdk\\signtool.exe", "C:\\tmp\\cert.pfx", "hunter2", "C:\\build\\Soundcheck.exe", {});
    assert.equal(command, "C:\\sdk\\signtool.exe");
    assert.deepEqual(args, [
      "sign",
      "/fd",
      "SHA256",
      "/tr",
      "http://timestamp.digicert.com",
      "/td",
      "SHA256",
      "/f",
      "C:\\tmp\\cert.pfx",
      "/p",
      "hunter2",
      "/d",
      "Soundcheck",
      "C:\\build\\Soundcheck.exe",
    ]);
  });

  test("the timestamp server can be another", () => {
    const { args } = pfxCommand("signtool.exe", "cert.pfx", "pw", "a.exe", { WINDOWS_TIMESTAMP_URL: "http://ts.example.com" });
    assert.equal(args[args.indexOf("/tr") + 1], "http://ts.example.com");
  });
});

/** The script run with only what Node needs of the environment, so no secret of this machine's leaks in. */
function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", ...env },
  });
}

describe("the script", () => {
  test("with no secret, it leaves the file unsigned and succeeds, so the build goes on", () => {
    const result = run(["C:\\build\\Soundcheck.exe"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Not signing C:\\build\\Soundcheck\.exe: no Windows signing secret is set/);
  });

  test("--how says how it would sign", () => {
    assert.equal(run(["--how"]).stdout.trim(), "unsigned");
    assert.equal(run(["--how"], PFX).stdout.trim(), "pfx");
    assert.equal(run(["--how"], ARTIFACT_SIGNING).stdout.trim(), "artifact-signing");
  });

  test("--how fails on half-set secrets, so CI stops before the build rather than at the first file", () => {
    const result = run(["--how"], { AZURE_ARTIFACT_SIGNING_ACCOUNT: "soundcheck" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID/);
  });

  test("half-set secrets fail, naming what is missing and never a secret's value", () => {
    const result = run(["C:\\build\\Soundcheck.exe"], { WINDOWS_CERTIFICATE: "MIIK-the-certificate" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /WINDOWS_CERTIFICATE_PASSWORD/);
    assert.doesNotMatch(result.stdout + result.stderr, /MIIK-the-certificate/);
  });

  test("with no file, it says how it is used", () => {
    const result = run([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /node scripts\/sign-windows\.ts <file>/);
  });
});

describe("desktop/tauri.windows.conf.json", () => {
  const config = JSON.parse(readFileSync(resolve(DESKTOP, "tauri.windows.conf.json"), "utf8"));

  test("builds the NSIS installer", () => {
    assert.equal(config.bundle.active, true);
    assert.deepEqual(config.bundle.targets, ["nsis"]);
  });

  test("signs with this script, from desktop/, where Tauri runs it", () => {
    const { cmd, args } = config.bundle.windows.signCommand;
    assert.equal(cmd, "node");
    assert.equal(resolve(DESKTOP, args[0]), SCRIPT);
    assert.deepEqual(args.slice(1), ["%1"]);
  });
});

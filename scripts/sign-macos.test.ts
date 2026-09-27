/**
 * The macOS sign command's choice of how to sign and notarise, the
 * environment it gives Tauri for that, the script itself run with no secret
 * set, and the macOS bundle's config. `pnpm test` and CI run it:
 *
 *   node --test scripts/sign-macos.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { notarised, notarytoolCommand, signing, tauriEnv } from "./sign-macos.ts";

const SCRIPT = fileURLToPath(new URL("./sign-macos.ts", import.meta.url));
const DESKTOP = fileURLToPath(new URL("../desktop", import.meta.url));

const CERTIFICATE = { APPLE_CERTIFICATE: "MIIM", APPLE_CERTIFICATE_PASSWORD: "hunter2" };
const API_KEY = {
  APPLE_API_KEY: "ABC123DEFG",
  APPLE_API_ISSUER: "69a6de7e-0000-47e3-e053-5b8c7c11a4d1",
  APPLE_API_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nthe key\n-----END PRIVATE KEY-----\n",
};
const APPLE_ID = { APPLE_ID: "adrian@example.com", APPLE_PASSWORD: "abcd-efgh-ijkl-mnop", APPLE_TEAM_ID: "ABCDE12345" };

describe("signing", () => {
  test("with no secret, it signs ad hoc", () => {
    assert.deepEqual(signing({}), { kind: "ad-hoc" });
  });

  test("a secret GitHub doesn't have is an empty string, which is no secret", () => {
    const empty = Object.fromEntries(Object.keys({ ...CERTIFICATE, ...API_KEY, ...APPLE_ID }).map((name) => [name, ""]));
    assert.deepEqual(signing(empty), { kind: "ad-hoc" });
  });

  test("the certificate and an App Store Connect API key sign with the Developer ID and notarise with the key", () => {
    assert.deepEqual(signing({ ...CERTIFICATE, ...API_KEY }), { kind: "developer-id", notarise: "api-key" });
  });

  test("the key can be a file on this machine rather than its contents", () => {
    const { APPLE_API_PRIVATE_KEY: _, ...key } = API_KEY;
    assert.deepEqual(signing({ ...CERTIFICATE, ...key, APPLE_API_KEY_PATH: "/Users/adrian/AuthKey_ABC123DEFG.p8" }), {
      kind: "developer-id",
      notarise: "api-key",
    });
  });

  test("the certificate and an Apple ID notarise with the Apple ID", () => {
    assert.deepEqual(signing({ ...CERTIFICATE, ...APPLE_ID }), { kind: "developer-id", notarise: "apple-id" });
  });

  test("with both ways of notarising, the API key wins", () => {
    assert.deepEqual(signing({ ...CERTIFICATE, ...APPLE_ID, ...API_KEY }), { kind: "developer-id", notarise: "api-key" });
  });

  test("an identity already in this Mac's keychain stands in for the certificate", () => {
    const identity = { APPLE_SIGNING_IDENTITY: "Developer ID Application: Adrian Eyre (ABCDE12345)" };
    assert.deepEqual(signing({ ...identity, ...API_KEY }), { kind: "developer-id", notarise: "api-key" });
  });

  test("a certificate with no way to notarise is half a set: Gatekeeper refuses a Developer ID app that isn't notarised", () => {
    assert.deepEqual(signing(CERTIFICATE), {
      kind: "incomplete",
      missing: ["APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_PRIVATE_KEY"],
      or: ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"],
    });
  });

  test("a way to notarise with nothing to sign with names the certificate", () => {
    assert.deepEqual(signing(API_KEY), {
      kind: "incomplete",
      missing: ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD"],
    });
  });

  test("a certificate without its password names the password", () => {
    assert.deepEqual(signing({ APPLE_CERTIFICATE: "MIIM", ...API_KEY }), {
      kind: "incomplete",
      missing: ["APPLE_CERTIFICATE_PASSWORD"],
    });
  });

  test("half an API key names the rest of it, rather than falling back to ad hoc", () => {
    assert.deepEqual(signing({ ...CERTIFICATE, APPLE_API_KEY: "ABC123DEFG" }), {
      kind: "incomplete",
      missing: ["APPLE_API_ISSUER", "APPLE_API_PRIVATE_KEY"],
    });
  });

  test("half an Apple ID names the rest of it", () => {
    assert.deepEqual(signing({ ...CERTIFICATE, APPLE_ID: "adrian@example.com", APPLE_PASSWORD: "abcd" }), {
      kind: "incomplete",
      missing: ["APPLE_TEAM_ID"],
    });
  });

  test("half an Apple ID is named even when the API key is complete", () => {
    assert.equal(signing({ ...CERTIFICATE, ...API_KEY, APPLE_TEAM_ID: "ABCDE12345" }).kind, "incomplete");
  });
});

describe("tauriEnv", () => {
  const folder = "/tmp/soundcheck-sign-x";

  test("ad hoc drops the empty secrets Tauri would otherwise take for set, and leaves the rest alone", () => {
    const env = tauriEnv({ PATH: "/usr/bin", APPLE_CERTIFICATE: "", APPLE_ID: "" }, { kind: "ad-hoc" }, folder);
    assert.deepEqual(env.vars, { PATH: "/usr/bin" });
    assert.deepEqual(env.files, []);
  });

  test("a certificate with no identity named signs with it only if it is a Developer ID Application one", () => {
    const { vars } = tauriEnv({ ...CERTIFICATE, ...APPLE_ID }, { kind: "developer-id", notarise: "apple-id" }, folder);
    assert.equal(vars.APPLE_SIGNING_IDENTITY, "Developer ID Application");
  });

  test("a named identity is kept", () => {
    const identity = "Developer ID Application: Adrian Eyre (ABCDE12345)";
    const { vars } = tauriEnv(
      { ...CERTIFICATE, ...APPLE_ID, APPLE_SIGNING_IDENTITY: identity },
      { kind: "developer-id", notarise: "apple-id" },
      folder,
    );
    assert.equal(vars.APPLE_SIGNING_IDENTITY, identity);
  });

  test("the API key's contents become the file Tauri reads, named as Apple names it, and leave the environment", () => {
    const { vars, files } = tauriEnv({ ...CERTIFICATE, ...API_KEY }, { kind: "developer-id", notarise: "api-key" }, folder);
    assert.equal(vars.APPLE_API_KEY_PATH, join(folder, "AuthKey_ABC123DEFG.p8"));
    assert.equal(vars.APPLE_API_PRIVATE_KEY, undefined);
    assert.deepEqual(files, [{ path: join(folder, "AuthKey_ABC123DEFG.p8"), contents: API_KEY.APPLE_API_PRIVATE_KEY }]);
  });

  test("a key already in a file is used where it is", () => {
    const { APPLE_API_PRIVATE_KEY: _, ...key } = API_KEY;
    const { vars, files } = tauriEnv(
      { ...CERTIFICATE, ...key, APPLE_API_KEY_PATH: "/Users/adrian/AuthKey_ABC123DEFG.p8" },
      { kind: "developer-id", notarise: "api-key" },
      folder,
    );
    assert.equal(vars.APPLE_API_KEY_PATH, "/Users/adrian/AuthKey_ABC123DEFG.p8");
    assert.deepEqual(files, []);
  });

  test("when the API key wins, the Apple ID is taken away, since Tauri would otherwise prefer it", () => {
    const { vars } = tauriEnv({ ...CERTIFICATE, ...APPLE_ID, ...API_KEY }, { kind: "developer-id", notarise: "api-key" }, folder);
    assert.equal(vars.APPLE_ID, undefined);
    assert.equal(vars.APPLE_PASSWORD, undefined);
    assert.equal(vars.APPLE_TEAM_ID, undefined);
  });
});

describe("notarising the disk image", () => {
  const dmg = "target/release/bundle/dmg/Soundcheck_1.0.0_aarch64.dmg";

  test("with the API key, submits the file with the key's file, ID and issuer, and waits", () => {
    const vars = { APPLE_API_KEY: "ABC123DEFG", APPLE_API_ISSUER: "issuer", APPLE_API_KEY_PATH: "/tmp/k/AuthKey_ABC123DEFG.p8" };
    assert.deepEqual(notarytoolCommand(vars, "api-key", dmg), {
      command: "xcrun",
      args: [
        "notarytool",
        "submit",
        dmg,
        "--key",
        "/tmp/k/AuthKey_ABC123DEFG.p8",
        "--key-id",
        "ABC123DEFG",
        "--issuer",
        "issuer",
        "--wait",
        "--output-format",
        "json",
      ],
    });
  });

  test("with the Apple ID, submits it with the ID, its app-specific password and the team", () => {
    const { args } = notarytoolCommand(APPLE_ID, "apple-id", dmg);
    assert.deepEqual(args.slice(3, 9), ["--apple-id", "adrian@example.com", "--password", "abcd-efgh-ijkl-mnop", "--team-id", "ABCDE12345"]);
  });

  test("only Accepted is notarised", () => {
    assert.deepEqual(notarised('{"id":"2efe2717","status":"Accepted","message":"Processing complete"}\n'), {
      accepted: true,
      id: "2efe2717",
      status: "Accepted",
    });
    assert.deepEqual(notarised('{"id":"2efe2717","status":"Invalid","message":"Processing complete"}'), {
      accepted: false,
      id: "2efe2717",
      status: "Invalid",
    });
  });

  test("no answer at all isn't notarised", () => {
    assert.deepEqual(notarised(""), { accepted: false });
  });
});

/** The script run with only what Node needs of the environment, so no secret of this machine's leaks in. */
function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
}

describe("the script", () => {
  test("--how says how it would sign", () => {
    assert.equal(run(["--how"]).stdout.trim(), "ad-hoc");
    assert.equal(run(["--how"], { ...CERTIFICATE, ...API_KEY }).stdout.trim(), "developer-id");
  });

  test("--how fails on half-set secrets, so CI stops before the build", () => {
    const result = run(["--how"], CERTIFICATE);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_PRIVATE_KEY \(or APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID\)/);
  });

  test("runs the build with no secret, with the empty ones gone", () => {
    const folder = mkdtempSync(join(tmpdir(), "soundcheck-sign-test-"));
    try {
      const out = join(folder, "env.json");
      const print = `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`;
      const result = run(["--", process.execPath, "-e", print], { APPLE_CERTIFICATE: "", APPLE_ID: "" });
      assert.equal(result.status, 0, result.stderr);
      const env = JSON.parse(readFileSync(out, "utf8"));
      assert.equal("APPLE_CERTIFICATE" in env, false);
      assert.equal("APPLE_ID" in env, false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("passes on the build's exit status", () => {
    assert.equal(run(["--", process.execPath, "-e", "process.exit(3)"]).status, 3);
  });

  test("gives Tauri the API key as a file while the build runs, and deletes it after", () => {
    const folder = mkdtempSync(join(tmpdir(), "soundcheck-sign-test-"));
    try {
      const out = join(folder, "key.json");
      const print = `const p = process.env.APPLE_API_KEY_PATH; require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ p, key: require("fs").readFileSync(p, "utf8"), inEnv: "APPLE_API_PRIVATE_KEY" in process.env }))`;
      const result = run(["--", process.execPath, "-e", print], { ...CERTIFICATE, ...API_KEY });
      assert.equal(result.status, 0, result.stderr);
      const seen = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(seen.key, API_KEY.APPLE_API_PRIVATE_KEY);
      assert.equal(seen.inEnv, false);
      assert.equal(existsSync(seen.p), false, "the key is deleted after the build");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("half-set secrets fail before the build runs, naming what is missing and never a secret's value", () => {
    const result = run(["--", process.execPath, "-e", "console.log('built')"], { APPLE_CERTIFICATE: "MIIM-the-certificate" });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /built/);
    assert.match(result.stderr, /APPLE_CERTIFICATE_PASSWORD/);
    assert.doesNotMatch(result.stdout + result.stderr, /MIIM-the-certificate/);
  });

  test("--notarise does nothing, and succeeds, when the app is signed ad hoc", () => {
    const result = run(["--notarise", "Soundcheck.dmg"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Not notarising Soundcheck\.dmg: the app is signed ad hoc/);
  });

  test("--notarise fails on half-set secrets", () => {
    const result = run(["--notarise", "Soundcheck.dmg"], { APPLE_ID: "adrian@example.com" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_PASSWORD, APPLE_TEAM_ID/);
  });

  test("with no command, it says how it is used", () => {
    const result = run([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /node scripts\/sign-macos\.ts -- <command>/);
  });
});

/** The `<key>`s in a plist whose value is `<true/>`. */
function trueKeys(plist: string): string[] {
  return [...plist.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((match) => match[1]!);
}

describe("desktop/tauri.macos.conf.json", () => {
  const config = JSON.parse(readFileSync(resolve(DESKTOP, "tauri.macos.conf.json"), "utf8"));
  const macOS = config.bundle.macOS;

  test("builds the app and a disk image of it", () => {
    assert.equal(config.bundle.active, true);
    assert.deepEqual(config.bundle.targets, ["app", "dmg"]);
  });

  test("has a real .icns, so Tauri needn't make one from small PNGs", () => {
    const icns = config.bundle.icon.find((icon: string) => icon.endsWith(".icns"));
    assert.equal(readFileSync(resolve(DESKTOP, icns)).subarray(0, 4).toString("latin1"), "icns");
  });

  test("signs ad hoc unless the sign command names a Developer ID", () => {
    assert.equal(macOS.signingIdentity, "-");
  });

  test("runs under the hardened runtime, which notarisation requires, with the entitlements the app needs", () => {
    assert.equal(macOS.hardenedRuntime, true);
    const entitlements = readFileSync(resolve(DESKTOP, macOS.entitlements), "utf8");
    assert.deepEqual(trueKeys(entitlements).toSorted(), [
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.device.audio-input",
    ]);
  });

  test("asks for macOS 13.4, the oldest the linked ONNX Runtime was built for", () => {
    assert.equal(macOS.minimumSystemVersion, "13.4");
  });

  test("says why it wants the microphone, in the Info.plist Tauri merges in from desktop/", () => {
    const plist = readFileSync(resolve(DESKTOP, "Info.plist"), "utf8");
    assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
  });
});

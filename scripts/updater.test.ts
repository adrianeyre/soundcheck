/**
 * The updater's side of the build: when it signs the update packages, what
 * it gives `tauri build` for that, how a release's packages are checked and
 * announced, and the script itself run with no secret set. The signatures
 * are checked against a stand-in signed by a throwaway key, in `fixtures/`,
 * whose private half was deleted once it had signed. `pnpm test` and CI run
 * it:
 *
 *   node --test scripts/updater.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  bundlesHelper,
  CONFIG,
  cleanEnv,
  HELPER_SIDECAR,
  manifest,
  pair,
  placeHelper,
  PUBLIC_KEY,
  publicKey,
  release,
  signing,
  targets,
  targetTriple,
  tauriArgs,
  UPDATER_ARTIFACTS,
  verify,
} from "./updater.ts";

const SCRIPT = fileURLToPath(new URL("./updater.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A made-up public key: `tauri signer generate` makes one like it, base64 of minisign's two lines. */
const PUBKEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEYxQTQ1Mjc0RkE4RkEwMjcK";
const KEY = { TAURI_SIGNING_PRIVATE_KEY: "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg==" };
const PASSWORD = { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "hunter2" };

describe("signing", () => {
  test("with the key and the public key, the update packages are signed", () => {
    assert.deepEqual(signing(KEY, PUBKEY), { kind: "signed" });
    assert.deepEqual(signing({ ...KEY, ...PASSWORD }, PUBKEY), { kind: "signed" });
  });

  test("with neither, there are no update packages, and nothing fails", () => {
    assert.deepEqual(signing({}, ""), { kind: "unsigned", publicKey: false });
  });

  test("with the public key committed but no secret, as on a fork or a pull request, nothing fails either", () => {
    assert.deepEqual(signing({}, PUBKEY), { kind: "unsigned", publicKey: true });
  });

  test("a secret GitHub doesn't have is an empty string, which is no secret", () => {
    assert.deepEqual(signing({ TAURI_SIGNING_PRIVATE_KEY: "", TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" }, PUBKEY), {
      kind: "unsigned",
      publicKey: true,
    });
  });

  test("the key without the public key is half a set: the app couldn't check what it signs", () => {
    assert.deepEqual(signing(KEY, ""), { kind: "incomplete", missing: [PUBLIC_KEY] });
  });

  test("the password without the key is half a set", () => {
    assert.deepEqual(signing(PASSWORD, PUBKEY), { kind: "incomplete", missing: ["TAURI_SIGNING_PRIVATE_KEY"] });
  });
});

describe("publicKey", () => {
  test("is the updater plugin's pubkey, or empty when there is none", () => {
    assert.equal(publicKey(JSON.stringify({ plugins: { updater: { pubkey: ` ${PUBKEY}\n` } } })), PUBKEY);
    assert.equal(publicKey(JSON.stringify({ plugins: { updater: { pubkey: "" } } })), "");
    assert.equal(publicKey(JSON.stringify({})), "");
  });
});

describe("tauriArgs", () => {
  test("signed, the update packages are turned on for this build", () => {
    assert.deepEqual(tauriArgs([], { kind: "signed" }, false), ["build", "--config", UPDATER_ARTIFACTS]);
    assert.deepEqual(JSON.parse(UPDATER_ARTIFACTS), { bundle: { createUpdaterArtifacts: true } });
  });

  test("the build's own options are kept, and the config goes before anything meant for Cargo", () => {
    assert.deepEqual(tauriArgs(["--features", "asio", "--", "--locked"], { kind: "signed" }, false), [
      "build",
      "--features",
      "asio",
      "--config",
      UPDATER_ARTIFACTS,
      "--",
      "--locked",
    ]);
  });

  test("unsigned, it is the build as asked for", () => {
    assert.deepEqual(tauriArgs(["--features", "asio"], { kind: "unsigned", publicKey: true }, false), [
      "build",
      "--features",
      "asio",
    ]);
  });

  test("the VST3 helper is bundled as a sidecar, in the same config as the update packages", () => {
    const [, flag, config] = tauriArgs([], { kind: "signed" }, true);
    assert.equal(flag, "--config");
    assert.deepEqual(JSON.parse(config!), { bundle: { createUpdaterArtifacts: true, externalBin: [HELPER_SIDECAR] } });
    const [, , unsigned] = tauriArgs([], { kind: "unsigned", publicKey: false }, true);
    assert.deepEqual(JSON.parse(unsigned!), { bundle: { externalBin: [HELPER_SIDECAR] } });
  });
});

describe("the VST3 helper", () => {
  test("is bundled on Windows and Linux, and not yet on macOS", () => {
    assert.equal(bundlesHelper("win32"), true);
    assert.equal(bundlesHelper("linux"), true);
    assert.equal(bundlesHelper("darwin"), false);
  });

  test("is built for the build's own target, or else the host's", () => {
    const rustc = "rustc 1.95.0 (abc 2026-08-01)\nbinary: rustc\nhost: x86_64-pc-windows-msvc\nrelease: 1.95.0\n";
    assert.equal(targetTriple([], rustc), "x86_64-pc-windows-msvc");
    assert.equal(targetTriple(["--target", "aarch64-pc-windows-msvc"], rustc), "aarch64-pc-windows-msvc");
    assert.equal(targetTriple(["--target=aarch64-unknown-linux-gnu"], rustc), "aarch64-unknown-linux-gnu");
    assert.equal(targetTriple(["-t", "i686-pc-windows-msvc"], rustc), "i686-pc-windows-msvc");
    // What follows `--` is Cargo's.
    assert.equal(targetTriple(["--", "--target", "wasm32-unknown-unknown"], rustc), "x86_64-pc-windows-msvc");
    assert.equal(targetTriple([], ""), null);
  });

  test("is copied to the name Tauri reads, with the triple, or the build says to build it first", () => {
    const desktop = mkdtempSync(join(tmpdir(), "helper-"));
    try {
      const missing = placeHelper(desktop, "x86_64-pc-windows-msvc");
      assert.equal(missing.ok, false);
      assert.match(!missing.ok ? missing.why : "", /The VST3 helper isn't built .*run pnpm vst3:build first/);

      mkdirSync(join(desktop, "vst3-host/build/bin"), { recursive: true });
      writeFileSync(join(desktop, "vst3-host/build/bin/soundcheck-vst3-host.exe"), "windows helper");
      writeFileSync(join(desktop, "vst3-host/build/bin/soundcheck-vst3-host"), "linux helper");
      assert.deepEqual(placeHelper(desktop, "x86_64-pc-windows-msvc"), { ok: true });
      assert.deepEqual(placeHelper(desktop, "x86_64-unknown-linux-gnu"), { ok: true });
      const sidecar = join(desktop, HELPER_SIDECAR);
      assert.equal(readFileSync(`${sidecar}-x86_64-pc-windows-msvc.exe`, "utf8"), "windows helper");
      assert.equal(readFileSync(`${sidecar}-x86_64-unknown-linux-gnu`, "utf8"), "linux helper");
    } finally {
      rmSync(desktop, { recursive: true, force: true });
    }
  });

  test("its sidecar is in the build folder, which is never committed", () => {
    const ignored = spawnSync("git", ["check-ignore", "-q", `desktop/${HELPER_SIDECAR}-x86_64-pc-windows-msvc.exe`], { cwd: ROOT });
    assert.equal(ignored.status, 0);
    const config = JSON.parse(readFileSync(CONFIG, "utf8")) as { bundle: { externalBin?: string[] } };
    // Only the release build bundles it, so tauri dev and a macOS build don't need it.
    assert.equal(config.bundle.externalBin, undefined);
  });
});

describe("cleanEnv", () => {
  test("drops the empty variables Tauri would take for set, and keeps the rest", () => {
    assert.deepEqual(cleanEnv({ ...KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "", PATH: "/bin", GONE: undefined }), {
      ...KEY,
      PATH: "/bin",
    });
  });
});

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/updater/${name}`, import.meta.url));
const THROWAWAY = readFileSync(fixture("throwaway.pub"), "utf8");
const OTHER = readFileSync(fixture("other-throwaway.pub"), "utf8");
const STAND_IN = readFileSync(fixture("stand-in-installer.txt"));
/** Signed by the throwaway key for version 1.2.3. */
const SIGNATURE = readFileSync(fixture("stand-in-installer.txt.sig"), "utf8");

/** `signature` with the text of its trusted comment replaced. */
function retrusted(signature: string, from: string, to: string): string {
  return Buffer.from(Buffer.from(signature, "base64").toString("utf8").replace(from, to)).toString("base64");
}

describe("verify", () => {
  test("takes the file its key signed, and reads the version it was signed for", () => {
    assert.deepEqual(verify(THROWAWAY, STAND_IN, SIGNATURE), { ok: true, version: "1.2.3" });
  });

  test("turns away a file changed after it was signed", () => {
    const tampered = Buffer.concat([STAND_IN, Buffer.from("!")]);
    assert.deepEqual(verify(THROWAWAY, tampered, SIGNATURE), { ok: false, why: "the file isn't what was signed" });
  });

  test("turns away a signature by another key", () => {
    assert.deepEqual(verify(OTHER, STAND_IN, SIGNATURE), { ok: false, why: "it is signed by another key" });
  });

  test("turns away a version changed after it was signed", () => {
    const moved = retrusted(SIGNATURE, "version:1.2.3", "version:9.9.9");
    assert.deepEqual(verify(THROWAWAY, STAND_IN, moved), { ok: false, why: "its trusted comment isn't what was signed" });
  });

  test("turns away what isn't a signature or a key", () => {
    assert.deepEqual(verify(THROWAWAY, STAND_IN, "bm90IGEgc2lnbmF0dXJl"), { ok: false, why: "it isn't a minisign signature" });
    assert.deepEqual(verify("", STAND_IN, SIGNATURE), { ok: false, why: "the public key isn't a minisign key" });
  });
});

describe("targets", () => {
  test("names the platform each update package is for, as the updater looks it up", () => {
    assert.deepEqual(targets("Soundcheck_1.2.3_x64-setup.exe"), ["windows-x86_64-nsis", "windows-x86_64"]);
    assert.deepEqual(targets("Soundcheck_1.2.3_aarch64.app.tar.gz"), ["darwin-aarch64-app", "darwin-aarch64"]);
    assert.deepEqual(targets("Soundcheck_1.2.3_amd64.AppImage"), ["linux-x86_64-appimage", "linux-x86_64"]);
    assert.deepEqual(targets("Soundcheck_1.2.3_amd64.deb"), ["linux-x86_64-deb"]);
  });

  test("an installer the updater can't install is no update package", () => {
    assert.deepEqual(targets("Soundcheck_1.2.3_aarch64.dmg"), []);
    assert.deepEqual(targets("Soundcheck_1.2.3_x64-setup.exe.sig"), []);
  });
});

describe("pair", () => {
  test("finds the update packages, each with its signature", () => {
    assert.deepEqual(pair(["b.deb", "b.deb.sig", "a-setup.exe.sig", "a-setup.exe", "c.dmg"]), {
      packages: ["a-setup.exe", "b.deb"],
      problems: [],
    });
  });

  test("a package without its signature, or a signature without its package, is a problem", () => {
    assert.deepEqual(pair(["a-setup.exe", "b.deb.sig"]).problems, [
      "a-setup.exe has no signature.",
      "b.deb.sig signs no update package.",
    ]);
  });
});

describe("manifest", () => {
  const BASE = "https://github.com/adrianeyre/soundcheck/releases/download/v1.2.3/";
  const date = new Date("2026-09-26T12:00:00.123Z");

  test("announces the version, and each platform's package and signature", () => {
    const packages = [
      { file: "Soundcheck_1.2.3_x64-setup.exe", signature: "c2ln\n" },
      { file: "Soundcheck_1.2.3_amd64.deb", signature: "ZGVi" },
    ];
    assert.deepEqual(manifest("1.2.3", packages, BASE, "What's new", date), {
      version: "1.2.3",
      notes: "What's new",
      pub_date: "2026-09-26T12:00:00Z",
      platforms: {
        "windows-x86_64-nsis": { signature: "c2ln", url: `${BASE}Soundcheck_1.2.3_x64-setup.exe` },
        "windows-x86_64": { signature: "c2ln", url: `${BASE}Soundcheck_1.2.3_x64-setup.exe` },
        "linux-x86_64-deb": { signature: "ZGVi", url: `${BASE}Soundcheck_1.2.3_amd64.deb` },
      },
    });
  });

  test("two packages for one platform is a mistake", () => {
    const packages = [
      { file: "a-setup.exe", signature: "" },
      { file: "b-setup.exe", signature: "" },
    ];
    assert.throws(() => manifest("1.2.3", packages, BASE, "", date), /Two update packages for windows-x86_64-nsis/);
  });
});

describe("release", () => {
  let dir: string;
  const INSTALLER = "Soundcheck_1.2.3_x64-setup.exe";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soundcheck-release-"));
    copyFileSync(fixture("stand-in-installer.txt"), join(dir, INSTALLER));
    copyFileSync(fixture("stand-in-installer.txt.sig"), join(dir, `${INSTALLER}.sig`));
    writeFileSync(join(dir, "Soundcheck_1.2.3_aarch64.dmg"), "an installer, not an update package");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("takes the packages signed by the app's key for this version", () => {
    assert.deepEqual(release(dir, THROWAWAY, "1.2.3"), {
      kind: "signed",
      packages: [{ file: INSTALLER, signature: SIGNATURE }],
    });
  });

  test("turns away a package signed for another version, as the app would", () => {
    assert.deepEqual(release(dir, THROWAWAY, "1.2.4"), {
      kind: "problems",
      problems: [`${INSTALLER} is signed for version 1.2.3, not 1.2.4.`],
    });
  });

  test("turns away a package signed by a key the app doesn't have", () => {
    assert.deepEqual(release(dir, OTHER, "1.2.3"), {
      kind: "problems",
      problems: [`${INSTALLER}: it is signed by another key.`],
    });
  });

  test("with no key yet and nothing signed, there is nothing to announce", () => {
    rmSync(join(dir, `${INSTALLER}.sig`));
    assert.deepEqual(release(dir, "", "1.2.3"), { kind: "none" });
  });

  test("with the public key committed but nothing signed, the release has lost its key", () => {
    rmSync(join(dir, `${INSTALLER}.sig`));
    const found = release(dir, THROWAWAY, "1.2.3");
    assert.equal(found.kind, "problems");
    assert.match(found.kind === "problems" ? found.problems[0]! : "", /no package is signed: is TAURI_SIGNING_PRIVATE_KEY set/);
  });

  test("signed packages without the public key can't be checked", () => {
    assert.deepEqual(release(dir, "", "1.2.3"), {
      kind: "problems",
      problems: [`The packages are signed, but ${PUBLIC_KEY} isn't set.`],
    });
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
  test("--how with no secret says the packages are unsigned, and succeeds", () => {
    const result = run(["--how"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "unsigned");
  });

  test("--how fails on half a set, naming what is missing and never a value", () => {
    const result = run(["--how"], PASSWORD);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /TAURI_SIGNING_PRIVATE_KEY isn't set/);
    assert.doesNotMatch(result.stderr, /hunter2/);
  });

  test("anything else prints how to use it", () => {
    assert.equal(run([]).status, 2);
    assert.equal(run(["manifest"]).status, 2);
  });

  test("manifest, with no key yet and nothing signed, writes no latest.json and succeeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "soundcheck-release-"));
    try {
      writeFileSync(join(dir, "Soundcheck_0.1.0_x64-setup.exe"), "unsigned");
      const result = run(["manifest", dir, "https://example.com/"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /no latest\.json/);
      assert.throws(() => readFileSync(join(dir, "latest.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the build", () => {
  test("pnpm desktop:build goes through the script", () => {
    const scripts = (JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")) as { scripts: Record<string, string> })
      .scripts;
    assert.equal(scripts["desktop:build"], "node scripts/updater.ts build");
  });

  test("the config leaves the update packages off, so a build without the key doesn't fail", () => {
    const config = JSON.parse(readFileSync(CONFIG, "utf8")) as { bundle: { createUpdaterArtifacts?: boolean } };
    assert.notEqual(config.bundle.createUpdaterArtifacts, true);
  });
});

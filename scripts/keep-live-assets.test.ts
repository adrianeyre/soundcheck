/**
 * Keeping the live site's files in the next deploy, against a stand-in for
 * the site. `pnpm test` and CI run it:
 *
 *   node --test scripts/keep-live-assets.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { hashedNames, keepLiveAssets } from "./keep-live-assets.ts";

const folders: string[] = [];
after(() => folders.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** The live site: its files by path, everything else a 404. */
function site(files: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname.replace(/^\/soundcheck\//, "");
    const body = files[path];
    return body === undefined ? new Response("Not found", { status: 404 }) : new Response(body);
  }) as typeof fetch;
}

function dist(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "keep-live-"));
  folders.push(dir);
  mkdirSync(join(dir, "assets"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "assets", name), body);
  return dir;
}

const LIVE = {
  "index.html": '<script type="module" src="./assets/index-DHn1Xx_P.js"></script><link href="./assets/index-ekszGA7W.css">',
  "assets/index-DHn1Xx_P.js":
    'import(`./node.browser-CcY0RAP2.js`);new URL("soundcheck_engine_bg-D7kKR3v_.wasm",import.meta.url);new Worker(new URL("stem-worker-DWtuiXxF.js",import.meta.url))',
  "assets/index-ekszGA7W.css": "body{}",
  "assets/node.browser-CcY0RAP2.js": "export const fs = {};",
  "assets/soundcheck_engine_bg-D7kKR3v_.wasm": "\0asm",
  "assets/stem-worker-DWtuiXxF.js": 'new URL("ort-wasm-simd-threaded.jsep-MDYUKy93.wasm",import.meta.url)',
  "assets/ort-wasm-simd-threaded.jsep-MDYUKy93.wasm": "\0asm",
};

test("hashed file names are found in pages, scripts and stylesheets, and nothing else is", () => {
  assert.deepEqual(hashedNames(LIVE["assets/index-DHn1Xx_P.js"]), [
    "node.browser-CcY0RAP2.js",
    "soundcheck_engine_bg-D7kKR3v_.wasm",
    "stem-worker-DWtuiXxF.js",
  ]);
  assert.deepEqual(hashedNames(LIVE["assets/stem-worker-DWtuiXxF.js"]), ["ort-wasm-simd-threaded.jsep-MDYUKy93.wasm"]);
  assert.deepEqual(hashedNames("coi-serviceworker.js site.webmanifest icon-192.png"), []);
});

test("every file the live site's page reaches is kept beside the new build's, and the new build's own are left as they are", async () => {
  const to = dist({ "index-ekszGA7W.css": "the new build's", "index-NEWbuild.js": "new" });
  const { kept, missing } = await keepLiveAssets("https://example.com/soundcheck", to, site(LIVE));
  assert.deepEqual(kept.toSorted(), [
    "index-DHn1Xx_P.js",
    "node.browser-CcY0RAP2.js",
    "ort-wasm-simd-threaded.jsep-MDYUKy93.wasm",
    "soundcheck_engine_bg-D7kKR3v_.wasm",
    "stem-worker-DWtuiXxF.js",
  ]);
  assert.deepEqual(missing, []);
  assert.equal(readFileSync(join(to, "assets", "index-ekszGA7W.css"), "utf8"), "the new build's");
  assert.equal(readFileSync(join(to, "assets", "soundcheck_engine_bg-D7kKR3v_.wasm"), "utf8"), "\0asm");
});

test("a name the live site hasn't got is reported, and a site that can't be reached keeps nothing", async () => {
  const { ["assets/node.browser-CcY0RAP2.js"]: _, ...without } = LIVE;
  const to = dist();
  assert.deepEqual((await keepLiveAssets("https://example.com/soundcheck/", to, site(without))).missing, ["node.browser-CcY0RAP2.js"]);
  const none = dist();
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.deepEqual(await keepLiveAssets("https://example.com/", none, offline), { kept: [], missing: [] });
  assert.equal(existsSync(join(none, "assets", "index-DHn1Xx_P.js")), false);
});

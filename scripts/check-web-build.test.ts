/**
 * The web build check, on builds made for each test in a folder of their
 * own. `pnpm test` and CI run it:
 *
 *   node --test scripts/check-web-build.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { checkWebBuild } from "./check-web-build.ts";

const folders: string[] = [];
after(() => folders.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const MANIFEST = JSON.stringify({
  start_url: "./",
  scope: "./",
  icons: [{ src: "icon-192.png", sizes: "192x192", type: "image/png" }],
});

/** A build as Vite makes it with a relative base, with `files` added or replaced (null leaves one out). */
function build(files: Record<string, string | null> = {}): string {
  const dist = mkdtempSync(join(tmpdir(), "web-build-"));
  folders.push(dist);
  const all: Record<string, string | null> = {
    "index.html": `<!doctype html>
<html>
  <head>
    <link rel="canonical" href="https://example.com/soundcheck/" />
    <meta property="og:image" content="https://example.com/soundcheck/og-image.png" />
    <link rel="icon" href="./favicon.ico" />
    <link rel="manifest" href="./site.webmanifest" />
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-abc.css">
  </head>
  <body><div id="root"></div></body>
</html>
`,
    "site.webmanifest": MANIFEST,
    "favicon.ico": "",
    "icon-192.png": "",
    "assets/index-abc.js": 'const wasm = new URL(`engine-abc.wasm`, import.meta.url).href;',
    "assets/index-abc.css": "body{}",
    "assets/engine-abc.wasm": "",
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    if (contents === null) continue;
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), contents);
  }
  return dist;
}

test("a build that names everything relatively, and has it all, passes", () => {
  assert.deepEqual(checkWebBuild(build()), []);
});

test("there must be a build", () => {
  const dist = build({ "index.html": null });
  assert.deepEqual(checkWebBuild(dist), [`${join(dist, "index.html")} is missing: run the app's build first`]);
});

test("index.html may not name a file from the host's root, which a sub-path breaks", () => {
  const problems = checkWebBuild(
    build({
      "index.html": `<link rel="icon" href="/favicon.ico" /><script type="module" src="/assets/index-abc.js"></script>`,
    }),
  );
  assert.deepEqual(problems, [
    "index.html names /favicon.ico from the host's root, so it breaks under a sub-path; build with a relative base",
    "index.html names /assets/index-abc.js from the host's root, so it breaks under a sub-path; build with a relative base",
  ]);
});

test("index.html's own files must be in the build; other sites' needn't be", () => {
  const problems = checkWebBuild(build({ "favicon.ico": null }));
  assert.deepEqual(problems, ["index.html names ./favicon.ico, which isn't in the build"]);
});

test("a protocol-relative URL is another site's, not the host's root", () => {
  assert.deepEqual(checkWebBuild(build({ "index.html": `<script src="//cdn.example.com/x.js"></script>` })), []);
});

test("the web app manifest's start, scope and icons are relative, and its icons are there", () => {
  const problems = checkWebBuild(
    build({
      "site.webmanifest": JSON.stringify({
        start_url: "/",
        scope: "/",
        icons: [{ src: "/icon-192.png" }, { src: "icon-512.png" }],
      }),
    }),
  );
  assert.deepEqual(problems, [
    "site.webmanifest's start_url is / from the host's root, so it breaks under a sub-path",
    "site.webmanifest's scope is / from the host's root, so it breaks under a sub-path",
    "site.webmanifest's icon /icon-192.png is from the host's root, so it breaks under a sub-path",
    "site.webmanifest's icon icon-512.png isn't in the build",
  ]);
});

test("the scripts may not load assets from the host's root", () => {
  const problems = checkWebBuild(build({ "assets/index-abc.js": 'fetch("/assets/engine-abc.wasm")' }));
  assert.deepEqual(problems, [
    "assets/index-abc.js loads /assets/ from the host's root, so it breaks under a sub-path; build with a relative base",
  ]);
});

test("the build may not have a model in it, whose weights mustn't be published", () => {
  assert.deepEqual(checkWebBuild(build({ "model/htdemucs.onnx": "weights" })), [
    "model/htdemucs.onnx is a model in the build: its weights mustn't be published (ADR 0005), so keep it out of app/public",
  ]);
  assert.equal(checkWebBuild(build({ "assets/other.ONNX": "" })).length, 1);
});

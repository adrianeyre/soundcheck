/**
 * Cross-origin isolation for the Browser Version, so WebAssembly has threads
 * and Stem Separation a CPU fallback fast enough for browsers without WebGPU
 * (ADR 0006).
 *
 * GitHub Pages can't send the COOP and COEP headers isolation needs, so
 * [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT,
 * Guido Zuidhof and contributors) adds them from a service worker: the first
 * visit registers it and reloads once, and every visit after is isolated. The
 * page loads nothing cross-origin but CORS requests (the Assistant's
 * providers), so the headers break nothing it uses.
 *
 * The same build runs in the Desktop App's window, which needs no isolation
 * of this kind and must not have a service worker, so the page skips it there.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { HtmlTagDescriptor, Plugin } from "vite";

/** Where the worker is served, beside `index.html`: its scope is the folder it's in. */
export const SERVICE_WORKER_FILE = "coi-serviceworker.js";

/** Before the worker script runs: register it everywhere but the Desktop App. */
export const CONFIG_SCRIPT =
  'window.coi = { shouldRegister: function () { return !("__TAURI_INTERNALS__" in window); }, quiet: true };';

/** The tags `index.html` gets, first in its head, so isolation starts before the app loads. */
export function isolationTags(): HtmlTagDescriptor[] {
  return [
    { tag: "script", children: CONFIG_SCRIPT, injectTo: "head-prepend" },
    // A classic script with a `src`, not a module: the worker registers itself by its own URL.
    { tag: "script", attrs: { src: SERVICE_WORKER_FILE }, injectTo: "head-prepend" },
  ];
}

function serviceWorkerSource(): string {
  return readFileSync(createRequire(import.meta.url).resolve("coi-serviceworker/coi-serviceworker.min.js"), "utf8");
}

/** Puts coi-serviceworker in the build and the dev server, and loads it from `index.html`. */
export function crossOriginIsolation(): Plugin {
  return {
    name: "soundcheck-cross-origin-isolation",
    transformIndexHtml: () => isolationTags(),
    configureServer(server) {
      server.middlewares.use(`/${SERVICE_WORKER_FILE}`, (_request, response) => {
        response.setHeader("Content-Type", "text/javascript");
        response.end(serviceWorkerSource());
      });
    },
    generateBundle() {
      // Not hashed: a service worker has to keep its URL for the browser to update it.
      this.emitFile({ type: "asset", fileName: SERVICE_WORKER_FILE, source: serviceWorkerSource() });
    },
  };
}

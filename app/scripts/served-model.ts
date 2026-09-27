/**
 * The repo's `model/htdemucs.onnx`, which `pnpm htdemucs:export` writes, served
 * beside the page by `pnpm dev` and `vite preview`, so the Browser Version
 * finds and installs it without asking (`fetchServedModel`).
 *
 * Only the local dev and preview servers serve it. It is never in the build,
 * so never on GitHub Pages: the weights are for personal use only and mustn't
 * be published (ADR 0005), and `scripts/check-web-build.ts` fails a build
 * that has any `.onnx` in it.
 */
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

/** Where the page asks for it: `SERVED_MODEL` in `browser-stem-separator.ts`. */
const URL_PATH = "/model/htdemucs.onnx";

/** The repo's `model/htdemucs.onnx`. */
export const REPO_MODEL = fileURLToPath(new URL("../../model/htdemucs.onnx", import.meta.url));

/** Answer a request for the model with the file at `file`, or pass it on when there's none. */
export function serveModel(file: string) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const size = (() => {
      try {
        const stats = statSync(file);
        return stats.isFile() ? stats.size : null;
      } catch {
        return null;
      }
    })();
    if (size === null || (request.method !== "GET" && request.method !== "HEAD")) return next();
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Length", size);
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "HEAD") return response.end();
    createReadStream(file).pipe(response);
  };
}

export function servedModel(file = REPO_MODEL): Plugin {
  return {
    name: "soundcheck-served-model",
    configureServer(server) {
      server.middlewares.use(URL_PATH, serveModel(file));
    },
    configurePreviewServer(server) {
      server.middlewares.use(URL_PATH, serveModel(file));
    },
  };
}

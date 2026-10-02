import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

import { crossOriginIsolation } from "./scripts/cross-origin-isolation.ts";
import { servedModel } from "./scripts/served-model.ts";

// `@engine` is the wasm-pack output of the Rust Audio Engine. `pnpm engine:build`
// at the repo root writes it; it is generated, not committed.
const enginePackage = fileURLToPath(
  new URL("../engine/pkg/soundcheck_engine.js", import.meta.url),
);

// The version the footer shows, and the author the Credits name, are the repository's own.
const { version, author } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  author: string;
};

/**
 * Where the web build is hosted. Share previews (Slack, Teams, LinkedIn, X)
 * and search engines need absolute URLs for the page and its image, so a
 * deploy elsewhere sets `VITE_SITE_URL` (`VITE_SITE_URL=https://… pnpm build`).
 */
process.env.VITE_SITE_URL ||= "https://adrianeyre.github.io/soundcheck";

/** The dev server's port. Tauri's `devUrl` names it too, so it must not drift. */
const PORT = 5145;

/**
 * `robots.txt` and `sitemap.xml`, which must name the site by its absolute
 * URL: `VITE_SITE_URL`, the same one `index.html`'s share tags use.
 */
function crawlerFiles(): Plugin {
  let site = "";
  return {
    name: "soundcheck-crawler-files",
    configResolved(config) {
      site = (loadEnv(config.mode, config.envDir || config.root, "VITE_").VITE_SITE_URL ?? "").replace(/\/$/, "");
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: `User-agent: *\nAllow: /\n${site ? `\nSitemap: ${site}/sitemap.xml\n` : ""}`,
      });
      if (!site) return;
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${site}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>
</urlset>
`,
      });
    },
  };
}

/**
 * Each production build's id, in the page (`VITE_BUILD_ID`) and in
 * `version.json` beside `index.html`, so a page left open across a deploy
 * can tell it has been replaced (`src/update/new-deploy.ts`). The commit CI
 * built, or when it was built elsewhere. Not under `pnpm dev` or the tests,
 * which have no `version.json` to compare with.
 */
function deployStamp(): Plugin {
  const build = process.env.GITHUB_SHA || `local-${Date.now()}`;
  return {
    name: "soundcheck-deploy-stamp",
    config: (_, { command }) => (command === "build" ? { define: { "import.meta.env.VITE_BUILD_ID": JSON.stringify(build) } } : {}),
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ build, version })}\n` });
    },
  };
}

export default defineConfig({
  // Relative, so the one build works in the Desktop App's window at `/` and
  // as the Browser Version under a sub-path such as GitHub Pages'
  // `/soundcheck/` (ADR 0006). The pages are `#` routes, so no path needs a
  // server's rewrite. `scripts/check-web-build.ts` keeps it so.
  base: "./",
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(version),
    "import.meta.env.VITE_APP_AUTHOR": JSON.stringify(author),
  },
  plugins: [react(), crawlerFiles(), crossOriginIsolation(), servedModel(), deployStamp()],
  resolve: {
    alias: { "@engine": enginePackage },
  },
  // The AudioWorklet processor is bundled as a module: addModule() loads ES
  // modules, and the engine's glue uses import.meta.
  worker: { format: "es" },
  server: {
    port: PORT,
    strictPort: true,
    fs: { allow: [".."] },
  },
  preview: {
    port: PORT,
    strictPort: true,
  },
  test: {
    environment: "node",
    // The Song page tests draw the whole Editor, every Widget on it, many times over. Alone each takes one
    // or two seconds; on a busy CI runner, with every test file running at once, five was too tight.
    testTimeout: 15_000,
  },
});

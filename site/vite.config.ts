import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Where the website is hosted: the root of the GitHub Pages site, with the
 * Browser Version under `app/` (ADR 0017). The share tags, `robots.txt` and
 * the sitemap need it absolute; CI sets it from what Pages reports.
 */
process.env.VITE_SITE_URL ||= "https://adrianeyre.github.io/soundcheck";

/** `robots.txt` and `sitemap.xml` for the whole Pages site: this page and the Browser Version's. */
function crawlerFiles(): Plugin {
  let site = "";
  return {
    name: "soundcheck-site-crawler-files",
    configResolved(config) {
      site = (loadEnv(config.mode, config.envDir || config.root, "VITE_").VITE_SITE_URL ?? "").replace(/\/$/, "");
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "robots.txt", source: `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n` });
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${site}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>
  <url><loc>${site}/app/</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
</urlset>
`,
      });
    },
  };
}

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/**
 * `version.json` at the root, where the Browser Version used to write its own
 * (ADR 0016). A Browser Version page opened there before the move, and still
 * open, reads it, sees a build that isn't its own and offers Reload; the
 * reload lands here with its `#` route, and `forward.ts` sends it on to `app/`.
 */
function deployStamp(): Plugin {
  const build = `website-${process.env.GITHUB_SHA || Date.now()}`;
  return {
    name: "soundcheck-site-deploy-stamp",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ build, version })}\n` });
    },
  };
}

export default defineConfig({
  // Relative, like the app's, so the build works under any sub-path.
  base: "./",
  plugins: [react(), crawlerFiles(), deployStamp()],
  server: { port: 5146, strictPort: true },
  preview: { port: 5146, strictPort: true },
  test: { environment: "node" },
});

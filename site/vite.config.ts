import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer, loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

import { robotsTxt, siteAddress, sitemapXml, withPrerendered } from "./seo.ts";

/**
 * Where the website is hosted: the root of the GitHub Pages site, with the
 * Browser Version under `app/` (ADR 0017). The share tags, `robots.txt` and
 * the sitemap need it absolute; CI sets it from what Pages reports.
 */
process.env.VITE_SITE_URL = siteAddress(process.env.VITE_SITE_URL || "https://soundcheck.adrianeyre.co.uk");

/** `robots.txt` and `sitemap.xml` for the whole Pages site: this page and the Browser Version's. */
function crawlerFiles(): Plugin {
  let site = "";
  return {
    name: "soundcheck-site-crawler-files",
    configResolved(config) {
      site = siteAddress(loadEnv(config.mode, config.envDir || config.root, "VITE_").VITE_SITE_URL ?? "");
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robotsTxt(site) });
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemapXml(site, new Date()) });
    },
  };
}

/**
 * The page drawn into the built `index.html`, so a search engine, or an AI
 * crawler, that doesn't run the script still reads every heading and word,
 * and the first paint doesn't wait for it. `main.tsx` hydrates it.
 */
function prerender(): Plugin {
  let root = "";
  let outDir = "";
  return {
    name: "soundcheck-site-prerender",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      // Its own server, without this config's plugins, so it doesn't build again.
      const server = await createServer({
        root,
        configFile: false,
        plugins: [react()],
        logLevel: "error",
        appType: "custom",
        server: { middlewareMode: true, hmr: false, ws: false },
      });
      try {
        const { App } = (await server.ssrLoadModule("/src/App.tsx")) as typeof import("./src/App");
        const markup = renderToString(createElement(App));
        const index = resolve(outDir, "index.html");
        writeFileSync(index, withPrerendered(readFileSync(index, "utf8"), markup));
      } finally {
        await server.close();
      }
    },
  };
}

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/** The release, for the structured data in `index.html`. */
process.env.VITE_APP_VERSION = version;

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
  plugins: [react(), crawlerFiles(), prerender(), deployStamp()],
  server: { port: 5146, strictPort: true },
  preview: { port: 5146, strictPort: true },
  test: { environment: "node" },
});

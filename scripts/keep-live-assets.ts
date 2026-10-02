/**
 * Keep the live site's files in the next deploy of the Browser Version. A
 * GitHub Pages deploy replaces the whole site, and every build's files are
 * named by their hash, so a page opened before a deploy, still open after
 * it, asks for its engine's WASM or a lazily loaded chunk and gets a 404:
 * the Mixer page's engine, say, which loads only when audio starts. CI runs
 * this between the build and the upload:
 *
 *   node scripts/keep-live-assets.ts <site URL> [dist]
 *
 * It reads the live `index.html`, follows every hashed file it names, and
 * the files those name, and copies each one the new build lacks into its
 * `assets/`. The previous deploy's files are then still there, beside the
 * new ones, so a page left open keeps working until it reloads; the page
 * also says when there is a newer version (`app/src/update/new-deploy.ts`).
 * Only one deploy back is kept: the next deploy keeps this one's, not the
 * one before. A site that can't be reached, as on a first deploy, keeps
 * nothing and fails nothing.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A file of a build, by its name as Vite hashes it: `index-DHn1Xx_P.js`, `ort-wasm-simd-threaded.jsep-MDYUKy93.wasm`. */
const HASHED = /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)*-[A-Za-z0-9_-]{8}\.(?:js|mjs|css|wasm|woff2?|ttf|png|svg|jpe?g|webp)(?![A-Za-z0-9])/g;

/** Never more than this much kept, in case a site serves something unexpected. */
export const MAX_BYTES = 256 * 1024 * 1024;

/** The hashed files `text` (an HTML page, a script or a stylesheet) names. */
export function hashedNames(text: string): string[] {
  return [...new Set(text.match(HASHED) ?? [])];
}

/** Whether a file named so is one to read for the names of more. */
const readable = (name: string) => /\.(?:m?js|css)$/.test(name);

export interface Kept {
  kept: string[];
  /** Files the live site names but doesn't have, or that couldn't be fetched. */
  missing: string[];
}

/** Copies the live site's hashed files that `dist/assets` lacks into it. */
export async function keepLiveAssets(site: string, dist: string, fetchFn: typeof fetch = fetch): Promise<Kept> {
  const base = site.endsWith("/") ? site : `${site}/`;
  const assets = join(dist, "assets");
  const result: Kept = { kept: [], missing: [] };
  const index = await fetchFn(new URL("index.html", base), { cache: "no-store" }).catch(() => null);
  if (!index?.ok) return result;
  const queue = hashedNames(await index.text());
  const seen = new Set(queue);
  let bytes = 0;
  while (queue.length > 0) {
    const name = queue.shift()!;
    const response = await fetchFn(new URL(`assets/${name}`, base)).catch(() => null);
    if (!response?.ok) {
      result.missing.push(name);
      continue;
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (readable(name)) {
      for (const next of hashedNames(new TextDecoder().decode(body))) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    const to = join(assets, name);
    if (existsSync(to)) continue;
    bytes += body.byteLength;
    if (bytes > MAX_BYTES) throw new Error(`The live site's files come to more than ${MAX_BYTES} bytes; kept none past ${name}.`);
    mkdirSync(assets, { recursive: true });
    writeFileSync(to, body);
    result.kept.push(name);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [site, dist = "app/dist"] = process.argv.slice(2);
  if (!site) {
    console.error("Usage: node scripts/keep-live-assets.ts <site URL> [dist]");
    process.exit(2);
  }
  try {
    const { kept, missing } = await keepLiveAssets(site, resolve(dist));
    console.log(kept.length > 0 ? `Kept ${kept.length} of the live site's files: ${kept.join(", ")}` : "Kept none of the live site's files.");
    // The site names a file it hasn't got: one a lazily loaded name matched by chance, or one already gone.
    if (missing.length > 0) console.log(`Not on the live site: ${missing.join(", ")}`);
  } catch (error) {
    // Keeping them is a courtesy to pages left open: a deploy goes on without it.
    console.log(`::warning title=Live files not kept::${error instanceof Error ? error.message : String(error)}`);
  }
}

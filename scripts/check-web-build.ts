/**
 * Check that the web build in `app/dist` works from any folder of a site,
 * not only its root (ADR 0006). The Browser Version is served from a
 * sub-path (`/soundcheck/` on GitHub Pages) and the Desktop App's window
 * from `/`, so the one build must name all its own files relatively.
 * `pnpm build` and CI run it after the app's build:
 *
 *   node scripts/check-web-build.ts [dist]
 *
 * It reads `index.html`'s `src` and `href`s, the web app manifest it links
 * and the built scripts: each file named from the host's root (`/…`) is a
 * problem, and so is each relative one missing from the build. So is any
 * `.onnx` model in it: htdemucs' weights are for personal use only and must
 * never be deployed (ADR 0005).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A URL of another site (`https:`, `data:`, `//host`) or a fragment, which the build needn't have. */
function external(url: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);
}

function fromRoot(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

/** Where a relative `url`, named by the file at `from` in the build, is in it. */
function inBuild(dist: string, from: string, url: string): string {
  const path = posix.normalize(posix.join(posix.dirname(from), url.split(/[?#]/)[0]!));
  return join(dist, path === "." ? "index.html" : path);
}

/** What is wrong with the web build in `dist`: one line each, or none. */
export function checkWebBuild(dist: string): string[] {
  const index = join(dist, "index.html");
  if (!existsSync(index)) return [`${index} is missing: run the app's build first`];

  const problems: string[] = [];
  const html = readFileSync(index, "utf8");
  for (const [, url] of html.matchAll(/\s(?:src|href)="([^"]*)"/g)) {
    if (external(url!)) continue;
    if (fromRoot(url!)) {
      problems.push(`index.html names ${url} from the host's root, so it breaks under a sub-path; build with a relative base`);
    } else if (!existsSync(inBuild(dist, "index.html", url!))) {
      problems.push(`index.html names ${url}, which isn't in the build`);
    }
  }

  const link = /<link[^>]*\srel="manifest"[^>]*>/.exec(html)?.[0];
  const manifestUrl = link && /\shref="([^"]*)"/.exec(link)?.[1];
  if (manifestUrl && !fromRoot(manifestUrl) && !external(manifestUrl)) {
    problems.push(...checkManifest(dist, posix.normalize(manifestUrl)));
  }

  for (const path of readdirSync(dist, { recursive: true, encoding: "utf8" })) {
    if (/\.onnx$/i.test(path)) {
      problems.push(`${path.replaceAll("\\", "/")} is a model in the build: its weights mustn't be published (ADR 0005), so keep it out of app/public`);
    }
  }

  const assets = join(dist, "assets");
  const scripts = existsSync(assets) ? readdirSync(assets).filter((name) => name.endsWith(".js")) : [];
  for (const name of scripts) {
    if (/["'`]\/assets\//.test(readFileSync(join(assets, name), "utf8"))) {
      problems.push(`assets/${name} loads /assets/ from the host's root, so it breaks under a sub-path; build with a relative base`);
    }
  }
  return problems;
}

interface Manifest {
  start_url?: string;
  scope?: string;
  icons?: { src: string }[];
}

/** The manifest at `path` in the build. Its URLs are relative to where it is, not to the page. */
function checkManifest(dist: string, path: string): string[] {
  const file = join(dist, path);
  if (!existsSync(file)) return [`index.html links the web app manifest ${path}, which isn't in the build`];
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  const problems: string[] = [];
  for (const key of ["start_url", "scope"] as const) {
    const url = manifest[key];
    if (url && fromRoot(url)) problems.push(`${path}'s ${key} is ${url} from the host's root, so it breaks under a sub-path`);
  }
  for (const { src } of manifest.icons ?? []) {
    if (external(src)) continue;
    if (fromRoot(src)) problems.push(`${path}'s icon ${src} is from the host's root, so it breaks under a sub-path`);
    else if (!existsSync(inBuild(dist, path, src))) problems.push(`${path}'s icon ${src} isn't in the build`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? fileURLToPath(new URL("../app/dist", import.meta.url)));
  const problems = checkWebBuild(dist);
  if (problems.length > 0) {
    console.error(`The web build must work from any folder of a site, and publish no model:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("The web build names all its own files relatively, and has them all.");
}

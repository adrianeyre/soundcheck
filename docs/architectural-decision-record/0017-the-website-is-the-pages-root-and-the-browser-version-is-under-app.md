# The website is the root of GitHub Pages, and the Browser Version is under `app/`

**Status: proposed** in the pull request that adds the website.

Until now the **Browser Version** was the whole GitHub Pages site ([ADR 0006](0006-a-browser-version-beside-the-desktop-app.md)): `https://adrianeyre.github.io/soundcheck/` opened the Editor. Someone sent that link learnt nothing about Soundcheck before they were in a DAW with an empty song, and there was nowhere to download the Desktop App from but the GitHub Releases page.

## Decision

**A website at the root.** `site/` is a small React page of its own (`pnpm site:dev`): what Soundcheck is, its features, the downloads for Windows, macOS and Linux (each the latest GitHub Release), and a link into the Browser Version. Its illustrations are faux product UI drawn with the [Stageshow](https://github.com/benjitaylor/skills/tree/main/stageshow) kit (MIT), vendored unchanged in `site/src/kit/`, in Soundcheck's own colours. They are illustrations, not screenshots, so they stay readable at any width and don't go stale with every change to the UI. The README carries real screenshots.

**The Browser Version under `app/`.** CI's `web` job builds both and deploys one Pages artifact, the website's `dist` at the root and the app's at `app/`. The app is built with `VITE_SITE_URL` ending `/app`, so its share tags, its invite links and the Desktop App's point there. The website writes the site's `robots.txt` and sitemap, which name both.

**Old addresses keep working.** The app's pages are `#` routes, so a bookmark (`…/soundcheck/#settings`) or an invite link made before the move (`…/soundcheck/#live=…`, which older Desktop Apps go on making) reaches the website. Before it draws anything, the website sends any of the app's routes on to `app/` with the same hash (`site/src/forward.ts`). The website's own anchors (`#features`, `#download`) aren't app routes.

**Pages opened before the move.** The deploy keeps the live site's hashed files in both places (`scripts/keep-live-assets.ts`, [ADR 0016](0016-a-deploy-keeps-the-previous-deploys-files.md)): at `app/` for the Browser Version now, and at the root for an app page still open from before. The website writes a `version.json` at the root too, so that page sees a build that isn't its own and offers Reload; the reload is forwarded to `app/`.

**The old service worker.** The Browser Version registered coi-serviceworker at the root to make itself cross-origin isolated. A browser that visited before still has it, and it would put the website under COEP. The website ships a `coi-serviceworker.js` in its place that unregisters itself and reloads the pages it controlled once. The app registers its own under `app/`, as before.

## Consequences

- The site's address is the website, not the Editor. `https://adrianeyre.github.io/soundcheck/app/` is the Browser Version's.
- The origin doesn't change, so the Browser Version keeps what it had stored in this browser: the Assistant's key, Presets, the installed Stem Separation model, its folders.
- The first visit after the move from a browser that had the old service worker reloads once more.
- The website doesn't need the engine. CI checks it in a `site` job of its own, and `pnpm typecheck`, `pnpm test` and `pnpm build` cover it.
- A newer Stageshow kit is copied over `site/src/kit/` whole. It isn't linted (`.oxlintrc.json`), as it isn't ours.

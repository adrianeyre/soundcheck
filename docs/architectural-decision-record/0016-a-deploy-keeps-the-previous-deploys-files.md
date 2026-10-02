# A deploy of the Browser Version keeps the previous deploy's files, and an open page offers to reload

**Status: proposed** in the pull request that adds it.

The **Browser Version** is deployed to GitHub Pages on every push to `main` ([ADR 0006](0006-a-browser-version-beside-the-desktop-app.md)). Vite names every file of a build by its hash (`soundcheck_engine_bg-D7kKR3v_.wasm`), and a Pages deploy replaces the whole site, so each deploy deletes the last one's files. A page opened before a deploy keeps running the old build. The parts it loads later then 404: the engine's WASM when audio starts (the Mixer page's Decks, the Track browser's analysis), a lazily loaded chunk, the Stem Separation worker. The musician sees "Failed to load" with no way out but a reload they aren't told to make. That happened on the Mixer page after the 1.7.0 deploy.

## Decision

**The deploy keeps one deploy back.** Between the build and the upload, `scripts/keep-live-assets.ts` reads the live `index.html` and follows every hashed file it names, and those files name in turn: the scripts, the stylesheet, the engine's WASM, the workers, ONNX Runtime's WASM. It copies each file the new build lacks into its `assets/`. A page from the previous deploy then finds all its files. Only one deploy back is kept, since the next deploy keeps this one's and not the one before; a page open across two deploys reloads. A site that can't be reached (a first deploy, say) keeps nothing and fails nothing.

**An open page knows when it is out of date.** Each production build writes its id (the commit CI built) into the page and into `version.json` beside `index.html`. The page reads that file, past every cache, when it starts, when it is shown again, every ten minutes, and at once when a file fails to load. That covers a dynamic import Vite reports (`vite:preloadError`), an error that reads as a missing file, and the engine's own loading, which reports what it catches. When the ids differ, or a file failed, a notice says a newer version is out and offers **Reload**, or Later. The Desktop App serves its page from inside itself and has its own Updates ([ADR 0011](0011-the-desktop-app-updates-itself-from-the-latest-github-release.md)), so none of this runs there.

**No service worker cache.** A service worker could keep every build's files in the browser and make the site work offline, but the page already has one, coi-serviceworker, for cross-origin isolation. Making it a cache would change what every request returns and how updates arrive. That is left for later.

## Consequences

- The site carries two builds' files, about 15 MB rather than 7.
- A page open across two deploys can still fail; it then says why and reloads.
- `pnpm dev` and the tests have no `version.json`, so they never show the notice.

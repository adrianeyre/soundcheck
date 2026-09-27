# Soundcheck ships a Browser Version too: the Desktop App stays the low-latency one

**Status: proposed** in the v4 pull request (#67). It amends [ADR 0002](0002-mvp-is-a-desktop-app.md); it does not reverse it. The maintainer has chosen to ship both; what they still have to confirm is under [To confirm](#to-confirm).

ADR 0002 made the MVP a **Desktop App** because the browser failed Milestone 0's latency test (80 ms key-to-sound against a limit of 20 ms), and left a browser build to "consider later" ([v4](../product-requirements-document/v4.md)). That measurement stands, and nothing here makes the browser faster. What has changed is what the browser is for: the **Audio Engine** already builds to WASM for `pnpm dev` ([ADR 0001](0001-audio-engine-in-rust.md)), and every platform-dependent part of the app is already behind an interface in `app/src/platform.ts` with a browser implementation or a plain "needs the desktop app". So a **Browser Version** costs one deploy, and gives a way to try Soundcheck, or open a Project on a machine without it, with nothing to install.

## Decision

**Ship both.** The **Desktop App** (Windows first, then macOS and Linux) is the product for making music: low latency, recording, and later **VST3 Plugins** and **Stem Separation**. *Amended 2026-09-27:* the Browser Version separates Stems too, where the browser can ([below](#amended-2026-09-27-stem-separation)). The **Browser Version** is the lighter one: the same UI, the same Audio Engine and the same **Project** format, on the browser's own audio path.

**One build, both targets.** The Browser Version is `app/`'s production build (`pnpm build`), the same one the Desktop App bundles. Vite builds it with a relative base (`base: "./"` in `app/vite.config.ts`), and the app's pages are `#` routes, so the one `app/dist` works in the Tauri window at `/` and on a static host under any sub-path, with no server rewrites. `scripts/check-web-build.ts` runs after every `pnpm build` and fails if `index.html` or the web app manifest names anything by a root-absolute path, which would break under a sub-path.

**Hosted on GitHub Pages, from CI, on pushes to `main` only.** The `web` job in `.github/workflows/ci.yml` runs once `lint`, `engine` and `app` have passed on `main`, builds with `VITE_SITE_URL` set to the Pages URL (for the share tags, `robots.txt` and `sitemap.xml`), and deploys with GitHub's own Pages actions. Pull requests never deploy. Pages is free for a public repository and needs no secret. Where Pages isn't turned on for GitHub Actions (a fork, or this repository before the maintainer does so), the job says so and skips its deploy, and CI stays green.

**What the Browser Version lacks, and says it lacks.** The browser implementation of each platform interface is either a cheap one or null, and where it is null the UI says the feature needs the Desktop App. Settings has a **Browser version** section listing them, with a link to the Desktop App.

| Feature | In the Browser Version | Why |
| --- | --- | --- |
| Low latency | No: 80 ms measured (ADR 0002) | The browser can only use the OS's shared audio path. |
| Choosing the audio host and buffer size (ASIO, WASAPI, CoreAudio, JACK, PipeWire) | No | The same: a page can't reach the audio driver. |
| Recording audio, Input Monitoring, multi-input interfaces | No | `getUserMedia` into the AudioWorklet is possible but not cheap (Inputs, lining a take up, monitoring), and at the browser's latency recording through it would be poor. A later decision, not this one. |
| The sample browser | Yes (since #136) | Folders you pick in the browser; unlike the Desktop App's, a page may have to ask for them again. |
| **VST3 Plugins** (v4, #69/#70) | Never | Native code, run in a separate process. A page can run neither. |
| **Stem Separation** ([ADR 0005](0005-stem-separation-with-htdemucs-on-onnx-runtime.md)) | ~~Not planned~~ *Amended 2026-09-27:* Yes, on WebGPU, or WebAssembly with threads | ~~ONNX Runtime and a large model the musician installs, in `desktop/`.~~ ONNX Runtime Web in a Web Worker, from the model the musician installs, kept in the site's storage. See [Amended](#amended-2026-09-27-stem-separation). |
| Installers, signing and auto-update (#72–#74) | Not needed | Each visit loads the latest deploy. |
| Keeping the API key in the OS credential store | No: the browser's local storage | See the risk below. |
| Opening and saving **Project** folders | Chrome and Edge only | The File System Access API. Elsewhere the File menu says the Desktop App can. |
| MIDI keyboards | Chrome, Edge and Firefox | Web MIDI; not in Safari. |
| Everything else: Tracks, Clips, the Synth, the Drum Sampler, **Effects**, **Automation**, **WASM Plugins**, export to WAV, the **Reference Track**, the **Assistant** | Yes | The same code; WASM Plugins run in the browser's own WebAssembly (ADR 0003). |

The Desktop App's list only ever grows: a new feature that needs the machine goes behind `platform.ts` with a browser implementation that is null, and adds its line to the Browser version section. *Amended 2026-09-27:* it has shrunk once, when Stem Separation came to the Browser Version and left the list.

## Consequences

- ADR 0002's decision is unchanged: the MVP, and every **[desktop]** requirement, is the Desktop App. Only its last consequence ("a browser build moves to consider later") is superseded by this ADR.
- `pnpm dev` and the Browser Version are the same browser implementation, so keeping one working keeps the other. CLAUDE.md's rule stands: desktop first, and a browser version where it is cheap; where it isn't, the UI says the feature needs the Desktop App.
- **The API key is kept in local storage, which any page on the same origin can read.** On GitHub Pages the origin is `https://adrianeyre.github.io`, shared by every Pages site the account has, not only this one. A musician who pastes a key into the Browser Version is trusting all of them. A custom domain for the Browser Version would give it an origin of its own.
- **The Assistant's requests go from the page, so CORS applies.** Claude (with the SDK's direct-browser-access header), OpenAI and Gemini answer browsers. A gateway must allow CORS from the Pages origin, and the Local **Provider** needs Ollama to allow it (`OLLAMA_ORIGINS=https://adrianeyre.github.io`); Chrome may also ask the musician before a public page reaches `localhost`.
- The deploy runs on every push to `main`, so what is on `main` is live within minutes. A broken `main` is caught by the jobs the deploy waits for, not by a release step.

## To confirm

The maintainer has to:

1. **Turn Pages on**: the repository's *Settings → Pages → Build and deployment → Source: GitHub Actions*. Until then the `web` job skips its deploy.
2. **Choose the address.** CI builds with the URL Pages reports (`https://adrianeyre.github.io/soundcheck/` unless a custom domain is set). The `VITE_SITE_URL` default that local builds use is `https://adrianeyre.github.io/soundcheck`, which is right once the repository is renamed from `temp` to `soundcheck`; change it if the site is meant to be elsewhere.
3. **Accept the API-key risk above**, or set a custom domain for the Browser Version.
4. **Check by hand** once it is deployed, in current Chrome or Edge, which the sandbox this was written in can't do (it has no display or sound device): the page loads from its sub-path with its icons; **Play** is heard; a MIDI keyboard plays the Synth; a Project folder saves and opens again; the Settings page lists what the Browser Version lacks and links to the Desktop App; an Assistant Request with a Claude key edits the song. Then in Firefox: it plays, and the File menu says Project folders need the Desktop App.

## Amended 2026-09-27: Stem Separation

The table said the Browser Version would have no **Stem Separation**. It has it now, on [ONNX Runtime Web](https://www.npmjs.com/package/onnxruntime-web) in a Web Worker, from the same `htdemucs.onnx` the musician exports and installs from a file. [ADR 0005's second amendment](0005-stem-separation-with-htdemucs-on-onnx-runtime.md#amended-2026-09-27-the-browser-version-separates-stems-too) has what was built, what it was measured at, and its risks. What it means here:

- **It isn't one of the Desktop App's features any more, where the browser can run it.** Settings no longer lists it. Where the browser can't (no WebGPU and no WebAssembly threads, which since the 2026-09-27 amendment below means a browser that refuses the service worker that isolates the page; under 4 GB of memory; no storage), **Separate into Stems** and **Import as Stems…** are disabled, with the reason, which says the Desktop App can.
- **The page gets bigger, but only when it's used.** ONNX Runtime Web's JavaScript (about 420 kB) is in the worker's own chunk, and its WebAssembly (28 MB, about 7 MB compressed) is a file of its own; neither is fetched until a model is installed or a separation starts.
- **The site's storage holds about 300 MB more**, in the Origin Private File System (IndexedDB where the browser can't write that). On `github.io` every Pages site of the account shares that origin's quota. Clearing the site's data removes the model with the rest.
- **Cross-origin isolation would make it faster everywhere.** COOP and COEP headers would give WebAssembly threads, and so a CPU fallback fast enough for browsers without WebGPU. Pages can't send headers; a service worker that adds them (as `coi-serviceworker` does) could, but it would also require every cross-origin resource the page loads to allow it. That is a later decision, not this one.
  - **Amended 2026-09-27: decided, and built.** The Browser Version registers [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT, Guido Zuidhof and contributors), from `app/scripts/cross-origin-isolation.ts`: it is the first script in `index.html`'s head, served beside it unhashed, and the service worker adds COOP `same-origin` and COEP to every response. The page loads nothing cross-origin except CORS requests to the Assistant's providers, and the Relay's WebSocket, which COEP doesn't touch, so nothing it uses breaks. The costs: **the first visit reloads once** to come under the worker; a browser that refuses service workers (some private windows) stays unisolated, and without WebGPU still can't separate; and a future cross-origin image, font or script has to send CORP or CORS, or it's blocked. The Desktop App's window runs the same build and never registers it (`window.coi.shouldRegister` checks `__TAURI_INTERNALS__`). Unverified by eye: that Pages is isolated after the reload (`crossOriginIsolated` is `true` in the console) and that the Assistant's providers still answer.

To confirm, beside the list above: **check it by hand**, with a real `htdemucs.onnx`, in Chrome or Edge on the Windows machine, as [the README](../../README.md#checking-it-by-hand) says. It has only ever run against fake models, in Node.

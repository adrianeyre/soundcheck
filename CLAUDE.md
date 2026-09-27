# Soundcheck

A music-creation app (a DAW) whose Assistant can edit and listen to a song. Read these before changing anything:

- `CONTEXT.md`: the glossary. Use its terms in code, issues and docs.
- `docs/product-requirements-document/`: what is being built (`mvp.md` first).
- `docs/architectural-decision-record/`: decisions already made, and why.
- `docs/processes/`: how issues move and how Sandcastle runs work.

## Layout

- `engine/`: the Rust Audio Engine core. Platform-free: no audio devices, files or browser APIs (ADR 0001).
- `app/`: the React UI (Vite, TypeScript). It imports the engine's WASM build as `@engine` and never processes audio itself.
- `desktop/`: the Tauri desktop app (ADR 0002). It runs the engine natively on cpal and reads MIDI through midir. Everything device-specific lives here, never in `engine/`.
- `sdk/`: the stable SDK a WASM Plugin is written against (ADR 0003). `examples/plugins/` are Plugins written only against it; a check in `pnpm lint` keeps them that way.
- `spikes/`: throwaway prototypes behind an ADR, each its own workspace, outside the app's checks. Don't build on them.

## Commands

Run from the repo root:

- `pnpm lint`: `cargo fmt --check`, `cargo clippy -D warnings`, `oxlint --deny-warnings`
- `pnpm typecheck`
- `pnpm test`: Rust tests, then the WASM build, then the UI tests
- `pnpm build`
- `pnpm dev`: the UI in the browser, with the engine loaded as WASM
- `pnpm desktop:dev`: the desktop app (see the README for Windows setup)

All four checks must pass before a commit.

## Rules

- **Versions.** Node 26. pnpm at the version in `packageManager`, which is kept at the latest release. Every npm package, crate and GitHub Action you add or touch goes in at its latest version; look it up (`npm view <pkg> version`, `cargo search <crate>`, the action's latest release) instead of recalling one. Dependabot keeps them there afterwards. If the latest versions don't work together, say so in the PR; don't quietly pin an older one.
- **Engine tests don't need audio hardware.** Neither CI nor the sandbox has a sound device. Render into a buffer and assert on the samples.
- **Anything platform-dependent** (audio output and input, MIDI, files, secrets) goes behind an interface, and `app/src/platform.ts` picks the implementation. **Desktop first:** the MVP is the Tauri desktop app on Windows (ADR 0002), so write the desktop implementation first. The Browser Version (`pnpm dev`, and deployed to GitHub Pages; ADR 0006) ships too: give it the browser implementation where one is cheap; where it isn't, make its part null, add the feature to `app/src/settings/desktop-only.ts` so the UI says it needs the Desktop App, and say so in the PR.

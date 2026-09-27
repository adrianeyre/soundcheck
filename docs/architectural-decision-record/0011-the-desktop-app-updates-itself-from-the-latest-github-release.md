# The Desktop App updates itself from the latest GitHub Release

**Status: proposed** in the v4 pull request (#74). What the maintainer has to confirm, and make, is under [To confirm](#to-confirm).

The v4 PRD asks for "installers, signing and auto-update" on Windows, macOS and Linux. The installers are [ADR 0009](0009-an-nsis-installer-signed-with-whichever-secret-is-set.md) (Windows, #73), [ADR 0010](0010-the-mac-app-is-signed-ad-hoc-or-with-a-developer-id-and-notarised.md) (macOS, #72) and #71 (a .deb and an AppImage on Linux). Until now CI kept each as a workflow artifact of a push to `main`, and nothing told an installed **Desktop App** that a newer version was out, let alone installed it. The **Browser Version** needs none of this: each visit loads the latest deploy ([ADR 0006](0006-a-browser-version-beside-the-desktop-app.md)).

The maintainer decided the shape: "the Tauri updater, fed from GitHub Releases, with its signing key as a secret", wired now and switched on by adding the secret, with CI green either way.

## Decision

### Tauri's updater, with a key of our own

The Desktop App uses [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/) (2.12, the latest for Tauri 2). It downloads `latest.json` from one endpoint, finds the package for its own platform and installs it only if the package is **signed by the updater's key** (minisign, Ed25519). This is a key of our own, separate from Windows' and Apple's code signing:

- its **private half** is the `TAURI_SIGNING_PRIVATE_KEY` secret, with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, which only CI's build steps get;
- its **public half** is committed, as `plugins.updater.pubkey` in `desktop/tauri.conf.json`, and built into the app. It stays **empty until the maintainer makes the key**.

`desktop/tauri.conf.json` also sets:

- the endpoint, `https://github.com/adrianeyre/soundcheck/releases/latest/download/latest.json`: GitHub's address for a file on the **latest Release**, which is never a draft or a pre-release;
- `requireSignedVersion`, so a package signed for one version can't be announced as another. Without it, an old, vulnerable Release's signed package could be offered again as "newer";
- on Windows, `installMode: passive`: the NSIS installer shows its progress with no questions, then starts the new version itself.

What the updater replaces, and so which **Release** packages carry an update, per platform:

| Platform | Installed from | Update package | Installed by |
| --- | --- | --- | --- |
| Windows | the NSIS installer | the same installer, `Soundcheck_<version>_x64-setup.exe` | the installer, per user, with no administrator prompt (ADR 0009) |
| macOS | the disk image | `Soundcheck_<version>_aarch64.app.tar.gz`, the signed and notarised app | the updater, replacing the app in place |
| Linux | the AppImage | the same AppImage | the updater, replacing the file in place |
| Linux | the .deb | the same .deb | `dpkg`, through `pkexec`, which asks for the musician's password |

### Only the app's own commands, and only when it can

The page doesn't get the plugin's commands: the window's capability doesn't grant `updater:default`, so a page script can't point the updater at another endpoint or key. Instead `desktop/src/update.rs` has four commands of its own: `update_status` (the version, and why it doesn't update itself, if it doesn't), `update_check`, `update_install` (download, check, install, restart) and `update_progress`.

A build **doesn't update itself**, and says why rather than failing, when:

- it has **no public key**: built before the maintainer made the key, or on a fork;
- it is a **development build** (`pnpm desktop:dev`), which an update would replace with a release;
- it **wasn't installed from a Release's package**, such as a binary built from source, or the .rpm Tauri could make but a Release doesn't carry. Tauri writes which package a binary was built into, and the app reads it.

### In Settings, and a notice

The UI reaches it through an `Updater` interface, which `app/src/platform.ts` gives the Desktop App and not the Browser Version (`null`: it has nothing to update, so no desktop-only entry either).

- *Settings → Updates* shows the version running and, where it can't update, why, with a link to the Releases page. Otherwise it has **Check for updates**; what is found, with its date and notes; and **Install and restart**, with the download's progress.
- **At each start** the app checks, unless *Check for a newer version when Soundcheck starts* is turned off (kept in local settings). A check at start that fails, offline say, shows nothing but in Settings. One that finds a newer version shows a **notice**, with **Install and restart** and **Later**.
- Installing closes the app, so it **asks first when the Project has unsaved changes**, as closing does.

### Update packages made by the build, only when signed

Tauri makes and signs the update packages when `bundle.createUpdaterArtifacts` is on, and then fails the build without the private key, which would break every fork, pull request and developer's machine. So it stays off in the config, and `pnpm desktop:build` runs through `scripts/updater.ts build`, which turns it on (`--config`) when the private key and the public key are both there:

- both: the packages are **signed**, each with a `.sig` beside it;
- neither, or only the public key: the build goes on **without update packages**, saying so;
- the private key without the public key, or a password without the key: **half a set**, which fails, naming what is missing and never a value, as `sign-windows.ts` and `sign-macos.ts` do.

`node scripts/updater.ts --how` says which it would do. The Windows installer is signed for the updater after Windows' own signature; the Mac's `.tar.gz` is made from the app after it is signed and notarised.

### A Release for each `v*` tag

CI runs on a pushed tag `v*` as on `main`, apart from deploying the Browser Version. The build jobs (`desktop-release`, `desktop-macos` and `desktop-linux-packages`) get the two secrets and keep the update packages and their `.sig`s with the installers. Tauri names the Mac's `Soundcheck.app.tar.gz` whatever the version, so the job renames it after the version, as the other files are named. A new **`release`** job runs only for the tag, once every test and build has passed, with `contents: write` for that job alone. It:

1. fails unless the tag is `v` and the root `package.json`'s version, which the app's version comes from;
2. downloads every build's files;
3. runs `node scripts/updater.ts manifest`, which pairs each package with its `.sig`, **checks every signature against the committed public key and the version**, as the app will, and writes `latest.json`: the version, the notes, the date and each platform's package address and signature. It fails on a package without a signature, a signature without a package, one signed by another key or for another version, or two packages for one platform. With no key at all, and so nothing signed, it writes no `latest.json` and the Release goes ahead with the installers and a notice, "No auto-update";
4. makes the GitHub Release with `gh release create`: every file and `latest.json` at once, with notes GitHub writes from the merged pull requests. A version with a `-` is a **pre-release**, which `releases/latest` never is, so installed copies don't update to it.

Making the Release in one step means the latest Release never lacks its `latest.json`, and never points at a package it doesn't have. The version is bumped by hand in `package.json`, and the tag is pushed by hand.

## Why

**Tauri's updater.** The app is a Tauri app, and the plugin is Tauri's own: it knows how each of our packages installs (the NSIS installer, the app bundle, the AppImage, the .deb), checks the signature before anything runs, and is maintained with the rest of Tauri. Writing our own would mean a signature check, a download and four installers of our own, each a place for a mistake that lets an unsigned file run.

**A key of our own, not the code signature.** The updater doesn't use Windows' or Apple's signatures; it needs its own either way. Its key is free and made by one command, so, unlike those, auto-update can be switched on the day the maintainer chooses, without paying anyone. It also means an update is trusted only if it came from Soundcheck's CI, whoever else Windows or Apple would trust.

**The public key committed, and empty until made.** The public key isn't secret, and committing it makes the key the app trusts a reviewed change, not whatever a build was given. Empty, every build says it doesn't update, which is true, rather than building a key in that nobody holds.

**GitHub Releases.** The code, CI and issues are already on GitHub, a Release is free, and `releases/latest/download/…` is a stable address that always means the newest non-pre-release version. There is no server of ours to run, pay for or keep secure.

**Checking the signatures before publishing.** The app refuses a package signed by another key, or for another version, so a Release with one would announce an update no installed copy can take, and every musician would see it fail. Checking in CI, with the same algorithm, turns that into a failed release job that the maintainer sees instead. `scripts/updater.ts` checks minisign's signature with Node's own Ed25519, and is tested against a signature made by Tauri's CLI.

**Our own commands, not the plugin's JavaScript API.** With the plugin's commands granted, anything running in the page could ask the updater to check another endpoint. The app's own commands take no address, so the endpoint and key are only ever the ones built in. They also let the app say *why* it doesn't update, which the plugin can't.

**Asking, not installing on its own.** An update restarts the app and, on Linux, may ask for a password. Doing that without asking, in the middle of a take, is worse than a notice. The notice appears only when a check finds something, and **Later** puts it off until the next start.

**A tag, not every push to `main`.** A Release is something the maintainer means to give everyone, with a version that says what changed. Every push to `main` still builds everything as an artifact, for testing.

## Alternatives

- **CrabNebula Cloud**, Tauri's hosted updater and distribution service. It adds download statistics and staged roll-outs, but it is another account and, past its free tier, a bill, for what GitHub Releases does for a project this size.
- **A server of our own** answering the updater dynamically, which could roll an update out gradually or hold it back per platform. More to run and secure; `latest.json` on a Release can do this later by being edited.
- **The plugin's JavaScript API** (`@tauri-apps/plugin-updater`) instead of our own commands. Less Rust, but the page could then point the updater anywhere; see [Why](#why).
- **Automatic, silent updates**, downloaded in the background and installed at the next start. Fewer clicks, but a restart the musician didn't choose, and a Linux password prompt out of nowhere. A setting could add it later.
- **The Microsoft Store and the Mac App Store**, which update apps themselves. Each is its own package, listing and review, with a sandbox (ADR 0009, ADR 0010); beside this, not instead of it.
- **A release tool** such as release-please or `tauri-action`'s release mode, to bump versions and write notes. The version bump and the tag are two commands, and `tauri-action` would build the app a way our jobs don't (with our signing scripts), so for now the release is a job of our own. Either can be added once there are Releases to automate.
- **Signing `latest.json` itself.** The updater doesn't: it trusts the file only for where to look and what the version is, and each package's signature, bound to the version, is what it checks. That is enough, since a forged `latest.json` can only offer packages already signed.

## Consequences

- Nothing updates itself until the maintainer makes the key. Copies built before the public key is committed never update: their users install the first signed version by hand, once.
- **The private key can't be lost.** Without it, no installed copy can be updated again: each would have to be reinstalled from a Release built with a new key. If it leaks, whoever has it can sign an update every copy takes: make a new key and ship it the same way. It needs a backup, with its password, away from the maintainer's machine.
- A release is: bump the version in `package.json`, commit, push the tag. The tag waits for the whole of CI, about as long as a push to `main`.
- The Linux .deb asks for the musician's password to update, as installing it did. The AppImage updates without asking, if its file is writable.
- On Windows, a copy installed per user updates per user; the installer's own upgrade (ADR 0009) is what the updater runs.
- The installed app contacts `github.com` at each start, unless the check at start is turned off. GitHub sees the address and the version asked for, as it would for any download.
- Every build job on a tag has the signing key in its build step's environment, as it has the Windows and Apple secrets. Pull requests never do.

## Limits of this result

The sandbox this was written in is Linux, with no display, no Windows and no Mac, and nothing here has been published. What is proven here:

- `scripts/updater.ts`: when it signs, how it passes that to Tauri, how it pairs packages and signatures, and that its signature check agrees with Tauri's, on a package signed by Tauri's CLI with a throwaway key (in `scripts/fixtures/updater/`; no private key is committed). The `manifest` it writes, and each way it refuses one, are tested with `node --test`.
- The real plugin, in `desktop/tests/updater.rs`, served that `latest.json` from this machine: it finds the right package for the Windows, Mac and both Linux targets, downloads it and accepts its signature; turns away one signed by another key, and one announced for a version it wasn't signed for; and the page can't call its commands.
- The app's status logic, the UI (with a stand-in `Updater`) and the notice, in their tests.
- A real `pnpm desktop:build` on Linux, with a throwaway key and its public key in the config (not committed): it made the .deb and the AppImage with their `.sig`s, and `manifest` accepted them.
- The release job's shell, run locally: flattening the artifacts, the manifest step with no key, and the pre-release check.

Not proven: installing and restarting on any platform, on Windows (the NSIS installer, passive), macOS (replacing the notarised app) and Linux (the .deb through `pkexec`, the AppImage in place); the UI in a real window; and a real tag, its CI run and its GitHub Release. Those are first done by the maintainer, below.

## To confirm

The maintainer has to:

1. **Accept the decision**: Tauri's updater, GitHub Releases, a key of our own, a Release per `v*` tag, and the app asking before it installs.
2. **Make the key**, with a password, as the README's "Releases and updates" says (`pnpm exec tauri signer generate -w ~/.tauri/soundcheck.key`), and **back it up**, with its password, somewhere other than their machine.
3. **Add the secrets** `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and **commit the public key** into `plugins.updater.pubkey`.
4. **Make two Releases** to update between: bump `package.json`'s version, commit, push the tag `v<version>`, and check that the `release` job made a Release with an installer per platform, the update packages, their `.sig`s and `latest.json`, and no "No auto-update" notice. Then the same for a second, higher version.
5. **Check by hand**, with the first Release installed, that *Settings → Updates* shows its version and **Check for updates** finds the second, with its notes, and that a notice says so at start. Then, on each platform, that **Install and restart** installs it:
   - **Windows**: the installer shows its progress without questions or an administrator prompt, and Soundcheck opens again as the new version, with its settings and Claude API key kept;
   - **macOS**: Soundcheck restarts as the new version, still opening without a Gatekeeper warning (with the Developer ID, ADR 0010);
   - **Linux, AppImage**: the file is replaced and Soundcheck restarts as the new version;
   - **Linux, .deb**: it asks for the password, then restarts as the new version; `dpkg -l soundcheck` shows it.
6. **Check what it refuses**: with the Project changed and unsaved, **Install and restart** asks first; offline, the check at start shows nothing and Settings says it couldn't check; with *Check for a newer version when Soundcheck starts* off, no notice appears; and a copy built with `pnpm desktop:dev` says it is a development build.

## Amendment, 2026-09-27: semantic-release makes the version and the tag

A Release is no longer made by bumping `package.json` and pushing a `v*` tag by hand. `.github/workflows/release.yml` runs on every push to `main`. It verifies with `ci.yml` (now for pull requests only), then runs semantic-release (`.releaserc.json`). semantic-release decides the version from the Conventional Commits since the last tag, bumps `package.json`, writes `CHANGELOG.md`, commits them with `[skip ci]`, tags `v<version>`, and makes a **draft** Release. The build jobs (`desktop-release`, `desktop-macos` and `desktop-linux-packages`) then build that tag. The `release` job described above is now **`publish`**: it writes `latest.json` from the draft's notes, as before, uploads everything, and publishes the draft, so the latest Release still never lacks an installer or `latest.json`. A merge with nothing to release (`docs:`, `test:`, `chore:`, `ci:`, `style:`) makes no version and no installers. The Browser Version is deployed after every merge, from the bumped `main`. The two Releases in "To confirm" below are made by merging a `fix:` or `feat:` pull request each, in place of pushing tags.

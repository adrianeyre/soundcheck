# The Mac app is signed ad hoc, or with a Developer ID and notarised

**Status: proposed** in the v4 pull request (#72). What the maintainer has to confirm, and pay for, is under [To confirm](#to-confirm).

The **Desktop App** ships on Windows first ([ADR 0002](0002-mvp-is-a-desktop-app.md)), and the v4 PRD asks for "installers, signing and auto-update" on Windows, macOS and Linux. Windows is [ADR 0009](0009-an-nsis-installer-signed-with-whichever-secret-is-set.md) (#73), Linux's packages are #71, and the auto-update is #74. This ADR is macOS: until now, `pnpm desktop:build` on a Mac made only a bare executable, with no app bundle, no signature and nothing to drag into Applications.

macOS is stricter than Windows. On Apple silicon, code that isn't signed at all doesn't run. A downloaded app that isn't signed with a **Developer ID** and **notarised** by Apple is stopped by Gatekeeper, and since macOS 15 the only way past is *System Settings → Privacy & Security → Open Anyway*. A Developer ID needs the Apple Developer Program, which costs money every year. So, as for Windows, the maintainer asked for it to be wired now and switched on later by adding secrets: built, signed and notarised from `APPLE_*` secrets on a macOS runner, with the app and disk image still made, unsigned, when they are absent, and CI green either way.

## Decision

### An app and a disk image, for Apple silicon on macOS 13.4 and later

`desktop/tauri.macos.conf.json` turns Tauri's bundler on for macOS (as `tauri.windows.conf.json` and `tauri.linux.conf.json` do on theirs) with two targets, the **app** and a **disk image**. So `pnpm desktop:build` on a Mac leaves `target/release/bundle/macos/Soundcheck.app` and `target/release/bundle/dmg/Soundcheck_<version>_aarch64.dmg`, which opens to Soundcheck beside a link to Applications.

- **Apple silicon only** (`aarch64-apple-darwin`), **macOS 13.4 or later** (`minimumSystemVersion`, which Tauri also passes to the compiler as `MACOSX_DEPLOYMENT_TARGET`). See [Why](#why).
- `desktop/icons/icon.icns`, made by `tauri icon` from the same `icon.png` as the other platforms' icons.
- `desktop/Info.plist`, which Tauri merges into the app's own, says why Soundcheck wants the microphone (`NSMicrophoneUsageDescription`). Without it, macOS ends the app the moment it opens an audio input; with it, macOS asks the musician once, and until they allow it, recording gets silence.
- The Claude API key is kept in the login keychain, as it is in Windows Credential Manager on Windows.

### Signed under the hardened runtime, with two entitlements

Notarisation requires the **hardened runtime** (`hardenedRuntime: true`), which by default forbids what Soundcheck needs twice. `desktop/Entitlements.plist` allows exactly those, and nothing else:

- `com.apple.security.device.audio-input`: recording, through CoreAudio.
- `com.apple.security.cs.allow-unsigned-executable-memory`: **WASM Plugins** ([ADR 0003](0003-wasm-plugin-hosting.md)). wasmtime compiles a Plugin into memory it then makes executable. It does so without `MAP_JIT`, so the narrower `allow-jit` isn't enough.

The app isn't sandboxed (`com.apple.security.app-sandbox` is off), since it isn't for the Mac App Store; see [Alternatives](#alternatives).

### Ad hoc by default, a Developer ID when the secrets are set

`bundle.macOS.signingIdentity` is `-`: **ad hoc**. That is what a build with no secret gets (a fork, a pull request, a developer's Mac). It is a signature with no identity behind it, which is what lets Apple silicon run the app at all. It opens on the Mac that built it; a downloaded copy is stopped as from an unidentified developer, and is opened once through *Open Anyway* (on macOS 14, with Control-click → **Open**).

Tauri signs and notarises by itself, from `APPLE_*` variables, but it takes an empty variable for a set one (and GitHub gives a secret it doesn't have as an empty string), and it reads an App Store Connect API key only from a file. So `scripts/sign-macos.ts` runs the build: `node scripts/sign-macos.ts -- pnpm desktop:build`. It drops the empty variables and then chooses:

1. **a Developer ID, notarised**, when there is an identity and one way of notarising:
   - the identity is `APPLE_CERTIFICATE` (a *Developer ID Application* certificate and its key, as a base64 `.p12`) with `APPLE_CERTIFICATE_PASSWORD`, which Tauri imports into a temporary keychain for the build. On a Mac that has the certificate in its own keychain, `APPLE_SIGNING_IDENTITY` alone will do. Given a certificate and no identity, the script sets the identity to `Developer ID Application`. Tauri accepts an identity only if it is part of the certificate's name, so this refuses an *Apple Development* certificate, which Gatekeeper doesn't trust;
   - notarising is done by an **App Store Connect API key** (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_PRIVATE_KEY`; the script writes the key to a file only the build can read, deleted afterwards; locally, `APPLE_API_KEY_PATH` can name the `.p8` instead), or else by an **Apple Account** (`APPLE_ID`, an app-specific `APPLE_PASSWORD`, `APPLE_TEAM_ID`). If both are complete, the API key wins;
2. otherwise, with no `APPLE_*` secret at all, **ad hoc**, saying so.

**Half a set fails**, before the build, naming what is missing and never a value. A certificate with no way of notarising counts as half a set: Gatekeeper turns away a Developer ID app that isn't notarised, so such a build would be worse than an ad hoc one while looking finished. The choice is `signing()` in the script, tested with `node --test` in `pnpm test`, as `sign-windows.ts` is.

Tauri then signs the app's executable and the app, submits the app to Apple's notary service, waits and staples the ticket. It signs the disk image with the Developer ID but doesn't notarise it, so `node scripts/sign-macos.ts --notarise <dmg>` does: `xcrun notarytool submit … --wait` with the same credentials, then `xcrun stapler staple`. It does nothing when the app is signed ad hoc.

### Built and checked on `main`, kept as an artifact

The `desktop` job's tests of the host (`cargo test -p soundcheck-desktop`) now run on `macos-latest` too, beside Windows and Linux, on every push and pull request. A new `desktop-macos` job runs on pushes to `main` only, on `macos-latest` (Apple silicon):

1. `node scripts/sign-macos.ts --how` fails at once on half a set of secrets, and otherwise leaves a notice, "Mac app not signed", when there are none;
2. the build runs through the sign script, and with a Developer ID the disk image is notarised. The secrets are in those steps' environments only, not the whole job's;
3. it checks what a Mac would: `codesign --verify --deep --strict` on the app, and its entitlements printed. With a Developer ID it also checks `spctl --assess` on the app and on the disk image (Gatekeeper's own verdict) and `stapler validate` on both;
4. it keeps the disk image as the `soundcheck-macos` workflow artifact. Only the disk image: an artifact is a zip, which would lose the app's symlinks and executable bits.

Publishing it to a GitHub Release, for the updater, is #74: [ADR 0011](0011-the-desktop-app-updates-itself-from-the-latest-github-release.md) does it for each `v*` tag, with the app's update package beside the disk image, and the job runs for those tags too.

## Why

**Apple silicon only.** **Stem Separation** ([ADR 0005](0005-stem-separation-with-htdemucs-on-onnx-runtime.md)) links ONNX Runtime statically, from the `ort` crate's prebuilt libraries, and those exist for `aarch64-apple-darwin` but not for Intel Macs. An Intel build would mean building ONNX Runtime from source in CI, or an Intel app without Stem Separation. Neither is worth it for a platform Apple is ending: macOS 26 is the last release for Intel Macs, and Macs have been sold only with Apple silicon since 2023. A universal app is one `--target universal-apple-darwin` away once an Intel ONNX Runtime is.

**macOS 13.4.** The same prebuilt ONNX Runtime is compiled for macOS 13.4 and later, so the app can't claim to run on anything older. Rather than let that minimum surprise someone as a crash at launch, `minimumSystemVersion` states it, and macOS refuses to open the app on an older system with a clear message.

**Ad hoc rather than unsigned.** On Apple silicon, an unsigned app doesn't run at all, even on the Mac that built it. Ad hoc costs nothing and needs no secret. The linker already signs the executable ad hoc; `-` makes Tauri sign the whole app so, with the entitlements, and tells the reader that it does.

**Allowing unsigned executable memory.** It is the one entitlement that weakens the hardened runtime, and it is needed only because WASM Plugins are compiled at run time, which is what [ADR 0003](0003-wasm-plugin-hosting.md) chose for their speed. wasmtime's code memory doesn't use `MAP_JIT`, so `allow-jit`, the narrower one, isn't enough.

**The API key before the Apple Account.** An App Store Connect API key belongs to the team, not a person, has no password to rotate and no two-factor prompt, and can be revoked on its own. An Apple Account needs an app-specific password, which stops working when the account's password changes. Both are offered because the maintainer may have only one.

**Notarising the disk image too.** Gatekeeper checks the disk image first when a downloaded one is opened. A disk image that isn't notarised, around an app that is, can still be stopped on recent macOS, and Tauri doesn't notarise it ([tauri#7533](https://github.com/tauri-apps/tauri/issues/7533)). Stapling both means neither needs Apple's servers to open.

**A script around Tauri, not a signing step after it.** As on Windows, the signature must be made inside the build, before the app is packed into the disk image, and Tauri already knows how to sign, notarise and staple the app. The script only gives it the environment it can't make from GitHub's secrets, and does the one thing Tauri leaves out.

## Alternatives

- **A universal app, Intel as well.** Twice the build, and blocked on an Intel ONNX Runtime; see [Why](#why).
- **No hardened runtime.** It would drop both entitlements, but Apple refuses to notarise without it, so there would be no Developer ID route.
- **The Mac App Store.** Apple signs and hosts the app, with no Gatekeeper warning, but it must be sandboxed. That makes the file system, audio devices, MIDI, and a VST3 host ([ADR 0008](0008-vst3-plugins-run-in-a-helper-process.md)) each a question of their own, and the App Store has its own review and its own updates instead of #74's. A later decision if wanted, beside the direct download rather than instead of it.
- **A Homebrew cask.** Useful for people who install that way, and cheap to add once a notarised disk image is published to a GitHub Release (#74), but Homebrew is dropping casks that aren't signed and notarised, so it comes after this, not instead of it.
- **Signing with `codesign` in steps of our own.** More to maintain than Tauri's signing, and it would have to repeat Tauri's order (the executable, then the app, then the disk image) and its temporary keychain.

## Consequences

- `pnpm desktop:build` on a Mac now also makes the app and the disk image, and signs them ad hoc. Tauri's `--no-sign` skips signing altogether.
- The Mac app has one entitlement that loosens the hardened runtime, for WASM Plugins. The VST3 helper, when it comes to macOS ([ADR 0008](0008-vst3-plugins-run-in-a-helper-process.md)), loads third-party code signed by other teams, and will need `com.apple.security.cs.disable-library-validation`, in the helper's own entitlements and not the app's. ADR 0008 also wants macOS 14.4 for the helper's shared memory, which would raise this minimum, or be done without, when it lands.
- The macOS runners add a job to every push and pull request (the host's tests) and a longer one, the build, to each push to `main`, notarising included (usually a few minutes).
- An ad hoc disk image from CI can't be opened without *Open Anyway* on another Mac, so until the secrets are set it is for testing, not for sharing.

## Limits of this result

Nothing here has run on a Mac: the sandbox this was written in is Linux, with no Xcode, no keychain, no certificate and no Apple account. What is proven here: the Tauri configuration, merged and checked against Tauri's published schema; the icon, the entitlements and the Info.plist key; the sign script's choice of how to sign, the environment it gives Tauri, the notarytool command it builds and how it reads the answer; and that with no secret it signs ad hoc, and `--notarise` does nothing and succeeds. How Tauri behaves with that environment was read in its source (tauri-cli 2.11), not run. Building, signing, notarising, Gatekeeper's verdict and the host's tests on macOS are first done by CI on the next push, and by hand, below.

## To confirm

The maintainer has to:

1. **Join the Apple Developer Program** (US$99 a year), as an individual or as an organisation (which needs a D-U-N-S number, and shows the organisation's name as the developer). Or not for now: CI keeps building an app signed ad hoc.
2. **Add the secrets**, as the README's "Signing and notarising the Mac app" says: the Developer ID Application certificate, and an App Store Connect API key (or an Apple Account with an app-specific password).
3. **Confirm the name and team.** The certificate says *Developer ID Application: \<name\> (\<team ID\>)*. It should match `bundle.publisher` (*Adrian Eyre*) and the Windows signature.
4. **Accept Apple silicon only, on macOS 13.4 and later**, or ask for an Intel build without Stem Separation.
5. **Accept the two entitlements**, above all `allow-unsigned-executable-memory` for WASM Plugins.
6. **Check by hand on a Mac**, which the sandbox can't, with the disk image from the `soundcheck-macos` artifact of a push to `main`:
   - The CI run's `desktop` tests pass on macOS, and its `desktop-macos` job made `Soundcheck_<version>_aarch64.dmg`. With no secret set, it left the "Mac app not signed" notice and `codesign --verify` passed. With secrets set, there's no notice, the notarising step says Apple accepted it, and `spctl` says *accepted, source=Notarized Developer ID* for the app and the disk image.
   - Signed: downloading the disk image, opening it and dragging Soundcheck to Applications, it opens with at most macOS's "downloaded from the Internet" question, naming the developer, and no "unidentified developer" warning. With the Mac offline, it still opens (the stapled ticket).
   - Unsigned: the downloaded copy is stopped; *System Settings → Privacy & Security → Open Anyway* opens it, and it opens directly after that.
   - Arming an Audio Track and recording asks for the microphone once, then records; denied, it records silence and doesn't crash.
   - A WASM Plugin loads and plays (the hardened runtime allows its compiled code), and Stem Separation separates a clip.
   - The Claude API key, saved in Settings, is in Keychain Access under the login keychain and is still there after a restart.
   - On a Mac with macOS older than 13.4, or an Intel Mac, macOS refuses to open it with a message rather than crashing.

## Amended 2026-09-27: an Intel Mac has Stem Separation in the Browser Version

[Why](#why) weighs "an Intel app without Stem Separation" as the way to reach Intel Macs. Since [ADR 0005's second amendment](0005-stem-separation-with-htdemucs-on-onnx-runtime.md#amended-2026-09-27-the-browser-version-separates-stems-too), the Browser Version separates Stems too, on ONNX Runtime Web, so an Intel Mac already has it there (in Safari 26, or a browser with WebGPU), with the Browser Version's latency and without recording or VST3 Plugins. The decision stands: the Desktop App is for Apple silicon only, for the same reason, the `ort` crate's prebuilt ONNX Runtime. What changes is item 4 of [To confirm](#to-confirm): an Intel build without Stem Separation would now give an Intel Mac low latency and recording, not Stem Separation, which it has in the browser.

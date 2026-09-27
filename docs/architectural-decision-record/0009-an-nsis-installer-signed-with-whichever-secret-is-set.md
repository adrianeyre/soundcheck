# The Windows installer is NSIS, signed with whichever secret is set

**Status: proposed** in the v4 pull request (#73). What the maintainer has to confirm, and pay for, is under [To confirm](#to-confirm).

The **Desktop App** ships on Windows first ([ADR 0002](0002-mvp-is-a-desktop-app.md)), but until now `pnpm desktop:build` there made only `soundcheck-desktop.exe`, with nothing to install it and no signature. An unsigned download is what Windows warns hardest about: SmartScreen's "Windows protected your PC" with the publisher shown as *Unknown*, and some antivirus quarantine it outright. The v4 PRD asks for "installers, signing and auto-update". This ADR is the Windows installer and its signature. macOS is #72; the auto-update that will replace an installed copy is #74 and builds on this.

Signing needs a certificate, which costs money every year, so the maintainer asked for it to be wired now and switched on later by adding secrets: signed through Azure Artifact Signing (formerly Trusted Signing) or a PFX certificate, whichever is set, and unsigned when neither is, with CI green either way.

## Decision

### An NSIS installer, per user

`desktop/tauri.windows.conf.json` turns Tauri's bundler on for Windows (as `tauri.linux.conf.json` does on Linux, #71) with one target, **NSIS**. So `pnpm desktop:build` on Windows leaves `target/release/bundle/nsis/Soundcheck_<version>_x64-setup.exe` beside the `.exe`.

- **Installed for the current user** (`installMode: currentUser`, Tauri's default, set explicitly): into `%LOCALAPPDATA%\Soundcheck`, with no administrator prompt, a Start menu entry, an optional desktop shortcut, and an entry in *Settings → Apps* with its own uninstaller. The updater (#74) can then replace it without asking for administrator rights either.
- **WebView2 is fetched if missing**: Tauri's default, the Evergreen bootstrapper, downloaded and run silently by the installer only on a machine without WebView2. Windows 11, and Windows 10 since 2018, already have it.
- **Nothing else is bundled.** ONNX Runtime, for **Stem Separation** ([ADR 0005](0005-stem-separation-with-htdemucs-on-onnx-runtime.md)), is linked into the executable statically, and its model is installed by the musician on first use. The ASIO build (`--features asio`) is still a build of its own; the installer is the default WASAPI one (see [To confirm](#to-confirm)).
- The publisher shown in *Settings → Apps* is `bundle.publisher`, *Adrian Eyre*, and the licence GPL-3.0-or-later.

### Signed by one script, from whichever secret is set

Tauri signs the executable, the installer and the uninstaller inside it by running `bundle.windows.signCommand` on each, and signing all three matters: an unsigned uninstaller is warned about too. The command is `node ../scripts/sign-windows.ts %1` (Tauri runs it from `desktop/`, and makes the script's path absolute so NSIS can run it again for the uninstaller). The script looks at the environment and:

1. **signs through Azure Artifact Signing** when all six of its secrets are set: Azure's sign-in (`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`) and the account (`AZURE_ARTIFACT_SIGNING_ENDPOINT`, `…_ACCOUNT`, `…_CERTIFICATE_PROFILE`). It runs [`artifact-signing-cli`](https://github.com/levminer/trusted-signing-cli) (MIT), which fetches Microsoft's signtool plugin for the service (`Microsoft.ArtifactSigning.Client` from NuGet), signs in with the Azure CLI and runs signtool with it. The private key never leaves Microsoft's HSM;
2. otherwise **signs with a PFX certificate** when `WINDOWS_CERTIFICATE` (the `.pfx`, base64) and `WINDOWS_CERTIFICATE_PASSWORD` are set: it writes the certificate to a temporary folder, runs the Windows SDK's newest signtool (`/fd SHA256`, timestamped by RFC 3161 at `http://timestamp.digicert.com`, or `WINDOWS_TIMESTAMP_URL`) and deletes the folder;
3. otherwise **leaves the file unsigned** and succeeds, saying so, so a fork, a pull request and a developer's machine still build an installer.

If both sets are complete, Artifact Signing wins. **Half a set fails** the build, naming what is missing and never a value: a maintainer who has added five of six secrets wants to know, not to ship unsigned. Azure's sign-in alone doesn't count as starting Artifact Signing, since a developer's machine can have those three set for other work. The choice is `signing()` in the script, tested with `node --test` in `pnpm test`.

### Built on `main`, kept as an artifact

CI's `desktop-release` job (Windows, on pushes to `main` only, as before) now:

1. runs `node scripts/sign-windows.ts --how` first, which fails at once on half a set of secrets, and otherwise leaves a notice, "Windows installer not signed", when there are none;
2. installs `artifact-signing-cli` only when Artifact Signing is what it will use;
3. runs `pnpm desktop:build` with the secrets in that step's environment only, not the whole job's;
4. keeps the installer as the `soundcheck-windows` workflow artifact.

Secrets are never given to pull requests from forks, and the job doesn't run on pull requests anyway. Publishing the installer to a GitHub Release, which the updater reads from, is #74: [ADR 0011](0011-the-desktop-app-updates-itself-from-the-latest-github-release.md) does it for each `v*` tag, and the job runs for those tags too.

## Why

**NSIS rather than MSI.** Tauri makes both. NSIS installs per user with no administrator prompt; Tauri's MSI (WiX) is per machine and always asks. NSIS builds on any Windows runner with nothing installed first (Tauri fetches it), is smaller, and is what Tauri's updater runs in its quiet modes. An MSI matters to IT departments that push software through Group Policy; nobody has asked for that, and adding `msi` to `targets` later makes one beside the NSIS installer, signed by the same command.

**Artifact Signing first, and why the PFX is second.** Since 1 June 2023, the CA/Browser Forum requires the private key of every publicly trusted code-signing certificate, OV or EV, to be made and kept in certified hardware (a USB token or an HSM) from which it can't be exported. So a CA can no longer sell a certificate as a `.pfx` file, and the last ones sold that way, before June 2023 and for at most three years, have now expired. A publicly trusted signature from CI therefore means a cloud HSM, and Artifact Signing is the cheapest: US$9.99 a month on its Basic tier (5,000 signatures; a build uses three), with short-lived certificates Microsoft renews itself (so every signature is timestamped) and the key in its HSM. The PFX route stays because the maintainer asked for it, and it still has uses: a self-signed or company-internal certificate (for testing the signing path end to end, or for machines that trust that certificate), or an older exportable certificate if one turns up. It is not a way to reach the public.

**EV is no better for SmartScreen.** Since 2024, Microsoft gives EV certificates no head start on SmartScreen reputation: OV (which Artifact Signing's are) and EV both build it from downloads over time. So for the first releases, even a signed installer can show SmartScreen's warning, with the publisher's name instead of *Unknown*, until enough people have run it.

**A script, not Tauri's own signing settings.** Tauri's `certificateThumbprint` signs with a certificate already imported into the machine's store, and suits neither Artifact Signing nor a runner with no secrets. One command that chooses at run time keeps both routes, and the unsigned case, in one place that `pnpm test` covers, and a developer can run the same build locally with the same variables.

## Alternatives

- **Sign in a separate step after `tauri build`**, e.g. with Microsoft's GitHub Action for Artifact Signing. It would sign the installer but not the executable and uninstaller already packed inside it, so the installed app would be unsigned.
- **A signing certificate on a USB token**, used from the maintainer's own machine. It costs about as much per year as Artifact Signing, and releases could then only be built where the token is plugged in, never by CI.
- **SignPath's free signing for open-source projects**, which signs with SignPath's certificate after a manual review of the project. It is free, but the publisher shown is SignPath's foundation, not Soundcheck's, and it runs as its own CI integration and approval step. Worth it if the recurring cost is the obstacle; it would replace step 1 of the script, not the rest.
- **The Microsoft Store (MSIX)**, which re-signs the package itself, free, with no SmartScreen warning at all. It is a separate package format, a Store listing, and the Store's own update path instead of #74's, and the Store's sandbox would need checking against ASIO drivers and the file system. A later decision if wanted, beside the installer rather than instead of it.

## Consequences

- `pnpm desktop:build` on Windows now also builds the installer, which takes a little longer and downloads NSIS the first time. Tauri's `--no-sign` skips the sign command altogether.
- Every Windows build runs `scripts/sign-windows.ts`, so Node is needed where `tauri build` runs, as it already is for `pnpm build`.
- `artifact-signing-cli` is a third party's tool that is given the Azure app registration's secret. It is small and MIT-licensed, and the source is short enough to read; the app registration should hold only the *Artifact Signing Certificate Profile Signer* role, so that secret can sign and do nothing else in Azure. CI installs a pinned version with `cargo install --locked`, which Dependabot doesn't update: bump it by hand when a new one is out.
- The installer and its uninstaller carry the version from the root `package.json`, as the app does. Installing a newer one over an older one upgrades it in place.

## Limits of this result

Nothing here has run on Windows: the sandbox this was written in has no Windows, no display and no certificate. What is proven here is the Tauri configuration (checked against Tauri's own schema), the script's choice of how to sign, the commands it builds, and that with no secret it succeeds without signing. Building the installer, signing it either way, and installing it are first done by CI on the next push to `main` and by hand, below.

## To confirm

The maintainer has to:

1. **Choose how to sign, and pay for it.**
   - **Artifact Signing** (recommended): US$9.99 a month, on a paid Azure subscription. For a **public** certificate, individuals must be in the USA or Canada; organisations in the USA, Canada, the EU, the UK and some other countries. Microsoft validates the identity first, which takes 1 to 20 business days. Then set the six `AZURE_*` secrets, as the README's "Signing the installer" says.
   - **A PFX**, only for a self-signed or internal certificate, or an older exportable one: set `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD`. It won't satisfy SmartScreen for the public.
   - Or neither for now: CI keeps building an unsigned installer.
2. **Confirm the publisher name.** `bundle.publisher` says *Adrian Eyre*; the signature says whatever name was validated. They should match.
3. **Confirm per-user installation**, rather than per machine or offering both (which always asks for administrator rights).
4. **Accept `artifact-signing-cli`** being trusted with the Azure secret, or replace it with Microsoft's signtool plugin called directly.
5. **Decide whether the installer should include ASIO.** It is the WASAPI build because the README says the ASIO SDK can't be redistributed, but Steinberg has also licensed it under GPLv3 since October 2025, which suits Soundcheck's GPL-3.0-or-later. CI could then fetch it and build `--features asio`. That is a change of its own, not part of this one.
6. **Check by hand on Windows**, which the sandbox can't, with the installer from the `soundcheck-windows` artifact of a push to `main`:
   - The CI run's `desktop-release` job made `Soundcheck_<version>_x64-setup.exe`. With no secret set it left the "Windows installer not signed" notice; with secrets set, no notice, and each sign step's output shows signtool succeeding.
   - Running the installer asks for no administrator rights, installs to `%LOCALAPPDATA%\Soundcheck`, adds Soundcheck to the Start menu and to *Settings → Apps*, and the app opens and plays.
   - Signed: the installer's and the installed `soundcheck-desktop.exe`'s *Properties → Digital Signatures* show the publisher and a timestamp, and `signtool verify /pa /v` passes on both and on `uninstall.exe`. The download's SmartScreen prompt names the publisher, not *Unknown*.
   - Installing a newer version over it upgrades it in place, keeping Settings and the saved API key; uninstalling from *Settings → Apps* removes it and leaves Projects alone.
   - On a machine without WebView2 (a fresh Windows 10 VM with it removed), the installer fetches it.

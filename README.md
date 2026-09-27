# Soundcheck

A music-creation app (a DAW) whose Assistant can edit and listen to your song.
The Audio Engine is Rust and the UI is React. The MVP ships as a Tauri
desktop app for Windows ([ADR 0002](docs/architectural-decision-record/0002-mvp-is-a-desktop-app.md)),
with the engine running natively on the audio device through cpal. The same UI
also ships as the lighter **Browser Version**, with the engine as WebAssembly in
an AudioWorklet ([ADR 0006](docs/architectural-decision-record/0006-a-browser-version-beside-the-desktop-app.md),
and [below](#the-browser-version)). See [`CONTEXT.md`](CONTEXT.md) for the terms used here and
[`docs/product-requirements-document/mvp.md`](docs/product-requirements-document/mvp.md)
for what is being built.

The title bar has the menu and the Project's name (edited where it is shown,
with whether it is saved) on the left, and the app's name in the middle. The
menu's **File** side menu has New (**Ctrl+N**), Open (**Ctrl+O**), Save
(**Ctrl+S**), Save As (**Ctrl+Shift+S**), Tracks (Add Audio Track **Ctrl+Shift+A**,
Instrument Track **Ctrl+Shift+T**, Drum Track **Ctrl+Shift+D**) and Export
(**Ctrl+E**); each shortcut works from anywhere, and ⌘ does on a Mac. Export
opens a dialog to render the whole song or the loop region as WAV (16, 24 or
32-bit float) or MP3 (128 to 320 kbps), at 44.1 or 48 kHz. The menu also chooses between the app's two pages (`#settings` in the
address opens Settings directly):

- **Editor**: only the music. Transport, Tracks, the Timeline, the Step
  Sequencer, Instruments, recording, the Mixer and the Assistant's Request box.
  Every edit undoes. A section with nothing to show, such as the Step Sequencer
  before a Pattern Clip is selected, steps aside until it has something.
- **Settings**: everything else. The Assistant's connection (Provider, key,
  model, gateway), the audio host, Plugins, the colour theme and palette, and
  **Diagnostics**, which
  holds the **Latency test**: Milestone 0's load page. N Tracks of Synth → EQ →
  Compressor → Reverb, played live from a MIDI or computer keyboard, with
  latency and dropout figures. The browser measured 80 ms from key to sound
  against a 20 ms limit, which is why the MVP is a desktop app. The song's own
  audio stops while the test runs.

The footer credits the design, shows the version (the root `package.json`'s,
which the Audio Engine and the desktop app are built as too), and opens the
**Cookie Policy** and the **Accessibility** statement. **Credits**, last in the
title bar's menu, says who made Soundcheck and whose work it is built on
(`app/src/legal/Credits.tsx`). The UI is built to WCAG
2.2 AA in its dark and light themes and each of their six colour palettes, which tint the backgrounds, the accent, the logo and tab icon, and draw a faint motif behind the pages;
`app/src/theme-contrast.test.ts` checks every colour pair.

## What you need

| Tool | Version | Why |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | 26 | Runs the UI tooling |
| [pnpm](https://pnpm.io/) | the version in `packageManager` in [`package.json`](package.json) | Installs packages and runs every command |
| [Rust](https://rustup.rs/) via rustup | current stable | Builds the Audio Engine |
| The `wasm32-unknown-unknown` Rust target | | Compiles the engine to WebAssembly |
| A C linker | | Rust needs one for build scripts, even when targeting WASM |
| Chrome or Edge | current | Runs the Browser Version (`pnpm dev`) |

`wasm-pack` is installed by `pnpm install`; you don't need it globally.

Rust must come from **rustup**, not from an OS package manager or Homebrew's
`rust` formula, because only rustup can add the WASM target.

## Setup

### Windows

Run the commands below in **Git Bash** (it comes with
[Git for Windows](https://git-scm.com/download/win)).

1. Install the **C++ build tools**: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/),
   with **Desktop development with C++** ticked. Skip this if Visual Studio with
   C++ is already installed.
2. Install **Node.js 26** from [nodejs.org](https://nodejs.org/).
3. Install **rustup**, from PowerShell with `winget install Rustlang.Rustup`, or
   by running `rustup-init.exe` from [rustup.rs](https://rustup.rs/) and
   accepting the default (MSVC) install.
4. **Open a new Git Bash window** so it picks up the new PATH. (There is no
   `~/.cargo/env` to `source` on Windows; if `rustup` still isn't found, run
   `export PATH="$HOME/.cargo/bin:$PATH"`.)
5. Check the toolchain is **MSVC**: `rustup show` should name one ending in
   `-pc-windows-msvc`. If it says `-pc-windows-gnu` (common when Rust was
   installed some other way first), switch, and add the WASM target again,
   since targets are per toolchain:
   ```bash
   rustup default stable-msvc
   rustup target add wasm32-unknown-unknown
   ```
   The browser build works on either, which hides the problem until
   `pnpm desktop:dev` fails with `dlltool.exe: program not found`.
6. Continue with [Every platform](#every-platform).

### macOS

1. Install the **Xcode Command Line Tools**, which provide the linker:
   `xcode-select --install`
2. Install **Node.js 26**, from [nodejs.org](https://nodejs.org/) or a version
   manager such as [fnm](https://github.com/Schniz/fnm) (`fnm install 26`).
3. Install **rustup**:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source "$HOME/.cargo/env"
   ```
4. Continue with [Every platform](#every-platform).

### Linux

1. Install a **C toolchain** and `curl`, e.g. on Debian or Ubuntu:
   `sudo apt install build-essential curl`
2. Install **Node.js 26**, from [nodejs.org](https://nodejs.org/) or a version
   manager such as [fnm](https://github.com/Schniz/fnm) (`fnm install 26`).
3. Install **rustup**:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source "$HOME/.cargo/env"
   ```
4. Continue with [Every platform](#every-platform).

### Every platform

From a terminal (Git Bash on Windows):

```bash
git clone https://github.com/adrianeyre/soundcheck.git
cd soundcheck

# pnpm, at the version this repo pins
npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"

rustup target add wasm32-unknown-unknown
pnpm install
pnpm htdemucs:export   # optional: Stem Separation's model, into model/
pnpm dev
```

`pnpm htdemucs:export` makes the model Stem Separation needs,
`model/htdemucs.onnx`, once. It needs Python 3.11 to 3.14 and about 2 GB of
disk ([Stem Separation](#stem-separation)). `model/` is gitignored, and
both `pnpm dev` and the Desktop App look there first, so they install it
without asking. Skip it and Stem Separation asks for the file the first time
instead. To write it somewhere else, name a folder:
`pnpm htdemucs:export ~/Models`.

Open the URL `pnpm dev` prints (`http://localhost:5145`) in Chrome or Edge on
**the same machine**. Web MIDI and AudioWorklet only work on `localhost` or
HTTPS, so browsing to the dev server from another computer by IP address won't
play sound. Allow MIDI access when Chrome asks.

To check everything is working: `rustup target list --installed` lists
`wasm32-unknown-unknown`, and the page shows **Audio Engine 0.1.0** and, after
**Start audio**, a stats table with **Voices sounding** above 0.

## The desktop app (Windows)

The desktop app is the React UI in a Tauri window. The Audio Engine runs in
the app's own Rust process, on the audio device through
[cpal](https://github.com/RustAudio/cpal), and MIDI keyboards are read natively
through [midir](https://github.com/Boddlnagg/midir), so notes go straight to
the engine.

### What else you need

On top of [the setup above](#windows):

- **WebView2**, which Tauri draws the UI with. Windows 10 (since April 2018)
  and Windows 11 already have it. If not, install the *Evergreen Bootstrapper*
  from [Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/).
- The **C++ build tools** and **rustup (MSVC)** from the Windows setup are
  Tauri's other [prerequisites](https://v2.tauri.app/start/prerequisites/#windows);
  nothing more is needed.

### Run it

From Git Bash, at the repo root:

```bash
pnpm install
pnpm desktop:dev      # builds everything and opens the app
pnpm vst3:build       # the VST3 helper, which the installer bundles (see VST3 Plugins below)
pnpm desktop:build    # a release build, target/release/soundcheck-desktop.exe, and its installer
```

`pnpm desktop:dev` starts the same Vite dev server as `pnpm dev` and points the
window at it, so UI changes reload live; changes to `desktop/` or `engine/`
rebuild and restart the app. It runs `pnpm dev` itself, so don't also run `pnpm dev` in another
terminal: the two engine builds fight over `engine/pkg/`, and the second Vite
server moves to another port while the window still loads
`http://localhost:5145`.

**Settings → Audio** chooses the **audio host** and **buffer size** the song
plays through. The choice is kept on this machine, and changing it while audio
runs starts it again on the new one, with no restart of the app. Beside it is
what the stream actually got: the host and device, the sample rate, and the
frames per buffer, with the latency they make; a host can round the size asked
for, or ignore it (see below).

The **Latency test** (Settings → Diagnostics) works as in the browser, with a **Buffer size** to
choose (the one from Settings → Audio, or 256 frames at 48 kHz) in place of the latency hint. The
stats show the buffer size requested and the one granted, the output latency
where Windows reports it, and **late callbacks**: callbacks whose render took
longer than the audio they rendered lasts.

### Low latency: ASIO

By default the app plays through **WASAPI in shared mode**, and there Windows
decides the buffer: cpal's WASAPI backend always calls back once per device
period, usually 10 ms (480 frames at 48 kHz), whatever size is asked for.
Asking for 256 frames only changes how much audio is queued. To get below
Windows' period you need an audio interface with an **ASIO** driver, and a
build with ASIO support:

1. Download the **ASIO SDK** from [Steinberg](https://www.steinberg.net/developers/)
   and unzip it, e.g. to `C:\SDKs\asiosdk`.
2. Install **LLVM** (for `bindgen`): `winget install LLVM.LLVM`, then open a
   new terminal.
3. Point the build at the SDK and build with the `asio` feature:
   ```bash
   export CPAL_ASIO_DIR="C:\SDKs\asiosdk"
   pnpm desktop:dev --features asio
   ```
4. In **Settings → Audio**, choose **Audio host: ASIO**, then the smallest
   buffer size that plays without late callbacks (the Latency test in
   Settings → Diagnostics counts them).

The ASIO SDK's licence doesn't allow it to be redistributed, so it isn't in
this repo, and no release is built with the `asio` feature. CI's Windows
`desktop` job runs Clippy on it, so it keeps compiling: without
`CPAL_ASIO_DIR`, cpal's `asio-sys` downloads the SDK from Steinberg into the
temp folder itself, and the runner has LLVM.

**WASAPI exclusive mode isn't offered.** It would take the device for the app
alone and let it choose its own period, but cpal, which the app plays through,
opens WASAPI in shared mode only: neither the version in `Cargo.lock` (0.18.2)
nor its latest release exposes exclusive mode, and the app doesn't drive WASAPI
itself. For low latency on Windows, use ASIO.

### Recording audio, and lining it up

Add an Audio Track, choose its **Input** (an input device on the same audio
host as the output, and one of its channels or a stereo pair), **Arm** it
and check its level meter, then **Record audio**: the song plays and the
take becomes a new Audio Clip, saved into the Project folder's `audio/` when
the Project is saved. One undo removes it.

The Input is saved with the Track. On a multi-input interface, arm several
Tracks on different channels of the same device (say a vocal on Mono 5 and a
keyboard on Stereo 3/4) and one Record takes them all at once, from one input
stream, as one undo step. Tracks on different devices can't be armed
together. A mono channel is recorded on both sides; the default, and what a
Project from before Inputs records, is the device's first two channels (its
only one on both sides if it is mono). The channel list is what the device
opens with at 48 kHz (or its default configuration); on ASIO that is every
input the driver offers. The browser dev host has no audio recording, so it
has no Input picker; a saved Input is kept as it is.

**Monitor** a Track to hear its Input through the Track's Effects while it is
armed (**Input Monitoring**, saved with the Track). Use headphones: through
speakers the monitored sound can feed back into the microphone. The take is
still the dry Input, and nothing monitored reaches an export. The captured
input reaches the output through a lock-free ring buffer
(`desktop/src/monitor.rs`) that holds one input and one output callback of
audio, 256 frames (5.3 ms) at 128-frame buffers and 48 kHz, on top of the
driver's own latency, and never more than twice that: a lower buffer size in
Settings lowers it. If the input falls behind, the output plays silence for
that callback and waits for the buffer to fill again, rather than repeating
old audio. Monitoring needs the input at the output's sample rate, and
restarting the output (a new host or buffer size) while armed stops it until
the Track is armed again. The browser dev host doesn't monitor.

A take is placed where it was played. The input and output streams each
report their latency to cpal, and the take is lined up from those
(`desktop/src/recorder.rs`, `engine/src/audio_recording.rs`). What a driver
doesn't report, such as its converters, is the **Offset (ms)**, measured once
per machine and interface with a loopback and kept between sessions:

1. Connect the output to the input with a cable (line out into line in, or
   the headphone jack into the line or mic input, levels down). A microphone
   against a speaker works too, but adds about 3 ms per metre of air.
2. Start audio, set the tempo to 120, turn the metronome on, and set the
   Offset to 0.
3. Add an Audio Track, choose the input, Arm it, and check the meter shows
   the clicks without clipping.
4. With the transport at the start of the song, **Record audio** for a few
   bars, then stop. The take starts at the song's start.
5. Save the Project and open `audio/Audio 1 take.wav` in an audio editor
   such as Audacity. At 120 bpm a click should start every 0.500 s:
   measure how far after 0.500, 1.000, 1.500 s… each click's first edge is.
   Their average, in ms, is the latency the driver doesn't report (negative
   if the clicks are early).
6. Enter it as the Offset, undo the take, and record again: every click
   should now start within a millisecond or two of its beat. Put the
   figures (interface, host, buffer size, measured offset, remaining error)
   in the PR or ADR that asks for them.

`desktop/tests/recording_loopback.rs` runs the same loopback in software,
with made-up latencies, so CI checks the compensation without a device.

### The installer

On Windows, `desktop/tauri.windows.conf.json` turns bundling on, so
`pnpm desktop:build` also leaves an NSIS installer,
`target/release/bundle/nsis/Soundcheck_<version>_x64-setup.exe` (#73,
[ADR 0009](docs/architectural-decision-record/0009-an-nsis-installer-signed-with-whichever-secret-is-set.md)).
It installs for the current user, into `%LOCALAPPDATA%\Soundcheck`, with no
administrator prompt: a Start menu entry, an optional desktop shortcut, and
an uninstaller in *Settings → Apps*. On a machine without WebView2 it fetches
it. Installing a newer version over an older one upgrades it in place.

CI builds it on each push to `main` and keeps it as the `soundcheck-windows`
workflow artifact. It is unsigned until the maintainer adds a signing secret
(below), and Windows' SmartScreen warns about an unsigned download: **More
info → Run anyway** installs it.

### Signing the installer

Tauri signs the app, the installer and its uninstaller by running
`scripts/sign-windows.ts` on each. The script signs through **Azure Artifact
Signing** (formerly Trusted Signing) when its secrets are set, else with a
**PFX certificate** when those are, and otherwise leaves them unsigned and
says so, which is what happens on a fork, on a pull request and on your own
machine. Half a set of either fails the build, naming what is missing.
`node scripts/sign-windows.ts --how` says which it would do.

For CI, add these as repository secrets (*Settings → Secrets and variables →
Actions → New repository secret*). Locally, set them as environment
variables before `pnpm desktop:build`.

**Azure Artifact Signing** (recommended: US$9.99 a month; ADR 0009 says why a
PFX can't be publicly trusted any more). The account needs a paid Azure
subscription, and a public certificate needs an individual in the USA or
Canada, or an organisation in one of the countries Microsoft lists.

| Secret | What it is, and where it comes from |
| --- | --- |
| `AZURE_ARTIFACT_SIGNING_ENDPOINT` | The account's region's endpoint, e.g. `https://weu.codesigning.azure.net`. Create an **Artifact Signing account** in the [Azure portal](https://portal.azure.com/) (register the `Microsoft.CodeSigning` resource provider first); its *Overview* shows the endpoint. |
| `AZURE_ARTIFACT_SIGNING_ACCOUNT` | That account's name. |
| `AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE` | The name of a **Public Trust** certificate profile in it, made once Microsoft has validated your identity (*Identity validations → New identity*; 1 to 20 business days). See Microsoft's [quickstart](https://learn.microsoft.com/azure/artifact-signing/quickstart). |
| `AZURE_TENANT_ID` | *Microsoft Entra ID → App registrations → New registration*: register an app for CI. Its *Overview* shows the **Directory (tenant) ID**… |
| `AZURE_CLIENT_ID` | …and the **Application (client) ID**. |
| `AZURE_CLIENT_SECRET` | *Certificates & secrets → New client secret* on that app registration. Then, on the Artifact Signing account, *Access control (IAM) → Add role assignment*: give the app the **Artifact Signing Certificate Profile Signer** role, and nothing else. The secret expires: renew it before then. |

CI installs [`artifact-signing-cli`](https://github.com/levminer/trusted-signing-cli)
when these are set. Locally, you need it (`cargo install artifact-signing-cli`),
the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli-windows),
the .NET 8 runtime and the Windows SDK's signtool.

**A PFX certificate**, for a self-signed or company-internal certificate, or
an older exportable one. Since June 2023 no certificate authority issues a
publicly trusted code-signing certificate as a file, so this doesn't stop
SmartScreen's warning for the public.

| Secret | What it is, and where it comes from |
| --- | --- |
| `WINDOWS_CERTIFICATE` | The `.pfx`, base64: `base64 -w0 certificate.pfx` in Git Bash, or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx"))` in PowerShell. |
| `WINDOWS_CERTIFICATE_PASSWORD` | Its password. |

It is timestamped by `http://timestamp.digicert.com`; set `WINDOWS_TIMESTAMP_URL`
for another. Locally it uses the newest signtool in the Windows SDK, or
`SIGNTOOL_PATH`.

With neither, the installer is unsigned and CI's `desktop-release` job leaves
a notice, "Windows installer not signed"; everything else stays green.

**Checking it by hand**, on Windows, with the installer from the
`soundcheck-windows` artifact: ADR 0009's [To confirm](docs/architectural-decision-record/0009-an-nsis-installer-signed-with-whichever-secret-is-set.md#to-confirm)
lists what to try. Signed, the installer's *Properties → Digital Signatures*
names the publisher, and `signtool verify /pa /v` passes on it, on the
installed `soundcheck-desktop.exe` and on its `uninstall.exe`.

### On Linux

The desktop app builds, tests and packages on Linux too (#71); CI runs its
tests on Ubuntu as well as Windows. It plays through **ALSA** by default
(PipeWire and PulseAudio serve ALSA clients too), or through **JACK** (below).
Linux isn't a supported desktop yet (v4).

**Build it.** On top of [the Linux setup](#linux), install the libraries Tauri's
webview and GTK, cpal and midir build against (JACK's headers too), and
`file`, which the AppImage bundler runs (Debian or Ubuntu names):

```bash
sudo apt install libwebkit2gtk-4.1-dev libasound2-dev libjack-jackd2-dev libxdo-dev libssl-dev librsvg2-dev file
pnpm install
cargo test -p soundcheck-desktop   # the host's tests; no audio device needed
pnpm desktop:dev                   # run it, with live reload
pnpm vst3:build                    # the VST3 helper, which the packages bundle (needs CMake)
pnpm desktop:build                 # the release build and the two packages
```

**The packages.** `desktop/tauri.linux.conf.json` turns bundling on for Linux
only, so `pnpm desktop:build` leaves, in `target/release/bundle/`:

- `deb/Soundcheck_<version>_amd64.deb`, for Debian and Ubuntu:
  `sudo apt install ./Soundcheck_<version>_amd64.deb` puts `soundcheck-desktop`
  on the PATH and Soundcheck in the app menu. It depends on
  `libwebkit2gtk-4.1-0`, `libgtk-3-0` and `libasound2`, which apt installs.
- `appimage/Soundcheck_<version>_amd64.AppImage`, for any recent x86-64 distro:
  `chmod +x` it and run it. It carries its own WebKitGTK and GTK, but uses
  the system's ALSA library (`libasound.so.2`, on practically every desktop),
  and mounting it needs FUSE; without FUSE (e.g. in a container), run it with
  `--appimage-extract-and-run`. Building it needs no FUSE: the bundler
  downloads linuxdeploy on the first build and runs it extracted.

Neither package needs JACK: the deb recommends `libjack-jackd2-0` (or
`libjack0`, or `pipewire-jack`), and the app loads libjack only when JACK is
chosen.

**Low latency: JACK and PipeWire.** Every Linux build offers **JACK** as a
second audio host in Settings → Audio, beside ALSA. JACK runs at its server's
buffer size and sample rate, whatever the app asks for, so set them there
(Settings → Audio shows what it got):

- **PipeWire** (the default on current Ubuntu, Fedora and Debian desktops)
  serves JACK clients through its JACK layer: install `pipewire-jack`
  (`pipewire-audio-client-libraries` on older Ubuntu). On Debian and Ubuntu,
  point the system's libjack at PipeWire's with
  `sudo cp /usr/share/doc/pipewire/examples/ld.so.conf.d/pipewire-jack-*.conf /etc/ld.so.conf.d/ && sudo ldconfig`,
  or start the app under `pw-jack soundcheck-desktop`. The buffer is
  PipeWire's quantum: `pw-metadata -n settings 0 clock.force-quantum 128` sets
  it to 128 frames until the next restart (0 goes back to the default).
- **JACK itself** (`jackd2`): start the server first, e.g. with QjackCtl or
  `jackd -d alsa -r 48000 -p 128`, choosing the period (buffer) there.

The app doesn't start a JACK server of its own. With none running (or no
libjack installed), starting audio on JACK says so beside the choice, and ALSA
still works. The app's output connects to the system playback ports on its
own; its input, to the capture ports.

Either way, the Claude API key is kept through the **Secret Service**
(GNOME Keyring, KWallet or KeePassXC), so one must be running to save it.
CI builds both packages on each push to `main` and keeps them as the
`soundcheck-linux` workflow artifact.

The packages aren't signed for the distributions, but both **update
themselves** from a Release ([below](#releases-and-updates)); updating the
.deb asks for your password. On Windows, `pnpm desktop:build` makes an
installer instead ([above](#the-installer)), and on macOS an app and a disk
image ([below](#on-macos)).

### On macOS

The desktop app builds, tests and packages on macOS too (#72,
[ADR 0010](docs/architectural-decision-record/0010-the-mac-app-is-signed-ad-hoc-or-with-a-developer-id-and-notarised.md)),
for **Apple silicon** (M1 and later) on **macOS 13.4 or later**. It plays and
records through **CoreAudio**, and reads MIDI through CoreMIDI. Intel Macs
aren't supported: ONNX Runtime, which Stem Separation links, has no prebuilt
build for them, and macOS 26 is the last macOS for them anyway.

**Build it.** On top of [the macOS setup](#macos), nothing more is needed:
the Xcode Command Line Tools are all Tauri [asks for](https://v2.tauri.app/start/prerequisites/#macos).

```bash
pnpm install
cargo test -p soundcheck-desktop   # the host's tests; no audio device needed
pnpm desktop:dev                   # run it, with live reload
pnpm desktop:build                 # the release build, the app and a disk image
```

**The app and the disk image.** `desktop/tauri.macos.conf.json` turns
bundling on for macOS only, so `pnpm desktop:build` leaves, in
`target/release/bundle/`, `macos/Soundcheck.app` and
`dmg/Soundcheck_<version>_aarch64.dmg`. Open the disk image and drag
Soundcheck into Applications.

The first time Soundcheck opens an audio input, macOS asks whether it may
use the microphone (the answer is kept in *System Settings → Privacy &
Security → Microphone*); until it may, it records silence. The Claude API key
is kept in the login keychain.

**Unsigned, it is signed ad hoc.** Built with no Apple secret (on your own
Mac, a fork or a pull request), the app is signed ad hoc, which is what lets
Apple silicon run it at all. It opens on the Mac that built it, but macOS
stops a downloaded copy, such as CI's, as from an unidentified developer.
Open it once, then *System Settings → Privacy & Security → Open Anyway*
(on macOS 14, Control-click it in Finder and choose **Open**). CI builds the
disk image on each push to `main` and keeps it as the `soundcheck-macos`
workflow artifact. Signed with a Developer ID and notarised, it opens without
asking: see [below](#signing-and-notarising-the-mac-app).

### Signing and notarising the Mac app

Tauri signs the app, under the hardened runtime, and notarises it by itself,
from `APPLE_*` variables. `scripts/sign-macos.ts` runs the build with them
(`node scripts/sign-macos.ts -- pnpm desktop:build`), dropping the empty ones
GitHub gives for secrets it doesn't have, and `--notarise` then notarises the
disk image, which Tauri doesn't. With the certificate and one way of
notarising, the app is signed with your **Developer ID** and **notarised**;
with none, it is signed **ad hoc** ([above](#on-macos)). Half a set fails,
naming what is missing, and a certificate with no way of notarising counts as
half: Gatekeeper turns a Developer ID app away unless it is notarised.
`node scripts/sign-macos.ts --how` says which it would do.

For CI, add these as repository secrets (*Settings → Secrets and variables →
Actions → New repository secret*). Locally, on a Mac, set them as environment
variables and run `node scripts/sign-macos.ts -- pnpm desktop:build`.

All of it needs a membership of the **Apple Developer Program**, US$99 a
year, as an individual or an organisation (which needs a D-U-N-S number).

**The certificate**:

| Secret | What it is, and where it comes from |
| --- | --- |
| `APPLE_CERTIFICATE` | A **Developer ID Application** certificate and its private key, as a base64 `.p12`. Only the team's Account Holder can make one: in Xcode, *Settings → Accounts → Manage Certificates → + → Developer ID Application*; or at [developer.apple.com](https://developer.apple.com/account/resources/certificates/add), with a certificate request from Keychain Access. Then in Keychain Access, under *My Certificates*, right-click it, *Export*, as `.p12` with a password, and `base64 -i certificate.p12 \| pbcopy`. It lasts five years. |
| `APPLE_CERTIFICATE_PASSWORD` | The password it was exported with. |
| `APPLE_SIGNING_IDENTITY` | Optional: the certificate's name, `Developer ID Application: <name> (<team ID>)` (`security find-identity -v -p codesigning` lists it). Without it, the certificate is used if it is a Developer ID Application one. On a Mac with the certificate in its keychain, this alone stands in for the two above. |

**Notarising**, with an App Store Connect API key (recommended: it belongs to
the team, not a person, and needs no password):

| Secret | What it is, and where it comes from |
| --- | --- |
| `APPLE_API_KEY` | In [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api), *Users and Access → Integrations → Team Keys → +*, with the **Developer** role: its **Key ID**. |
| `APPLE_API_ISSUER` | The **Issuer ID** shown above the keys. |
| `APPLE_API_PRIVATE_KEY` | The contents of the `AuthKey_<Key ID>.p8` it lets you download, once: `pbcopy < AuthKey_<Key ID>.p8`. Locally, `APPLE_API_KEY_PATH` can name the file instead. |

**Or notarising with an Apple Account**:

| Secret | What it is, and where it comes from |
| --- | --- |
| `APPLE_ID` | The Apple Account's email, a member of the team. |
| `APPLE_PASSWORD` | An **app-specific password** for it, from [account.apple.com](https://account.apple.com/) → *Sign-In and Security → App-Specific Passwords*, not the account's own password. |
| `APPLE_TEAM_ID` | The team's ID, in *Membership details* at [developer.apple.com](https://developer.apple.com/account). |

If both are set, the API key is used. With neither set, nor the
certificate, the app is signed ad hoc and CI's `desktop-macos` job leaves a
notice, "Mac app not signed"; everything else stays green.

CI keeps the disk image as the `soundcheck-macos` workflow artifact, after
checking the app's signature and, when signed, that Gatekeeper accepts the
app and the disk image as notarised, with their tickets stapled.
**Checking it by hand**, on a Mac, with that disk image: ADR 0010's
[To confirm](docs/architectural-decision-record/0010-the-mac-app-is-signed-ad-hoc-or-with-a-developer-id-and-notarised.md#to-confirm)
lists what to try.

### Releases and updates

The installed Desktop App **updates itself** (#74,
[ADR 0011](docs/architectural-decision-record/0011-the-desktop-app-updates-itself-from-the-latest-github-release.md)),
through [Tauri's updater](https://v2.tauri.app/plugin/updater/): the Windows
installer, the Mac app, the AppImage and the .deb. *Settings → Updates* shows
the version running, **Check for updates** asks the latest GitHub Release
whether there is a newer one, and **Install and restart** downloads it,
installs it and opens the new version (asking first if the Project has
unsaved changes). Unless *Check for a newer version when Soundcheck starts*
is turned off, it asks at each start too, and a notice says when one is out.
A development build, a binary built from source and the Browser Version
don't update themselves; Settings says why.

The app asks
`https://github.com/adrianeyre/soundcheck/releases/latest/download/latest.json`,
which names the newest version and each platform's package, and installs a
package only if it is **signed by the updater's key for that version**. The
key's public half is built into the app, as `plugins.updater.pubkey` in
`desktop/tauri.conf.json`; its private half is a secret only CI has.

**Until the maintainer makes the key, nothing updates itself**: the public
key is empty, Settings says the build can't update itself, and builds and
Releases go on without update packages, saying so. To make it, once, on
your own machine:

```bash
pnpm exec tauri signer generate -w ~/.tauri/soundcheck.key
```

It asks for a password (use one, and keep it in a password manager), and
writes the private key, `~/.tauri/soundcheck.key`, and the public key beside
it, `soundcheck.key.pub`. Then:

1. Add the repository secrets (*Settings → Secrets and variables → Actions →
   New repository secret*):

   | Secret | What it is, and where it comes from |
   | --- | --- |
   | `TAURI_SIGNING_PRIVATE_KEY` | The contents of `~/.tauri/soundcheck.key` (a line of base64): `cat ~/.tauri/soundcheck.key`, or `pbcopy < ~/.tauri/soundcheck.key` on a Mac. |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you gave it. Leave it out if you gave none. |

2. Paste the contents of `soundcheck.key.pub` (also a line of base64) into
   `plugins.updater.pubkey` in `desktop/tauri.conf.json`, and commit that.
   The public key isn't a secret. Builds made from then on update
   themselves; copies built before it don't, so their users install the
   first signed version by hand, once.

3. **Back the private key up**, with its password, somewhere other than your
   machine. Lost, no installed copy can ever be updated again: each must be
   reinstalled by hand from a Release built with a new key. Leaked, whoever
   has it can sign an update every installed copy takes: make a new key and
   ship it the same way.

`node scripts/updater.ts --how` says whether a build would sign its update
packages. With the key and the public key, `pnpm desktop:build` also leaves
each platform's update package and its `.sig` in `target/release/bundle/`;
with neither it builds as before; with the key but no public key, or the
password but no key, it fails, naming what is missing. Locally, set the two
secrets as environment variables to sign.

**Making a Release.** Merge a pull request into `main`: releases are made by
[semantic-release](https://github.com/semantic-release/semantic-release), from
the [Conventional Commits](https://www.conventionalcommits.org) merged since
the last one, so nobody sets a version or pushes a tag. `.github/workflows/release.yml`
runs on every push to `main`:

1. **Verify:** the same checks as a pull request (`ci.yml`), on what was
   merged.
2. **Release:** semantic-release (`.releaserc.json`) works out the version.
   `feat:` makes a minor version; `fix:`, `perf:`, `refactor:`, `revert:` and
   `build:` a patch; a `!` after the type, or a `BREAKING CHANGE:` footer, a
   major. `docs:`, `test:`, `chore:`, `ci:` and `style:` make none, and then
   nothing below it runs but the Browser Version's deploy. With a version,
   it puts it in the root `package.json` (`desktop/tauri.conf.json` takes its
   version from there), writes `CHANGELOG.md`, commits both to `main` as
   `chore(release): <version> [skip ci]`, tags `v<version>`, and makes a
   **draft** GitHub Release with the notes. It also comments on the pull
   requests and issues it released.
3. **Build:** the Windows installer, the Mac app and disk image, and the
   Linux packages, from that tag, signed with whichever secrets are set.
4. **Publish:** it checks every update package's signature against the
   committed public key and the version, as the app will, and writes
   `latest.json`. Then it puts the installers, the update packages and
   `latest.json` on the draft, and publishes it, so the latest Release never
   lacks them.
5. **Pages:** the Browser Version, built from `main` with the new version,
   deployed to GitHub Pages.

A version with a `-`, such as `1.1.0-rc.1`, is a pre-release, which installed
copies don't update to. A Release made while the public key is committed but
a package isn't signed by its key fails rather than announcing an update no
copy would take. One made with no key yet has no `latest.json`, and a notice,
"No auto-update", says so. `main` must let GitHub Actions push the version
commit and the tag: under branch protection, allow `github-actions[bot]` to
bypass it.

**Checking it by hand**, on each platform: ADR 0011's
[To confirm](docs/architectural-decision-record/0011-the-desktop-app-updates-itself-from-the-latest-github-release.md#to-confirm)
lists what to try. It needs two signed Releases: install the older, then
update to the newer from Settings.

### Stem Separation

The desktop app can separate audio into four **Stems** (drums, bass, other,
vocals) with **htdemucs** on ONNX Runtime, on the CPU (ADR 0005). The model is
never downloaded or bundled, as its weights are for personal use only: you
export `htdemucs.onnx` once, on your own machine, and install it from that file.
The app checks its shapes and copies it to `models/htdemucs.onnx` in its
app-data folder, outside any Project. The Browser Version separates Stems too,
with the same model ([below](#stem-separation-in-the-browser-version)).

**Exporting the model.** The export is in this repo, in
[`tools/htdemucs-onnx/`](tools/htdemucs-onnx/README.md): the part of
[Mixxx's fork of Demucs](https://github.com/mixxxdj/demucs) it needs, so there
is nothing to clone. With Python 3.11 to 3.14, from the repo's root:

```sh
pnpm htdemucs:export              # writes model/htdemucs.onnx, in the repo
pnpm htdemucs:export ~/Models     # or anywhere else
```

It runs `tools/htdemucs-onnx/export.sh` on Linux and macOS and `export.ps1`
on Windows, which you can run yourself with the same optional folder.
`model/` is gitignored. **The Desktop App and `pnpm dev` look there first**:
the first time you separate, they install `model/htdemucs.onnx` without
asking (still checking it's htdemucs). If it isn't there, or isn't htdemucs,
they ask you for the file, saying why. The Desktop App also looks in `model/`
beside the app itself. GitHub Pages never has the model, as the weights
mustn't be published, so there it always asks. It makes a Python venv
in `tools/htdemucs-onnx/.venv` (about 1 GB, PyTorch for the CPU), downloads
Meta's htdemucs weights (about 80 MB, into PyTorch's cache,
`~/.cache/torch/hub/checkpoints/`), writes `htdemucs.onnx` (about 300 MB) and
checks its shapes. Keep the file to yourself. Once you've installed it you can
delete the venv and the cached weights.

Right-click an Audio Clip and choose **Separate into Stems**: the stretch the
Clip plays is separated in the background, one at a time. A card in the centre
of the screen, with a spinner, says what it's doing (reading the audio, loading
the model, separating, making the Stems), how far it has got and roughly how
long is left, with a Cancel; you can keep editing around it. Then its four
Stems land on new Audio Tracks under its Track, `<Clip> – Vocals`, `– Drums`,
`– Bass` and `– Other`, in place of the Clip. One undo puts
the Clip back. The first time, it offers to install the model from a file.

**File → Import as Stems…** does the same for a whole WAV, FLAC or MP3 file
that isn't in the Project: its four Stems land on new Audio Tracks at the end of
the Track list, `<file> – Vocals` and so on, each from the playhead. Only the
Stems are copied into the Project, not the file. One undo removes all four.

The Assistant can do the same inside a Request (`separate_stems`), keeping only
the Stems it asks for (“pull the vocals out of take 1”). The Request box shows
the progress and a Cancel while it waits. The Assistant never installs the
model: until you have, the call fails and nothing changes.

**Building it downloads ONNX Runtime.** The `ort` crate fetches its prebuilt
binaries (about 100 MB unpacked, over rustls: no OpenSSL needed) into
`~/.cache/ort.pyke.io` the first time `desktop/` builds, so that build needs
the network. Its Linux build needs **glibc 2.38 or later** (Ubuntu 24.04,
Debian 13) to link. On an older Linux, link Microsoft's own build instead:

```bash
curl -L https://github.com/microsoft/onnxruntime/releases/download/v1.28.0/onnxruntime-linux-x64-1.28.0.tgz | tar xz -C ~/.local
export ORT_LIB_LOCATION=~/.local/onnxruntime-linux-x64-1.28.0/lib ORT_PREFER_DYNAMIC_LINK=1
export LD_LIBRARY_PATH=$ORT_LIB_LOCATION   # to run what that builds
```

**The real model's test.** The tests use tiny fake models of their own. One
ignored test separates with your `htdemucs.onnx` and checks the four Stems sum
close to the input:

```bash
SOUNDCHECK_HTDEMUCS=/path/to/htdemucs.onnx cargo test --release -p soundcheck-desktop real_htdemucs -- --ignored --nocapture
```

Add `SOUNDCHECK_SONG=/path/to/song.wav` to separate a song of yours rather
than test tones. On the Linux dev VM (16 cores) it installs in 1.1 s and
separates 20 s of audio in 9.5 s.

### VST3 Plugins

The desktop app hosts **VST3 Plugins**, as Effects in any Insert Chain and as
a Track's Instrument (#70,
[ADR 0008](docs/architectural-decision-record/0008-vst3-plugins-run-in-a-helper-process.md),
proposed). Each one runs in a process of its own, `soundcheck-vst3-host`, so
a Plugin that crashes or hangs costs only its own sound: an Effect passes the
audio through untouched and an Instrument goes silent, it says it crashed,
and **Reload** starts it again from its last saved or fetched state.

- **Settings → VST3 Plugins** lists what the scan found in the platform's
  VST3 folders (on Windows, `%COMMONPROGRAMFILES%\VST3` and
  `%LOCALAPPDATA%\Programs\Common\VST3`) and any folders you add, what it
  couldn't read and why, and **Rescan**.
- Add an Effect from an Insert Chain's list, where it is marked *(VST3)*,
  or an Instrument as a new Track, **Add <Plugin> Track** in the Tracks
  menu or among the Instruments a new Track can play. It is loaded first,
  so a licence dialog it opens comes up then (loading allows a minute), and
  it starts at its own defaults.
- **Open <Plugin>'s window** shows the Plugin's own window, titled
  *<Track>: <Plugin>*, on Windows only so far. What you turn there is
  recorded in the Project as one undo step when you let go. Its settings are
  drawn in Soundcheck too, where it exposes any.
- Its state is saved in the Project (`project.json`, base64, at most 16 MB
  each) whenever the Project is saved. A Project with a VST3 Plugin that
  isn't installed keeps it exactly, marked **missing**; install it and
  Rescan to hear it again.
- **The Assistant** changes only the settings a Plugin exposes for
  automation, from 0 to 1, and never its state. Only you add a VST3 Plugin.

**Building the helper.** It is C++, built with CMake (3.25 or later) against
Steinberg's VST3 SDK, which CMake fetches with git at the tag
`desktop/vst3-host/CMakeLists.txt` pins; nothing it builds is committed. On
Windows, the Visual Studio Build Tools' *Desktop development with C++*
includes CMake; if `cmake --version` isn't found in Git Bash, install it
(`winget install Kitware.CMake`) and open a new window. On Linux, `sudo apt
install cmake`. Then:

```bash
pnpm vst3:build                                    # the helper, the test Plugin and the SDK's examples, in desktop/vst3-host/build/
SOUNDCHECK_VST3_REQUIRE=1 cargo test -p soundcheck-desktop vst3   # the host's VST3 tests against them
```

`pnpm desktop:dev` finds the helper where `pnpm vst3:build` leaves it.
Without it, loading a VST3 Plugin fails and says to build it; everything
else works. `pnpm desktop:build` bundles it beside the app on Windows and
Linux, and fails, saying so, if it isn't built. The macOS build doesn't have
it yet (ADR 0008's slice 6), nor the Plugin's window on Linux: on macOS the
Desktop App offers no VST3 Plugins, and Settings and each VST3 Plugin in a
Project say *VST3 Plugins aren't supported on macOS yet*, keeping it as the
Browser Version does. The VST3
tests skip without it, unless `SOUNDCHECK_VST3_REQUIRE` is set, as CI's
`vst3` job sets it. `SOUNDCHECK_VST3_VERBOSE=1` shows what the helpers and
their Plugins print.

**Checking it by hand.** This needs Windows, a display and real Plugins,
some bought, so CI can't do it: ADR 0008's
[To confirm](docs/architectural-decision-record/0008-vst3-plugins-run-in-a-helper-process.md#to-confirm)
lists what to try (the scan, copy protection, the window, killing a helper
mid-song, 16 Plugins at 128 frames, saving and reopening, the installer).

VST is a registered trademark of Steinberg Media Technologies GmbH.

## The Browser Version

The same UI and Audio Engine as a web page, with nothing to install
([ADR 0006](docs/architectural-decision-record/0006-a-browser-version-beside-the-desktop-app.md)).
It is `pnpm build`'s `app/dist`, the build the Desktop App bundles too: Vite
builds it with a relative base, so it works under any folder of a site, and
`scripts/check-web-build.ts` fails the build if anything in it is named from
the site's root.

It is the lighter version. What you play is heard later (80 ms measured, ADR
0002), and it has no choice of audio host or buffer size, no recording and no
credential store; Project folders only in Chrome and
Edge; and no VST3 Plugins, which only the Desktop App
hosts: a Project with them keeps them exactly, bypassed or silent.
Its **Settings** page lists what it lacks, first, and links to the Desktop App.

### Stem Separation in the Browser Version

It separates Stems as the Desktop App does, with the same `htdemucs.onnx` you
export ([above](#stem-separation)) and the same menus, in a Web Worker, on
[ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) (ADR 0005,
ADR 0006). The chunking and cross-fading around the model is the engine's own
Rust, the same the Desktop App runs, so the two give the same Stems.

- **Which browsers.** It runs the model on the GPU through **WebGPU** where the
  browser has it: current Chrome, Edge and Firefox on Windows and macOS,
  Safari 26, and Chrome on ChromeOS and on Linux where its GPU and drivers
  allow ([the WebGPU implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)).
  Elsewhere it runs on the CPU in WebAssembly, which is only fast enough with
  WebAssembly threads, and those need the page to be cross-origin isolated.
  GitHub Pages can't send the headers for that, so the Browser Version
  registers [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker),
  a service worker that adds them: **the first visit reloads the page once**,
  and every visit after has threads, WebGPU or not. The Desktop App's window
  never registers it. A browser with neither WebGPU nor a service worker (a
  private window may refuse one) disables **Separate into Stems**, saying it
  needs the Desktop App; so does a machine that says it has under 4 GB of memory, or a
  private window with no storage. Separating takes about 3 GB of the tab's
  memory while it runs.
- **Where the model is kept.** The first time, it asks for the file; it
  checks the shapes and keeps a copy in the site's own storage in this
  browser, the Origin Private File System (IndexedDB where the browser can't
  write that), outside any Project. It asks the browser to keep it
  (`navigator.storage.persist()`); a browser that doesn't grant that may clear
  it when the disk is short, and you install it again. It is about 300 MB of
  the site's quota.
- **Removing it.** Clear the site's data: in Chrome or Edge, the padlock (or
  tune icon) beside the address → **Site settings** → **Delete data**; in
  Safari, **Settings → Privacy → Manage Website Data**; in Firefox, **Settings
  → Privacy & Security → Cookies and Site Data → Manage Data**. That clears the
  site's other data (Presets, the sample browser's folders, the API key) too.

The page never downloads the model: only the file you pick is read.

### Where it is deployed

CI's `web` job deploys it to **GitHub Pages** on each push to `main`, once
`lint`, `engine` and `app` pass. Pull requests never deploy. It needs no
secret, only Pages turned on:

1. In the repository, **Settings → Pages → Build and deployment → Source:
   GitHub Actions**.
2. Push to `main` (or re-run the latest CI run on it). The run's `web` job
   links to the site: `https://adrianeyre.github.io/soundcheck/`, unless
   Pages has a custom domain.

Until Pages is on (and on a fork), the `pages` job leaves a notice, "Browser
Version not deployed", and `web` is skipped; CI stays green. The build takes
the site's address from Pages, for the share tags, `robots.txt` and the
sitemap ([below](#search-engines-and-link-previews)).

The Assistant's API key is kept in the browser's local storage there, and on
`github.io` every Pages site of the same account shares one origin, so they
can all read it. A custom domain gives the Browser Version an origin of its
own.

### Checking it by hand

Nothing here plays sound in CI, so once it is deployed, in current Chrome or
Edge: the page loads from `/soundcheck/` with its icons; **Play** is heard;
a MIDI keyboard plays the Synth; a Project folder saves and opens again;
Settings lists what the Browser Version lacks; an Assistant Request with a
Claude key edits the song. In Firefox it plays, and **File → Save** says
Project folders need Chrome, Edge or the Desktop App.

Stem Separation in a browser has only been run against fake models, in Node:
the real model has never been run in a browser. With your `htdemucs.onnx`, in
Chrome or Edge on the Windows machine: **Separate into Stems** on a 3-minute
Clip offers to install the model; after choosing the file it installs (note
how long); it separates with progress (note how long, and the tab's memory in
the browser's task manager), and Cancel stops it at once; the four Stems sound
like the Desktop App's of the same Clip; after a reload it separates without
asking for the model again. Then the same in Firefox on Windows (WebGPU), and
in a browser without it (Firefox on Linux). On Pages that browser separates
on WebAssembly threads, since the service worker isolates the page: on the
first visit the page reloads once, and after that `crossOriginIsolated` in the
console is `true`. Check an Assistant Request still gets an answer and a Live
Session still connects with it in place. In a private window that refuses the
service worker, **Separate into Stems** is disabled there, saying it needs the
Desktop App.

## The Assistant

The **Assistant** edits your song when you ask it to: type a **Request** in the
Editor's Assistant box ("add a kick and a bass at 128"), and it makes the
change. Everything one Request changes is a single undo step, so **Undo** takes
all of it back.

A **Skill** is a ready-made Request for one kind of job, such as `/fix-clipping`
or `/drum-beat 124 bpm house`: type `/` in the Assistant box to pick one (the
arrow keys choose, Enter completes), or open **View skills** to read them, narrowed to one
category (Songwriting, Drums, Arrangement, Mixing, Mastering or Genres) if you like, one at
a time. Each lives in its own folder of [`skills/`](skills/README.md), which
says how to write one; a new folder is a new Skill, with no code to change.

It talks to the **Provider** you pick in **Settings → Assistant**: Claude (the default),
OpenAI, Google Gemini, xAI Grok, or a Local model served by Ollama or llama.cpp. For
Claude it needs your own API key, from
[the Anthropic Console](https://console.anthropic.com/settings/keys); OpenAI,
Gemini and Grok need theirs (Grok's from [the xAI Console](https://console.x.ai)). Local needs no key, only a server with a model that can
use tools (`ollama pull qwen3:8b`, say): it goes to Ollama at
`http://localhost:11434/v1` unless you give another base URL (llama.cpp's
`llama-server`, for one, serves `http://localhost:8080/v1`). Each Provider
keeps its own key, model, version, effort and gateway, so switching to another
and back loses nothing. The app asks for a key once and keeps it in the machine's credential store — Windows
Credential Manager on Windows, the login keychain on macOS — never in a Project, so a Project you share
carries no key. **Forget API key** removes it. Requests are billed to your key.

The Browser Version (and `pnpm dev`) has no credential store, so there it is
kept in the browser's local storage; on Linux the credential store is the Secret
Service, which needs a keyring daemon (`gnome-keyring` or KWallet) running.

The **Gateway** fields there can point any Provider at a gateway in front of its
API instead: a base URL and custom headers. The desktop app sends its requests
from Rust, trusting the certificates Windows trusts, so any gateway it can reach
works. The Browser Version sends them from the page, so there the gateway must
allow CORS from the page's origin (`http://localhost:5145` for `pnpm dev`,
`https://adrianeyre.github.io` for the deployed one) and answer the `OPTIONS`
preflight without asking for credentials; one that doesn't fails with "Claude
could not be reached: Connection error." The same goes for Local: start Ollama
with `OLLAMA_ORIGINS` naming that origin, and Chrome may ask before a site
reaches `localhost`.

## Search engines and link previews

`app/index.html` carries the page's description, Open Graph and X card tags
(the preview Slack, Teams and LinkedIn show for a shared link, with
`app/public/og-image.png`), structured data, the favicons and the web app
manifest. The build writes `robots.txt` and `sitemap.xml`. Previews and
crawlers need absolute URLs, so they are built from `VITE_SITE_URL`, which
defaults to `https://adrianeyre.github.io/soundcheck`; set it when deploying
anywhere else: `VITE_SITE_URL=https://example.com pnpm build`. CI's `web` job
sets it to the address GitHub Pages reports. The icons'
sources are in `app/brand/`.

## Commands

Run from the repo root:

| Command | What it does |
| --- | --- |
| `pnpm dev` | Builds the engine to WASM and serves the UI in the browser |
| `pnpm desktop:dev` | Runs the desktop app, with live reload |
| `pnpm vst3:build` | Builds the VST3 helper, with CMake, and the Plugins its tests load |
| `pnpm desktop:build` | Builds the desktop app, and its installer on Windows (on macOS, an app and a disk image; on Linux, a `.deb` and an AppImage), with signed update packages when the updater's key is set |
| `pnpm build` | Production build into `app/dist`: the Browser Version, and the UI the Desktop App bundles |
| `pnpm test` | Rust tests, then the WASM build, then the UI tests |
| `pnpm lint` | `cargo fmt --check`, `cargo clippy -D warnings`, `oxlint` |
| `pnpm typecheck` | TypeScript, against a fresh engine build |

`lint`, `typecheck`, `test` and `build` must all pass before a commit.

## Projects on disk

A Project is a folder, not a file:

```
Night drive/
  project.json    the Project itself: tempo, Tracks, Clips, notes, Effects
  audio/          the Project's own copy of every audio file it uses
```

Everything the Project names lives inside the folder, so a folder can be
moved, copied to another machine or shared and still opens with all its audio.
`project.json` carries the schema version it was saved with: an older one is
migrated forward when it opens, and one from a newer version of Soundcheck is
refused rather than half-read. Your Claude API key is kept by the machine's
credential store and is never written into a Project.

The desktop app reads and writes these folders through the native filesystem;
`pnpm dev` in Chrome or Edge can too, through the File System Access API.

A Shared Project's folder (below) also has `changes/`, one file per
Collaborator's copy, and `project.json` is the base those Changes start from.

## Collaboration

Several people can edit one Project, each on their own machine
([ADR 0007](docs/architectural-decision-record/0007-collaboration-by-an-ordered-log-of-changes.md),
proposed). Every copy applies everyone's Changes in the same order, so all of
them end with the same song. **Undo reaches only your own steps.** It is one
step back for a whole Assistant Request, even while someone else edits. It
leaves anything a Collaborator has changed since, and the song page says
what it left and who changed it. **Settings → Collaboration → Your name** is
the name the others see on your Changes.

There are two ways to collaborate, and they can be used together:

- **Through a folder, offline or live: File → Share this Project….** It
  makes the Project a Shared Project in its folder. Put that folder
  somewhere your Collaborators sync or share, such as OneDrive, Dropbox,
  iCloud Drive, Google Drive, Syncthing or a network drive, and each of them
  opens it there. Each copy writes its own Changes to its own file in
  `changes/` as they are made, and reads everyone else's every 2 seconds.
  So edits made days apart, offline, still meet, and no file ever has two
  writers for the sync service to conflict over. New audio is named after
  its content, so two people's `kick.wav` never collide. The title says
  *Shared*, and every edit is saved as it is made. Save only matters for a
  VST3 Plugin's state. The Desktop App and the Browser Version in Chrome
  and Edge can do this. No server is involved.
- **Live, through a Relay: File → Live Session….** *Start a Live Session*
  gives an invite link to send to whoever you want to edit with. It opens
  the Browser Version, in any current browser, with *Join* filled in, or can
  be pasted into *Join* in the Desktop App. Whoever joins is sent the
  Project and its audio, and each person's edits then reach the others
  within a moment. A dropped connection is retried, and both sides catch up
  when it is back. The link carries the session's key after the `#`, which
  browsers never send to a server. Everything is encrypted with that key,
  so the Relay can't read any of it. Anyone with the link can join, so a
  new session is the way to leave someone out. A joined Project isn't saved
  anywhere until you save it.

A Live Session needs a **Relay**: [`relay/`](relay/README.md), a small Rust
program that passes the sealed frames between members and stores nothing.
The repository variable `RELAY_URL` builds in the one Soundcheck starts
with, which is none until the maintainer runs one
([ADR 0012](docs/architectural-decision-record/0012-the-public-relay-runs-from-the-image-ci-publishes.md),
proposed). **Settings → Collaboration → Relay address** points your copy at
any other. Joining from a link needs no setting, as the link names its Relay.
To run one locally, for development:

```sh
cargo run -p soundcheck-relay      # ws://localhost:8080
```

Then, in `pnpm dev`, type `ws://localhost:8080` as the Relay address,
start a Live Session, and open its invite link in another browser window.

Nothing here was checked across two real machines in this repository's
sandbox. ADR 0007's [To confirm](docs/architectural-decision-record/0007-collaboration-by-an-ordered-log-of-changes.md#to-confirm)
lists the checks by hand.

## Layout

- `engine/`: the Rust Audio Engine. Platform-free: no audio devices, files or
  browser APIs ([ADR 0001](docs/architectural-decision-record/0001-audio-engine-in-rust.md)).
- `app/`: the React UI (Vite, TypeScript). It imports the engine's WASM build
  as `@engine` and never processes audio itself.
- `desktop/`: the Tauri desktop app. It runs the engine natively on cpal and
  reads MIDI through midir; everything device-specific lives here.
  `desktop/vst3-host/` is the VST3 helper, the only C++ in Soundcheck.
- `relay/`: the Relay a Live Session goes through (ADR 0007, ADR 0012), with
  its container image.
- `sdk/`: the SDK a WASM Plugin is written against, stable from 1.0.0. Its
  [README](sdk/README.md) says how to write, build and install one.
- `examples/plugins/`: a bitcrusher Effect and a wavetable Instrument,
  written only against the SDK and its docs. `pnpm lint` fails if one
  depends on or imports anything else.
- `docs/`: product requirements, architectural decisions and processes.

## Troubleshooting

- **`rustup: command not found`** right after installing: open a new terminal
  (macOS/Linux: or `source "$HOME/.cargo/env"`).
- **`linker 'link.exe' not found`** (Windows) or **`linker 'cc' not found`**
  (macOS/Linux): the C build tools from your platform's step 1 are missing.
- **`error calling dlltool 'dlltool.exe': program not found`** (Windows): Rust
  is on the GNU toolchain, not MSVC. See [Windows](#windows) step 5.
- **`os error 32`** from `wasm-opt`, or **`Blocking waiting for file lock`**
  (Windows): another build is running — usually `pnpm dev` alongside
  `pnpm desktop:dev`. Stop the other one. If it still happens, Windows Defender
  may be scanning the fresh `.wasm`: retry, or exclude the repo folder.
- **`can't find crate for 'core'`** or a missing `wasm32` target: run
  `rustup target add wasm32-unknown-unknown`.
- **No sound**: check the system output device, then that the page says the
  Audio Engine started. Chrome only starts audio after you click **Start
  audio**.

## Licence

[GPL-3.0-or-later](package.json).

### Credits

The app's **Credits** (last in the title bar's menu) list these, and the
other work Soundcheck is built on: Tauri, cpal, midir, Wasmtime, Steinberg's
VST 3 and ASIO SDKs, Symphonia, rusty_mp3, wasm-bindgen, React, Lucide, the
Assistant's provider SDKs, and Tokio and axum for the Relay.

- **Demucs**, by Alexandre Défossez and the Demucs authors at Meta AI
  ([facebookresearch/demucs](https://github.com/facebookresearch/demucs);
  *Hybrid Transformers for Music Source Separation*, Rouard, Massa and
  Défossez, ICASSP 2023): the htdemucs model Stem Separation runs. Its code is MIT. Its pretrained weights
  are for research and personal use only, and are never in this repo or its
  releases: you download them from Meta when you export the model.
- **Mixxx's ONNX export of Demucs**, Anmol Mishra's Google Summer of Code 2025
  project for Mixxx, mentored by Jörg (JoergAtGithub) and Antoine (acolombier)
  ([mixxxdj/demucs](https://github.com/mixxxdj/demucs), and
  [their write-up](https://mixxx.org/news/2025-10-27-gsoc2025-demucs-to-onnx-dhunstack/)),
  MIT: vendored in [`tools/htdemucs-onnx/`](tools/htdemucs-onnx/README.md),
  whose README says what came from where and what was changed. The MIT
  licence is compatible with GPL-3.0-or-later.
- **ONNX Runtime** and **ONNX Runtime Web**, by Microsoft
  ([microsoft/onnxruntime](https://github.com/microsoft/onnxruntime)), MIT:
  they run the model, in the Desktop App (through the
  [`ort`](https://github.com/pykeio/ort) crate, MIT or Apache-2.0) and in the
  browser.
- **coi-serviceworker**, by Guido Zuidhof and contributors
  ([gzuidhof/coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)),
  MIT: the service worker that makes the Browser Version cross-origin isolated
  on GitHub Pages, so WebAssembly has threads.

The bundled Starter Kit's samples are this repository's own work, generated by
`engine/examples/make_starter_kit.rs` and redistributable under the same
licence: see [`engine/assets/kits/starter/LICENCE.md`](engine/assets/kits/starter/LICENCE.md),
which also sets out what any sample added later has to come with.

# PRD: Stem Separation

Terms in **bold** are defined in [`CONTEXT.md`](../../CONTEXT.md). The approach is settled in [ADR 0005](../architectural-decision-record/0005-stem-separation-with-htdemucs-on-onnx-runtime.md); this doc covers the features built on it. They are issues #116, #119, #117, #118 and #120, done in that order and shipped as one pull request.

*Updated 2026-09-27:* the **Browser Version** separates Stems too, from the same model, on ONNX Runtime Web ([ADR 0005's second amendment](../architectural-decision-record/0005-stem-separation-with-htdemucs-on-onnx-runtime.md#amended-2026-09-27-the-browser-version-separates-stems-too), [ADR 0006's amendment](../architectural-decision-record/0006-a-browser-version-beside-the-desktop-app.md#amended-2026-09-27-stem-separation)). This doc was written for the Desktop App; where the Browser Version differs, it says so, and its stories are [In the Browser Version](#in-the-browser-version).

## Problem

A musician often starts from a finished recording: a demo bounced to one file, a song to remix, a loop with the drums baked in. Soundcheck can import it as an **Audio Clip**, place it, trim it and copy it, but it stays one blob of sound. Nobody can turn down its vocals, replace its drums, or ask the **Assistant** to work on just its bass. There is also no way to save one **Audio Clip's** audio on its own: File → Export writes the whole mix.

## Goal

Any **Audio Clip**, or any audio file, can be split into its four **Stems** (vocals, drums, bass, everything else) on the musician's own machine. Each **Stem** lands on its own **Audio Track** as ordinary audio the **Project** owns, as one undo step. The musician can do this by hand or ask the **Assistant** to, and can save any **Audio Clip** (a **Stem** or not) as its own WAV or MP3.

## Who it's for

The author first, remixing and re-arranging their own recordings on the Windows desktop app. Soundcheck is personal and non-commercial for now, which is what lets it use the model at all (see Licence).

## Architecture constraints

- **Desktop first.** The model runs through ONNX Runtime (the `ort` crate, on the CPU) in `desktop/`, never in `engine/`, which stays platform-free and builds to WASM ([ADR 0001](../architectural-decision-record/0001-audio-engine-in-rust.md)). The math around it (chunks, cross-fade, standardising) is the engine's `StemSeparation`, shared with the **Browser Version**, which runs the model on ONNX Runtime Web in a Web Worker (ADR 0005, amended 2026-09-27). Where a browser can't run it, every Stem Separation entry point says why.
- **One platform interface.** A `StemSeparator` (`app/src/stems/`), picked in `app/src/platform.ts`, is the only way into separation. It reports whether the model is installed, installs it from a file, and separates audio with progress (0–1) and an `AbortSignal`. It has four implementations: the desktop one over Tauri commands, the browser one over a Web Worker, one that says "not available" (a browser without Web Workers), and a fake for tests. The UI, the **Assistant** and File → Import as Stems… all go through it.
- **One placement module.** Turning four **Stems** into **Tracks** and **Clips** (`app/src/stems/place-stems.ts`) is written once and shared by the Clip action, the **Assistant** tool and the File menu entry.
- **One undo step.** A whole Stem Separation (new **Tracks**, **Stem** Clips, removing the source Clip) is one `ProjectGroup` in the history, whether the musician or the **Assistant** ran it.
- **Progress and cancel follow mix export.** Rust keeps one job at a time with an atomic progress value and a cancel flag, and the app polls it (`export_progress` / `export_cancel`, `desktop-mix-exporter.ts`). Cancelling writes nothing and changes nothing. The **Browser Version** starts a Web Worker for each job, which posts its progress, and cancelling ends the worker at once, which also gives its memory back.
- **No test needs the real model, audio hardware or an LLM.** Rust tests use tiny fake ONNX models written as protobuf bytes in the test. UI and **Assistant** tests use the fake `StemSeparator` and scripted model replies. The **Browser Version's** tests run the worker's code in Node, on the engine's WASM build and ONNX Runtime Web's Node build, with fake models written in the test, and its **Stems** must match the desktop's for the same audio to within 1e-6. The one real-model test is `#[ignore]`d and runs only when `SOUNDCHECK_HTDEMUCS` names the file.

## Licence, and so how the model gets onto a machine

The model is htdemucs (Demucs v4, 4 **Stems**), exported to a self-contained ONNX file (`htdemucs.onnx`, about 300 MB) by Mixxx's fork of Demucs. Its pretrained weights are for research and personal use only. So nothing in the repo, its releases or the app downloads or bundles them. The musician exports the file once on their own machine, with the export vendored into `tools/htdemucs-onnx/` (its README), and installs it from that file. The app checks the file's input `[1, 2, 343980]` and output `[1, 4, 2, 343980]` shapes, refuses anything else with a reason, and keeps a copy in its app-data folder (the **Browser Version**: the site's own storage), outside any **Project**. Any commercial release is blocked until this changes (ADR 0005).

## User stories

### Stem Separation on the desktop (#116)

1. As a musician, the first time I separate something, I'm asked for the model file. A wrong file is refused with a reason, and a right one is installed once for every **Project**.
2. As a musician, a Stem Separation runs off the UI thread, shows progress, and can be cancelled. Cancelling leaves nothing behind.
3. As a musician, mono audio is separated as stereo, and audio at any sample rate works: the engine resamples to 44.1 kHz on the way in, and the **Stems** come back as 32-bit float WAV.

### Export Clip… (#119)

4. As a musician, right-clicking any **Audio Clip** offers **Export Clip…**. It saves exactly the stretch the Clip plays (`fileOffset`, `duration`) as raw audio, with no fader, pan, **Effects**, **Sends** or **Automation**.
5. As a musician, I choose WAV (16/24/32-bit, 44.1/48 kHz) or MP3 (128–320 kbps) from the same picker mix export uses. My last choice is remembered, the Clip's name is suggested, and I can cancel with nothing written. This works on the desktop and on the browser dev host.

### Separate into Stems on an Audio Clip (#117)

6. As a musician, right-clicking any **Audio Clip** offers **Separate into Stems**, beside Export Clip…. Only the stretch the Clip plays is separated.
7. As a musician, the separation runs in the background and I keep editing. There is one at a time, and New or Open cancels it.
8. As a musician, I get four new **Audio Tracks** directly under the source **Track**: `<Clip name> – Vocals`, `– Drums`, `– Bass`, `– Other`. Each holds its **Stem** at the source Clip's position and length. The source Clip is removed, so the song sounds about the same, and one undo puts it all back.
9. As a musician, if I delete or trim the source Clip while it is being separated, the result is discarded and I'm told why. If I only move it, the **Stems** follow it.
10. As a musician, the **Stems'** audio is saved in the **Project's** `audio/` folder like any imported file, and is still there when I reopen the **Project**.

### The Assistant can separate an Audio Clip (#118)

11. As a musician, I can ask the **Assistant** to separate a Clip ("pull the vocals out of the demo"). Its `separate_stems(clipId, keep?)` tool waits for the separation inside the **Request** without using up turns (`MAX_TURNS`), then applies the result in the **Request's** single undo step.
12. As a musician, `keep` (e.g. `["vocals"]`) keeps only those **Stems**, and the source Clip is removed either way. The tool returns the new **Tracks'** ids and names, so the **Assistant** can go on to analyse a **Stem** or turn one down.
13. As a musician, I see progress and a Cancel button in the **Request** box. Cancelling, a missing model, or a browser that can't separate each fail the call with a clear message and change nothing. The **Assistant** never installs the model.
14. As a musician, a **Suggestion** that separates runs as normal. Applying it reuses the **Stems** already separated rather than separating again, and rejecting it leaves no **Stem** audio in the **Project**.

### File → Import as Stems… (#120)

15. As a musician, **File → Import as Stems…** separates a whole WAV, FLAC or MP3 file straight into four **Audio Tracks** named `<file name> – Vocals` and so on. They're added at the end of the **Track** list, each **Stem** starting at the playhead. Only the **Stems'** audio is copied into the **Project**, not the original file.
16. As a musician, this uses the same install prompt, background progress, Cancel and one-step undo as Separate into Stems. Where the browser can't separate, it says why.

### In the Browser Version

Added 2026-09-27, after the stories above shipped.

17. As a musician in the **Browser Version**, every story above works as it does in the Desktop App, with the same `htdemucs.onnx` and the same menus, and gives the same **Stems**.
18. As a musician, the first time, I'm asked for the model file, which is checked as on the desktop and kept in the site's own storage in this browser (the Origin Private File System, or IndexedDB), outside any **Project**. After a reload I'm not asked again, unless the browser has cleared the site's data. The page never downloads the model; it only reads the file I pick.
19. As a musician, where my browser can't separate (no WebAssembly, no storage for the model, under 4 GB of memory, or neither WebGPU nor WebAssembly threads), **Separate into Stems**, **Import as Stems…** and the **Assistant's** tool say why, and that the Desktop App can.

## Decisions made while building

- The **Track** order is Vocals, Drums, Bass, Other, as the issues list them.
- The new **Tracks** are fresh **Audio Tracks**: they don't copy the source **Track's** fader, pan, **Effects**, **Sends** or routing.
- If an **Assistant** **Request** holds the history when a hand-started separation ends, the **Stems** are not placed, and the message says why.
- The sandbox image moved to `node:26-trixie`, because the ONNX Runtime that `ort` downloads needs glibc 2.38. CI's `ubuntu-latest` and `windows-latest` need no change. `ort` links ONNX Runtime statically, so no DLL ships with the app.
- The math around the model (standardising, the overlapping chunks, the cross-fade) moved from `desktop/src/stems.rs` into the engine's `StemSeparation`, so the Desktop App and the **Browser Version** run the same Rust and give the same **Stems**. Each platform keeps only the model run (added 2026-09-27).
- Both platforms check the model with ONNX Runtime's basic optimisations. With none, the export's symbolic output shape isn't resolved, and the real model was refused (found and fixed 2026-09-27).
- Clip export and Stem Separation both cut the Clip's stretch with the engine's `ClipRender`, so what is exported or separated is exactly what the engine plays.

## Out of scope

- GPU / DirectML on the desktop (a later `ort` feature flag, not a new runtime), and the 6-**Stem** model. (Separation in the browser was out of scope here and is built since, on WebGPU or WebAssembly: ADR 0005, amended 2026-09-27.)
- Downloading the model from anywhere, or the **Assistant** installing it.
- Choosing which **Stems** to keep in the UI (the musician deletes what they don't want; only the **Assistant's** `keep` filters).
- Remembering in the **Project** which Clips are **Stems**. Exporting several Clips or all **Stems** at once, or a **Track** as it sounds in the mix.
- Keeping the original mix when importing as **Stems** (as a muted **Track** or the **Reference Track**). A plain File → Import Audio… entry.
- A general Stop button for any **Request**, and a **Skill** for separation.
- ~~Cross-origin isolation for the **Browser Version**~~: built since (2026-09-27), with coi-serviceworker adding COOP and COEP from a service worker, so browsers without WebGPU get WebAssembly threads on GitHub Pages too (ADR 0006).

## Open: the real run

ADR 0005 was accepted before the spike was measured on real audio, and this work was built and tested with fake models only. Before it is trusted, the maintainer:

1. exports `htdemucs.onnx` (`tools/htdemucs-onnx/export.sh` or `export.ps1`, as its README says);
2. runs the spike on a real 3-minute song and fills in its results table: time, peak memory, and difference from PyTorch per **Stem**;
3. runs `SOUNDCHECK_HTDEMUCS=/path/to/htdemucs.onnx cargo test --release -p soundcheck-desktop real_htdemucs -- --ignored --nocapture` (see the README), and listens.

4. checks the **Browser Version** by hand with the same file, in Chrome or Edge on the Windows machine, then Firefox, as the README's [Checking it by hand](../../README.md#checking-it-by-hand) says. The real model has never run in a browser: only fake models, in Node.

If a 3-minute song takes over about 3 minutes on the CPU, or the **Stems** aren't faithful to PyTorch, ADR 0005 is reopened. If in the **Browser Version** it takes much over 5 minutes on WebGPU, or doesn't fit in the tab's memory, its Stem Separation is reopened.

## Risks

- **Speed on the maintainer's CPU is unmeasured.** Mixxx reports about 21 s of CPU per minute of audio, on hardware they don't name. A slow machine makes every separation a long wait, which is why everything runs in the background and can be cancelled.
- **Memory.** A 300 MB model plus a whole song's audio in and four **Stems** out is several hundred MB during a run.
- **ONNX Runtime's prebuilt binaries** need an x86-64-v3 (Haswell or later) CPU on Windows and glibc 2.38 on Linux, and are downloaded at build time.
- **Bleed.** **Stems** are an estimate, so a little of one can bleed into another. The musician judges that by ear.
- **The Browser Version** has risks of its own, in ADR 0005's second amendment: ONNX Runtime Web's 4 GB WebAssembly heap against htdemucs' ~3 GB, slow separation without WebGPU, and the browser evicting the 300 MB model from the site's storage.
- **Licence.** The weights are personal-use only, so any commercial release needs a new decision.

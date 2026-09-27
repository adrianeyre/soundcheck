# Stem Separation runs htdemucs through ONNX Runtime on the desktop, from a model the musician installs

*Amended 2026-09-27: not on the desktop only. The Browser Version runs the same model on ONNX Runtime Web; see [the second amendment](#amended-2026-09-27-the-browser-version-separates-stems-too).*

**Status: accepted** by the maintainer on 2026-09-26, closing #115 **without the spike's measurements**: the maintainer accepted the approach, and responsibility for its quality, before the spike was run on real audio. The first run is the first task of #116.

**Stem Separation** needs a trained model; training our own is research we won't do. The spike ([`spikes/stem-separation/`](../../spikes/stem-separation/README.md)) is a CLI that runs one through ONNX Runtime and compares it with Demucs's own PyTorch output.

## Decision

**Model.** Demucs v4, **htdemucs**: 4 Stems (drums, bass, other, vocals), one model rather than the fine-tuned bag of four. The 6-Stem variant is out: Demucs's own README calls its piano Stem poor.

**Export.** [Mixxx's fork of Demucs](https://github.com/mixxxdj/demucs) (GSoC 2025) exports it to a **self-contained ONNX model**: the STFT and iSTFT are rebuilt as convolutions inside the graph from the original weights, so the app only feeds in 7.8 s chunks of waveform. Mixxx reports it within 0.1 dB SI-SDR of PyTorch and about 21 s of CPU per minute of audio ([their write-up](https://mixxx.org/news/2025-10-27-gsoc2025-demucs-to-onnx-dhunstack/); hardware not stated). The alternative, sevagh's export with the STFT outside the graph, would have meant writing and matching the STFT in Rust ourselves. What the app does around the model (standardise, overlapping chunks, triangular cross-fade) is in the spike's `src/main.rs`. The export's code is vendored into this repo, in [`tools/htdemucs-onnx/`](../../tools/htdemucs-onnx/README.md), from Mixxx's fork at `d788c1a`: see [Amended](#amended-2026-09-27).

**Runtime.** ONNX Runtime through the [`ort`](https://crates.io/crates/ort) crate (2.0.0-rc.13; there is no stable 2.x), in `desktop/`, never `engine/`, which stays platform-free and builds to WASM ([ADR 0001](0001-audio-engine-in-rust.md)). CPU first. Its prebuilt Windows binaries include DirectML, so GPU is a later feature flag, not a new runtime; they need an x86-64-v3 (Haswell or later) CPU. Build it with the `tls-rustls` feature, so building it needs no OpenSSL. ~~The browser dev host has no Stem Separation.~~ *Amended 2026-09-27:* the Browser Version runs the same model on ONNX Runtime Web: see [the second amendment](#amended-2026-09-27-the-browser-version-separates-stems-too).

**Licence, and so how the model gets onto a machine.** The Demucs code is MIT; its **pretrained weights are for research and personal use only** (the author, in [demucs#327](https://github.com/facebookresearch/demucs/issues/327) and [#384](https://github.com/facebookresearch/demucs/issues/384)), because their training data is. No separation weights we found carry a clear commercial licence. Soundcheck is personal and non-commercial for now, so we use them, but **nothing in the repo or its releases redistributes them**: the musician exports `htdemucs.onnx` once, on their own machine, with `tools/htdemucs-onnx/` (its README), and installs it from that file; the app checks its input and output shapes and keeps a copy in its data folder, outside any Project.

## Consequences

- **Any commercial release is blocked** until the weights are licensed, replaced by a model with a clear licence, or trained by us. That is a new decision, and it would bring back a download in place of installing from a file.
- The spike's numbers (time, memory, parity with PyTorch) and a judgement by ear have not been taken. If #116 finds it too slow on CPU (over ~3 minutes for a 3-minute song) or unfaithful to PyTorch, this decision is reopened before #117 builds on it.

## Amended 2026-09-27

**The export's code is in this repo.** Exporting the model meant cloning Mixxx's fork and installing it by hand. The part of the fork the export reaches (`scripts/convert-pth-to-onnx.py`, the `demucs` modules it imports, and Mixxx's three tests) is now vendored into [`tools/htdemucs-onnx/`](../../tools/htdemucs-onnx/README.md) from commit `d788c1a06876ced89b11d6531f771e5e40204d48`, under its MIT licence, with its Python dependencies pinned and one command (`export.sh`, `export.ps1`) that makes a venv, exports and checks the shapes. Two lines of the script are changed, each marked: PyTorch 2.9 made the `torch.export` exporter the default, and it fails on this model, so the script passes `dynamo=False`; and it now exits with an error when the export fails. The folder's README credits Meta's Demucs authors and Mixxx's GSoC 2025 export, file by file.

What hasn't changed: the weights. `get_model` still downloads Meta's checkpoint from Meta, onto the musician's machine, when they run the export. Nothing in the repo or its releases holds or fetches a `.th`, `.pth` or `.onnx`, and `.gitignore` keeps them out. The folder is Python, outside `pnpm lint`, `test` and `build`, so CI still needs no Python.

It was run end to end on the Linux dev VM (Python 3.13, the pinned versions): Mixxx's seven tests pass, and the export writes a 304 MB `htdemucs.onnx` with input `[1, 2, 343980]` and output `[1, 4, 2, 343980]`, in about 15 s once the weights are cached. On Windows it hasn't been run.

## Amended 2026-09-27: the Browser Version separates Stems too

**What changed.** The Browser Version was to have no Stem Separation ([ADR 0006](0006-a-browser-version-beside-the-desktop-app.md)). It now runs htdemucs on [ONNX Runtime Web](https://www.npmjs.com/package/onnxruntime-web) (1.30.0) in a Web Worker, on WebGPU where the browser has it and WebAssembly on the CPU elsewhere (`app/src/stems/browser-stem-separator.ts`). The musician installs the same `htdemucs.onnx` from a file, as on the desktop; the page checks its shapes and keeps it in the site's Origin Private File System, or IndexedDB where it can't write that. The licence stands as decided above: the page never downloads the model, only reads the file the musician picks.

**One implementation of the math.** What goes around the model (standardising, 7.8 s chunks overlapping by a quarter, the triangular cross-fade, and un-standardising) moved from `desktop/src/stems.rs` into the engine, as `StemSeparation` (`engine/src/stem_separation.rs`), which is platform-free and builds to WASM ([ADR 0001](0001-audio-engine-in-rust.md)). The desktop calls it natively around `ort`; the worker calls its WASM build around ONNX Runtime Web, decoding and resampling the file to 44.1 kHz as the engine does for every file. Each platform keeps only the model run. A test on each side separates the same 8 s of 48 kHz noise with the same fake model, and the browser's must match the desktop's (`app/src/stems/fake-htdemucs-stems.json`, written by the desktop's test with `BLESS=1`) to within 1e-6.

**Why it's feasible.** The model is self-contained (the STFT is inside the graph), so the page only feeds it waveform, and ONNX Runtime Web runs the graph the desktop does. Measured on the Linux dev VM (16 cores) in Node, with ONNX Runtime Web's WebAssembly backend on the real model: loading it takes 0.8 s with the basic optimisations; one 7.8 s chunk takes about 23 s on one thread, and 7.7 s on four (18 s for the first); the process peaks at 3.1 to 3.2 GB. A 3-minute song is 31 chunks, so about 4 minutes on four threads and 12 on one. Native ONNX Runtime takes 2.2 s a chunk on the same machine.

**A fix found on the way.** The export leaves its output's shape symbolic, and ONNX Runtime only works it out once it folds the graph's constants. The Desktop App's install check opened the model with no optimisations, so it saw `[-1, -1, -1, -1]` and refused the real model. Both platforms now check it with the basic optimisations, which also load it faster (0.99 s against 1.42 s with none, in Python).

**When it says it can't.** The Browser Version says Stem Separation needs the Desktop App, with the reason, where the browser has: no WebAssembly; no storage for the model (a private window may have none); under 4 GB of memory, where it says (`navigator.deviceMemory`, Chromium only); or neither WebGPU nor WebAssembly threads. The last is because threads need the page to be cross-origin isolated, and GitHub Pages sends no COOP or COEP headers, so there, without WebGPU, one song would take over 10 minutes on one thread. (Amended 2026-09-27: a service worker now adds those headers on Pages, ADR 0006, so only a browser that refuses it and has no WebGPU is refused.)

**Risks.**

- **The 32-bit WebAssembly heap.** ONNX Runtime Web's WebAssembly build has at most 4 GB, and htdemucs took about 3 GB of the process in Node. A browser that gives a tab less, or a longer song's Stems (four stereo float Stems, about 60 MB each for 3 minutes, held by the engine until each is written out), may run out; the worker then fails, and the page says the browser may have run out of memory. Each separation starts a fresh worker and ends it afterwards, which gives the memory back.
- **Speed without WebGPU.** On WebAssembly with threads, about 4 minutes for a 3-minute song on this VM, and slower on a laptop; on one thread, too slow to offer.
- **Storage quota and eviction.** The model is about 300 MB of the site's quota. The page asks for persistent storage after installing it, but a browser that doesn't grant that may evict it under disk pressure, and the musician installs it again. Clearing the site's data removes it (the README says how). On GitHub Pages the origin is shared with every Pages site of the account, so they share its quota too.
- **WebGPU coverage.** ONNX Runtime Web may run some of htdemucs' operators on the CPU instead, which would be slower than a GPU but still correct.

**Not measured.** The real model has never run in a browser: not on WebGPU, not on WebAssembly in a page, and not on Windows. Only fake models ran through the worker's code, in Node, and the numbers above are from Node on Linux. Nor has anyone listened to the browser's Stems of a real song against the Desktop App's. The maintainer has to do that by hand ([the README's check](../../README.md#checking-it-by-hand)), and if a 3-minute song takes much over 5 minutes on WebGPU on the Windows machine, or doesn't fit in the tab's memory, the Browser Version's Stem Separation is reopened.

## Amendment, 2026-09-27: the model is looked for in the repo's `model/` first

`pnpm htdemucs:export` writes `model/htdemucs.onnx` in the repo by default (a folder can still be named). `model/` is gitignored. Before asking for the file, the Desktop App looks there, as the repo was when the app was built, and in `model/` beside the app. `pnpm dev` and `vite preview` serve it to the Browser Version at `model/htdemucs.onnx`. Either installs a model it finds without asking, still checking it is htdemucs, and asks for the file, saying why, when the model isn't there or is refused.

**The weights are still never published.** The build never contains the model: `scripts/check-web-build.ts` fails a build with any `.onnx` in it, so GitHub Pages never serves one, and there the Browser Version always asks for the file.

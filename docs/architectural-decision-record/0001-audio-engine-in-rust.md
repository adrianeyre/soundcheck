# Audio Engine core is portable Rust, hosted per platform

All audio work (playback, mixing, synthesis, effects, recording, rendering) lives in one Rust Audio Engine core that knows nothing about where it runs. A thin host adapter connects it to sound: compiled to WASM inside an AudioWorklet in the browser, or natively on the audio driver via cpal inside a Tauri desktop app. The UI (React) never processes audio; it sends commands to the engine and displays what the engine reports. We chose this over a Web Audio node-graph engine written in JS because that would be thrown away the moment we need a desktop build — for low-latency recording or VST3 hosting — whereas a Rust core is kept on every platform.

Whether the MVP ships in the browser or on the desktop is decided by a latency spike (see the MVP PRD), not by this ADR. It was decided: the browser failed, so the MVP is a desktop app ([ADR 0002](0002-mvp-is-a-desktop-app.md)).

## Consequences

- Built-in instruments and effects are Rust code. A future third-party plugin format (WASM) is hosted by the engine, not the browser.
- The engine can't rely on Web Audio's built-in nodes (BiquadFilter, Convolver, etc.); it implements its own DSP.
- Adding a platform is a host-adapter and packaging job, not an engine rewrite.

## Amended 2026-09-27: one model runs beside the engine

"All audio work lives in one Rust Audio Engine core" no longer holds for one step: **Stem Separation**'s neural network. htdemucs runs on ONNX Runtime, outside the engine, in `desktop/` through the `ort` crate ([ADR 0005](0005-stem-separation-with-htdemucs-on-onnx-runtime.md), since 2026-09-26), and in the Browser Version on ONNX Runtime Web, in a Web Worker in `app/src/stems/` ([ADR 0005's second amendment](0005-stem-separation-with-htdemucs-on-onnx-runtime.md#amended-2026-09-27-the-browser-version-separates-stems-too)). A model runtime is a large native or WebAssembly library of its own, and each platform has the one that suits it, so neither is built into the engine.

Everything else about a separation is still the engine's: decoding and resampling the file, standardising, cutting it into overlapping chunks, cross-fading the Stems and writing them out (`engine/src/stem_separation.rs`, platform-free, native and WASM). Each host only hands the engine's chunks to its model runtime and the results back, as the AudioWorklet and cpal hosts hand blocks to the engine. So both platforms give the same Stems, and the React UI still never touches a sample: the worker is the Browser Version's host code, not the UI.

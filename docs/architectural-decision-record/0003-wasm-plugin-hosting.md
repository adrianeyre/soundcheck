# WASM Plugins are core modules behind a small C-style ABI, run by wasmtime on desktop

**Status: accepted** by the maintainer on 2026-09-25, when #90 merged (#53).

The v2 PRD asks how the **Audio Engine** hosts **WASM Plugins** before any hosting is built. A spike ([`spikes/wasm-plugin-host/`](../../spikes/wasm-plugin-host/README.md)) wrote one throwaway **Effect** and ran 16 instances of it in both runtimes, with the same DSP run natively as the baseline and the same Effect behind the WASM Component Model as the alternative interface.

## Decision

**Runtime.** On desktop, [wasmtime](https://wasmtime.dev) with its Cranelift compiler, in `desktop/`. On the browser dev host, the host's own `WebAssembly`, driven from the AudioWorklet. The engine itself stays platform-free ([ADR 0001](0001-audio-engine-in-rust.md)): wasmtime doesn't build for `wasm32`, so the engine declares a Plugin-runtime interface and each host implements it, as it already does for audio output.

**Interface.** A Plugin is a plain WebAssembly core module (`wasm32-unknown-unknown`) with **no imports**, exporting ABI version 1:

| Export | What it does |
| --- | --- |
| `memory` | The Plugin's linear memory |
| `sc_abi_version() -> u32` | The ABI version it was built for; the host refuses one it doesn't know |
| `sc_manifest() -> u32`, `sc_manifest_len() -> u32` | Where its manifest is: UTF-8 JSON with its id, version, kind (`effect` or `instrument`), name, and settings (name, label, unit, min, max, default, step), the same fields as a built-in's table |
| `sc_init(sample_rate: f32, max_frames: u32) -> u32` | Allocate everything it will ever need; 0 means ready |
| `sc_buffer(channel: u32) -> u32` | Where channel's `max_frames` of `f32` live; the host writes and reads audio there |
| `sc_set_param(index: u32, value: f32)` | Change a setting, by its index in the manifest |
| `sc_process(frames: u32)` | Process the buffers in place, the way a built-in Effect does |
| `sc_reset()` | Clear its state (tails, filters) without reallocating |

One WASM instance is one Plugin instance, each in its own wasmtime `Store`, so a Plugin keeps its state in globals and needs no handles, and instances share nothing. **Instruments** extend this with note events in the SDK issue that builds them; the version number is how the ABI grows.

**Rules a Plugin must follow**, enforced where the host can: it allocates only in `sc_init` (a `memory.grow` later would invalidate the browser host's views, and allocating on the audio thread is what the engine never does); it is deterministic and imports nothing, so it has no clock, files or network. On desktop the host turns on wasmtime's epoch interruption and ticks it per block, so a Plugin that runs away is stopped and bypassed instead of stalling the audio.

## What was measured

16 instances of the spike Effect (seven biquads per channel and a soft clip, about the work of the built-in EQ), 48 000 Hz, 128-frame stereo blocks, one setting swept every block as **Automation** would. Each time covers the whole call from the host: copying the block in, setting the parameter, processing, copying it out. 20 000 blocks (53 s of audio) per run, the first tenth discarded as warm-up. Two runs each; ranges are across them.

| Runtime | 16 instances, mean | p99 | Per instance | Of the 2 667 µs block |
| --- | --- | --- | --- | --- |
| Native Rust (baseline) | 40–42 µs | 55–61 µs | 2.5–2.6 µs | 1.5–1.6% |
| **wasmtime 49, C-style ABI** | **49–51 µs** | 74–80 µs | 3.1–3.2 µs | **1.9%** |
| wasmtime 49, C-style ABI + epoch interruption | 49 µs | 68–72 µs | 3.1 µs | 1.8% |
| wasmtime 49, Component Model | 63–65 µs | 85–101 µs | 3.9–4.1 µs | 2.4% |
| Node 26.7 (V8), C-style ABI | 54 µs | 81 µs | 3.4 µs | 2.0% |
| **Chromium 151 (V8), C-style ABI** | **55–56 µs** | 85–95 µs | 3.4–3.5 µs | **2.1%** |

- Compiling the 63 KB Plugin takes 48 ms in wasmtime (58 ms with epoch interruption) and under 10 ms in V8, which compiles lazily. Instantiating 16 takes 0.4 ms. Both happen when a Plugin is loaded, never on the audio thread.
- Every WASM run's output matched the native baseline's.
- The worst single blocks (110–440 µs) are scheduling noise on a shared VM; they show up in the native baseline too.

## Why

- **The runtime cost is small and predictable.** Behind the C ABI, wasmtime costs about 1.2× native and V8 about 1.35×. 16 instances take about 2% of the block, which leaves the rest for the Tracks, built-ins and mixing.
- **One ABI runs on both hosts unchanged.** The same `.wasm` file ran in wasmtime, Node and Chromium with no glue beyond a dozen lines. The browser has no Component Model: a component has to be transpiled to core modules plus JavaScript (jco) before a page can run it, so it would be two builds of every Plugin, or one build and a transpile step in the dev host.
- **The Component Model costs more on the one path that matters.** Passing `list<f32>` through the canonical ABI copies each block and makes the guest allocate on every call. That is 1.3× the C ABI's cost, and it allocates on the audio thread. A Rust component built for `wasm32-wasip2` also imports WASI whether it uses it or not (103 KB against 63 KB), so the host has to provide and sandbox it.
- **It's small enough to document and keep.** Nine exports, numbers only, one JSON string. An SDK in any language that targets WebAssembly can produce it, and that's what the PRD's `examples/plugins/` have to prove.
- **wasmtime** is the reference runtime for WebAssembly outside the browser. It's maintained by the Bytecode Alliance, written in Rust (so it drops straight into `desktop/`), and has the interruption and limits a host needs. Its cost here was already close to native, so an interpreter or a second JIT wasn't worth measuring.

## Limits of this result

- It was measured on a Linux VM (Intel Xeon Platinum 8488C, 16 vCPUs), not the author's Windows laptop, and with one Effect rather than a mix of them. The ratios should hold; the absolute numbers will differ.
- The browser run timed a page's main thread, not an AudioWorklet, whose scope has no timer. It is the same V8 compiler. The dev host would reach a Plugin through JavaScript from the engine's worklet, a call per block that is included in these times.
- The JavaScript host builds its test signal in `f64`, so its checksum differs from the Rust host's; the Node and Chromium runs agree with each other exactly.
- Settings change once per block. A host that needs a change mid-block splits the block there.

## Consequences

- The engine gets a Plugin-runtime interface; `desktop/` implements it with wasmtime, and the browser dev host implements it in its worklet. This is the next Plugin issue.
- The ABI is version 1 and the SDK stays marked unstable until the example Plugins prove it, as the PRD says. Changing it before then is cheap; after, it needs a new version that the host supports alongside the old one. *Done in #56:* `examples/plugins/` holds a bitcrusher Effect and a wavetable Instrument, written only from the SDK and its docs, with a CI check that they import nothing else. They build and play through wasmtime and the browser's `WebAssembly`, so the SDK is stable at 1.0.0 and ABI version 1 is fixed.
- The Component Model can be looked at again if browsers ever run components natively; the version export is where a second interface would start.
- The spike's code is throwaway. It lives in `spikes/` as its own Cargo workspace, outside the app's build, lint and test.

## Amendment: Instruments (#55)

Instruments stay on **ABI version 1**. What's new is two exports, and a Plugin only needs them when its manifest's `kind` is `"instrument"`. An Effect exports exactly what it did before, and a #54 Effect loads unchanged.

| Export | What it does |
| --- | --- |
| `sc_note_on(note: u32, velocity: f32)` | Start a MIDI note (0 to 127) at a velocity from 0 to 1 |
| `sc_note_off(note: u32)` | Release a note |

For an Instrument, `sc_process(frames)` renders the next `frames` into both buffers, replacing whatever is in them, and `sc_reset()` also silences its voices. The host calls the note exports between two `sc_process` calls, in the order the notes are played. It cuts a block at every note start and end, so a note lands on the exact frame it is due. Settings change between blocks, as an Effect's do. The engine never calls `sc_reset` on an Instrument: stopping, seeking or moving the Clip sends `sc_note_off` for the notes still held, so a Plugin's release tail plays out as a Synth's does.

What the hosts check:

- Both hosts refuse an Instrument without `sc_note_on` and `sc_note_off`, with a reason naming the missing export. wasmtime on desktop checks this when it loads the module, and the browser runtime does the same.
- A Plugin is matched by id and kind. An Instrument slot holding an installed Effect with that id (or an Effect slot holding an Instrument) counts as a missing Plugin.
- An Instrument that traps, or on desktop runs past its time, goes silent until it is loaded again, in the same way a faulted Effect is bypassed.

A Track whose Instrument Plugin isn't installed is silent. Its id, version and settings are kept exactly, and it sounds right again once the Plugin is installed.

The SDK exports all of this through `export_instrument!`. `sdk/test-instrument` is the Instrument counterpart of `sdk/test-effect`, and its `expected-output.json` is rendered bit-exact both by wasmtime and by the browser's `WebAssembly`.

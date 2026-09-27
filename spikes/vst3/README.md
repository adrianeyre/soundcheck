# Spike: hosting VST3 Plugins in a process of their own (#69)

Throwaway code behind [ADR 0008](../../docs/architectural-decision-record/0008-vst3-plugins-run-in-a-helper-process.md). The C++ is built with CMake against Steinberg's VST3 SDK, and the Rust is its own Cargo workspace, so the app's `pnpm lint`, `test` and `build` never build any of it. Keep it only as the record of what was proven. #70 builds the real thing in `desktop/` and doesn't import from here.

| Path | What it is |
| --- | --- |
| `helper/` | `soundcheck-vst3-host`, the helper process: loads one **VST3 Plugin** with the SDK's hosting classes, answers commands on a pipe, and processes blocks through shared memory (`shared.h`). Its header comment is the protocol. |
| `faulty/` | "Spike Faulty", a stereo gain **Effect** that crashes, hangs or runs slow when told to, and crashes as its library loads when `SPIKE_FAULTY_CRASH_ON_LOAD` is set. It stands in for the misbehaving Plugins the helper exists for. |
| `host/` | The Desktop App's side, in Rust: scanning (`scan.rs`, `moduleinfo.rs`), the helper's protocol (`protocol.rs`), the shared memory (`shared.rs`), one Plugin in its process (`process.rs`) and how a Plugin's state would sit in `project.json` (`saved.rs`). `tests/` runs it all against the real helper and Plugins, and `src/bin/bench.rs` measures it. |

Only Linux is built here: the helper uses POSIX shared memory and semaphores, which is what the sandbox has. ADR 0008 says what Windows and macOS use instead.

## Building it

You need a C++17 compiler and CMake 3.25 or later (`.sandcastle/Dockerfile` installs it; an image built before that change doesn't have it, and Kitware's release tarball works unpacked anywhere). The SDK needs no other libraries, because the spike turns VSTGUI and the SDK's GUI hosting examples off.

```bash
cd spikes/vst3
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release   # fetches VST3 SDK v3.8.1_build_84
cmake --build build -j
```

To build against an SDK you have already cloned (with its submodules), add `-DVST3_SDK_DIR=/path/to/vst3sdk`.

This builds the helper at `build/bin/soundcheck-vst3-host`, and at `build/VST3/Release/` Spike Faulty plus the SDK's own example Plugins: ADelay, AGain Sample Accurate, and the mda set (DX10, JX10 and Piano among its Instruments). No Plugin binaries are committed, and none from anyone else are used.

## Running it

```bash
cd spikes/vst3/host
cargo test                          # needs ../build; SPIKE_VST3_BUILD points elsewhere
cargo run --release --bin bench
```

`SPIKE_VST3_VERBOSE=1` shows the helpers' stderr, which is where a Plugin's own prints go.

The helper can also be driven by hand, which is how its protocol was first tried:

```bash
printf 'scan\tbuild/VST3/Release/adelay.vst3\n' | build/bin/soundcheck-vst3-host
```

## What it proves

33 tests, all against real VST3 binaries built from the SDK here:

- **Scanning runs no Plugin code in the app.** A scan of the build's folder finds every Instrument and Effect from each bundle's `moduleinfo.json`, without loading any. A bundle with no moduleinfo (built before SDK 3.7) is scanned in a helper process of its own. When the Plugin crashes as it loads, which copy protection can do, that bundle is reported as *"it crashed while it was being scanned"* and the scan carries on (`crash_on_load.rs`).
- **A Plugin runs in its own process, and processes audio exactly.** Spike Faulty's gain is applied bit for bit. ADelay delays an impulse by exactly the samples its Delay setting asks for. DX10 plays a note sent as an event, and is silent without one.
- **A crash takes down only its own Plugin.** Two Tracks each play through an ADelay while a third plays through Spike Faulty, which crashes mid-song. Every block of the ADelay Track stays bit-identical to a second ADelay's output, the crash is reported in the very block it happened in, and Spike Faulty loads again from the state the Project had saved and carries on.
- **A hang never stalls the audio.** A Plugin that stops returning is bypassed every block, with no call waiting past its deadline, and is killed and reported as crashed after 500 ms.
- **A slow Plugin misses no setting.** Blocks it is late for are bypassed, and the setting changes they carried reach it with the next block that goes through.
- **State survives a new process.** A Plugin's state goes through `project.json` (base64, beside its class id, name, vendor and version) into a fresh helper, and plays the same: Spike Faulty's gain, and ADelay's delay time.
- **The Assistant reaches only what a Plugin exposes.** The settings a Plugin lists, with their units and flags, and only those it lets be automated.
- **A Plugin's window can be asked about.** Spike Faulty says it is 420 × 240 and can be attached to an `HWND`, `NSView` or `X11EmbedWindowID`. ADelay, built here without VSTGUI, has none.
- **Nothing is left behind.** A helper that quits, is dropped, crashes or hangs is gone afterwards, not even a zombie, and every shared-memory name is unlinked as soon as its helper has mapped it.

## What it measured

On this sandbox's VM (Intel Xeon Platinum 8488C, 16 vCPUs, Linux 6.17, no real-time scheduling), 128-frame blocks at 48 kHz (2 667 µs), 20 000 blocks per row. Spike Faulty does next to nothing with a block, so these times are the cost of crossing between processes. *One by one* is how a Track's chain of Effects has to run. *All at once* starts every Plugin before waiting for any, with one deadline for the whole callback, as independent Tracks can. *Paced* waits for the next block as an audio callback would; *flat out* doesn't. Two runs:

| Plugins | Order | Callback | Mean | p99 | Max | Plugin blocks bypassed |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | one by one | flat out | 6–7 µs | 12 µs | 93–1 052 µs | 0 of 20 000 |
| 1 | one by one | paced | 160–180 µs | 432–442 µs | 4.4–8.1 ms | 11–19 of 20 000 |
| 16 | one by one | flat out | 297–346 µs | 1.9–2.3 ms | 8.7–8.8 ms | 6–7 of 320 000 |
| 16 | one by one | paced | 1.09–1.14 ms | 3.3–3.4 ms | 8.4–12.2 ms | 18–23 of 320 000 |
| 16 | all at once | flat out | 38–39 µs | 63–64 µs | 584–756 µs | 0 of 320 000 |
| 16 | all at once | paced | 240–257 µs | 516–540 µs | 4.2–7.3 ms | 112–158 of 320 000 |

- Starting a helper and loading a Plugin: 1.3–1.6 ms on average.
- From a crash to the host knowing: 48–92 µs on average, 226 µs at most. The helper's crash handler says so through the shared memory before the process ends. Without it, the host only knew when the process had gone, 158 ms later on average here, because the system writes a core dump first.
- Waiting on each Plugin's deadline in turn is what makes *one by one* overrun: 16 slow Plugins could take 16 deadlines. *All at once* with one deadline is what ADR 0008 takes.
- *Paced* is slower than *flat out* because a helper that sleeps between blocks has to be woken, and on this VM nothing runs at real-time priority. On the Desktop App the helpers' block threads would, as the audio thread does (ADR 0008).

## What it doesn't do

- **No Plugin windows.** This sandbox has no display. ADR 0008 designs them, unverified by eye.
- **No Windows or macOS.** The design of both is in ADR 0008. Nothing here was run on either.
- **No purchased Plugins.** None may be tested here. Copy protection (iLok, activation dialogs) is designed for in ADR 0008 and has to be checked by hand.
- **Stereo only, one main bus each way, 32-bit float.** Side-chain inputs, surround and 64-bit processing are left out.
- **Not the engine's Plugin interface.** The spike's host is standalone. ADR 0008 says how #70 fits it behind the engine's `PluginInstance`.

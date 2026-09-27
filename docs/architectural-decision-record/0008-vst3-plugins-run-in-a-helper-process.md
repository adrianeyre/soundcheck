# VST3 Plugins run one to a helper process, which the Desktop App drives through shared memory

**Status: proposed** in the v4 pull request (#69), and **amended** as #70 built it: where the build differs from the design, [As #70 built it](#as-70-built-it) says how and why, and the sections it changes point there. What the maintainer has to confirm is under [To confirm](#to-confirm).

The v4 PRD calls hosting VST®3 Plugins "the riskiest item on the whole roadmap". Third-party Plugins crash, each has its own licensing and copy protection, and their windows are native ones next to a webview. The maintainer asked for a spike ([`spikes/vst3/`](../../spikes/vst3/README.md)) to prove, against Plugins built here from Steinberg's own SDK, that the **Desktop App** can:

- scan for and load a **VST3 Plugin**;
- run it in a separate process, so a crash doesn't take the song down;
- save and restore its state;

and to design the Plugin's window, which this sandbox can't show.

## Decision

### One helper process per Plugin

Every VST3 Plugin in a **Project** (every instance, not every kind) runs in a process of its own: `soundcheck-vst3-host`, a small C++ program on the SDK's own hosting classes. It loads one class from one bundle, and does nothing else. The Desktop App never loads a VST3 Plugin's code, not even to scan it. So whatever a Plugin does wrong (crash, hang, corrupt memory, print to stdout) happens to its own process.

A helper costs little. Starting one and loading a Plugin took 1.3–1.6 ms. An idle helper uses 3.6 MB of memory, and the binary is 266 KB. A Project with dozens of VST3 Plugins has dozens of helpers. Bitwig and Reaper offer the same, one process per Plugin, as a setting.

### Two channels: a pipe for commands, shared memory for audio

- **Commands** go down the helper's stdin as tab-separated lines and come back on a pipe as data lines and then `ok` or `err`. The commands are load, list the settings, set one, get and set state, and ask about the window. The pipe is the helper's stdout as it started; stdout itself is pointed at stderr, so a Plugin that prints can't corrupt the protocol. State travels as hex. None of this is on the audio path.
- **Audio** goes through one block of shared memory per helper. The block holds:
  - the input and output buffers, up to the Desktop App's `MAX_BLOCK` of 1 024 frames, stereo, 32-bit float;
  - the block's setting changes (up to 64, each with its frame offset, so they're sample accurate without cutting the block);
  - its notes (up to 128, with offsets);
  - a sequence number and a status;
  - two semaphores, *go* and *done*.

  The Desktop App writes the block, posts *go*, and waits on *done*. The helper's block thread runs the Plugin's `process` straight from and into that memory. The helper is started with the memory's name, and the name is removed once the helper has it mapped, so nothing is left behind if either side dies.
- The layout is versioned. The helper's first line gives its version and the layout's size, and the Desktop App refuses a helper that doesn't match it.

### No block waits past its deadline

The audio thread never waits for a Plugin longer than the block lasts. What happens to a block:

- **Processed**: the output is the Plugin's.
- **Bypassed**: the Plugin was late, or said the block failed. An Effect's input passes through unchanged, and an Instrument is silent for that block. The helper finishes the late block in its own time, and the setting changes of any block it misses are kept, the latest of each, and sent with the next block that goes through. So a Plugin that is late never misses a value.
- **Crashed**: the helper has gone. The Plugin is bypassed (an Effect) or silent (an Instrument) until it is loaded again. A Plugin late for longer than **500 ms** is taken for hung, killed, and treated as crashed.

A crash is known **in the block it happens in**. The helper catches the fatal signals (on Windows, the unhandled exception) on an alternate stack, and marks the block crashed and posts *done* before the process dies. In the spike that took 48–92 µs on average. Without the handler, the host only knew once the process had ended, 158 ms later on average, because the system wrote a core dump first. The pipe closing is the fallback, for a helper killed from outside.

**One deadline for the whole callback, and every Plugin started before any is waited for.** The spike measured what happens otherwise. 16 Plugins, each waited for in turn against its own deadline, had a p99 of 1.9–3.4 ms against a 2.7 ms block, because the waits add up. Started all at once and waited for against one deadline, the same 16 had a mean of 38–39 µs and a p99 of 63–64 µs (see [What was measured](#what-was-measured)). So in each callback, the engine hands every VST3 Plugin its block as soon as that block's input is ready, and collects each output as late as it can. VST3 Plugins on different Tracks then run in parallel on their own cores. Plugins in one Insert Chain still run one after another, since each needs the last one's output. A chain of several VST3 Plugins costs one round trip each.

*Amended by #70:* the one deadline is built; starting them all at once isn't yet. See [As #70 built it](#as-70-built-it).

The helpers' block threads run at the audio thread's priority. On Windows that is MMCSS "Pro Audio" (`AvSetMmThreadCharacteristics`). On macOS it is a time-constraint thread policy, and on Linux `SCHED_FIFO` through rtkit where it is allowed. The spike's VM ran nothing at real-time priority, which is most of why its *paced* numbers are worse than its *flat out* ones.

### Scanning runs no Plugin code in the app

- The folders are the ones Steinberg specifies:
  - Windows: `%COMMONPROGRAMFILES%\VST3` and `%LOCALAPPDATA%\Programs\Common\VST3`;
  - macOS: `~/Library/Audio/Plug-Ins/VST3` and `/Library/Audio/Plug-Ins/VST3`;
  - Linux: `~/.vst3`, `/usr/lib/vst3` and `/usr/local/lib/vst3`;
  - plus any folders the musician adds.
- A bundle from SDK 3.7 or later carries `Contents/Resources/moduleinfo.json`, which lists its classes (id, name, vendor, version, categories). It is read as a file, JSON5, without running anything. That was every bundle the spike built.
- A bundle without one is scanned in a helper of its own, with a 60 s limit. A Plugin that crashes or hangs while it loads costs only that helper, and the bundle is listed as *couldn't be scanned* with the reason, and a button to try again.
- Results are cached by bundle path, size and modification time. At startup only new and changed bundles are scanned, in the background. A full rescan is a button in Settings.
- Only the Audio Module classes are listed. Each is an **Instrument** if its sub-categories say `Instrument`, otherwise an **Effect**.

### Copy protection and licensing checks

Soundcheck never works around a Plugin's copy protection. It gives it room to run:

- iLok, PACE, activation dialogs and online licence checks run when the Plugin loads, in its helper. Loading has a 60 s limit, not the 5 s that other commands have. The Desktop App shows *"Waiting for <Plugin>…"*, so a dialog the Plugin opens is expected, not a hang. On Windows the Desktop App calls `AllowSetForegroundWindow` for the helper, so that dialog can come to the front.
- The helper tells a Plugin that asks that the host is "Soundcheck". Some Plugins check the host's name, and some copy protection behaves differently in a host it doesn't know. Only running them will tell, which is a hand check.
- A Plugin that refuses to load says why if it can, and is treated as missing (below). Its settings and state are kept.

A helper isolates crashes, not malice. A VST3 Plugin is native code with the musician's own rights, as in every other DAW, and a helper is not a sandbox.

### The Plugin's own window (designed, **unverified by eye**)

This sandbox has no display, so none of this has been seen working. The spike only proves the question the design starts from: a Plugin's `IPlugView` reports its size, whether it can be resized, and the kinds of native window it attaches to (Spike Faulty: 420 × 240, `HWND`, `NSView`, `X11EmbedWindowID`).

A Plugin's view has to be attached to a native window in its own process, so **the helper makes the window**. It is a top-level window that belongs to the Desktop App's main window rather than a view inside the webview:

- **Windows** (built by #70): the helper creates a captioned top-level window whose *owner* is the Desktop App's main `HWND`, passed to it as a number. An owned window stays above its owner, minimises with it and has no taskbar button, across processes. The Plugin's view is attached to it, and the window is sized from `getSize`.
- **macOS** (not built yet): one process can't put an `NSView` into another process's window, so the helper runs as an agent app (no Dock icon). It shows an `NSWindow` at floating level while Soundcheck is the active app, and hides it when Soundcheck isn't. The Desktop App tells it which.
- **Linux** (not built yet): an X11 window made transient for the main window. Under Wayland that needs XWayland, and the Desktop App runs with `GDK_BACKEND=x11` when VST3 Plugins are in use.

Around the window:

- The Desktop App opens and closes it (`open-editor` and `close-editor`), titled *"<Track>: <Plugin>"*, and remembers where it was.
- The helper runs the window on its main thread's event loop, with commands read on a thread of their own and handed to the main thread. The spike, having no window, runs commands on the main thread.
- The Plugin resizes itself through `IPlugFrame::resizeView`. Where it can be resized, the helper resizes it with `onSize` after `checkSizeConstraint`. On Windows it passes the monitor's scale with `IPlugViewContentScaleSupport`.
- A setting the musician turns in the Plugin's window comes back as `performEdit`. The helper sends it up the pipe as it happens, and the Desktop App records it in the Project, as Automation when it is recording. `beginEdit` and `endEdit` bracket one undo step. `restartComponent` (new latency, reloaded values) is passed on too. (#70 records it as the setting's value, not yet as Automation: see [As #70 built it](#as-70-built-it).)

Embedding the Plugin's view inside the webview's window was considered and rejected. It works across processes on Windows (`SetParent`) and X11 (reparenting), with known trouble over focus and keyboard input, but not at all on macOS. One design for all three is worth more than a window that looks built in on two.

### What the Assistant can reach

The **Assistant** can reach only what a Plugin exposes: its name, vendor and kind, and the settings it lists, with title, units, steps and default. It can change a setting only if the Plugin lets it be automated and it isn't read-only or hidden, and it changes it as a normalised value from 0 to 1, as **Automation** does. The helper turns a value into the Plugin's own text for it (`getParamStringByValue`), so the Assistant can say *"Cutoff 1.2 kHz"* (built, but not yet given to the Assistant: see [As #70 built it](#as-70-built-it)). It can't read or change anything inside a Plugin's state. It hears a Plugin as it hears everything else, through a render. **Export** and the Assistant's listening render through the same helpers in `kOffline` mode, where a block has no deadline but the 500 ms hang limit still applies.

### In the Project

A VST3 Plugin in an Insert Chain, or as a Track's Instrument, was designed as a `type: "vst3"` of its own. #70 made it a **Plugin Effect** or **Plugin Instrument**, as a WASM Plugin is, so every panel, command and Automation Lane that works on a Plugin's settings works on it unchanged (schema 16):

```ts
{
  type: "plugin",
  plugin: { id: "vst3.<cid, lowercase hex>", version: string },
  settings: { [`p${ParamID}`]: number },           // normalised, 0 to 1
  vst3: {
    name: string; vendor: string;                    // for "missing" when it isn't installed
    state: { component: string; controller: string } // base64, as the Plugin gave them; "" before the first save
  },
}
```

- It is found by class id, never by path, so it is the same Plugin wherever it is installed. A different version still loads, because a VST3 Plugin must read its own older state.
- The state is fetched off the audio thread when the Project is saved, and at most every 2 s while its window is open or its settings change. When the helper crashes, the Desktop App offers **Reload**, which starts a new helper from the last state it has, so a crash loses at most those 2 s. It doesn't reload by itself: a Plugin that crashes every time it is loaded would crash in a loop.
- Automation of a VST3 setting is kept by the setting's id: `effect:<effect id>:p<ParamID>`, or `instrument:p<ParamID>`.
- A VST3 Plugin that isn't installed, or won't load, is kept exactly, and is bypassed (an Effect) or silent (an Instrument), as a missing **WASM Plugin** is (ADR 0003).
- `validate.ts` caps each state at 16 MB. That is room for a sampler's state, and still small enough that `project.json` stays readable to git and to the Changes of ADR 0007. For those Changes, the state is one value: the last write wins.
- The **Browser Version** opens a Project with VST3 Plugins, keeps each one exactly, and bypasses or silences it. Where Plugins are listed it says they need the Desktop App: `app/src/settings/desktop-only.ts` gains "VST3 Plugins" when #70 adds the platform part, null in the browser. This is ADR 0006's "Never", unchanged.

### Where it lives

All of it is in `desktop/`, never in `engine/`, as [ADR 0001](0001-audio-engine-in-rust.md) says:

- `desktop/vst3-host/` holds the helper, in C++, built with CMake against the SDK, which CMake fetches at a pinned tag. It is the only C++ in Soundcheck, and it's in a process of its own, so no C++ is linked into the Desktop App. The v4 PRD guessed at "a small C++ layer wrapped by Rust". This is that layer, but as a program the Rust talks to, not a library it links.
- The helper ships as a Tauri **sidecar** (`bundle.externalBin`), so it is installed next to the Desktop App and is signed and notarised with it by the installer work (#73).
- `desktop/src/vst3/` holds the Rust side: the protocol, the shared memory for each OS, one Plugin in its process, and the scan and its cache.
- The engine stays platform-free and knows nothing of VST3. It gets a second kind of Plugin behind its Plugin interface (ADR 0003): settings by id, notes and setting changes with frame offsets, a state blob, a result per block (processed, bypassed or crashed), and a block split into *begin* and *finish* so the callback can start them all at once. (#70 built the result per block and a slot the Desktop App fills; not the split, and not the state blob, which goes over the pipe: see [As #70 built it](#as-70-built-it).) `desktop/` implements it with helpers. WASM Plugins stay as they are, in-process in wasmtime: they can't crash the song, because wasmtime traps them.

### Each OS's shared memory and signals

| | Shared memory | *go* and *done* | Helper dies with the app | Crash handler |
| --- | --- | --- | --- | --- |
| Linux (spike) | `shm_open`, unlinked once mapped | process-shared POSIX semaphores inside it, `sem_timedwait` | `PR_SET_PDEATHSIG` | `sigaction` on `SIGSEGV`, `SIGBUS`, `SIGILL`, `SIGFPE`, `SIGABRT`, on `sigaltstack` |
| Windows | `CreateFileMapping`, unnamed, its handle inherited | two auto-reset events, handles inherited; `WaitForSingleObject` with a timeout | a Job Object with `KILL_ON_JOB_CLOSE` | `SetUnhandledExceptionFilter`, and Windows Error Reporting turned off for the helper so it dies at once |
| macOS | `shm_open` | `os_sync_wait_on_address_with_timeout` with its shared flag (macOS 14.4 and later) on a word in the memory; Mach semaphores if that proves unreliable | the helper watches its parent with `kqueue` | `sigaction`, as on Linux |

Only the Linux row has run. #70 built the Windows row differently, and the Linux row without `PR_SET_PDEATHSIG`: see [As #70 built it](#as-70-built-it). The macOS row is the least certain: its POSIX semaphores can't live in shared memory and have no timed wait, which is why the table doesn't use them.

## As #70 built it

#70 built the helper, the Desktop App's side, the engine's slot for it and the UI, Windows first. Where the build differs from the design above, this is what it does and why. All of it is proposed along with the rest.

**The Project.** A VST3 Plugin is a Plugin Effect or Plugin Instrument whose id is `vst3.<class id>` ([In the Project](#in-the-project)), not a `type: "vst3"` of its own. Its settings are its automatable ones, named `p<ParamID>`, as normalised values; its name, vendor and state are kept beside them. Schema 16 adds the `vst3` part, and `validate.ts` checks it (base64, 16 MB each state). A new Plugin is loaded before it is added, so it starts at its own defaults, with an empty state until the Project is saved.

**Each OS's shared memory.**
- *Windows*: a **named** file mapping and two named auto-reset events, in the session's `Local\` namespace under a random name, rather than unnamed ones with inherited handles: stable Rust's `Command` can't limit which handles a child inherits, so an inheritable handle would leak into every other process started meanwhile, and a random name in the session's own namespace is as private. The wait for *done* also waits on a high-resolution waitable timer (`CREATE_WAITABLE_TIMER_HIGH_RESOLUTION`), since `WaitForSingleObject`'s own timeout is in whole milliseconds, too coarse for a 2.7 ms block.
- *Windows and Linux*: the helper ends **when its stdin closes**, which it does whenever the Desktop App ends, however it ends. That replaces the Job Object and `PR_SET_PDEATHSIG`. It is read on a thread of its own, so a Plugin that has hung the helper's main thread doesn't keep it alive. The crash handlers are as designed: `SetUnhandledExceptionFilter`, with `SetErrorMode` turning off Windows' crash dialog, and `sigaction` on an alternate stack.
- The Desktop App calls `AllowSetForegroundWindow` for each helper, as designed, so a licence dialog can come to the front.

**One deadline, one Plugin after another.** Each audio callback sets one deadline, three quarters of the way through the time its buffer lasts, leaving the last quarter for the rest of the render. Every VST3 Plugin's block must be back by then, or is bypassed. But the engine still renders its slots in order, so each VST3 Plugin is handed its block and waited for before the next one starts; the *begin* and *finish* split, which would start them all at once, isn't built. A few VST3 Plugins cost a round trip each. The spike's 16 Plugins one by one had a p99 of 1.9–3.4 ms against a 2.7 ms block. So a Project with many VST3 Plugins at a small buffer may bypass blocks until the split is built. The bench on Windows ([To confirm](#to-confirm)) says whether it is needed.

**Setting changes** are cut by the engine where each happens, so each goes with its block at offset 0, and at most 64 go with a block (the latest of each). A Plugin lists at most 64 automatable settings to the Project, the first 64, as a WASM Plugin's manifest does. The changes of a block the helper missed are kept, as designed.

**The Plugin's window** is built on Windows only. Opening one elsewhere says *"A VST3 Plugin's own window opens only on Windows so far"*; the Plugin still runs, and its exposed settings are drawn in Soundcheck. The X11 and macOS windows wait for slice 6. Until slice 6, the macOS build has no shared memory for VST3 (making a block there fails, *"VST3 Plugins aren't supported on macOS yet"*), and the Desktop App on macOS offers no VST3 Plugins: Settings and each VST3 Plugin in a Project say so, and a Project keeps them exactly, as the Browser Version does. Where it was closed is remembered for the session, not saved. The helper applies what the musician turns in the window to the processor itself, and tells the controller of changes the processor reports, so the Desktop App only records them.

**What the window changes** is recorded as one undo step when the knob is let go of (`endEdit`), and only for exposed settings whose value changed. It is recorded as the setting's value, not as Automation while recording: recording Automation from any Plugin's window is for later. While the Assistant is carrying out a Request, the history refuses changes, so a knob turned then keeps its value in the Plugin but isn't recorded. The Plugin's state still reaches the Project.

**State** is fetched at most every 2 s while its window is open or its settings change, and every instance's is fetched when the Project is saved, into the file being written, outside undo: saving doesn't add an undo step, and a change to a Plugin's state alone doesn't mark the Project as having unsaved changes. So closing a Project whose Plugins were changed only in their own windows, with no exposed setting touched, doesn't ask first; saving it still keeps the change.

**Rates and offline renders.** A helper runs at one sample rate. When the device's rate changes, the instance is loaded again at the new rate from its current state. An Export or a listening render loads its own copy of each instance, from its current state, in offline mode, and ends it with the render, so the song playing is never disturbed.

**The Assistant** reads a running VST3 Plugin's exposed settings (`exposed` in `read_channel`, each with its label, unit and step) and changes them from 0 to 1, as for any Plugin. It never reads or changes the state. It can't add a VST3 Plugin, only the musician can: loading one can open a licence dialog, and takes up to a minute. It isn't yet given the Plugin's own text for a value; the helper and the Desktop App can already produce it. One that isn't running (the Browser Version, not installed, not loaded yet, failed or crashed) is *missing* to the Assistant, whose settings can't be changed until it runs.

**Scanning.** The Desktop App scans once when it starts, reading `moduleinfo.json` where there is one, and using a cache (`vst3-scan.json` in the app's data folder) keyed by the bundle's path, total size and newest modification time for a bundle a helper scanned. Settings shows what was found and what couldn't be read, and why, with **Rescan**, which rescans everything; there is no per-bundle retry button.

**Shipping.** The helper is a Tauri sidecar, as designed, but only in `pnpm desktop:build` (`scripts/updater.ts` adds `bundle.externalBin` for Windows and Linux), so `tauri dev` and the macOS build don't need it. The installer and packages put it beside the app, where the app looks for it; in a development build the app finds it where `pnpm vst3:build` leaves it. CI's Windows and Linux release jobs build it first, without the test Plugins.

## What was measured

Spike Faulty, a gain that does next to nothing, so the times are the cost of crossing between processes. 128-frame blocks at 48 kHz (2 667 µs), 20 000 blocks per row, on a Linux VM (Intel Xeon Platinum 8488C, 16 vCPUs, nothing at real-time priority). Two runs; ranges are across them. *One by one* waits for each Plugin before starting the next, against its own deadline. *All at once* starts all of them and then waits, against one deadline. *Paced* waits for the next block as an audio callback does.

| Plugins | Order | Callback | Mean | p99 | Max | Plugin blocks bypassed |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | one by one | flat out | 6–7 µs | 12 µs | 0.1–1.1 ms | 0 of 20 000 |
| 1 | one by one | paced | 160–180 µs | 432–442 µs | 4.4–8.1 ms | 11–19 of 20 000 |
| 16 | one by one | flat out | 297–346 µs | 1.9–2.3 ms | 8.7–8.8 ms | 6–7 of 320 000 |
| 16 | one by one | paced | 1.09–1.14 ms | 3.3–3.4 ms | 8.4–12.2 ms | 18–23 of 320 000 |
| **16** | **all at once** | flat out | **38–39 µs** | **63–64 µs** | 0.6–0.8 ms | 0 of 320 000 |
| 16 | all at once | paced | 240–257 µs | 516–540 µs | 4.2–7.3 ms | 112–158 of 320 000 |

- From a crash to the host knowing: 48–92 µs on average, 226 µs at most.
- Starting a helper and loading a Plugin: 1.3–1.6 ms on average.
- The worst single blocks are milliseconds on this VM, whatever the order. That is the scheduler waking threads that aren't real-time, which is what real-time priority on the Desktop App is for. It has to be measured on Windows (below).

## Why

- **It is the only design where a crash can't take the song down.** In-process hosting is what the PRD rules out. One helper for all Plugins, or one per vendor, means one Plugin's crash silences every other Plugin sharing its process. A helper each costs a round trip per block and a few MB. Started all at once, 16 of them cost 1.5% of a block here.
- **The audio thread's deadline is a hard limit.** A late, hung or dead Plugin costs its own output for a block, never the callback.
- **The SDK's own hosting classes are the reference implementation.** They are what Steinberg tests Plugins against: module loading on each OS, the Plugin provider, process data, parameter changes, event lists and memory streams. The helper is about 600 lines on top of them. Rust bindings (the `vst3` crate) would mean rewriting all of that and debugging it against Plugins that are tested only in C++ hosts.
- **It needs nothing from the app it can't test.** The Rust side only speaks a protocol, so everything but the Plugin can be tested with Plugins built from the SDK in CI.

## Licensing

- **The VST3 SDK is MIT-licensed.** This was checked in the SDK itself, not recalled: `LICENSE.txt` at tag `v3.8.1_build_84` (VST3 SDK 3.8.1, 11 August 2026, the latest), "MIT License, Copyright (c) 2026, Steinberg Media Technologies GmbH". The same text is in `base`, `pluginterfaces`, `public.sdk`, `cmake` and `doc`. MIT is compatible with Soundcheck's GPL-3.0-or-later. The helper links the SDK and is GPL like the rest, and the SDK's MIT notice ships with it among the third-party licences. VSTGUI (BSD-3-Clause) isn't used.
- **"VST" is Steinberg's trademark, and the SDK's `VST3_Usage_Guidelines.pdf` sets its terms.** Once Soundcheck refers to VST at all, the guidelines ask for:
  - the "VST Compatible" logo on every web page that mentions it (a footer or imprint alone isn't enough), in the documentation, and in the About box or its equivalent;
  - ® on the first use of "VST" in any product material;
  - the line *"VST is a registered trademark of Steinberg Media Technologies GmbH."* in the credits and documentation;
  - no made-up variants such as "VSTi". The glossary already avoids it.

  Soundcheck's README and PRDs already say "VST3", and #70 will put it in the Desktop App's UI. That is a decision for the maintainer (below), and nothing about it is changed here beyond this ADR's own ® and attribution.
- **No Plugin binaries are committed or shipped.** The spike builds the SDK's example Plugins and its own Spike Faulty from source, outside git. A musician's Plugins stay theirs, under their own EULAs.

## Alternatives

- **In-process**: the fastest, and what the PRD rules out.
- **One helper for all VST3 Plugins**: a single round trip per block for all of them, and one crash silences them all.
- **One helper per bundle or vendor**: fewer processes for Projects with many instances of one Plugin. It can be added later as a setting, since the protocol already hosts one Plugin per helper and would host several the same way.
- **A Rust helper on the `vst3` crate's bindings**: one language, but it rewrites the SDK's hosting classes (above).
- **Embedding the window in the webview's window**: impossible on macOS (above).

## Limits of this result

- Only Linux has run. Windows is the MVP's platform (ADR 0002), and nothing here has run on it.
- Only Plugins built from the SDK here: Spike Faulty, ADelay, AGain, and the mda set's DX10 (an Instrument, played by a note). None has copy protection. None of the SDK's examples has a window, because VSTGUI needs X11 libraries the sandbox doesn't have.
- The numbers come from a shared VM with nothing at real-time priority, and a Plugin that does no work.
- Stereo only, one main bus each way, 32-bit float. Side-chain inputs, surround and 64-bit processing are for later.

## Consequences

#70 builds it, Windows first, in slices:

#70 builds it, Windows first, in slices. Slices 1 to 5 are built, as [As #70 built it](#as-70-built-it) describes; slice 6 and the items after it are for later.

1. **The helper in `desktop/vst3-host/`**, from the spike's, with the Windows row of the table, built by CMake and shipped as a Tauri sidecar. CI builds it and the SDK's example Plugins on the Windows and Linux runners, from the pinned SDK tag, and runs the Desktop App's VST3 tests against them.
2. **`desktop/src/vst3/`**: the protocol, shared memory, one Plugin per helper, and the scan and its cache, tested as the spike is against the examples and a faulty Plugin.
3. **The engine's second kind of Plugin**, platform-free, and the Project's VST3 Plugin (a Plugin Effect or Instrument with a `vst3` part) in `model.ts`, `validate.ts` and `serialise.ts`, with a missing Plugin kept exactly.
4. **The UI**: the scanned list in Settings, adding a VST3 Plugin as an Effect or Instrument, its window, *crashed* with **Reload**, the Assistant's tools for its exposed settings, and the Browser Version's entry in `desktop-only.ts`.
5. **Export and the Assistant's listening** through the helpers in offline mode.
6. **macOS and Linux**: the macOS row of the table, and the macOS and X11 windows. (Linux's shared memory is built.)

Later, when they are needed: starting every VST3 Plugin's block at once (*begin* and *finish*); recording Automation from a Plugin's window; the Plugin's own text for a value in the Assistant's replies; AU on macOS.

## To confirm

The maintainer has to:

1. **Accept the design, as amended**: one helper process per Plugin instance, in C++ on the SDK's hosting classes, with shared memory for audio, one deadline for the callback, blocks processed, bypassed or crashed, and **Reload** by hand. The Project format above (a Plugin Effect or Instrument with a `vst3` part, schema 16) and its 16 MB cap on state come with it, and so do [As #70 built it](#as-70-built-it)'s differences: named objects on Windows, the helper ending with its stdin, one Plugin after another against the callback's deadline, the window on Windows only, states saved outside undo, and only the musician adding a VST3 Plugin.
2. **Decide how Soundcheck uses the VST trademark.** Follow Steinberg's usage guidelines in full: the VST Compatible logo on the README, the GitHub Pages site and the About box, ® on first use, and the attribution line in the credits. Or ask Steinberg (reception@steinberg.de) whether a GPL project's plain-text mention of VST3 compatibility needs all of that. Either way, the SDK's MIT notice ships with the Desktop App.
3. **Check by hand on Windows, with Plugins bought or installed there**, once #70 has built it. None of this can be done here: no Windows, no display, and no purchased Plugins.
   - A scan of the real VST3 folder finds them all. One that pops a dialog while it is scanned doesn't stop the scan.
   - A Plugin under iLok or PACE, and one with an activation dialog, load, and their dialogs come to the front.
   - Each Plugin's window opens beside Soundcheck, stays above it, moves and minimises with it, resizes if the Plugin allows, is sharp at 150% scaling, and takes keyboard input. Turning a knob in it moves the setting in Soundcheck, and undo puts it back.
   - Killing a helper in Task Manager mid-song leaves every other Track playing. The Plugin shows *crashed*, and **Reload** brings it back as it was.
   - A song with 16 VST3 Plugins plays at a 128-frame buffer on the maintainer's Windows machine without dropouts, and without blocks bypassed. Since #70 runs them one after another, this says whether *begin* and *finish* are needed. Record the numbers there next to these.
   - A Project with VST3 Plugins saves, closes, reopens and sounds the same. A Plugin changed only in its own window keeps that change once the Project is saved.
   - The installer puts `soundcheck-vst3-host.exe` beside `soundcheck-desktop.exe`, signed as the app is, and Windows Defender and SmartScreen don't stop it starting.
   - An Export, and the Assistant listening, of a song with a VST3 Plugin sound as it plays.
   - Changing the audio device's sample rate in Settings reloads each Plugin as it was.

---

VST is a registered trademark of Steinberg Media Technologies GmbH.

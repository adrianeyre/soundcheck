# PRD: Soundcheck MVP

Terms in **bold** are defined in [`CONTEXT.md`](../../CONTEXT.md).

## Problem

Making a track in a DAW means hundreds of small manual edits: programming drums, choosing sounds, balancing levels, fixing a muddy mix. Musicians know what they want ("a punchier kick", "build up the last 8 bars") long before they know which knobs get them there. No DAW lets you describe the change and have it made — and none can listen to your mix and tell you what's wrong with it.

## Goal

A working, end-to-end DAW in which a musician can build a short song by hand **and** by asking the **Assistant**, which can both edit the **Project** and listen to how it sounds. It is good enough for the author to use daily, and its **Project** model is the foundation every later version builds on.

## Who it's for

The author, as a personal tool released as open source (GPL-3.0). Other people can build and run it from source; installers, signing and onboarding are not part of the MVP.

## Milestone 0 — latency test (decides the platform)

Before building the MVP, a throwaway prototype answers one question: can the MVP run in the browser without lag? The prototype runs the Rust **Audio Engine** core compiled to WASM inside an AudioWorklet, in Chrome, on the author's own machine with their audio interface and MIDI keyboard.

The browser wins only if **all three** pass:

1. **Key-to-sound latency ≤ 20 ms** — measured by recording the MIDI key's click and the synth's output together.
2. **16 tracks, each running the Synth plus EQ, Compressor and Reverb, play for 10 minutes with no dropouts**, at a buffer size the browser actually provides.
3. **The UI stays at 60 fps** (smooth playhead) while test 2 runs.

If any test fails, the MVP is a desktop app (Tauri, with the engine on the native audio driver via cpal). Either way the result, with its numbers, is recorded as ADR 0002. The prototype's engine code is kept.

**Result: the browser failed, so the MVP is a desktop app** ([ADR 0002](../architectural-decision-record/0002-mvp-is-a-desktop-app.md)). Test 1 failed: key-to-sound latency measured 80 ms against the 20 ms limit, with Chrome reporting a 10 ms buffer and 48 ms of output latency on the author's Windows laptop. Tests 2 and 3 weren't run to completion, since test 1 alone decides the outcome; partial runs of 16 Tracks were clean. The test used the laptop's built-in audio and a computer keyboard, because no audio interface or MIDI keyboard was available.

Requirements below that differ by platform are marked **[web]** / **[desktop]**. Following ADR 0002, the **[desktop]** requirements apply; the **[web]** ones are kept only as a record of the alternative.

## Architecture constraints

- The **Audio Engine** core is portable Rust ([ADR 0001](../architectural-decision-record/0001-audio-engine-in-rust.md)). All sound — playback, **Instruments**, **Effects**, recording, **Audio Analysis**, export — happens there.
- The UI is React. It never processes audio; it sends commands to the engine and shows what the engine reports.
- The whole **Project** is plain, versioned data. Every note, setting and **Clip** position is data the UI, undo history and **Assistant** all edit the same way.
- **[web]** Chromium browsers only (Chrome, Edge). **[desktop]** Windows first, since it is the author's machine; the code is not written in a way that rules out Linux or macOS.

## User stories

### Projects

1. As a musician, I can create a new **Project**, set its name, tempo and time signature, and save it as a folder on disk.
2. As a musician, I can reopen a saved **Project** and find it exactly as I left it.
3. As a musician, I can move or share a **Project** folder and it still opens, because it contains its own copies of all audio it uses.

### Tracks and clips

4. As a musician, I can add, rename, reorder and delete **Audio Tracks** and **Instrument Tracks**.
5. As a musician, I can choose an **Instrument Track's** **Instrument** (Synth or Drum Sampler) and one of its presets.
6. As a musician, I can create a **Pattern Clip** on an **Instrument Track** and edit its notes in the **Step Sequencer**.
7. As a musician, I can record notes from a MIDI keyboard into a **Pattern Clip**.
8. As a musician, I can import a WAV, FLAC or MP3 file onto an **Audio Track** as an **Audio Clip**.
9. As a musician, I can record from any audio input onto an **Audio Track**.
10. As a musician, I can move, copy, trim and delete **Clips** on the timeline, snapping to a grid.

### Playback

11. As a musician, I can play, stop, and loop a region, with a metronome I can switch on and off.
12. As a musician, I can play my MIDI keyboard through the selected **Instrument Track** live.

### Mixing

13. As a musician, I can set each Track's volume and pan, mute or solo it, and see its level meter.
14. As a musician, I can add, reorder, bypass and remove **Effects** in any Track's **Insert Chain** or the **Master's**, and change their settings.

### Export and undo

15. As a musician, I can export the whole song as a WAV file.
16. As a musician, I can undo and redo any change.

### The Assistant

17. As a musician, I can enter my Claude API key once and have it remembered on this machine.
18. As a musician, I can type a **Request** ("add a four-on-the-floor kick and a bassline in A minor") and the **Assistant** makes the changes in my **Project**.
19. As a musician, I can ask the **Assistant** about how my song sounds ("why does it sound muddy?", "is anything clipping?") and it listens before answering or fixing.
20. As a musician, after a **Request** I see a short summary of what changed, and one undo reverts the whole **Request**.

## Requirements

### Built-in sounds

- **Synth**: a subtractive synth (oscillators, filter, envelopes, LFO) with about 10 factory presets covering bass, lead, pad, pluck and keys.
- **Drum Sampler**: 8–16 pads, each playing a WAV sample; the user can load their own samples onto pads. One starter drum kit is bundled.
- **Effects**: EQ, Compressor, Reverb.

### Mixer

- Per Track: volume, pan, mute, solo, **Insert Chain**, level meter.
- **Master**: volume, **Insert Chain**, level meter.
- Every Track feeds the **Master** directly (no sends or buses).

### Timing

- One tempo per **Project**, adjustable but constant through the song.
- One time signature per **Project**, selectable but constant.
- Loop region, metronome, snap-to-grid (bars, beats, subdivisions).

### Audio in and out

- Import WAV, FLAC and MP3; imported audio is copied into the **Project** folder.
- Record from any available input device.
- Export the full mix as WAV, rendered offline (faster than real time).
- **[desktop]** Audio on Windows goes through cpal. Target a 256-sample buffer at 48 kHz (~5 ms) with no dropouts on 16 tracks, and key-to-sound within Milestone 0's 20 ms. Windows' shared audio path alone may not reach that (Milestone 0 saw a 10 ms buffer there), so the desktop shell (#28) finds out whether shared mode is enough or whether cpal's ASIO support is needed.
- **[web]** The buffer size is whatever the browser provides; Milestone 0's thresholds are the latency and load targets.

### Undo

- Every change — by hand or by the **Assistant** — can be undone and redone.
- All changes from one **Request** are a single undo step.

### The Assistant

- Uses Claude only, with the user's own API key. The key is stored on the machine (**[web]** browser storage; **[desktop]** the OS credential store, Windows Credential Manager first) and never written into a **Project**.
- Changes apply straight away, with a summary of what changed; there is no approve-first step (one-step undo is the safety net).
- Tools available to the **Assistant** in the MVP:
  - create, rename or delete a Track
  - set a Track's **Instrument** and preset
  - write or replace a **Pattern Clip's** notes
  - place, move or delete **Clips**
  - set tempo
  - set a Track's volume, pan, mute or solo
  - add, remove or reorder an **Effect**, and set an **Effect's** settings
  - `analyse_audio` (below)
- **Listening**: Claude's API does not accept audio, so the **Assistant** listens through **Audio Analysis**. It calls `analyse_audio` only when a **Request** needs it, choosing the whole mix, one Track, or a time range. The **Audio Engine** renders that audio offline and returns measurements:
  - loudness (LUFS, RMS) and peaks, including clipping
  - energy per frequency band
  - detected key and tempo
  - where sounds start (onsets)
- **Stretch goal**: `analyse_audio` can also return a spectrogram image, sent via Claude's image input.

## Acceptance criteria

- [x] Milestone 0 has run on the author's machine, and ADR 0002 records the platform decision with the measured numbers.
- [ ] A song with at least 4 **Instrument Tracks** and 2 **Audio Tracks** can be built, saved, closed, reopened and exported to WAV without a single edit lost.
- [ ] A **Project** folder copied to another location opens with all audio intact.
- [ ] 16 tracks, each running the Synth plus the three **Effects**, play without dropouts on the author's machine.
- [ ] A MIDI keyboard can play and record into an **Instrument Track**.
- [ ] Every user story's action can be undone and redone.
- [ ] The **Request** "make a 4-bar drum beat at 120 BPM with a bassline" produces a playable result in a new **Project**.
- [ ] The **Request** "the mix is clipping — fix it" calls `analyse_audio`, finds the loud Track or the **Master**, and lowers its level so a new analysis shows no clipping.
- [ ] One undo after any **Request** restores the **Project** exactly as it was before.
- [ ] The API key is never found inside a saved **Project** folder.

## Out of scope for the MVP

- Piano roll, automation, sends/buses/return tracks, the Delay effect, tempo or time-signature changes within a song (v2)
- Saving your own presets, a sample browser, a third-party plugin SDK (v2)
- **Assistant** conversations spanning several **Requests**, other models or providers, models that take audio directly (v3)
- VST3/AU plugins, installers and code signing, collaboration (v4)
- Firefox and Safari **[web]**; Linux and macOS builds **[desktop]**
- Time-stretching or pitch-shifting audio
- MIDI file import/export

## Open questions

- ~~Milestone 0's outcome — web or desktop.~~ Answered: desktop ([ADR 0002](../architectural-decision-record/0002-mvp-is-a-desktop-app.md)).
- ~~**[web]** Whether recording latency in the browser is acceptable for recording while listening back.~~ No longer applies: the MVP is not a browser app.
- ~~**[desktop]** Which OS comes first.~~ Answered: Windows, the author's machine. Linux and macOS follow in v4.
- ~~Exactly which key-detection and loudness algorithms the **Audio Engine** uses for **Audio Analysis**.~~ Answered in the engine: loudness per ITU-R BS.1770-4 and EBU R 128 (`engine/src/analysis/loudness.rs`), and key by the Krumhansl–Schmuckler algorithm over a chroma (`engine/src/analysis/key.rs`).
- ~~How much of the **Project** is sent to Claude on each **Request** once songs get large.~~ Answered in [v3](v3.md): a summary, then read tools.

# The DJ Mixer runs in the Audio Engine, beside the song, and is added to the output after the song's Master

**Status: proposed** in the pull request that adds the **Mixing page**, which [its PRD](../product-requirements-document/mixing.md) specifies.

The **Mixing page** plays files on **Decks** into a DJ mixer: two to four files at once, each at its own tempo, time-stretched, EQ'd, filtered, crossfaded and through Colour FX and Beat FX. That is audio processing, which the UI never does ([ADR 0001](0001-audio-engine-in-rust.md)). It is also not the song: nothing on the page is part of a **Project**.

## Decision

**In the engine, beside the song.** The DJ Mixer is `engine/src/dj/`: a `DjMixer` of four `Deck`s, four mixer channels, a **Crossfader**, Colour FX, Beat FX, a headphone mix and a recorder. The `Engine` holds one once it is first used and renders it in `render`, after the song's Master has been clamped and metered, then adds it to the output. So:

- the song's meters, Audio Analysis and exports never hear it: an offline render gets no DJ command, and both hosts' export paths leave `djSet` out;
- it plays out of the same output, on the desktop (cpal) and in the Browser Version (the AudioWorklet), with no second engine, clock or device;
- the Editor's song keeps its own state. It is stopped when the Mixing page opens (the page sends `stop`), so only the mix is heard, but a live note or a tail still sums in rather than being cut off.

**Commands by name, parsed off the audio thread.** One `EngineCommand`, `djSet { kind, index, name, value }`, sets any control: a Deck's (`play`, `cueDown`, `tempo`, `sync`, `autoLoop`…), a channel's (`eqHigh`, `fader`, `assign`…) or the mixer's (`crossfader`, `beatFxType`…). `DjControl::parse` turns the name into an enum; the desktop parses it on the control side, so the audio thread only matches an enum. A name there isn't is nothing to send. The engine reports back one flat array of numbers (`DjMixer::report`, laid out as `app/src/dj/dj-report.ts` reads it): the desktop publishes it through atomics like the other meters, the worklet posts it with its reports.

**A file is decoded and analysed off the audio thread, and moved in whole.** Loading a Deck decodes the file, resamples it to the engine's rate and analyses its BPM, **Beat Grid**, key and a three-band waveform (`dj/analysis.rs`, from the Assistant's own `analysis/`), which takes up to a second for a long track. On the desktop the Tauri command `dj_load` does it outside the audio lock and pushes the prepared file; in the browser the page's own copy of the WASM engine does it (`dj_prepare`) and transfers the samples to the worklet, which only copies them in. Loops, cues, **Sync**, **Slip** and the FX change only where a Deck reads and what it multiplies by; the Beat FX, echoes and reverbs allocate their buffers when the mixer is built, off the audio thread on the desktop (`DjInstall`), and the old mixer or file goes back as garbage.

**Master Tempo by WSOLA.** A Deck with **Master Tempo** or a **Key Shift** is read by overlapping 42 ms Hann-windowed grains at the pitch wanted, each started near the playhead (which moves at the tempo) where it best matches the grain fading out. It reads straight from the file, so it allocates nothing. It holds the pitch to within 0.5% from half to 1.6 times the speed; how it sounds on drums at wide ranges is untested (the PRD's risk).

**The Beat Grid is the engine's.** Sync, **Quantize**, loops and Beat Jump go by each Deck's grid, which the engine holds: the analysis's, or one set with Tap and the grid nudges. Sync sets a follower's speed to the **Sync Master**'s BPM over its own, jumps its beats into line once, and then eases out any drift with a speed trim of at most 3%.

**The headphone cue goes out of outputs 3 and 4.** A DJ interface has four outputs; the cued channels, blended with the Master, go out of the third and fourth. The desktop writes them into any device with four or more channels. The Browser Version opens the worklet with four channels when the output device has them (`maxChannelCount`) and does the same. On a two-channel output the cue buttons still work and the page says the cue can't be heard; no second device is opened.

**A recording is the engine's, encoded by the engine, saved by the platform.** While the mixer records, it copies the Master into a buffer it drains each block: the desktop into a lock-free queue the UI takes with `dj_recording_take`, the worklet with its reports. On stop, the page encodes it with the engine's own `encode_wav` (24-bit) or `encode_mp3` (320 kbps) and saves it through `DjRecordingSaver`, which `platform.ts` picks: the system's save dialog on the desktop, the File System Access API's or a download in the browser, as an export saves.

**Not in the Project.** Decks, the files on them, cues and knobs are the page's state for its session. The engine's side is lost when the audio restarts; the page then sends every knob again, and the DJ loads the Decks again.

## Considered and rejected

- **Web Audio for the Browser Version's Decks.** It would decode and play files in the browser with its own nodes, but it is the UI processing audio, would sound different from the desktop, and couldn't share the Beat Grid, Sync and FX code.
- **A second engine instance for the DJ Mixer.** It would keep the song's engine untouched, but needs a second device stream or a mix of two engines on the desktop, and a second worklet in the browser.
- **Decoding in the worklet**, as `loadAudioFile` does for Audio Clips. A track takes long enough to decode and analyse that the other Deck would drop out while it loads, which a DJ loading the next track mid-mix can't have.

## Consequences

- The `Engine` grows a DJ Mixer that only the Mixing page uses; until then it is `None` and costs nothing.
- Four time-stretched Decks with Beat FX at a small buffer may be more than a laptop manages; the Settings load test measures the song's engine, not this.
- Two-channel outputs, the usual laptop case, have no headphone cue.

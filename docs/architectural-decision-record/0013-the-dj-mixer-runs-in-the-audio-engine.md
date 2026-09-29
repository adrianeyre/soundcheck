# The DJ Mixer runs in the Audio Engine, beside the song, and is added to the output after the song's Master

**Status: proposed** in the pull request that adds the **Mixer page**, which [its PRD](../product-requirements-document/mixing.md) specifies.

The **Mixer page** plays files on **Decks** into a DJ mixer: two to four files at once, each at its own tempo, time-stretched, EQ'd, filtered, crossfaded and through Colour FX and Beat FX. That is audio processing, which the UI never does ([ADR 0001](0001-audio-engine-in-rust.md)). It is also not the song: nothing on the page is part of a **Project**.

## Decision

**In the engine, beside the song.** The DJ Mixer is `engine/src/dj/`: a `DjMixer` of four `Deck`s, four mixer channels, a **Crossfader**, Colour FX, Beat FX, a headphone mix and a recorder. The `Engine` holds one once it is first used and renders it in `render`, after the song's Master has been clamped and metered, then adds it to the output. So:

- the song's meters, Audio Analysis and exports never hear it: an offline render gets no DJ command, and both hosts' export paths leave `djSet` out;
- it plays out of the same output, on the desktop (cpal) and in the Browser Version (the AudioWorklet), with no second engine, clock or device;
- the Editor's song keeps its own state. It is stopped when the Mixer page opens (the page sends `stop`), so only the mix is heard, but a live note or a tail still sums in rather than being cut off.

**Commands by name, parsed off the audio thread.** One `EngineCommand`, `djSet { kind, index, name, value }`, sets any control: a Deck's (`play`, `cueDown`, `tempo`, `sync`, `autoLoop`…), a channel's (`eqHigh`, `fader`, `assign`…) or the mixer's (`crossfader`, `beatFxType`…). `DjControl::parse` turns the name into an enum; the desktop parses it on the control side, so the audio thread only matches an enum. A name there isn't is nothing to send. The engine reports back one flat array of numbers (`DjMixer::report`, laid out as `app/src/dj/dj-report.ts` reads it): the desktop publishes it through atomics like the other meters, the worklet posts it with its reports.

**A file is decoded and analysed off the audio thread, and moved in whole.** Loading a Deck decodes the file, resamples it to the engine's rate and analyses its BPM, **Beat Grid**, key and a three-band waveform (`dj/analysis.rs`, from the Assistant's own `analysis/`), which takes up to a second for a long track. On the desktop the Tauri command `dj_load` does it outside the audio lock and pushes the prepared file; in the browser the page's own copy of the WASM engine does it (`dj_prepare`) and transfers the samples to the worklet, which only copies them in. Loops, cues, **Sync**, **Slip** and the FX change only where a Deck reads and what it multiplies by; the Beat FX, echoes and reverbs allocate their buffers when the mixer is built, off the audio thread on the desktop (`DjInstall`), and the old mixer or file goes back as garbage.

**Master Tempo by WSOLA.** A Deck with **Master Tempo** or a **Key Shift** is read by overlapping 42 ms Hann-windowed grains at the pitch wanted, each started near the playhead (which moves at the tempo) where it best matches the grain fading out. It reads straight from the file, so it allocates nothing. It holds the pitch to within 0.5% from half to 1.6 times the speed; how it sounds on drums at wide ranges is untested (the PRD's risk).

**The Beat Grid is the engine's.** Sync, **Quantize**, loops and Beat Jump go by each Deck's grid, which the engine holds: the analysis's, or one set with Tap and the grid nudges. Sync sets a follower's speed to the **Sync Master**'s BPM over its own, jumps its beats into line once, and then eases out any drift with a speed trim of at most 3%.

**The headphone cue goes out of a second device the DJ picks, or outputs 3 and 4.** The cued channels, blended with the Master by the headphone MIXING knob at its LEVEL, are the engine's headphone mix. It reaches the DJ's ears two ways, behind `HeadphoneOutput` in `platform.ts`:

- **A second output device** (headphones, a USB headset), picked in the mixer's HEADPHONES section and remembered on the machine (`soundcheck.dj.headphones`). On the desktop the shell opens a second cpal stream on it (`desktop/src/headphones.rs`). The main output's audio thread pushes the headphone mix, interleaved, into a lock-free single-producer, single-consumer ring (`rtrb`), whole frames only, dropping what doesn't fit; the headphone stream's audio thread reads it through a `DriftReader`, which resamples by the two devices' rates (the device runs at the engine's rate where it can, at its own otherwise) and nudges that ratio by up to 0.5% to keep the ring about 40 ms full, so two clocks that drift apart neither run it dry nor overfill it. Run dry, it is silent until the ring fills again. Neither thread locks or allocates; the ring comes and goes as a prepared command, and the old one is dropped off the audio thread. A device that goes away is marked failed by its error callback, and the page says so. The chosen device follows the main output: it is opened again on each new one, on the same audio host. In the Browser Version the worklet always renders four channels; a splitter sends the first two (and, on a four-channel device, the cue) to the output and the cue to a `MediaStreamAudioDestinationNode`, which an audio element plays out of the chosen device with `setSinkId`, listed by `enumerateDevices()`. That adds the audio element's own buffering, some tens of milliseconds, to the cue, which is fine for previewing what is coming up. A browser without `setSinkId` (Firefox, Safari) has no `HeadphoneOutput`: the picker says so, and Settings lists it as the Desktop App's.
- **Outputs 3 and 4** of an interface with four or more, as a DJ interface has, in both versions, as before.

On a two-channel output with no second device chosen, the cue buttons still work and the page says the cue can't be heard.

**A recording is the engine's, encoded by the engine, saved by the platform.** While the mixer records, it copies the Master into a buffer it drains each block: the desktop into a lock-free queue the UI takes with `dj_recording_take`, the worklet with its reports. On stop, the page encodes it with the engine's own `encode_wav` (24-bit) or `encode_mp3` (320 kbps) and saves it through `DjRecordingSaver`, which `platform.ts` picks: the system's save dialog on the desktop, the File System Access API's or a download in the browser, as an export saves.

**Not in the Project.** Decks, the files on them, cues and knobs are the page's state for its session. The engine's side is lost when the audio restarts; the page then sends every knob again, and the DJ loads the Decks again.

## Considered and rejected

- **Web Audio for the Browser Version's Decks.** It would decode and play files in the browser with its own nodes, but it is the UI processing audio, would sound different from the desktop, and couldn't share the Beat Grid, Sync and FX code.
- **A second engine instance for the DJ Mixer.** It would keep the song's engine untouched, but needs a second device stream or a mix of two engines on the desktop, and a second worklet in the browser.
- **Decoding in the worklet**, as `loadAudioFile` does for Audio Clips. A track takes long enough to decode and analyse that the other Deck would drop out while it loads, which a DJ loading the next track mid-mix can't have.

## Consequences

- The `Engine` grows a DJ Mixer that only the Mixer page uses; until then it is `None` and costs nothing.
- Four time-stretched Decks with Beat FX at a small buffer may be more than a laptop manages; the Settings load test measures the song's engine, not this.
- A two-channel output, the usual laptop case, needs a second device chosen for the headphone cue.
- The headphone cue on a second device runs on its own clock and a little behind the Master (the ring's 40 ms, and in the browser the audio element's buffering): enough to preview, not to beat-match by ear against the Master in one ear.

## Amended: the Sampler, and a session the Pads page shares

The **Pad Controller** (the Pads page's, and a Widget of the Mixer page's) plays a **Sampler** as DJ software's does, so the DJ Mixer grows one, in the engine as everything else here is.

- **The Sampler is part of the DJ Mixer** (`engine/src/dj/sampler.rs`): 64 **Sampler Slots** (four banks of sixteen), each a decoded sample at the engine's rate, a read position, a mode (one-shot, gate or loop), a level and a short fade so a stop, pause or retrigger doesn't click. Its sum goes into the Master past the Crossfader, at the Sampler Gain, and into the headphone cue when its cue is on. Its controls are named like the others' (`"sampler"`, by slot, and `samplerGain`, `samplerCue`, `samplerStopAll` on the mixer), and the report grows a Sampler section after the Decks (its meter, gain, cue and each slot's state).
- **A sample reaches a slot as a Deck's file does:** decoded and resampled off the audio thread (the desktop's `dj_sample_load` command, the browser page's `dj_prepare_sample`), moved in whole (`RtCommand::DjSample`, the worklet's `djSample` message), the one it replaces dropped off the audio thread. Playing one only moves a read position.
- **The recording can take the Sampler alone** (`recordSource`), so what was played on the pads can go into the song by itself.
- **Silent Cue and Slip Reverse are the Deck's**: a mute that the Deck plays on under, which calling a Hot Cue ends; and Reverse held with Slip, which ends itself after 8 beats backwards.
- **One session, two pages.** The Mixer page and the Pads page draw over one session (`app/src/dj/dj-session.ts`), started when the first of them opens and kept while the app is open, so both drive the same Decks, Sampler and recording.
- **The Sampler's slots are kept** in the app-level library (`dj-sampler/`), not the session: they are the DJ's instrument. Everything else stays the session's.
- **"Add to song" is the exception to "Not in the Project"**, and only when the DJ asks: the last recording goes into the Editor's Project, through the Editor, as a new Audio Track with one Audio Clip, as one undo step.

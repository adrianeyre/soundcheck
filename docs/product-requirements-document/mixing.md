# PRD: The Mixer page (DJ Mixer)

Terms in **bold** are defined in [`CONTEXT.md`](../../CONTEXT.md). Where the DJ Mixer runs, and how its sound reaches the audio output beside the song, is settled in [ADR 0013](../architectural-decision-record/0013-the-dj-mixer-runs-in-the-audio-engine.md); this doc covers what is built on it. It ships in one pull request with the Editor's new Widgets.

## Problem

A producer finishes a track in Soundcheck and then wants to hear it in a set: next to the records it will be played with, beat-matched, EQ'd and faded against them. Today that means exporting a WAV, opening separate DJ software, and coming back to fix what they heard. Soundcheck can play one song. It can't play two files at once at matched tempos, beat-match them, or blend them with a crossfader. A **Reference Track** can only be auditioned alone, past the mixer.

## Goal

A **Mixing** page, beside the Editor and Settings, that works like a club setup: Pioneer CDJ-3000 players into a DJM-V10 / DJM-A9 mixer. The DJ loads MP3, WAV or FLAC files onto **Decks**, sees each one as a coloured waveform with its **Beat Grid**, BPM and key, and mixes them with **Sync**, **Hot Cues**, loops, EQ, Colour FX, Beat FX and a **Crossfader**. The mix can be recorded to a file. Every control is visual, and every drag has a keyboard alternative.

## Who it's for

The author first, as a producer who DJs: testing their own tracks in a mix, preparing sets, and recording mixes, on the Windows desktop app. The **Browser Version** gets the same page, less what a browser can't do (see [Platforms](#platforms)).

## Architecture constraints

- **All sound in the Audio Engine.** Decoding, playback, rate and pitch change, time-stretching, EQ, filters, FX, the crossfade, metering and BPM, beat and key analysis all run in the Rust engine (`engine/`), as every other sound does ([ADR 0001](../architectural-decision-record/0001-audio-engine-in-rust.md)). The UI only sends commands and draws what the engine reports. It reuses the engine's decoder (`audio_file.rs`), resampler, biquads and analysis (`analysis/tempo.rs`, `onsets.rs`, `key.rs`, `peaks.rs`).
- **Not part of the Project.** **Decks**, their files, cues and mixer settings are the DJ's session, not the song. Nothing on the page changes the **Project**, goes into its undo history, reaches an export of the song, or is seen by the **Assistant**. The page's audio goes out the same audio output as the song, as ADR 0013 describes.
- **Allocation-free on the audio thread.** A file is decoded and analysed off the audio thread and moved in whole, as Audio Clips' files are. Loops, cues, **Sync** and FX change only where a **Deck** reads and what it multiplies by.
- **Desktop first, one platform seam.** Anything platform-dependent (a second output device for the headphone cue, where a recording is saved) goes behind an interface picked in `app/src/platform.ts`. Where the **Browser Version** can't have it, its part is null and it is listed in `app/src/settings/desktop-only.ts`.
- **No test needs audio hardware.** Engine tests render into buffers and assert on the samples. UI tests use a fake audio output.

## User stories

### The page

1. As a DJ, **Menu → Mixer** opens the Mixer page, as Settings opens. The Editor's song stops while it is open, and going back leaves my **Decks** as they were.
2. As a DJ, I choose a layout of two or four **Decks** around the mixer.
3. As a DJ, the **Track browser** has two tabs. **Folders** is the Editor's sample folder tree: I browse my audio folders, audition a file, and put it on any **Deck** from its "Put on" list or by dragging it onto the Deck. **Loaded tracks** lists the files I've loaded, with title, BPM, key (in Camelot notation too) and length, sortable by any column. I can also load a file straight from my disk with a Deck's SOURCE button or by dropping it on the Deck. Where the platform has no sample folders, the Folders tab says so and the page opens on Loaded tracks.
4. As a DJ, keyboard shortcuts play, cue and sync each **Deck**, and every drag (jog wheel, faders, knobs, waveform) has a keyboard alternative, meeting WCAG 2.2 AA as the rest of the app does.

### Decks (CDJ-3000)

5. As a DJ, a loaded **Deck** shows the title, elapsed and remaining time, BPM (the file's and at the current tempo), key and tempo change. The remaining time flashes near the track's end.
6. As a DJ, I see an overview of the whole track as a waveform coloured by its low, mid and high energy, with the playhead, cues and loop. Clicking it moves the playhead there (Needle Search).
7. As a DJ, across the top of the page, above the **Decks** and the mixer, a waveform stack shows one lane per loaded **Deck**. Each lane is a coloured waveform scrolling past a fixed centre playhead, with the **Beat Grid**'s beats and bars on it and the Deck's number, BPM, key and remaining time beside it. The lanes share one zoom, so the beats line up visibly between Decks. Each Deck's display shows a count of beats to the next cue.
8. As a DJ, each **Deck** and the mixer look and work like the club hardware they model, on a dark metal panel with the controls where the hardware has them: big lit CUE and PLAY buttons that blink as on a player, a jog wheel with a centre display, lit pads and buttons, LED meters and long faders. No maker's name or logo is printed on them. BROWSE jumps to the Track browser, and a time-mode button switches the jog's display between elapsed and remaining time.
9. As a DJ, **Play/Pause** and **Cue** work as on a CDJ. Paused, Cue sets the cue point at the playhead. Playing, Cue returns to it and pauses. Holding Cue while paused plays from it until I let go.
10. As a DJ, the jog wheel turns with the track, with its cue and **Hot Cues** marked around the ring. In vinyl mode, dragging the platter scratches. In CDJ mode, dragging its edge bends the pitch to nudge the beat. Vinyl brake and spin-back stop and start the **Deck** as a turntable does, at a speed I set.
11. As a DJ, eight **Hot Cues** per **Deck**, each in its own colour and with a name, are set, jumped to and cleared with one press each. With **Quantize** on, they land on the nearest beat.
12. As a DJ, loops: auto-loops of 1/32 to 512 beats, loop in and out, halve, double, reloop and exit, drawn on both waveforms. With **Quantize** on, they snap to the **Beat Grid**.
13. As a DJ, **Beat Jump** moves the playhead by 1, 4, 16 or 32 beats either way, in time.
14. As a DJ, **Slip** mode keeps the track running silently underneath a loop, scratch, reverse or Hot Cue, and returns to where it would have been when I let go.
15. As a DJ, **Reverse** plays the track backwards.
16. As a DJ, the tempo fader has ranges of ±6, ±10, ±16 and WIDE (±100%), a reset, and a readout to 0.01%. **Master Tempo** (key lock) keeps the pitch where it is while the tempo changes.
17. As a DJ, **Sync** matches a **Deck**'s tempo to the **Sync Master**'s and lines its beats up with the Master's, and keeps them lined up. One **Deck** is the Master, marked, and I can make another the Master.
18. As a DJ, **Key Shift** moves a **Deck**'s pitch in semitones, and **Key Sync** moves it to the key nearest the Master's that mixes with it. Keys that mix well with the Master (the same key, a fifth either way, or its relative minor or major on the Camelot wheel) are highlighted.
19. As a DJ, **Tap** tempo and grid nudges put the **Beat Grid** right where the analysis got it wrong.

### Mixer (DJM-V10 / A9)

20. As a DJ, each channel has a trim, a four-band EQ (high, high-mid, low-mid, low) that switches between EQ curves (+6 to −26 dB) and isolator mode (a full kill), a per-channel compressor knob, a Colour FX knob, a channel fader with a curve I choose, a crossfader assign (A, THRU, B), a cue button, a peak meter with peak hold, and its BPM.
21. As a DJ, Colour FX (Space, Dub Echo, Sweep, Noise, Crush and Filter) is chosen once for the mixer and turned per channel: left of centre does one thing, right of centre another, and centre is off.
22. As a DJ, Beat FX are Delay, Echo, Ping Pong, Spiral, Reverb, Trans, Filter, Flanger, Phaser, Pitch, Slip Roll, Roll, Vinyl Brake and Helix. Each is timed to the Master's BPM by a beat division from 1/16 of a beat to 16 bars, applied to a channel, a crossfader side or the Master, with a level/depth and an on/off. I can tap its BPM.
23. As a DJ, the **Crossfader** blends side A with side B on a curve I choose (smooth, constant power or a sharp cut), and can be reversed.
24. As a DJ, the Master has a level, a booth level, and a stereo meter with peak hold and a clip indicator.
25. As a DJ, the headphone section mixes the cued channels with the Master, at its own level, out of a second audio device I pick, such as my headphones, so I hear what is coming up while the Master plays out of the main output; or out of outputs 3 and 4 of an audio interface with four or more outputs. The device I picked is remembered, and the page says when it can't be used or has been unplugged (see [Platforms](#platforms)).
26. As a DJ, **Record** captures the Master output as I hear it and saves it as WAV or MP3.

## Platforms

- **Desktop App and Browser Version:** everything above, in both, with one exception below. The headphone cue plays out of a second output device the DJ picks, and out of outputs 3 and 4 wherever the output device has four or more channels.
- **Browser Version without `setSinkId`** (Firefox, Safari): no second headphone device; outputs 3 and 4 still work. The headphone section says so, and Settings lists it in `desktop-only.ts`. Chrome and Edge have it. A recording is saved through the system's save dialog on the desktop, and through the browser's save picker, or as a download, in the Browser Version.

## Decisions made while building

- **Master Tempo and Key Shift** use a WSOLA time-stretch in the engine. It holds the pitch to within 0.5% from 0.5× to 1.6× speed; how it sounds on drums hasn't been judged by ear.
- **Sync** keeps a synced **Deck** on the **Sync Master's** beat with a drift correction of at most 3% of its speed.
- **Booth level** is kept and sent to the engine, but there is no separate booth output yet, so it changes nothing heard.
- The **Track browser** shows a file's BPM and key once it has been loaded onto a **Deck** (the analysis runs on load), not as soon as it is added.
- **Slip** applies to a held **Hot Cue**; a plain press of a Hot Cue jumps to it.
- A recording is held in memory until it is saved, so a very long session could run short of memory.
- When the page opens, the song stops; a live note or a reverb tail already sounding rings out rather than being cut.
- **Not built yet:** phrase and section colouring of the waveform.

## Out of scope

- Streaming services, rekordbox library import and USB export.
- Controllers and MIDI mapping for DJ hardware. The page takes the computer keyboard and the mouse; the Editor's MIDI input keeps playing Instrument Tracks.
- Video, lighting and DVS (timecode vinyl).
- Saving a set: **Decks**, cues and loops last as long as the page's session.
- Putting a mix into a **Project**. A recording is a file; importing it as an **Audio Clip** works as for any file.

## Risks

- **Master Tempo quality.** A time-stretch that keeps the pitch at ±16% without smearing drums is hard. If the engine's is poor at wide ranges, the display says Master Tempo is on and the DJ hears artefacts. It is tested for tempo accuracy and length, not for how good it sounds.
- **Analysis mistakes.** BPM and **Beat Grid** detection misreads half- or double-time tracks and swung or live-played ones. Tap tempo and grid nudge are the fix; **Sync** is only as good as the grid.
- **CPU.** Four **Decks** with time-stretching and Beat FX, at a small buffer on a laptop, may drop out. The load test in Settings measures the song's engine, not this page's.
- **Latency.** The jog wheel and Cue feel wrong past about 20 ms of output latency. The Browser Version's AudioWorklet is usually above that.

## Status

Implementation status is recorded in the pull request. A story left out, or cut down, is listed there with why.

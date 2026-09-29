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
3. As a DJ, the page opens with two **Track browsers**, one under each of the first two **Decks** and down to the bottom of the mixer, each with its own tab and folder open over the same loaded files. Each has two tabs. **Folders** is the Editor's sample folder tree: I browse my audio folders, audition a file, and put it on any **Deck** from its "Put on" list or by dragging it onto the Deck. **Loaded tracks** lists the files I've loaded, with title, BPM, key (in Camelot notation too) and length, sortable by any column. I can also load a file straight from my disk with a Deck's SOURCE button or by dropping it on the Deck. Where the platform has no sample folders, the Folders tab says so and the page opens on Loaded tracks.
4. As a DJ, keyboard shortcuts play, cue and sync each **Deck**, and every drag (jog wheel, faders, knobs, waveform) has a keyboard alternative, meeting WCAG 2.2 AA as the rest of the app does.

### Decks (CDJ-3000)

5. As a DJ, a loaded **Deck** shows the title, elapsed and remaining time, BPM (the file's and at the current tempo), key and tempo change. The remaining time flashes near the track's end.
6. As a DJ, I see an overview of the whole track as a waveform coloured by its low, mid and high energy, with the playhead, cues and loop. Clicking it moves the playhead there (Needle Search).
7. As a DJ, across the top of the page, above the **Decks** and the mixer, a waveform stack shows one lane per loaded **Deck**. Each lane is a coloured waveform scrolling past a fixed centre playhead, with the **Beat Grid**'s beats and bars on it and the Deck's number, BPM, key and remaining time beside it. The lanes share one zoom, so the beats line up visibly between Decks. Each Deck's display shows a count of beats to the next cue.
8. As a DJ, each **Deck** and the mixer look and work like the club hardware they model, on a dark metal panel with the controls where the hardware has them: big lit CUE and PLAY buttons that blink as on a player, a jog wheel with a centre display, lit pads and buttons, LED meters and long faders. No maker's name or logo is printed on them. BROWSE jumps to the Track browser on its Deck's side of the mixer, the mixer shows all four channels even with two Decks, and a time-mode button switches the jog's display between elapsed and remaining time.
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
26. As a DJ, **Record** captures the Master output as I hear it and saves it as WAV or MP3. Once it has stopped, **Add to song** puts it into the Editor's **Project** as an **Audio Clip** from the song's start on a new **Audio Track**, as one undo step.

### The Pad Controller and the Pads page

27. As a DJ, **Menu → Pads** opens the **Pads page**, beside the Editor, the Mixer page and Settings, with a Grid of its own (its own layout, Grid menu and Reset layout). It opens with the **Pad Controller** across the Grid's whole width, so there is room to play, and a **Track browser** under it. The Pads page and the Mixer page share one session: the pads play the Mixer page's **Decks** and the **Sampler**, and a recording made on either page is the same recording. The Editor's song stops while it is open. On the Mixer page the Pad Controller is in the Grid menu, hidden until I show it.
28. As a DJ, the Pad Controller is drawn and laid out as a two-deck pad controller for DJ software: on the dark metal of the Decks and the mixer, a half for each side, each with a SLIDE FX strip at its outer edge (FX 1, 2 and 3 above it, HOLD below), LOOP (4 BEAT LOOP, 1/2X, 2X), QUANTIZE, LOAD, PARAMETER ◀ ▶, SLIP REVERSE, MASTER TEMPO, BEAT SYNC, SILENT CUE, KEY − and +, INT, four PAD MODE buttons and sixteen lit RGB pads coloured by their mode; between the halves the browse knob and SHIFT. What SHIFT gives is printed under each button. No maker's name or logo is on it. Too narrow for the halves side by side, they stack.
29. As a DJ, the left half drives **Deck** 1 and the right Deck 2; SHIFT and INT switches a half to Deck 3 or 4, which plays through its mixer channel even while the Mixer page shows two Decks.
30. As a DJ, the loop buttons work as on the hardware: 4 BEAT LOOP turns a 4-beat loop on and off (SHIFT: the last loop again, Active Loop), 1/2X and 2X halve and double it (SHIFT: loop in and loop out). QUANTIZE, MASTER TEMPO and BEAT SYNC (SHIFT: make the Deck the **Sync Master**) toggle. SLIP REVERSE plays backwards while held, with **Slip**, for at most 8 beats. SILENT CUE mutes the Deck while it plays on, until a **Hot Cue** is called. KEY − and + move the **Key Shift** a semitone (SHIFT: **Key Sync** on and off, which then follows the Master's key; and key reset).
31. As a DJ, the eight pad modes work as the hardware's do. PAD MODE 1 is Hot Cue (sixteen Hot Cues, A to P: set, call and, with SHIFT, delete) and with SHIFT Keyboard (the chosen Hot Cue played at a semitone, five pages from +12 to −12 with Key Sync, up, down, +7, +12, reset, −5 and −12 on the last). PAD MODE 2 is Pad FX 1 (effects A to P) and with SHIFT Pad FX 2 (Q to AF), each applied to the Deck for a number of beats while its pad is held. PAD MODE 3 is Beat Jump (three pages, from FINE to 32 bars, back and forward) and with SHIFT Beat Loop (1/64 of a beat to 128 bars, on and off). PAD MODE 4 is Sampler (slots 1 to 16 of the bank) and with SHIFT Key Shift (the Keyboard's pages, moving the Deck's key). PARAMETER ◀ ▶ turns the pages, and in Sampler mode (or with SHIFT) the bank.
32. As a DJ, the SLIDE FX strip turns on the FX chosen with FX 1, 2 or 3 (one a side), at the level where I touch it, on its Deck; let go, it goes off, unless HOLD is on. SHIFT and FX 1, 2 or 3 chooses which effect that button gives.
33. As a DJ, the browse knob moves a cursor through the Track browser's loaded tracks (the arrow keys, the mouse wheel, or its ▲ ▼), and pressing it brings up the loaded list (SHIFT: the folders). LOAD puts the chosen track on the half's Deck; pressed twice, it loads the other half's track at the same place, playing if it is (instant doubles); SHIFT and LOAD loads the next track.
34. As a DJ, the **Sampler** has four banks of sixteen **Sampler Slots**, shared by every Deck. A pad in Sampler mode plays its slot: once through, while held, or round until stopped, as I set each slot. SHIFT and the pad pauses a sounding slot, or loads the chosen track into a still one. The Sampler has a gain, a cue for the headphones, a meter and STOP ALL, and plays on its own channel into the Master, past the Crossfader. It starts with the Starter Kit's sounds across its first bank and into its second, so it plays out of the box.
35. As a DJ, I can change what each slot holds: EDIT SLOTS lists the bank's slots, each with its name (to rename it), how it plays, its level, **File…** (a file from my disk), **Chosen track** and **Clear**; or I drop a file from my disk, a file from the Track browser's folders or a loaded track onto a slot or its pad. What is in the slots is kept for next time.
36. As a DJ, the Pad Controller records: the whole mix, or the Sampler alone, and then **Add to song** puts the take into the Editor's **Project** on a new **Audio Track**, as one undo step, or **Save…** saves it as a file.

## Platforms

- **Desktop App and Browser Version:** everything above, in both, with one exception below. The Pad Controller, the Sampler and Add to song work in both: the desktop decodes a sample off the audio thread in the Tauri shell (`dj_sample_load`), the browser on the page's thread before the AudioWorklet takes it. The headphone cue plays out of a second output device the DJ picks, and out of outputs 3 and 4 wherever the output device has four or more channels.
- **Browser Version without `setSinkId`** (Firefox, Safari): no second headphone device; outputs 3 and 4 still work. The headphone section says so, and Settings lists it in `desktop-only.ts`. Chrome and Edge have it. A recording is saved through the system's save dialog on the desktop, and through the browser's save picker, or as a download, in the Browser Version.

## Decisions made while building

- **Master Tempo and Key Shift** use a WSOLA time-stretch in the engine. It holds the pitch to within 0.5% from 0.5× to 1.6× speed; how it sounds on drums hasn't been judged by ear.
- **Sync** keeps a synced **Deck** on the **Sync Master's** beat with a drift correction of at most 3% of its speed.
- **Booth level** is kept and sent to the engine, but there is no separate booth output yet, so it changes nothing heard.
- The **Track browser** shows a file's BPM and key once it has been loaded onto a **Deck** (the analysis runs on load), not as soon as it is added.
- **Slip** applies to a held **Hot Cue**; a plain press of a Hot Cue jumps to it.
- A recording is held in memory until it is saved, so a very long session could run short of memory. The last one is kept after it stops, to save or add to the song.
- **Add to song** puts the take at the song's start (bar 1): the Mixer page's tempo isn't the song's, so there is no better place to guess. It is a 24-bit WAV copied into the Project's `audio/`, like any imported file.
- **Pad FX** borrow the mixer's one Beat FX unit, on the Deck's own channel, while their pad is held, and hand it back as the mixer's knobs have it; a SLIDE FX does the same while its strip is touched (or HOLD is on), at the mixer's beat division. The last to borrow it has it. They are, A to P: Echo 1/2, 3/4 and 1; Delay 1/4; Roll 1/4, 1/8, 1/16 and 1/32; Reverb 1; Filter 4; Flanger 4; Phaser 4; Trans 1/4 and 1/8; Vinyl Brake 1; Spiral 1/2. Q to AF: Ping Pong 1/2 and 1/4; Delay 1/2 and 3/4; Slip Roll 1/4, 1/8 and 1/16; Helix 1; Pitch 1/2 and 1; Filter 1; Reverb 4; Vinyl Brake 2 and 1/2; Spiral 1/4; Helix 2. The SLIDE FX start as Filter, Echo and Reverb.
- **FINE** Beat Jump moves a thirty-second of a beat. Keyboard and Key Shift open on their second page (+7 to −8), Beat Jump on its second (1 beat to 32 bars), as the hardware's default. Keyboard mode plays the last Hot Cue pressed in Hot Cue mode (or the first one set, or the cue point).
- **INT** only says what it is for: the Decks always play the file itself (INT); REL is for timecode vinyl, which the page doesn't take. SHIFT and INT switches the Deck.
- **SHIFT** is latched on screen: pressed, the next button or pad does its SHIFT function, and SHIFT lets go. Holding the keyboard's Shift key while pressing works too.
- The browse knob's press brings up a Track browser's loaded list (SHIFT: its folders); moving through the folder tree itself is the tree's own keyboard's. The cursor goes through the loaded tracks in the order the Track browser last sorted them, and clicking a track's title puts the cursor on it.
- The **Sampler**'s slots are kept in the app-level library (`dj-sampler/` beside the saved Kits: the app's data folder on the desktop, IndexedDB in the Browser Version), a copy of each sample with them; a slot playing a Starter Kit sound keeps only which one. They play at the engine's rate from the start, without following the Master's BPM.
- Two Pad Controllers (the Pads page's, and the Mixer page's once shown) each keep their own pad modes, pages and SHIFT; the Decks and the Sampler they drive are the same.
- When the page opens, the song stops; a live note or a reverb tail already sounding rings out rather than being cut.
- **Not built yet:** phrase and section colouring of the waveform.

## Out of scope

- Streaming services, rekordbox library import and USB export.
- Controllers and MIDI mapping for DJ hardware. The page takes the computer keyboard and the mouse; the Editor's MIDI input keeps playing Instrument Tracks.
- Video, lighting and DVS (timecode vinyl).
- Saving a set: **Decks**, cues and loops last as long as the app is open (the **Sampler**'s slots are kept).
- Controlling the Pad Controller from the hardware it is drawn after: it is on screen, played with the mouse, touch and the keyboard, as the rest of the page is.

## Risks

- **Master Tempo quality.** A time-stretch that keeps the pitch at ±16% without smearing drums is hard. If the engine's is poor at wide ranges, the display says Master Tempo is on and the DJ hears artefacts. It is tested for tempo accuracy and length, not for how good it sounds.
- **Analysis mistakes.** BPM and **Beat Grid** detection misreads half- or double-time tracks and swung or live-played ones. Tap tempo and grid nudge are the fix; **Sync** is only as good as the grid.
- **CPU.** Four **Decks** with time-stretching and Beat FX, at a small buffer on a laptop, may drop out. The load test in Settings measures the song's engine, not this page's.
- **Latency.** The jog wheel and Cue feel wrong past about 20 ms of output latency. The Browser Version's AudioWorklet is usually above that.

## Status

Implementation status is recorded in the pull request. A story left out, or cut down, is listed there with why.

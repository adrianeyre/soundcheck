# Soundcheck

A music-creation app (a DAW) in which a musician can also ask an LLM to create or edit their song.

## Language

### The song

**Project**:
One song: everything needed to reopen, play and render it, saved as a folder on disk that contains its own copies of all audio it uses.
_Avoid_: Song file, session

**Track**:
One horizontal lane of the arrangement, with its own mixer channel. Every Track is either an Audio Track or an Instrument Track.
_Avoid_: Channel (that is the mixer's view of a Track), lane

**Audio Track**:
A Track whose Clips are recorded or imported audio.

**Instrument Track**:
A Track that owns one Instrument and whose Clips are Pattern Clips played by that Instrument.

**Clip**:
A block placed on a Track at a position in time. It is either an Audio Clip or a Pattern Clip, matching its Track.
_Avoid_: Region, part, event

**Audio Clip**:
A Clip that plays a stretch of an audio file.

**Stem**:
One part of a mixed recording pulled out by Stem Separation: its vocals, drums, bass, or everything else. Once separated it is audio like any other, owned by the Project.
_Avoid_: Part, source, track (a Track is a lane of the arrangement)

**Stem Separation**:
Splitting the sound of an Audio Clip into its Stems. The Stems are an estimate, so a little of one can bleed into another.
_Avoid_: Decompiling, unmixing, splitting

**Pattern Clip**:
A Clip holding notes for its Track's single Instrument. It belongs to exactly one Track.
_Avoid_: Pattern (on its own; in other DAWs a pattern spans many instruments), sequence

**Step Sequencer**:
A grid editor for a Pattern Clip's notes. It is a way of editing, not a separate kind of data.

**Piano Roll**:
An editor for a Pattern Clip's notes with free pitch, length and velocity. Like the Step Sequencer, it is a way of editing, not a separate kind of data.
_Avoid_: Note editor, MIDI editor

**Audio Editor**:
An editor for one Audio Clip's audio: its waveform, drawn down to single samples, and the cuts that make Slices of it. Like the Piano Roll, it is a way of editing; its cuts are the editor's, not the Project's, until the Clip is split.
_Avoid_: Sample editor, wave editor, chopper

**Slice**:
One stretch of an Audio Clip between two cuts, or a cut and the Clip's start or end, as the Audio Editor makes it. A Slice can be auditioned, exported as its own WAV or MP3, or left out; splitting the Clip replaces it with one Clip for each Slice kept, as one undo step.
_Avoid_: Chop, segment, region, part

**Tempo Change**:
A point in the song where the tempo or time signature changes, taking effect instantly. A time signature can only change at a bar line.
_Avoid_: Tempo marker, tempo event

**Section**:
A named bar range of the song, such as an intro, verse or chorus, marked on the ruler. Sections never overlap, and arrangement edits take one as their target.
_Avoid_: Marker, region, part

**Automation**:
The breakpoints of one setting over time, which move it while the song plays and override its fixed value. Any number of a channel, its Sends, its Effects or its Instrument (each Pad's volume, pan and pitch among them) can be automated; mute, solo, bypass and settings that pick from a list (a Pad's note and Choke Group among them) never are.
_Avoid_: Envelope (that is part of a sound), modulation

**Automation Lane**:
Where one setting's Automation is drawn, under the Track, Bus or Master that owns the setting.

### Sound

**Audio Engine**:
The part of the app that makes and records sound; the UI only asks it to do things and shows what it reports.
_Avoid_: Backend, player

**Instrument**:
A sound source that turns notes into audio: built in, such as the Synth or the Drum Sampler, or a Plugin.
_Avoid_: Generator, VSTi

**Preset**:
A named set of an Instrument's or Effect's settings. It is either a Factory Preset, which ships with the app, or a User Preset, which the musician saved. Loading one copies its settings into the Instrument or Effect, where they can then be changed. User Presets live in the app's Preset library, outside any Project, so every Project can load them.
_Avoid_: Patch, program, sound

**Keys**:
The Instrument that plays pitched sounds across the keyboard: its modelled piano, set by one of its factory Presets (grand, upright, electric and character pianos, 33 of them), or a sample the musician loads, played at each key's pitch from its root note, the key that plays it as recorded. The sample is the Project's own audio, as a Pad's is.
_Avoid_: Piano (on its own: the Keyboard Widget is the on-screen piano), sampler (on its own), multisample

**Drum Sampler**:
The Instrument that plays one sample per Pad, each triggered by its own note.
_Avoid_: Drum machine, sampler (on its own)

**Pad**:
One sound of a Drum Sampler: a sample, the note that triggers it, and its volume, pan, pitch and Choke Group.
_Avoid_: Slot, key, drum

**Kit**:
A named set of Pads loaded onto a Drum Sampler together, such as the bundled Starter Kit or one the musician saved. A saved Kit lives in the app's library, outside any Project, with a copy of every sample its Pads play; loading it copies those samples into the Project, so the Project still owns all its audio.
_Avoid_: Bank, preset (that is the name a Kit is saved under)

**Choke Group**:
A number Pads share so that triggering one cuts off the others, as a closing hi-hat cuts off an open one. 0 is no choking.
_Avoid_: Mute group, exclusive group

**Effect**:
A processor that changes audio passing through it: built in, such as EQ, Compressor, Reverb or Delay, or a Plugin.
_Avoid_: FX, insert

**Plugin**:
An Instrument or Effect that is not built into the app, loaded by the Audio Engine. It is either a WASM Plugin or a VST3 Plugin.
_Avoid_: Extension, add-on

**WASM Plugin**:
A Plugin written against Soundcheck's own SDK, whose settings are declared up front so the app can draw its controls and the Assistant can change them.

**VST3 Plugin**:
A third-party Plugin in Steinberg's VST3 format, which draws its own window and whose settings are only those it chooses to expose.

**Insert Chain**:
The ordered list of Effects on one mixer channel.
_Avoid_: Effects rack, FX chain

**Channel EQ**:
The four knobs, low, low mid, high mid and high, on every Track's, Bus's and the Master's mixer channel, each turning its band up to 12 dB either way. It comes after the Insert Chain and before the fader, and at 0 dB on every band it changes nothing. It is the DJ Mixer's EQ, meeting at the same frequencies.
_Avoid_: EQ (on its own: that is the EQ Effect), tone controls

**Send**:
A level-controlled copy of a Track's or Bus's signal, taken after its fader and pan, fed to a Bus. Each has at most one Send to any Bus, and the Master has none.
_Avoid_: Aux

**Bus**:
A mixer channel fed by Sends or by Tracks routed to it, with its own Insert Chain, feeding the Master or another Bus. It holds no Clips, so it is not a Track.
_Avoid_: Return track, group track, aux channel

**Output**:
Where a Track or Bus sends its signal: the Master or a Bus. Each has exactly one, and Buses never feed each other in a loop, whether through Outputs or Sends.
_Avoid_: Destination, route

**Input**:
Where an Audio Track records from: an audio input device, and one of its channels (mono, recorded on both sides) or a stereo pair. Kept with the Track in the Project. Every Track armed at once records from the same device.
_Avoid_: Source, input channel (on its own; a channel is one of the device's)

**Input Monitoring**:
Hearing an armed Audio Track's live Input through its Insert Chain, Sends and the rest of the mix while it records. Kept with the Track, off by default. Never in an export, an Audio Analysis render or the take, which is always the dry Input.
_Avoid_: Direct monitoring (that is the interface's own, before the app), input echo, software monitoring

**Master**:
The final mixer channel that every Track and Bus ends up feeding, with its own Insert Chain.
_Avoid_: Main out, stereo out

**Audition**:
Playing a file from the sample browser once, straight to the audio output at a fixed preview level, past the mixer, so it is never in the mix, the meters or an export.
_Avoid_: Preview (on its own), prelisten

**Reference Track**:
A finished song the musician adds to a Project to compare their mix against. It is kept in the Project but is never in the mix, the meters or an export.
_Avoid_: Reference mix, target track

### The Assistant

**Assistant**:
The LLM feature that edits the Project on the musician's behalf, and can listen to the Project's sound as well as read its data.
_Avoid_: Claude, AI, the LLM, copilot

**Provider**:
Whose LLM the Assistant talks to: Claude, OpenAI, Google Gemini, xAI Grok, Meta AI, or a Local one (Ollama or llama.cpp). The musician picks one, then its model, version and effort; each Provider keeps its own key and settings in the platform's key store, never in a Project. With several set up, the Assistant Widget switches between them.
_Avoid_: Backend, vendor

**Decision Engine**:
A model that only picks between options the app or the Assistant defines, answering each with a probability, and never chats or makes a change: TypeSafe's Jev. The Assistant asks it for many small bounded musical choices and makes the changes itself; the Chords Widget asks it for the next chord. It is not a Provider, and its key is kept beside theirs.
_Avoid_: Provider (it can't be one), classifier, System One (TypeSafe's own name for the kind)

**Capability**:
What a Provider's model can do, as the Provider's catalogue declares it: tool use, image input, audio input, and several tool calls per turn. The Assistant uses a feature only where the model declares it, and a model without tool use can't be the Assistant. A Local model's image input, audio input and several calls per turn start off, and the musician turns on what their server gives it.
_Avoid_: Feature, support

**Audio Analysis**:
Measurements the Audio Engine takes of rendered sound (the whole mix, one Track, or a time range) so the Assistant can "listen" to it. Each one a Request makes is kept for the rest of it by an id, so the Assistant can compare two of the same sound before and after its change. Where the model declares audio input, the Assistant is also sent the rendered sound itself, capped in length, beside the measurements, unless the musician turns that off.
_Avoid_: Listening, audio understanding

**Project Summary**:
What the Assistant is sent of the Project at the start of each Request: its Tracks, Buses and Master, what each feeds, their Effects and Clips, the tempo map, and which settings are automated, without the values. Its read tools return the settings, Automation breakpoints and notes it leaves out.
_Avoid_: Context, snapshot

**Request**:
One instruction the musician gives the Assistant. All the changes it produces are undone together as one step.
_Avoid_: Prompt, command

**Conversation**:
The run of Requests since the musician last started a new one. Each follow-up is sent with the earlier ones, so the Assistant knows what was just done; each Request is still its own undo step. Not saved in the Project.
_Avoid_: Chat, thread, session

**Token Usage**:
The tokens a Request, or a Conversation, cost with the Provider: what the model was sent (input, cached or not) and what it wrote back (output, its thinking included). Shown under the prompt, with what a running Request is doing, so the musician can see what the Assistant costs and that it hasn't stalled.
_Avoid_: Credits, cost

**Context Window**:
How many tokens one turn of the model can hold, what it is sent and what it writes back together: the catalogue's for each model, or, for a Local model, what its server gives it. The box shows how much of it the latest turn used. **Refresh context** has the next Request sent none of the Conversation's earlier Requests, while they stay in the transcript and in its Token Usage.
_Avoid_: Memory, context length

**Skill**:
A named set of instructions for one kind of Request, such as fixing clipping or programming a drum beat, which the musician starts a Request with by its slash command (`/fix-clipping`). Each is a folder of the repo's `skills/`; the Assistant is sent its instructions, followed by whatever the musician typed after the command.
_Avoid_: Command, macro, prompt template, recipe

**Suggestion**:
A Request's changes offered to the musician without being applied: they are worked out against a copy of the Project and applied, as one undo step, only when the musician says so.
_Avoid_: Preview, draft, proposal

### The Editor

**Widget**:
One section of the Editor, such as the Tracks, the Timeline or the Mixer, that the musician can move, resize, pin or hide on the Grid. It is a way of arranging the screen, not part of the Project.
_Avoid_: Panel (that is how a section looks), pane, card

**Grid**:
The columns and rows every Widget snaps to, and the menu that lists the Widgets to show or hide. Its layout is kept on the device, never in a Project.
_Avoid_: Dashboard, layout (on its own)

**Empty**:
Said of a Widget with nothing to show just now, such as the Step Sequencer with no Pattern Clip selected. It is off the Grid until it has something, then comes back where it was.
_Avoid_: Blank, inactive

**Pinned**:
Said of a Widget kept under the title bar or above the footer, so it stays on screen while the rest of the Editor scrolls.
_Avoid_: Sticky, docked

**Song Key**:
The key the musician is writing in, a root and a scale, which the Keyboard marks, the Chords are built from and Note Tools fit notes to. It is the musician's view while they work, not part of the Project, and changes nothing heard.
_Avoid_: Scale (on its own; that is only half of it), tonality

**Chord Pad**:
One chord of the Song Key, or one borrowed from its parallel key, in the Chords Widget: held, it plays; clicked with a Pattern Clip selected, it joins the progression to write into the Clip.
_Avoid_: Chord trigger, chord button

**Note Tools**:
Changes to every note of the selected Pattern Clip at once, such as transpose, humanise, strum or arpeggiate, each one undo step. Like the Piano Roll, it is a way of editing, not a separate kind of data.
_Avoid_: MIDI effects (those would run while the song plays), MIDI functions, macros

### Where it runs

**Desktop App**:
Soundcheck installed on Windows, macOS or Linux, with the Audio Engine on the machine's own audio driver. The low-latency version, and the only one that records audio or hosts VST3 Plugins.
_Avoid_: Native app, Tauri app

**Browser Version**:
Soundcheck as a web page, with the Audio Engine's WASM build on the browser's audio path. The lighter version: the same song and Project format, heard later, and without the Desktop App's features that need the machine.
_Avoid_: Web app, web build (that is how it is made), dev host (that is `pnpm dev`)

**Release**:
A version of the Desktop App published on GitHub, with its installers and the Updates to it. Made by pushing a tag, `v` and the version.
_Avoid_: Build (every push makes one), deploy (that is the Browser Version's)

**Update**:
A newer Release, as the installed Desktop App finds and installs it. It installs only what is signed by the updater's key for that version.
_Avoid_: Upgrade, patch

### Working together

**Shared Project**:
A Project more than one person edits, each on their own copy, whose changes reach the others live or the next time its folder syncs. Each copy is still a complete folder with all its audio.
_Avoid_: Shared song, cloud project, document

**Collaborator**:
Someone else editing the same Project, in a Shared Project or a Live Session. Undo only ever reaches your own steps, never a Collaborator's, and never overwrites what a Collaborator has changed since.
_Avoid_: User, peer (that is the sync code's name for one copy), co-author

**Live Session**:
Copies of one Project connected through a Relay, so each one's changes reach the others within a second. It is started with any Project, and whoever opens its invite link joins it. The copies of a Shared Project can be in one too; without one, their changes travel when the Project folder syncs.
_Avoid_: Room, call, jam, session (on its own)

**Relay**:
The server that passes a Live Session's changes, and new audio, between Collaborators. It stores nothing and can't read what it passes on.
_Avoid_: Server (on its own), backend, cloud

**Invite link**:
The link that joins a Live Session: the Browser Version's address, with the Relay, the session and its key after the `#`. Anyone with it can join.
_Avoid_: Share link (Share makes a Shared Project), room code

### The Mixer page

**Mixer page**:
The page, beside the Editor, the Pads page and Settings, where a DJ plays audio files against each other on Decks through a DJ mixer, as on a club's players and mixer. The Editor's song stops while it is open. Nothing on it is part of a Project, its undo history, an export or what the Assistant sees, until the DJ adds a recording to the song.
_Avoid_: DJ mode, performance view, live page

**Deck**:
One of the Mixer page's two or four players: a file loaded onto it, played at a tempo of its own, with its own cues and loops, into one channel of the DJ mixer. A Deck is not a Track: it holds a file, not Clips.
_Avoid_: Player, turntable, channel (that is its strip on the mixer)

**Track browser**:
The Mixer and Pads pages' list of the files the DJ has added, with each one's BPM, key and length once a Deck has analysed it, from which a file is loaded onto a Deck or into a Sampler Slot. The Pad Controller's browse knob moves a cursor through it, and LOAD loads the file it is on (the chosen track).
_Avoid_: Library (that is the app's Preset and Kit library), crate, playlist

**Beat Grid**:
Where a Deck's file has its beats: a BPM and the time of its first beat, found by the engine when the file is loaded and put right by hand with Tap and the grid nudges. Sync, Quantize, loops and Beat Jump all go by it.
_Avoid_: Tempo map (that is the song's), grid (on its own; the Editor has a Grid)

**Hot Cue**:
One of sixteen points of a Deck's file, A to P, each with a colour and a name, that one press jumps the Deck to. The Deck's own pads reach the first eight; the Pad Controller's reach all sixteen. Unlike the cue point, it is set and cleared at will and stays until then. Calling one ends a Silent Cue.
_Avoid_: Marker, Section, memory cue (that only moves the cue point)

**Quantize**:
A Deck's setting that snaps its cue point, Hot Cues, loops and Beat Jumps to the nearest beat of its Beat Grid.
_Avoid_: Quantise (that is the Piano Roll's note tool), snap

**Slip**:
A Deck's setting under which a loop, a scratch, Reverse or a held Hot Cue plays over the track while it runs on silently underneath, and the Deck goes back to where the track would have been when they end.
_Avoid_: Censor, shadow play

**Master Tempo**:
A Deck's key lock: its tempo changes and its pitch doesn't, by time-stretching in the engine.
_Avoid_: Key lock, keylock, pitch lock

**Sync**:
Matching a Deck's tempo to the Sync Master's and keeping its beats on the Master's, by their Beat Grids. Turned off, the Deck keeps the tempo it had.
_Avoid_: Beat-match (that is what a DJ does by ear), auto-sync

**Sync Master**:
The one Deck the others Sync to, marked MASTER; its tempo also times the Beat FX.
_Avoid_: Leader, clock

**Key Shift**:
Moving a Deck's pitch by whole semitones without changing its tempo.
_Avoid_: Transpose (that is the Note Tools'), pitch (that is the tempo fader's)

**Key Sync**:
The Key Shift that brings a Deck to the nearest key that mixes with the Sync Master's: the same key, a fifth either way, or its relative major or minor, round the Camelot wheel. Turned on from the Pad Controller, it stays on, following the Master's key as it changes.
_Avoid_: Harmonic mixing (that is the practice), auto-key

**Silent Cue**:
A Deck's mute: it plays on unheard, so a Hot Cue called brings it in from that point. Calling a Hot Cue ends it.
_Avoid_: Mute (on its own; a Track's mixer channel has one), censor

**Slip Reverse**:
Reverse held, with Slip: the Deck plays backwards while the button is held, for at most 8 beats, and then carries on from where the track would have been.
_Avoid_: Censor, rewind

**Sampler**:
The DJ mixer's own player of short sounds: 64 Sampler Slots in four banks of sixteen, shared by every Deck, into a channel of its own past the Crossfader, with a Sampler Gain, a cue button and a meter. What is in its slots is kept between sessions, in the app's library; it starts with the Starter Kit's sounds.
_Avoid_: Drum Sampler (that is an Instrument), sampler deck, sample player

**Sampler Slot**:
One of the Sampler's 64 places for a sample: a name, the sample, how it plays (one-shot, gate or loop) and its level. A pad of the Pad Controller in SAMPLER mode plays one; SHIFT and the pad pauses it, or loads the Track browser's chosen track into it.
_Avoid_: Pad (that is a Drum Sampler's sound), cell

**Pad Controller**:
The Widget drawn and played as a two-deck pad controller for DJ software: each half drives a Deck (the left Deck 1 or 3, the right 2 or 4) with its SLIDE FX strip, loop, sync, key and cue buttons, four PAD MODE buttons and sixteen lit pads, and between the halves a browse knob, the LOAD buttons and SHIFT. Its pad modes are Hot Cue, Keyboard, Pad FX 1 and 2, Beat Jump, Beat Loop, Sampler and Key Shift. It drives the same Decks and Sampler as the Mixer page, and records what it plays. It is the Pads page's, and on the Mixer page's Grid menu too.
_Avoid_: Pads (on its own; that is the page), controller (on its own), launchpad, the maker's name

**Pads page**:
The page, beside the Editor, the Mixer page and Settings, with the Pad Controller across the whole width of its Grid and a Track browser under it. It shares the Mixer page's session: its pads play the same Decks and the same Sampler, into the same mix and recording, and "Add to song" puts a recording into the Editor's Project. Its name is "Pads", never "Pad".
_Avoid_: Pad page, sampler page, performance page

**Pad FX**:
One of 32 effects, A to AF, on the Pad Controller's PAD FX pages: a Beat FX at a beat division that its pad applies to its Deck's channel while it is held. The DJ mixer has one Beat FX unit, so a Pad FX (or a SLIDE FX) borrows it while it is held and hands it back as the mixer had it.
_Avoid_: Pad effect, stutter

**Crossfader**:
The DJ mixer's horizontal fader, which blends the channels assigned to its side A with those assigned to side B, on a curve the DJ picks. A channel assigned THRU is past it.
_Avoid_: Fader (on its own; each channel has one), balance

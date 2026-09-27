//! The audio callback allocates nothing: a counting allocator watches the
//! render path while it applies every kind of command.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use soundcheck_desktop::command::{EngineCommand, RtCommand};
use soundcheck_desktop::host::host;
use soundcheck_desktop::monitor::{MonitorFeed, monitor};
use soundcheck_desktop::recorder::{Tap, recorder};

struct Counting;

thread_local! {
    /// Allocations and frees on this thread while watching, or None.
    static WATCHED: Cell<Option<usize>> = const { Cell::new(None) };
}

fn count() {
    // `try_with`: the allocator also runs while thread locals are torn down.
    let _ = WATCHED.try_with(|watched| {
        if let Some(n) = watched.get() {
            watched.set(Some(n + 1));
        }
    });
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        count();
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count();
        unsafe { System.realloc(ptr, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// How many times `f` allocates or frees on this thread.
fn allocations(f: impl FnOnce()) -> usize {
    WATCHED.with(|w| w.set(Some(0)));
    f();
    WATCHED.with(|w| w.replace(None)).unwrap()
}

#[test]
fn the_render_path_allocates_and_frees_nothing() {
    assert_eq!(
        allocations(|| drop(std::hint::black_box(vec![1u8]))),
        2,
        "the counter sees an allocation and its free"
    );
    let (mut controller, mut renderer, mut midi) = host(48_000.0, 16);
    let mut buffer = vec![0.0; 256 * 2];
    // Every kind of command, queued before a callback applies them.
    let commands = [
        EngineCommand::SetPatternPlaying { playing: true },
        EngineCommand::SetTrackCount { count: 20 },
        EngineCommand::SetTrackNotes {
            track: 3,
            notes: vec![0.0, 960.0, 60.0, 1.0, 480.0, 960.0, 64.0, 1.0],
        },
        EngineCommand::SetTrackMixer {
            track: 3,
            volume: 0.5,
            pan: -0.25,
            mute: false,
            solo: true,
        },
        EngineCommand::SetMasterVolume { volume: 0.8 },
        EngineCommand::SetMetronome { on: true },
        EngineCommand::SetLoop {
            start_tick: 0.0,
            end_tick: 3_840.0,
            enabled: true,
        },
        EngineCommand::SetTempo { bpm: 140.0 },
        EngineCommand::SetTimeSignature {
            beats_per_bar: 3,
            beat_unit: 4,
        },
        EngineCommand::NoteOn {
            note: 72,
            velocity: 0.8,
        },
        EngineCommand::SetLiveTrack { track: Some(3) },
        EngineCommand::SetRecording { on: true },
        // The Drum Sampler: the kit is decoded, the pad set and the WAV
        // decoded on this side, so the callback only moves them in.
        EngineCommand::SetTrackInstrument {
            track: 1,
            instrument: "drumSampler".to_string(),
            // A kit bigger than the bundled one is built on this side too.
            pads: Some(16),
        },
        EngineCommand::SetPad {
            track: 1,
            pad: 0,
            note: 36,
            volume: 0.9,
            pan: -0.2,
            pitch: -1.0,
            choke_group: 0,
        },
        EngineCommand::SetPadSample {
            track: 1,
            pad: 0,
            wav: include_bytes!("../../engine/assets/kits/starter/snare.wav").to_vec(),
        },
        // Insert Chains: every Effect is built on this side, so the
        // callback only moves it in; its settings are plain numbers.
        EngineCommand::InsertEffect {
            chain: 3,
            index: 0,
            effect: "eq".to_string(),
        },
        EngineCommand::InsertEffect {
            chain: 3,
            index: 1,
            effect: "compressor".to_string(),
        },
        EngineCommand::InsertEffect {
            chain: 3,
            index: 2,
            effect: "reverb".to_string(),
        },
        EngineCommand::InsertEffect {
            chain: -1,
            index: 0,
            effect: "reverb".to_string(),
        },
        EngineCommand::InsertEffect {
            chain: 1,
            index: 0,
            effect: "compressor".to_string(),
        },
        EngineCommand::SetEffectSettings {
            chain: 3,
            index: 0,
            settings: vec![1.0, 80.0, 200.0, 3.0, 400.0, 2.0, -6.0],
        },
        EngineCommand::MoveEffect {
            chain: 3,
            from: 2,
            to: 0,
        },
        EngineCommand::SetEffectBypassed {
            chain: 3,
            index: 1,
            bypassed: true,
        },
        // Buses fed by Sends, and a Send that would loop, which comes
        // straight back.
        EngineCommand::SetBusCount { count: 2 },
        EngineCommand::SetSends {
            channel: 0,
            sends: vec![0.0, 0.5, 1.0, 0.25],
        },
        EngineCommand::SetSends {
            channel: -2,
            sends: vec![1.0, 1.0],
        },
        // Automation is built on this side too, and ramps a frame at a
        // time: a Send, an Effect's and the Synth's settings, a Bus.
        EngineCommand::SetAutomation {
            target: 3,
            setting: "send:0".to_string(),
            points: vec![0.0, 0.0, 0.0, 1_920.0, 1.0, 0.0],
        },
        EngineCommand::SetAutomation {
            target: 3,
            setting: "effect:0:lowShelfGainDb".to_string(),
            points: vec![0.0, -12.0, 0.0, 3_840.0, 12.0, 0.0],
        },
        EngineCommand::SetAutomation {
            target: 3,
            setting: "instrument:cutoffHz".to_string(),
            points: vec![0.0, 200.0, 0.0, 3_840.0, 8_000.0, 1.0],
        },
        EngineCommand::SetAutomation {
            target: -2,
            setting: "pan".to_string(),
            points: vec![0.0, -1.0, 0.0, 3_840.0, 1.0, 0.0],
        },
        EngineCommand::SetSends {
            channel: -3,
            sends: vec![0.0, 1.0],
        },
        EngineCommand::SetBusCount { count: 1 },
        // No such Track: the Effect comes straight back.
        EngineCommand::InsertEffect {
            chain: 99,
            index: 0,
            effect: "eq".to_string(),
        },
    ];
    for command in commands {
        controller.send(command);
    }
    assert!(
        midi.push(RtCommand::NoteOn {
            note: 48,
            velocity: 1.0
        })
        .is_ok()
    );

    // An armed Audio Track monitoring its input: the input callback's
    // writer and the output callback's feed, both watched below.
    controller.send(EngineCommand::SetTrackAudio {
        track: 5,
        audio: true,
    });
    controller.send(EngineCommand::SetTrackMonitoring { track: 5, on: true });
    let (_recorder, mut writer) = recorder(48_000, &[Tap::FirstTwo, Tap::Mono(2)]);
    let (to_output, from_input) = monitor(2);
    writer.set_monitor(to_output);
    controller.set_monitor(Some(MonitorFeed::new(from_input, vec![5, 6])));
    let input = vec![0.1_f32; 256 * 4];

    // Seconds of playback: notes start and end, the loop wraps, Tracks'
    // sounding lists fill up and empty. A live note arrives in every other
    // callback, so recording them and handing them back is watched too, and
    // so is the monitored input, from the input callback to the Track.
    let during = allocations(|| {
        for callback in 0..1_000 {
            writer.write(&input, 4, callback as f64, |s| s);
            if callback % 2 == 0 {
                let _ = midi.push(RtCommand::NoteOn {
                    note: 36 + (callback % 24) as u8,
                    velocity: 0.9,
                });
            } else {
                let _ = midi.push(RtCommand::NoteOff {
                    note: 36 + ((callback - 1) % 24) as u8,
                });
            }
            renderer.process(&mut buffer, 2);
        }
    });
    assert_eq!(during, 0, "allocations in the audio callback");
    assert_eq!(
        controller.take_recorded_notes().len(),
        1_001,
        "every live note came back: the 1,000 above and note 48 before them"
    );

    for command in [
        EngineCommand::SetTrackCount { count: 2 },
        EngineCommand::SetPatternPlaying { playing: false },
        EngineCommand::Seek { tick: 960.0 },
        EngineCommand::Stop,
        EngineCommand::NoteOff { note: 72 },
        EngineCommand::SetLatencyTest { on: true },
        EngineCommand::NoteOn {
            note: 60,
            velocity: 1.0,
        },
        EngineCommand::SetLiveTrack { track: None },
        EngineCommand::SetRecording { on: false },
        // Replacing an Instrument and a pad's sample hands both back.
        EngineCommand::SetTrackInstrument {
            track: 1,
            instrument: "synth".to_string(),
            pads: None,
        },
        EngineCommand::SetPadSample {
            track: 0,
            pad: 0,
            wav: include_bytes!("../../engine/assets/kits/starter/kick.wav").to_vec(),
        },
        // An Audio Track: the file is decoded and resampled, and its Clips
        // built, on this side; replacing the Clips hands the old ones back.
        EngineCommand::LoadAudioFile {
            file: 1,
            bytes: include_bytes!("../../engine/tests/fixtures/tone.flac").to_vec(),
        },
        EngineCommand::SetTrackAudio {
            track: 1,
            audio: true,
        },
        EngineCommand::SetTrackAudioClips {
            track: 1,
            clips: vec![0.0, 96_000.0, 1.0, 0.0],
        },
        EngineCommand::SetTrackAudioClips {
            track: 1,
            clips: vec![0.0, 96_000.0, 1.0, 0.1],
        },
        // Taking a sample off hands it back too: the kit's own sample is
        // decoded on this side, and a pad past the kit's end simply empties.
        EngineCommand::ClearPadSample { track: 0, pad: 0 },
        EngineCommand::ClearPadSample { track: 0, pad: 12 },
        // Removing Effects hands them back too.
        EngineCommand::RemoveEffect {
            chain: -1,
            index: 0,
        },
        EngineCommand::RemoveEffect { chain: 1, index: 0 },
        EngineCommand::SetEffectSettings {
            chain: 1,
            index: 0,
            settings: vec![0.5; 5],
        },
    ] {
        controller.send(command);
    }
    // Closing the input hands its monitor feed back too.
    controller.set_monitor(None);
    // Removing Tracks and replacing notes hands memory back; it must not be
    // freed here.
    let during = allocations(|| {
        for _ in 0..100 {
            renderer.process(&mut buffer, 2);
        }
    });
    assert_eq!(during, 0, "frees in the audio callback");
    assert!(buffer.iter().all(|s| s.is_finite()));
    assert_eq!(controller.stats().snapshot().engine.track_count, 2);
}

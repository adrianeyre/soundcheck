use super::*;

const RATE: f32 = 48_000.0;

/// Run `renderer` for `frames` of stereo in callbacks of `callback` frames,
/// returning the left channel.
fn play(renderer: &mut Renderer, frames: usize, callback: usize) -> Vec<f32> {
    let mut left = Vec::with_capacity(frames);
    let mut buffer = vec![0.0; callback * 2];
    while left.len() < frames {
        renderer.process(&mut buffer, 2);
        left.extend(buffer.iter().step_by(2));
    }
    left.truncate(frames);
    left
}

fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0, |max, s| max.max(s.abs()))
}

#[test]
fn queued_commands_play_exactly_what_the_engine_plays_when_driven_directly() {
    let notes = [0.0, 960.0, 60.0, 1.0, 1_000.0, 480.0, 67.0, 0.7];

    let mut engine = Engine::new(RATE);
    engine.set_track_count(2);
    engine.set_track_notes(1, &notes);
    engine.set_metronome(true);
    engine.set_tempo(137.0);
    engine.play();
    let mut expected = Vec::new();
    while expected.len() < 96_000 {
        engine.render(256);
        expected.extend_from_slice(&engine.left()[..256]);
    }

    let (mut controller, mut renderer, _midi) = host(RATE, 2);
    controller.send(EngineCommand::SetTrackNotes {
        track: 1,
        notes: notes.to_vec(),
    });
    controller.send(EngineCommand::SetMetronome { on: true });
    controller.send(EngineCommand::SetTempo { bpm: 137.0 });
    controller.send(EngineCommand::Play);
    let played = play(&mut renderer, 96_000, 256);

    assert!(peak(&played) > 0.05);
    assert_eq!(played, expected);
}

#[test]
fn the_load_test_pattern_plays_on_every_track_and_tracks_come_and_go() {
    let (mut controller, mut renderer, _midi) = host(RATE, 16);
    controller.send(EngineCommand::SetPatternPlaying { playing: true });
    let out = play(&mut renderer, 24_000, 256);
    assert!(peak(&out) > 0.05);
    let measured = controller.stats().snapshot();
    assert_eq!(measured.engine.track_count, 16);
    assert!(measured.engine.active_voices >= 16);
    assert!(measured.engine.playing);

    controller.send(EngineCommand::SetTrackCount { count: 3 });
    controller.send(EngineCommand::SetPatternPlaying { playing: false });
    play(&mut renderer, 48_000, 256);
    let measured = controller.stats().snapshot();
    assert_eq!(measured.engine.track_count, 3);
    assert_eq!(measured.engine.active_voices, 0);
    assert!(!measured.engine.playing);
}

#[test]
fn midi_notes_go_straight_to_the_engine() {
    let (mut controller, mut renderer, mut midi) = host(RATE, 0);
    assert!(
        midi.push(RtCommand::NoteOn {
            note: 60,
            velocity: 1.0
        })
        .is_ok()
    );
    let out = play(&mut renderer, 4_800, 256);
    assert!(peak(&out) > 0.05);
    assert_eq!(controller.stats().snapshot().engine.active_voices, 1);
}

#[test]
fn a_latency_test_note_is_the_transient_at_the_start_of_the_next_callback() {
    let (mut controller, mut renderer, _midi) = host(RATE, 0);
    controller.send(EngineCommand::SetLatencyTest { on: true });
    play(&mut renderer, 256, 256);
    controller.send(EngineCommand::NoteOn {
        note: 60,
        velocity: 1.0,
    });
    let out = play(&mut renderer, 256, 256);
    assert_eq!(out[0], 0.9);
}

#[test]
fn any_callback_size_and_channel_count_is_filled() {
    let (mut controller, mut renderer, _midi) = host(RATE, 1);
    controller.send(EngineCommand::NoteOn {
        note: 60,
        velocity: 1.0,
    });

    // More than one engine block, on a device with four channels.
    let frames = MAX_BLOCK * 2 + 100;
    let mut quad = vec![1.0; frames * 4];
    renderer.process(&mut quad, 4);
    let frame = |i: usize| &quad[i * 4..i * 4 + 4];
    assert!((0..frames).all(|i| frame(i)[2] == 0.0 && frame(i)[3] == 0.0));
    assert!(peak(&quad) > 0.05);

    let mut mono = vec![0.0; 512];
    renderer.process(&mut mono, 1);
    assert!(peak(&mono) > 0.05);

    let measured = controller.stats().snapshot();
    assert_eq!(measured.callback_frames, 512);
    assert_eq!(measured.frames_played, frames as u64 + 512);
    assert_eq!(measured.callbacks, 2);
}

#[test]
fn commands_that_do_not_fit_the_queue_wait_and_arrive_in_order() {
    let (mut controller, mut renderer, _midi) = host(RATE, 1);
    // Far more than the queue holds; the last tempo must win.
    for bpm in 0..QUEUE * 2 {
        controller.send(EngineCommand::SetTempo {
            bpm: 60.0 + (bpm % 100) as f64,
        });
    }
    controller.send(EngineCommand::SetTempo { bpm: 90.0 });
    controller.send(EngineCommand::Play);
    for _ in 0..4 {
        play(&mut renderer, 256, 256);
        controller.stats();
    }
    play(&mut renderer, 48_000, 256);
    // A second at 90 BPM is one and a half beats.
    let position = controller.stats().snapshot().engine.position;
    assert!((1_300.0..1_500.0).contains(&position), "{position}");
}

#[test]
fn mixer_commands_and_meters_go_through_to_the_engine() {
    let notes = [0.0, 3_840.0, 60.0, 1.0];
    let (mut controller, mut renderer, _midi) = host(RATE, 2);
    for command in [
        EngineCommand::SetTrackNotes {
            track: 0,
            notes: notes.to_vec(),
        },
        EngineCommand::SetTrackNotes {
            track: 1,
            notes: notes.to_vec(),
        },
        // Track 1 muted and panned hard left, so only Track 0 is heard.
        EngineCommand::SetTrackMixer {
            track: 1,
            volume: 1.0,
            pan: -1.0,
            mute: true,
            solo: false,
        },
        EngineCommand::SetMasterVolume { volume: 0.5 },
        EngineCommand::Play,
    ] {
        controller.send(command);
    }
    let played = play(&mut renderer, 24_064, 256);

    let mut engine = Engine::new(RATE);
    engine.set_track_count(2);
    engine.set_track_notes(0, &notes);
    engine.set_track_notes(1, &notes);
    engine.set_track_mixer(1, 1.0, -1.0, true, false);
    engine.set_master_volume(0.5);
    engine.play();
    let mut expected = Vec::new();
    while expected.len() < 24_064 {
        engine.render(256);
        expected.extend_from_slice(&engine.left()[..256]);
    }
    assert!(peak(&played) > 0.01);
    assert_eq!(played, expected);

    // The meters the UI reads are the engine's own.
    let meters = controller.stats().snapshot().meters;
    assert_eq!(meters.tracks.len(), 2);
    assert_eq!(meters.tracks[0], engine.track_peak(0));
    assert_eq!(meters.tracks[1], 0.0, "a muted Track never reaches the mix");
    assert_eq!(meters.master, engine.master_peak());
    assert!(meters.master > 0.01);
}

#[test]
fn bus_routing_plays_exactly_what_the_engine_plays_when_driven_directly() {
    let notes = [0.0, 3_840.0, 60.0, 1.0];
    let bus0 = soundcheck_engine::bus_chain(0);

    let mut engine = Engine::new(RATE);
    engine.set_track_count(2);
    engine.set_bus_count(2);
    engine.set_track_notes(0, &notes);
    engine.set_track_notes(1, &notes);
    engine.set_track_output(0, 1);
    engine.set_track_output(1, 0);
    engine.set_bus_output(1, 0);
    engine.set_bus_mixer(0, 0.8, -0.5, false, false);
    engine.insert_effect(bus0, 0, "reverb");
    engine.play();
    let mut expected = Vec::new();
    while expected.len() < 24_064 {
        engine.render(256);
        expected.extend_from_slice(&engine.left()[..256]);
    }

    let (mut controller, mut renderer, _midi) = host(RATE, 2);
    for command in [
        EngineCommand::SetBusCount { count: 2 },
        EngineCommand::SetTrackNotes {
            track: 0,
            notes: notes.to_vec(),
        },
        EngineCommand::SetTrackNotes {
            track: 1,
            notes: notes.to_vec(),
        },
        EngineCommand::SetTrackOutput {
            track: 0,
            output: 1,
        },
        EngineCommand::SetTrackOutput {
            track: 1,
            output: 0,
        },
        EngineCommand::SetBusOutput { bus: 1, output: 0 },
        // A loop, refused: the routing stays as it was.
        EngineCommand::SetBusOutput { bus: 0, output: 1 },
        EngineCommand::SetBusMixer {
            bus: 0,
            volume: 0.8,
            pan: -0.5,
            mute: false,
            solo: false,
        },
        EngineCommand::InsertEffect {
            chain: bus0,
            index: 0,
            effect: "reverb".to_string(),
        },
        EngineCommand::Play,
    ] {
        controller.send(command);
    }
    let played = play(&mut renderer, 24_064, 256);
    assert!(peak(&played) > 0.05);
    assert_eq!(played, expected);

    let meters = controller.stats().snapshot().meters;
    assert_eq!(meters.buses.len(), 2);
    assert!(meters.buses.iter().all(|&peak| peak > 0.01), "{meters:?}");
    assert_eq!(meters.gain_reduction.buses, vec![vec![0.0], vec![]]);

    // Removing the Buses hands them back to be dropped off the audio thread.
    controller.send(EngineCommand::SetBusCount { count: 0 });
    play(&mut renderer, 256, 256);
    assert_eq!(renderer.engine_mut().bus_count(), 0);
}

#[test]
fn compressor_gain_reduction_meters_reach_the_ui_from_every_chain() {
    let notes = [0.0, 3_840.0, 60.0, 1.0];
    let hard = [-60.0, 20.0, 1.0, 100.0, 0.0, 0.0];
    let (mut controller, mut renderer, _midi) = host(RATE, 1);
    let mut commands = vec![EngineCommand::SetTrackNotes {
        track: 0,
        notes: notes.to_vec(),
    }];
    // An EQ then a Compressor on the Track, and a Compressor on the Master.
    for (chain, index, effect) in [(0, 0, "eq"), (0, 1, "compressor"), (-1, 0, "compressor")] {
        commands.push(EngineCommand::InsertEffect {
            chain,
            index,
            effect: effect.to_string(),
        });
    }
    for (chain, index) in [(0, 1), (-1, 0)] {
        commands.push(EngineCommand::SetEffectSettings {
            chain,
            index,
            settings: hard.to_vec(),
        });
    }
    commands.push(EngineCommand::Play);
    for command in commands {
        controller.send(command);
    }
    play(&mut renderer, 12_032, 256);

    let meters = controller.stats().snapshot().meters.gain_reduction;
    assert_eq!(meters.tracks.len(), 1);
    assert_eq!(meters.tracks[0].len(), 2, "one per Effect");
    assert_eq!(meters.tracks[0][0], 0.0, "an EQ reduces nothing");
    assert!(meters.tracks[0][1] > 10.0, "{:?}", meters.tracks[0]);
    assert_eq!(meters.master.len(), 1);
    assert!(meters.master[0] > 0.1, "{:?}", meters.master);
}

#[test]
fn recorded_midi_notes_come_back_with_the_tick_of_the_callback_they_arrived_in() {
    // 48 kHz at the default 120 BPM: 25 frames a tick, so 10.24 ticks a
    // callback of 256 frames.
    let (mut controller, mut renderer, mut midi) = host(RATE, 1);
    controller.send(EngineCommand::SetLiveTrack { track: Some(0) });
    controller.send(EngineCommand::SetRecording { on: true });
    controller.send(EngineCommand::Play);
    play(&mut renderer, 100 * 256, 256);
    assert!(
        controller.take_recorded_notes().is_empty(),
        "nothing played"
    );

    midi.push(RtCommand::NoteOn {
        note: 60,
        velocity: 0.75,
    })
    .unwrap();
    let out = play(&mut renderer, 50 * 256, 256);
    assert!(peak(&out) > 0.05, "the live note plays through the Track");

    midi.push(RtCommand::NoteOff { note: 60 }).unwrap();
    play(&mut renderer, 256, 256);

    let recorded = controller.take_recorded_notes();
    assert_eq!(
        recorded,
        vec![
            RecordedNoteEvent {
                tick: 1_024.0,
                pitch: 60,
                velocity: 0.75,
                on: true,
            },
            RecordedNoteEvent {
                tick: 1_536.0,
                pitch: 60,
                velocity: 0.0,
                on: false,
            },
        ]
    );
    assert!(
        controller.take_recorded_notes().is_empty(),
        "draining empties"
    );
}

#[test]
fn nothing_is_recorded_until_the_ui_arms_recording() {
    let (mut controller, mut renderer, mut midi) = host(RATE, 1);
    controller.send(EngineCommand::SetLiveTrack { track: Some(0) });
    midi.push(RtCommand::NoteOn {
        note: 60,
        velocity: 1.0,
    })
    .unwrap();
    let out = play(&mut renderer, 4_800, 256);
    assert!(peak(&out) > 0.05, "live notes still play");
    assert!(controller.take_recorded_notes().is_empty());

    controller.send(EngineCommand::SetRecording { on: true });
    midi.push(RtCommand::NoteOn {
        note: 64,
        velocity: 1.0,
    })
    .unwrap();
    play(&mut renderer, 256, 256);
    let recorded = controller.take_recorded_notes();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].pitch, 64);
}

#[test]
fn a_preset_sent_from_the_ui_reaches_the_tracks_synth() {
    let preset = soundcheck_engine::factory_presets()
        .into_iter()
        .find(|preset| preset.name == "Sub Bass")
        .expect("a Sub Bass preset");

    let (mut controller, mut renderer, _midi) = host(RATE, 1);
    controller.send(EngineCommand::SetSynthSettings {
        track: -1,
        settings: preset.settings.to_flat(),
    });
    controller.send(EngineCommand::NoteOn {
        note: 36,
        velocity: 1.0,
    });
    let out = play(&mut renderer, 4_800, 256);
    assert!(peak(&out) > 0.01, "the note sounds");

    // Rendered straight from the engine with the same preset, it is the
    // same sound sample for sample.
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_synth(-1, &preset.settings.to_flat());
    engine.note_on(36, 1.0);
    let mut expected = Vec::new();
    while expected.len() < out.len() {
        engine.render(256);
        expected.extend_from_slice(&engine.left()[..256]);
    }
    assert_eq!(out, expected[..out.len()]);
}

#[test]
fn the_drum_sampler_plays_the_same_through_the_queues_as_driven_directly() {
    // A snare from the bundled kit, standing in for a WAV the musician loads.
    let wav: &[u8] = include_bytes!("../../../engine/assets/kits/starter/snare.wav");
    // Kick on every beat, with the loaded pad's note (42) in between.
    let notes = [
        0.0, 240.0, 36.0, 1.0, 960.0, 240.0, 42.0, 1.0, 1_920.0, 240.0, 36.0, 1.0,
    ];

    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    assert!(engine.set_track_instrument(0, "drumSampler", None));
    engine.set_track_pad(0, 3, 42, 0.8, -0.5, -2.0, 1);
    assert_eq!(engine.load_track_pad_sample(0, 3, wav), None);
    engine.set_track_notes(0, &notes);
    engine.play();
    let mut expected = Vec::new();
    while expected.len() < 96_000 {
        engine.render(256);
        expected.extend_from_slice(&engine.left()[..256]);
    }

    let (mut controller, mut renderer, _midi) = host(RATE, 1);
    controller.send(EngineCommand::SetTrackInstrument {
        track: 0,
        instrument: "drumSampler".to_string(),
        pads: None,
    });
    controller.send(EngineCommand::SetPad {
        track: 0,
        pad: 3,
        note: 42,
        volume: 0.8,
        pan: -0.5,
        pitch: -2.0,
        choke_group: 1,
    });
    controller.send(EngineCommand::SetPadSample {
        track: 0,
        pad: 3,
        wav: wav.to_vec(),
    });
    controller.send(EngineCommand::SetTrackNotes {
        track: 0,
        notes: notes.to_vec(),
    });
    controller.send(EngineCommand::Play);
    let played = play(&mut renderer, 96_000, 256);

    assert!(peak(&played) > 0.05);
    assert_eq!(played, expected);
}

/// The bundled snare, standing in for a WAV the musician loads.
const SNARE: &[u8] = include_bytes!("../../../engine/assets/kits/starter/snare.wav");

#[test]
fn taking_a_sample_off_a_pad_puts_the_kits_own_sound_back_through_the_queues() {
    // The kick pad as the bundled kit has it, driven directly.
    let notes = [0.0, 240.0, 36.0, 1.0];
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    assert!(engine.set_track_instrument(0, "drumSampler", None));
    engine.set_track_notes(0, &notes);
    engine.play();
    let mut expected = Vec::new();
    while expected.len() < 24_000 {
        engine.render(256);
        expected.extend_from_slice(&engine.left()[..256]);
    }

    // The same pad, with a WAV loaded onto it and then taken off again.
    let (mut controller, mut renderer, _midi) = host(RATE, 1);
    controller.send(EngineCommand::SetTrackInstrument {
        track: 0,
        instrument: "drumSampler".to_string(),
        pads: None,
    });
    controller.send(EngineCommand::SetPadSample {
        track: 0,
        pad: 0,
        wav: SNARE.to_vec(),
    });
    controller.send(EngineCommand::ClearPadSample { track: 0, pad: 0 });
    controller.send(EngineCommand::SetTrackNotes {
        track: 0,
        notes: notes.to_vec(),
    });
    controller.send(EngineCommand::Play);

    let played = play(&mut renderer, 24_000, 256);
    assert!(peak(&played) > 0.05);
    assert_eq!(played, expected[..played.len()]);
}

#[test]
fn a_kit_of_more_than_eight_pads_reaches_the_audio_thread_whole() {
    let (mut controller, mut renderer, _midi) = host(RATE, 1);
    controller.send(EngineCommand::SetTrackInstrument {
        track: 0,
        instrument: "drumSampler".to_string(),
        pads: Some(16),
    });
    // Pad 13 is past the bundled kit, so only the musician's own WAV sounds
    // there — and only if the audio thread's kit is that big.
    controller.send(EngineCommand::SetPad {
        track: 0,
        pad: 12,
        note: 60,
        volume: 1.0,
        pan: 0.0,
        pitch: 0.0,
        choke_group: 0,
    });
    controller.send(EngineCommand::SetPadSample {
        track: 0,
        pad: 12,
        wav: SNARE.to_vec(),
    });
    controller.send(EngineCommand::SetTrackNotes {
        track: 0,
        notes: vec![0.0, 240.0, 60.0, 1.0],
    });
    controller.send(EngineCommand::Play);

    assert!(peak(&play(&mut renderer, 24_000, 256)) > 0.05);
}

#[test]
fn an_unknown_instrument_and_a_broken_wav_leave_the_track_alone() {
    let (mut controller, mut renderer, _midi) = host(RATE, 1);
    controller.send(EngineCommand::SetTrackInstrument {
        track: 0,
        instrument: "theremin".to_string(),
        pads: None,
    });
    controller.send(EngineCommand::SetPadSample {
        track: 0,
        pad: 0,
        wav: b"not a wav".to_vec(),
    });
    // The Synth is still there, playing the note the Drum Sampler would not.
    controller.send(EngineCommand::SetTrackNotes {
        track: 0,
        notes: vec![0.0, 960.0, 72.0, 1.0],
    });
    controller.send(EngineCommand::Play);
    assert!(peak(&play(&mut renderer, 24_000, 256)) > 0.05);
}

#[test]
fn insert_chain_edits_play_exactly_what_the_engine_plays_when_driven_directly() {
    let notes = [0.0, 960.0, 60.0, 1.0];
    let eq = [0.0, 30.0, 20_000.0, -12.0];

    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_notes(0, &notes);
    engine.insert_effect(0, 0, "reverb");
    engine.insert_effect(0, 0, "eq");
    engine.set_effect_settings(0, 0, &eq);
    engine.insert_effect(-1, 0, "compressor");
    engine.set_effect_bypassed(-1, 0, true);
    engine.play();
    let mut expected = Vec::new();
    while expected.len() < 48_000 {
        engine.render(256);
        expected.extend_from_slice(&engine.left()[..256]);
    }

    let (mut controller, mut renderer, _midi) = host(RATE, 1);
    for command in [
        EngineCommand::SetTrackNotes {
            track: 0,
            notes: notes.to_vec(),
        },
        // Added in another order, then moved into the same one.
        EngineCommand::InsertEffect {
            chain: 0,
            index: 0,
            effect: "eq".to_string(),
        },
        EngineCommand::InsertEffect {
            chain: 0,
            index: 0,
            effect: "reverb".to_string(),
        },
        EngineCommand::MoveEffect {
            chain: 0,
            from: 1,
            to: 0,
        },
        EngineCommand::SetEffectSettings {
            chain: 0,
            index: 0,
            settings: eq.to_vec(),
        },
        EngineCommand::InsertEffect {
            chain: -1,
            index: 0,
            effect: "compressor".to_string(),
        },
        EngineCommand::InsertEffect {
            chain: -1,
            index: 1,
            effect: "flanger".to_string(),
        },
        EngineCommand::InsertEffect {
            chain: -1,
            index: 1,
            effect: "reverb".to_string(),
        },
        EngineCommand::RemoveEffect {
            chain: -1,
            index: 1,
        },
        EngineCommand::SetEffectBypassed {
            chain: -1,
            index: 0,
            bypassed: true,
        },
        EngineCommand::Play,
    ] {
        controller.send(command);
    }
    let played = play(&mut renderer, 48_000, 256);

    assert!(peak(&played) > 0.01);
    let first = played.iter().zip(&expected).position(|(a, b)| a != b);
    assert_eq!(first, None, "{:?}", first.map(|i| (played[i], expected[i])));
}

#[test]
fn an_audio_clip_plays_through_the_queues_as_it_does_driven_directly() {
    let clips = [480.0, 0.5, 1.0, 0.1];
    let mut engine = Engine::new(RATE);
    engine.set_track_count(2);
    engine.set_track_audio(1, true);
    assert_eq!(engine.load_audio_file(1, SNARE), None);
    engine.set_track_audio_clips(1, &clips);
    engine.play();
    let mut expected = Vec::new();
    while expected.len() < 49_152 {
        engine.render(256);
        expected.extend_from_slice(&engine.left()[..256]);
    }

    let (mut controller, mut renderer, _midi) = host(RATE, 2);
    controller.send(EngineCommand::SetTrackAudio {
        track: 1,
        audio: true,
    });
    controller.send(EngineCommand::LoadAudioFile {
        file: 1,
        bytes: SNARE.to_vec(),
    });
    controller.send(EngineCommand::SetTrackAudioClips {
        track: 1,
        clips: clips.to_vec(),
    });
    // The Controller has the file now; forgetting it leaves the Clips theirs.
    controller.send(EngineCommand::UnloadAudioFile { file: 1 });
    controller.send(EngineCommand::Play);
    let played = play(&mut renderer, 49_152, 256);

    assert!(peak(&played) > 0.05);
    assert_eq!(played, expected);
}

const TONE: &[u8] = include_bytes!("../../../engine/tests/fixtures/tone.wav");

#[test]
fn an_audition_plays_straight_to_the_output_past_the_mixer_and_its_meters() {
    let (mut controller, mut renderer, _midi) = host(RATE, 1);
    // A Master at silence would silence anything that went through the mixer.
    controller.send(EngineCommand::SetMasterVolume { volume: 0.0 });
    controller.audition(TONE).unwrap();
    let out = play(&mut renderer, 12_000, 256);

    // The tone is half scale on the left, heard at the preview level.
    let heard = peak(&out);
    assert!(
        (heard - 0.5 * soundcheck_engine::AUDITION_GAIN).abs() < 0.01,
        "{heard}"
    );
    let measured = controller.stats().snapshot();
    assert_eq!(measured.meters.master, 0.0);
    assert_eq!(measured.meters.tracks, [0.0]);

    // A quarter of a second, played once.
    assert_eq!(peak(&play(&mut renderer, 12_000, 256)), 0.0);
}

#[test]
fn the_reference_track_auditions_at_the_gain_it_is_given_past_the_meters() {
    let (mut controller, mut renderer, _midi) = host(RATE, 1);
    controller.audition_at(TONE, 0.2).unwrap();
    let heard = peak(&play(&mut renderer, 12_000, 256));
    // Half scale on the left, turned down to a fifth.
    assert!((heard - 0.5 * 0.2).abs() < 0.01, "{heard}");
    assert_eq!(controller.stats().snapshot().meters.master, 0.0);
}

#[test]
fn stopping_an_audition_silences_it_and_a_file_that_isnt_audio_is_refused() {
    let (mut controller, mut renderer, _midi) = host(RATE, 0);
    controller.audition(TONE).unwrap();
    assert!(peak(&play(&mut renderer, 1_024, 256)) > 0.1);
    controller.stop_audition();
    assert_eq!(peak(&play(&mut renderer, 1_024, 256)), 0.0);

    assert!(controller.audition(b"not audio").is_err());
    assert_eq!(peak(&play(&mut renderer, 1_024, 256)), 0.0);
}

#[test]
fn an_offline_render_of_what_plays_never_hears_the_audition() {
    // An export or Audio Analysis is the song's commands on a Renderer of
    // its own; an audition isn't one of them, so it can't be in the mix.
    let commands = || {
        vec![
            EngineCommand::SetTrackCount { count: 1 },
            EngineCommand::Play,
        ]
    };
    let (mut controller, mut live, _midi) = host(RATE, 0);
    for command in commands() {
        controller.send(command);
    }
    controller.audition(TONE).unwrap();
    assert!(peak(&play(&mut live, 4_096, 256)) > 0.1);

    let mut offline = offline(RATE, commands());
    assert_eq!(peak(&play(&mut offline, 4_096, 256)), 0.0);
}

#[test]
fn automation_plays_exactly_what_the_engine_plays_when_driven_directly() {
    let notes = [0.0, 1_920.0, 60.0, 1.0];
    let volume = [0.0, 0.0, 0.0, 960.0, 1.0, 1.0, 1_440.0, 0.3, 0.0];
    let master = [480.0, 1.0, 0.0, 1_920.0, 0.2, 0.0];
    let (mut controller, mut renderer, _midi) = host(RATE, 1);
    for command in [
        EngineCommand::SetTrackNotes {
            track: 0,
            notes: notes.to_vec(),
        },
        EngineCommand::SetAutomation {
            target: 0,
            setting: "volume".into(),
            points: volume.to_vec(),
        },
        EngineCommand::SetAutomation {
            target: -1,
            setting: "volume".into(),
            points: master.to_vec(),
        },
        // Not a setting the engine automates: nothing reaches it.
        EngineCommand::SetAutomation {
            target: 0,
            setting: "mute".into(),
            points: vec![0.0, 1.0, 0.0],
        },
        EngineCommand::Play,
    ] {
        controller.send(command);
    }
    let played = play(&mut renderer, 48_000, 256);

    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_notes(0, &notes);
    engine.set_automation(0, "volume", &volume);
    engine.set_automation(-1, "volume", &master);
    engine.play();
    let mut expected = Vec::new();
    while expected.len() < 48_000 {
        engine.render(256);
        expected.extend_from_slice(&engine.left()[..256]);
    }
    assert!(peak(&played) > 0.01);
    let first = played.iter().zip(&expected).position(|(a, b)| a != b);
    assert_eq!(first, None, "{:?}", first.map(|i| (played[i], expected[i])));
}

#[test]
fn sends_play_exactly_what_the_engine_plays_when_driven_directly() {
    let notes = [0.0, 3_840.0, 60.0, 1.0];
    let bus0 = soundcheck_engine::bus_chain(0);
    let bus1 = soundcheck_engine::bus_chain(1);

    let mut engine = Engine::new(RATE);
    engine.set_track_count(2);
    engine.set_bus_count(2);
    engine.set_track_notes(0, &notes);
    engine.set_track_notes(1, &notes);
    engine.set_sends(0, &[0.0, 0.6]);
    engine.set_sends(1, &[0.0, 0.3, 1.0, 1.0]);
    engine.set_sends(bus0, &[1.0, 0.5]);
    engine.insert_effect(bus0, 0, "reverb");
    engine.play();
    let mut expected = Vec::new();
    while expected.len() < 24_064 {
        engine.render(256);
        expected.extend_from_slice(&engine.left()[..256]);
    }

    let (mut controller, mut renderer, _midi) = host(RATE, 2);
    for command in [
        EngineCommand::SetBusCount { count: 2 },
        EngineCommand::SetTrackNotes {
            track: 0,
            notes: notes.to_vec(),
        },
        EngineCommand::SetTrackNotes {
            track: 1,
            notes: notes.to_vec(),
        },
        EngineCommand::SetSends {
            channel: 0,
            sends: vec![0.0, 0.6],
        },
        EngineCommand::SetSends {
            channel: 1,
            sends: vec![0.0, 0.3, 1.0, 1.0],
        },
        EngineCommand::SetSends {
            channel: bus0,
            sends: vec![1.0, 0.5],
        },
        // A loop, refused: the Sends stay as they were.
        EngineCommand::SetSends {
            channel: bus1,
            sends: vec![0.0, 1.0],
        },
        // Malformed, so nothing reaches the audio thread.
        EngineCommand::SetSends {
            channel: 0,
            sends: vec![0.0],
        },
        EngineCommand::InsertEffect {
            chain: bus0,
            index: 0,
            effect: "reverb".to_string(),
        },
        EngineCommand::Play,
    ] {
        controller.send(command);
    }
    let played = play(&mut renderer, 24_064, 256);
    assert!(peak(&played) > 0.05);
    assert_eq!(played, expected);
    let meters = controller.stats().snapshot().meters;
    assert!(meters.buses.iter().all(|&peak| peak > 0.01), "{meters:?}");
}

/// An Audio Track playing a tone, the Master's first slot holding the test
/// Plugin with some settings changed and one automated, however the Plugin
/// got there.
fn through_the_test_plugin(plugin: Vec<EngineCommand>) -> Vec<EngineCommand> {
    let mut commands = vec![
        EngineCommand::SetTrackCount { count: 1 },
        EngineCommand::SetTrackAudio {
            track: 0,
            audio: true,
        },
        EngineCommand::LoadAudioFile {
            file: 1,
            bytes: TONE.to_vec(),
        },
        EngineCommand::SetTrackAudioClips {
            track: 0,
            clips: vec![0.0, 1.0, 1.0, 0.0],
        },
    ];
    commands.extend(plugin);
    commands.extend([
        EngineCommand::SetEffectSettings {
            chain: -1,
            index: 0,
            settings: vec![1.5, 0.25, 0.5],
        },
        EngineCommand::SetAutomation {
            target: -1,
            setting: "effect:0:smooth".into(),
            points: vec![0.0, 0.0, 0.0, 960.0, 0.9, 0.0],
        },
        EngineCommand::Play,
    ]);
    commands
}

const PLUGIN: &str = "dev.soundcheck.test.effect";

fn insert_plugin() -> EngineCommand {
    EngineCommand::InsertPlugin {
        chain: -1,
        index: 0,
        plugin: PLUGIN.into(),
    }
}

fn load_plugin() -> EngineCommand {
    EngineCommand::LoadPlugin {
        plugin: PLUGIN.into(),
        wasm: crate::plugin::tests::test_effect().to_vec(),
    }
}

#[test]
fn a_plugin_effect_plays_exactly_what_the_engine_plays_hosting_it_directly() {
    let plugin = crate::plugin::load(crate::plugin::tests::test_effect()).unwrap();
    let instance = crate::plugin::runtime()
        .instantiate(&plugin.module, &plugin.manifest, RATE, MAX_BLOCK)
        .unwrap();
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_audio(0, true);
    assert_eq!(engine.load_audio_file(1, TONE), None);
    engine.set_track_audio_clips(0, &[0.0, 1.0, 1.0, 0.0]);
    let effect = PreparedEffect::plugin(plugin.manifest, instance);
    assert!(engine.insert_prepared_effect(-1, 0, effect).is_ok());
    engine.set_effect_settings(-1, 0, &[1.5, 0.25, 0.5]);
    engine.set_automation(-1, "effect:0:smooth", &[0.0, 0.0, 0.0, 960.0, 0.9, 0.0]);
    engine.play();
    let mut expected = Vec::new();
    while expected.len() < 24_576 {
        engine.render(256);
        expected.extend_from_slice(&engine.left()[..256]);
    }

    let mut renderer = offline(
        RATE,
        through_the_test_plugin(vec![load_plugin(), insert_plugin()]),
    );
    let played = play(&mut renderer, 24_576, 256);
    assert!(peak(&played) > 0.05);
    assert_eq!(played, expected);
    assert_eq!(renderer.engine.effect_settings(-1, 0), [1.5, 0.25, 0.5]);
    assert!(!renderer.engine.effect_faulted(-1, 0));
}

#[test]
fn a_missing_plugin_passes_audio_through_and_sounds_right_once_installed() {
    let dry = play(
        &mut offline(RATE, through_the_test_plugin(vec![])),
        24_576,
        256,
    );
    assert!(peak(&dry) > 0.05);

    // Not loaded: the slot holds its place and passes the audio untouched.
    let mut missing = offline(RATE, through_the_test_plugin(vec![insert_plugin()]));
    assert_eq!(play(&mut missing, 24_576, 256), dry);

    // Installed: the UI loads it and puts it in the slot in place of the
    // missing one, with the settings the Project kept.
    let mut commands = through_the_test_plugin(vec![insert_plugin()]);
    commands.pop();
    commands.extend([
        EngineCommand::RemoveEffect {
            chain: -1,
            index: 0,
        },
        load_plugin(),
    ]);
    commands.extend(
        through_the_test_plugin(vec![insert_plugin()])
            .into_iter()
            .skip(4),
    );
    let installed = play(&mut offline(RATE, commands), 24_576, 256);
    let loaded = through_the_test_plugin(vec![load_plugin(), insert_plugin()]);
    assert_eq!(installed, play(&mut offline(RATE, loaded), 24_576, 256));
    assert_ne!(installed, dry);
}

#[test]
fn a_vst3_plugin_that_isnt_loaded_is_missing_and_passes_audio_through() {
    let dry = play(
        &mut offline(RATE, through_the_test_plugin(vec![])),
        24_576,
        256,
    );
    let insert = EngineCommand::InsertVst3 {
        chain: -1,
        index: 0,
        instance: "nothing".into(),
        generation: 1,
    };
    let mut missing = offline(RATE, through_the_test_plugin(vec![insert]));
    assert_eq!(play(&mut missing, 24_576, 256), dry);
}

#[test]
fn an_offline_render_hears_a_copy_of_the_live_vst3_plugin() {
    use crate::vst3::{hosted, process::State, registry};
    let Some(build) = hosted::build() else { return };
    let dry = play(
        &mut offline(RATE, through_the_test_plugin(vec![])),
        24_576,
        256,
    );
    // The test Plugin "Soundcheck Faulty", saved at half gain.
    let state = State {
        component: 0.5f32.to_le_bytes().to_vec(),
        controller: Vec::new(),
    };
    let request = hosted::request(
        &build,
        "host-offline",
        "soundcheck-test-faulty",
        hosted::FAULTY,
        Some(state),
    );
    let summary = registry().load(request).unwrap();
    let mut commands = through_the_test_plugin(vec![EngineCommand::InsertVst3 {
        chain: -1,
        index: 0,
        instance: "host-offline".into(),
        generation: summary.generation,
    }]);
    // Its one setting, Gain, rather than the WASM Plugin's three.
    commands.retain(|c| {
        !matches!(
            c,
            EngineCommand::SetEffectSettings { .. } | EngineCommand::SetAutomation { .. }
        )
    });
    let mut renderer = offline(RATE, commands.clone());
    assert_eq!(renderer.engine.effect_settings(-1, 0), [0.5], "as restored");
    let played = play(&mut renderer, 24_576, 256);
    assert!(peak(&dry) > 0.05);
    for (played, dry) in played.iter().zip(&dry) {
        assert!((played - dry * 0.5).abs() < 1e-6, "{played} against {dry}");
    }
    assert!(!renderer.engine.effect_faulted(-1, 0));

    // The UI's setting reaches it through the engine, as any Plugin's does.
    let play_at = commands.len() - 1;
    commands.insert(
        play_at,
        EngineCommand::SetEffectSettings {
            chain: -1,
            index: 0,
            settings: vec![0.25],
        },
    );
    let played = play(&mut offline(RATE, commands), 24_576, 256);
    for (played, dry) in played.iter().zip(&dry) {
        assert!((played - dry * 0.25).abs() < 1e-6, "{played} against {dry}");
    }
    registry().unload("host-offline");
}

const INSTRUMENT: &str = "dev.soundcheck.test.instrument";
const INSTRUMENT_NOTES: [f64; 12] = [
    0.0, 480.0, 60.0, 1.0, 240.0, 480.0, 67.0, 0.5, 600.0, 240.0, 64.0, 0.75,
];

/// An Instrument Track playing a few notes on the test Plugin Instrument,
/// with its settings changed and its level automated, however the Plugin got
/// there.
fn on_the_test_instrument(plugin: Vec<EngineCommand>) -> Vec<EngineCommand> {
    let mut commands = vec![
        EngineCommand::SetTrackCount { count: 1 },
        EngineCommand::SetTrackNotes {
            track: 0,
            notes: INSTRUMENT_NOTES.to_vec(),
        },
    ];
    commands.extend(plugin);
    commands.extend([
        EngineCommand::SetInstrumentSettings {
            track: 0,
            settings: vec![0.75, 2.0, 20.0, 0.5],
        },
        EngineCommand::SetAutomation {
            target: 0,
            setting: "instrument:level".into(),
            points: vec![0.0, 0.25, 0.0, 960.0, 1.0, 0.0],
        },
        EngineCommand::Play,
    ]);
    commands
}

fn set_track_plugin() -> EngineCommand {
    EngineCommand::SetTrackPlugin {
        track: 0,
        plugin: INSTRUMENT.into(),
    }
}

fn load_instrument() -> EngineCommand {
    EngineCommand::LoadPlugin {
        plugin: INSTRUMENT.into(),
        wasm: crate::plugin::tests::test_instrument().to_vec(),
    }
}

#[test]
fn a_plugin_instrument_plays_exactly_what_the_engine_plays_hosting_it_directly() {
    let plugin = crate::plugin::load(crate::plugin::tests::test_instrument()).unwrap();
    let instance = crate::plugin::runtime()
        .instantiate(&plugin.module, &plugin.manifest, RATE, MAX_BLOCK)
        .unwrap();
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_notes(0, &INSTRUMENT_NOTES);
    let old =
        engine.swap_track_instrument(0, PreparedInstrument::plugin(plugin.manifest, instance));
    drop(old);
    engine.set_track_instrument_settings(0, &[0.75, 2.0, 20.0, 0.5]);
    engine.set_automation(0, "instrument:level", &[0.0, 0.25, 0.0, 960.0, 1.0, 0.0]);
    engine.play();
    let mut expected = Vec::new();
    while expected.len() < 24_576 {
        engine.render(256);
        expected.extend_from_slice(&engine.left()[..256]);
    }

    let mut renderer = offline(
        RATE,
        on_the_test_instrument(vec![load_instrument(), set_track_plugin()]),
    );
    let played = play(&mut renderer, 24_576, 256);
    assert!(peak(&played) > 0.05);
    assert_eq!(played, expected);
    assert_eq!(
        renderer.engine.track_instrument(0),
        format!("plugin:{INSTRUMENT}")
    );
    assert_eq!(
        renderer.engine.track_instrument_settings(0),
        [0.75, 2.0, 20.0, 0.5]
    );
    assert!(!renderer.engine.track_instrument_faulted(0));
}

#[test]
fn a_missing_plugin_instrument_is_silent_and_sounds_right_once_installed() {
    // Not loaded: the Track keeps its settings and plays nothing.
    let mut missing = offline(RATE, on_the_test_instrument(vec![set_track_plugin()]));
    assert_eq!(peak(&play(&mut missing, 24_576, 256)), 0.0);
    assert_eq!(
        missing.engine.track_instrument(0),
        format!("missing:{INSTRUMENT}")
    );

    // Installed: the UI loads it and sets it on the Track in place of the
    // missing one, then sends the settings and automation the Project kept.
    let mut commands = on_the_test_instrument(vec![set_track_plugin()]);
    commands.pop();
    commands.push(load_instrument());
    commands.extend(
        on_the_test_instrument(vec![set_track_plugin()])
            .into_iter()
            .skip(2),
    );
    let installed = play(&mut offline(RATE, commands), 24_576, 256);
    let loaded = on_the_test_instrument(vec![load_instrument(), set_track_plugin()]);
    assert_eq!(installed, play(&mut offline(RATE, loaded), 24_576, 256));
    assert!(peak(&installed) > 0.05);
}

fn dj(kind: &str, index: usize, name: &str, value: f64) -> EngineCommand {
    EngineCommand::DjSet {
        kind: kind.into(),
        index,
        name: name.into(),
        value,
    }
}

#[test]
fn a_deck_plays_through_the_queues_its_headphone_cue_goes_to_outputs_3_and_4_and_it_records() {
    let (mut controller, mut renderer, _midi) = host(RATE, 0);
    let wav = soundcheck_engine_test_wav();
    let prepared = PreparedDjTrack::decode(&wav, RATE).unwrap();
    let analysis = controller.dj_put(0, prepared);
    assert!(analysis.starts_with(r#"{"seconds":"#));
    controller.send(dj("deck", 0, "play", 1.0));
    controller.send(dj("channel", 0, "cue", 1.0));
    controller.send(dj("mixer", 0, "record", 1.0));
    let mut buffer = vec![0.0; 256 * 4];
    renderer.process(&mut buffer, 4);
    renderer.process(&mut buffer, 4);
    let main: Vec<f32> = buffer.iter().step_by(4).copied().collect();
    let cue: Vec<f32> = buffer.iter().skip(2).step_by(4).copied().collect();
    assert!(peak(&main) > 0.1, "the mix is heard");
    assert!(peak(&cue) > 0.1, "and cued in the headphones");
    let measured = controller.stats().snapshot();
    let report = measured.dj.expect("the DJ Mixer reports once in use");
    assert_eq!(
        report[soundcheck_engine::GLOBAL_FIELDS + 1],
        1.0,
        "Deck 1 is playing"
    );
    assert_eq!(controller.take_dj_recording().len(), 2 * 512);
    // The song's own meter never hears it.
    assert_eq!(measured.meters.master, 0.0);
}

#[test]
fn an_unknown_dj_control_is_nothing_to_send() {
    let (mut controller, mut renderer, _midi) = host(RATE, 0);
    controller.send(dj("deck", 9, "play", 1.0));
    controller.send(dj("mixer", 0, "volume", 1.0));
    play(&mut renderer, 256, 256);
    assert!(
        controller.stats().snapshot().dj.is_none(),
        "no mixer was built"
    );
}

/// Half a second of a loud 220 Hz tone, as a 16-bit WAV.
fn soundcheck_engine_test_wav() -> Vec<u8> {
    let tone: Vec<i16> = (0..24_000)
        .map(|i| ((i as f32 * 220.0 * std::f32::consts::TAU / RATE).sin() * 16_000.0) as i16)
        .collect();
    let data: Vec<u8> = tone
        .iter()
        .flat_map(|s| [*s, *s])
        .flat_map(i16::to_le_bytes)
        .collect();
    let mut out = Vec::new();
    out.extend(b"RIFF");
    out.extend((36 + data.len() as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend((RATE as u32).to_le_bytes());
    out.extend((RATE as u32 * 4).to_le_bytes());
    out.extend(4u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend((data.len() as u32).to_le_bytes());
    out.extend(data);
    out
}

#[test]
fn the_headphone_cue_reaches_a_second_devices_ring_and_a_fake_device_plays_it() {
    let (mut controller, mut renderer, _midi) = host(RATE, 0);
    let prepared = PreparedDjTrack::decode(&soundcheck_engine_test_wav(), RATE).unwrap();
    controller.dj_put(0, prepared);
    controller.send(dj("deck", 0, "play", 1.0));
    controller.send(dj("channel", 0, "cue", 1.0));
    controller.send(dj("channel", 0, "fader", 0.0));
    controller.send(dj("mixer", 0, "headphoneLevel", 1.0));
    let (producer, consumer) = crate::headphones::ring(RATE);
    controller.set_headphones(Some(producer));
    // The main output is stereo: no outputs 3 and 4, so the ring is the only way to hear the cue.
    let main = play(&mut renderer, 4_096, 256);
    assert_eq!(
        peak(&main),
        0.0,
        "the fader is down, so the Master is silent"
    );
    // The "second device": a reader at 44.1 kHz, as a headset might run.
    let mut reader = crate::headphones::DriftReader::new(consumer, RATE, 44_100);
    let mut heard = vec![0.0f32; 2 * 1_500];
    reader.fill(&mut heard, 2, |s| s);
    assert!(peak(&heard) > 0.1, "the cue plays on the second device");

    // Taking the ring away hands it back to be dropped off the audio thread.
    controller.set_headphones(None);
    play(&mut renderer, 256, 256);
}

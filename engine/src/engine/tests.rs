use super::*;
use crate::dsp::measure::{peak, rms, sine};
use crate::metronome::CLICK_LEVEL as METRONOME_LEVEL;
use crate::record::RECORDING_CAPACITY;
use crate::schedule::NoteList;
use crate::transport::TICKS_PER_BEAT;

const RATE: f32 = 48_000.0;
const BLOCK: usize = 128;
const BEAT: f64 = TICKS_PER_BEAT as f64;
const BAR: f64 = BEAT * 4.0;

/// Render `blocks` blocks, returning the left channel end to end.
fn run(engine: &mut Engine, blocks: usize) -> Vec<f32> {
    run_frames(engine, blocks * BLOCK)
}

/// Render `frames` frames in blocks of `BLOCK`, returning the left channel.
fn run_frames(engine: &mut Engine, frames: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(frames);
    while out.len() < frames {
        let block = BLOCK.min(frames - out.len());
        engine.render(block);
        out.extend_from_slice(&engine.left()[..block]);
    }
    out
}

/// The left channel of interleaved stereo.
pub(super) fn left_of(interleaved: &[f32]) -> Vec<f32> {
    interleaved.iter().step_by(2).copied().collect()
}

/// Frames where a metronome click starts: its first sample is exactly the
/// click level, straight after silence.
fn click_onsets(left: &[f32]) -> Vec<usize> {
    (0..left.len())
        .filter(|&i| left[i] == METRONOME_LEVEL && (i == 0 || left[i - 1] == 0.0))
        .collect()
}

/// Whether the click starting at `onset` is the accented (higher) one. Ten
/// samples in, the 1.5 kHz accent has swung negative; the 1 kHz beat hasn't.
fn is_accent(left: &[f32], onset: usize) -> bool {
    left[onset + 10] < 0.0
}

fn engine_with_metronome() -> Engine {
    let mut engine = Engine::new(RATE);
    engine.set_metronome(true);
    engine
}

// The load test and live play, as before the transport.

#[test]
fn silent_with_nothing_playing() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(4);
    assert_eq!(peak(&run(&mut engine, 100)), 0.0);
}

#[test]
fn sixteen_tracks_play_their_patterns_without_clipping_or_blowing_up() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(16);
    engine.set_pattern_playing(true);
    // One bar at 120 BPM: every note has started and most have ended.
    let out = run(&mut engine, 750);

    assert!(peak(&out) > 0.05, "audible");
    assert!(out.iter().all(|s| s.is_finite() && s.abs() <= 1.0));
    assert!(
        engine.active_voices() >= 16,
        "{} voices",
        engine.active_voices()
    );
}

#[test]
fn stopping_the_pattern_lets_every_track_fall_silent() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(2);
    engine.set_loop(0.0, BAR, true);
    engine.set_pattern_playing(true);
    run(&mut engine, 200);
    engine.set_pattern_playing(false);
    run(&mut engine, 200);
    assert_eq!(engine.active_voices(), 0);
    assert!(!engine.is_playing());
}

#[test]
fn tracks_added_while_the_pattern_plays_join_in() {
    let mut engine = Engine::new(RATE);
    engine.set_loop(0.0, BAR, true);
    engine.set_pattern_playing(true);
    engine.set_track_count(3);
    run(&mut engine, 750);
    assert!(engine.active_voices() >= 3);
}

#[test]
fn track_count_grows_shrinks_and_is_capped() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(16);
    assert_eq!(engine.track_count(), 16);
    engine.set_track_count(3);
    assert_eq!(engine.track_count(), 3);
    engine.set_track_count(usize::MAX);
    assert_eq!(engine.track_count(), MAX_TRACKS);
}

#[test]
fn the_live_keyboard_plays_the_synth() {
    let mut engine = Engine::new(RATE);
    engine.note_on(60, 1.0);
    assert!(peak(&run(&mut engine, 20)) > 0.05);
    assert_eq!(engine.active_voices(), 1);
}

#[test]
fn in_latency_test_mode_a_note_plays_the_transient_at_the_next_block() {
    let mut engine = Engine::new(RATE);
    engine.set_latency_test(true);
    run(&mut engine, 3);
    engine.note_on(60, 1.0);
    let out = run(&mut engine, 3);

    // The first sample of the next block is the transient's first edge.
    assert_eq!(out[0], CLICK_LEVEL);
    assert_eq!(out[47], CLICK_LEVEL);
    assert_eq!(out[48], -CLICK_LEVEL);
    assert_eq!(out[95], -CLICK_LEVEL);
    assert_eq!(peak(&out[96..]), 0.0, "then silence: the Synth didn't play");
    assert_eq!(engine.active_voices(), 0);
}

#[test]
fn blocks_of_any_size_render() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_pattern_playing(true);
    for frames in [128, 256, 1, 1024] {
        engine.render(frames);
        assert!(engine.left().len() >= frames);
    }
}

// The transport.

#[test]
fn offline_metronome_clicks_land_on_the_exact_sample_for_the_tempo() {
    let mut engine = engine_with_metronome();
    let left = left_of(&engine.render_range(0.0, 4.0 * BAR));

    // 120 BPM at 48 kHz: a beat every 24 000 frames, the bar's first accented.
    let expected: Vec<usize> = (0..16).map(|beat| beat * 24_000).collect();
    let onsets = click_onsets(&left);
    assert_eq!(onsets, expected);
    for (beat, &onset) in onsets.iter().enumerate() {
        assert_eq!(is_accent(&left, onset), beat % 4 == 0, "beat {beat}");
    }
}

#[test]
fn clicks_follow_an_awkward_tempo_and_time_signature_exactly() {
    let mut engine = engine_with_metronome();
    engine.set_tempo(137.0);
    engine.set_time_signature(7, 8);
    let left = left_of(&engine.render_range(0.0, 2.0 * 7.0 * BEAT / 2.0));

    // Beats are eighth notes; each lands on the first frame at or after its
    // exact time, however the frames and ticks fall.
    let frames_per_eighth = 60.0 / 137.0 / 2.0 * f64::from(RATE);
    let expected: Vec<usize> = (0..14)
        .map(|beat| (beat as f64 * frames_per_eighth - 1e-6).ceil() as usize)
        .collect();
    let onsets = click_onsets(&left);
    assert_eq!(onsets, expected);
    let accents: Vec<bool> = onsets.iter().map(|&o| is_accent(&left, o)).collect();
    assert_eq!(accents.iter().filter(|&&a| a).count(), 2, "one per 7/8 bar");
    assert!(accents[0] && accents[7]);
}

#[test]
fn a_loop_repeats_with_no_gap_or_double_click_at_the_loop_point() {
    let mut engine = engine_with_metronome();
    // Loop beats 2 and 3 of the bar; playback starts at the top, reaches the
    // loop's end and goes round. 128-frame blocks, so wraps fall mid-block.
    engine.set_loop(BEAT, 3.0 * BEAT, true);
    engine.play();
    let left = run_frames(&mut engine, 10 * 24_000 + 1_000);

    let expected: Vec<usize> = (0..=10).map(|beat| beat * 24_000).collect();
    let onsets = click_onsets(&left);
    assert_eq!(
        onsets, expected,
        "a click every beat, evenly, through each wrap"
    );
    // Only the very first beat is a bar's first; the loop never reaches one.
    assert!(is_accent(&left, 0));
    assert!(onsets[1..].iter().all(|&o| !is_accent(&left, o)));
}

#[test]
fn a_note_held_across_the_loop_point_is_released_and_restarted_once() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_notes(0, &[0.0, BAR * 2.0, 60.0, 1.0]);
    engine.set_loop(0.0, BAR, true);
    engine.play();
    for _ in 0..3 {
        run_frames(&mut engine, 96_000);
        assert_eq!(engine.active_voices(), 1, "one voice, not a pile-up");
    }
}

#[test]
fn changing_tempo_while_playing_keeps_playback_in_time() {
    let mut engine = engine_with_metronome();
    engine.play();
    // A beat and a half at 120 BPM (1440 ticks), then half speed.
    let mut left = run_frames(&mut engine, 36_000);
    engine.set_tempo(60.0);
    assert!((engine.position() - 1_440.0).abs() < 1e-6, "no jump");
    left.extend(run_frames(&mut engine, 121_000));

    // The rest of beat 2 (480 ticks) now takes 24 000 frames, and each beat
    // after that 48 000.
    assert_eq!(click_onsets(&left), [0, 24_000, 60_000, 108_000, 156_000]);
}

#[test]
fn offline_render_of_one_minute_is_faster_than_real_time() {
    let mut engine = engine_with_metronome();
    engine.set_track_count(16);
    engine.set_pattern_playing(true);
    engine.set_loop(0.0, BAR, true);
    engine.stop();

    let started = std::time::Instant::now();
    // 120 beats at 120 BPM.
    let out = engine.render_range(0.0, 120.0 * BEAT);
    let elapsed = started.elapsed();

    assert_eq!(out.len(), 60 * 48_000 * 2);
    assert!(peak(&out) > 0.05);
    assert!(elapsed.as_secs_f64() < 60.0, "took {elapsed:?}");
    // The loop is ignored offline but kept for playback.
    assert!(engine.transport.loop_region().is_some());
}

#[test]
fn scheduled_notes_start_on_their_exact_sample() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    // Tick 1000 is 25 000 frames in at 120 BPM and 48 kHz. The saw starts at
    // its wrap point, where its first sample is exactly 0, so the first
    // sound is the frame after.
    engine.set_track_notes(0, &[1_000.0, 480.0, 60.0, 1.0]);
    let left = left_of(&engine.render_range(0.0, BAR));
    let first = left.iter().position(|&s| s != 0.0);
    assert_eq!(first, Some(25_001));
}

#[test]
fn notes_after_a_tempo_change_land_on_the_exact_sample_for_the_new_tempo() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    // 120 bpm for a bar (96 000 frames), then 90: a beat is 32 000 frames.
    engine.set_tempo_changes(&[BAR, 90.0, 4.0, 4.0]);
    engine.set_track_notes(0, &[BAR + 2.0 * BEAT, 480.0, 60.0, 1.0]);
    let left = left_of(&engine.render_range(0.0, 2.0 * BAR));
    let first = left.iter().position(|&s| s != 0.0);
    // The saw's first sample is exactly 0, so the first sound is the frame
    // after the note's.
    assert_eq!(first, Some(96_000 + 2 * 32_000 + 1));
}

#[test]
fn a_tempo_change_off_a_frame_puts_later_notes_on_the_first_frame_after_them() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_tempo(137.0);
    engine.set_tempo_changes(&[1_000.0, 71.0, 4.0, 4.0]);
    let note = 3_333.0;
    engine.set_track_notes(0, &[note, 480.0, 60.0, 1.0]);
    let left = left_of(&engine.render_range(0.0, BAR));
    let seconds = 1_000.0 * 60.0 / (137.0 * BEAT) + (note - 1_000.0) * 60.0 / (71.0 * BEAT);
    let frame = (seconds * f64::from(RATE) - 1e-6).ceil() as usize;
    assert_eq!(left.iter().position(|&s| s != 0.0), Some(frame + 1));
}

#[test]
fn the_metronome_follows_tempo_and_time_signature_changes() {
    let mut engine = engine_with_metronome();
    // A bar of 4/4 at 120, then 3/4 at 60 from bar 2: beats a second apart.
    engine.set_tempo_changes(&[BAR, 60.0, 3.0, 4.0]);
    let left = left_of(&engine.render_range(0.0, BAR + 6.0 * BEAT));
    let onsets = click_onsets(&left);
    assert_eq!(
        onsets,
        [
            0, 24_000, 48_000, 72_000, 96_000, 144_000, 192_000, 240_000, 288_000, 336_000
        ]
    );
    let accents: Vec<usize> = onsets
        .iter()
        .copied()
        .filter(|&o| is_accent(&left, o))
        .collect();
    assert_eq!(accents, [0, 96_000, 240_000]);
}

#[test]
fn an_offline_render_is_as_long_as_the_tempo_map_makes_its_range() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    // A bar at 120 (2 s), then a bar at 60 (4 s).
    engine.set_tempo_changes(&[BAR, 60.0, 4.0, 4.0]);
    assert_eq!(
        engine.render_range(0.0, 2.0 * BAR).len(),
        2 * (96_000 + 192_000)
    );
    // From the change on, only the slower tempo counts.
    assert_eq!(engine.render_range(BAR, 2.0 * BAR).len(), 2 * 192_000);
}

#[test]
fn tempo_changes_handed_in_play_like_ones_set_directly() {
    let mut direct = engine_with_metronome();
    direct.set_tempo_changes(&[BAR, 90.0, 4.0, 4.0]);
    let mut handed = engine_with_metronome();
    let old = handed.swap_tempo_changes(PreparedTempoChanges::new(&[BAR, 90.0, 4.0, 4.0]));
    assert_eq!(old.0, TempoChanges::default());
    assert_eq!(
        direct.render_range(0.0, 2.0 * BAR),
        handed.render_range(0.0, 2.0 * BAR)
    );
}

#[test]
fn stop_keeps_the_position_releases_notes_and_play_resumes() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_notes(0, &[0.0, BAR, 60.0, 1.0]);
    engine.play();
    run_frames(&mut engine, 24_000);
    engine.stop();
    let stopped_at = engine.position();
    assert!((stopped_at - BEAT).abs() < 1e-6);

    run_frames(&mut engine, 48_000);
    assert_eq!(engine.position(), stopped_at, "doesn't move while stopped");
    assert_eq!(engine.active_voices(), 0, "released");

    engine.play();
    run_frames(&mut engine, 24_000);
    assert!((engine.position() - 2.0 * BEAT).abs() < 1e-6);
}

#[test]
fn seeking_moves_the_position_and_skips_notes_already_started() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_notes(0, &[0.0, BAR, 60.0, 1.0]);
    engine.seek(BEAT);
    engine.play();
    run(&mut engine, 10);
    assert_eq!(engine.active_voices(), 0, "the note began before the seek");
    assert!(engine.position() > BEAT);
}

#[test]
fn bad_values_are_ignored() {
    let mut engine = Engine::new(RATE);
    engine.set_tempo(f64::NAN);
    assert_eq!(engine.tempo(), 120.0);
    engine.set_time_signature(4, 3);
    engine.set_time_signature(0, 4);
    engine.set_track_notes(5, &[0.0, 960.0, 60.0, 1.0]);
    engine.set_track_count(1);
    engine.set_track_notes(0, &[f64::NAN, 960.0, 60.0, 1.0, -5.0, 1.0, 60.0, 1.0]);
    engine.play();
    assert_eq!(peak(&run(&mut engine, 100)), 0.0);
}

// Live play and recording.

#[test]
fn live_notes_play_the_chosen_track_and_not_the_live_synth() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_live_track(Some(0));
    engine.note_on(60, 1.0);
    let live_on_track = run(&mut engine, 40);

    // The same note played by Track 0's own schedule, through its Synth and
    // Insert Chain, is sample for sample the same: the live Synth added
    // nothing on top, and nothing was lost.
    let mut scheduled = Engine::new(RATE);
    scheduled.set_track_count(1);
    scheduled.set_track_notes(0, &[0.0, BAR, 60.0, 1.0]);
    scheduled.play();
    assert_eq!(live_on_track, run(&mut scheduled, 40));
    assert!(peak(&live_on_track) > 0.05, "audible");

    // Without a live Track it is the engine's own Synth, at its own level.
    let mut own = Engine::new(RATE);
    own.set_track_count(1);
    own.note_on(60, 1.0);
    assert_ne!(run(&mut own, 40), live_on_track);
}

#[test]
fn a_note_held_while_the_live_track_changes_does_not_stick() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(2);
    engine.set_live_track(Some(0));
    engine.note_on(60, 1.0);
    run(&mut engine, 20);
    assert_eq!(engine.active_voices(), 1);

    // The key is still down when the live Track changes, so its note-off
    // goes to Track 1. Track 0's voice sustains for ever unless the change
    // released it.
    engine.set_live_track(Some(1));
    engine.note_off(60);
    run_frames(&mut engine, 48_000);
    assert_eq!(
        engine.active_voices(),
        0,
        "nothing stuck on the Track it left"
    );

    // A live Track that doesn't exist falls back to the engine's own Synth.
    engine.set_live_track(Some(9));
    engine.note_on(64, 1.0);
    assert!(peak(&run(&mut engine, 20)) > 0.05);
}

#[test]
fn recorded_notes_are_stamped_with_the_transport_position_at_their_block() {
    let mut engine = Engine::new(RATE);
    engine.set_recording(true);
    assert!(engine.is_recording());
    // Two beats, so the loop wraps within the test.
    engine.set_loop(0.0, 2.0 * BEAT, true);
    engine.play();

    // 120 BPM at 48 kHz is 25 frames a tick, so 100 blocks is 512 ticks.
    run(&mut engine, 100);
    engine.note_on(60, 0.5);
    run(&mut engine, 100);

    // Half speed from tick 1024: 50 frames a tick, so 100 blocks is 256.
    engine.set_tempo(60.0);
    run(&mut engine, 100);
    engine.note_off(60);

    // On to tick 1920, where the loop wraps back to 0, and 128 ticks past it.
    run(&mut engine, 300);
    engine.note_on(72, 1.0);

    let recorded = engine.recorded_notes();
    let ticks: Vec<f64> = recorded.iter().map(|n| n.tick).collect();
    assert!(
        ticks
            .iter()
            .zip([512.0, 1_280.0, 128.0])
            .all(|(tick, expected)| (tick - expected).abs() < 1e-9),
        "{ticks:?}"
    );
    assert_eq!(
        recorded.iter().map(|n| (n.pitch, n.on)).collect::<Vec<_>>(),
        [(60, true), (60, false), (72, true)]
    );
    assert_eq!(recorded[0].velocity, 0.5);

    engine.clear_recorded_notes();
    assert!(engine.recorded_notes().is_empty(), "the host drained it");
}

#[test]
fn nothing_is_recorded_until_recording_starts_and_logging_never_allocates() {
    let mut engine = Engine::new(RATE);
    engine.note_on(60, 1.0);
    engine.note_off(60);
    assert!(engine.recorded_notes().is_empty());

    engine.set_recording(true);
    let room = RECORDING_CAPACITY;
    let start = engine.recorded_notes().as_ptr();
    for _ in 0..room + 50 {
        engine.note_on(60, 1.0);
    }
    assert_eq!(engine.recorded_notes().len(), room);
    assert_eq!(engine.dropped_notes(), 50, "counted, not kept");
    assert_eq!(
        engine.recorded_notes().as_ptr(),
        start,
        "the log never moved: it never grew"
    );

    engine.set_recording(false);
    engine.clear_recorded_notes();
    engine.note_on(64, 1.0);
    assert!(engine.recorded_notes().is_empty());
}

#[test]
fn a_js_host_drains_the_log_as_flat_numbers() {
    let mut engine = Engine::new(RATE);
    engine.set_recording(true);
    engine.play();
    run(&mut engine, 100);
    engine.note_on(60, 1.0);

    assert_eq!(engine.take_recorded_notes(), [512.0, 60.0, 1.0, 1.0]);
    assert!(engine.take_recorded_notes().is_empty(), "drained");
}

// Realtime-safe control, for a native host.

#[test]
fn tracks_and_notes_handed_in_play_like_ones_set_directly() {
    let flat = [1_000.0, 480.0, 60.0, 1.0];
    let mut direct = Engine::new(RATE);
    direct.set_track_count(1);
    direct.set_track_notes(0, &flat);
    direct.play();

    let mut handed = Engine::new(RATE);
    handed.prepare(BLOCK);
    assert!(
        handed
            .add_track(PreparedTrack::new(RATE, BLOCK, NoteList::default()))
            .is_ok()
    );
    let old = handed.set_track_note_list(0, NoteList::from_flat(&flat));
    assert!(old.is_empty());
    handed.play();

    assert_eq!(run(&mut direct, 400), run(&mut handed, 400));
}

#[test]
fn a_track_can_be_handed_back_and_a_full_engine_refuses_more() {
    let mut engine = Engine::new(RATE);
    // Nothing reserved: adding would allocate, so it is refused.
    let track = PreparedTrack::new(RATE, BLOCK, NoteList::default());
    assert!(engine.add_track(track).is_err());

    engine.prepare(BLOCK);
    for _ in 0..MAX_TRACKS {
        let track = PreparedTrack::new(RATE, BLOCK, NoteList::default());
        assert!(engine.add_track(track).is_ok());
    }
    let track = PreparedTrack::new(RATE, BLOCK, NoteList::default());
    assert!(engine.add_track(track).is_err(), "at MAX_TRACKS");
    assert!(engine.remove_track().is_some());
    assert_eq!(engine.track_count(), MAX_TRACKS - 1);
}

#[test]
fn notes_for_a_missing_track_come_straight_back() {
    let mut engine = Engine::new(RATE);
    let back = engine.set_track_note_list(3, NoteList::from_flat(&[0.0, 960.0, 60.0, 1.0]));
    assert_eq!(back.len(), 1);
}

// The mixer: a channel per Track, all feeding the Master.

/// The right channel of interleaved stereo.
fn right_of(interleaved: &[f32]) -> Vec<f32> {
    interleaved.iter().skip(1).step_by(2).copied().collect()
}

/// An engine with `count` Tracks, each holding one note of `pitches` for a
/// bar, quietly enough that nothing clips.
pub(super) fn engine_with_notes(pitches: &[u8]) -> Engine {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(pitches.len());
    for (track, &pitch) in pitches.iter().enumerate() {
        engine.set_track_notes(track, &[0.0, BAR, f64::from(pitch), 0.6]);
    }
    engine
}

#[test]
fn solo_on_one_track_silences_the_others_and_two_solos_play_both() {
    let alone = |solo: &[usize]| {
        let mut engine = engine_with_notes(&[48, 60, 72]);
        for &track in solo {
            engine.set_track_mixer(track, 1.0, 0.0, false, true);
        }
        engine.render_range(0.0, BAR)
    };
    let one = |track: usize| {
        let mut engine = engine_with_notes(&[48, 60, 72]);
        for other in 0..3 {
            if other != track {
                engine.set_track_mixer(other, 1.0, 0.0, true, false);
            }
        }
        engine.render_range(0.0, BAR)
    };

    // Soloing a Track plays exactly that Track and nothing else.
    for track in 0..3 {
        assert!(peak(&one(track)) > 0.01, "Track {track} is audible");
        assert_eq!(alone(&[track]), one(track), "only Track {track} plays");
    }
    // Two solos play both, which is not the same as either alone.
    let two = alone(&[0, 2]);
    assert_ne!(two, one(0));
    assert_ne!(two, one(2));
    let both: Vec<f32> = one(0).iter().zip(one(2)).map(|(a, b)| a + b).collect();
    assert_eq!(two, both, "the two soloed Tracks, summed");
}

#[test]
fn muting_a_track_takes_it_out_of_the_mix() {
    // Each render gets its own Engine: Effects ring on, so a second render
    // of the same Tracks would start from a different state.
    let mut both = engine_with_notes(&[48, 60]);
    let mut muted = engine_with_notes(&[48, 60]);
    muted.set_track_mixer(1, 1.0, 0.0, true, false);
    let mut faded_out = engine_with_notes(&[48, 60]);
    faded_out.set_track_mixer(1, 0.0, 0.0, false, false);

    let muted = muted.render_range(0.0, BAR);
    assert!(peak(&muted) > 0.01);
    assert_ne!(muted, both.render_range(0.0, BAR));
    assert_eq!(muted, faded_out.render_range(0.0, BAR), "silent either way");
}

#[test]
fn volume_and_pan_scale_the_render_by_exactly_what_they_say() {
    let render = |volume: f32, pan: f32| {
        let mut engine = engine_with_notes(&[60]);
        engine.set_track_mixer(0, volume, pan, false, false);
        engine.render_range(0.0, BAR)
    };
    let unity = render(1.0, 0.0);
    assert!(peak(&unity) > 0.01 && peak(&unity) < 1.0, "no clipping");

    // Halving the fader halves every sample; the pan takes one side down by
    // its own fraction and leaves the other alone.
    for (volume, pan, left_gain, right_gain) in [
        (0.5, 0.0, 0.5, 0.5),
        (0.25, 0.0, 0.25, 0.25),
        (2.0, 0.0, 2.0, 2.0),
        (1.0, -1.0, 1.0, 0.0),
        (1.0, 1.0, 0.0, 1.0),
        (0.5, 0.5, 0.25, 0.5),
        (1.0, -0.25, 1.0, 0.75),
        (0.0, 0.0, 0.0, 0.0),
    ] {
        let out = render(volume, pan);
        let scaled: Vec<f32> = left_of(&unity)
            .iter()
            .map(|s| s * left_gain)
            .zip(right_of(&unity).iter().map(|s| s * right_gain))
            .flat_map(|(l, r)| [l.clamp(-1.0, 1.0), r.clamp(-1.0, 1.0)])
            .collect();
        assert_eq!(out, scaled, "volume {volume}, pan {pan}");
    }
}

#[test]
fn the_master_fader_scales_the_whole_mix() {
    let mut engine = engine_with_notes(&[48, 60]);
    assert_eq!(engine.master_volume(), 1.0);
    let unity = engine.render_range(0.0, BAR);

    let mut quieter = engine_with_notes(&[48, 60]);
    quieter.set_master_volume(0.5);
    assert_eq!(quieter.master_volume(), 0.5);

    let expected: Vec<f32> = unity.iter().map(|s| s * 0.5).collect();
    assert_eq!(quieter.render_range(0.0, BAR), expected);
}

#[test]
fn a_track_meter_reads_the_peak_of_what_that_track_puts_into_the_mix() {
    let mut engine = engine_with_notes(&[48, 60]);
    // Track 1 alone, so the mix is only its own contribution.
    engine.set_track_mixer(0, 1.0, 0.0, true, false);
    engine.play();
    let mut left = Vec::new();
    let mut right = Vec::new();
    for _ in 0..40 {
        engine.render(1_024);
        left.extend_from_slice(&engine.left()[..1_024]);
        right.extend_from_slice(&engine.right()[..1_024]);
        // The engine's own measurement of the block it just rendered.
        let block = peak(&engine.left()[..1_024]).max(peak(&engine.right()[..1_024]));
        assert!(engine.track_peak(1) >= block, "the meter holds the peak");
        assert!(engine.master_peak() >= block);
    }

    let measured = peak(&left).max(peak(&right));
    assert!(measured > 0.01, "audible");
    assert_eq!(engine.track_peak(0), 0.0, "a muted Track reads nothing");
    // Somewhere in the last blocks the meter reached the loudest sample.
    let mut engine = engine_with_notes(&[48, 60]);
    engine.set_track_mixer(0, 1.0, 0.0, true, false);
    engine.play();
    let mut highest: f32 = 0.0;
    for _ in 0..40 {
        engine.render(1_024);
        highest = highest.max(engine.track_peak(1));
    }
    assert!((highest - measured).abs() < 1e-6, "{highest} vs {measured}");
}

#[test]
fn the_master_meter_reads_the_peak_of_the_engines_own_output() {
    let mut engine = engine_with_notes(&[48, 60, 67]);
    engine.play();
    let mut highest: f32 = 0.0;
    let mut output: f32 = 0.0;
    for _ in 0..40 {
        engine.render(1_024);
        output = output.max(peak(&engine.left()[..1_024]).max(peak(&engine.right()[..1_024])));
        highest = highest.max(engine.master_peak());
    }
    assert!(output > 0.01);
    assert!((highest - output).abs() < 1e-6, "{highest} vs {output}");
}

#[test]
fn a_meter_falls_back_after_its_peak_and_a_silent_track_reaches_nothing() {
    let mut engine = engine_with_notes(&[60]);
    engine.play();
    run_frames(&mut engine, 4_800);
    let peaked = engine.track_peak(0);
    assert!(peaked > 0.01);

    engine.stop();
    engine.set_track_count(0);
    engine.set_track_count(1);
    // Two seconds of silence is 40 dB of fall.
    run_frames(&mut engine, 96_000);
    assert!(
        engine.master_peak() < peaked / 10.0,
        "the Master falls back"
    );
    assert_eq!(engine.track_peak(0), 0.0);
    assert_eq!(engine.track_peak(9), 0.0, "no such Track");
}

#[test]
fn mixer_settings_that_make_no_sense_are_ignored_or_clamped() {
    let mut engine = engine_with_notes(&[60]);
    engine.set_track_mixer(0, 0.5, 0.0, false, false);
    engine.set_track_mixer(0, f32::NAN, 0.0, true, true);
    engine.set_track_mixer(0, 1.0, f32::INFINITY, true, true);
    engine.set_track_mixer(7, 0.1, 0.0, true, true);
    engine.set_master_volume(f32::NAN);
    assert_eq!(engine.master_volume(), 1.0);

    let mut expected = engine_with_notes(&[60]);
    expected.set_track_mixer(0, 0.5, 0.0, false, false);
    assert_eq!(
        engine.render_range(0.0, BEAT),
        expected.render_range(0.0, BEAT)
    );

    // Out-of-range values stop at the ends of the controls.
    engine.set_master_volume(50.0);
    assert_eq!(engine.master_volume(), 2.0);
    engine.set_track_mixer(0, -3.0, -9.0, false, false);
    let silent = engine.render_range(0.0, BEAT);
    assert_eq!(peak(&silent), 0.0, "a fader at the bottom is silence");
}

#[test]
fn audio_analysis_hears_a_track_through_its_own_fader_whatever_mute_says() {
    use crate::analysis::Source;
    let mut loud_engine = engine_with_notes(&[60]);
    let mut quiet_engine = engine_with_notes(&[60]);
    quiet_engine.set_track_mixer(0, 0.5, 0.0, true, false);

    let loud = loud_engine
        .analysis(0.0, BAR, Source::Track(0))
        .sample_peak_db;
    let quiet = quiet_engine
        .analysis(0.0, BAR, Source::Track(0))
        .sample_peak_db;
    assert!(loud.is_finite());
    assert!((quiet - (loud - 6.02)).abs() < 0.01, "{quiet} vs {loud}");
}

#[test]
fn a_tracks_synth_takes_a_preset_and_the_live_track_takes_its_own() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(2);
    let pad = crate::factory_presets()
        .into_iter()
        .find(|preset| preset.name == "Warm Pad")
        .expect("a Warm Pad preset");
    engine.set_track_synth(1, &pad.settings.to_flat());

    assert_eq!(engine.track_synth(1), pad.settings.to_flat());
    assert_eq!(
        engine.track_synth(0),
        SynthSettings::default().to_flat(),
        "the other Track is left alone"
    );

    // Below zero is the live Track the keyboard plays.
    engine.set_track_synth(-1, &pad.settings.to_flat());
    assert_eq!(engine.track_synth(-1), pad.settings.to_flat());
    engine.note_on(60, 1.0);
    assert!(peak(&run(&mut engine, 200)) > 0.01, "and it still sounds");

    // A Track that doesn't exist is ignored, not a panic.
    engine.set_track_synth(9, &pad.settings.to_flat());
}

// The Drum Sampler.

/// The bundled snare, as a host would hand the file over.
const SNARE_WAV: &[u8] = include_bytes!("../../assets/kits/starter/snare.wav");

/// Pads of the bundled kit, in the order it lists them.
const CLOSED_HAT: usize = 3;
const OPEN_HAT: usize = 4;

/// A kick on each of `beats` beats, as 1/16 steps of the Step Sequencer.
fn four_on_the_floor(beats: usize) -> Vec<f64> {
    (0..beats)
        .flat_map(|beat| [beat as f64 * BEAT, BEAT / 4.0, 36.0, 0.8])
        .collect()
}

#[test]
fn a_four_on_the_floor_pattern_plays_the_bundled_kick_on_every_beat() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    assert!(engine.set_track_instrument(0, "drumSampler", None));
    engine.set_track_notes(0, &four_on_the_floor(4));
    let left = left_of(&engine.render_range(0.0, BAR));

    // At 120 BPM a beat is 24 000 frames, and the kick attacks on each.
    for beat in 0..4 {
        let at = beat * 24_000;
        let attack = peak(&left[at..at + 2_400]);
        assert!(attack > 0.2, "beat {beat} is quiet: {attack}");
        if beat > 0 {
            let before = peak(&left[at - 2_400..at]);
            assert!(
                attack > 4.0 * before,
                "beat {beat}: {attack} after {before}"
            );
        }
    }
}

/// A mono 16-bit WAV of `samples` at `RATE`, as a musician's own file
/// arrives: the bytes, for the engine to decode.
fn wav_of(samples: &[f32]) -> Vec<u8> {
    let data: Vec<u8> = samples
        .iter()
        .flat_map(|s| ((s * 32_767.0) as i16).to_le_bytes())
        .collect();
    let rate = RATE as u32;
    let mut out = Vec::new();
    out.extend(b"RIFF");
    out.extend((36 + data.len() as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes()); // PCM
    out.extend(1u16.to_le_bytes()); // mono
    out.extend(rate.to_le_bytes());
    out.extend((rate * 2).to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend((data.len() as u32).to_le_bytes());
    out.extend(data);
    out
}

#[test]
fn a_closed_hat_chokes_an_open_one_in_an_offline_render() {
    // A steady tone stands in for the open hat, so what the choke stops
    // is easy to hear. The kit's own hats choke each other in the Drum
    // Sampler's own tests.
    let tone = wav_of(&sine(1_000.0, 0.8, RATE, 48_000));
    let tap = wav_of(&sine(4_000.0, 0.2, RATE, 480));
    let render = |notes: &[f64]| {
        let mut engine = Engine::new(RATE);
        engine.set_track_count(1);
        engine.set_track_instrument(0, "drumSampler", None);
        assert_eq!(engine.load_track_pad_sample(0, OPEN_HAT, &tone), None);
        assert_eq!(engine.load_track_pad_sample(0, CLOSED_HAT, &tap), None);
        engine.set_track_notes(0, notes);
        left_of(&engine.render_range(0.0, BAR))
    };
    let open = [0.0, BEAT / 2.0, 46.0, 1.0];
    let closed = [BEAT / 2.0, BEAT / 2.0, 42.0, 1.0];

    // The eighth note is 12 000 frames in; measure once the closed hat's
    // own tap and the choke's 5 ms fade are over.
    let ringing = rms(&render(&open)[16_800..24_000]);
    let choked = rms(&render(&[open, closed].concat())[16_800..24_000]);
    assert!(ringing > 0.1, "the open hat rings on: {ringing}");
    assert!(choked < ringing / 5.0, "choked: {choked} vs {ringing}");
}

#[test]
fn only_a_drum_sampler_track_takes_pads_and_samples() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    assert!(!engine.set_track_instrument(0, "theremin", None), "unknown");
    assert!(
        !engine.set_track_instrument(1, "drumSampler", None),
        "no Track 1"
    );
    assert_eq!(
        engine.load_track_pad_sample(0, 0, SNARE_WAV).as_deref(),
        Some("That Track isn't playing the Drum Sampler")
    );
    // Setting a pad on the Synth is ignored rather than fatal.
    engine.set_track_pad(0, 0, 36, 1.0, 0.0, 0.0, 0);

    assert!(engine.set_track_instrument(0, "drumSampler", None));
    assert_eq!(
        engine.load_track_pad_sample(0, 99, SNARE_WAV).as_deref(),
        Some("This kit has no such pad")
    );
    assert_eq!(
        engine
            .load_track_pad_sample(0, 0, b"not a wav at all")
            .as_deref(),
        Some("This isn't a WAV file")
    );
    assert_eq!(engine.load_track_pad_sample(0, 0, SNARE_WAV), None);
}

#[test]
fn a_pad_the_musician_loads_and_pans_plays_in_its_place() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_instrument(0, "drumSampler", None);
    // The snare, on the kick's pad, hard left and an octave down.
    assert_eq!(engine.load_track_pad_sample(0, 0, SNARE_WAV), None);
    engine.set_track_pad(0, 0, 36, 1.0, -1.0, -12.0, 0);
    engine.set_track_notes(0, &four_on_the_floor(1));

    let stereo = engine.render_range(0.0, BEAT);
    let left = left_of(&stereo);
    let right: Vec<f32> = stereo.iter().skip(1).step_by(2).copied().collect();
    assert!(peak(&left) > 0.2, "the loaded sample plays");
    assert!(peak(&right) < peak(&left) / 4.0, "panned left");
}

/// A Drum Sampler Track, with `pads` pads where the host says so.
fn drums(pads: Option<usize>) -> Engine {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    assert!(engine.set_track_instrument(0, "drumSampler", pads));
    engine
}

#[test]
fn taking_a_loaded_sample_off_a_pad_puts_the_kits_own_sound_back() {
    // The kick pad, as the kit has it, with the snare loaded onto it, and
    // with that snare taken off again.
    let kick = |load: bool, clear: bool| {
        let mut engine = drums(None);
        if load {
            assert_eq!(engine.load_track_pad_sample(0, 0, SNARE_WAV), None);
        }
        if clear {
            engine.clear_track_pad_sample(0, 0);
        }
        engine.set_track_notes(0, &four_on_the_floor(1));
        left_of(&engine.render_range(0.0, BEAT))
    };

    let kit = kick(false, false);
    assert!(peak(&kit) > 0.1, "the kit's own kick sounds");
    assert_ne!(kick(true, false), kit, "the snare is not the kick");
    assert_eq!(kick(true, true), kit, "the kit's kick is back");
}

#[test]
fn a_kit_of_more_than_eight_pads_plays_the_pads_past_the_bundled_ones() {
    // A Project may have 8 to 16 pads (PRD #10); the pads past the bundled
    // kit start empty, for the musician's own samples.
    let mut engine = drums(Some(16));
    assert_eq!(engine.load_track_pad_sample(0, 12, SNARE_WAV), None);
    engine.set_track_pad(0, 12, 60, 1.0, 0.0, 0.0, 0);
    engine.set_track_notes(0, &[0.0, BEAT / 4.0, 60.0, 1.0]);
    assert!(
        peak(&left_of(&engine.render_range(0.0, BEAT))) > 0.1,
        "pad 13"
    );

    // The kit has no sound of its own that far up, so taking the sample off
    // leaves the pad silent.
    let mut engine = drums(Some(16));
    assert_eq!(engine.load_track_pad_sample(0, 12, SNARE_WAV), None);
    engine.clear_track_pad_sample(0, 12);
    engine.set_track_pad(0, 12, 60, 1.0, 0.0, 0.0, 0);
    engine.set_track_notes(0, &[0.0, BEAT / 4.0, 60.0, 1.0]);
    assert!(
        peak(&left_of(&engine.render_range(0.0, BEAT))) < 0.01,
        "silent"
    );

    // A kit the other way round: eight pads, and nothing past them.
    let mut engine = drums(Some(8));
    assert_eq!(
        engine.load_track_pad_sample(0, 12, SNARE_WAV).as_deref(),
        Some("This kit has no such pad")
    );
}

#[test]
fn a_kit_that_changes_size_is_rebuilt_at_the_new_size() {
    let mut engine = drums(Some(8));
    assert_eq!(
        engine.load_track_pad_sample(0, 9, SNARE_WAV).as_deref(),
        Some("This kit has no such pad")
    );
    assert!(engine.set_track_instrument(0, "drumSampler", Some(12)));
    assert_eq!(engine.load_track_pad_sample(0, 9, SNARE_WAV), None);
}

#[test]
fn asking_for_the_instrument_a_track_already_has_leaves_it_alone() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_instrument(0, "drumSampler", None);
    engine.load_track_pad_sample(0, 0, SNARE_WAV);
    assert!(engine.set_track_instrument(0, "drumSampler", None));
    // The loaded sample survives, so the kit wasn't rebuilt underneath it.
    engine.set_track_pad(0, 0, 36, 1.0, -1.0, 0.0, 0);
    engine.set_track_notes(0, &four_on_the_floor(1));
    let stereo = engine.render_range(0.0, BEAT);
    let right: Vec<f32> = stereo.iter().skip(1).step_by(2).copied().collect();
    assert!(
        peak(&left_of(&stereo)) > 4.0 * peak(&right),
        "still panned left"
    );
}

#[test]
fn an_instrument_and_a_sample_handed_in_play_like_ones_set_directly() {
    let mut engine = Engine::new(RATE);
    engine.prepare(BLOCK);
    assert!(
        engine
            .add_track(PreparedTrack::new(
                RATE,
                BLOCK,
                NoteList::from_flat(&four_on_the_floor(1))
            ))
            .is_ok()
    );
    assert!(PreparedInstrument::named("theremin", RATE, None).is_none());
    assert!(PreparedSample::decode(b"not a wav at all").is_err());

    let drums = PreparedInstrument::named("drumSampler", RATE, None).unwrap();
    // The Synth comes back, to be dropped off the audio thread.
    let _synth = engine.swap_track_instrument(0, drums);
    let sample = PreparedSample::decode(SNARE_WAV).unwrap();
    let _replaced = engine.swap_pad_sample(0, 0, sample).expect("the kit's own");
    // A Track without pads hands the sample straight back.
    let sample = PreparedSample::decode(SNARE_WAV).unwrap();
    assert!(engine.swap_pad_sample(9, 0, sample).is_some());

    engine.play();
    assert!(peak(&run(&mut engine, 100)) > 0.1, "the snare on pad 1");
}

#[test]
fn stopping_cuts_a_ringing_drum_short() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_instrument(0, "drumSampler", None);
    engine.set_track_notes(0, &[0.0, BEAT / 4.0, 46.0, 1.0]);
    engine.play();
    let playing = peak(&run_frames(&mut engine, 4_800));
    assert!(engine.active_voices() > 0, "the open hat rings");

    engine.stop();
    run_frames(&mut engine, 1_024); // The 5 ms fade.
    assert_eq!(engine.active_voices(), 0);
    let after = peak(&run_frames(&mut engine, 4_800));
    assert!(after < playing / 4.0, "silence: {after}");
}

/// The EQ's flat form with the named settings changed.
pub(super) fn eq_flat(settings: &[(&str, f32)]) -> Vec<f32> {
    use crate::effect::{EQ_PARAMS, EqSettings, Settings};
    let mut flat = EqSettings::default().to_flat();
    for (name, value) in settings {
        let index = EQ_PARAMS.iter().position(|p| p.name == *name).unwrap();
        flat[index] = *value;
    }
    flat
}

/// About 12 dB off everything: a low shelf that reaches past the top.
pub(super) fn cut_everything() -> Vec<f32> {
    eq_flat(&[("lowShelfHz", 20_000.0), ("lowShelfGainDb", -12.0)])
}

/// A second of one Track playing a held note, rendered offline, with
/// `chain` setting up its Insert Chain (chain 0) and the Master's (-1).
fn render_with(chain: impl FnOnce(&mut Engine)) -> Vec<f32> {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_notes(0, &[0.0, BEAT, 57.0, 1.0]);
    chain(&mut engine);
    left_of(&engine.render_range(0.0, BEAT * 2.0))
}

fn db_between(a: &[f32], b: &[f32]) -> f32 {
    crate::dsp::gain_to_db(rms(a) / rms(b))
}

#[test]
fn a_track_with_no_effects_plays_its_instrument_dry() {
    let dry = render_with(|_| {});
    let emptied = render_with(|engine| {
        assert!(engine.insert_effect(0, 0, "reverb"));
        engine.remove_effect(0, 0);
    });
    assert_eq!(dry, emptied, "removing the only Effect leaves it dry");
    // The note ends at one beat (24,000 frames at 120 bpm): dry, nothing
    // rings on past its 0.3 s release.
    assert!(peak(&dry[42_000..]) < 1e-4);
}

#[test]
fn a_reverb_rings_on_until_it_is_bypassed_or_removed() {
    let dry = render_with(|_| {});
    let reverb = render_with(|engine| {
        engine.insert_effect(0, 0, "reverb");
    });
    assert!(rms(&reverb[42_000..]) > 1e-3, "the tail");
    let bypassed = render_with(|engine| {
        engine.insert_effect(0, 0, "reverb");
        engine.set_effect_bypassed(0, 0, true);
    });
    assert_eq!(
        bypassed, dry,
        "a bypassed Effect passes the signal untouched"
    );
}

#[test]
fn reordering_effects_changes_the_render() {
    // A hard Compressor before a 12 dB cut squashes the loud signal; after
    // it, it hears a quiet one and hardly acts.
    let compressor = [-30.0, 20.0, 1.0, 100.0, 0.0];
    let setup = |engine: &mut Engine| {
        engine.insert_effect(0, 0, "compressor");
        engine.set_effect_settings(0, 0, &compressor);
        engine.insert_effect(0, 1, "eq");
        engine.set_effect_settings(0, 1, &cut_everything());
        assert_eq!(engine.chain_effects(0), "compressor,eq");
    };
    let compressed_first = render_with(setup);
    let cut_first = render_with(|engine| {
        setup(engine);
        engine.move_effect(0, 1, 0);
        assert_eq!(engine.chain_effects(0), "eq,compressor");
    });
    let difference = db_between(&cut_first[..24_000], &compressed_first[..24_000]);
    assert!(difference > 6.0, "{difference} dB");
}

#[test]
fn effect_settings_are_clamped_and_change_the_render() {
    let dry = render_with(|_| {});
    let cut = render_with(|engine| {
        engine.insert_effect(0, 0, "eq");
        engine.set_effect_settings(0, 0, &cut_everything());
    });
    let difference = db_between(&cut[..24_000], &dry[..24_000]);
    assert!((difference - -12.0).abs() < 1.0, "{difference} dB");

    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    assert!(!engine.insert_effect(0, 0, "flanger"), "no such Effect");
    assert!(!engine.insert_effect(3, 0, "eq"), "no such Track");
    assert!(
        engine.insert_effect(0, 99, "compressor"),
        "past the end appends"
    );
    engine.set_effect_settings(0, 0, &[-100.0, 99.0]);
    assert_eq!(
        engine.effect_settings(0, 0),
        [-60.0, 20.0, 5.0, 120.0, 3.0, 6.0]
    );
    assert!(engine.effect_settings(0, 1).is_empty());
}

#[test]
fn the_master_chain_acts_on_the_whole_mix() {
    let dry = render_with(|_| {});
    let cut = render_with(|engine| {
        engine.insert_effect(-1, 0, "eq");
        engine.set_effect_settings(-1, 0, &cut_everything());
        assert_eq!(engine.chain_effects(-1), "eq");
        assert_eq!(engine.chain_effects(0), "", "not the Track's");
    });
    let difference = db_between(&cut[..24_000], &dry[..24_000]);
    assert!((difference - -12.0).abs() < 1.0, "{difference} dB");

    let bypassed = render_with(|engine| {
        engine.insert_effect(-1, 0, "eq");
        engine.set_effect_settings(-1, 0, &cut_everything());
        engine.set_effect_bypassed(-1, 0, true);
    });
    assert_eq!(bypassed, dry);
}

#[test]
fn a_compressor_on_any_chain_meters_its_gain_reduction() {
    // A hard Compressor on the Track and another on the Master: both report
    // how far they pull the held note down, the Master's less, as it hears
    // the Track's already squashed.
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_notes(0, &[0.0, BEAT, 57.0, 1.0]);
    engine.insert_effect(0, 0, "eq");
    engine.insert_effect(0, 1, "compressor");
    engine.set_effect_settings(0, 1, &[-60.0, 20.0, 1.0, 100.0, 0.0, 0.0]);
    engine.insert_effect(-1, 0, "compressor");
    engine.set_effect_settings(-1, 0, &[-60.0, 20.0, 1.0, 100.0, 0.0, 0.0]);
    assert_eq!(engine.effect_count(0), 2);
    assert_eq!(engine.effect_count(-1), 1);
    assert_eq!(engine.effect_count(5), 0, "no such Track");
    assert_eq!(engine.effect_gain_reduction(0, 1), 0.0, "before any sound");

    engine.play();
    for _ in 0..100 {
        engine.render(128);
    }
    let track = engine.effect_gain_reduction(0, 1);
    let master = engine.effect_gain_reduction(-1, 0);
    assert!(track > 10.0, "the Track's shows {track} dB");
    assert!(
        master > 0.1 && master < track,
        "the Master's shows {master} dB"
    );
    assert_eq!(engine.effect_gain_reduction(0, 0), 0.0, "an EQ has none");
    assert_eq!(engine.effect_gain_reduction(0, 9), 0.0, "no such Effect");
    engine.set_effect_bypassed(-1, 0, true);
    assert_eq!(engine.effect_gain_reduction(-1, 0), 0.0, "bypassed");
}

#[test]
fn audio_analysis_of_one_track_skips_the_master_chain() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_notes(0, &[0.0, BEAT, 57.0, 1.0]);
    engine.insert_effect(-1, 0, "eq");
    engine.set_effect_settings(-1, 0, &cut_everything());
    engine.isolate = Some(0);
    let isolated = left_of(&engine.render_range(0.0, BEAT));
    engine.isolate = None;
    let mixed = left_of(&engine.render_range(0.0, BEAT));
    assert!(db_between(&isolated, &mixed) > 10.0);
}

#[test]
fn prepared_effects_move_in_and_out_of_a_chain() {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    let reverb = PreparedEffect::named("reverb", RATE).unwrap();
    assert!(engine.insert_prepared_effect(0, 0, reverb).is_ok());
    let eq = PreparedEffect::named("eq", RATE).unwrap();
    assert!(
        engine.insert_prepared_effect(5, 0, eq).is_err(),
        "no such Track"
    );
    assert!(PreparedEffect::named("flanger", RATE).is_none());
    assert!(engine.take_effect(0, 0).is_some());
    assert!(engine.take_effect(0, 0).is_none());
    for _ in 0..crate::effect::MAX_EFFECTS {
        assert!(engine.insert_effect(-1, 0, "eq"));
    }
    assert!(!engine.insert_effect(-1, 0, "eq"), "the chain is full");
}

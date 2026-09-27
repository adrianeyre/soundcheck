//! Audio Tracks and their Audio Clips, rendered offline.

use super::*;
use crate::audio_file::tests::{
    TONE_FLAC, TONE_FRAMES, TONE_MP3, TONE_RATE, TONE_WAV, best_aligned_error, stereo_wav, tone,
};
use crate::dsp::measure::peak;
use crate::transport::TICKS_PER_BEAT;

const BEAT: f64 = TICKS_PER_BEAT as f64;

const RATE: f32 = 48_000.0;
/// At 120 bpm and 48 kHz a tick is exactly 25 frames.
const FRAMES_PER_TICK: usize = 25;
/// A length in ticks, in seconds at 120 bpm: how the engine takes an Audio
/// Clip's length.
fn seconds(ticks: f64) -> f64 {
    ticks / 1_920.0
}

/// What one Track alone reaches the Master at.
const ONE_TRACK: f32 = TRACKS_GAIN;

/// An engine at 120 bpm with one Audio Track and file number 1 loaded.
fn engine_with(bytes: &[u8]) -> Engine {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_audio(0, true);
    assert_eq!(engine.load_audio_file(1, bytes), None);
    engine
}

fn sides(interleaved: &[f32]) -> (Vec<f32>, Vec<f32>) {
    (
        interleaved
            .iter()
            .step_by(2)
            .map(|s| s / ONE_TRACK)
            .collect(),
        interleaved
            .iter()
            .skip(1)
            .step_by(2)
            .map(|s| s / ONE_TRACK)
            .collect(),
    )
}

/// A 48 kHz stereo WAV whose every frame is different: a ramp on the left,
/// the same ramp upside down on the right.
fn ramp(frames: usize) -> (Vec<f32>, Vec<f32>, Vec<u8>) {
    let left: Vec<f32> = (0..frames)
        .map(|i| (i % 30_000) as f32 / 40_000.0 + 0.01)
        .collect();
    let right: Vec<f32> = left.iter().map(|s| -s).collect();
    let wav = stereo_wav(&left, &right, RATE as u32);
    // The WAV holds 16-bit samples: compare with what it decodes to.
    let decoded = crate::audio_file::decode(&wav).unwrap();
    (decoded.left, decoded.right, wav)
}

/// The last block's first 10 frames on the left, as the file had them.
fn own_left(engine: &Engine) -> Vec<f32> {
    engine.left()[..10].iter().map(|s| s / ONE_TRACK).collect()
}

fn assert_plays_the_tone(bytes: &[u8]) {
    let mut engine = engine_with(bytes);
    let length = (TONE_FRAMES as f64 / TONE_RATE * 1_920.0).ceil();
    engine.set_track_audio_clips(0, &[0.0, seconds(length), 1.0, 0.0]);
    let (left, right) = sides(&engine.render_range(0.0, length + 100.0));
    // The resampler's kernel runs off the file at each end.
    for i in 64..11_900 {
        assert!(
            (left[i] - tone(i, f64::from(RATE), 0)).abs() < 2e-3,
            "left {i}"
        );
        assert!(
            (right[i] - tone(i, f64::from(RATE), 1)).abs() < 2e-3,
            "right {i}"
        );
    }
    assert!(
        left[12_100..].iter().all(|&s| s == 0.0),
        "silent after the file ends"
    );
}

#[test]
fn a_wav_on_an_audio_track_plays_its_samples_at_the_engines_rate() {
    assert_plays_the_tone(TONE_WAV);
}

#[test]
fn a_flac_on_an_audio_track_plays_its_samples_at_the_engines_rate() {
    assert_plays_the_tone(TONE_FLAC);
}

#[test]
fn an_mp3_on_an_audio_track_plays_its_tone_at_the_engines_rate() {
    let mut engine = engine_with(TONE_MP3);
    engine.set_track_audio_clips(0, &[0.0, seconds(960.0), 1.0, 0.0]);
    let (left, right) = sides(&engine.render_range(0.0, 960.0));
    let rate = f64::from(RATE);
    assert!(best_aligned_error(&left, |i| tone(i, rate, 0)) < 0.05);
    assert!(best_aligned_error(&right, |i| tone(i, rate, 1)) < 0.05);
}

#[test]
fn a_trimmed_clip_plays_only_its_range_to_the_frame() {
    let (file_left, file_right, wav) = ramp(48_000);
    let mut engine = engine_with(&wav);
    // From beat 2 for half a beat, starting 0.1 s into the file.
    engine.set_track_audio_clips(0, &[960.0, seconds(480.0), 1.0, 0.1]);
    let (left, right) = sides(&engine.render_range(0.0, 2_400.0));

    let (start, end, offset) = (960 * FRAMES_PER_TICK, 1_440 * FRAMES_PER_TICK, 4_800);
    assert!(left[..start].iter().all(|&s| s == 0.0), "nothing before it");
    for i in start..end {
        assert_eq!(left[i], file_left[offset + i - start], "left {i}");
        assert_eq!(right[i], file_right[offset + i - start], "right {i}");
    }
    assert!(left[end..].iter().all(|&s| s == 0.0), "nothing after it");
}

#[test]
fn playing_from_inside_a_clip_picks_up_where_the_playhead_is() {
    let (file_left, _, wav) = ramp(48_000);
    let mut engine = engine_with(&wav);
    engine.set_track_audio_clips(0, &[0.0, seconds(1_920.0), 1.0, 0.0]);
    let (left, _) = sides(&engine.render_range(100.0, 200.0));
    let into = 100 * FRAMES_PER_TICK;
    assert_eq!(left[..10], file_left[into..into + 10]);
}

#[test]
fn a_clip_loaded_while_playing_joins_in_under_the_playhead() {
    let (file_left, _, wav) = ramp(48_000);
    let mut engine = engine_with(&wav);
    engine.play();
    engine.render(1_000);
    engine.set_track_audio_clips(0, &[0.0, seconds(1_920.0), 1.0, 0.0]);
    engine.render(10);
    let left = own_left(&engine);
    assert_eq!(left, file_left[1_000..1_010]);
}

#[test]
fn stopping_silences_a_clip_and_a_tempo_change_does_not_stretch_it() {
    let (file_left, _, wav) = ramp(48_000);
    let mut engine = engine_with(&wav);
    engine.set_track_audio_clips(0, &[0.0, seconds(9_600.0), 1.0, 0.0]);
    engine.play();
    engine.render(500);
    engine.set_tempo(60.0);
    engine.render(10);
    let left = own_left(&engine);
    assert_eq!(left, file_left[500..510]);

    engine.stop();
    engine.render(10);
    assert!(engine.left()[..10].iter().all(|&s| s == 0.0));
}

#[test]
fn an_audio_track_plays_no_instrument_and_follows_its_mixer() {
    let (_, _, wav) = ramp(48_000);
    let mut engine = engine_with(&wav);
    engine.set_live_track(Some(0));
    engine.note_on(60, 1.0);
    engine.render(4_800);
    assert_eq!(
        peak(engine.left()),
        0.0,
        "notes don't sound on an Audio Track"
    );

    engine.set_track_audio_clips(0, &[0.0, seconds(960.0), 1.0, 0.0]);
    engine.set_track_mixer(0, 1.0, 0.0, true, false);
    assert!(
        engine.render_range(0.0, 960.0).iter().all(|&s| s == 0.0),
        "muted"
    );
    engine.set_track_mixer(0, 1.0, 1.0, false, false);
    let (left, right) = sides(&engine.render_range(0.0, 960.0));
    assert_eq!(peak(&left), 0.0, "panned hard right");
    assert!(peak(&right) > 0.1);
}

#[test]
fn a_clip_whose_file_is_not_loaded_is_silent_and_a_bad_file_says_why() {
    let mut engine = engine_with(TONE_WAV);
    engine.set_track_audio_clips(0, &[0.0, seconds(960.0), 2.0, 0.0]);
    assert!(engine.render_range(0.0, 960.0).iter().all(|&s| s == 0.0));
    assert!(engine.load_audio_file(2, b"not audio").is_some());
}

#[test]
fn an_audio_track_plays_through_its_insert_chain() {
    let (_, _, wav) = ramp(24_000);
    let clips = [0.0, seconds(960.0), 1.0, 0.0];
    let mut dry = engine_with(&wav);
    dry.set_track_audio_clips(0, &clips);
    let dry = dry.render_range(0.0, 960.0);

    // An EQ whose low shelf takes 18 dB off everything.
    let mut cut = engine_with(&wav);
    cut.set_track_audio_clips(0, &clips);
    assert!(cut.insert_effect(0, 0, "eq"));
    cut.set_effect_settings(0, 0, &[0.0, 30.0, 20_000.0, -18.0]);
    let cut = cut.render_range(0.0, 960.0);
    assert!(peak(&dry) > 0.1);
    assert!(peak(&cut) < peak(&dry) / 4.0);
}

#[test]
fn an_exported_range_ends_a_clip_that_runs_past_it() {
    let (_, _, wav) = ramp(48_000);
    let mut engine = engine_with(&wav);
    // A Clip for two beats, and a range that stops after one.
    engine.set_track_audio_clips(0, &[0.0, seconds(1_920.0), 1.0, 0.0]);
    let range = engine.start_render(0.0, 960.0, 10.0);
    let mut out = Vec::new();
    loop {
        let step = engine.render_next(4_800);
        if step.is_empty() {
            break;
        }
        out.extend(step);
    }
    assert!(peak(&out[..range * 2]) > 0.1);
    // With nothing to ring out, the tail is its half-second of silence.
    assert_eq!(out.len(), (range + 24_000) * 2);
    assert_eq!(peak(&out[range * 2..]), 0.0);
}

#[test]
fn a_clip_under_a_tempo_change_starts_on_its_tick_and_is_not_stretched() {
    let (file_left, _, wav) = ramp(48_000);
    let mut engine = engine_with(&wav);
    // From beat 2 for half a second of audio; from beat 3 the tempo halves.
    engine.set_track_audio_clips(0, &[960.0, 0.5, 1.0, 0.0]);
    engine.set_tempo_changes(&[1_920.0, 60.0, 4.0, 4.0]);
    let (left, _) = sides(&engine.render_range(0.0, 3_840.0));

    let start = 960 * FRAMES_PER_TICK;
    assert!(left[..start].iter().all(|&s| s == 0.0), "nothing before it");
    assert_eq!(left[start..start + 24_000], file_left[..24_000]);
    assert!(
        left[start + 24_000..].iter().all(|&s| s == 0.0),
        "nothing after it"
    );
}

#[test]
fn a_clip_ends_on_the_frame_its_length_in_ticks_did_before_tempo_changes() {
    // A schema 4 Project held an Audio Clip's length in ticks at one tempo.
    // Migrated to seconds, it must end on the very frame the tick did.
    let (_, _, wav) = ramp(48_000);
    let rate = 44_100.0;
    let mut engine = Engine::new(rate);
    engine.set_track_count(1);
    engine.set_track_audio(0, true);
    engine.load_audio_file(1, &wav);
    engine.set_tempo(97.0);
    let (start, length) = (1_001.0, 1_337.0);
    let seconds = length * 60.0 / (97.0 * BEAT);
    engine.set_track_audio_clips(0, &[start, seconds, 1.0, 0.0]);
    let left: Vec<f32> = engine
        .render_range(0.0, 4_000.0)
        .into_iter()
        .step_by(2)
        .collect();

    let frame_of =
        |tick: f64| (tick * 60.0 / (97.0 * BEAT) * f64::from(rate) - 1e-6).ceil() as usize;
    let last = left.iter().rposition(|&s| s != 0.0).unwrap();
    assert_eq!(last + 1, frame_of(start + length));
    assert_eq!(left.iter().position(|&s| s != 0.0), Some(frame_of(start)));
}

#[test]
fn a_prepared_file_hands_a_host_its_samples_at_the_rate_asked_for() {
    // As Stem Separation on the desktop reads a file: at 44.1 kHz whatever its
    // own rate, with a mono file on both sides.
    let file = PreparedAudioFile::decode(TONE_WAV, 22_050.0).unwrap();
    assert_eq!(file.left().len(), TONE_FRAMES.div_ceil(2));
    assert_eq!(file.right().len(), file.left().len());
    assert!(file.left() != file.right());

    let mono: Vec<f32> = (0..100).map(|i| i as f32 / 200.0).collect();
    let bytes = crate::wav_writer::mono_wav_bytes(&mono, 44_100, crate::SampleFormat::Float32);
    let file = PreparedAudioFile::decode(&bytes, 44_100.0).unwrap();
    assert_eq!(file.left(), mono);
    assert_eq!(file.right(), mono);
}

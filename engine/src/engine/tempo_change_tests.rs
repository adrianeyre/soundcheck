//! Tempo Changes in export and Audio Analysis: both render ranges through
//! the tempo map, so they hear what playback plays.

use super::tests::left_of;
use super::*;
use crate::analysis::Source;
use crate::audio_file::tests::stereo_wav;
use crate::transport::TICKS_PER_BEAT;

const RATE: f32 = 48_000.0;
const BEAT: f64 = TICKS_PER_BEAT as f64;
const BAR: f64 = BEAT * 4.0;
const MASTER: i32 = -1;

/// Two bars of 4/4 at 120, then 3/4 at 60 from bar 3: bar 3 starts 4 s in,
/// and every bar after it is 3 s long.
const CHANGE: [f64; 4] = [2.0 * BAR, 60.0, 3.0, 4.0];

/// Where bar `bar` (counting from 1) starts, in ticks, under `CHANGE`.
fn bar_tick(bar: u32) -> f64 {
    match bar {
        1..=3 => f64::from(bar - 1) * BAR,
        _ => 2.0 * BAR + f64::from(bar - 3) * 3.0 * BEAT,
    }
}

/// A song across `CHANGE`: a Synth playing a short note on every beat, into
/// a tempo-synced Delay on a Bus and another on the Master, and an Audio
/// Clip that starts in the first tempo and plays on under the second.
fn song() -> Engine {
    let mut engine = Engine::new(RATE);
    engine.set_tempo_changes(&CHANGE);
    engine.set_track_count(2);
    let beats = 2 * 4 + 3 * 3;
    let notes: Vec<f64> = (0..beats)
        .flat_map(|beat| {
            let tick = if beat < 8 {
                f64::from(beat) * BEAT
            } else {
                2.0 * BAR + f64::from(beat - 8) * BEAT
            };
            [tick, BEAT / 4.0, 60.0 + f64::from(beat % 5), 0.8]
        })
        .collect();
    engine.set_track_notes(0, &notes);

    let tone: Vec<f32> = (0..3 * 48_000)
        .map(|i| (i as f32 * 0.03).sin() * 0.3)
        .collect();
    engine.set_track_audio(1, true);
    assert_eq!(
        engine.load_audio_file(1, &stereo_wav(&tone, &tone, RATE as u32)),
        None
    );
    // From bar 2, for 3 s: a bar at 120, then a second at 60.
    engine.set_track_audio_clips(1, &[BAR, 3.0, 1.0, 0.0]);

    // Sync, note, time (ms), feedback, high cut (Hz), ping-pong, mix.
    let delay = [1.0, 7.0, 250.0, 0.4, 8_000.0, 1.0, 0.5];
    engine.set_bus_count(1);
    assert!(engine.set_track_output(0, 0));
    assert!(engine.insert_effect(bus_chain(0), 0, "delay"));
    engine.set_effect_settings(bus_chain(0), 0, &delay);
    assert!(engine.insert_effect(MASTER, 0, "delay"));
    engine.set_effect_settings(MASTER, 0, &delay);
    engine
}

/// What playback plays from `start` for `frames` frames, as interleaved
/// stereo, in blocks of `block` frames as an audio device asks for them.
pub(super) fn played(engine: &mut Engine, start: f64, frames: usize, block: usize) -> Vec<f32> {
    engine.seek(start);
    engine.play();
    let mut out = Vec::with_capacity(frames * 2 + block * 2);
    while out.len() < frames * 2 {
        engine.render(block);
        for (l, r) in engine.left()[..block].iter().zip(&engine.right()[..block]) {
            out.extend([*l, *r]);
        }
    }
    out.truncate(frames * 2);
    out
}

/// The first frame where `a` and `b` differ, if they do.
pub(super) fn first_difference(a: &[f32], b: &[f32]) -> Option<usize> {
    if a.len() != b.len() {
        return Some(a.len().min(b.len()) / 2);
    }
    a.iter().zip(b).position(|(x, y)| x != y).map(|i| i / 2)
}

/// An export of `start` to `end`, as the host runs one: in steps, with no
/// tail.
pub(super) fn exported(engine: &mut Engine, start: f64, end: f64) -> Vec<f32> {
    engine.start_render(start, end, 0.0);
    let mut out = Vec::new();
    loop {
        let step = engine.render_next(4_096);
        if step.is_empty() {
            return out;
        }
        out.extend(step);
    }
}

#[test]
fn an_export_across_a_tempo_change_matches_playback() {
    let end = bar_tick(6);
    let export = exported(&mut song(), 0.0, end);
    // 4 s of 4/4 at 120, then three bars of 3/4 at 60.
    assert_eq!(export.len(), 2 * (4 + 9) * 48_000);
    assert!(export.iter().any(|s| s.abs() > 0.05), "the song is heard");
    for block in [128, 256, 441, 1_024] {
        let playback = played(&mut song(), 0.0, export.len() / 2, block);
        assert_eq!(
            first_difference(&playback, &export),
            None,
            "played in blocks of {block}"
        );
    }
}

#[test]
fn an_export_of_a_range_after_a_tempo_change_matches_playback_from_there() {
    let (start, end) = (bar_tick(4), bar_tick(6));
    let export = exported(&mut song(), start, end);
    // Two bars of 3/4 at 60.
    assert_eq!(export.len(), 2 * 6 * 48_000);
    let playback = played(&mut song(), start, export.len() / 2, 256);
    assert_eq!(first_difference(&playback, &export), None);
}

#[test]
fn analysing_bars_after_a_tempo_change_hears_the_seconds_they_play_at() {
    // A note on every beat of bars 4 and 5 only.
    let notes: Vec<f64> = (0..6)
        .flat_map(|beat| [bar_tick(4) + f64::from(beat) * BEAT, BEAT / 4.0, 60.0, 0.8])
        .collect();
    let mut engine = Engine::new(RATE);
    engine.set_tempo_changes(&CHANGE);
    engine.set_track_count(1);
    engine.set_track_notes(0, &notes);

    let analysis = engine.analysis(bar_tick(4), bar_tick(6), Source::Mix);
    // Bar 4 starts 4 s + a bar of 3/4 at 60 in, and two bars last 6 s.
    assert_eq!((analysis.start.seconds, analysis.end.seconds), (7.0, 13.0));
    assert_eq!(
        (analysis.start.label(), analysis.end.label()),
        ("4.1".into(), "6.1".into())
    );
    assert_eq!(analysis.onset_count, 6, "{:?}", analysis.onsets);
    for (beat, onset) in analysis.onsets.iter().enumerate() {
        assert!(
            (onset.seconds - (7.0 + beat as f64)).abs() < 0.02,
            "{onset:?}"
        );
        assert_eq!(onset.label(), format!("{}.{}", 4 + beat / 3, beat % 3 + 1));
    }

    // What it heard is what an export of those bars holds, and nothing
    // from the bars before.
    let export = left_of(&exported(&mut engine, bar_tick(4), bar_tick(6)));
    assert_eq!(export.len(), 6 * 48_000);
    let early = engine.analysis(bar_tick(3), bar_tick(4), Source::Mix);
    assert_eq!((early.start.seconds, early.end.seconds), (4.0, 7.0));
    assert_eq!(early.onset_count, 0, "{:?}", early.onsets);
}

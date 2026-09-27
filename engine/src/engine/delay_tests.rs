//! The Delay in the engine's Insert Chains, following the song's tempo map.

use super::tests::left_of;
use super::*;
use crate::transport::TICKS_PER_BEAT;

const RATE: f32 = 48_000.0;
const BEAT: f64 = TICKS_PER_BEAT as f64;
const BAR: f64 = BEAT * 4.0;
const MASTER: i32 = -1;

/// Sync, note, time (ms), feedback, high cut (Hz), ping-pong, mix: only the
/// repeats of a synced quarter note, no feedback, the high cut open.
const QUARTER_REPEATS: [f32; 7] = [1.0, 7.0, 250.0, 0.0, 20_000.0, 0.0, 1.0];

/// One Track playing a short note at `tick`.
fn engine_with_a_note_at(tick: f64) -> Engine {
    let mut engine = Engine::new(RATE);
    engine.set_track_count(1);
    engine.set_track_notes(0, &[tick, BEAT / 8.0, 60.0, 1.0]);
    engine
}

fn with_delay(engine: &mut Engine, chain: i32) {
    assert!(engine.insert_effect(chain, 0, "delay"));
    engine.set_effect_settings(chain, 0, &QUARTER_REPEATS);
}

/// The first frame that is not silent.
fn onset(left: &[f32]) -> usize {
    left.iter()
        .position(|s| s.abs() > 1e-3)
        .expect("something plays")
}

#[test]
fn a_synced_delay_repeats_a_quarter_note_later_on_any_chain() {
    for tempo in [120.0, 90.0] {
        let render = |delay: Option<i32>| {
            let mut engine = engine_with_a_note_at(0.0);
            engine.set_tempo(tempo);
            engine.set_bus_count(1);
            assert!(engine.set_track_output(0, 0));
            if let Some(chain) = delay {
                with_delay(&mut engine, chain);
            }
            left_of(&engine.render_range(0.0, BAR))
        };
        let dry = onset(&render(None));
        let quarter = (60.0 / tempo * f64::from(RATE)).round() as usize;
        for chain in [0, bus_chain(0), MASTER] {
            assert_eq!(
                onset(&render(Some(chain))),
                dry + quarter,
                "chain {chain} at {tempo}"
            );
        }
    }
}

#[test]
fn a_synced_delay_follows_a_tempo_change() {
    // 120 for two bars, then 60: the note on bar 3 repeats a second later,
    // not half a second.
    let render = |delay: bool| {
        let mut engine = engine_with_a_note_at(2.0 * BAR);
        engine.set_tempo(120.0);
        engine.set_tempo_changes(&[2.0 * BAR, 60.0, 4.0, 4.0]);
        if delay {
            with_delay(&mut engine, 0);
        }
        left_of(&engine.render_range(0.0, 3.0 * BAR))
    };
    let dry = onset(&render(false));
    assert!((dry as i64 - 4 * 48_000).abs() < 100, "bar 3 is 4 s in");
    assert_eq!(onset(&render(true)), dry + 48_000);
}

#[test]
fn playback_through_a_delay_matches_an_offline_render() {
    let setup = || {
        let mut engine = engine_with_a_note_at(0.0);
        with_delay(&mut engine, MASTER);
        engine.set_effect_settings(MASTER, 0, &[1.0, 6.0, 250.0, 0.5, 6_000.0, 1.0, 0.4]);
        engine
    };
    let offline = setup().render_range(0.0, BAR);

    let mut live = setup();
    live.play();
    let mut played = Vec::new();
    while played.len() < offline.len() {
        live.render(256);
        for (l, r) in live.left()[..256].iter().zip(&live.right()[..256]) {
            played.extend([*l, *r]);
        }
    }
    played.truncate(offline.len());
    assert_eq!(played, offline);
}

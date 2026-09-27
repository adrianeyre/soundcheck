//! Buses and each Track's and Bus's output, rendered into buffers.

use super::tests::{cut_everything, engine_with_notes, left_of};
use super::*;
use crate::dsp::measure::{peak, rms};
use crate::transport::TICKS_PER_BEAT;

const BAR: f64 = TICKS_PER_BEAT as f64 * 4.0;
const MASTER: i32 = -1;

fn render(engine: &mut Engine) -> Vec<f32> {
    left_of(&engine.render_range(0.0, BAR))
}

/// Two Tracks, a bar each, feeding the Master.
fn two_tracks() -> Engine {
    engine_with_notes(&[48, 60])
}

fn close(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5)
}

#[test]
fn two_tracks_routed_to_a_bus_are_both_processed_by_its_effect() {
    let mut bussed = two_tracks();
    bussed.set_bus_count(1);
    assert!(bussed.insert_effect(bus_chain(0), 0, "reverb"));
    assert!(bussed.set_track_output(0, 0));
    assert!(bussed.set_track_output(1, 0));

    // The same Reverb hearing the same two Tracks, on the Master instead.
    let mut mastered = two_tracks();
    assert!(mastered.insert_effect(MASTER, 0, "reverb"));

    let dry = render(&mut two_tracks());
    let through_the_bus = render(&mut bussed);
    assert_eq!(through_the_bus, render(&mut mastered));
    assert!(!close(&through_the_bus, &dry), "the Reverb is heard");
    assert!(bussed.bus_peak(0) > 0.01, "the Bus's meter moves");
}

#[test]
fn a_track_not_routed_to_the_bus_skips_it() {
    let mut engine = two_tracks();
    engine.set_bus_count(1);
    engine.set_track_output(0, 0);
    // The Bus's fader is down, so only Track 1 is heard.
    engine.set_bus_mixer(0, 0.0, 0.0, false, false);

    let mut alone = two_tracks();
    alone.set_track_mixer(0, 1.0, 0.0, true, false);
    assert_eq!(render(&mut engine), render(&mut alone));
}

#[test]
fn a_bus_at_unity_with_no_effects_changes_nothing() {
    let mut engine = two_tracks();
    engine.set_bus_count(2);
    engine.set_track_output(0, 0);
    engine.set_track_output(1, 1);
    assert!(engine.set_bus_output(1, 0));
    assert_eq!(render(&mut engine), render(&mut two_tracks()));
}

#[test]
fn a_bus_feeding_a_bus_passes_through_both_faders_whichever_comes_first() {
    for (first, second) in [(0, 1), (1, 0)] {
        let mut engine = two_tracks();
        engine.set_bus_count(2);
        engine.set_track_output(0, first);
        engine.set_track_output(1, first);
        assert!(engine.set_bus_output(first as usize, second));
        engine.set_bus_mixer(0, 0.5, 0.0, false, false);
        engine.set_bus_mixer(1, 0.5, 0.0, false, false);
        let quarter: Vec<f32> = render(&mut two_tracks()).iter().map(|s| s * 0.25).collect();
        assert!(close(&render(&mut engine), &quarter), "{first} -> {second}");
    }
}

#[test]
fn a_loop_is_refused_and_leaves_the_routing_as_it_was() {
    let mut engine = two_tracks();
    engine.set_bus_count(3);
    assert!(engine.set_bus_output(0, 1));
    assert!(engine.set_bus_output(1, 2));
    assert!(!engine.set_bus_output(2, 0), "2 -> 0 -> 1 -> 2 loops");
    assert!(!engine.set_bus_output(1, 1), "a Bus can't feed itself");
    assert!(!engine.set_bus_output(0, 3), "no such Bus");
    assert!(!engine.set_bus_output(3, MASTER), "no such Bus");
    assert!(!engine.set_track_output(0, 3), "no such Bus");
    assert!(!engine.set_track_output(2, 0), "no such Track");

    engine.set_track_output(0, 0);
    engine.set_track_output(1, 0);
    // Still 0 -> 1 -> 2 -> Master, so everything is still heard.
    assert_eq!(render(&mut engine), render(&mut two_tracks()));
}

#[test]
fn removing_a_bus_sends_what_fed_it_to_the_master() {
    let routed = || {
        let mut engine = two_tracks();
        engine.set_bus_count(2);
        engine.set_track_output(0, 1);
        engine.set_bus_output(0, 1);
        engine.set_track_output(1, 0);
        engine.set_bus_mixer(1, 0.0, 0.0, false, false);
        engine
    };
    assert_eq!(
        peak(&render(&mut routed())),
        0.0,
        "both behind a closed fader"
    );

    let mut engine = routed();
    engine.set_bus_count(1);
    assert_eq!(render(&mut engine), render(&mut two_tracks()));
    assert!(!engine.set_track_output(0, 1), "the Bus has gone");
}

#[test]
fn a_bus_chain_is_addressed_below_the_masters() {
    let mut engine = Engine::new(48_000.0);
    engine.set_bus_count(2);
    assert!(engine.insert_effect(bus_chain(1), 0, "eq"));
    assert!(engine.insert_effect(bus_chain(1), 1, "compressor"));
    assert_eq!(engine.chain_effects(bus_chain(1)), "eq,compressor");
    assert_eq!(engine.effect_count(bus_chain(0)), 0);
    assert_eq!(engine.effect_count(MASTER), 0);
    assert!(!engine.insert_effect(bus_chain(2), 0, "eq"), "no such Bus");
}

#[test]
fn a_bus_effect_processes_the_bus_and_not_the_master() {
    let mut engine = two_tracks();
    engine.set_bus_count(1);
    engine.set_track_output(0, 0);
    engine.set_track_output(1, 0);
    engine.insert_effect(bus_chain(0), 0, "eq");
    engine.set_effect_settings(bus_chain(0), 0, &cut_everything());
    let cut = rms(&render(&mut engine)) / rms(&render(&mut two_tracks()));
    assert!((0.2..0.3).contains(&cut), "about 12 dB down: {cut}");
}

#[test]
fn soloing_a_bus_plays_what_feeds_it_and_nothing_else() {
    let mut engine = engine_with_notes(&[48, 60, 72]);
    engine.set_bus_count(1);
    engine.set_track_output(0, 0);
    engine.set_track_output(1, 0);
    engine.set_bus_mixer(0, 1.0, 0.0, false, true);

    let mut expected = engine_with_notes(&[48, 60, 72]);
    expected.set_track_mixer(2, 1.0, 0.0, true, false);
    assert_eq!(render(&mut engine), render(&mut expected));
}

#[test]
fn soloing_a_track_plays_it_through_its_bus_without_the_buses_other_tracks() {
    let mut engine = engine_with_notes(&[48, 60, 72]);
    engine.set_bus_count(1);
    engine.set_track_output(0, 0);
    engine.set_track_output(1, 0);
    engine.set_bus_mixer(0, 0.5, 0.0, false, false);
    engine.set_track_mixer(0, 1.0, 0.0, false, true);

    let mut expected = engine_with_notes(&[48, 60, 72]);
    expected.set_track_mixer(0, 0.5, 0.0, false, true);
    assert!(close(&render(&mut engine), &render(&mut expected)));
}

#[test]
fn muting_a_bus_silences_what_feeds_it() {
    let mut engine = two_tracks();
    engine.set_bus_count(1);
    engine.set_track_output(0, 0);
    engine.set_track_output(1, 0);
    engine.set_bus_mixer(0, 1.0, 0.0, true, false);
    assert_eq!(peak(&render(&mut engine)), 0.0);
    assert_eq!(engine.bus_peak(0), 0.0);
}

#[test]
fn playback_through_buses_matches_an_offline_render() {
    let setup = || {
        let mut engine = two_tracks();
        engine.set_bus_count(2);
        engine.set_track_output(0, 1);
        engine.set_track_output(1, 0);
        engine.set_bus_output(1, 0);
        engine.insert_effect(bus_chain(0), 0, "reverb");
        engine.insert_effect(bus_chain(1), 0, "compressor");
        engine
    };
    let offline = render(&mut setup());

    let mut live = setup();
    live.play();
    let mut played = Vec::new();
    while played.len() < offline.len() {
        let block = 256.min(offline.len() - played.len());
        live.render(block);
        played.extend_from_slice(&live.left()[..block]);
    }
    assert_eq!(played, offline);
}

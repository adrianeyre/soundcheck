//! Sends: post-fader copies of a Track's or Bus's signal fed to a Bus,
//! rendered into buffers.

use super::tests::{engine_with_notes, left_of};
use super::*;
use crate::dsp::measure::peak;
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

fn sum(a: &[f32], b: &[f32]) -> Vec<f32> {
    a.iter().zip(b).map(|(x, y)| x + y).collect()
}

/// Track 0 alone, reaching the Master only through a Send at `level`: its
/// output is a Bus with the fader down.
fn through_a_send(volume: f32, pan: f32, level: f64) -> Engine {
    let mut engine = two_tracks();
    engine.set_track_mixer(1, 1.0, 0.0, true, false);
    engine.set_bus_count(2);
    engine.set_bus_mixer(0, 0.0, 0.0, false, false);
    assert!(engine.set_track_output(0, 0));
    engine.set_track_mixer(0, volume, pan, false, false);
    assert!(engine.set_sends(0, &[1.0, level]));
    engine
}

/// Track 0 alone on the Master at `volume` and `pan`.
fn straight(volume: f32, pan: f32) -> Engine {
    let mut engine = two_tracks();
    engine.set_track_mixer(1, 1.0, 0.0, true, false);
    engine.set_track_mixer(0, volume, pan, false, false);
    engine
}

#[test]
fn a_sends_level_scales_what_reaches_the_bus_after_the_fader() {
    for (volume, level) in [(1.0, 1.0), (0.5, 1.0), (1.0, 0.5), (0.5, 0.25), (0.8, 2.0)] {
        let sent = render(&mut through_a_send(volume, 0.0, level));
        let expected = render(&mut straight(volume * level as f32, 0.0));
        assert!(peak(&sent) > 0.001, "the Send is heard");

        assert!(close(&sent, &expected), "fader {volume}, Send {level}");
    }
}

#[test]
fn a_send_follows_the_fader_down_and_the_pan() {
    assert_eq!(peak(&render(&mut through_a_send(0.0, 0.0, 1.0))), 0.0);
    assert_eq!(peak(&render(&mut through_a_send(1.0, 0.0, 0.0))), 0.0);
    // Panned hard right, nothing reaches the Bus's left side.
    assert_eq!(peak(&render(&mut through_a_send(1.0, 1.0, 1.0))), 0.0);
}

#[test]
fn muting_a_track_silences_its_sends() {
    let mut engine = through_a_send(1.0, 0.0, 1.0);
    engine.set_track_mixer(0, 1.0, 0.0, true, false);
    assert_eq!(peak(&render(&mut engine)), 0.0);
    assert_eq!(engine.bus_peak(1), 0.0);
}

#[test]
fn one_reverb_fed_by_two_tracks_adds_to_their_dry_signal() {
    let mut sent = two_tracks();
    sent.set_bus_count(1);
    assert!(sent.insert_effect(bus_chain(0), 0, "reverb"));
    assert!(sent.set_sends(0, &[0.0, 1.0]));
    assert!(sent.set_sends(1, &[0.0, 1.0]));

    // The same Reverb hearing both Tracks as their Output, with nothing dry.
    let mut wet = two_tracks();
    wet.set_bus_count(1);
    wet.insert_effect(bus_chain(0), 0, "reverb");
    wet.set_track_output(0, 0);
    wet.set_track_output(1, 0);

    let dry = render(&mut two_tracks());
    let mixed = render(&mut sent);
    assert!(close(&mixed, &sum(&dry, &render(&mut wet))));
    assert!(!close(&mixed, &dry), "the Reverb is heard");
    assert!(sent.bus_peak(0) > 0.01, "the Bus's meter moves");
}

#[test]
fn a_bus_sends_after_its_own_fader_whichever_bus_comes_first() {
    for (from, to) in [(0usize, 1usize), (1, 0)] {
        let mut engine = two_tracks();
        engine.set_bus_count(3);
        // Both Tracks into `from`, whose own Output is a closed Bus 2, so
        // only its Send to `to` is heard.
        engine.set_track_output(0, from as i32);
        engine.set_track_output(1, from as i32);
        engine.set_bus_mixer(2, 0.0, 0.0, false, false);
        assert!(engine.set_bus_output(from, 2));
        engine.set_bus_mixer(from, 0.5, 0.0, false, false);
        assert!(engine.set_sends(bus_chain(from), &[to as f64, 0.5]));
        let quarter: Vec<f32> = render(&mut two_tracks()).iter().map(|s| s * 0.25).collect();
        assert!(close(&render(&mut engine), &quarter), "{from} -> {to}");
    }
}

#[test]
fn a_send_that_would_loop_is_refused_and_leaves_the_routing_as_it_was() {
    let mut engine = two_tracks();
    engine.set_bus_count(3);
    assert!(engine.set_bus_output(0, 1));
    assert!(engine.set_sends(bus_chain(1), &[2.0, 1.0]));
    assert!(
        !engine.set_sends(bus_chain(2), &[0.0, 1.0]),
        "2 -> 0 -> 1 -> 2 loops"
    );
    assert!(
        !engine.set_sends(bus_chain(0), &[0.0, 1.0]),
        "a Bus can't send to itself"
    );
    assert!(
        !engine.set_bus_output(2, 0),
        "an Output can't close a loop through a Send"
    );
    assert!(!engine.set_sends(bus_chain(0), &[3.0, 1.0]), "no such Bus");
    assert!(!engine.set_sends(bus_chain(3), &[0.0, 1.0]), "no such Bus");
    assert!(
        !engine.set_sends(MASTER, &[0.0, 1.0]),
        "the Master has no Sends"
    );
    assert!(!engine.set_sends(2, &[0.0, 1.0]), "no such Track");
    assert!(!engine.set_sends(0, &[0.0]), "half a Send");

    // Still 0 -> 1 -(Send)-> 2 -> Master, and Bus 1's Output is the
    // Master too, so a Track in Bus 0 is heard twice.
    engine.set_track_output(0, 0);
    engine.set_track_mixer(1, 1.0, 0.0, true, false);
    let twice: Vec<f32> = render(&mut straight(2.0, 0.0));
    assert!(close(&render(&mut engine), &twice));
}

#[test]
fn a_refused_prepared_send_comes_back_to_be_dropped() {
    let mut engine = two_tracks();
    engine.set_bus_count(1);
    let refused = engine.swap_sends(PreparedSends::new(bus_chain(0), &[0.0, 1.0]).unwrap());
    assert!(refused.is_err());
    let old = engine.swap_sends(PreparedSends::new(0, &[0.0, 0.5]).unwrap());
    assert!(old.is_ok_and(|old| old.sends.is_empty()));
}

#[test]
fn removing_a_bus_drops_the_sends_to_it() {
    let mut engine = two_tracks();
    engine.set_bus_count(2);
    engine.set_sends(0, &[1.0, 1.0, 0.0, 1.0]);
    engine.set_sends(bus_chain(0), &[1.0, 1.0]);
    engine.set_bus_count(1);
    assert_eq!(engine.tracks[0].sends(), &[BusSend { bus: 0, level: 1.0 }]);
    assert!(engine.buses[0].sends().is_empty());
    engine.set_bus_count(0);
    assert_eq!(render(&mut engine), render(&mut two_tracks()));
}

#[test]
fn a_send_is_heard_past_a_muted_output() {
    let mut engine = through_a_send(1.0, 0.0, 1.0);
    engine.set_bus_mixer(0, 1.0, 0.0, true, false);
    assert!(close(
        &render(&mut engine),
        &render(&mut straight(1.0, 0.0))
    ));
}

/// Two Tracks on the Master, each sending to Bus 0 with its fader at a half.
fn shared_return() -> Engine {
    let mut engine = two_tracks();
    engine.set_bus_count(1);
    engine.set_bus_mixer(0, 0.5, 0.0, false, false);
    engine.set_sends(0, &[0.0, 1.0]);
    engine.set_sends(1, &[0.0, 1.0]);
    engine
}

#[test]
fn soloing_a_track_keeps_its_sends_but_not_the_other_tracks() {
    let mut engine = shared_return();
    engine.set_track_mixer(0, 1.0, 0.0, false, true);
    // Track 0 dry, and again at a half through the Bus.
    assert!(close(
        &render(&mut engine),
        &render(&mut straight(1.5, 0.0))
    ));
}

#[test]
fn soloing_a_bus_plays_what_sends_to_it() {
    let mut engine = shared_return();
    engine.set_bus_mixer(0, 0.5, 0.0, false, true);
    assert!(close(&render(&mut engine), &render(&mut shared_return())));
}

#[test]
fn audio_analysis_of_a_track_skips_its_sends() {
    let mut engine = through_a_send(1.0, 0.0, 1.0);
    let mut straight = straight(1.0, 0.0);
    assert_eq!(engine.analyse(0.0, BAR, 0), straight.analyse(0.0, BAR, 0));
}

#[test]
fn playback_with_sends_matches_an_offline_render() {
    let setup = || {
        let mut engine = two_tracks();
        engine.set_bus_count(2);
        engine.set_track_output(1, 0);
        engine.set_sends(0, &[1.0, 0.7, 0.0, 0.3]);
        engine.set_sends(bus_chain(0), &[1.0, 0.5]);
        engine.insert_effect(bus_chain(1), 0, "reverb");
        engine.insert_effect(bus_chain(0), 0, "compressor");
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

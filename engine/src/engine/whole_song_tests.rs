//! One song with every v2 ingredient at once: a Tempo Change, a Bus fed by
//! two Sends with a Delay on it, and volume Automation. Each is audible
//! where it should be, and playback plays what export writes.

use super::tempo_change_tests::{exported, first_difference, played};
use super::tests::left_of;
use super::*;
use crate::dsp::measure::peak;
use crate::transport::TICKS_PER_BEAT;

const RATE: usize = 48_000;
const BEAT: f64 = TICKS_PER_BEAT as f64;
const BAR: f64 = BEAT * 4.0;

/// Two bars of 4/4 at 120, then 4/4 at 60 from bar 3: bar 3 starts 4 s in
/// and every bar after it is 4 s long.
const CHANGE: [f64; 4] = [2.0 * BAR, 60.0, 4.0, 4.0];

/// Where bar `bar` (counting from 1) starts, in ticks.
fn bar_tick(bar: u32) -> f64 {
    f64::from(bar - 1) * BAR
}

/// Where bar `bar` starts, in frames, under `CHANGE`.
fn bar_frame(bar: u32) -> usize {
    match bar {
        1..=3 => (bar as usize - 1) * 2 * RATE,
        _ => 4 * RATE + (bar as usize - 3) * 4 * RATE,
    }
}

/// Sync, note, time (ms), feedback, high cut (Hz), ping-pong, mix: one
/// repeat of a synced quarter note and nothing of the dry signal.
const QUARTER_REPEAT: [f32; 7] = [1.0, 7.0, 250.0, 0.0, 20_000.0, 0.0, 1.0];

/// Which parts of the song are on, so a test can hear what each adds.
#[derive(Clone, Copy)]
struct Parts {
    /// Whether the Bus is heard.
    bus: bool,
    /// Which Tracks Send to the Bus.
    sends: [bool; 2],
    /// Whether Track 1's volume is automated down at bar 4.
    automation: bool,
}

const ALL: Parts = Parts {
    bus: true,
    sends: [true, true],
    automation: true,
};

/// The song: Track 0 plays a short note on bars 1 and 3, Track 1 on bars 2
/// and 4, both straight to the Master and each Sending to a Bus whose only
/// Effect is a synced Delay. Track 1's volume holds at unity, then drops to
/// half at bar 4.
fn song(parts: Parts) -> Engine {
    let mut engine = Engine::new(RATE as f32);
    engine.set_tempo_changes(&CHANGE);
    engine.set_track_count(2);
    let note = |bar| [bar_tick(bar), BEAT / 8.0, 60.0, 1.0];
    engine.set_track_notes(0, &[note(1), note(3)].concat());
    engine.set_track_notes(1, &[note(2), note(4)].concat());

    engine.set_bus_count(1);
    assert!(engine.insert_effect(bus_chain(0), 0, "delay"));
    engine.set_effect_settings(bus_chain(0), 0, &QUARTER_REPEAT);
    engine.set_bus_mixer(0, 1.0, 0.0, !parts.bus, false);
    for (track, sends) in parts.sends.iter().enumerate() {
        if *sends {
            assert!(engine.set_sends(track as i32, &[0.0, 1.0]));
        }
    }
    if parts.automation {
        engine.set_automation(1, "volume", &[0.0, 1.0, 1.0, bar_tick(4), 0.5, 1.0]);
    }
    engine
}

/// The left side of an export of bars 1 to 4, and a bar of silence after.
fn render(parts: Parts) -> Vec<f32> {
    left_of(&exported(&mut song(parts), 0.0, bar_tick(5)))
}

/// What the Bus adds to the mix: the render less the same song without it.
fn bus_of(parts: Parts) -> Vec<f32> {
    let dry = render(Parts {
        bus: false,
        ..parts
    });
    render(parts).iter().zip(&dry).map(|(a, b)| a - b).collect()
}

/// The first frame from `from` that is not silent, before `to`.
fn onset(left: &[f32], from: usize, to: usize) -> Option<usize> {
    left[from..to]
        .iter()
        .position(|s| s.abs() > 1e-3)
        .map(|at| from + at)
}

#[test]
fn a_tempo_change_moves_the_notes_onsets() {
    let dry = render(Parts { bus: false, ..ALL });
    for bar in 1..=4 {
        let at = onset(&dry, bar_frame(bar), bar_frame(bar + 1)).expect("the note plays");
        // Bar 4 is 8 s in, not the 6 s it would be at 120 throughout.
        assert!(
            at.abs_diff(bar_frame(bar)) < 100,
            "bar {bar}'s note at {at}"
        );
    }
}

#[test]
fn the_bus_carries_both_sends_repeated_at_the_tempo_in_force() {
    let dry = render(Parts { bus: false, ..ALL });
    let wet = bus_of(ALL);
    let only_track_0 = bus_of(Parts {
        sends: [true, false],
        ..ALL
    });
    let only_track_1 = bus_of(Parts {
        sends: [false, true],
        ..ALL
    });
    for bar in 1..=4 {
        let (from, to) = (bar_frame(bar), bar_frame(bar + 1));
        let note = onset(&dry, from, to).expect("the note plays");
        // A quarter note is half a second at 120 and a second at 60.
        let quarter = if bar < 3 { RATE / 2 } else { RATE };
        assert_eq!(onset(&wet, from, to), Some(note + quarter), "bar {bar}");

        // Track 0 plays bars 1 and 3, Track 1 bars 2 and 4: the Bus holds
        // each one's repeats only while it Sends.
        let (sending, silent) = if bar % 2 == 1 {
            (&only_track_0, &only_track_1)
        } else {
            (&only_track_1, &only_track_0)
        };
        assert_eq!(onset(sending, from, to), Some(note + quarter), "bar {bar}");
        assert_eq!(peak(&silent[from..to]), 0.0, "bar {bar}");
    }
}

#[test]
fn volume_automation_halves_the_track_and_its_send_from_bar_4() {
    let automated = render(ALL);
    let fixed = render(Parts {
        automation: false,
        ..ALL
    });
    // Before bar 4 the held breakpoint leaves every sample as it was.
    let bar_4 = bar_frame(4);
    assert_eq!(first_difference(&automated[..bar_4], &fixed[..bar_4]), None);
    // From bar 4, Track 1's note and its repeat are half as loud.
    let (note, repeat) = (bar_4..bar_4 + RATE, bar_4 + RATE..bar_frame(5));
    for range in [note, repeat] {
        let (level, was) = (peak(&automated[range.clone()]), peak(&fixed[range]));
        assert!(was > 0.01, "heard without the Automation");
        assert!((level / was - 0.5).abs() < 1e-3, "{level} against {was}");
    }
}

#[test]
fn playback_of_the_song_matches_its_export() {
    let export = exported(&mut song(ALL), 0.0, bar_tick(5));
    assert_eq!(export.len(), 2 * bar_frame(5));
    for block in [128, 441, 1_024] {
        let playback = played(&mut song(ALL), 0.0, export.len() / 2, block);
        assert_eq!(
            first_difference(&playback, &export),
            None,
            "played in blocks of {block}"
        );
    }
}

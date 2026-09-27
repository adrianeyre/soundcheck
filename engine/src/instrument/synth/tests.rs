//! The Synth, measured on offline renders: there is no audio device here.

use super::*;
use crate::dsp::measure::{max_jump, peak, rising_zero_crossings, rms};
use crate::dsp::{FilterKind, Waveform};
use params::LfoTarget;

const RATE: f32 = 48_000.0;

fn render(synth: &mut Synth, frames: usize) -> Vec<f32> {
    let mut buffer = vec![0.0; frames];
    synth.render(&mut buffer);
    buffer
}

/// A sine-only Synth with the filter out of the way: what comes out is the
/// envelope times the pitch, which is what most of these tests measure.
/// Tests take what they need from it: `SynthSettings { attack: 1.0, ..plain() }`.
fn plain() -> SynthSettings {
    SynthSettings {
        osc1_wave: Waveform::Sine,
        osc2_wave: Waveform::Sine,
        cutoff_hz: 20_000.0,
        ..SynthSettings::default()
    }
}

/// A steady sine: the envelope out of the way too, so only the level the
/// test is after moves.
fn steady() -> SynthSettings {
    SynthSettings {
        attack: 0.001,
        decay: 0.001,
        sustain: 1.0,
        ..plain()
    }
}

#[test]
fn silent_until_a_note_plays() {
    let mut synth = Synth::new(RATE, SynthSettings::default());
    assert_eq!(peak(&render(&mut synth, 1_024)), 0.0);
}

#[test]
fn every_note_plays_at_its_own_frequency() {
    // A sine crosses zero upwards exactly once per cycle, so counting the
    // crossings in a second counts the frequency.
    for (note, frequency) in [(36, 65.41), (60, 261.63), (69, 440.0), (93, 1_760.0)] {
        let mut synth = Synth::new(RATE, plain());
        synth.note_on(note, 1.0);
        let buffer = render(&mut synth, RATE as usize);
        let counted = rising_zero_crossings(&buffer) as f32;
        // Within a cent: 0.06% of the frequency, plus the crossing the
        // render's edge can cut off.
        let tolerance = frequency * 0.000_6 + 1.0;
        assert!(
            (counted - frequency).abs() <= tolerance,
            "note {note}: counted {counted} Hz, wanted {frequency} Hz"
        );
    }
}

#[test]
fn the_second_oscillator_is_detuned_from_the_first() {
    // Only the second oscillator, an octave up: twice the crossings.
    let settings = SynthSettings {
        osc_mix: 1.0,
        osc2_detune: 1_200.0,
        ..plain()
    };
    let mut synth = Synth::new(RATE, settings);
    synth.note_on(69, 1.0);
    let counted = rising_zero_crossings(&render(&mut synth, RATE as usize));
    assert!((879..=881).contains(&counted), "{counted} crossings");

    // A few cents apart, the two beat against each other: the level rises
    // and falls at the difference between them.
    let settings = SynthSettings {
        osc_mix: 0.5,
        osc2_detune: 20.0, // 440 Hz vs 445.1 Hz: about 5 beats a second
        ..steady()
    };
    let mut synth = Synth::new(RATE, settings);
    synth.note_on(69, 1.0);
    let buffer = render(&mut synth, RATE as usize);
    // 10 ms windows: several cycles of the note, a twentieth of a beat.
    let levels = envelope(&buffer, 480);
    let loudest = levels.iter().fold(0.0_f32, |max, level| max.max(*level));
    let quietest = levels.iter().fold(1.0_f32, |min, level| min.min(*level));
    assert!(
        quietest < 0.3 * loudest,
        "{quietest} to {loudest}: no beating"
    );
}

#[test]
fn the_filter_cuts_what_is_past_its_cutoff() {
    // A sine at 440 Hz through a low-pass, with the cutoff moved around it:
    // two poles, so an octave above the cutoff is about a quarter the level.
    let level_at = |cutoff_hz| {
        let settings = SynthSettings {
            cutoff_hz,
            resonance: 0.707,
            ..steady()
        };
        let mut synth = Synth::new(RATE, settings);
        synth.note_on(69, 1.0);
        rms(&render(&mut synth, 24_000)[12_000..])
    };
    let open = level_at(7_040.0);
    assert!(
        (level_at(1_760.0) / open - 1.0).abs() < 0.1,
        "two octaves below the cutoff"
    );
    assert!(
        (level_at(220.0) / open - 0.25).abs() < 0.06,
        "an octave above it"
    );
    assert!(
        (level_at(110.0) / open - 0.0625).abs() < 0.03,
        "two octaves above it"
    );

    // A high-pass does the opposite, and a band-pass keeps its own band.
    let kind_level = |filter_kind, cutoff_hz| {
        let settings = SynthSettings {
            filter_kind,
            cutoff_hz,
            resonance: 0.707,
            ..steady()
        };
        let mut synth = Synth::new(RATE, settings);
        synth.note_on(69, 1.0);
        rms(&render(&mut synth, 24_000)[12_000..])
    };
    assert!(kind_level(FilterKind::High, 110.0) > 0.9 * open);
    assert!(kind_level(FilterKind::High, 1_760.0) < 0.3 * open);
    assert!(kind_level(FilterKind::Band, 440.0) > 0.9 * open);
    assert!(kind_level(FilterKind::Band, 7_040.0) < 0.3 * open);
}

#[test]
fn the_filter_envelope_opens_the_filter_and_closes_it_again() {
    // A saw held under a closed filter, with the envelope sweeping four
    // octaves: the sound is at its brightest at the end of the attack and
    // dulls away over the decay.
    let settings = SynthSettings {
        osc1_wave: Waveform::Saw,
        osc_mix: 0.0,
        cutoff_hz: 300.0,
        resonance: 0.707,
        filter_env_amount: 4.0,
        filter_attack: 0.05,
        filter_decay: 0.5,
        filter_sustain: 0.0,
        attack: 0.001,
        decay: 0.001,
        sustain: 1.0,
        ..SynthSettings::default()
    };
    let mut synth = Synth::new(RATE, settings);
    synth.note_on(45, 1.0);
    let buffer = render(&mut synth, 48_000);

    // How bright a stretch is: how fast it moves compared with how loud it
    // is. A dull sound moves slowly between samples.
    let brightness = |window: &[f32]| {
        let steps: Vec<f32> = window.windows(2).map(|p| p[1] - p[0]).collect();
        rms(&steps) / rms(window).max(1e-9)
    };
    let open = brightness(&buffer[2_400..4_800]);
    let closing = brightness(&buffer[14_400..16_800]);
    let closed = brightness(&buffer[36_000..38_400]);
    assert!(open > 1.5 * closing, "{open} then {closing}");
    assert!(closing > 1.25 * closed, "{closing} then {closed}");
}

/// The level of each `window` samples: the envelope, sampled. A window of a
/// few cycles of the note is enough for its peak to be the level there.
fn envelope(buffer: &[f32], window: usize) -> Vec<f32> {
    buffer.chunks(window).map(peak).collect()
}

#[test]
fn the_amplitude_envelope_keeps_its_times() {
    let settings = SynthSettings {
        attack: 0.1,
        decay: 0.2,
        sustain: 0.5,
        release: 0.3,
        ..plain()
    };
    let mut synth = Synth::new(RATE, settings);
    synth.note_on(69, 1.0);
    let held = render(&mut synth, 48_000);

    // 10 ms windows: four cycles of 440 Hz, and a fortieth of the attack.
    const WINDOW: usize = 480;
    let seconds = |windows: usize| windows as f32 * WINDOW as f32 / RATE;
    let levels = envelope(&held, WINDOW);
    let full = levels.iter().fold(0.0_f32, |max, l| max.max(*l));

    let peaked = levels.iter().position(|l| *l >= 0.99 * full).unwrap();
    assert!(
        (seconds(peaked) - 0.1).abs() < 0.015,
        "attack: {}s",
        seconds(peaked)
    );

    let sustained = levels[peaked..]
        .iter()
        .position(|l| *l <= 0.51 * full)
        .unwrap()
        + peaked;
    assert!(
        (seconds(sustained) - 0.3).abs() < 0.015,
        "decay: {}s",
        seconds(sustained)
    );
    assert!(
        (levels[60] / full - 0.5).abs() < 0.02,
        "the sustain at 0.6 s"
    );
    assert!(
        (levels[95] / full - 0.5).abs() < 0.02,
        "still the sustain at 0.95 s"
    );

    synth.note_off(69);
    let released = render(&mut synth, 48_000);
    let levels = envelope(&released, WINDOW);
    assert!(
        (levels[15] / full - 0.25).abs() < 0.03,
        "halfway through the release"
    );
    let silent = levels.iter().position(|l| *l == 0.0).unwrap();
    assert!(
        (seconds(silent) - 0.3).abs() < 0.015,
        "release: {}s",
        seconds(silent)
    );
    assert_eq!(synth.active_voices(), 0);
}

#[test]
fn plays_several_notes_at_once_and_releases_them() {
    let mut synth = Synth::new(RATE, SynthSettings::default());
    for note in [60, 64, 67] {
        synth.note_on(note, 0.8);
    }
    assert_eq!(synth.active_voices(), 3);
    assert!(peak(&render(&mut synth, 4_800)) > 0.1);

    for note in [60, 64, 67] {
        synth.note_off(note);
    }
    render(&mut synth, 48_000);
    assert_eq!(synth.active_voices(), 0);
    assert_eq!(peak(&render(&mut synth, 1_024)), 0.0);
}

#[test]
fn only_as_many_voices_play_as_the_settings_allow() {
    let settings = SynthSettings {
        voices: 4,
        ..SynthSettings::default()
    };
    let mut synth = Synth::new(RATE, settings);
    for note in 60..70 {
        synth.note_on(note, 1.0);
    }
    assert_eq!(synth.active_voices(), 4);

    // One voice: each note takes over from the last, monophonically.
    let mut synth = Synth::new(
        RATE,
        SynthSettings {
            voices: 1,
            ..SynthSettings::default()
        },
    );
    synth.note_on(60, 1.0);
    synth.note_on(64, 1.0);
    assert_eq!(synth.active_voices(), 1);
}

#[test]
fn steals_a_released_voice_before_a_held_one() {
    let mut synth = Synth::new(RATE, SynthSettings::default());
    for note in 60..68 {
        synth.note_on(note, 1.0);
    }
    // 60 is the oldest, but 63 has been let go, so 63's voice is taken.
    synth.note_off(63);
    synth.note_on(72, 1.0);
    assert_eq!(synth.active_voices(), 8);
    assert!(
        synth
            .voices
            .iter()
            .any(|v| v.note == 60 && v.amp.is_active())
    );
    assert!(!synth.voices.iter().any(|v| v.note == 63));

    // With every voice held, the oldest goes.
    synth.note_on(74, 1.0);
    assert!(!synth.voices.iter().any(|v| v.note == 60));
}

#[test]
fn glide_slides_from_the_note_before() {
    let settings = SynthSettings {
        glide: 0.2,
        voices: 1,
        ..steady()
    };
    let mut synth = Synth::new(RATE, settings);
    synth.note_on(57, 1.0); // 220 Hz
    render(&mut synth, 24_000);
    synth.note_on(69, 1.0); // 440 Hz, an octave up over 0.2 s

    render(&mut synth, 4_800); // the first tenth of the glide
    let sliding = render(&mut synth, 4_800); // 311 Hz to 440 Hz across it
    let arrived = render(&mut synth, 24_000);
    let sliding = rising_zero_crossings(&sliding) as f32 * 10.0;
    let arrived = rising_zero_crossings(&arrived) as f32 * 2.0;
    assert!(
        (350.0..395.0).contains(&sliding),
        "{sliding} Hz on average through the second half of the glide"
    );
    assert!((438.0..442.0).contains(&arrived), "{arrived} Hz at the end");
}

#[test]
fn the_lfo_moves_whatever_it_is_pointed_at() {
    let with_lfo = |lfo_target| {
        let settings = SynthSettings {
            lfo_target,
            lfo_rate_hz: 4.0,
            lfo_depth: 1.0,
            cutoff_hz: 600.0,
            resonance: 0.707,
            ..steady()
        };
        let mut synth = Synth::new(RATE, settings);
        synth.note_on(69, 1.0);
        render(&mut synth, 48_000)
    };

    // Off: a steady tone, the same level all the way through.
    let steady = with_lfo(LfoTarget::Off);
    let level = |b: &[f32], n: usize| rms(&b[n * 4_800..(n + 1) * 4_800]);
    assert!((level(&steady, 2) - level(&steady, 6)).abs() < 0.01);

    // Pitch: the frequency swings either side of the note. At 4 Hz the LFO
    // is at the top of its rise 3,000 samples in and the bottom at 9,000.
    let bent = with_lfo(LfoTarget::Pitch);
    let up = rising_zero_crossings(&bent[1_500..4_500]) * 16;
    let down = rising_zero_crossings(&bent[7_500..10_500]) * 16;
    assert!(up > 465, "{up} Hz at the top of the bend");
    assert!(down < 415, "{down} Hz at the bottom");

    // Filter: with the cutoff swinging four octaves, the level swings too.
    let swept = with_lfo(LfoTarget::Filter);
    let loudest = (0..10).map(|n| level(&swept, n)).fold(0.0_f32, f32::max);
    let quietest = (0..10).map(|n| level(&swept, n)).fold(1.0_f32, f32::min);
    assert!(
        quietest < 0.6 * loudest,
        "{quietest} to {loudest}: no sweep"
    );

    // Amp: full depth takes the level to silence and back.
    let wobbling = with_lfo(LfoTarget::Amp);
    let loudest = (0..10).map(|n| level(&wobbling, n)).fold(0.0_f32, f32::max);
    let quietest = (0..10).map(|n| level(&wobbling, n)).fold(1.0_f32, f32::min);
    assert!(
        quietest < 0.3 * loudest,
        "{quietest} to {loudest}: no tremolo"
    );
}

#[test]
fn velocity_scales_the_level() {
    let mut loud = Synth::new(RATE, SynthSettings::default());
    let mut quiet = Synth::new(RATE, SynthSettings::default());
    loud.note_on(60, 1.0);
    quiet.note_on(60, 0.5);
    let ratio = peak(&render(&mut quiet, 4_800)) / peak(&render(&mut loud, 4_800));
    assert!((ratio - 0.5).abs() < 0.01, "ratio {ratio}");
}

#[test]
fn settings_can_change_while_a_note_sounds_without_a_jump() {
    let mut synth = Synth::new(RATE, SynthSettings::default());
    synth.note_on(60, 1.0);
    let before = render(&mut synth, 4_800);
    synth.set_settings(SynthSettings {
        osc1_wave: Waveform::Square,
        cutoff_hz: 600.0,
        sustain: 0.2,
        ..SynthSettings::default()
    });
    let after = render(&mut synth, 4_800);
    assert_eq!(synth.active_voices(), 1, "the note carries on");
    // The joint between the two renders is no worse a step than the sound
    // itself makes.
    let joint = (after[0] - before[before.len() - 1]).abs();
    assert!(joint <= max_jump(&before).max(max_jump(&after)), "{joint}");
    assert_eq!(synth.settings().cutoff_hz, 600.0);
}

/// How big the step from one sample to the next is around `boundary`,
/// against the biggest step the sound itself makes anywhere else. A click is
/// a step that does not belong to the waveform, so anything up to 1.0 is the
/// sound and anything above it is a click.
fn jump_around(buffer: &[f32], boundaries: [usize; 2], which: usize) -> f32 {
    const NEAR: usize = 64;
    let near = |at: usize| {
        let from = at.saturating_sub(NEAR);
        max_jump(&buffer[from..(at + NEAR).min(buffer.len())])
    };
    // Everything more than four blocks away from either boundary.
    let clear = |at: usize| boundaries.iter().all(|b| at.abs_diff(*b) > 4 * NEAR);
    let elsewhere = (0..buffer.len() - 1)
        .filter(|n| clear(*n))
        .fold(0.0_f32, |max, n| max.max((buffer[n + 1] - buffer[n]).abs()));
    near(boundaries[which]) / elsewhere.max(1e-9)
}

#[test]
fn notes_start_and_stop_without_a_click() {
    for preset in factory_presets() {
        let mut synth = Synth::new(RATE, preset.settings);
        // Half a second of silence, then the note, held for two seconds,
        // then three more seconds to fade out in.
        let mut buffer = render(&mut synth, 24_000);
        let note_on = buffer.len();
        synth.note_on(60, 1.0);
        buffer.extend(render(&mut synth, 96_000));
        let note_off = buffer.len();
        synth.note_off(60);
        buffer.extend(render(&mut synth, 144_000));
        assert!(peak(&buffer) > 0.05, "{}: no sound", preset.name);

        let boundaries = [note_on, note_off];
        let start = jump_around(&buffer, boundaries, 0);
        let stop = jump_around(&buffer, boundaries, 1);
        assert!(
            start <= 1.0,
            "{}: {start}x the sound's own step at the note's start",
            preset.name
        );
        assert!(
            stop <= 1.0,
            "{}: {stop}x the sound's own step at the note's end",
            preset.name
        );
        assert_eq!(
            peak(&buffer[buffer.len() - 4_800..]),
            0.0,
            "{}: never stops",
            preset.name
        );
    }
}

#[test]
fn stealing_a_voice_does_not_click() {
    // One voice, so the second note takes the first one over.
    let settings = SynthSettings {
        voices: 1,
        attack: 0.05,
        release: 0.5,
        ..SynthSettings::default()
    };
    let mut synth = Synth::new(RATE, settings);
    synth.note_on(48, 1.0);
    let mut buffer = render(&mut synth, 24_000);
    let stolen = buffer.len();
    synth.note_on(72, 1.0); // takes the voice, two octaves up
    buffer.extend(render(&mut synth, 24_000));

    let jump = jump_around(&buffer, [stolen, stolen], 0);
    assert!(
        jump <= 1.0,
        "{jump}x the sound's own step where the voice was taken"
    );
}

#[test]
fn every_preset_loads_plays_and_stops() {
    for preset in factory_presets() {
        let mut synth = Synth::new(RATE, preset.settings);
        assert_eq!(synth.settings(), preset.settings, "{}", preset.name);

        // Long enough for the slowest pad to swell.
        synth.note_on(60, 1.0);
        let held = render(&mut synth, 4 * RATE as usize);
        let level = peak(&held);
        assert!(level > 0.05, "{}: only reached {level}", preset.name);
        assert!(
            level <= 1.0,
            "{}: {level} would clip on its own",
            preset.name
        );

        synth.note_off(60);
        render(&mut synth, 6 * RATE as usize);
        assert_eq!(synth.active_voices(), 0, "{} never stops", preset.name);
    }
}

#[test]
fn the_presets_are_balanced_against_each_other() {
    // One preset must not be far louder than the next, and a chord of any of
    // them must stay in the range the mixer expects.
    for preset in factory_presets() {
        let mut synth = Synth::new(RATE, preset.settings);
        synth.note_on(60, 1.0);
        let one = peak(&render(&mut synth, 4 * RATE as usize));
        assert!(
            (0.06..=0.3).contains(&one),
            "{}: one note peaks at {one}",
            preset.name
        );

        let mut synth = Synth::new(RATE, preset.settings);
        for note in [48, 55, 60, 64, 67, 72] {
            synth.note_on(note, 1.0);
        }
        let chord = peak(&render(&mut synth, 4 * RATE as usize));
        assert!(
            chord < 6.0 * one,
            "{}: a chord peaks at {chord}",
            preset.name
        );
    }
}

//! The Transient Shaper Effect: more or less punch, and more or less tail,
//! without a threshold to set.
//!
//! Followers track the level of the louder side, held over the last few
//! cycles so a steady tone reads as steady. A fast one catches each hit
//! as it lands while a slow one lags behind it: where the fast one is ahead
//! the sound is starting, and Attack turns that part up (above 0%) or down
//! (below). A slow-releasing follower outlasts a fast-releasing one as a
//! sound rings out, and Sustain turns that part up or down. It follows the
//! shape of the sound, not its level, so a quiet hit is shaped like a loud
//! one. Output sets the level after, and Mix blends it with the dry signal.

use super::params::{Param, Settings, number, time_coefficient};
use super::stereo::StereoEffect;
use crate::dsp::{db_to_gain, flush_denormal, gain_to_db};

/// How long each window the level is held over is: longer than a cycle of
/// the lowest note a kick plays, so the level is steady on a steady tone.
const WINDOW_MS: f32 = 20.0;
/// How fast the follower that catches a hit rises.
const FAST_ATTACK_MS: f32 = 0.5;
/// How far the follower that lags behind a hit takes to rise.
const SLOW_ATTACK_MS: f32 = 25.0;
/// How fast both attack followers fall.
const ATTACK_RELEASE_MS: f32 = 80.0;
/// How fast the follower that hears a sound end lets go.
const FAST_RELEASE_MS: f32 = 30.0;
/// How long the follower that hears the tail holds on.
const SLOW_RELEASE_MS: f32 = 300.0;
/// Quieter than this is treated as silence, so a tail fading out isn't
/// boosted without end.
const FLOOR_DB: f32 = -80.0;
/// The most the gain moves either way, in dB.
const MOST_DB: f32 = 24.0;
/// How long a changed setting takes to settle, so it doesn't click.
const SMOOTHING_MS: f32 = 10.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TransientShaperSettings {
    /// -100% to 100%: how far the start of each hit is turned down or up.
    pub attack: f32,
    /// -100% to 100%: how far each sound's tail is turned down or up.
    pub sustain: f32,
    pub output_db: f32,
    pub mix: f32,
}

impl Default for TransientShaperSettings {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Every setting of the Transient Shaper, in the order a host sends them.
#[rustfmt::skip]
pub const TRANSIENT_PARAMS: &[Param<TransientShaperSettings>] = &[
    number("attack", "Attack", "%", (-100.0, 100.0, 0.0),
        |s| s.attack, |s, v| s.attack = v),
    number("sustain", "Sustain", "%", (-100.0, 100.0, 0.0),
        |s| s.sustain, |s, v| s.sustain = v),
    number("outputDb", "Output", "dB", (-24.0, 24.0, 0.0),
        |s| s.output_db, |s, v| s.output_db = v),
    number("mix", "Mix", "", (0.0, 1.0, 1.0),
        |s| s.mix, |s, v| s.mix = v),
];

impl Settings for TransientShaperSettings {
    const PARAMS: &'static [Param<Self>] = TRANSIENT_PARAMS;

    fn zeroed() -> Self {
        Self {
            attack: 0.0,
            sustain: 0.0,
            output_db: 0.0,
            mix: 0.0,
        }
    }
}

/// A level follower that rises with one time constant and falls with
/// another.
#[derive(Clone, Copy, Debug, Default)]
struct Follower {
    rise: f32,
    fall: f32,
    level: f32,
}

impl Follower {
    fn new(sample_rate: f32, rise_ms: f32, fall_ms: f32) -> Self {
        Self {
            rise: time_coefficient(rise_ms, sample_rate),
            fall: time_coefficient(fall_ms, sample_rate),
            level: 0.0,
        }
    }

    /// Follow `level` one sample, and the level in dB, no quieter than the
    /// floor.
    fn next_db(&mut self, level: f32) -> f32 {
        let coefficient = if level > self.level {
            self.rise
        } else {
            self.fall
        };
        self.level = flush_denormal(level + coefficient * (self.level - level));
        gain_to_db(self.level).max(FLOOR_DB)
    }
}

#[derive(Clone, Debug)]
pub struct TransientShaper {
    settings: TransientShaperSettings,
    /// The level is the loudest sample over this window and the one before,
    /// so it rises at once and doesn't ripple with each cycle of a tone.
    window: usize,
    window_at: usize,
    window_peak: f32,
    last_window_peak: f32,
    attack_fast: Follower,
    attack_slow: Follower,
    sustain_fast: Follower,
    sustain_slow: Follower,
    smoothing: f32,
    /// Attack and Sustain as fractions, the output gain and the mix, each
    /// easing towards its setting.
    current: [f32; 4],
}

impl TransientShaper {
    pub fn new(sample_rate: f32, settings: TransientShaperSettings) -> Self {
        Self {
            settings,
            window: ((WINDOW_MS / 1_000.0 * sample_rate) as usize).max(1),
            window_at: 0,
            window_peak: 0.0,
            last_window_peak: 0.0,
            attack_fast: Follower::new(sample_rate, FAST_ATTACK_MS, ATTACK_RELEASE_MS),
            attack_slow: Follower::new(sample_rate, SLOW_ATTACK_MS, ATTACK_RELEASE_MS),
            sustain_fast: Follower::new(sample_rate, FAST_ATTACK_MS, FAST_RELEASE_MS),
            sustain_slow: Follower::new(sample_rate, FAST_ATTACK_MS, SLOW_RELEASE_MS),
            smoothing: time_coefficient(SMOOTHING_MS, sample_rate),
            current: Self::targets(settings),
        }
    }

    fn targets(settings: TransientShaperSettings) -> [f32; 4] {
        [
            settings.attack / 100.0,
            settings.sustain / 100.0,
            db_to_gain(settings.output_db),
            settings.mix,
        ]
    }
}

impl StereoEffect for TransientShaper {
    type Settings = TransientShaperSettings;

    fn settings(&self) -> TransientShaperSettings {
        self.settings
    }

    fn set_settings(&mut self, settings: TransientShaperSettings) {
        self.settings = settings;
    }

    fn settle(&mut self) {
        self.current = Self::targets(self.settings);
    }

    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let targets = Self::targets(self.settings);
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            for (current, target) in self.current.iter_mut().zip(targets) {
                *current = target + self.smoothing * (*current - target);
            }
            let [attack, sustain, output, mix] = self.current;
            self.window_peak = self.window_peak.max(l.abs().max(r.abs()));
            let level = self.window_peak.max(self.last_window_peak);
            self.window_at += 1;
            if self.window_at == self.window {
                self.last_window_peak = self.window_peak;
                self.window_peak = 0.0;
                self.window_at = 0;
            }
            let start_db = self.attack_fast.next_db(level) - self.attack_slow.next_db(level);
            let tail_db = self.sustain_slow.next_db(level) - self.sustain_fast.next_db(level);
            let gain_db =
                attack * start_db.clamp(0.0, MOST_DB) + sustain * tail_db.clamp(0.0, MOST_DB);
            let gain = db_to_gain(gain_db.clamp(-MOST_DB, MOST_DB)) * output;
            *l = *l * (1.0 - mix) + *l * gain * mix;
            *r = *r * (1.0 - mix) + *r * gain * mix;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, rms, sine};

    const RATE: f32 = 48_000.0;

    /// Four hits: a 200 Hz tone that starts at once and dies away over about
    /// 100 ms, after a gap of silence.
    fn hits() -> Vec<f32> {
        let tone = sine(200.0, 0.5, RATE, 12_000);
        (0..4)
            .flat_map(|_| {
                let hit: Vec<f32> = tone
                    .iter()
                    .enumerate()
                    .map(|(n, s)| s * (-(n as f32) / (0.1 * RATE)).exp())
                    .collect();
                std::iter::repeat_n(0.0, 2_400).chain(hit)
            })
            .collect()
    }

    fn run(settings: TransientShaperSettings, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut shaper = TransientShaper::new(RATE, settings);
        let mut left = input.to_vec();
        let mut right = input.to_vec();
        for (l, r) in left.chunks_mut(chunk).zip(right.chunks_mut(chunk)) {
            shaper.process_stereo(l, r);
        }
        left
    }

    /// The last hit's first 5 ms, and 100 to 250 ms into it.
    fn start_and_tail(output: &[f32]) -> (f32, f32) {
        let onset = 3 * 14_400 + 2_400;
        (
            peak(&output[onset..onset + 240]),
            rms(&output[onset + 4_800..onset + 12_000]),
        )
    }

    #[test]
    fn at_zero_it_leaves_the_signal_as_it_is() {
        let input = hits();
        assert_eq!(run(TransientShaperSettings::default(), &input, 64), input);
        let no_mix = TransientShaperSettings {
            attack: 100.0,
            sustain: -100.0,
            output_db: 12.0,
            mix: 0.0,
        };
        assert_eq!(run(no_mix, &input, 64), input);
    }

    #[test]
    fn attack_turns_the_start_of_each_hit_up_or_down() {
        let input = hits();
        let (dry_start, dry_tail) = start_and_tail(&input);
        let punchy = TransientShaperSettings {
            attack: 100.0,
            ..TransientShaperSettings::default()
        };
        let (start, tail) = start_and_tail(&run(punchy, &input, 64));
        assert!(start > dry_start * 1.5, "{start} against {dry_start}");
        assert!(
            (tail / dry_tail - 1.0).abs() < 0.1,
            "the tail stays: {tail} against {dry_tail}"
        );

        let soft = TransientShaperSettings {
            attack: -100.0,
            ..punchy
        };
        let (start, _) = start_and_tail(&run(soft, &input, 64));
        assert!(start < dry_start * 0.7, "{start} against {dry_start}");
    }

    #[test]
    fn a_steady_tone_is_left_at_its_level() {
        let input = sine(200.0, 0.5, RATE, 48_000);
        let shaped = TransientShaperSettings {
            attack: 100.0,
            sustain: 100.0,
            ..TransientShaperSettings::default()
        };
        let output = run(shaped, &input, 64);
        let ratio = rms(&output[24_000..]) / rms(&input[24_000..]);
        assert!((ratio - 1.0).abs() < 0.01, "{ratio}");
    }

    #[test]
    fn sustain_turns_the_tail_up_or_down() {
        let input = hits();
        let (_, dry_tail) = start_and_tail(&input);
        let long = TransientShaperSettings {
            sustain: 100.0,
            ..TransientShaperSettings::default()
        };
        let (_, tail) = start_and_tail(&run(long, &input, 64));
        assert!(tail > dry_tail * 1.5, "{tail} against {dry_tail}");
        let short = TransientShaperSettings {
            sustain: -100.0,
            ..long
        };
        let (_, tail) = start_and_tail(&run(short, &input, 64));
        assert!(tail < dry_tail * 0.7, "{tail} against {dry_tail}");
    }

    #[test]
    fn it_is_finite_at_the_extremes_and_the_same_in_any_size_of_block() {
        let mut input = hits();
        input[5_000] = 1.0e6;
        let extreme = TransientShaperSettings {
            attack: 100.0,
            sustain: 100.0,
            output_db: 24.0,
            mix: 1.0,
        };
        let whole = run(extreme, &input, input.len());
        assert!(whole.iter().all(|s| s.is_finite()));
        assert_eq!(run(extreme, &input, 1), whole);
        assert_eq!(run(extreme, &input, 97), whole);
    }

    #[test]
    fn a_changed_setting_eases_in() {
        let input = vec![0.25; 4_800];
        let mut shaper = TransientShaper::new(RATE, TransientShaperSettings::default());
        let (mut left, mut right) = (input.clone(), input.clone());
        shaper.process_stereo(&mut left[..2_400], &mut right[..2_400]);
        shaper.set_settings(TransientShaperSettings {
            output_db: 24.0,
            ..TransientShaperSettings::default()
        });
        shaper.process_stereo(&mut left[2_400..], &mut right[2_400..]);
        let step = left[2_400] / 0.25;
        assert!(step < 1.5, "the gain jumped to {step}");
        let settled = left[4_799] / 0.25;
        assert!((settled - db_to_gain(24.0)).abs() < 0.2, "{settled}");
    }
}

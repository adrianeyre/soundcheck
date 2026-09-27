//! The Synth's settings, declared up front.
//!
//! One table describes every setting: the name it is known by, a label and
//! unit to draw it with, its range, its default, and the choices it offers
//! if it picks from a list. The table is the only place a setting is
//! defined — defaults, clamping, the flat form a host sends and the JSON the
//! UI and the **Assistant** read all come from it, so they cannot drift
//! apart.
//!
//! Times are in seconds, frequencies in Hz, and detune in cents.

use std::fmt::Write;

use crate::dsp::{FilterKind, Waveform};

/// One setting: what it is called, what it may be, and what it is by default.
pub struct Param {
    /// The name the UI, the **Assistant** and the Project all use.
    pub name: &'static str,
    pub label: &'static str,
    /// A unit to show after the value, or "" when it has none.
    pub unit: &'static str,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    /// The gap between values a control should offer, or 0 for continuous.
    pub step: f32,
    /// The names of the choices, lowest value first, or empty for a number.
    pub choices: &'static [&'static str],
    get: fn(&SynthSettings) -> f32,
    set: fn(&mut SynthSettings, f32),
}

impl Param {
    /// This setting's value in `settings`.
    pub fn get(&self, settings: &SynthSettings) -> f32 {
        (self.get)(settings)
    }

    /// Set this setting, clamped to its range and rounded to its step.
    pub fn set(&self, settings: &mut SynthSettings, value: f32) {
        let value = if value.is_finite() {
            value
        } else {
            self.default
        };
        let value = value.clamp(self.min, self.max);
        let value = if self.step > 0.0 {
            (value / self.step).round() * self.step
        } else {
            value
        };
        (self.set)(settings, value);
    }
}

const fn number(
    name: &'static str,
    label: &'static str,
    unit: &'static str,
    (min, max, default): (f32, f32, f32),
    step: f32,
    get: fn(&SynthSettings) -> f32,
    set: fn(&mut SynthSettings, f32),
) -> Param {
    Param {
        name,
        label,
        unit,
        min,
        max,
        default,
        step,
        choices: &[],
        get,
        set,
    }
}

const fn choice(
    name: &'static str,
    label: &'static str,
    choices: &'static [&'static str],
    default: f32,
    get: fn(&SynthSettings) -> f32,
    set: fn(&mut SynthSettings, f32),
) -> Param {
    Param {
        name,
        label,
        unit: "",
        min: 0.0,
        max: (choices.len() - 1) as f32,
        default,
        step: 1.0,
        choices,
        get,
        set,
    }
}

/// The shortest attack, decay and release the Synth allows. A stage that
/// took no time at all would step the level, and a step is a click.
pub const MIN_STAGE: f32 = 0.001;
/// The longest any envelope stage can take.
pub const MAX_STAGE: f32 = 10.0;
/// How many voices a Synth has room for, whatever `voices` asks for.
pub const MAX_VOICES: usize = 16;

const STAGE: (f32, f32, f32) = (MIN_STAGE, MAX_STAGE, 0.2);

/// Every setting of the Synth, in the order a host sends them.
#[rustfmt::skip]
pub const PARAMS: &[Param] = &[
    choice("osc1Wave", "Oscillator 1 wave", &Waveform::NAMES, 0.0,
        |s| s.osc1_wave.index() as f32, |s, v| s.osc1_wave = Waveform::from_index(v as usize)),
    choice("osc2Wave", "Oscillator 2 wave", &Waveform::NAMES, 0.0,
        |s| s.osc2_wave.index() as f32, |s, v| s.osc2_wave = Waveform::from_index(v as usize)),
    number("osc2Detune", "Oscillator 2 detune", "cents", (-2_400.0, 2_400.0, 7.0), 0.0,
        |s| s.osc2_detune, |s, v| s.osc2_detune = v),
    number("oscMix", "Oscillator mix", "", (0.0, 1.0, 0.0), 0.0,
        |s| s.osc_mix, |s, v| s.osc_mix = v),

    choice("filterType", "Filter type", &FilterKind::NAMES, 0.0,
        |s| s.filter_kind.index() as f32, |s, v| s.filter_kind = FilterKind::from_index(v as usize)),
    number("cutoffHz", "Cutoff", "Hz", (20.0, 20_000.0, 2_400.0), 0.0,
        |s| s.cutoff_hz, |s, v| s.cutoff_hz = v),
    number("resonance", "Resonance", "Q", (0.1, 20.0, 1.2), 0.0,
        |s| s.resonance, |s, v| s.resonance = v),
    number("filterEnvAmount", "Filter envelope amount", "octaves", (-8.0, 8.0, 0.0), 0.0,
        |s| s.filter_env_amount, |s, v| s.filter_env_amount = v),
    number("filterAttack", "Filter attack", "s", (MIN_STAGE, MAX_STAGE, MIN_STAGE), 0.0,
        |s| s.filter_attack, |s, v| s.filter_attack = v),
    number("filterDecay", "Filter decay", "s", STAGE, 0.0,
        |s| s.filter_decay, |s, v| s.filter_decay = v),
    number("filterSustain", "Filter sustain", "", (0.0, 1.0, 1.0), 0.0,
        |s| s.filter_sustain, |s, v| s.filter_sustain = v),
    number("filterRelease", "Filter release", "s", (MIN_STAGE, MAX_STAGE, 0.3), 0.0,
        |s| s.filter_release, |s, v| s.filter_release = v),

    number("attack", "Attack", "s", (MIN_STAGE, MAX_STAGE, 0.005), 0.0,
        |s| s.attack, |s, v| s.attack = v),
    number("decay", "Decay", "s", STAGE, 0.0,
        |s| s.decay, |s, v| s.decay = v),
    number("sustain", "Sustain", "", (0.0, 1.0, 0.6), 0.0,
        |s| s.sustain, |s, v| s.sustain = v),
    number("release", "Release", "s", (MIN_STAGE, MAX_STAGE, 0.3), 0.0,
        |s| s.release, |s, v| s.release = v),

    choice("lfoTarget", "LFO target", &LFO_TARGETS, 0.0,
        |s| s.lfo_target.index() as f32, |s, v| s.lfo_target = LfoTarget::from_index(v as usize)),
    number("lfoRateHz", "LFO rate", "Hz", (0.01, 20.0, 5.0), 0.0,
        |s| s.lfo_rate_hz, |s, v| s.lfo_rate_hz = v),
    number("lfoDepth", "LFO depth", "", (0.0, 1.0, 0.0), 0.0,
        |s| s.lfo_depth, |s, v| s.lfo_depth = v),

    number("glide", "Glide", "s", (0.0, 5.0, 0.0), 0.0,
        |s| s.glide, |s, v| s.glide = v),
    number("voices", "Voices", "", (1.0, MAX_VOICES as f32, 8.0), 1.0,
        |s| s.voices as f32, |s, v| s.voices = v as usize),
    number("level", "Level", "", (0.0, 1.0, 1.0), 0.0,
        |s| s.level, |s, v| s.level = v),
];

/// Where the LFO goes. The order is the order `lfoTarget` chooses from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LfoTarget {
    #[default]
    Off,
    Pitch,
    Filter,
    Amp,
}

const LFO_TARGETS: [&str; 4] = ["off", "pitch", "filter", "amp"];

impl LfoTarget {
    fn from_index(index: usize) -> Self {
        match index {
            1 => Self::Pitch,
            2 => Self::Filter,
            3 => Self::Amp,
            _ => Self::Off,
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Off => 0,
            Self::Pitch => 1,
            Self::Filter => 2,
            Self::Amp => 3,
        }
    }
}

/// The Synth's sound: one value for each of `PARAMS`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SynthSettings {
    pub osc1_wave: Waveform,
    pub osc2_wave: Waveform,
    pub osc2_detune: f32,
    pub osc_mix: f32,
    pub filter_kind: FilterKind,
    pub cutoff_hz: f32,
    pub resonance: f32,
    pub filter_env_amount: f32,
    pub filter_attack: f32,
    pub filter_decay: f32,
    pub filter_sustain: f32,
    pub filter_release: f32,
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
    pub lfo_target: LfoTarget,
    pub lfo_rate_hz: f32,
    pub lfo_depth: f32,
    pub glide: f32,
    pub voices: usize,
    pub level: f32,
}

impl Default for SynthSettings {
    fn default() -> Self {
        // Every default comes from the table, so there is one of each.
        let mut settings = Self::zeroed();
        for param in PARAMS {
            param.set(&mut settings, param.default);
        }
        settings
    }
}

impl SynthSettings {
    /// A host's flat form: one value per setting, in `PARAMS` order. Values
    /// out of range are clamped, and any the host leaves off keep their
    /// default, so an older host still gets a sound it asked for.
    pub fn from_flat(values: &[f32]) -> Self {
        let mut settings = Self::default();
        for (param, value) in PARAMS.iter().zip(values) {
            param.set(&mut settings, *value);
        }
        settings
    }

    /// The settings as a host sends them: one value per setting, in order.
    pub fn to_flat(&self) -> Vec<f32> {
        PARAMS.iter().map(|param| param.get(self)).collect()
    }

    fn zeroed() -> Self {
        Self {
            osc1_wave: Waveform::Saw,
            osc2_wave: Waveform::Saw,
            osc2_detune: 0.0,
            osc_mix: 0.0,
            filter_kind: FilterKind::Low,
            cutoff_hz: 0.0,
            resonance: 0.0,
            filter_env_amount: 0.0,
            filter_attack: 0.0,
            filter_decay: 0.0,
            filter_sustain: 0.0,
            filter_release: 0.0,
            attack: 0.0,
            decay: 0.0,
            sustain: 0.0,
            release: 0.0,
            lfo_target: LfoTarget::Off,
            lfo_rate_hz: 0.0,
            lfo_depth: 0.0,
            glide: 0.0,
            voices: 0,
            level: 0.0,
        }
    }
}

/// The settings as JSON, so the UI can draw a control for each and the
/// **Assistant** knows what it may set.
pub fn parameters_json() -> String {
    let mut out = String::with_capacity(2_048);
    out.push('[');
    for (index, param) in PARAMS.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let choices = param
            .choices
            .iter()
            .map(|name| format!(r#""{name}""#))
            .collect::<Vec<_>>()
            .join(",");
        let _ = write!(
            out,
            r#"{{"name":"{}","label":"{}","unit":"{}","min":{},"max":{},"default":{},"step":{},"choices":[{choices}]}}"#,
            param.name,
            param.label,
            param.unit,
            number_json(param.min),
            number_json(param.max),
            number_json(param.default),
            number_json(param.step),
        );
    }
    out.push(']');
    out
}

/// A setting's value as JSON, without a trailing `.0` that would read as a
/// different number from the one the UI holds.
pub fn number_json(value: f32) -> String {
    // 4 decimals is finer than any setting's step; f32 prints its shortest
    // exact form, which can be 0.30000001.
    let rounded = (f64::from(value) * 10_000.0).round() / 10_000.0;
    format!("{rounded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_setting_is_declared_once_with_a_default_in_range() {
        let mut names: Vec<&str> = PARAMS.iter().map(|p| p.name).collect();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count, "duplicate setting names");

        for param in PARAMS {
            assert!(param.min < param.max, "{}: empty range", param.name);
            assert!(
                (param.min..=param.max).contains(&param.default),
                "{}: default out of range",
                param.name
            );
            assert!(!param.label.is_empty(), "{}: no label", param.name);
            if !param.choices.is_empty() {
                assert_eq!(param.max, (param.choices.len() - 1) as f32);
                assert_eq!(param.step, 1.0);
            }
        }
    }

    #[test]
    fn the_defaults_are_the_tables_defaults() {
        let settings = SynthSettings::default();
        for param in PARAMS {
            assert_eq!(param.get(&settings), param.default, "{}", param.name);
        }
        assert_eq!(SynthSettings::from_flat(&[]), settings, "nothing sent");
    }

    #[test]
    fn the_flat_form_round_trips_and_clamps() {
        let settings = SynthSettings {
            cutoff_hz: 800.0,
            osc2_wave: Waveform::Triangle,
            lfo_target: LfoTarget::Filter,
            voices: 3,
            ..SynthSettings::default()
        };
        assert_eq!(SynthSettings::from_flat(&settings.to_flat()), settings);

        let mut flat = settings.to_flat();
        flat[index_of("cutoffHz")] = 1e9;
        flat[index_of("sustain")] = -4.0;
        flat[index_of("voices")] = 2.6;
        flat[index_of("attack")] = f32::NAN;
        let clamped = SynthSettings::from_flat(&flat);
        assert_eq!(clamped.cutoff_hz, 20_000.0);
        assert_eq!(clamped.sustain, 0.0);
        assert_eq!(clamped.voices, 3);
        assert_eq!(clamped.attack, 0.005, "NaN falls back to the default");
    }

    #[test]
    fn the_json_lists_every_setting_with_its_range() {
        let json = parameters_json();
        assert!(json.starts_with(r#"[{"name":"osc1Wave""#), "{json}");
        assert!(json.contains(r#""choices":["saw","square","triangle","sine"]"#));
        assert!(json.contains(r#""name":"cutoffHz","label":"Cutoff","unit":"Hz","min":20,"max":20000,"default":2400,"step":0,"choices":[]"#));
        assert_eq!(json.matches(r#""name":"#).count(), PARAMS.len());
    }

    fn index_of(name: &str) -> usize {
        PARAMS.iter().position(|p| p.name == name).unwrap()
    }
}

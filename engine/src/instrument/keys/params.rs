//! The Keys' settings, declared up front, as the Synth's are.
//!
//! One table describes every setting: its name, label, unit, range, default
//! and step, and the choices it offers if it picks from a list. The settings
//! themselves are one number per row of the table, in its order, which is
//! also the flat form a host sends, so the two cannot drift apart.

use std::fmt::Write;

use crate::instrument::synth::number_json;

/// One setting: what it is called, what it may be, and what it is by default.
pub struct KeysParam {
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
}

impl KeysParam {
    /// `value` clamped to the range and rounded to the step; the default for one that isn't a number.
    pub fn clamp(&self, value: f32) -> f32 {
        let value = if value.is_finite() {
            value
        } else {
            self.default
        };
        let value = value.clamp(self.min, self.max);
        if self.step > 0.0 {
            (value / self.step).round() * self.step
        } else {
            value
        }
    }
}

const fn number(
    name: &'static str,
    label: &'static str,
    unit: &'static str,
    (min, max, default): (f32, f32, f32),
    step: f32,
) -> KeysParam {
    KeysParam {
        name,
        label,
        unit,
        min,
        max,
        default,
        step,
        choices: &[],
    }
}

/// Where the Keys' sound comes from: its modelled piano, or a sample played at each key's pitch.
pub const SOURCES: [&str; 2] = ["piano", "sample"];

/// How many voices the Keys have room for, whatever `voices` asks for.
pub const MAX_KEYS_VOICES: usize = 32;
/// The most partials a string has.
pub const MAX_PARTIALS: usize = 16;
/// The most strings a note has.
pub const MAX_STRINGS: usize = 3;

/// Every setting of the Keys, in the order a host sends them.
#[rustfmt::skip]
pub const KEYS_PARAMS: &[KeysParam] = &[
    KeysParam { name: "source", label: "Sound source", unit: "", min: 0.0, max: 1.0, default: 0.0, step: 1.0, choices: &SOURCES },
    number("brightness", "Brightness", "", (0.0, 1.0, 0.55), 0.0),
    number("hammerPosition", "Hammer position", "", (0.02, 0.5, 0.12), 0.0),
    number("partials", "Partials", "", (1.0, MAX_PARTIALS as f32, 12.0), 1.0),
    number("inharmonicity", "Inharmonicity", "", (0.0, 1.0, 0.3), 0.0),
    number("strings", "Strings per note", "", (1.0, MAX_STRINGS as f32, 2.0), 1.0),
    number("detune", "String detune", "cents", (0.0, 40.0, 1.5), 0.0),
    number("decay", "Decay", "s", (0.1, 30.0, 8.0), 0.0),
    number("highDamping", "High damping", "", (0.0, 1.0, 0.5), 0.0),
    number("release", "Release", "s", (0.01, 5.0, 0.3), 0.0),
    number("attack", "Attack", "s", (0.001, 2.0, 0.001), 0.0),
    number("hammerNoise", "Hammer noise", "", (0.0, 1.0, 0.2), 0.0),
    number("bell", "Bell", "", (0.0, 1.0, 0.0), 0.0),
    number("bellRatio", "Bell ratio", "", (1.0, 16.0, 7.0), 0.0),
    number("bellDecay", "Bell decay", "s", (0.02, 5.0, 0.6), 0.0),
    number("drive", "Drive", "", (0.0, 1.0, 0.0), 0.0),
    number("toneHz", "Tone", "Hz", (200.0, 20_000.0, 20_000.0), 0.0),
    number("tremoloRateHz", "Tremolo rate", "Hz", (0.1, 12.0, 5.0), 0.0),
    number("tremoloDepth", "Tremolo depth", "", (0.0, 1.0, 0.0), 0.0),
    number("tremoloStereo", "Tremolo stereo", "", (0.0, 1.0, 0.0), 0.0),
    number("width", "Stereo width", "", (0.0, 1.0, 0.5), 0.0),
    number("velocitySense", "Velocity sensitivity", "", (0.0, 1.0, 0.8), 0.0),
    number("rootNote", "Sample root note", "", (0.0, 127.0, 60.0), 1.0),
    number("voices", "Voices", "", (1.0, MAX_KEYS_VOICES as f32, 24.0), 1.0),
    number("level", "Level", "", (0.0, 1.0, 0.8), 0.0),
];

/// How many settings the Keys have.
pub const KEYS_PARAM_COUNT: usize = 25;
const _: () = assert!(KEYS_PARAMS.len() == KEYS_PARAM_COUNT);

/// The row of the setting called `name`.
pub fn keys_param_index(name: &str) -> Option<usize> {
    KEYS_PARAMS.iter().position(|param| param.name == name)
}

/// The Keys' sound: one value for each of `KEYS_PARAMS`, in order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeysSettings {
    values: [f32; KEYS_PARAM_COUNT],
}

impl Default for KeysSettings {
    fn default() -> Self {
        let mut values = [0.0; KEYS_PARAM_COUNT];
        for (value, param) in values.iter_mut().zip(KEYS_PARAMS) {
            *value = param.default;
        }
        Self { values }
    }
}

impl KeysSettings {
    /// A host's flat form, clamped; any it leaves off keep their default.
    pub fn from_flat(values: &[f32]) -> Self {
        let mut settings = Self::default();
        for (index, value) in values.iter().enumerate().take(KEYS_PARAM_COUNT) {
            settings.values[index] = KEYS_PARAMS[index].clamp(*value);
        }
        settings
    }

    /// The settings as a host sends them: one value per setting, in order.
    pub fn to_flat(&self) -> Vec<f32> {
        self.values.to_vec()
    }

    /// The default settings with `changes` made, by name: a Preset's.
    pub fn with(changes: &[(&str, f32)]) -> Self {
        let mut settings = Self::default();
        for (name, value) in changes {
            let index =
                keys_param_index(name).unwrap_or_else(|| panic!("no Keys setting called {name}"));
            settings.values[index] = KEYS_PARAMS[index].clamp(*value);
        }
        settings
    }

    /// The setting called `name`, or 0 for none.
    pub fn get(&self, name: &str) -> f32 {
        keys_param_index(name).map_or(0.0, |index| self.values[index])
    }

    /// Set the setting at `index`, clamped; ignored past the table.
    pub fn set_index(&mut self, index: usize, value: f32) {
        if let Some(param) = KEYS_PARAMS.get(index) {
            self.values[index] = param.clamp(value);
        }
    }

    /// The setting at `index` of the table, or 0 past it.
    pub fn value(&self, index: usize) -> f32 {
        self.values.get(index).copied().unwrap_or(0.0)
    }

    pub(super) fn at(&self, index: usize) -> f32 {
        self.values[index]
    }
}

/// The rows of the settings the voices read, so rendering never looks a name up.
pub(super) mod at {
    pub const SOURCE: usize = 0;
    pub const BRIGHTNESS: usize = 1;
    pub const HAMMER_POSITION: usize = 2;
    pub const PARTIALS: usize = 3;
    pub const INHARMONICITY: usize = 4;
    pub const STRINGS: usize = 5;
    pub const DETUNE: usize = 6;
    pub const DECAY: usize = 7;
    pub const HIGH_DAMPING: usize = 8;
    pub const RELEASE: usize = 9;
    pub const ATTACK: usize = 10;
    pub const HAMMER_NOISE: usize = 11;
    pub const BELL: usize = 12;
    pub const BELL_RATIO: usize = 13;
    pub const BELL_DECAY: usize = 14;
    pub const DRIVE: usize = 15;
    pub const TONE_HZ: usize = 16;
    pub const TREMOLO_RATE_HZ: usize = 17;
    pub const TREMOLO_DEPTH: usize = 18;
    pub const TREMOLO_STEREO: usize = 19;
    pub const WIDTH: usize = 20;
    pub const VELOCITY_SENSE: usize = 21;
    pub const ROOT_NOTE: usize = 22;
    pub const VOICES: usize = 23;
    pub const LEVEL: usize = 24;
}

/// The settings as JSON, so the UI can draw a control for each and the **Assistant** knows what it may set.
pub fn keys_parameters_json() -> String {
    let mut out = String::with_capacity(3_072);
    out.push('[');
    for (index, param) in KEYS_PARAMS.iter().enumerate() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_setting_is_declared_once_with_a_default_in_range_and_its_row_is_right() {
        let mut names: Vec<&str> = KEYS_PARAMS.iter().map(|p| p.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), KEYS_PARAM_COUNT);
        for param in KEYS_PARAMS {
            assert!(param.min < param.max, "{}", param.name);
            assert!(
                (param.min..=param.max).contains(&param.default),
                "{}",
                param.name
            );
        }
        let rows = [
            ("source", at::SOURCE),
            ("brightness", at::BRIGHTNESS),
            ("hammerPosition", at::HAMMER_POSITION),
            ("partials", at::PARTIALS),
            ("inharmonicity", at::INHARMONICITY),
            ("strings", at::STRINGS),
            ("detune", at::DETUNE),
            ("decay", at::DECAY),
            ("highDamping", at::HIGH_DAMPING),
            ("release", at::RELEASE),
            ("attack", at::ATTACK),
            ("hammerNoise", at::HAMMER_NOISE),
            ("bell", at::BELL),
            ("bellRatio", at::BELL_RATIO),
            ("bellDecay", at::BELL_DECAY),
            ("drive", at::DRIVE),
            ("toneHz", at::TONE_HZ),
            ("tremoloRateHz", at::TREMOLO_RATE_HZ),
            ("tremoloDepth", at::TREMOLO_DEPTH),
            ("tremoloStereo", at::TREMOLO_STEREO),
            ("width", at::WIDTH),
            ("velocitySense", at::VELOCITY_SENSE),
            ("rootNote", at::ROOT_NOTE),
            ("voices", at::VOICES),
            ("level", at::LEVEL),
        ];
        for (name, row) in rows {
            assert_eq!(keys_param_index(name), Some(row), "{name}");
        }
    }

    #[test]
    fn the_flat_form_round_trips_and_clamps() {
        let settings = KeysSettings::with(&[("decay", 3.0), ("strings", 3.0)]);
        assert_eq!(KeysSettings::from_flat(&settings.to_flat()), settings);
        let mut flat = settings.to_flat();
        flat[at::DECAY] = 1e9;
        flat[at::STRINGS] = 2.4;
        flat[at::LEVEL] = f32::NAN;
        let clamped = KeysSettings::from_flat(&flat);
        assert_eq!(clamped.get("decay"), 30.0);
        assert_eq!(clamped.get("strings"), 2.0);
        assert_eq!(clamped.get("level"), 0.8);
        assert_eq!(KeysSettings::from_flat(&[]), KeysSettings::default());
    }

    #[test]
    fn the_json_lists_every_setting() {
        let json = keys_parameters_json();
        assert!(json.starts_with(r#"[{"name":"source","label":"Sound source","unit":"","min":0,"max":1,"default":0,"step":1,"choices":["piano","sample"]}"#), "{json}");
        assert_eq!(json.matches(r#""name":"#).count(), KEYS_PARAM_COUNT);
    }
}

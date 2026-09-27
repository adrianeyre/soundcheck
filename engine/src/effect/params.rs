//! Every Effect's settings, declared up front, the way the Synth's are.
//!
//! Each Effect has one table: the name a setting is known by, a label and
//! unit to draw it with, its range, its default, and the choices it offers
//! if it picks from a list. Defaults, clamping, the flat form a host sends
//! and the JSON the UI and the **Assistant** read all come from it.

use std::fmt::Write;

/// One setting of an Effect whose settings are `S`.
pub struct Param<S> {
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
    get: fn(&S) -> f32,
    set: fn(&mut S, f32),
}

// By hand, because a derive would ask for `S: Copy` too.
impl<S> Clone for Param<S> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<S> Copy for Param<S> {}

impl<S> Param<S> {
    pub fn get(&self, settings: &S) -> f32 {
        (self.get)(settings)
    }

    /// Set this setting, clamped to its range and rounded to its step.
    pub fn set(&self, settings: &mut S, value: f32) {
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

pub const fn number<S>(
    name: &'static str,
    label: &'static str,
    unit: &'static str,
    (min, max, default): (f32, f32, f32),
    get: fn(&S) -> f32,
    set: fn(&mut S, f32),
) -> Param<S> {
    Param {
        name,
        label,
        unit,
        min,
        max,
        default,
        step: 0.0,
        choices: &[],
        get,
        set,
    }
}

/// A setting that is off or on: 0 or 1.
pub const fn switch<S>(
    name: &'static str,
    label: &'static str,
    default: bool,
    get: fn(&S) -> f32,
    set: fn(&mut S, f32),
) -> Param<S> {
    Param {
        name,
        label,
        unit: "",
        min: 0.0,
        max: 1.0,
        default: if default { 1.0 } else { 0.0 },
        step: 1.0,
        choices: &["off", "on"],
        get,
        set,
    }
}

/// A setting that picks one of `choices`: its value is the choice's index.
pub const fn choice<S>(
    name: &'static str,
    label: &'static str,
    choices: &'static [&'static str],
    default: usize,
    get: fn(&S) -> f32,
    set: fn(&mut S, f32),
) -> Param<S> {
    Param {
        name,
        label,
        unit: "",
        min: 0.0,
        max: (choices.len() - 1) as f32,
        default: default as f32,
        step: 1.0,
        choices,
        get,
        set,
    }
}

/// Settings made from a table: the defaults and the flat form come from it.
pub trait Settings: Sized + 'static {
    /// Every setting, in the order a host sends them.
    const PARAMS: &'static [Param<Self>];

    /// All zeros, for the table to fill in.
    fn zeroed() -> Self;

    fn defaults() -> Self {
        let mut settings = Self::zeroed();
        for param in Self::PARAMS {
            param.set(&mut settings, param.default);
        }
        settings
    }

    /// A host's flat form: one value per setting, in table order. Values out
    /// of range are clamped, and any left off keep their default.
    fn from_flat(values: &[f32]) -> Self {
        let mut settings = Self::defaults();
        for (param, value) in Self::PARAMS.iter().zip(values) {
            param.set(&mut settings, *value);
        }
        settings
    }

    #[cfg(test)]
    fn to_flat(&self) -> Vec<f32> {
        Self::PARAMS.iter().map(|param| param.get(self)).collect()
    }
}

/// A table as JSON, so the UI can draw a control for each setting and the
/// **Assistant** knows what it may set.
pub fn table_json<S>(params: &[Param<S>]) -> String {
    let mut out = String::with_capacity(2_048);
    out.push('[');
    for (index, param) in params.iter().enumerate() {
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

/// A number as JSON, rounded so that an f32 widened to f64 doesn't print a
/// different number from the one the UI holds.
fn number_json(value: f32) -> String {
    let rounded = (f64::from(value) * 10_000.0).round() / 10_000.0;
    format!("{rounded}")
}

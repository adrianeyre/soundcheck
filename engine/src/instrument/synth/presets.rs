//! The Synth's factory presets: a starting sound for each of the kinds the
//! MVP asks for — bass, lead, pad, pluck and keys.
//!
//! A preset is only its settings and a name. The **Assistant** picks one by
//! name, and the UI lists them by category; loading one copies its settings
//! into the Track's Instrument, where they can then be changed. Saving your
//! own preset is v2.

use std::fmt::Write;

use super::params::{LfoTarget, SynthSettings, number_json};
use crate::dsp::{FilterKind, Waveform};

/// One factory preset.
#[derive(Clone, Copy, Debug)]
pub struct Preset {
    pub name: &'static str,
    /// One of bass, lead, pad, pluck or keys.
    pub category: &'static str,
    /// What it sounds like, for the musician and the **Assistant**.
    pub description: &'static str,
    pub settings: SynthSettings,
}

/// Every factory preset, in the order the UI lists them.
pub fn factory_presets() -> Vec<Preset> {
    vec![
        Preset {
            name: "Sub Bass",
            category: "bass",
            description: "Deep round sine bass with a little grit underneath",
            settings: SynthSettings {
                osc1_wave: Waveform::Sine,
                osc2_wave: Waveform::Triangle,
                osc2_detune: -1_200.0,
                osc_mix: 0.3,
                cutoff_hz: 320.0,
                resonance: 0.8,
                filter_env_amount: 1.0,
                filter_decay: 0.25,
                filter_sustain: 0.3,
                attack: 0.004,
                decay: 0.3,
                sustain: 0.85,
                release: 0.12,
                glide: 0.04,
                voices: 1,
                level: 0.9,
                ..SynthSettings::default()
            },
        },
        Preset {
            name: "Reese Bass",
            category: "bass",
            description: "Wide detuned saw bass that growls",
            settings: SynthSettings {
                osc1_wave: Waveform::Saw,
                osc2_wave: Waveform::Saw,
                osc2_detune: 18.0,
                osc_mix: 0.5,
                cutoff_hz: 520.0,
                resonance: 3.0,
                filter_env_amount: 1.5,
                filter_decay: 0.4,
                filter_sustain: 0.25,
                attack: 0.006,
                decay: 0.4,
                sustain: 0.8,
                release: 0.15,
                voices: 2,
                level: 0.55,
                ..SynthSettings::default()
            },
        },
        Preset {
            name: "Saw Lead",
            category: "lead",
            description: "Bright cutting saw lead with a touch of vibrato",
            settings: SynthSettings {
                osc1_wave: Waveform::Saw,
                osc2_wave: Waveform::Saw,
                osc2_detune: 9.0,
                osc_mix: 0.45,
                cutoff_hz: 4_200.0,
                resonance: 1.4,
                filter_env_amount: 1.0,
                filter_decay: 0.6,
                filter_sustain: 0.5,
                attack: 0.01,
                decay: 0.25,
                sustain: 0.75,
                release: 0.25,
                lfo_target: LfoTarget::Pitch,
                lfo_rate_hz: 5.5,
                lfo_depth: 0.06,
                glide: 0.03,
                voices: 2,
                level: 0.7,
                ..SynthSettings::default()
            },
        },
        Preset {
            name: "Square Lead",
            category: "lead",
            description: "Hollow square lead, dry and direct",
            settings: SynthSettings {
                osc1_wave: Waveform::Square,
                osc2_wave: Waveform::Square,
                osc2_detune: -1_195.0,
                osc_mix: 0.35,
                cutoff_hz: 3_000.0,
                resonance: 2.0,
                filter_env_amount: 1.2,
                filter_decay: 0.35,
                filter_sustain: 0.4,
                attack: 0.006,
                decay: 0.2,
                sustain: 0.7,
                release: 0.2,
                voices: 1,
                level: 0.65,
                ..SynthSettings::default()
            },
        },
        Preset {
            name: "Warm Pad",
            category: "pad",
            description: "Slow swelling saw pad that opens as it grows",
            settings: SynthSettings {
                osc1_wave: Waveform::Saw,
                osc2_wave: Waveform::Triangle,
                osc2_detune: 12.0,
                osc_mix: 0.5,
                cutoff_hz: 700.0,
                resonance: 0.9,
                filter_env_amount: 2.2,
                filter_attack: 1.2,
                filter_decay: 2.0,
                filter_sustain: 0.6,
                filter_release: 1.5,
                attack: 0.9,
                decay: 1.5,
                sustain: 0.8,
                release: 1.4,
                voices: 8,
                level: 0.6,
                ..SynthSettings::default()
            },
        },
        Preset {
            name: "Glass Pad",
            category: "pad",
            description: "Airy triangle pad with the filter drifting under it",
            settings: SynthSettings {
                osc1_wave: Waveform::Triangle,
                osc2_wave: Waveform::Sine,
                osc2_detune: 1_207.0,
                osc_mix: 0.4,
                cutoff_hz: 1_800.0,
                resonance: 1.1,
                filter_env_amount: 1.0,
                filter_attack: 0.8,
                filter_decay: 2.5,
                filter_sustain: 0.5,
                filter_release: 2.0,
                attack: 0.6,
                decay: 1.2,
                sustain: 0.75,
                release: 1.8,
                lfo_target: LfoTarget::Filter,
                lfo_rate_hz: 0.35,
                lfo_depth: 0.12,
                voices: 8,
                level: 0.6,
                ..SynthSettings::default()
            },
        },
        Preset {
            name: "Synth Pluck",
            category: "pluck",
            description: "Short filtered pluck that falls away fast",
            settings: SynthSettings {
                osc1_wave: Waveform::Saw,
                osc2_wave: Waveform::Square,
                osc2_detune: 5.0,
                osc_mix: 0.3,
                cutoff_hz: 900.0,
                resonance: 2.5,
                filter_env_amount: 3.0,
                filter_attack: 0.002,
                filter_decay: 0.22,
                filter_sustain: 0.0,
                filter_release: 0.12,
                attack: 0.002,
                decay: 0.35,
                sustain: 0.0,
                release: 0.12,
                voices: 8,
                level: 0.8,
                ..SynthSettings::default()
            },
        },
        Preset {
            name: "Bell Pluck",
            category: "pluck",
            description: "Bright bell-like pluck an octave wide",
            settings: SynthSettings {
                osc1_wave: Waveform::Sine,
                osc2_wave: Waveform::Triangle,
                osc2_detune: 1_902.0,
                osc_mix: 0.45,
                // A band-pass around the upper partial: the fundamental is
                // left as a thump under the ring.
                filter_kind: FilterKind::Band,
                cutoff_hz: 800.0,
                resonance: 1.2,
                filter_env_amount: 1.0,
                filter_attack: 0.002,
                filter_decay: 0.5,
                filter_sustain: 0.1,
                filter_release: 0.3,
                attack: 0.002,
                decay: 0.8,
                sustain: 0.05,
                release: 0.35,
                voices: 8,
                level: 0.9,
                ..SynthSettings::default()
            },
        },
        Preset {
            name: "Electric Keys",
            category: "keys",
            description: "Soft tine-like keys, mellow and playable",
            settings: SynthSettings {
                osc1_wave: Waveform::Sine,
                osc2_wave: Waveform::Triangle,
                osc2_detune: 1_203.0,
                osc_mix: 0.25,
                cutoff_hz: 2_000.0,
                resonance: 0.9,
                filter_env_amount: 1.5,
                filter_decay: 0.9,
                filter_sustain: 0.25,
                filter_release: 0.4,
                attack: 0.004,
                decay: 1.1,
                sustain: 0.35,
                release: 0.4,
                voices: 8,
                level: 0.85,
                ..SynthSettings::default()
            },
        },
        Preset {
            name: "Tremolo Keys",
            category: "keys",
            description: "Bright keys with the level wobbling underneath",
            settings: SynthSettings {
                osc1_wave: Waveform::Square,
                osc2_wave: Waveform::Saw,
                osc2_detune: -8.0,
                osc_mix: 0.4,
                cutoff_hz: 2_600.0,
                resonance: 1.0,
                filter_env_amount: 0.8,
                filter_decay: 0.8,
                filter_sustain: 0.4,
                attack: 0.008,
                decay: 0.9,
                sustain: 0.5,
                release: 0.35,
                lfo_target: LfoTarget::Amp,
                lfo_rate_hz: 5.0,
                lfo_depth: 0.4,
                voices: 8,
                level: 0.7,
                ..SynthSettings::default()
            },
        },
    ]
}

/// The presets as JSON: each with its name, category, description and the
/// settings it loads, keyed by the names `PARAMS` declares.
pub fn presets_json() -> String {
    let mut out = String::with_capacity(4_096);
    out.push('[');
    for (index, preset) in factory_presets().iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let settings = super::PARAMS
            .iter()
            .map(|param| {
                format!(
                    r#""{}":{}"#,
                    param.name,
                    number_json(param.get(&preset.settings))
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let _ = write!(
            out,
            r#"{{"name":"{}","category":"{}","description":"{}","settings":{{{settings}}}}}"#,
            preset.name, preset.category, preset.description,
        );
    }
    out.push(']');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The kinds of sound the MVP asks the factory presets to cover.
    const CATEGORIES: [&str; 5] = ["bass", "lead", "pad", "pluck", "keys"];

    #[test]
    fn about_ten_presets_cover_every_category_with_names_of_their_own() {
        let presets = factory_presets();
        assert!(
            (8..=12).contains(&presets.len()),
            "{} presets",
            presets.len()
        );

        let mut names: Vec<&str> = presets.iter().map(|p| p.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), presets.len(), "duplicate preset names");

        for category in CATEGORIES {
            assert!(
                presets.iter().any(|p| p.category == category),
                "no {category} preset"
            );
        }
        for preset in &presets {
            assert!(CATEGORIES.contains(&preset.category), "{}", preset.name);
            assert!(!preset.description.is_empty(), "{}", preset.name);
            // Nothing in a name or description may need JSON escaping.
            for text in [preset.name, preset.category, preset.description] {
                assert!(!text.contains(['"', '\\']), "{text}");
            }
        }
    }

    #[test]
    fn every_preset_setting_is_the_one_asked_for() {
        // Settings a preset gives are kept as they are, not clamped away.
        for preset in factory_presets() {
            let round_tripped = SynthSettings::from_flat(&preset.settings.to_flat());
            assert_eq!(round_tripped, preset.settings, "{}", preset.name);
        }
    }

    #[test]
    fn the_json_names_every_preset_and_its_settings() {
        let json = presets_json();
        for preset in factory_presets() {
            assert!(json.contains(&format!(r#""name":"{}""#, preset.name)));
        }
        assert!(json.contains(r#""category":"pluck""#));
        assert!(json.contains(r#""cutoffHz":320"#), "Sub Bass's cutoff");
    }
}

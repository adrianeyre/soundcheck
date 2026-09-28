//! The Keys' factory presets: grand, upright and electric pianos, and a few
//! with more character. Each is only a name and its settings, the changes it
//! makes to the defaults; loading one copies them into the Track's Keys.

use std::fmt::Write;

use super::params::{KEYS_PARAMS, KeysSettings};
use crate::instrument::synth::number_json;

/// One factory preset.
#[derive(Clone, Copy, Debug)]
pub struct KeysPreset {
    pub name: &'static str,
    /// One of grand, upright, electric or character.
    pub category: &'static str,
    /// What it sounds like, for the musician and the **Assistant**.
    pub description: &'static str,
    pub settings: KeysSettings,
}

type Changes = &'static [(&'static str, f32)];

#[rustfmt::skip]
const PRESETS: &[(&str, &str, &str, Changes)] = &[
    // Grand pianos: two or three strings a note, slightly stretched partials, long decay.
    ("Concert Grand", "grand", "Full, even nine-foot grand with a long singing decay",
        &[("brightness", 0.6), ("strings", 3.0), ("detune", 1.2), ("decay", 12.0), ("inharmonicity", 0.35), ("width", 0.7)]),
    ("Bright Grand", "grand", "Hard-hammered grand that cuts through a mix",
        &[("brightness", 0.85), ("strings", 3.0), ("detune", 1.5), ("decay", 9.0), ("highDamping", 0.3), ("hammerNoise", 0.35), ("level", 0.7)]),
    ("Warm Grand", "grand", "Soft-voiced grand, round and mellow",
        &[("brightness", 0.35), ("strings", 3.0), ("detune", 1.0), ("decay", 11.0), ("highDamping", 0.7), ("toneHz", 7_000.0)]),
    ("Jazz Grand", "grand", "Close, woody grand for comping and ballads",
        &[("brightness", 0.5), ("strings", 2.0), ("detune", 2.0), ("decay", 7.0), ("hammerPosition", 0.14), ("toneHz", 10_000.0)]),
    ("Studio Grand", "grand", "Tight, polished grand as on a pop record",
        &[("brightness", 0.7), ("strings", 2.0), ("detune", 1.0), ("decay", 6.0), ("release", 0.2), ("width", 0.6)]),
    ("Ballad Grand", "grand", "Gentle grand with a slow bloom and a long tail",
        &[("brightness", 0.4), ("strings", 3.0), ("decay", 16.0), ("release", 0.8), ("attack", 0.01), ("width", 0.8)]),
    ("Classical Grand", "grand", "Balanced grand with a clear bass and sparkling top",
        &[("brightness", 0.6), ("strings", 3.0), ("detune", 0.8), ("decay", 13.0), ("inharmonicity", 0.4), ("partials", 14.0)]),
    ("Rock Piano", "grand", "Bright, driven grand for pounding chords",
        &[("brightness", 0.9), ("strings", 2.0), ("detune", 3.0), ("decay", 5.0), ("drive", 0.35), ("hammerNoise", 0.4), ("level", 0.65)]),

    // Uprights: shorter strings, more inharmonic, looser tuning.
    ("Upright Piano", "upright", "Homely upright, a little boxy and intimate",
        &[("brightness", 0.5), ("strings", 2.0), ("detune", 3.0), ("decay", 5.0), ("inharmonicity", 0.55), ("toneHz", 9_000.0)]),
    ("Old Upright", "upright", "Tired upright with a dull top and a wobble",
        &[("brightness", 0.35), ("strings", 2.0), ("detune", 7.0), ("decay", 4.0), ("inharmonicity", 0.7), ("toneHz", 5_000.0)]),
    ("Honky-Tonk", "upright", "Saloon upright with its strings pulled out of tune",
        &[("brightness", 0.7), ("strings", 3.0), ("detune", 18.0), ("decay", 4.0), ("inharmonicity", 0.5), ("hammerNoise", 0.35)]),
    ("Saloon Piano", "upright", "Jangly, clattering bar-room piano",
        &[("brightness", 0.8), ("strings", 3.0), ("detune", 26.0), ("decay", 3.0), ("hammerNoise", 0.55), ("inharmonicity", 0.6)]),
    ("Felt Piano", "upright", "Felt over the hammers: soft, hushed and close",
        &[("brightness", 0.15), ("strings", 2.0), ("detune", 2.0), ("decay", 4.0), ("toneHz", 2_500.0), ("hammerNoise", 0.45), ("release", 0.5)]),
    ("Lullaby Felt", "upright", "The softest felt, for quiet lullabies and film cues",
        &[("brightness", 0.1), ("strings", 1.0), ("decay", 5.0), ("toneHz", 1_800.0), ("attack", 0.008), ("release", 0.9), ("width", 0.8)]),
    ("Tack Piano", "upright", "Tacks in the hammers: bright, metallic and ragtime",
        &[("brightness", 1.0), ("strings", 2.0), ("detune", 9.0), ("decay", 3.0), ("hammerNoise", 0.7), ("hammerPosition", 0.05), ("bell", 0.15), ("bellRatio", 11.0), ("bellDecay", 0.15)]),
    ("Muted Piano", "upright", "Palm-muted strings, short and percussive",
        &[("brightness", 0.45), ("strings", 2.0), ("decay", 0.6), ("release", 0.1), ("highDamping", 0.9), ("hammerNoise", 0.3)]),

    // Electric pianos: tines, reeds and FM, a bell partial over a pure tone.
    ("Tine EP", "electric", "Classic tine electric piano, bell on top and a warm core",
        &[("brightness", 0.2), ("partials", 4.0), ("strings", 1.0), ("inharmonicity", 0.0), ("decay", 6.0), ("bell", 0.45), ("bellRatio", 7.0), ("bellDecay", 0.5), ("drive", 0.15), ("hammerNoise", 0.05)]),
    ("Suitcase EP", "electric", "Tine piano through a stereo tremolo that swirls side to side",
        &[("brightness", 0.2), ("partials", 4.0), ("strings", 1.0), ("inharmonicity", 0.0), ("decay", 6.0), ("bell", 0.4), ("bellRatio", 7.0), ("tremoloDepth", 0.6), ("tremoloStereo", 1.0), ("tremoloRateHz", 4.5), ("width", 0.9)]),
    ("Bark EP", "electric", "Tine piano played hard: growling and driven",
        &[("brightness", 0.35), ("partials", 5.0), ("strings", 1.0), ("inharmonicity", 0.0), ("decay", 5.0), ("bell", 0.55), ("bellRatio", 7.0), ("drive", 0.7), ("velocitySense", 1.0)]),
    ("Reed EP", "electric", "Reed electric piano, nasal and buzzy, with a little tremolo",
        &[("brightness", 0.55), ("partials", 8.0), ("strings", 1.0), ("inharmonicity", 0.05), ("decay", 3.5), ("bell", 0.2), ("bellRatio", 3.0), ("bellDecay", 0.3), ("drive", 0.45), ("tremoloDepth", 0.3), ("tremoloRateHz", 5.5)]),
    ("FM EP", "electric", "Glassy digital FM piano, bright bell and clean body",
        &[("brightness", 0.25), ("partials", 3.0), ("strings", 1.0), ("inharmonicity", 0.0), ("decay", 5.0), ("bell", 0.6), ("bellRatio", 14.0), ("bellDecay", 0.35), ("width", 0.7)]),
    ("Glass EP", "electric", "Airy, chorused electric piano for pads and ballads",
        &[("brightness", 0.2), ("partials", 4.0), ("strings", 2.0), ("detune", 6.0), ("inharmonicity", 0.0), ("decay", 8.0), ("bell", 0.5), ("bellRatio", 9.0), ("release", 0.8), ("width", 1.0)]),
    ("Dyno EP", "electric", "Punchy, hi-fi tine piano with an emphasised attack",
        &[("brightness", 0.45), ("partials", 5.0), ("strings", 1.0), ("inharmonicity", 0.0), ("decay", 4.0), ("bell", 0.7), ("bellRatio", 7.0), ("bellDecay", 0.2), ("hammerNoise", 0.15), ("velocitySense", 0.9)]),
    ("Stage Piano", "electric", "Electric grand: strings with pickups, bright and compact",
        &[("brightness", 0.75), ("strings", 2.0), ("detune", 4.0), ("decay", 4.5), ("inharmonicity", 0.45), ("drive", 0.2), ("toneHz", 8_000.0)]),

    // Character: toys, bells, plucked keys, and pianos with a treatment.
    ("Toy Piano", "character", "Struck metal rods: plinky, out of tune and cute",
        &[("brightness", 0.5), ("partials", 3.0), ("strings", 1.0), ("inharmonicity", 1.0), ("decay", 1.2), ("bell", 0.6), ("bellRatio", 2.76), ("bellDecay", 0.5), ("hammerNoise", 0.4)]),
    ("Music Box", "character", "Plucked comb teeth, delicate and chiming",
        &[("brightness", 0.3), ("partials", 2.0), ("strings", 1.0), ("inharmonicity", 0.0), ("decay", 2.5), ("bell", 0.5), ("bellRatio", 5.4), ("bellDecay", 0.9), ("hammerNoise", 0.05), ("width", 0.9)]),
    ("Celesta", "character", "Hammers on steel plates: soft sparkling bells",
        &[("brightness", 0.2), ("partials", 3.0), ("strings", 1.0), ("inharmonicity", 0.0), ("decay", 2.0), ("bell", 0.4), ("bellRatio", 4.0), ("bellDecay", 0.8), ("release", 0.6)]),
    ("Harpsichord", "character", "Plucked strings: bright, thin and baroque",
        &[("brightness", 1.0), ("hammerPosition", 0.04), ("partials", 16.0), ("strings", 2.0), ("detune", 2.0), ("decay", 3.0), ("highDamping", 0.1), ("release", 0.15), ("velocitySense", 0.2), ("hammerNoise", 0.25), ("level", 0.7)]),
    ("Clavinet", "character", "Struck, damped strings: funky and snappy",
        &[("brightness", 0.95), ("hammerPosition", 0.06), ("partials", 14.0), ("strings", 1.0), ("decay", 1.2), ("release", 0.05), ("drive", 0.5), ("highDamping", 0.2)]),
    ("Lo-fi Piano", "character", "Dusty, wobbly piano as off a worn cassette",
        &[("brightness", 0.4), ("strings", 2.0), ("detune", 10.0), ("decay", 5.0), ("toneHz", 3_000.0), ("tremoloDepth", 0.15), ("tremoloRateHz", 0.8), ("drive", 0.25), ("width", 0.3)]),
    ("Ambient Piano", "character", "Slow-blooming piano that hangs in the air",
        &[("brightness", 0.35), ("strings", 3.0), ("detune", 3.0), ("decay", 20.0), ("attack", 0.25), ("release", 3.0), ("toneHz", 6_000.0), ("width", 1.0)]),
    ("Dream Piano", "character", "Piano with a shimmer of bells over it",
        &[("brightness", 0.45), ("strings", 2.0), ("detune", 4.0), ("decay", 12.0), ("bell", 0.3), ("bellRatio", 8.0), ("bellDecay", 1.5), ("release", 1.5), ("width", 1.0)]),
    ("Cinematic Piano", "character", "Dark, huge low piano for film scores",
        &[("brightness", 0.3), ("strings", 3.0), ("detune", 1.5), ("decay", 24.0), ("highDamping", 0.8), ("toneHz", 4_500.0), ("release", 2.0), ("width", 1.0), ("partials", 16.0)]),
];

/// Every factory preset, in the order the UI lists them.
pub fn keys_factory_presets() -> Vec<KeysPreset> {
    PRESETS
        .iter()
        .map(|(name, category, description, changes)| KeysPreset {
            name,
            category,
            description,
            settings: KeysSettings::with(changes),
        })
        .collect()
}

/// The presets as JSON, for the UI's picker and the **Assistant**.
pub fn keys_presets_json() -> String {
    let mut out = String::with_capacity(12_288);
    out.push('[');
    for (index, preset) in keys_factory_presets().iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let flat = preset.settings.to_flat();
        let settings = KEYS_PARAMS
            .iter()
            .zip(flat)
            .map(|(param, value)| format!(r#""{}":{}"#, param.name, number_json(value)))
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

    #[test]
    fn there_are_at_least_thirty_presets_each_named_once_in_a_known_category() {
        let presets = keys_factory_presets();
        assert!(presets.len() >= 30, "{}", presets.len());
        let mut names: Vec<&str> = presets.iter().map(|p| p.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), presets.len());
        for preset in &presets {
            assert!(
                ["grand", "upright", "electric", "character"].contains(&preset.category),
                "{}",
                preset.name
            );
            // Every preset plays the modelled piano; a sample is the musician's.
            assert_eq!(preset.settings.get("source"), 0.0, "{}", preset.name);
        }
    }

    #[test]
    fn the_json_lists_every_preset() {
        let json = keys_presets_json();
        assert!(json.contains(r#""name":"Concert Grand","category":"grand""#));
        assert_eq!(
            json.matches(r#""category":"#).count(),
            keys_factory_presets().len()
        );
    }
}

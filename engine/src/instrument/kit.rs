//! The bundled starter kit.
//!
//! The WAVs are embedded at compile time, so the engine still opens no files
//! (ADR 0001) and the kit is there in the browser dev host and the desktop
//! app alike. They are synthesised by `examples/make_starter_kit.rs` and are
//! this repository's own work, redistributable under GPL-3.0; see
//! `assets/kits/starter/LICENCE.md`.

/// One pad of a kit, before its sample is decoded.
#[derive(Clone, Copy, Debug)]
pub struct KitPad {
    pub name: &'static str,
    /// The note that triggers it: the General MIDI drum map, so a MIDI
    /// keyboard's drum pads land where a musician expects.
    pub note: u8,
    /// Pads sharing a group above 0 cut each other off.
    pub choke_group: u8,
    pub wav: &'static [u8],
}

macro_rules! pad {
    ($name:literal, $note:literal, $choke:literal, $file:literal) => {
        KitPad {
            name: $name,
            note: $note,
            choke_group: $choke,
            wav: include_bytes!(concat!("../../assets/kits/starter/", $file, ".wav")),
        }
    };
}

/// The one kit the MVP bundles. Choke group 1 is the hi-hat: closing it cuts
/// the open one off, as a real hi-hat does.
pub const STARTER_KIT: [KitPad; 8] = [
    pad!("Kick", 36, 0, "kick"),
    pad!("Snare", 38, 0, "snare"),
    pad!("Clap", 39, 0, "clap"),
    pad!("Closed Hat", 42, 1, "closed-hat"),
    pad!("Open Hat", 46, 1, "open-hat"),
    pad!("Low Tom", 45, 0, "low-tom"),
    pad!("High Tom", 48, 0, "high-tom"),
    pad!("Cowbell", 56, 0, "cowbell"),
];

/// The kit as JSON, so the UI shows the same pad names, notes and choke
/// groups the engine plays without repeating them.
pub fn starter_kit_json() -> String {
    let pads: Vec<String> = STARTER_KIT
        .iter()
        .map(|pad| {
            format!(
                r#"{{"name":"{}","note":{},"chokeGroup":{}}}"#,
                pad.name, pad.note, pad.choke_group
            )
        })
        .collect();
    format!("[{}]", pads.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instrument::wav;

    #[test]
    fn every_pad_has_a_sample_that_decodes_and_makes_a_sound() {
        for pad in STARTER_KIT {
            let sample = wav::decode(pad.wav).unwrap_or_else(|e| panic!("{}: {:?}", pad.name, e));
            assert_eq!(sample.rate(), 48_000.0, "{}", pad.name);
            assert!(sample.frames() > 1_000, "{} is too short", pad.name);
            let peak = (0..sample.frames()).fold(0.0_f32, |max, f| max.max(sample.at(f, 0).abs()));
            assert!(peak > 0.5, "{} is too quiet: {peak}", pad.name);
        }
    }

    #[test]
    fn the_kit_covers_a_drum_machine_and_its_notes_are_its_own() {
        assert_eq!(STARTER_KIT.len(), 8, "8 to 16 pads");
        let mut notes: Vec<u8> = STARTER_KIT.iter().map(|p| p.note).collect();
        notes.sort_unstable();
        notes.dedup();
        assert_eq!(notes.len(), STARTER_KIT.len(), "no two pads share a note");
        // The hi-hats choke each other and nothing else does.
        let choked: Vec<&str> = STARTER_KIT
            .iter()
            .filter(|p| p.choke_group == 1)
            .map(|p| p.name)
            .collect();
        assert_eq!(choked, ["Closed Hat", "Open Hat"]);
    }

    #[test]
    fn the_json_the_ui_reads_lists_every_pad() {
        let json = starter_kit_json();
        assert!(
            json.starts_with(r#"[{"name":"Kick","note":36,"chokeGroup":0}"#),
            "{json}"
        );
        assert_eq!(json.matches("name").count(), STARTER_KIT.len());
    }
}

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

/// The one kit the app bundles. Choke group 1 is the hi-hat: closing it,
/// with the stick or the pedal, cuts the open one off, as a real hi-hat does.
///
/// The first eight are the kit as it first shipped, in their first order,
/// and the rest follow by note. The order is load-bearing: a pad plays the
/// kit's sample at its own index until a sample is loaded over it, so a
/// Project saved with the first eight still hears the same eight sounds.
pub const STARTER_KIT: [KitPad; 22] = [
    pad!("Kick", 36, 0, "kick"),
    pad!("Snare", 38, 0, "snare"),
    pad!("Clap", 39, 0, "clap"),
    pad!("Closed Hat", 42, 1, "closed-hat"),
    pad!("Open Hat", 46, 1, "open-hat"),
    pad!("Low Tom", 45, 0, "low-tom"),
    pad!("High Tom", 48, 0, "high-tom"),
    pad!("Cowbell", 56, 0, "cowbell"),
    pad!("Hard Kick", 35, 0, "hard-kick"),
    pad!("Rimshot", 37, 0, "rimshot"),
    pad!("Electric Snare", 40, 0, "electric-snare"),
    pad!("Low Floor Tom", 41, 0, "low-floor-tom"),
    pad!("Pedal Hat", 44, 1, "pedal-hat"),
    pad!("Mid Tom", 47, 0, "mid-tom"),
    pad!("Crash", 49, 0, "crash"),
    pad!("Ride", 51, 0, "ride"),
    pad!("Tambourine", 54, 0, "tambourine"),
    pad!("Splash", 55, 0, "splash"),
    pad!("Hi Conga", 62, 0, "hi-conga"),
    pad!("Low Conga", 64, 0, "low-conga"),
    pad!("Maracas", 70, 0, "maracas"),
    pad!("Claves", 75, 0, "claves"),
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
            // Normalised with headroom: under 0 dBFS, never clipped.
            assert!(peak < 0.99, "{} clips: {peak}", pad.name);
            // Short, like a drum machine's one-shots, so the kit stays small.
            assert!(
                sample.frames() <= 48_000 * 6 / 5,
                "{} is too long",
                pad.name
            );
            // It fades out, rather than stopping on a step.
            let last = sample.at(sample.frames() - 1, 0).abs();
            assert!(last < 0.01, "{} ends on {last}", pad.name);
        }
    }

    /// How much of a sample's energy is in the band a one-pole split at
    /// `hz` leaves above it: near 0 for a boom, near 1 for a hiss.
    fn brightness(wav: &[u8], hz: f32) -> f32 {
        let sample = wav::decode(wav).unwrap();
        let k = (-std::f32::consts::TAU * hz / sample.rate()).exp();
        let (mut low, mut all, mut high) = (0.0_f32, 0.0_f32, 0.0_f32);
        for f in 0..sample.frames() {
            let x = sample.at(f, 0);
            low = x * (1.0 - k) + low * k;
            all += x * x;
            high += (x - low) * (x - low);
        }
        high / all
    }

    fn pad(name: &str) -> KitPad {
        *STARTER_KIT.iter().find(|p| p.name == name).unwrap()
    }

    #[test]
    fn the_pads_sound_like_what_they_are_called() {
        // Drums are low, cymbals and shakers are bright.
        for low in [
            "Kick",
            "Hard Kick",
            "Low Floor Tom",
            "Low Tom",
            "Mid Tom",
            "Low Conga",
        ] {
            let b = brightness(pad(low).wav, 1_000.0);
            assert!(b < 0.2, "{low} should be a low sound: {b}");
        }
        for bright in [
            "Pedal Hat",
            "Crash",
            "Ride",
            "Splash",
            "Tambourine",
            "Maracas",
        ] {
            let b = brightness(pad(bright).wav, 2_000.0);
            assert!(b > 0.5, "{bright} should be a bright sound: {b}");
        }
        // No two pads are the same sound.
        for (i, a) in STARTER_KIT.iter().enumerate() {
            for b in &STARTER_KIT[i + 1..] {
                assert_ne!(a.wav, b.wav, "{} and {}", a.name, b.name);
            }
        }
    }

    #[test]
    fn the_hard_kick_is_long_loud_and_driven() {
        let rms = |wav: &[u8], from: f32, to: f32| {
            let sample = wav::decode(wav).unwrap();
            let range = (from * sample.rate()) as usize..(to * sample.rate()) as usize;
            let len = range.len() as f32;
            (range.map(|f| sample.at(f, 0).powi(2)).sum::<f32>() / len).sqrt()
        };
        let hard = pad("Hard Kick").wav;
        let kick = pad("Kick").wav;
        // Its tail still booms well after the Kick's has gone.
        assert!(rms(hard, 0.3, 0.4) > 3.0 * rms(kick, 0.3, 0.4));
        // Driven into a clip, it spends much of its body near full scale.
        let sample = wav::decode(hard).unwrap();
        let body = (0..frames_at(0.3))
            .filter(|&f| sample.at(f, 0).abs() > 0.6)
            .count();
        assert!(body > frames_at(0.3) / 3, "{body}");
    }

    fn frames_at(seconds: f32) -> usize {
        (seconds * 48_000.0) as usize
    }

    #[test]
    fn the_kit_covers_a_drum_machine_and_its_notes_are_its_own() {
        assert_eq!(STARTER_KIT.len(), 22);
        assert!(STARTER_KIT.len() <= super::super::MAX_PADS);
        // The kit as it first shipped leads, in its first order.
        let first: Vec<&str> = STARTER_KIT[..8].iter().map(|p| p.name).collect();
        assert_eq!(
            first,
            [
                "Kick",
                "Snare",
                "Clap",
                "Closed Hat",
                "Open Hat",
                "Low Tom",
                "High Tom",
                "Cowbell"
            ]
        );
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
        assert_eq!(choked, ["Closed Hat", "Open Hat", "Pedal Hat"]);
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

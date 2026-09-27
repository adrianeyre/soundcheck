//! Instruments: built-in sound sources that turn notes into audio.
//!
//! Every Instrument renders stereo, because the Drum Sampler pans each pad
//! for itself. The Synth is the same on both sides.

mod kit;
mod plugin;
mod sampler;
mod synth;
mod wav;

pub use kit::starter_kit_json;
pub use plugin::PluginInstrument;
pub use sampler::{DrumSampler, MAX_PADS, PadParam, PadSettings};

/// How many pads the bundled starter kit has.
pub const STARTER_KIT_PADS: usize = kit::STARTER_KIT.len();
pub use synth::{
    PARAMS, Param, Preset, Synth, SynthSettings, factory_presets, parameters_json, presets_json,
};
pub use wav::{Sample, WavError, decode};

/// The bundled kit's own sample for pad `pad`, decoded, or `None` for a pad
/// the kit doesn't reach. Decoding allocates, so a native host calls this on
/// the control side and hands the result to the audio thread.
pub fn kit_sample(pad: usize) -> Option<Sample> {
    decode(kit::STARTER_KIT.get(pad)?.wav).ok()
}

/// The Instrument one Instrument Track owns.
#[derive(Debug)]
pub enum Instrument {
    Synth(Synth),
    Drums(DrumSampler),
    /// An Instrument Plugin's instance (ADR 0003).
    Plugin(PluginInstrument),
    /// The place of an Instrument Plugin with this id that this host
    /// doesn't have: it is silent.
    Missing(String),
}

impl Instrument {
    pub fn synth(sample_rate: f32) -> Self {
        Self::Synth(Synth::new(sample_rate, SynthSettings::default()))
    }

    /// The Drum Sampler with `pads` pads, the bundled starter kit on as many
    /// of them as it reaches: a Project's Drum Sampler has 8 to 16 (PRD #10).
    pub fn drum_sampler(sample_rate: f32, pads: usize) -> Self {
        Self::Drums(DrumSampler::starter_kit(sample_rate, pads))
    }

    /// The name the UI and the Project use for this kind of Instrument:
    /// "plugin" for any Plugin, and "missing" for one this host hasn't got.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Synth(_) => "synth",
            Self::Drums(_) => "drumSampler",
            Self::Plugin(_) => "plugin",
            Self::Missing(_) => "missing",
        }
    }

    /// What the UI calls it: its kind, "plugin:<id>" for a Plugin, or
    /// "missing:<id>" for one this host doesn't have.
    pub fn name(&self) -> String {
        match self {
            Self::Plugin(plugin) => format!("plugin:{}", plugin.plugin().manifest().id),
            Self::Missing(id) => format!("missing:{id}"),
            _ => self.kind().to_string(),
        }
    }

    /// The Plugin, when that is what this is.
    pub fn plugin(&self) -> Option<&PluginInstrument> {
        match self {
            Self::Plugin(plugin) => Some(plugin),
            _ => None,
        }
    }

    pub fn plugin_mut(&mut self) -> Option<&mut PluginInstrument> {
        match self {
            Self::Plugin(plugin) => Some(plugin),
            _ => None,
        }
    }

    /// The Instrument the UI names, or `None` if it names neither, with
    /// `pads` pads where that is the Drum Sampler: the Project says how many
    /// its kit has and the engine follows. Ignored by every other Instrument.
    pub fn named(kind: &str, sample_rate: f32, pads: usize) -> Option<Self> {
        match kind {
            "synth" => Some(Self::synth(sample_rate)),
            "drumSampler" => Some(Self::drum_sampler(sample_rate, pads)),
            _ => None,
        }
    }

    /// How many pads this Instrument has, or `None` where it has no pads.
    pub fn pad_count(&self) -> Option<usize> {
        match self {
            Self::Drums(drums) => Some(drums.pad_count()),
            _ => None,
        }
    }

    pub fn note_on(&mut self, note: u8, velocity: f32) {
        match self {
            Self::Synth(synth) => synth.note_on(note, velocity),
            Self::Drums(drums) => drums.note_on(note, velocity),
            Self::Plugin(plugin) => plugin.note_on(note, velocity),
            Self::Missing(_) => {}
        }
    }

    pub fn note_off(&mut self, note: u8) {
        match self {
            Self::Synth(synth) => synth.note_off(note),
            Self::Drums(drums) => drums.note_off(note),
            Self::Plugin(plugin) => plugin.note_off(note),
            Self::Missing(_) => {}
        }
    }

    /// Voices sounding. A Plugin doesn't say, so it counts none.
    pub fn active_voices(&self) -> usize {
        match self {
            Self::Synth(synth) => synth.active_voices(),
            Self::Drums(drums) => drums.active_voices(),
            Self::Plugin(_) | Self::Missing(_) => 0,
        }
    }

    /// The Drum Sampler, when that is what this is: pads only make sense
    /// there.
    pub fn drums_mut(&mut self) -> Option<&mut DrumSampler> {
        match self {
            Self::Drums(drums) => Some(drums),
            _ => None,
        }
    }

    /// The Synth's settings, when the Synth is what this is: settings and
    /// Presets only make sense there.
    pub fn synth_settings(&self) -> Option<SynthSettings> {
        match self {
            Self::Synth(synth) => Some(synth.settings()),
            _ => None,
        }
    }

    /// The Synth, when that is what this is, to change its settings.
    pub fn synth_mut(&mut self) -> Option<&mut Synth> {
        match self {
            Self::Synth(synth) => Some(synth),
            _ => None,
        }
    }

    /// Render the next `left.len()` frames, replacing what is there. A
    /// Plugin's settings follow their Automation where `ticks` says where in
    /// the song each frame is; the Synth's are the Track's to move.
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32], ticks: &[f64]) {
        match self {
            Self::Synth(synth) => {
                synth.render(left);
                right.copy_from_slice(left);
            }
            Self::Drums(drums) => drums.render(left, right),
            Self::Plugin(plugin) => plugin.render(left, right, ticks),
            Self::Missing(_) => {
                left.fill(0.0);
                right.fill(0.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::peak;

    const RATE: f32 = 48_000.0;

    fn render(instrument: &mut Instrument, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut left = vec![0.0; frames];
        let mut right = vec![0.0; frames];
        instrument.render(&mut left, &mut right, &[]);
        (left, right)
    }

    #[test]
    fn the_synth_plays_the_same_on_both_sides() {
        let mut instrument = Instrument::synth(RATE);
        instrument.note_on(60, 1.0);
        let (left, right) = render(&mut instrument, 4_800);
        assert!(peak(&left) > 0.05);
        assert_eq!(left, right);
    }

    #[test]
    fn each_instrument_is_named_and_built_by_name() {
        assert_eq!(Instrument::synth(RATE).kind(), "synth");
        assert_eq!(
            Instrument::drum_sampler(RATE, STARTER_KIT_PADS).kind(),
            "drumSampler"
        );
        assert!(Instrument::named("drumSampler", RATE, STARTER_KIT_PADS).is_some());
        assert!(Instrument::named("sampler", RATE, STARTER_KIT_PADS).is_none());
    }

    #[test]
    fn only_the_synth_has_settings() {
        assert!(Instrument::synth(RATE).synth_settings().is_some());
        assert!(
            Instrument::drum_sampler(RATE, STARTER_KIT_PADS)
                .synth_settings()
                .is_none()
        );
        assert!(
            Instrument::drum_sampler(RATE, STARTER_KIT_PADS)
                .synth_mut()
                .is_none()
        );
    }

    #[test]
    fn only_the_drum_sampler_has_pads() {
        assert!(Instrument::synth(RATE).drums_mut().is_none());
        let mut drums = Instrument::drum_sampler(RATE, STARTER_KIT_PADS);
        assert_eq!(
            drums.drums_mut().unwrap().pad_count(),
            kit::STARTER_KIT.len()
        );
    }

    #[test]
    fn the_drum_sampler_plays_its_pads_and_ignores_note_offs() {
        let mut instrument = Instrument::drum_sampler(RATE, STARTER_KIT_PADS);
        instrument.note_on(36, 1.0);
        instrument.note_off(36);
        assert_eq!(instrument.active_voices(), 1);
        assert!(peak(&render(&mut instrument, 2_400).0) > 0.3);
    }
}

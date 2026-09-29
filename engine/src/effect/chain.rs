//! The Insert Chain: the ordered list of Effects on one mixer channel, each
//! of which can be bypassed.
//!
//! Every Effect works on the stereo signal in place, in chain order. The
//! chain has room for `MAX_EFFECTS` from the start and keeps its own scratch
//! buffers, so adding, removing, reordering and processing Effects allocate
//! nothing once `prepare` has sized it: a native host builds an Effect off
//! the audio thread and only moves it in.

use super::delay::DEFAULT_TEMPO;
use super::params::{Param, Settings, table_json};
use super::stereo::InPlace;
use super::{
    AUTO_PAN_PARAMS, AUTO_WAH_PARAMS, AutoPan, AutoWah, BEAT_REPEAT_PARAMS, BITCRUSHER_PARAMS,
    BeatRepeat, Bitcrusher, BitcrusherSettings, CHORUS_PARAMS, CLIPPER_PARAMS, COMPRESSOR_PARAMS,
    Chorus, ChorusSettings, Clipper, Compressor, CompressorSettings, DE_ESSER_PARAMS, DELAY_PARAMS,
    DeEsser, Delay, DelaySettings, EQ_PARAMS, EXCITER_PARAMS, Eq, EqSettings, Exciter,
    FILTER_PARAMS, FLANGER_PARAMS, FREQ_SHIFT_PARAMS, Filter, FilterSettings, Flanger,
    FrequencyShifter, GATE_PARAMS, Gate, GateSettings, HAAS_PARAMS, Haas, LIMITER_PARAMS,
    LOFI_PARAMS, Limiter, LimiterSettings, LoFi, MULTIBAND_PARAMS, Multiband, PHASER_PARAMS,
    PITCH_SHIFT_PARAMS, PUMP_PARAMS, Phaser, PhaserSettings, PitchShifter, Pump, RESONATOR_PARAMS,
    REVERB_PARAMS, RING_MOD_PARAMS, Resonator, Reverb, ReverbSettings, RingMod, SATURATOR_PARAMS,
    Saturator, SaturatorSettings, TRANCE_GATE_PARAMS, TRANSIENT_PARAMS, TREMOLO_PARAMS, TranceGate,
    TransientShaper, Tremolo, UTILITY_PARAMS, Utility, UtilitySettings, VIBRATO_PARAMS,
    VOWEL_PARAMS, Vibrato, Vowel,
};
use crate::automation::{Automation, TableAutomation};
use crate::plugin::HostedPlugin;

/// The most Effects one Insert Chain holds.
pub const MAX_EFFECTS: usize = 16;

/// Declares `EffectKind`, one variant per built-in Effect, from each one's
/// variant, the name the Project and the UI use, and its settings table.
macro_rules! effect_kinds {
    ($($kind:ident $name:literal $params:ident;)*) => {
        /// Which Effect: the names are the ones the Project and the UI use.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum EffectKind {
            $($kind,)*
        }

        impl EffectKind {
            pub const ALL: [EffectKind; [$(stringify!($kind)),*].len()] = [$(Self::$kind),*];

            pub fn name(self) -> &'static str {
                match self {
                    $(Self::$kind => $name,)*
                }
            }

            /// This Effect's settings table, as JSON.
            fn table_json(self) -> String {
                match self {
                    $(Self::$kind => table_json($params),)*
                }
            }

            /// Where the setting called `name` is in this Effect's table, if it is
            /// one Automation can move: a number, not a switch or a choice.
            pub fn automatable(self, name: &str) -> Option<usize> {
                fn find<S>(params: &[Param<S>], name: &str) -> Option<usize> {
                    params
                        .iter()
                        .position(|p| p.name == name && p.choices.is_empty())
                }
                match self {
                    $(Self::$kind => find($params, name),)*
                }
            }

            /// How many settings this Effect has.
            pub fn param_count(self) -> usize {
                match self {
                    $(Self::$kind => $params.len(),)*
                }
            }

            /// The names of this Effect's settings, in table order.
            #[cfg(test)]
            fn param_names(self) -> Vec<&'static str> {
                match self {
                    $(Self::$kind => $params.iter().map(|p| p.name).collect(),)*
                }
            }

            /// Each of this Effect's settings' least and greatest values, in
            /// table order.
            #[cfg(test)]
            fn param_ranges(self) -> Vec<(f32, f32)> {
                match self {
                    $(Self::$kind => $params.iter().map(|p| (p.min, p.max)).collect(),)*
                }
            }
        }
    };
}

effect_kinds! {
    Eq "eq" EQ_PARAMS;
    Compressor "compressor" COMPRESSOR_PARAMS;
    Reverb "reverb" REVERB_PARAMS;
    Delay "delay" DELAY_PARAMS;
    Saturator "saturator" SATURATOR_PARAMS;
    Chorus "chorus" CHORUS_PARAMS;
    Phaser "phaser" PHASER_PARAMS;
    Filter "filter" FILTER_PARAMS;
    Gate "gate" GATE_PARAMS;
    Limiter "limiter" LIMITER_PARAMS;
    Bitcrusher "bitcrusher" BITCRUSHER_PARAMS;
    Utility "utility" UTILITY_PARAMS;
    Flanger "flanger" FLANGER_PARAMS;
    Tremolo "tremolo" TREMOLO_PARAMS;
    AutoPan "autopan" AUTO_PAN_PARAMS;
    RingMod "ringmod" RING_MOD_PARAMS;
    TransientShaper "transient" TRANSIENT_PARAMS;
    DeEsser "deesser" DE_ESSER_PARAMS;
    Exciter "exciter" EXCITER_PARAMS;
    Vibrato "vibrato" VIBRATO_PARAMS;
    FrequencyShifter "freqshift" FREQ_SHIFT_PARAMS;
    AutoWah "autowah" AUTO_WAH_PARAMS;
    Haas "haas" HAAS_PARAMS;
    Multiband "multiband" MULTIBAND_PARAMS;
    Pump "pump" PUMP_PARAMS;
    TranceGate "trancegate" TRANCE_GATE_PARAMS;
    PitchShifter "pitchshift" PITCH_SHIFT_PARAMS;
    Resonator "resonator" RESONATOR_PARAMS;
    Clipper "clipper" CLIPPER_PARAMS;
    LoFi "lofi" LOFI_PARAMS;
    BeatRepeat "beatrepeat" BEAT_REPEAT_PARAMS;
    Vowel "vowel" VOWEL_PARAMS;
}

/// Declares `in_place`, which makes each built-in Effect that is a
/// `StereoEffect`: the chain runs them all the same way.
macro_rules! in_place_kinds {
    ($($kind:ident;)*) => {
        /// `kind` at its default settings, if it is a `StereoEffect`.
        fn in_place(kind: EffectKind, sample_rate: f32) -> Option<Box<dyn InPlace>> {
            match kind {
                $(EffectKind::$kind => Some(Box::new($kind::new(sample_rate, Settings::defaults()))),)*
                _ => None,
            }
        }

        /// `kind` made with the settings `values` in their flat form, if it
        /// is a `StereoEffect`.
        #[cfg(test)]
        fn in_place_made_with(
            kind: EffectKind,
            sample_rate: f32,
            values: &[f32],
        ) -> Option<Box<dyn InPlace>> {
            match kind {
                $(EffectKind::$kind => Some(Box::new($kind::new(sample_rate, Settings::from_flat(values)))),)*
                _ => None,
            }
        }
    };
}

in_place_kinds! {
    Flanger;
    Tremolo;
    AutoPan;
    RingMod;
    TransientShaper;
    DeEsser;
    Exciter;
    Vibrato;
    FrequencyShifter;
    AutoWah;
    Haas;
    Multiband;
    Pump;
    TranceGate;
    PitchShifter;
    Resonator;
    Clipper;
    LoFi;
    BeatRepeat;
    Vowel;
}

impl EffectKind {
    pub fn named(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.name() == name)
    }
}

/// Every Effect's settings table as JSON, keyed by the Effect's name.
pub fn effect_parameters_json() -> String {
    let tables = EffectKind::ALL
        .iter()
        .map(|kind| format!(r#""{}":{}"#, kind.name(), kind.table_json()))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{tables}}}")
}

// Every Effect is boxed in its chain already, so the variants' sizes don't
// matter; boxing the EQ again would only add a pointer to follow.
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
enum Processor {
    Eq(Eq),
    Compressor(Compressor),
    Reverb(Reverb),
    Delay(Delay),
    Saturator(Saturator),
    Chorus(Chorus),
    Phaser(Phaser),
    Filter(Filter),
    Gate(Gate),
    Limiter(Limiter),
    Bitcrusher(Bitcrusher),
    Utility(Utility),
    /// Every other built-in, which works in place as a `StereoEffect`.
    InPlace(EffectKind, Box<dyn InPlace>),
    Plugin(HostedPlugin),
    /// A Plugin this host doesn't have, by its id: the signal passes it
    /// untouched and it has no settings, so the Project keeps them.
    Missing(String),
}

impl Processor {
    fn get(&self, index: usize) -> f32 {
        match self {
            Processor::Eq(eq) => EQ_PARAMS[index].get(&eq.settings()),
            Processor::Compressor(c) => COMPRESSOR_PARAMS[index].get(&c.settings()),
            Processor::Reverb(reverb) => REVERB_PARAMS[index].get(&reverb.settings()),
            Processor::Delay(delay) => DELAY_PARAMS[index].get(&delay.settings()),
            Processor::Saturator(effect) => SATURATOR_PARAMS[index].get(&effect.settings()),
            Processor::Chorus(effect) => CHORUS_PARAMS[index].get(&effect.settings()),
            Processor::Phaser(effect) => PHASER_PARAMS[index].get(&effect.settings()),
            Processor::Filter(effect) => FILTER_PARAMS[index].get(&effect.settings()),
            Processor::Gate(effect) => GATE_PARAMS[index].get(&effect.settings()),
            Processor::Limiter(effect) => LIMITER_PARAMS[index].get(&effect.settings()),
            Processor::Bitcrusher(effect) => BITCRUSHER_PARAMS[index].get(&effect.settings()),
            Processor::Utility(effect) => UTILITY_PARAMS[index].get(&effect.settings()),
            Processor::InPlace(_, effect) => effect.get(index),
            Processor::Plugin(plugin) => plugin.get(index),
            Processor::Missing(_) => 0.0,
        }
    }

    /// Set the setting at `index`, as its table clamps and rounds it. Only a
    /// value that changes it is applied, so following a steady Automation
    /// costs nothing. Allocates nothing.
    fn set(&mut self, index: usize, value: f32) {
        fn changed<S: Copy>(
            params: &[Param<S>],
            settings: S,
            index: usize,
            value: f32,
        ) -> Option<S> {
            let param = params[index];
            let mut next = settings;
            param.set(&mut next, value);
            (param.get(&next) != param.get(&settings)).then_some(next)
        }
        match self {
            Processor::Eq(eq) => {
                if let Some(next) = changed(EQ_PARAMS, eq.settings(), index, value) {
                    eq.set_settings(next);
                }
            }
            Processor::Compressor(c) => {
                if let Some(next) = changed(COMPRESSOR_PARAMS, c.settings(), index, value) {
                    c.set_settings(next);
                }
            }
            Processor::Reverb(reverb) => {
                if let Some(next) = changed(REVERB_PARAMS, reverb.settings(), index, value) {
                    reverb.set_settings(next);
                }
            }
            Processor::Delay(delay) => {
                if let Some(next) = changed(DELAY_PARAMS, delay.settings(), index, value) {
                    delay.set_settings(next);
                }
            }
            Processor::Saturator(effect) => {
                if let Some(next) = changed(SATURATOR_PARAMS, effect.settings(), index, value) {
                    effect.set_settings(next);
                }
            }
            Processor::Chorus(effect) => {
                if let Some(next) = changed(CHORUS_PARAMS, effect.settings(), index, value) {
                    effect.set_settings(next);
                }
            }
            Processor::Phaser(effect) => {
                if let Some(next) = changed(PHASER_PARAMS, effect.settings(), index, value) {
                    effect.set_settings(next);
                }
            }
            Processor::Filter(effect) => {
                if let Some(next) = changed(FILTER_PARAMS, effect.settings(), index, value) {
                    effect.set_settings(next);
                }
            }
            Processor::Gate(effect) => {
                if let Some(next) = changed(GATE_PARAMS, effect.settings(), index, value) {
                    effect.set_settings(next);
                }
            }
            Processor::Limiter(effect) => {
                if let Some(next) = changed(LIMITER_PARAMS, effect.settings(), index, value) {
                    effect.set_settings(next);
                }
            }
            Processor::Bitcrusher(effect) => {
                if let Some(next) = changed(BITCRUSHER_PARAMS, effect.settings(), index, value) {
                    effect.set_settings(next);
                }
            }
            Processor::Utility(effect) => {
                if let Some(next) = changed(UTILITY_PARAMS, effect.settings(), index, value) {
                    effect.set_settings(next);
                }
            }
            Processor::InPlace(_, effect) => effect.set(index, value),
            Processor::Plugin(plugin) => plugin.set(index, value),
            Processor::Missing(_) => {}
        }
    }
}

/// One Effect in an Insert Chain.
#[derive(Debug)]
pub struct Effect {
    processor: Processor,
    bypassed: bool,
    /// Its settings as the host last set them. An automated setting follows
    /// its Automation instead, and goes back to this when that is taken
    /// away.
    fixed: Vec<f32>,
    /// What moves its settings while the song plays. It is the Effect's, so
    /// it moves with the Effect and goes when the Effect does.
    automation: TableAutomation,
    /// Whether it has processed a block yet. Until it has, its settings
    /// arrive without gliding: it is being loaded, not changed.
    started: bool,
    /// The tick of the last frame it processed while the song moved, to
    /// tell whether a block of one frame moved on from it.
    last_tick: Option<f64>,
}

impl Effect {
    /// An Effect with its default settings, not bypassed.
    pub fn new(kind: EffectKind, sample_rate: f32) -> Self {
        if let Some(effect) = in_place(kind, sample_rate) {
            return Self::hosting(Processor::InPlace(kind, effect), kind.param_count());
        }
        let processor = match kind {
            EffectKind::Eq => Processor::Eq(Eq::new(sample_rate, EqSettings::default())),
            EffectKind::Compressor => {
                Processor::Compressor(Compressor::new(sample_rate, CompressorSettings::defaults()))
            }
            EffectKind::Reverb => {
                Processor::Reverb(Reverb::new(sample_rate, ReverbSettings::defaults()))
            }
            EffectKind::Delay => {
                Processor::Delay(Delay::new(sample_rate, DelaySettings::defaults()))
            }
            EffectKind::Saturator => {
                Processor::Saturator(Saturator::new(sample_rate, SaturatorSettings::defaults()))
            }
            EffectKind::Chorus => {
                Processor::Chorus(Chorus::new(sample_rate, ChorusSettings::defaults()))
            }
            EffectKind::Phaser => {
                Processor::Phaser(Phaser::new(sample_rate, PhaserSettings::defaults()))
            }
            EffectKind::Filter => {
                Processor::Filter(Filter::new(sample_rate, FilterSettings::defaults()))
            }
            EffectKind::Gate => Processor::Gate(Gate::new(sample_rate, GateSettings::defaults())),
            EffectKind::Limiter => {
                Processor::Limiter(Limiter::new(sample_rate, LimiterSettings::defaults()))
            }
            EffectKind::Bitcrusher => {
                Processor::Bitcrusher(Bitcrusher::new(BitcrusherSettings::defaults()))
            }
            EffectKind::Utility => Processor::Utility(Utility::new(UtilitySettings::defaults())),
            _ => unreachable!("{} works in place", kind.name()),
        };
        Self::hosting(processor, kind.param_count())
    }

    /// A Plugin's instance in a slot, at its default settings.
    pub fn plugin(plugin: HostedPlugin) -> Self {
        let count = plugin.manifest().settings.len();
        Self::hosting(Processor::Plugin(plugin), count)
    }

    /// The slot of a Plugin with the id `id` that this host doesn't have:
    /// it passes the signal through untouched.
    pub fn missing_plugin(id: &str) -> Self {
        Self::hosting(Processor::Missing(id.to_string()), 0)
    }

    fn hosting(processor: Processor, param_count: usize) -> Self {
        let mut effect = Self {
            processor,
            bypassed: false,
            fixed: vec![0.0; param_count],
            automation: TableAutomation::new(param_count),
            started: false,
            last_tick: None,
        };
        effect.keep_fixed();
        effect
    }

    /// Where the setting called `name` is in this Effect's table, if
    /// Automation can move it: any of a Plugin's, a built-in's numbers.
    fn automatable(&self, name: &str) -> Option<usize> {
        match &self.processor {
            Processor::Plugin(plugin) => plugin.manifest().setting_index(name),
            Processor::Missing(_) => None,
            _ => self.kind()?.automatable(name),
        }
    }

    fn keep_fixed(&mut self) {
        for (index, value) in self.fixed.iter_mut().enumerate() {
            *value = self.processor.get(index);
        }
    }

    /// Replace the Automation of the setting called `param`, handing back
    /// the old one, or `automation` itself when this Effect has no such
    /// setting to automate. Taking a setting's Automation away puts it back
    /// at its fixed value. Allocates nothing.
    pub fn set_automation(&mut self, param: &str, automation: Automation) -> Automation {
        let Some(index) = self.automatable(param) else {
            return automation;
        };
        let old = self.automation.set(index, automation);
        self.processor.set(index, self.fixed[index]);
        old
    }

    /// The tick of the first breakpoint at or after `from`, of any setting.
    pub fn next_breakpoint(&self, from: u64) -> Option<u64> {
        self.automation.next_point(from)
    }

    /// Which built-in it is, or none for a Plugin.
    pub fn kind(&self) -> Option<EffectKind> {
        match self.processor {
            Processor::Eq(_) => Some(EffectKind::Eq),
            Processor::Compressor(_) => Some(EffectKind::Compressor),
            Processor::Reverb(_) => Some(EffectKind::Reverb),
            Processor::Delay(_) => Some(EffectKind::Delay),
            Processor::Saturator(_) => Some(EffectKind::Saturator),
            Processor::Chorus(_) => Some(EffectKind::Chorus),
            Processor::Phaser(_) => Some(EffectKind::Phaser),
            Processor::Filter(_) => Some(EffectKind::Filter),
            Processor::Gate(_) => Some(EffectKind::Gate),
            Processor::Limiter(_) => Some(EffectKind::Limiter),
            Processor::Bitcrusher(_) => Some(EffectKind::Bitcrusher),
            Processor::Utility(_) => Some(EffectKind::Utility),
            Processor::InPlace(kind, _) => Some(kind),
            Processor::Plugin(_) | Processor::Missing(_) => None,
        }
    }

    /// What the UI calls it: a built-in's name, "plugin:<id>" for a Plugin
    /// or "missing:<id>" for one this host doesn't have.
    pub fn name(&self) -> String {
        match &self.processor {
            Processor::Plugin(plugin) => format!("plugin:{}", plugin.manifest().id),
            Processor::Missing(id) => format!("missing:{id}"),
            _ => self
                .kind()
                .map(EffectKind::name)
                .unwrap_or_default()
                .to_string(),
        }
    }

    /// Whether it is a Plugin that faulted, and so is bypassed for good.
    pub fn faulted(&self) -> bool {
        matches!(&self.processor, Processor::Plugin(plugin) if plugin.faulted())
    }

    pub fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }

    /// Change the settings from their flat form: one value per setting, in
    /// the Effect's table order, out-of-range values clamped and missing
    /// ones at their default. An Effect that hasn't processed a block yet
    /// takes them at once, so a loaded one doesn't glide from its defaults
    /// to the Project's settings; after that, they glide. Allocates nothing.
    pub fn set_flat(&mut self, values: &[f32]) {
        match &mut self.processor {
            Processor::Eq(eq) => eq.set_settings(EqSettings::from_flat(values)),
            Processor::Compressor(compressor) => {
                compressor.set_settings(CompressorSettings::from_flat(values))
            }
            Processor::Reverb(reverb) => reverb.set_settings(ReverbSettings::from_flat(values)),
            Processor::Delay(delay) => delay.set_settings(DelaySettings::from_flat(values)),
            Processor::Saturator(effect) => {
                effect.set_settings(SaturatorSettings::from_flat(values))
            }
            Processor::Chorus(effect) => effect.set_settings(ChorusSettings::from_flat(values)),
            Processor::Phaser(effect) => effect.set_settings(PhaserSettings::from_flat(values)),
            Processor::Filter(effect) => effect.set_settings(FilterSettings::from_flat(values)),
            Processor::Gate(effect) => effect.set_settings(GateSettings::from_flat(values)),
            Processor::Limiter(effect) => effect.set_settings(LimiterSettings::from_flat(values)),
            Processor::Bitcrusher(effect) => {
                effect.set_settings(BitcrusherSettings::from_flat(values))
            }
            Processor::Utility(effect) => effect.set_settings(UtilitySettings::from_flat(values)),
            Processor::InPlace(_, effect) => effect.set_flat(values),
            Processor::Plugin(plugin) => {
                let count = plugin.manifest().settings.len();
                for index in 0..count {
                    let value = values.get(index).copied();
                    plugin.set(
                        index,
                        value.unwrap_or(plugin.manifest().settings[index].default),
                    );
                }
            }
            Processor::Missing(_) => {}
        }
        if !self.started {
            self.processor.settle();
        }
        self.keep_fixed();
    }

    /// The settings in their flat form, as the host set them: an automated
    /// setting gives its fixed value.
    pub fn to_flat(&self) -> Vec<f32> {
        self.fixed.clone()
    }

    /// The song's tempo where it is playing, which a Delay synced to a note
    /// value follows. Allocates nothing.
    pub fn set_tempo(&mut self, tempo: f64) {
        match &mut self.processor {
            Processor::Delay(delay) => delay.set_tempo(tempo),
            Processor::InPlace(_, effect) => effect.set_tempo(tempo),
            _ => {}
        }
    }

    /// The gain-reduction meter, in dB (0 or more): how far a Compressor
    /// pulled the level down in the latest block. 0 for an Effect that
    /// doesn't reduce gain, and for one that is bypassed.
    pub fn gain_reduction_db(&self) -> f32 {
        match &self.processor {
            Processor::Compressor(compressor) if !self.bypassed => compressor.meter_db(),
            Processor::Gate(gate) if !self.bypassed => gate.meter_db(),
            Processor::Limiter(limiter) if !self.bypassed => limiter.meter_db(),
            _ => 0.0,
        }
    }

    /// Process both sides in place, with the settings following their
    /// Automation when `ticks` says where in the song each frame is (see
    /// `TableAutomation::drive`), and an Effect synced to the song lining up
    /// with it. `scratch_left` and `scratch_right` are at least as long, for
    /// an Effect that can't work in place. The first block starts at the
    /// settings its Automation gives, without gliding to them.
    fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        scratch: (&mut [f32], &mut [f32]),
        ticks: &[f64],
    ) {
        if self.bypassed {
            return;
        }
        let (scratch_left, scratch_right) = scratch;
        let mut settle = !self.started;
        self.started = true;
        // The frames' ticks, or none when they don't say where each frame is.
        let ticks = if ticks.len() == left.len() {
            ticks
        } else {
            &[]
        };
        // An Effect synced to the song hears where it is only while it moves.
        let moving = match ticks {
            [] => false,
            [only] => self.last_tick.is_some_and(|last| last != *only),
            [first, .., last] => first != last,
        };
        self.last_tick = ticks.last().copied();
        let song = if moving { ticks } else { &[] };
        self.automation.drive(
            left.len(),
            ticks,
            &mut self.processor,
            |processor, index, value| processor.set(index, value),
            |processor, frames| {
                if std::mem::take(&mut settle) {
                    processor.settle();
                }
                let ticks = song.get(frames.clone()).unwrap_or_default();
                processor.process(
                    &mut left[frames.clone()],
                    &mut right[frames],
                    (scratch_left, scratch_right),
                    ticks,
                );
            },
        );
    }
}

impl Processor {
    /// Jump an Effect that works in place to its settings (see
    /// `StereoEffect::settle`).
    fn settle(&mut self) {
        if let Processor::InPlace(_, effect) = self {
            effect.settle();
        }
    }

    /// `ticks` is where in the song each frame is while it moves, or empty.
    fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        (scratch_left, scratch_right): (&mut [f32], &mut [f32]),
        ticks: &[f64],
    ) {
        match self {
            Processor::Eq(eq) => eq.process_stereo(left, right),
            Processor::Compressor(compressor) => compressor.process_stereo(left, right),
            Processor::Reverb(reverb) => {
                let input_left = &mut scratch_left[..left.len()];
                let input_right = &mut scratch_right[..right.len()];
                input_left.copy_from_slice(left);
                input_right.copy_from_slice(right);
                left.fill(0.0);
                right.fill(0.0);
                reverb.process_stereo_into(input_left, input_right, left, right, 1.0);
            }
            Processor::Delay(delay) => delay.process_stereo(left, right),
            Processor::Saturator(effect) => effect.process_stereo(left, right),
            Processor::Chorus(effect) => effect.process_stereo(left, right),
            Processor::Phaser(effect) => effect.process_stereo(left, right),
            Processor::Filter(effect) => effect.process_stereo(left, right),
            Processor::Gate(effect) => effect.process_stereo(left, right),
            Processor::Limiter(effect) => effect.process_stereo(left, right),
            Processor::Bitcrusher(effect) => effect.process_stereo(left, right),
            Processor::Utility(effect) => effect.process_stereo(left, right),
            Processor::InPlace(_, effect) => effect.process(left, right, ticks),
            Processor::Plugin(plugin) => plugin.process(left, right, (scratch_left, scratch_right)),
            Processor::Missing(_) => {}
        }
    }
}

/// The ordered list of Effects on one mixer channel.
#[derive(Debug)]
pub struct InsertChain {
    /// Boxed, so a host can move one in or out without copying it.
    #[allow(clippy::vec_box)]
    effects: Vec<Box<Effect>>,
    scratch_left: Vec<f32>,
    scratch_right: Vec<f32>,
    /// The song's tempo where it is playing, for an Effect synced to it.
    tempo: f64,
}

impl Default for InsertChain {
    fn default() -> Self {
        Self {
            effects: Vec::with_capacity(MAX_EFFECTS),
            scratch_left: Vec::new(),
            scratch_right: Vec::new(),
            tempo: DEFAULT_TEMPO,
        }
    }
}

impl InsertChain {
    /// Size the scratch buffers for blocks of up to `frames`.
    pub fn prepare(&mut self, frames: usize) {
        if self.scratch_left.len() < frames {
            self.scratch_left.resize(frames, 0.0);
            self.scratch_right.resize(frames, 0.0);
        }
    }

    /// The song's tempo where it is playing, in quarter notes per minute:
    /// a Delay synced to a note value follows it. The host sets it before
    /// each block it processes. Allocates nothing.
    pub fn set_tempo(&mut self, tempo: f64) {
        if tempo == self.tempo {
            return;
        }
        self.tempo = tempo;
        for effect in &mut self.effects {
            effect.set_tempo(tempo);
        }
    }

    pub fn len(&self) -> usize {
        self.effects.len()
    }

    pub fn is_empty(&self) -> bool {
        self.effects.is_empty()
    }

    pub fn effect(&self, index: usize) -> Option<&Effect> {
        self.effects.get(index).map(|effect| &**effect)
    }

    pub fn effect_mut(&mut self, index: usize) -> Option<&mut Effect> {
        self.effects.get_mut(index).map(|effect| &mut **effect)
    }

    /// Put `effect` at `index`, or at the end when `index` is past it.
    /// Handed back when the chain is full.
    pub fn insert(&mut self, index: usize, mut effect: Box<Effect>) -> Result<(), Box<Effect>> {
        if self.effects.len() >= MAX_EFFECTS {
            return Err(effect);
        }
        effect.set_tempo(self.tempo);
        let index = index.min(self.effects.len());
        self.effects.insert(index, effect);
        Ok(())
    }

    /// Take the Effect at `index` out of the chain, to be dropped off the
    /// audio thread.
    pub fn remove(&mut self, index: usize) -> Option<Box<Effect>> {
        (index < self.effects.len()).then(|| self.effects.remove(index))
    }

    /// Move the Effect at `from` to `to`, where `to` is its position once
    /// moved: the others keep their order. Out of range, nothing moves.
    pub fn move_effect(&mut self, from: usize, to: usize) {
        let len = self.effects.len();
        if from >= len || to >= len {
            return;
        }
        if from < to {
            self.effects[from..=to].rotate_left(1);
        } else {
            self.effects[to..=from].rotate_right(1);
        }
    }

    /// Run `left` and `right` through every Effect that isn't bypassed, in
    /// order, each at its fixed settings.
    #[cfg(test)]
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.process_at(left, right, &[]);
    }

    /// `process`, with every automated setting following its Automation and
    /// every Effect synced to the song lined up with its beats: `ticks` says
    /// where in the song each frame is, and has no breakpoint between its
    /// first and last. Without one tick per frame, neither happens.
    pub fn process_at(&mut self, left: &mut [f32], right: &mut [f32], ticks: &[f64]) {
        if self.is_empty() {
            return;
        }
        self.prepare(left.len());
        for effect in &mut self.effects {
            let scratch = (&mut self.scratch_left[..], &mut self.scratch_right[..]);
            effect.process(left, right, scratch, ticks);
        }
    }

    /// The tick of the first breakpoint at or after `from`, of any Effect.
    pub fn next_breakpoint(&self, from: u64) -> Option<u64> {
        self.effects
            .iter()
            .filter_map(|effect| effect.next_breakpoint(from))
            .min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::gain_to_db;
    use crate::dsp::measure::{max_jump, rms, sine};
    use crate::effect::stereo::song_ticks;

    const RATE: f32 = 48_000.0;

    fn effect(kind: EffectKind, settings: &[(&str, f32)]) -> Box<Effect> {
        let mut effect = Effect::new(kind, RATE);
        let mut flat = effect.to_flat();
        let params = kind.param_names();
        for (name, value) in settings {
            flat[params.iter().position(|p| p == name).unwrap()] = *value;
        }
        effect.set_flat(&flat);
        Box::new(effect)
    }

    /// A 1 kHz sine, run through `chain`, as (left, right).
    fn run(chain: &mut InsertChain) -> (Vec<f32>, Vec<f32>) {
        let mut left = sine(1_000.0, 0.5, RATE, 24_000);
        let mut right = left.clone();
        for (l, r) in left.chunks_mut(256).zip(right.chunks_mut(256)) {
            chain.process(l, r);
        }
        (left, right)
    }

    fn level_db(chain: &mut InsertChain) -> f32 {
        let (left, _) = run(chain);
        gain_to_db(rms(&left[12_000..]) / rms(&sine(1_000.0, 0.5, RATE, 12_000)))
    }

    fn cut() -> Box<Effect> {
        effect(
            EffectKind::Eq,
            &[("band2Hz", 1_000.0), ("band2GainDb", -12.0)],
        )
    }

    fn boost() -> Box<Effect> {
        effect(
            EffectKind::Eq,
            &[("band2Hz", 1_000.0), ("band2GainDb", 6.0)],
        )
    }

    #[test]
    fn an_empty_chain_passes_the_signal_untouched() {
        let mut chain = InsertChain::default();
        let (left, _) = run(&mut chain);
        assert_eq!(left, sine(1_000.0, 0.5, RATE, 24_000));
    }

    #[test]
    fn effects_run_in_order_and_bypass_and_removal_take_one_out() {
        let mut chain = InsertChain::default();
        chain.insert(0, cut()).unwrap();
        chain.insert(1, boost()).unwrap();
        assert!((level_db(&mut chain) - -6.0).abs() < 0.2);

        chain.effect_mut(0).unwrap().set_bypassed(true);
        assert!((level_db(&mut chain) - 6.0).abs() < 0.2, "only the boost");
        chain.effect_mut(0).unwrap().set_bypassed(false);

        let removed = chain.remove(1).unwrap();
        assert_eq!(removed.kind(), Some(EffectKind::Eq));
        assert!((level_db(&mut chain) - -12.0).abs() < 0.2, "only the cut");
        assert!(chain.remove(5).is_none());
    }

    #[test]
    fn reordering_changes_what_a_compressor_hears() {
        // A compressor after a 12 dB boost works much harder than one before
        // it, so the order is audible.
        let compressor = || {
            effect(
                EffectKind::Compressor,
                &[("thresholdDb", -20.0), ("ratio", 10.0), ("makeupDb", 0.0)],
            )
        };
        let loud = || {
            effect(
                EffectKind::Eq,
                &[("band2Hz", 1_000.0), ("band2GainDb", 12.0)],
            )
        };
        let mut chain = InsertChain::default();
        chain.insert(0, compressor()).unwrap();
        chain.insert(1, loud()).unwrap();
        let compressed_first = level_db(&mut chain);

        let mut chain = InsertChain::default();
        chain.insert(0, compressor()).unwrap();
        chain.insert(1, loud()).unwrap();
        chain.move_effect(0, 1);
        assert_eq!(chain.effect(0).unwrap().kind(), Some(EffectKind::Eq));
        let boosted_first = level_db(&mut chain);
        assert!(
            compressed_first > boosted_first + 3.0,
            "{compressed_first} dB against {boosted_first} dB"
        );
    }

    #[test]
    fn moving_keeps_the_others_in_order() {
        let mut chain = InsertChain::default();
        for kind in [EffectKind::Eq, EffectKind::Compressor, EffectKind::Reverb] {
            chain
                .insert(usize::MAX, Box::new(Effect::new(kind, RATE)))
                .unwrap();
        }
        let kinds = |chain: &InsertChain| {
            (0..chain.len())
                .map(|i| chain.effect(i).unwrap().name())
                .collect::<Vec<_>>()
        };
        chain.move_effect(0, 2);
        assert_eq!(kinds(&chain), ["compressor", "reverb", "eq"]);
        chain.move_effect(2, 0);
        assert_eq!(kinds(&chain), ["eq", "compressor", "reverb"]);
        chain.move_effect(1, 9);
        assert_eq!(
            kinds(&chain),
            ["eq", "compressor", "reverb"],
            "out of range"
        );
    }

    #[test]
    fn a_reverb_in_the_chain_leaves_a_tail() {
        let mut chain = InsertChain::default();
        chain
            .insert(0, Box::new(Effect::new(EffectKind::Reverb, RATE)))
            .unwrap();
        let mut left = vec![0.0; 9_600];
        let mut right = vec![0.0; 9_600];
        left[0] = 1.0;
        right[0] = 1.0;
        chain.process(&mut left, &mut right);
        assert!(rms(&left[4_800..]) > 1e-4, "the tail rings on");
    }

    #[test]
    fn a_compressor_meters_its_gain_reduction_and_nothing_else_does() {
        let mut chain = InsertChain::default();
        chain.insert(0, cut()).unwrap();
        chain
            .insert(
                1,
                effect(
                    EffectKind::Compressor,
                    &[
                        ("thresholdDb", -26.0),
                        ("ratio", 4.0),
                        ("attack", 0.1),
                        ("kneeDb", 0.0),
                    ],
                ),
            )
            .unwrap();
        // 0.5 is -6 dBFS, cut to -18: 8 dB over, so 6 dB of reduction at
        // the peaks.
        run(&mut chain);
        assert_eq!(chain.effect(0).unwrap().gain_reduction_db(), 0.0);
        let meter = chain.effect(1).unwrap().gain_reduction_db();
        assert!((meter - 6.0).abs() < 0.5, "{meter} dB");

        chain.effect_mut(1).unwrap().set_bypassed(true);
        assert_eq!(chain.effect(1).unwrap().gain_reduction_db(), 0.0);
    }

    /// Where the first repeat of an impulse comes out of `chain`.
    fn first_repeat(chain: &mut InsertChain) -> usize {
        let mut left = vec![0.0; 50_000];
        let mut right = vec![0.0; 50_000];
        left[0] = 1.0;
        chain.process(&mut left, &mut right);
        left.iter().skip(1).position(|s| s.abs() > 0.1).unwrap() + 1
    }

    #[test]
    fn a_synced_delay_follows_the_chains_tempo() {
        let wet = || effect(EffectKind::Delay, &[("mix", 1.0), ("highCutHz", 20_000.0)]);
        let mut chain = InsertChain::default();
        chain.set_tempo(60.0);
        chain.insert(0, wet()).unwrap();
        // A quarter note at 60 is a second, whenever the Delay came in.
        assert_eq!(first_repeat(&mut chain), 48_000);

        let mut chain = InsertChain::default();
        chain.insert(0, wet()).unwrap();
        chain.set_tempo(240.0);
        assert_eq!(first_repeat(&mut chain), 12_000);
    }

    #[test]
    fn the_chain_is_full_at_its_limit() {
        let mut chain = InsertChain::default();
        for _ in 0..MAX_EFFECTS {
            chain.insert(0, cut()).unwrap();
        }
        assert!(chain.insert(0, cut()).is_err());
    }

    #[test]
    fn every_table_is_published() {
        let json = effect_parameters_json();
        assert!(json.starts_with(r#"{"eq":[{"name":"lowCut""#), "{json}");
        assert!(json.contains(r#""compressor":[{"name":"thresholdDb""#));
        assert!(json.contains(r#""reverb":[{"name":"size""#));
        assert!(json.contains(r#""delay":[{"name":"sync""#));
        assert!(json.contains(r#""choices":["1/16 triplet","1/16","#));
        for kind in EffectKind::ALL {
            assert_eq!(Effect::new(kind, RATE).to_flat().len(), kind.param_count());
            assert_eq!(EffectKind::named(kind.name()), Some(kind));
        }
    }

    #[test]
    fn the_defaults_are_the_tables() {
        assert_eq!(
            CompressorSettings::defaults(),
            CompressorSettings::default()
        );
        assert_eq!(ReverbSettings::defaults(), ReverbSettings::default());
        assert_eq!(DelaySettings::defaults(), DelaySettings::default());
    }

    #[test]
    fn every_built_in_runs_at_its_defaults_and_is_named_as_the_ui_names_it() {
        for kind in EffectKind::ALL {
            assert_eq!(EffectKind::named(kind.name()), Some(kind));
            let effect = Effect::new(kind, RATE);
            assert_eq!(effect.kind(), Some(kind));
            assert_eq!(effect.to_flat().len(), kind.param_count());
            let mut chain = InsertChain::default();
            chain.insert(0, Box::new(effect)).unwrap();
            let (left, right) = run(&mut chain);
            assert!(
                left.iter()
                    .chain(&right)
                    .all(|s| s.is_finite() && s.abs() < 4.0),
                "{}",
                kind.name()
            );
        }
    }

    #[test]
    fn a_gate_and_a_limiter_meter_their_gain_reduction() {
        let mut chain = InsertChain::default();
        chain
            .insert(
                0,
                effect(
                    EffectKind::Gate,
                    &[("thresholdDb", -3.0), ("rangeDb", -20.0)],
                ),
            )
            .unwrap();
        run(&mut chain);
        let gate = chain.effect(0).unwrap().gain_reduction_db();
        assert!((gate - 20.0).abs() < 0.5, "{gate} dB");

        let mut chain = InsertChain::default();
        chain
            .insert(0, effect(EffectKind::Limiter, &[("inputGainDb", 12.0)]))
            .unwrap();
        run(&mut chain);
        let limiter = chain.effect(0).unwrap().gain_reduction_db();
        assert!(limiter > 6.0, "{limiter} dB");
    }

    /// The settings of `kind` well away from their defaults, in their flat
    /// form: 30% of the way up each range where the default is high, 70%
    /// where it is low.
    fn moved_settings(kind: EffectKind) -> Vec<f32> {
        let defaults = Effect::new(kind, RATE).to_flat();
        kind.param_ranges()
            .into_iter()
            .zip(defaults)
            .map(|((min, max), default)| {
                let share = if default - min > 0.5 * (max - min) {
                    0.3
                } else {
                    0.7
                };
                min + share * (max - min)
            })
            .collect()
    }

    fn in_place_kinds() -> impl Iterator<Item = EffectKind> {
        EffectKind::ALL
            .into_iter()
            .filter(|&kind| in_place(kind, RATE).is_some())
    }

    #[test]
    fn a_loaded_effect_starts_at_its_settings_without_gliding() {
        for kind in in_place_kinds() {
            let values = moved_settings(kind);
            let mut loaded = InsertChain::default();
            let mut effect = Effect::new(kind, RATE);
            effect.set_flat(&values);
            loaded.insert(0, Box::new(effect)).unwrap();
            let (loaded_left, loaded_right) = run(&mut loaded);

            // As if it had been made with them, and settled.
            let mut made = in_place_made_with(kind, RATE, &values).unwrap();
            made.settle();
            let mut left = sine(1_000.0, 0.5, RATE, 24_000);
            let mut right = left.clone();
            for (l, r) in left.chunks_mut(256).zip(right.chunks_mut(256)) {
                made.process(l, r, &[]);
            }
            assert_eq!(loaded_left, left, "{}", kind.name());
            assert_eq!(loaded_right, right, "{}", kind.name());
        }
    }

    #[test]
    fn a_smoothed_setting_is_there_at_once_on_load_and_glides_after() {
        // The Clipper's output gain, the Ring Mod's mix, the Haas's level:
        // each is heard at the Project's setting from the first sample,
        // not faded in from the default.
        type Changes = &'static [(&'static str, f32)];
        let cases: [(EffectKind, Changes, Changes); 3] = [
            (
                EffectKind::Clipper,
                &[("outputDb", -12.0)],
                &[("outputDb", 0.0)],
            ),
            (EffectKind::RingMod, &[("mix", 0.0)], &[("mix", 1.0)]),
            (
                EffectKind::Haas,
                &[("side", 0.0), ("levelDb", -12.0)],
                &[("levelDb", 0.0)],
            ),
        ];
        for (kind, load, later) in cases {
            let loaded = effect(kind, load);
            let mut chain = InsertChain::default();
            chain.insert(0, loaded).unwrap();
            let (mut left, mut right) = (sine(1_000.0, 0.5, RATE, 4_800), vec![0.0; 4_800]);
            right.copy_from_slice(&left);
            chain.process(&mut left, &mut right);
            // (After the Haas's 15 ms delay has filled.)
            let (first, steady) = (rms(&left[960..1_440]), rms(&left[2_400..]));
            assert!(
                (first / steady - 1.0).abs() < 0.02,
                "{}: {first} against {steady}",
                kind.name(),
            );

            // Changed later, it glides: no click, and it gets there.
            let mut flat = chain.effect(0).unwrap().to_flat();
            let names = kind.param_names();
            for (name, value) in later {
                flat[names.iter().position(|p| p == name).unwrap()] = *value;
            }
            chain.effect_mut(0).unwrap().set_flat(&flat);
            let (mut after_left, mut after_right) =
                (sine(1_000.0, 0.5, RATE, 4_800), vec![0.0; 4_800]);
            after_right.copy_from_slice(&after_left);
            chain.process(&mut after_left, &mut after_right);
            let joined: Vec<f32> = left.iter().chain(&after_left).copied().collect();
            assert!(
                max_jump(&joined) < 0.2,
                "{}: {}",
                kind.name(),
                max_jump(&joined)
            );
            assert!(
                (rms(&after_left[2_400..]) - steady).abs() > 0.01,
                "{} reached its new setting",
                kind.name()
            );
        }
    }

    /// Frames of a steady signal through `chain`, in blocks of `block`, with
    /// the song at `ticks`.
    fn gains_at(chain: &mut InsertChain, ticks: &[f64], block: usize) -> Vec<f32> {
        let mut left = vec![1.0; ticks.len()];
        let mut right = left.clone();
        for ((l, r), t) in left
            .chunks_mut(block)
            .zip(right.chunks_mut(block))
            .zip(ticks.chunks(block))
        {
            chain.process_at(l, r, t);
        }
        left
    }

    #[test]
    fn a_synced_effect_follows_the_song_only_while_it_moves() {
        let synced = [
            (EffectKind::Pump, vec![("depth", 1.0)]),
            (EffectKind::TranceGate, vec![]),
            (EffectKind::Tremolo, vec![("sync", 1.0), ("depth", 1.0)]),
            (EffectKind::AutoPan, vec![("sync", 1.0)]),
            (EffectKind::BeatRepeat, vec![("repeat", 1.0)]),
        ];
        for (kind, settings) in synced {
            let run = |ticks: &[f64], frames: usize| {
                let mut chain = InsertChain::default();
                chain.insert(0, effect(kind, &settings)).unwrap();
                let mut left = sine(300.0, 0.5, RATE, frames);
                let mut right = left.clone();
                for (index, (l, r)) in left.chunks_mut(256).zip(right.chunks_mut(256)).enumerate() {
                    let t = ticks.get(index * 256..index * 256 + l.len()).unwrap_or(&[]);
                    chain.process_at(l, r, t);
                }
                left
            };
            // Stopped part-way through a beat, it runs free, as with no
            // position.
            let free = run(&[], 30_000);
            assert_eq!(run(&vec![360.0; 30_000], 30_000), free, "{}", kind.name());
            // Playing from there, it lines up with the song instead.
            let playing = run(&song_ticks(360.0, 120.0, RATE, 30_000), 30_000);
            assert_ne!(playing, free, "{}", kind.name());
        }
    }

    #[test]
    fn a_pump_dips_on_the_beat_while_its_settings_follow_automation() {
        // A moving Automation renders frame by frame: each frame still
        // knows the song is moving.
        let mut pump = effect(EffectKind::Pump, &[("depth", 1.0)]);
        let automation = Automation::from_flat(
            &[0.0, 0.9, 0.0, 3_840.0, 1.0, 0.0],
            crate::automation::Automatable::Effect {
                index: 0,
                param: crate::automation::ParamName::new("mix").unwrap(),
            },
        );
        pump.set_automation("mix", automation);
        let mut chain = InsertChain::default();
        chain.insert(0, pump).unwrap();
        let ticks = song_ticks(480.0, 120.0, RATE, 36_000);
        let gains = gains_at(&mut chain, &ticks, 1_000);
        let dip = (0..24_000)
            .min_by(|&a, &b| gains[a].total_cmp(&gains[b]))
            .unwrap();
        assert!((12_000..12_400).contains(&dip), "{dip}");
    }
}

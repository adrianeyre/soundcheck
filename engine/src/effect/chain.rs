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
use super::{
    COMPRESSOR_PARAMS, Compressor, CompressorSettings, DELAY_PARAMS, Delay, DelaySettings,
    EQ_PARAMS, Eq, EqSettings, REVERB_PARAMS, Reverb, ReverbSettings,
};
use crate::automation::{Automation, TableAutomation};
use crate::plugin::HostedPlugin;

/// The most Effects one Insert Chain holds.
pub const MAX_EFFECTS: usize = 16;

/// Which Effect: the names are the ones the Project and the UI use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectKind {
    Eq,
    Compressor,
    Reverb,
    Delay,
}

impl EffectKind {
    pub const ALL: [EffectKind; 4] = [Self::Eq, Self::Compressor, Self::Reverb, Self::Delay];

    pub fn name(self) -> &'static str {
        match self {
            Self::Eq => "eq",
            Self::Compressor => "compressor",
            Self::Reverb => "reverb",
            Self::Delay => "delay",
        }
    }

    pub fn named(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.name() == name)
    }

    /// This Effect's settings table, as JSON.
    fn table_json(self) -> String {
        match self {
            Self::Eq => table_json(EQ_PARAMS),
            Self::Compressor => table_json(COMPRESSOR_PARAMS),
            Self::Reverb => table_json(REVERB_PARAMS),
            Self::Delay => table_json(DELAY_PARAMS),
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
            Self::Eq => find(EQ_PARAMS, name),
            Self::Compressor => find(COMPRESSOR_PARAMS, name),
            Self::Reverb => find(REVERB_PARAMS, name),
            Self::Delay => find(DELAY_PARAMS, name),
        }
    }

    /// How many settings this Effect has.
    pub fn param_count(self) -> usize {
        match self {
            Self::Eq => EQ_PARAMS.len(),
            Self::Compressor => COMPRESSOR_PARAMS.len(),
            Self::Reverb => REVERB_PARAMS.len(),
            Self::Delay => DELAY_PARAMS.len(),
        }
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
}

impl Effect {
    /// An Effect with its default settings, not bypassed.
    pub fn new(kind: EffectKind, sample_rate: f32) -> Self {
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
    /// ones at their default. Allocates nothing.
    pub fn set_flat(&mut self, values: &[f32]) {
        match &mut self.processor {
            Processor::Eq(eq) => eq.set_settings(EqSettings::from_flat(values)),
            Processor::Compressor(compressor) => {
                compressor.set_settings(CompressorSettings::from_flat(values))
            }
            Processor::Reverb(reverb) => reverb.set_settings(ReverbSettings::from_flat(values)),
            Processor::Delay(delay) => delay.set_settings(DelaySettings::from_flat(values)),
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
        if let Processor::Delay(delay) = &mut self.processor {
            delay.set_tempo(tempo);
        }
    }

    /// The gain-reduction meter, in dB (0 or more): how far a Compressor
    /// pulled the level down in the latest block. 0 for an Effect that
    /// doesn't reduce gain, and for one that is bypassed.
    pub fn gain_reduction_db(&self) -> f32 {
        match &self.processor {
            Processor::Compressor(compressor) if !self.bypassed => compressor.meter_db(),
            _ => 0.0,
        }
    }

    /// Process both sides in place, with the settings following their
    /// Automation when `ticks` says where in the song each frame is (see
    /// `TableAutomation::drive`). `scratch_left` and `scratch_right` are at
    /// least as long, for an Effect that can't work in place.
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
        self.automation.drive(
            left.len(),
            ticks,
            &mut self.processor,
            |processor, index, value| processor.set(index, value),
            |processor, frames| {
                processor.process(
                    &mut left[frames.clone()],
                    &mut right[frames],
                    scratch_left,
                    scratch_right,
                );
            },
        );
    }
}

impl Processor {
    fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        scratch_left: &mut [f32],
        scratch_right: &mut [f32],
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

    /// `process`, with every automated setting following its Automation:
    /// `ticks` says where in the song each frame is, and has no breakpoint
    /// between its first and last.
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
    use crate::dsp::measure::{rms, sine};

    const RATE: f32 = 48_000.0;

    fn effect(kind: EffectKind, settings: &[(&str, f32)]) -> Box<Effect> {
        let mut effect = Effect::new(kind, RATE);
        let mut flat = effect.to_flat();
        let params: Vec<&str> = match kind {
            EffectKind::Eq => EQ_PARAMS.iter().map(|p| p.name).collect(),
            EffectKind::Compressor => COMPRESSOR_PARAMS.iter().map(|p| p.name).collect(),
            EffectKind::Reverb => REVERB_PARAMS.iter().map(|p| p.name).collect(),
            EffectKind::Delay => DELAY_PARAMS.iter().map(|p| p.name).collect(),
        };
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
}

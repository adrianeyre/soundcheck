//! A Plugin as a Track's Instrument (ADR 0003): its instance turns notes
//! into audio, and its settings are clamped, automated and kept exactly as
//! an Effect Plugin's are.

use crate::automation::{Automation, TableAutomation};
use crate::plugin::HostedPlugin;

#[derive(Debug)]
pub struct PluginInstrument {
    plugin: HostedPlugin,
    /// Its settings as the host last set them. An automated setting follows
    /// its Automation instead, and goes back to this when that is taken
    /// away.
    fixed: Vec<f32>,
    /// What moves its settings while the song plays. It is the Instrument's,
    /// so it goes when the Instrument does.
    automation: TableAutomation,
}

impl PluginInstrument {
    /// Host `plugin` at its default settings.
    pub fn new(plugin: HostedPlugin) -> Self {
        let count = plugin.manifest().settings.len();
        let fixed = (0..count).map(|index| plugin.get(index)).collect();
        Self {
            plugin,
            fixed,
            automation: TableAutomation::new(count),
        }
    }

    pub fn plugin(&self) -> &HostedPlugin {
        &self.plugin
    }

    /// Change the settings from their flat form: one value per setting, in
    /// the manifest's order, out-of-range values clamped and missing ones at
    /// their default. Allocates nothing.
    pub fn set_flat(&mut self, values: &[f32]) {
        for index in 0..self.fixed.len() {
            let default = self.plugin.manifest().settings[index].default;
            self.plugin
                .set(index, values.get(index).copied().unwrap_or(default));
            self.fixed[index] = self.plugin.get(index);
        }
    }

    /// The settings in their flat form, as the host set them: an automated
    /// setting gives its fixed value.
    pub fn to_flat(&self) -> Vec<f32> {
        self.fixed.clone()
    }

    /// Replace the Automation of the setting called `param`, handing back
    /// the old one, or `automation` itself when the Plugin has no such
    /// setting. Taking a setting's Automation away puts it back at its fixed
    /// value. Allocates nothing.
    pub fn set_automation(&mut self, param: &str, automation: Automation) -> Automation {
        let Some(index) = self.plugin.manifest().setting_index(param) else {
            return automation;
        };
        let old = self.automation.set(index, automation);
        self.plugin.set(index, self.fixed[index]);
        old
    }

    pub fn next_breakpoint(&self, from: u64) -> Option<u64> {
        self.automation.next_point(from)
    }

    pub fn note_on(&mut self, note: u8, velocity: f32) {
        self.plugin.note_on(note, velocity);
    }

    pub fn note_off(&mut self, note: u8) {
        self.plugin.note_off(note);
    }

    /// Render the next `left.len()` frames, replacing what is there, with
    /// its settings following their Automation where `ticks` says where in
    /// the song each frame is (see `TableAutomation::drive`).
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32], ticks: &[f64]) {
        self.automation.drive(
            left.len(),
            ticks,
            &mut self.plugin,
            |plugin, index, value| plugin.set(index, value),
            |plugin, frames| plugin.render(&mut left[frames.clone()], &mut right[frames]),
        );
    }
}

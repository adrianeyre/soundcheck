//! A VST3 Plugin as the Audio Engine hosts it: a `PluginInstance` whose
//! every block goes to its helper process.

use std::time::{Duration, Instant};

use soundcheck_engine::{PluginBlock, PluginFault, PluginInstance};

use super::process::{Audio, Control};
use super::shared::{
    EVENT_NOTE_OFF, EVENT_NOTE_ON, Event, MAX_EVENTS, MAX_PARAM_CHANGES, ParamChange,
};

/// One slot's VST3 Plugin. The engine tells it settings by their index in
/// its manifest, which are the Plugin's automatable settings in order; each
/// goes to the Plugin by its ParamID with the next block, as do notes. The
/// engine has already cut the block where each happens.
pub struct Vst3Instance {
    audio: Audio,
    /// The ParamID of each setting in the manifest.
    ids: Vec<u32>,
    changes: Vec<ParamChange>,
    events: Vec<Event>,
    held: [bool; 128],
    sample_rate: f64,
    /// An offline copy's own helper, which goes with it.
    _owner: Option<Control>,
}

impl Vst3Instance {
    pub fn new(audio: Audio, ids: Vec<u32>, sample_rate: f64, owner: Option<Control>) -> Self {
        Self {
            audio,
            ids,
            changes: Vec::with_capacity(MAX_PARAM_CHANGES),
            events: Vec::with_capacity(MAX_EVENTS),
            held: [false; 128],
            sample_rate,
            _owner: owner,
        }
    }

    fn note(&mut self, kind: u32, note: u8, velocity: f32) {
        if self.events.len() < MAX_EVENTS {
            self.events.push(Event {
                kind,
                offset: 0,
                pitch: i32::from(note),
                velocity,
            });
        }
    }
}

impl PluginInstance for Vst3Instance {
    fn set_param(&mut self, index: usize, value: f32) {
        let Some(&id) = self.ids.get(index) else {
            return;
        };
        let change = ParamChange {
            id,
            offset: 0,
            value: f64::from(value),
        };
        if let Some(queued) = self.changes.iter_mut().find(|c| c.id == id) {
            *queued = change;
        } else if self.changes.len() < MAX_PARAM_CHANGES {
            self.changes.push(change);
        }
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32]) -> Result<(), PluginFault> {
        match self.process_block(left, right) {
            PluginBlock::Crashed => Err(PluginFault),
            PluginBlock::Processed | PluginBlock::Bypassed => Ok(()),
        }
    }

    fn process_block(&mut self, left: &mut [f32], right: &mut [f32]) -> PluginBlock {
        let deadline = super::block_deadline().unwrap_or_else(|| {
            // No audio callback set one: as long as the block lasts.
            let frames = left.len().min(right.len()) as f64;
            Instant::now() + Duration::from_secs_f64(frames / self.sample_rate)
        });
        let block = self
            .audio
            .process(left, right, &self.changes, &self.events, deadline);
        self.changes.clear();
        self.events.clear();
        block
    }

    fn reset(&mut self) {
        // VST3 has no reset of its own; what matters is that nothing is left
        // sounding.
        for note in 0..128u8 {
            if std::mem::take(&mut self.held[usize::from(note)]) {
                self.note(EVENT_NOTE_OFF, note, 0.0);
            }
        }
    }

    fn note_on(&mut self, note: u8, velocity: f32) -> Result<(), PluginFault> {
        if let Some(held) = self.held.get_mut(usize::from(note)) {
            *held = true;
        }
        self.note(EVENT_NOTE_ON, note, velocity);
        Ok(())
    }

    fn note_off(&mut self, note: u8) -> Result<(), PluginFault> {
        if let Some(held) = self.held.get_mut(usize::from(note)) {
            *held = false;
        }
        self.note(EVENT_NOTE_OFF, note, 0.0);
        Ok(())
    }
}

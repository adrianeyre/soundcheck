//! A Bus: a mixer channel that Tracks and other Buses feed, with its own
//! Insert Chain, fader, pan, mute and solo, feeding the Master or another
//! Bus. It holds no Clips.
//!
//! Every Track and Bus has one output, and any number of Sends: post-fader
//! copies of its signal, each at its own level, fed to a Bus. Buses may feed
//! Buses, through their outputs or their Sends, but never in a loop: the host
//! refuses a cycle before it gets here, and the Engine refuses one too, so it
//! can always put the Buses in an order where each is mixed before whatever
//! it feeds.

use crate::automation::{Automatable, Automation, ChannelAutomation, Line};
use crate::channel_eq::ChannelEq;
use crate::effect::InsertChain;
use crate::track::{ChannelGains, Mixer};

/// Enough Buses for any mix, few enough that routing is checked in a blink.
pub const MAX_BUSES: usize = 128;

/// Where a Track or Bus sends its signal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Output {
    #[default]
    Master,
    Bus(usize),
}

impl Output {
    /// The host's number for an output: a Bus's index, or below zero for the
    /// Master.
    pub fn from_index(index: i32) -> Self {
        usize::try_from(index).map_or(Output::Master, Output::Bus)
    }

    pub fn bus(self) -> Option<usize> {
        match self {
            Output::Master => None,
            Output::Bus(bus) => Some(bus),
        }
    }
}

/// A Send: a post-fader copy of a Track's or Bus's signal, scaled by
/// `level`, fed to Bus `bus`. (Not called `Send`, which Rust already means.)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BusSend {
    pub bus: usize,
    /// Linear gain, like a fader: 1 is unity, 2 is +6 dB.
    pub level: f32,
}

/// The loudest a Send goes, matching the fader.
pub const MAX_SEND_LEVEL: f32 = 2.0;

impl BusSend {
    /// Sends from the host's flat list: a Bus index, then a level, for each.
    /// None if a Bus index isn't a whole number from 0, or a level isn't a
    /// number. Levels are clamped to 0..=`MAX_SEND_LEVEL`.
    pub fn from_flat(flat: &[f64]) -> Option<Vec<BusSend>> {
        if !flat.len().is_multiple_of(2) || flat.len() / 2 > MAX_BUSES {
            return None;
        }
        let (pairs, _) = flat.as_chunks::<2>();
        pairs
            .iter()
            .map(|&[bus, level]| {
                let whole = bus.is_finite() && bus >= 0.0 && bus.fract() == 0.0;
                (whole && level.is_finite() && bus < MAX_BUSES as f64).then(|| BusSend {
                    bus: bus as usize,
                    level: (level as f32).clamp(0.0, MAX_SEND_LEVEL),
                })
            })
            .collect()
    }
}

/// Every Bus a channel with `output` and `sends` feeds: its output's Bus, if
/// it has one, then each Send's.
pub fn feeds(output: Output, sends: &[BusSend]) -> impl Iterator<Item = usize> + '_ {
    output
        .bus()
        .into_iter()
        .chain(sends.iter().map(|send| send.bus))
}

#[derive(Debug, Default)]
pub struct Bus {
    chain: InsertChain,
    mixer: Mixer,
    /// The channel EQ, between the Insert Chain and the fader.
    eq: ChannelEq,
    output: Output,
    sends: Vec<BusSend>,
    /// What moves its fader, pan, EQ and Sends while the song plays.
    automation: ChannelAutomation,
    /// How many Buses its signal passes through to reach the Master, this
    /// one included, on its longest way there: a Bus is mixed after every
    /// Bus deeper than it.
    depth: usize,
    /// Whether it passes its signal on this block, from mute and solo.
    audible: bool,
    /// The loudest sample it last put out, for its meter.
    meter: f32,
    /// What feeds it this block, summed, and then its output.
    left: Vec<f32>,
    right: Vec<f32>,
}

impl Bus {
    pub fn new() -> Self {
        Self {
            depth: 1,
            audible: true,
            ..Self::default()
        }
    }

    pub fn chain(&self) -> &InsertChain {
        &self.chain
    }

    pub fn chain_mut(&mut self) -> &mut InsertChain {
        &mut self.chain
    }

    pub fn mixer(&self) -> Mixer {
        self.mixer
    }

    pub fn set_mixer(&mut self, mixer: Mixer) {
        self.mixer = mixer;
    }

    /// The channel EQ's bands, low to high, in dB.
    pub fn eq(&self) -> [f32; 4] {
        self.eq.db()
    }

    /// Set the channel EQ's bands, low to high, in dB. Allocates nothing.
    pub fn set_eq(&mut self, db: [f32; 4]) {
        self.eq.set(db);
    }

    /// Run the EQ at the Engine's rate. Allocates nothing.
    pub(crate) fn set_sample_rate(&mut self, sample_rate: f32) {
        self.eq.set_sample_rate(sample_rate);
    }

    pub fn output(&self) -> Output {
        self.output
    }

    /// Only the Engine sets this, having checked it makes no loop.
    pub(crate) fn set_output(&mut self, output: Output) {
        self.output = output;
    }

    pub fn sends(&self) -> &[BusSend] {
        &self.sends
    }

    /// Only the Engine sets these, having checked they make no loop. Hands
    /// back the Sends it had.
    pub(crate) fn swap_sends(&mut self, sends: Vec<BusSend>) -> Vec<BusSend> {
        std::mem::replace(&mut self.sends, sends)
    }

    pub(crate) fn sends_mut(&mut self) -> &mut Vec<BusSend> {
        &mut self.sends
    }

    /// Every Bus this one feeds, through its output or a Send.
    pub fn feeds(&self) -> impl Iterator<Item = usize> + '_ {
        feeds(self.output, &self.sends)
    }

    pub(crate) fn set_depth(&mut self, depth: usize) {
        self.depth = depth;
    }

    pub fn depth(&self) -> usize {
        self.depth
    }

    pub fn audible(&self) -> bool {
        self.audible
    }

    pub fn set_audible(&mut self, audible: bool) {
        self.audible = audible;
    }

    pub fn meter(&self) -> f32 {
        self.meter
    }

    pub fn fall(&mut self, factor: f32) {
        self.meter *= factor;
    }

    /// Size the buffers for blocks of up to `frames`, so mixing them
    /// allocates nothing.
    pub fn prepare(&mut self, frames: usize) {
        if self.left.len() < frames {
            self.left.resize(frames, 0.0);
            self.right.resize(frames, 0.0);
        }
        self.chain.prepare(frames);
    }

    /// Empty the input for a block of `frames`.
    pub fn clear(&mut self, frames: usize) {
        self.prepare(frames);
        self.left[..frames].fill(0.0);
        self.right[..frames].fill(0.0);
    }

    /// Where what feeds this Bus adds its signal, from frame `start` to `end`.
    pub fn input(&mut self, start: usize, end: usize) -> (&mut [f32], &mut [f32]) {
        (&mut self.left[start..end], &mut self.right[start..end])
    }

    /// Run frames `start` to `end` of what feeds this Bus through its Insert
    /// Chain, its EQ, its fader and its pan, leaving its output in place for
    /// `add_to`.
    /// `ticks` says where in the song each frame is, and has no breakpoint
    /// between its first and last, so every automated setting follows its
    /// Automation.
    pub fn process(&mut self, start: usize, end: usize, ticks: &[f64]) {
        let (own_left, own_right) = (&mut self.left[start..end], &mut self.right[start..end]);
        self.chain.process_at(own_left, own_right, ticks);
        self.eq.process(
            own_left,
            own_right,
            self.automation.eq().lines(ticks),
            ticks,
        );
        let gains = ChannelGains::new(self.mixer, 1.0, &self.automation, ticks);
        let mut meter = self.meter;
        for (frame, (l, r)) in own_left.iter_mut().zip(own_right.iter_mut()).enumerate() {
            let (gain_left, gain_right) = gains.at(frame, ticks);
            *l *= gain_left;
            *r *= gain_right;
            meter = meter.max(l.abs()).max(r.abs());
        }
        self.meter = meter;
    }

    /// Add this Bus's output, from frame `start`, as many frames as `left`
    /// holds, to `left` and `right`, scaled by `level`: 1 for its output, a
    /// Send's level for a Send, following `line` when it is automated (see
    /// `add_following`). Call `process` first.
    pub fn add_to(
        &self,
        start: usize,
        (left, right): (&mut [f32], &mut [f32]),
        level: f32,
        line: Option<Line>,
        ticks: &[f64],
    ) {
        let end = start + left.len();
        let from = (&self.left[start..end], &self.right[start..end]);
        add_following(from, (left, right), level, line, ticks);
    }

    /// Replace the Automation of its fader, pan, a Send or an Effect,
    /// handing back the old one, or `automation` itself for a setting a Bus
    /// doesn't have. Allocates nothing.
    pub fn set_automation(&mut self, setting: Automatable, automation: Automation) -> Automation {
        match setting {
            Automatable::Effect { index, param } => match self.chain.effect_mut(index) {
                Some(effect) => effect.set_automation(param.as_str(), automation),
                None => automation,
            },
            _ => self.automation.set(setting, automation),
        }
    }

    pub fn automation(&self) -> &ChannelAutomation {
        &self.automation
    }

    /// The tick of the first breakpoint at or after `from`, of any setting.
    pub fn next_breakpoint(&self, from: u64) -> Option<u64> {
        let mine = self.automation.next_point(from);
        mine.into_iter()
            .chain(self.chain.next_breakpoint(from))
            .min()
    }
}

/// `add_scaled` at a level that follows `line` frame by frame, over frames
/// at `ticks`, or stays at `level` when there is no line. A steady line
/// adds exactly as a fixed level does.
pub fn add_following(
    (from_left, from_right): (&[f32], &[f32]),
    (to_left, to_right): (&mut [f32], &mut [f32]),
    level: f32,
    line: Option<Line>,
    ticks: &[f64],
) {
    match line {
        None => add_scaled(from_left, from_right, to_left, to_right, level),
        Some(line) if line.is_steady() || ticks.len() != to_left.len() => {
            let level = ticks.first().map_or(level, |&tick| line.at(tick));
            add_scaled(from_left, from_right, to_left, to_right, level);
        }
        Some(line) => {
            for (frame, (((&in_l, &in_r), l), r)) in from_left
                .iter()
                .zip(from_right)
                .zip(to_left.iter_mut())
                .zip(to_right.iter_mut())
                .enumerate()
            {
                let level = line.at(ticks[frame]);
                *l += in_l * level;
                *r += in_r * level;
            }
        }
    }
}

/// Add `from` to `to`, side by side, scaled by `level`. At a level of 1 this
/// is exactly a plain sum.
pub fn add_scaled(
    from_left: &[f32],
    from_right: &[f32],
    to_left: &mut [f32],
    to_right: &mut [f32],
    level: f32,
) {
    for (((&in_l, &in_r), l), r) in from_left
        .iter()
        .zip(from_right)
        .zip(to_left.iter_mut())
        .zip(to_right.iter_mut())
    {
        *l += in_l * level;
        *r += in_r * level;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_come_from_pairs_of_a_bus_and_a_level() {
        let sends = BusSend::from_flat(&[1.0, 0.5, 0.0, 9.0]).unwrap();
        assert_eq!(
            sends,
            vec![
                BusSend { bus: 1, level: 0.5 },
                BusSend {
                    bus: 0,
                    level: MAX_SEND_LEVEL
                }
            ]
        );
        assert_eq!(BusSend::from_flat(&[1.0]), None, "half a pair");
        assert_eq!(
            BusSend::from_flat(&[-1.0, 1.0]),
            None,
            "the Master is no Bus"
        );
        assert_eq!(BusSend::from_flat(&[0.5, 1.0]), None);
        assert_eq!(BusSend::from_flat(&[0.0, f64::NAN]), None);
    }

    #[test]
    fn a_channel_feeds_its_outputs_bus_and_every_send() {
        let sends = [
            BusSend { bus: 3, level: 1.0 },
            BusSend { bus: 0, level: 1.0 },
        ];
        let fed: Vec<usize> = feeds(Output::Bus(2), &sends).collect();
        assert_eq!(fed, vec![2, 3, 0]);
        let fed: Vec<usize> = feeds(Output::Master, &sends).collect();
        assert_eq!(fed, vec![3, 0]);
    }

    #[test]
    fn a_bus_passes_what_feeds_it_through_its_fader_and_pan() {
        let mut bus = Bus::new();
        bus.clear(4);
        let (left, right) = bus.input(0, 4);
        left.fill(0.5);
        right.fill(0.5);
        bus.set_mixer(Mixer {
            volume: 0.5,
            pan: 1.0,
            mute: false,
            solo: false,
        });
        let (mut left, mut right) = (vec![0.1; 4], vec![0.1; 4]);
        bus.process(0, 4, &[]);
        bus.add_to(0, (&mut left, &mut right), 1.0, None, &[]);
        assert_eq!(left, vec![0.1; 4], "panned hard right, nothing on the left");
        assert_eq!(right, vec![0.35; 4]);
        assert_eq!(bus.meter(), 0.25);
    }
}

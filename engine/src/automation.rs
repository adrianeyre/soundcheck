//! **Automation**: the breakpoints of one setting over time, which move it
//! while the song plays and override its fixed value.
//!
//! Between two breakpoints the value ramps in a straight line, unless the
//! first holds: then it keeps its value and steps to the next at the next's
//! tick. Before the first breakpoint the value is the first's, and after the
//! last it is the last's. Positions are ticks, so Automation follows the
//! tempo map like everything else.
//!
//! The Engine starts a segment at every breakpoint, as it does at a Tempo
//! Change, so no segment has a breakpoint inside it and a value moves in a
//! straight line across each one: sample-accurate, whatever the block size.

/// Enough for any song, and a bound on what a host's message can make the
/// engine allocate.
pub const MAX_BREAKPOINTS: usize = 4_096;

/// The widest a fader or a Send goes, matching the Project's own limit.
const MAX_VOLUME: f32 = 2.0;

use crate::instrument::{MAX_PADS, PadParam};

/// A setting Automation can move. Only settings that are numbers: mute,
/// solo, bypass and a setting that picks from a list keep their fixed value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Automatable {
    /// A linear gain from 0 to 2.
    Volume,
    /// -1 hard left, 0 centre, 1 hard right.
    Pan,
    /// The level of the Send to Bus `n`, a linear gain from 0 to 2.
    Send(usize),
    /// The setting called `param` of the Effect at `index` in the channel's
    /// Insert Chain: a built-in's or a Plugin's, which the Effect looks up
    /// in its own table. The Effect keeps its Automation wherever it moves,
    /// and takes it along when it goes.
    Effect { index: usize, param: ParamName },
    /// The setting called `param` of the Track's Instrument: a number in
    /// the Synth's table (`PARAMS`), or any of a Plugin's, which the Track
    /// looks up in whichever Instrument it has.
    Instrument(ParamName),
    /// The number `param` of the Drum Sampler's pad at `pad`, counting from
    /// 0 in its kit. The Track keeps it when its Instrument changes, and
    /// only a Drum Sampler follows it.
    Pad { pad: usize, param: PadParam },
}

impl Automatable {
    /// The setting a host names: "volume", "pan", "send:<bus>",
    /// "effect:<index>:<setting>" or "instrument:<setting>", with a setting
    /// by the name its table gives it, or "pad:<index>:<setting>" for a
    /// pad's "volume", "pan" or "pitch".
    pub fn named(name: &str) -> Option<Self> {
        match name {
            "volume" => return Some(Self::Volume),
            "pan" => return Some(Self::Pan),
            _ => {}
        }
        let (kind, rest) = name.split_once(':')?;
        match kind {
            "send" => rest.parse().ok().map(Self::Send),
            "effect" => {
                let (index, param) = rest.split_once(':')?;
                let index = index.parse().ok()?;
                let param = ParamName::new(param)?;
                Some(Self::Effect { index, param })
            }
            "instrument" => ParamName::new(rest).map(Self::Instrument),
            "pad" => {
                let (pad, param) = rest.split_once(':')?;
                let pad = pad.parse().ok().filter(|&pad| pad < MAX_PADS)?;
                let param = PadParam::named(param)?;
                Some(Self::Pad { pad, param })
            }
            _ => None,
        }
    }

    /// The range values are clamped to as they are read. An Effect's or the
    /// Synth's own table clamps its settings as they are set.
    fn range(self) -> (f32, f32) {
        match self {
            Self::Volume | Self::Send(_) => (0.0, MAX_VOLUME),
            Self::Pan => (-1.0, 1.0),
            Self::Effect { .. } | Self::Instrument(_) | Self::Pad { .. } => (f32::MIN, f32::MAX),
        }
    }
}

/// The longest name an Effect's setting can have: a Plugin's manifest is
/// held to it too.
pub const MAX_PARAM_NAME: usize = 32;

/// The name of an Effect's setting, held inline so that naming one allocates
/// nothing and `Automatable` stays `Copy`, whether the name is a built-in's
/// or a Plugin's.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ParamName {
    bytes: [u8; MAX_PARAM_NAME],
    len: u8,
}

impl ParamName {
    /// `name`, if it could be a setting's: 1 to `MAX_PARAM_NAME` ASCII
    /// letters, digits and underscores.
    pub fn new(name: &str) -> Option<Self> {
        let valid = !name.is_empty()
            && name.len() <= MAX_PARAM_NAME
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !valid {
            return None;
        }
        let mut bytes = [0; MAX_PARAM_NAME];
        bytes[..name.len()].copy_from_slice(name.as_bytes());
        Some(Self {
            bytes,
            len: name.len() as u8,
        })
    }

    pub fn as_str(&self) -> &str {
        // Only ever built from a `&str` of ASCII.
        std::str::from_utf8(&self.bytes[..usize::from(self.len)]).unwrap_or_default()
    }
}

impl std::fmt::Debug for ParamName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.as_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Breakpoint {
    tick: u64,
    value: f32,
    /// Keep `value` until the next breakpoint, then step to it.
    hold: bool,
}

/// One setting's breakpoints, in tick order. Empty, the setting isn't
/// automated and keeps its fixed value. Building it allocates, so a native
/// host does it off the audio thread.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Automation(Vec<Breakpoint>);

impl Automation {
    /// Read flat tick, value and hold (anything but 0 holds) for each
    /// breakpoint of `setting`. One with a value that isn't a number or a
    /// tick below 0 is skipped, values are clamped to the setting's range,
    /// and of two at the same tick the later wins.
    pub fn from_flat(flat: &[f64], setting: Automatable) -> Self {
        let (min, max) = setting.range();
        let mut points: Vec<Breakpoint> = flat
            .as_chunks::<3>()
            .0
            .iter()
            .take(MAX_BREAKPOINTS)
            .filter(|p| p.iter().all(|v| v.is_finite()) && p[0] >= 0.0)
            .map(|&[tick, value, hold]| Breakpoint {
                tick: tick as u64,
                value: (value as f32).clamp(min, max),
                hold: hold != 0.0,
            })
            .collect();
        points.reverse();
        points.sort_by_key(|p| p.tick);
        points.dedup_by_key(|p| p.tick);
        Self(points)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The tick of the first breakpoint at or after `from`.
    pub fn next_point(&self, from: u64) -> Option<u64> {
        let index = self.0.partition_point(|p| p.tick < from);
        self.0.get(index).map(|p| p.tick)
    }

    /// The line the value follows over a stretch from `from` to `to` ticks
    /// with no breakpoint inside it, or none when nothing is automated. The
    /// stretch is found by its middle, so an end that rounding puts a hair
    /// past a breakpoint still counts as on its side of it.
    pub fn line(&self, from: f64, to: f64) -> Option<Line> {
        let (first, last) = (self.0.first()?, self.0.last()?);
        let middle = (from + to) / 2.0;
        let index = self.0.partition_point(|p| p.tick as f64 <= middle);
        if index == 0 {
            return Some(Line::steady(first.value));
        }
        let Some(next) = self.0.get(index) else {
            return Some(Line::steady(last.value));
        };
        let point = self.0[index - 1];
        if point.hold {
            return Some(Line::steady(point.value));
        }
        Some(Line {
            tick: point.tick as f64,
            value: point.value,
            span: (next.tick - point.tick) as f64,
            rise: next.value - point.value,
        })
    }
}

/// A setting's value between two breakpoints: a ramp, or a steady value.
/// It depends only on the tick, so however a song is cut into blocks, each
/// frame gets the same value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Line {
    tick: f64,
    value: f32,
    span: f64,
    rise: f32,
}

impl Line {
    pub fn steady(value: f32) -> Self {
        Self {
            tick: 0.0,
            value,
            span: 1.0,
            rise: 0.0,
        }
    }

    pub fn is_steady(&self) -> bool {
        self.rise == 0.0
    }

    pub fn at(&self, tick: f64) -> f32 {
        if self.is_steady() {
            return self.value;
        }
        self.value + self.rise * ((tick - self.tick) / self.span) as f32
    }
}

/// The most Sends a channel can have automated: one per Bus.
const MAX_SENDS: usize = crate::bus::MAX_BUSES;

/// What moves a Track's or Bus's mixer channel while the song plays: its
/// fader, its pan and the levels of its Sends. Building it allocates, so a
/// native host does it off the audio thread; changing it then doesn't.
#[derive(Clone, Debug)]
pub struct ChannelAutomation {
    volume: Automation,
    pan: Automation,
    /// Each automated Send, by the Bus it feeds.
    sends: Vec<(usize, Automation)>,
}

impl Default for ChannelAutomation {
    fn default() -> Self {
        Self {
            volume: Automation::default(),
            pan: Automation::default(),
            sends: Vec::with_capacity(MAX_SENDS),
        }
    }
}

impl ChannelAutomation {
    /// Replace the Automation of the fader, the pan or a Send, handing back
    /// the old one, or `automation` itself for any other setting.
    pub fn set(&mut self, setting: Automatable, automation: Automation) -> Automation {
        match setting {
            Automatable::Volume => std::mem::replace(&mut self.volume, automation),
            Automatable::Pan => std::mem::replace(&mut self.pan, automation),
            Automatable::Send(bus) if bus < MAX_SENDS => {
                let at = self.sends.iter().position(|(to, _)| *to == bus);
                match at {
                    Some(at) if automation.is_empty() => self.sends.swap_remove(at).1,
                    Some(at) => std::mem::replace(&mut self.sends[at].1, automation),
                    None if automation.is_empty() => automation,
                    None => {
                        self.sends.push((bus, automation));
                        Automation::default()
                    }
                }
            }
            _ => automation,
        }
    }

    /// The tick of the first breakpoint at or after `from`, of any of them.
    pub fn next_point(&self, from: u64) -> Option<u64> {
        let sends = self.sends.iter().map(|(_, automation)| automation);
        [&self.volume, &self.pan]
            .into_iter()
            .chain(sends)
            .filter_map(|automation| automation.next_point(from))
            .min()
    }

    /// The fader's and the pan's lines over `ticks`, which has no breakpoint
    /// between its first and last.
    pub fn mixer_lines(&self, ticks: &[f64]) -> (Option<Line>, Option<Line>) {
        (over(&self.volume, ticks), over(&self.pan, ticks))
    }

    /// The line the Send to `bus` follows over `ticks`, or none when it
    /// isn't automated.
    pub fn send_line(&self, bus: usize, ticks: &[f64]) -> Option<Line> {
        let (_, automation) = self.sends.iter().find(|(to, _)| *to == bus)?;
        over(automation, ticks)
    }
}

fn over(automation: &Automation, ticks: &[f64]) -> Option<Line> {
    automation.line(*ticks.first()?, *ticks.last()?)
}

/// Automation for the settings of a table, an Effect's or the Synth's, by
/// each setting's place in it. Building it allocates; changing it doesn't.
#[derive(Clone, Debug, Default)]
pub struct TableAutomation {
    lanes: Vec<Automation>,
    /// How many lanes have breakpoints, so an unautomated table costs
    /// nothing.
    automated: usize,
}

impl TableAutomation {
    pub fn new(settings: usize) -> Self {
        Self {
            lanes: vec![Automation::default(); settings],
            automated: 0,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.automated == 0
    }

    /// Replace setting `index`'s Automation, handing back the old one, or
    /// `automation` itself when the table has no such setting.
    pub fn set(&mut self, index: usize, automation: Automation) -> Automation {
        let Some(lane) = self.lanes.get_mut(index) else {
            return automation;
        };
        let old = std::mem::replace(lane, automation);
        self.automated = self.lanes.iter().filter(|lane| !lane.is_empty()).count();
        old
    }

    pub fn next_point(&self, from: u64) -> Option<u64> {
        if self.is_empty() {
            return None;
        }
        self.lanes
            .iter()
            .filter_map(|lane| lane.next_point(from))
            .min()
    }

    /// Render a stretch whose frames are at `ticks`, with no breakpoint
    /// between its first and last, with every automated setting following
    /// its Automation. `set` gives `target` a setting's value and `render`
    /// renders a run of frames. When nothing ramps, the settings are set
    /// once and the stretch renders in one go; while something ramps, each
    /// frame gets its own values. Either way a frame's values depend only
    /// on its tick, so however a song is cut into blocks it sounds the same.
    /// Without `ticks` for each of `frames`, the settings keep their values.
    pub fn drive<T: ?Sized>(
        &self,
        frames: usize,
        ticks: &[f64],
        target: &mut T,
        set: impl Fn(&mut T, usize, f32),
        mut render: impl FnMut(&mut T, std::ops::Range<usize>),
    ) {
        let lines = || {
            self.lanes
                .iter()
                .enumerate()
                .filter_map(|(index, lane)| Some((index, over(lane, ticks)?)))
        };
        if self.is_empty() || ticks.len() != frames || frames == 0 {
            render(target, 0..frames);
        } else if lines().all(|(_, line)| line.is_steady()) {
            for (index, line) in lines() {
                set(target, index, line.at(ticks[0]));
            }
            render(target, 0..frames);
        } else {
            for (frame, &tick) in ticks.iter().enumerate() {
                for (index, line) in lines() {
                    set(target, index, line.at(tick));
                }
                render(target, frame..frame + 1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn volume(flat: &[f64]) -> Automation {
        Automation::from_flat(flat, Automatable::Volume)
    }

    impl Automation {
        fn value_at(&self, tick: f64) -> Option<f32> {
            self.line(tick, tick).map(|line| line.at(tick))
        }
    }

    #[test]
    fn nothing_is_automated_without_breakpoints() {
        let automation = volume(&[]);
        assert_eq!(automation.value_at(0.0), None);
        assert_eq!(automation.line(0.0, 10.0), None);
        assert_eq!(automation.next_point(0), None);
    }

    #[test]
    fn a_value_ramps_between_breakpoints_and_holds_at_either_end() {
        let automation = volume(&[960.0, 0.0, 0.0, 1_920.0, 1.0, 0.0]);
        assert_eq!(automation.value_at(0.0), Some(0.0));
        assert_eq!(automation.value_at(960.0), Some(0.0));
        assert_eq!(automation.value_at(1_440.0), Some(0.5));
        assert_eq!(automation.value_at(1_920.0), Some(1.0));
        assert_eq!(automation.value_at(5_000.0), Some(1.0));
        let line = automation.line(1_200.0, 1_680.0).unwrap();
        assert_eq!((line.at(1_200.0), line.at(1_680.0)), (0.25, 0.75));
    }

    #[test]
    fn a_hold_keeps_its_value_and_steps_at_the_next_breakpoint() {
        let automation = volume(&[0.0, 1.0, 1.0, 960.0, 0.5, 0.0]);
        assert_eq!(automation.value_at(959.9), Some(1.0));
        assert_eq!(automation.value_at(960.0), Some(0.5));
        // Up to a breakpoint, a stretch is on the side it came from.
        assert_eq!(automation.line(480.0, 960.0), Some(Line::steady(1.0)));
    }

    #[test]
    fn breakpoints_are_sorted_clamped_and_the_later_of_two_at_a_tick_wins() {
        let automation = Automation::from_flat(
            &[
                960.0,
                3.0,
                0.0,
                0.0,
                -2.0,
                0.0,
                960.0,
                0.5,
                0.0,
                f64::NAN,
                1.0,
                0.0,
            ],
            Automatable::Pan,
        );
        assert_eq!(automation.value_at(0.0), Some(-1.0));
        assert_eq!(automation.value_at(960.0), Some(0.5));
        assert_eq!(automation.next_point(1), Some(960));
        assert_eq!(automation.next_point(961), None);
    }

    #[test]
    fn settings_are_named_as_the_host_names_them() {
        assert_eq!(Automatable::named("volume"), Some(Automatable::Volume));
        assert_eq!(Automatable::named("pan"), Some(Automatable::Pan));
        assert_eq!(Automatable::named("mute"), None);
        assert_eq!(
            Automatable::named("effect:2:thresholdDb"),
            Some(Automatable::Effect {
                index: 2,
                param: ParamName::new("thresholdDb").unwrap()
            })
        );
        // Any Effect's setting could have the name, a Plugin's too; one that
        // no setting could have is refused.
        assert!(Automatable::named("effect:0:drive").is_some());
        assert_eq!(Automatable::named("effect:0:no such"), None);
        assert_eq!(
            Automatable::named(&format!("effect:0:{}", "a".repeat(33))),
            None
        );
        assert_eq!(
            Automatable::named("pad:3:pitch"),
            Some(Automatable::Pad {
                pad: 3,
                param: PadParam::Pitch
            })
        );
        // A pad's note and choke group pick, and a kit has at most 32 pads.
        assert_eq!(Automatable::named("pad:0:note"), None);
        assert_eq!(Automatable::named("pad:0:chokeGroup"), None);
        assert_eq!(Automatable::named("pad:32:volume"), None);
        assert_eq!(Automatable::named("pad:x:volume"), None);
    }
}

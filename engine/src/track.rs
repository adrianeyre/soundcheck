//! A Track as the engine needs it so far: an Instrument feeding its Insert
//! Chain, the notes it plays, and its mixer channel.
//!
//! An Audio Track has no Instrument and plays its Audio Clips instead,
//! through its own Insert Chain like any other Track.
//!
//! The Instrument and the chain are stereo, because the Drum Sampler pans
//! each pad for itself. The Synth renders the same signal on both sides, so
//! it sounds exactly as it did when the chain was mono.

use crate::audio_clip::AudioClips;
use crate::automation::{Automatable, Automation, ChannelAutomation, Line, TableAutomation};
use crate::bus::{BusSend, Output, feeds};
use crate::effect::InsertChain;
use crate::instrument::{
    Instrument, KEYS_PARAM_COUNT, KEYS_PARAMS, KeysSettings, MAX_PADS, PARAMS, PadParam,
    SynthSettings,
};
use crate::schedule::{NoteList, Schedule};
use crate::transport::Transport;

/// A Track's or Bus's mixer channel: what the fader, the pan control and the
/// two buttons are set to. Where it goes is its `Output`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mixer {
    /// Linear gain: 1 is unity, 2 is +6 dB.
    pub volume: f32,
    /// -1 hard left, 0 centre, 1 hard right.
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
}

impl Default for Mixer {
    fn default() -> Self {
        Self {
            volume: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
        }
    }
}

impl Mixer {
    /// The gain for each side, from the fader and the pan control. Mute and
    /// solo aren't here: they decide whether a Track is in the mix at all,
    /// which is the Engine's to work out, and Audio Analysis ignores them.
    ///
    /// The pan control is a balance: centred, both sides pass at the fader's
    /// gain; turned one way, the other side fades out and reaches silence at
    /// the end of its travel.
    pub fn gains(&self) -> (f32, f32) {
        let pan = self.pan.clamp(-1.0, 1.0);
        (
            self.volume * (1.0 - pan.max(0.0)),
            self.volume * (1.0 + pan.min(0.0)),
        )
    }
}

#[derive(Debug)]
pub struct Track {
    instrument: Instrument,
    /// Empty until the host adds Effects, as a new Track's is in the
    /// Project.
    chain: InsertChain,
    schedule: Schedule,
    /// Whether this is an Audio Track, which plays `clips` and nothing else.
    audio: bool,
    clips: AudioClips,
    mixer: Mixer,
    /// What moves the fader, the pan and the Sends while the song plays.
    automation: ChannelAutomation,
    /// What moves the Synth's settings, by their place in its table. It
    /// stays with the Track when its Instrument changes, and only a Synth
    /// follows it.
    synth_automation: TableAutomation,
    /// The Synth's settings as the host last set them, which an automated
    /// setting goes back to when its Automation is taken away.
    synth_fixed: SynthSettings,
    /// What moves the Keys' settings, by their place in its table, as the
    /// Synth's does, and their settings as the host last set them.
    keys_automation: TableAutomation,
    keys_fixed: KeysSettings,
    /// What moves the Drum Sampler's pads' numbers, by `pad_lane`. Like the
    /// Synth's, it stays with the Track when its Instrument changes, and
    /// only a Drum Sampler follows it; the sampler keeps the fixed values.
    pad_automation: TableAutomation,
    /// The Master, or the Bus it feeds.
    output: Output,
    /// Post-fader copies of its signal, each fed to a Bus.
    sends: Vec<BusSend>,
    /// Whether it is in the mix this block, from mute and solo.
    audible: bool,
    /// The loudest sample this Track last put into the mix, for its meter.
    meter: f32,
    /// The Instrument's output, on its way through the Insert Chain to the
    /// fader and the pan.
    chain_left: Vec<f32>,
    chain_right: Vec<f32>,
    /// Input Monitoring: whether an Audio Track plays the live input the
    /// host hands it, with its Clips, through its Insert Chain.
    monitoring: bool,
    /// The live input for the block being rendered.
    input: LiveInput,
}

/// One block of live input, as the host hands it to a Track, and how much of
/// it has been played.
#[derive(Debug, Default)]
struct LiveInput {
    left: Vec<f32>,
    right: Vec<f32>,
    /// How many frames were handed in.
    frames: usize,
    /// How many have been played, which can run past `frames`.
    read: usize,
}

impl LiveInput {
    fn prepare(&mut self, frames: usize) {
        if self.left.len() < frames {
            self.left.resize(frames, 0.0);
            self.right.resize(frames, 0.0);
        }
    }

    fn set(&mut self, left: &[f32], right: &[f32]) {
        let frames = left.len().min(right.len());
        self.prepare(frames);
        self.left[..frames].copy_from_slice(&left[..frames]);
        self.right[..frames].copy_from_slice(&right[..frames]);
        self.frames = frames;
        self.read = 0;
    }

    fn clear(&mut self) {
        self.frames = 0;
        self.read = 0;
    }

    /// Add the next `left.len()` frames to `left` and `right`, silence past
    /// the end of what was handed in, and move on by as many.
    fn add_to(&mut self, left: &mut [f32], right: &mut [f32]) {
        let from = self.read.min(self.frames);
        let to = (from + left.len()).min(self.frames);
        for (out, input) in left.iter_mut().zip(&self.left[from..to]) {
            *out += input;
        }
        for (out, input) in right.iter_mut().zip(&self.right[from..to]) {
            *out += input;
        }
        self.read += left.len();
    }
}

impl Track {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            instrument: Instrument::synth(sample_rate),
            chain: InsertChain::default(),
            schedule: Schedule::default(),
            audio: false,
            clips: AudioClips::default(),
            mixer: Mixer::default(),
            automation: ChannelAutomation::default(),
            synth_automation: TableAutomation::new(PARAMS.len()),
            synth_fixed: SynthSettings::default(),
            keys_automation: TableAutomation::new(KEYS_PARAM_COUNT),
            keys_fixed: KeysSettings::default(),
            pad_automation: TableAutomation::new(MAX_PADS * PadParam::ALL.len()),
            output: Output::Master,
            sends: Vec::new(),
            audible: true,
            meter: 0.0,
            chain_left: Vec::new(),
            chain_right: Vec::new(),
            monitoring: false,
            input: LiveInput::default(),
        }
    }

    pub fn chain(&self) -> &InsertChain {
        &self.chain
    }

    pub fn chain_mut(&mut self) -> &mut InsertChain {
        &mut self.chain
    }

    /// Make this an Audio Track, or an Instrument Track again. Anything
    /// sounding stops.
    pub fn set_audio(&mut self, audio: bool) {
        if audio != self.audio {
            self.silence();
            self.audio = audio;
        }
    }

    /// Replace the Audio Clips this Track plays, handing back the old ones.
    /// While the transport plays, `rewind`'s arguments say where it is, so a
    /// Clip already under the playhead joins in. Allocates nothing.
    pub fn set_clips(
        &mut self,
        mut clips: AudioClips,
        playing: Option<(u64, &Transport)>,
    ) -> AudioClips {
        if let Some((from, transport)) = playing {
            clips.rewind(from, transport);
        }
        std::mem::replace(&mut self.clips, clips)
    }

    /// Turn Input Monitoring on or off. Only an Audio Track hears its input.
    pub fn set_monitoring(&mut self, on: bool) {
        self.monitoring = on;
    }

    /// The live input for the next block, played from its first frame; what
    /// is left of the last one is dropped. The shorter side decides how many
    /// frames there are. Allocates nothing for a block `prepare` sized for.
    pub fn set_input(&mut self, left: &[f32], right: &[f32]) {
        self.input.set(left, right);
    }

    /// Forget the live input, played or not, so a block the host hands none
    /// for is silent rather than the last one again.
    pub fn clear_input(&mut self) {
        self.input.clear();
    }

    pub fn mixer(&self) -> Mixer {
        self.mixer
    }

    pub fn set_mixer(&mut self, mixer: Mixer) {
        self.mixer = mixer;
    }

    pub fn output(&self) -> Output {
        self.output
    }

    /// Replace the Automation of `setting`, handing back the old one.
    /// Allocates nothing.
    /// `automation` itself comes back for a setting this Track doesn't have.
    pub fn set_automation(&mut self, setting: Automatable, automation: Automation) -> Automation {
        match setting {
            Automatable::Instrument(param) => match &mut self.instrument {
                Instrument::Plugin(plugin) => plugin.set_automation(param.as_str(), automation),
                Instrument::Missing(_) => automation,
                Instrument::Keys(_) => match keys_param(param.as_str()) {
                    Some(index) => {
                        let old = self.keys_automation.set(index, automation);
                        set_keys(&mut self.instrument, index, self.keys_fixed.value(index));
                        old
                    }
                    None => automation,
                },
                _ => match synth_param(param.as_str()) {
                    Some(index) => {
                        let old = self.synth_automation.set(index, automation);
                        set_synth(
                            &mut self.instrument,
                            index,
                            PARAMS[index].get(&self.synth_fixed),
                        );
                        old
                    }
                    None => automation,
                },
            },
            Automatable::Effect { index, param } => match self.chain.effect_mut(index) {
                Some(effect) => effect.set_automation(param.as_str(), automation),
                None => automation,
            },
            Automatable::Pad { pad, param } => match &mut self.instrument {
                Instrument::Plugin(_) | Instrument::Missing(_) => automation,
                instrument => {
                    let old = self.pad_automation.set(pad_lane(pad, param), automation);
                    if let Some(drums) = instrument.drums_mut() {
                        drums.automate(pad, param, None);
                    }
                    old
                }
            },
            _ => self.automation.set(setting, automation),
        }
    }

    pub fn automation(&self) -> &ChannelAutomation {
        &self.automation
    }

    /// The tick of the first breakpoint at or after `from`, of any setting.
    pub fn next_breakpoint(&self, from: u64) -> Option<u64> {
        [
            self.automation.next_point(from),
            self.synth_automation.next_point(from),
            self.keys_automation.next_point(from),
            self.pad_automation.next_point(from),
            self.instrument
                .plugin()
                .and_then(|plugin| plugin.next_breakpoint(from)),
            self.chain.next_breakpoint(from),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /// Only the Engine sets this, having checked the Bus exists.
    pub(crate) fn set_output(&mut self, output: Output) {
        self.output = output;
    }

    pub fn sends(&self) -> &[BusSend] {
        &self.sends
    }

    /// Only the Engine sets these, having checked each Bus exists. Hands back
    /// the Sends it had.
    pub(crate) fn swap_sends(&mut self, sends: Vec<BusSend>) -> Vec<BusSend> {
        std::mem::replace(&mut self.sends, sends)
    }

    pub(crate) fn sends_mut(&mut self) -> &mut Vec<BusSend> {
        &mut self.sends
    }

    /// Every Bus this Track feeds, through its output or a Send.
    pub fn feeds(&self) -> impl Iterator<Item = usize> + '_ {
        feeds(self.output, &self.sends)
    }

    pub fn audible(&self) -> bool {
        self.audible
    }

    pub fn set_audible(&mut self, audible: bool) {
        self.audible = audible;
    }

    /// The loudest sample this Track has put into the mix lately, as the
    /// meter reads it.
    pub fn meter(&self) -> f32 {
        self.meter
    }

    /// Let the meter fall by `factor`, so a peak fades instead of sticking.
    pub fn fall(&mut self, factor: f32) {
        self.meter *= factor;
    }

    /// Replace this Track's Instrument, handing back the old one so a host
    /// can drop it off the audio thread. Anything sounding stops with it.
    pub fn set_instrument(&mut self, instrument: Instrument) -> Instrument {
        self.release_notes();
        if let Some(settings) = instrument.synth_settings() {
            self.synth_fixed = settings;
        }
        if let Some(settings) = instrument.keys_settings() {
            self.keys_fixed = settings;
        }
        std::mem::replace(&mut self.instrument, instrument)
    }

    pub fn instrument(&self) -> &Instrument {
        &self.instrument
    }

    pub fn instrument_mut(&mut self) -> &mut Instrument {
        &mut self.instrument
    }

    /// Change the Synth's sound. Notes already sounding carry on with it.
    /// Ignored unless this Track's Instrument is the Synth.
    pub fn set_synth_settings(&mut self, settings: SynthSettings) {
        if let Some(synth) = self.instrument.synth_mut() {
            synth.set_settings(settings);
            self.synth_fixed = settings;
        }
    }

    /// Change the Keys' sound, as `set_synth_settings` does the Synth's.
    /// Ignored unless this Track's Instrument is the Keys.
    pub fn set_keys_settings(&mut self, settings: KeysSettings) {
        if let Some(keys) = self.instrument.keys_mut() {
            keys.set_settings(settings);
            self.keys_fixed = settings;
        }
    }

    /// This Track's Keys settings as the host set them, or `None` when it plays another Instrument.
    pub fn keys_settings(&self) -> Option<KeysSettings> {
        self.instrument.keys_settings().map(|_| self.keys_fixed)
    }

    /// This Track's Synth settings, or `None` when it plays another
    /// Instrument.
    /// As the host set them: an automated setting gives its fixed value.
    pub fn synth_settings(&self) -> Option<SynthSettings> {
        self.instrument.synth_settings().map(|_| self.synth_fixed)
    }

    pub fn note_on(&mut self, note: u8, velocity: f32) {
        self.instrument.note_on(note, velocity);
    }

    pub fn note_off(&mut self, note: u8) {
        self.instrument.note_off(note);
    }

    /// Replace the notes this Track plays, releasing any that are sounding,
    /// and hand back the old ones. `from` is the playback position, so notes
    /// already passed are skipped. Allocates nothing.
    pub fn set_notes(&mut self, notes: NoteList, from: u64) -> NoteList {
        self.release_notes();
        self.schedule.set_notes(notes, from)
    }

    /// Size the render buffers for blocks of up to `frames`, so rendering
    /// them allocates nothing.
    pub fn prepare(&mut self, frames: usize) {
        if self.chain_left.len() < frames {
            self.chain_left.resize(frames, 0.0);
            self.chain_right.resize(frames, 0.0);
        }
        self.input.prepare(frames);
        self.chain.prepare(frames);
    }

    /// The earliest tick, at or after `from`, when a note starts or ends.
    pub fn next_event(&self, from: u64) -> Option<u64> {
        let clips = self.clips.next_event(from);
        match self.schedule.next_event(from) {
            Some(note) => Some(clips.map_or(note, |clip| clip.min(note))),
            None => clips,
        }
    }

    /// End the notes that end at `tick`, then start the ones that start
    /// there. `transport` is at `tick`.
    pub fn play_events_at(&mut self, tick: u64, transport: &Transport) {
        let instrument = &mut self.instrument;
        self.schedule
            .end_notes_at(tick, |pitch| instrument.note_off(pitch));
        self.schedule
            .start_notes_at(tick, |pitch, velocity| instrument.note_on(pitch, velocity));
        self.clips.play_events_at(tick, transport);
    }

    /// Release scheduled notes that are sounding, and continue from `tick`.
    /// `transport` is at `tick` or just before it: an Audio Clip under the
    /// playhead picks up from there.
    pub fn rewind(&mut self, tick: u64, transport: &Transport) {
        self.silence();
        self.schedule.rewind(tick);
        self.clips.rewind(tick, transport);
    }

    /// Stop everything sounding, as the transport does when it stops or
    /// moves: scheduled notes are released, and drums, which play on past
    /// their note off, are cut short.
    pub fn silence(&mut self) {
        self.release_notes();
        if let Some(drums) = self.instrument.drums_mut() {
            drums.release_all();
        }
        if let Some(keys) = self.instrument.keys_mut() {
            keys.release_all();
        }
        self.clips.silence();
    }

    /// Release the scheduled notes and end the Audio Clips, as an offline
    /// render does where its range ends. Unlike `silence`, drums ring on, as
    /// a Synth's release and the Insert Chain's tails do.
    pub fn end_scheduled(&mut self) {
        self.release_notes();
        self.clips.silence();
    }

    /// Release every scheduled note that is sounding.
    pub fn release_notes(&mut self) {
        let instrument = &mut self.instrument;
        self.schedule
            .release_all(|pitch| instrument.note_off(pitch));
    }

    /// Voices sounding, counting each Audio Clip that is playing as one.
    pub fn active_voices(&self) -> usize {
        self.instrument.active_voices() + self.clips.playing()
    }

    /// Render `left.len()` frames through the Insert Chain and the mixer
    /// channel, and add them to `left` and `right`, scaled by `gain`. The
    /// meter takes the loudest sample added, so it measures exactly what
    /// reaches the Master.
    pub fn render_into(&mut self, left: &mut [f32], right: &mut [f32], gain: f32) {
        self.render_at(left, right, gain, &[]);
    }

    /// `render_into`, with the fader and the pan following their Automation:
    /// `ticks` says where in the song each frame is, and has no breakpoint
    /// between its first and last. Without ticks, or without Automation,
    /// they keep their fixed values.
    pub fn render_at(&mut self, left: &mut [f32], right: &mut [f32], gain: f32, ticks: &[f64]) {
        let frames = left.len();
        if frames == 0 {
            return;
        }
        self.prepare(frames);
        let chain_left = &mut self.chain_left[..frames];
        let chain_right = &mut self.chain_right[..frames];
        let ticks = if ticks.len() == frames { ticks } else { &[] };
        if self.audio {
            chain_left.fill(0.0);
            chain_right.fill(0.0);
            self.clips.render_into(chain_left, chain_right);
            if self.monitoring {
                self.input.add_to(chain_left, chain_right);
            }
        } else {
            let render = |instrument: &mut Instrument, run: std::ops::Range<usize>| {
                let at = ticks.get(run.clone()).unwrap_or_default();
                instrument.render(&mut chain_left[run.clone()], &mut chain_right[run], at);
            };
            if matches!(self.instrument, Instrument::Drums(_)) {
                self.pad_automation
                    .drive(frames, ticks, &mut self.instrument, set_pad, render);
            } else if matches!(self.instrument, Instrument::Keys(_)) {
                self.keys_automation
                    .drive(frames, ticks, &mut self.instrument, set_keys, render);
            } else {
                self.synth_automation
                    .drive(frames, ticks, &mut self.instrument, set_synth, render);
            }
        }
        self.chain.process_at(chain_left, chain_right, ticks);

        let gains = ChannelGains::new(self.mixer, gain, &self.automation, ticks);
        let mut meter = self.meter;
        for (frame, (((&channel_l, &channel_r), l), r)) in chain_left
            .iter()
            .zip(chain_right.iter())
            .zip(left.iter_mut())
            .zip(right.iter_mut())
            .enumerate()
        {
            let (gain_left, gain_right) = gains.at(frame, ticks);
            let (out_l, out_r) = (channel_l * gain_left, channel_r * gain_right);
            meter = meter.max(out_l.abs()).max(out_r.abs());
            *l += out_l;
            *r += out_r;
        }
        self.meter = meter;
    }
}

/// Where the Synth's setting called `name` is in its table, if Automation
/// can move it: a number, not a choice.
fn synth_param(name: &str) -> Option<usize> {
    PARAMS
        .iter()
        .position(|param| param.name == name && param.choices.is_empty())
}

/// Set the Synth's setting at `index` to `value`, as its table clamps and
/// rounds it. Only a change is applied, so a steady Automation costs
/// nothing. Allocates nothing.
fn set_synth(instrument: &mut Instrument, index: usize, value: f32) {
    if let Some(synth) = instrument.synth_mut() {
        let mut settings = synth.settings();
        PARAMS[index].set(&mut settings, value);
        if settings != synth.settings() {
            synth.set_settings(settings);
        }
    }
}

/// Where the Keys' setting called `name` is in its table, if Automation can
/// move it: a continuous number, not a choice or a count.
fn keys_param(name: &str) -> Option<usize> {
    KEYS_PARAMS
        .iter()
        .position(|param| param.name == name && param.choices.is_empty() && param.step == 0.0)
}

/// Set the Keys' setting at `index` to `value`, clamped. Allocates nothing.
fn set_keys(instrument: &mut Instrument, index: usize, value: f32) {
    if let Some(keys) = instrument.keys_mut() {
        keys.set_setting(index, value);
    }
}

/// Where pad `pad`'s `param` is in a Track's pad Automation.
fn pad_lane(pad: usize, param: PadParam) -> usize {
    pad * PadParam::ALL.len() + param.index()
}

/// Hold the number at `lane` (see `pad_lane`) of a Drum Sampler's pad at
/// `value`. Allocates nothing.
fn set_pad(instrument: &mut Instrument, lane: usize, value: f32) {
    if let Some(drums) = instrument.drums_mut() {
        let params = PadParam::ALL.len();
        drums.automate(lane / params, PadParam::ALL[lane % params], Some(value));
    }
}

/// A channel's gain for each side, frame by frame, as its fader and pan
/// follow their Automation over a stretch with no breakpoint inside it.
pub struct ChannelGains {
    mixer: Mixer,
    gain: f32,
    lines: (Option<Line>, Option<Line>),
    /// The gains for every frame, when nothing ramps.
    steady: Option<(f32, f32)>,
}

impl ChannelGains {
    /// `gain` scales both sides; `ticks` is where in the song each frame
    /// is, or empty to keep the fixed values.
    pub fn new(mixer: Mixer, gain: f32, automation: &ChannelAutomation, ticks: &[f64]) -> Self {
        let lines = automation.mixer_lines(ticks);
        let mut gains = Self {
            mixer,
            gain,
            lines,
            steady: None,
        };
        if lines.0.is_none_or(|l| l.is_steady()) && lines.1.is_none_or(|l| l.is_steady()) {
            gains.steady = Some(gains.compute(0, ticks));
        }
        gains
    }

    pub fn at(&self, frame: usize, ticks: &[f64]) -> (f32, f32) {
        self.steady.unwrap_or_else(|| self.compute(frame, ticks))
    }

    fn compute(&self, frame: usize, ticks: &[f64]) -> (f32, f32) {
        let at = |line: Option<Line>, fixed: f32| line.map_or(fixed, |line| line.at(ticks[frame]));
        let (pan_left, pan_right) = Mixer {
            volume: at(self.lines.0, self.mixer.volume).max(0.0),
            pan: at(self.lines.1, self.mixer.pan),
            ..self.mixer
        }
        .gains();
        (self.gain * pan_left, self.gain * pan_right)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::peak;
    use crate::instrument::{PadSettings, STARTER_KIT_PADS};

    #[test]
    fn a_note_comes_out_of_both_sides_and_adds_to_what_is_there() {
        let mut track = Track::new(48_000.0);
        track.note_on(60, 1.0);
        let mut left = vec![0.0; 4_800];
        let mut right = vec![0.0; 4_800];
        track.render_into(&mut left, &mut right, 1.0);
        assert!(peak(&left) > 0.05);
        assert!(peak(&right) > 0.05);

        let mut offset = vec![1.0; 128];
        let mut other = vec![1.0; 128];
        Track::new(48_000.0).render_into(&mut offset, &mut other, 1.0);
        assert_eq!(offset, vec![1.0; 128], "silence adds nothing");
    }

    #[test]
    fn scheduled_notes_play_and_release() {
        let mut track = Track::new(48_000.0);
        track.set_notes(NoteList::from_flat(&[0.0, 960.0, 60.0, 1.0]), 0);
        track.play_events_at(0, &Transport::new(48_000.0));
        assert_eq!(track.active_voices(), 1);
        track.release_notes();
        let mut left = vec![0.0; 48_000];
        let mut right = vec![0.0; 48_000];
        track.render_into(&mut left, &mut right, 1.0);
        assert_eq!(track.active_voices(), 0);
    }

    #[test]
    fn the_drum_sampler_plays_the_notes_the_track_schedules() {
        let mut track = Track::new(48_000.0);
        track.set_instrument(Instrument::drum_sampler(48_000.0, STARTER_KIT_PADS));
        // One kick (note 36), which a note off must not cut short.
        track.set_notes(NoteList::from_flat(&[0.0, 240.0, 36.0, 1.0]), 0);
        track.play_events_at(0, &Transport::new(48_000.0));
        let mut left = vec![0.0; 4_800];
        let mut right = vec![0.0; 4_800];
        track.render_into(&mut left, &mut right, 1.0);
        assert!(peak(&left) > 0.05, "the kick plays");
        assert_eq!(track.active_voices(), 1);
    }

    #[test]
    fn swapping_the_instrument_hands_the_old_one_back_and_silences_it() {
        let mut track = Track::new(48_000.0);
        track.note_on(60, 1.0);
        let old = track.set_instrument(Instrument::drum_sampler(48_000.0, STARTER_KIT_PADS));
        assert_eq!(old.kind(), "synth");
        assert_eq!(track.instrument().kind(), "drumSampler");
        assert_eq!(track.active_voices(), 0);
    }

    #[test]
    fn a_pad_panned_hard_right_leaves_the_left_side_alone() {
        let mut track = Track::new(48_000.0);
        track.set_instrument(Instrument::drum_sampler(48_000.0, STARTER_KIT_PADS));
        let drums = track.instrument_mut().drums_mut().unwrap();
        let settings = drums.pad_settings(0).unwrap();
        drums.set_pad(
            0,
            PadSettings {
                pan: 1.0,
                ..settings
            },
        );
        track.note_on(36, 1.0);

        let mut left = vec![0.0; 4_800];
        let mut right = vec![0.0; 4_800];
        track.render_into(&mut left, &mut right, 1.0);
        assert!(peak(&right) > 0.05);
        assert!(peak(&left) < peak(&right) / 4.0, "{} ", peak(&left));
    }
}

//! The DJ Mixer behind the **Mixing** page (ADR 0013): four **Decks** into
//! a four-channel mixer with a **Crossfader**, Colour FX, Beat FX and a
//! headphone cue, as a CDJ-3000 set-up into a DJM-V10 plays.
//!
//! It is not part of the song. Nothing here touches a Track, Bus or the
//! Master: the Engine renders it beside the song and adds it to the output
//! after the song's Master is metered, so it is never in a meter, an Audio
//! Analysis or an export of the song. Its state is the DJ's session, never
//! the Project's.
//!
//! The host drives it with named controls (`DjControl::parse`), parsed off
//! the audio thread on the desktop, and reads it back as one flat report
//! (`DjMixer::report`). A file reaches a Deck decoded and analysed, whole.

mod analysis;
mod beat_fx;
mod channel;
mod colour;
mod deck;
mod stretch;

pub use analysis::{TrackAnalysis, WAVEFORM_RATE, analyse};
pub use beat_fx::BEAT_FX;
pub use colour::COLOUR_FX;
pub use deck::DjTrack;

use beat_fx::BeatFx;
use channel::Channel;
use deck::Deck;

use crate::audio_file::{AudioFile, AudioFileError, decode};
use crate::engine::PreparedAudioFile;

/// How many Decks, and mixer channels, there are.
pub const DECKS: usize = 4;
/// The report's layout: `GLOBAL_FIELDS` numbers for the mixer, then
/// `DECK_FIELDS` for each Deck. Mirrored in `app/src/dj/dj-report.ts`.
pub const GLOBAL_FIELDS: usize = 8;
pub const DECK_FIELDS: usize = 24;
pub const DJ_REPORT_LEN: usize = GLOBAL_FIELDS + DECKS * DECK_FIELDS;
/// How much of the recording the engine holds before the host takes it.
const RECORD_SECONDS: f32 = 4.0;
/// How fast a meter falls back from a peak, in dB per second.
const METER_FALL_DB_PER_SECOND: f32 = 20.0;
/// How far out of step Sync lets the beats get before it jumps them back
/// into line rather than easing them, in beats.
const SYNC_JUMP_BEATS: f64 = 0.25;

/// A file decoded and analysed for a Deck, off the audio thread.
#[derive(Debug)]
pub struct PreparedDjTrack {
    pub track: DjTrack,
    pub analysis: TrackAnalysis,
}

impl PreparedDjTrack {
    /// Decode a WAV, FLAC or MP3 file's bytes for an engine at
    /// `sample_rate` and analyse it.
    pub fn decode(bytes: &[u8], sample_rate: f32) -> Result<Self, AudioFileError> {
        let decoded = decode(bytes)?;
        let file = AudioFile::from_decoded(&decoded, sample_rate);
        let analysis = analyse(file.left(), file.right(), sample_rate);
        Ok(Self {
            track: DjTrack {
                file: PreparedAudioFile::from_file(file),
                bpm: analysis.bpm,
                first_beat: analysis.first_beat,
            },
            analysis,
        })
    }
}

/// One thing a host can set on the DJ Mixer. Parsed from its name off the
/// audio thread, so applying it allocates nothing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DjControl {
    Deck(usize, DeckControl),
    Channel(usize, ChannelControl),
    Mixer(MixerControl),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DeckControl {
    Play,
    CueDown,
    CueUp,
    SetCue,
    Seek,
    JumpHold,
    JumpRelease,
    BeatJump,
    LoopIn,
    LoopOut,
    AutoLoop,
    ResizeLoop,
    ExitLoop,
    Reloop,
    Tempo,
    Bend,
    Touch,
    Scratch,
    Reverse,
    Slip,
    MasterTempo,
    KeyShift,
    Quantize,
    Sync,
    SyncMaster,
    Brake,
    Spinback,
    GridBpm,
    GridOffset,
    Eject,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ChannelControl {
    Trim,
    Eq(usize),
    Compression,
    Colour,
    Fader,
    Curve,
    Assign,
    Cue,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MixerControl {
    Crossfader,
    CrossfaderCurve,
    CrossfaderReverse,
    Master,
    Booth,
    HeadphoneMix,
    HeadphoneLevel,
    Isolator,
    ColourType,
    ColourParameter,
    BeatFxType,
    BeatFxDivision,
    BeatFxTarget,
    BeatFxLevel,
    BeatFxOn,
    Bpm,
    Record,
}

impl DjControl {
    /// The control `name` of a Deck, a channel (both by `index`, from 0) or
    /// the mixer, as `kind` says; None for one there isn't.
    pub fn parse(kind: &str, index: usize, name: &str) -> Option<Self> {
        use ChannelControl as C;
        use DeckControl as D;
        use MixerControl as M;
        match kind {
            "deck" if index < DECKS => Some(Self::Deck(
                index,
                match name {
                    "play" => D::Play,
                    "cueDown" => D::CueDown,
                    "cueUp" => D::CueUp,
                    "setCue" => D::SetCue,
                    "seek" => D::Seek,
                    "jumpHold" => D::JumpHold,
                    "jumpRelease" => D::JumpRelease,
                    "beatJump" => D::BeatJump,
                    "loopIn" => D::LoopIn,
                    "loopOut" => D::LoopOut,
                    "autoLoop" => D::AutoLoop,
                    "resizeLoop" => D::ResizeLoop,
                    "exitLoop" => D::ExitLoop,
                    "reloop" => D::Reloop,
                    "tempo" => D::Tempo,
                    "bend" => D::Bend,
                    "touch" => D::Touch,
                    "scratch" => D::Scratch,
                    "reverse" => D::Reverse,
                    "slip" => D::Slip,
                    "masterTempo" => D::MasterTempo,
                    "keyShift" => D::KeyShift,
                    "quantize" => D::Quantize,
                    "sync" => D::Sync,
                    "syncMaster" => D::SyncMaster,
                    "brake" => D::Brake,
                    "spinback" => D::Spinback,
                    "gridBpm" => D::GridBpm,
                    "gridOffset" => D::GridOffset,
                    "eject" => D::Eject,
                    _ => return None,
                },
            )),
            "channel" if index < DECKS => Some(Self::Channel(
                index,
                match name {
                    "trim" => C::Trim,
                    "eqLow" => C::Eq(0),
                    "eqLowMid" => C::Eq(1),
                    "eqHighMid" => C::Eq(2),
                    "eqHigh" => C::Eq(3),
                    "compression" => C::Compression,
                    "colour" => C::Colour,
                    "fader" => C::Fader,
                    "curve" => C::Curve,
                    "assign" => C::Assign,
                    "cue" => C::Cue,
                    _ => return None,
                },
            )),
            "mixer" => Some(Self::Mixer(match name {
                "crossfader" => M::Crossfader,
                "crossfaderCurve" => M::CrossfaderCurve,
                "crossfaderReverse" => M::CrossfaderReverse,
                "master" => M::Master,
                "booth" => M::Booth,
                "headphoneMix" => M::HeadphoneMix,
                "headphoneLevel" => M::HeadphoneLevel,
                "isolator" => M::Isolator,
                "colourType" => M::ColourType,
                "colourParameter" => M::ColourParameter,
                "beatFxType" => M::BeatFxType,
                "beatFxDivision" => M::BeatFxDivision,
                "beatFxTarget" => M::BeatFxTarget,
                "beatFxLevel" => M::BeatFxLevel,
                "beatFxOn" => M::BeatFxOn,
                "bpm" => M::Bpm,
                "record" => M::Record,
                _ => return None,
            })),
            _ => None,
        }
    }
}

/// How the Crossfader blends side A (`position` -1) with side B (1).
pub fn crossfade(position: f32, curve: u8) -> (f32, f32) {
    let p = (position.clamp(-1.0, 1.0) + 1.0) * 0.5;
    match curve {
        // Sharp cut, for scratching: both sides full across the middle.
        2 => (((1.0 - p) * 16.0).min(1.0), (p * 16.0).min(1.0)),
        // Constant power.
        1 => (
            (p * std::f32::consts::FRAC_PI_2).cos(),
            (p * std::f32::consts::FRAC_PI_2).sin(),
        ),
        // Smooth: both full at the centre, each fading out to its far end.
        _ => ((2.0 * (1.0 - p)).min(1.0), (2.0 * p).min(1.0)),
    }
}

/// Which signal the Beat FX works on.
fn beat_fx_target(value: f64) -> u8 {
    value.clamp(0.0, 6.0) as u8
}

#[derive(Debug)]
pub struct DjMixer {
    sample_rate: f32,
    decks: [Deck; DECKS],
    channels: [Channel; DECKS],
    /// Which Deck the others Sync to.
    sync_master: Option<usize>,
    /// Each Deck's Sync, and whether it has lined its beats up yet.
    synced: [bool; DECKS],
    aligned: [bool; DECKS],
    crossfader: f32,
    crossfader_curve: u8,
    crossfader_reverse: bool,
    master: f32,
    booth: f32,
    headphone_mix: f32,
    headphone_level: f32,
    isolator: bool,
    colour_type: u8,
    colour_parameter: f32,
    beat_fx: BeatFx,
    /// 0 to 3 a channel, 4 side A, 5 side B, 6 the Master.
    beat_fx_target: u8,
    /// The BPM tapped in for the Beat FX, or 0 to follow the Sync Master.
    bpm: f64,
    deck_buffers: [[Vec<f32>; 2]; DECKS],
    sides: [[Vec<f32>; 2]; 3],
    out: [Vec<f32>; 2],
    cue: [Vec<f32>; 2],
    /// Meters, falling back from their peaks.
    channel_meters: [f32; DECKS],
    master_meters: [f32; 2],
    recording: bool,
    recorded: Vec<f32>,
    recorded_frames: u64,
}

impl DjMixer {
    pub fn new(sample_rate: f32) -> Self {
        let block = || [Vec::new(), Vec::new()];
        Self {
            sample_rate,
            decks: std::array::from_fn(|_| Deck::new(sample_rate)),
            channels: std::array::from_fn(|_| Channel::new(sample_rate)),
            sync_master: None,
            synced: [false; DECKS],
            aligned: [false; DECKS],
            crossfader: 0.0,
            crossfader_curve: 0,
            crossfader_reverse: false,
            master: 1.0,
            booth: 1.0,
            headphone_mix: 0.0,
            headphone_level: 0.8,
            isolator: false,
            colour_type: 5,
            colour_parameter: 0.3,
            beat_fx: BeatFx::new(sample_rate),
            beat_fx_target: 6,
            bpm: 0.0,
            deck_buffers: std::array::from_fn(|_| block()),
            sides: std::array::from_fn(|_| block()),
            out: block(),
            cue: block(),
            channel_meters: [0.0; DECKS],
            master_meters: [0.0; 2],
            recording: false,
            recorded: Vec::with_capacity((RECORD_SECONDS * sample_rate) as usize * 2),
            recorded_frames: 0,
        }
    }

    /// Size the buffers for blocks of up to `frames`. Allocates, so a native
    /// host calls it before playing.
    pub fn prepare(&mut self, frames: usize) {
        let buffers = self
            .deck_buffers
            .iter_mut()
            .chain(self.sides.iter_mut())
            .chain([&mut self.out, &mut self.cue]);
        for pair in buffers {
            for buffer in pair {
                if buffer.len() < frames {
                    buffer.resize(frames, 0.0);
                }
            }
        }
    }

    /// Put a file on Deck `deck`, or take it off with None, handing back
    /// the one it replaces to be dropped off the audio thread.
    pub fn load(&mut self, deck: usize, track: Option<DjTrack>) -> Option<DjTrack> {
        let deck_index = deck;
        let deck = self.decks.get_mut(deck_index)?;
        let old = deck.load(track);
        self.aligned[deck_index] = false;
        old
    }

    /// Whether any Deck is sounding, so a host can skip the mixer's work.
    pub fn is_active(&self) -> bool {
        self.decks.iter().any(Deck::is_playing)
            || self.master_meters.iter().any(|&m| m > 1e-4)
            || self.beat_fx.on
    }

    /// The Beat FX's BPM: tapped in, or the Sync Master's, or a playing
    /// Deck's, or 120.
    pub fn master_bpm(&self) -> f64 {
        if self.bpm > 0.0 {
            return self.bpm;
        }
        self.sync_master
            .map(|m| self.decks[m].effective_bpm())
            .filter(|&bpm| bpm > 0.0)
            .or_else(|| {
                self.decks
                    .iter()
                    .filter(|d| d.is_playing())
                    .map(Deck::effective_bpm)
                    .find(|&bpm| bpm > 0.0)
            })
            .unwrap_or(120.0)
    }

    /// Set a control to `value`. Switches are on above 0.5.
    pub fn apply(&mut self, control: DjControl, value: f64) {
        let on = value >= 0.5;
        let v = value as f32;
        match control {
            DjControl::Deck(index, control) => self.apply_deck(index, control, value),
            DjControl::Channel(index, control) => {
                let channel = &mut self.channels[index];
                match control {
                    ChannelControl::Trim => channel.trim_db = v,
                    ChannelControl::Eq(band) => channel.eq_db[band] = v,
                    ChannelControl::Compression => channel.set_compression(v),
                    ChannelControl::Colour => channel.colour = v.clamp(-1.0, 1.0),
                    ChannelControl::Fader => channel.fader = v.clamp(0.0, 1.0),
                    ChannelControl::Curve => channel.curve = value.clamp(0.0, 2.0) as u8,
                    ChannelControl::Assign => channel.assign = value.clamp(0.0, 2.0) as u8,
                    ChannelControl::Cue => channel.cue = on,
                }
            }
            DjControl::Mixer(control) => match control {
                MixerControl::Crossfader => self.crossfader = v.clamp(-1.0, 1.0),
                MixerControl::CrossfaderCurve => {
                    self.crossfader_curve = value.clamp(0.0, 2.0) as u8
                }
                MixerControl::CrossfaderReverse => self.crossfader_reverse = on,
                MixerControl::Master => self.master = v.clamp(0.0, 2.0),
                MixerControl::Booth => self.booth = v.clamp(0.0, 2.0),
                MixerControl::HeadphoneMix => self.headphone_mix = v.clamp(0.0, 1.0),
                MixerControl::HeadphoneLevel => self.headphone_level = v.clamp(0.0, 2.0),
                MixerControl::Isolator => self.isolator = on,
                MixerControl::ColourType => {
                    self.colour_type = value.clamp(0.0, (COLOUR_FX.len() - 1) as f64) as u8
                }
                MixerControl::ColourParameter => self.colour_parameter = v.clamp(0.0, 1.0),
                MixerControl::BeatFxType => {
                    self.beat_fx.kind = value.clamp(0.0, (BEAT_FX.len() - 1) as f64) as u8
                }
                MixerControl::BeatFxDivision => {
                    self.beat_fx.division = value.clamp(1.0 / 64.0, 64.0)
                }
                MixerControl::BeatFxTarget => self.beat_fx_target = beat_fx_target(value),
                MixerControl::BeatFxLevel => self.beat_fx.level = v.clamp(0.0, 1.0),
                MixerControl::BeatFxOn => self.beat_fx.on = on,
                MixerControl::Bpm => self.bpm = if value > 20.0 { value.min(999.0) } else { 0.0 },
                MixerControl::Record => {
                    if on && !self.recording {
                        self.recorded_frames = 0;
                        self.recorded.clear();
                    }
                    self.recording = on;
                }
            },
        }
    }

    fn apply_deck(&mut self, index: usize, control: DeckControl, value: f64) {
        let on = value >= 0.5;
        let deck = &mut self.decks[index];
        match control {
            DeckControl::Play => {
                deck.play(on);
                self.aligned[index] = false;
            }
            DeckControl::CueDown => deck.cue_down(),
            DeckControl::CueUp => deck.cue_up(),
            DeckControl::SetCue => deck.set_cue(value),
            DeckControl::Seek => {
                deck.seek(value);
                self.aligned[index] = false;
            }
            DeckControl::JumpHold => {
                deck.jump_hold(value);
                self.aligned[index] = false;
            }
            DeckControl::JumpRelease => deck.jump_release(),
            DeckControl::BeatJump => deck.beat_jump(value),
            DeckControl::LoopIn => deck.loop_in(value),
            DeckControl::LoopOut => deck.loop_out(value),
            DeckControl::AutoLoop => deck.auto_loop(value),
            DeckControl::ResizeLoop => deck.resize_loop(value),
            DeckControl::ExitLoop => deck.exit_loop(),
            DeckControl::Reloop => deck.reloop(),
            DeckControl::Tempo => deck.tempo = value.clamp(-1.0, 1.0),
            DeckControl::Bend => deck.bend = value.clamp(-0.9, 0.9),
            DeckControl::Touch => deck.touch(on),
            DeckControl::Scratch => deck.scratch_to(value),
            DeckControl::Reverse => deck.set_reverse(on),
            DeckControl::Slip => deck.set_slip(on),
            DeckControl::MasterTempo => deck.master_tempo = on,
            DeckControl::KeyShift => deck.key_shift = value.clamp(-12.0, 12.0).round(),
            DeckControl::Quantize => deck.quantize = on,
            DeckControl::Brake => deck.brake(value),
            DeckControl::Spinback => deck.spinback(value),
            DeckControl::GridBpm => {
                let (_, first) = deck.grid();
                deck.set_grid(value, first);
            }
            DeckControl::GridOffset => {
                let (bpm, _) = deck.grid();
                deck.set_grid(bpm, value);
            }
            DeckControl::Eject => {
                // Only a paused Deck gives up its file, as a CDJ does; the
                // host drops it when it next loads.
                if !deck.is_playing() {
                    deck.load(None);
                }
            }
            DeckControl::SyncMaster => {
                self.sync_master = Some(index);
                self.decks[index].sync_rate = None;
                self.decks[index].phase_trim = 0.0;
            }
            DeckControl::Sync => self.set_sync(index, on),
        }
    }

    fn set_sync(&mut self, index: usize, on: bool) {
        self.synced[index] = on;
        self.aligned[index] = false;
        if on {
            let has_master = self
                .sync_master
                .is_some_and(|m| m != index && self.decks[m].is_loaded());
            if !has_master {
                // The first other Deck playing, or loaded, leads; with none,
                // this one does.
                let other = (0..DECKS)
                    .filter(|&d| d != index && self.decks[d].is_loaded())
                    .max_by_key(|&d| self.decks[d].is_playing());
                self.sync_master = Some(other.unwrap_or(index));
            }
        } else {
            let deck = &mut self.decks[index];
            // The tempo it had while synced stays, as on a CDJ.
            if let Some(rate) = deck.sync_rate.take() {
                deck.tempo = rate - 1.0;
            }
            deck.phase_trim = 0.0;
        }
    }

    /// Keep every synced Deck at the Master's tempo, its beats on the
    /// Master's.
    fn follow_sync(&mut self) {
        let Some(master) = self.sync_master else {
            return;
        };
        let leader_bpm = self.decks[master].effective_bpm();
        let leader_beat = self.decks[master].beat_position();
        for index in 0..DECKS {
            if index == master || !self.synced[index] {
                continue;
            }
            let (bpm, _) = self.decks[index].grid();
            if bpm <= 0.0 || leader_bpm <= 0.0 {
                continue;
            }
            let rate = leader_bpm / bpm;
            let deck = &mut self.decks[index];
            deck.sync_rate = Some(rate);
            let (Some(theirs), Some(ours)) = (leader_beat, deck.beat_position()) else {
                continue;
            };
            if !deck.is_playing() || !self.decks[master].is_playing() {
                self.decks[index].phase_trim = 0.0;
                continue;
            }
            let deck = &mut self.decks[index];
            let error = (theirs.fract() - ours.fract() + 1.5).rem_euclid(1.0) - 0.5;
            if !self.aligned[index] || error.abs() > SYNC_JUMP_BEATS {
                deck.shift_beats(error);
                deck.phase_trim = 0.0;
                self.aligned[index] = true;
            } else {
                // Ease the last of it out over about half a second.
                let beat_seconds = 60.0 / leader_bpm;
                deck.phase_trim = (2.0 * error * beat_seconds).clamp(-0.03, 0.03);
            }
        }
    }

    /// Render the next `frames` of the mix. Allocates nothing once
    /// `prepare` has sized it for `frames`.
    pub fn render(&mut self, frames: usize) {
        self.prepare(frames);
        self.follow_sync();
        let bpm = self.master_bpm();
        let fall = 10f32.powf(-METER_FALL_DB_PER_SECOND * frames as f32 / self.sample_rate / 20.0);
        for side in &mut self.sides {
            side[0][..frames].fill(0.0);
            side[1][..frames].fill(0.0);
        }
        self.cue[0][..frames].fill(0.0);
        self.cue[1][..frames].fill(0.0);

        for index in 0..DECKS {
            let [left, right] = &mut self.deck_buffers[index];
            let (left, right) = (&mut left[..frames], &mut right[..frames]);
            self.decks[index].render(left, right);
            let channel = &mut self.channels[index];
            channel.process(
                left,
                right,
                self.isolator,
                (self.colour_type, self.colour_parameter),
                bpm,
            );
            self.channel_meters[index] = (self.channel_meters[index] * fall).max(channel.peak);
            if channel.cue {
                for (c, s) in self.cue[0][..frames].iter_mut().zip(left.iter()) {
                    *c += s;
                }
                for (c, s) in self.cue[1][..frames].iter_mut().zip(right.iter()) {
                    *c += s;
                }
            }
            let gain = channel.gain();
            for s in left.iter_mut().chain(right.iter_mut()) {
                *s *= gain;
            }
            if self.beat_fx_target as usize == index {
                self.beat_fx.process(left, right, bpm);
            }
            let side = match channel.assign {
                0 => 0,
                2 => 1,
                _ => 2,
            };
            let [side_l, side_r] = &mut self.sides[side];
            for (o, s) in side_l[..frames].iter_mut().zip(left.iter()) {
                *o += s;
            }
            for (o, s) in side_r[..frames].iter_mut().zip(right.iter()) {
                *o += s;
            }
        }

        for (target, side) in [(4, 0), (5, 1)] {
            if self.beat_fx_target == target {
                let [left, right] = &mut self.sides[side];
                self.beat_fx
                    .process(&mut left[..frames], &mut right[..frames], bpm);
            }
        }
        let position = if self.crossfader_reverse {
            -self.crossfader
        } else {
            self.crossfader
        };
        let (a, b) = crossfade(position, self.crossfader_curve);
        let [out_l, out_r] = &mut self.out;
        for i in 0..frames {
            out_l[i] = self.sides[0][0][i] * a + self.sides[1][0][i] * b + self.sides[2][0][i];
            out_r[i] = self.sides[0][1][i] * a + self.sides[1][1][i] * b + self.sides[2][1][i];
        }
        if self.beat_fx_target == 6 {
            self.beat_fx
                .process(&mut out_l[..frames], &mut out_r[..frames], bpm);
        }
        let mut peaks = [0.0f32; 2];
        for (side, buffer) in [&mut *out_l, &mut *out_r].into_iter().enumerate() {
            for s in &mut buffer[..frames] {
                *s = (*s * self.master).clamp(-1.0, 1.0);
                peaks[side] = peaks[side].max(s.abs());
            }
        }
        for (meter, peak) in self.master_meters.iter_mut().zip(peaks) {
            *meter = (*meter * fall).max(peak);
        }
        if self.recording {
            let room = (self.recorded.capacity() - self.recorded.len()) / 2;
            for i in 0..frames.min(room) {
                self.recorded.push(out_l[i]);
                self.recorded.push(out_r[i]);
            }
            self.recorded_frames += frames as u64;
        }
        // The headphones: what is cued, blended with the Master.
        let (cue_gain, master_gain) = (
            (1.0 - self.headphone_mix) * self.headphone_level,
            self.headphone_mix * self.headphone_level,
        );
        for i in 0..frames {
            self.cue[0][i] = (self.cue[0][i] * cue_gain + out_l[i] * master_gain).clamp(-1.0, 1.0);
            self.cue[1][i] = (self.cue[1][i] * cue_gain + out_r[i] * master_gain).clamp(-1.0, 1.0);
        }
    }

    /// The last block's mix, left and right.
    pub fn output(&self) -> (&[f32], &[f32]) {
        (&self.out[0], &self.out[1])
    }

    /// The last block's headphone mix, left and right.
    pub fn headphones(&self) -> (&[f32], &[f32]) {
        (&self.cue[0], &self.cue[1])
    }

    /// The recording since it was last taken, interleaved stereo.
    pub fn recorded(&self) -> &[f32] {
        &self.recorded
    }

    /// Let go of what `recorded` gave. Allocates nothing: the room stays.
    pub fn clear_recorded(&mut self) {
        self.recorded.clear();
    }

    /// Fill `out` (at least `DJ_REPORT_LEN` long) with where everything is,
    /// as `app/src/dj/dj-report.ts` reads it.
    pub fn report(&self, out: &mut [f64]) {
        if out.len() < DJ_REPORT_LEN {
            return;
        }
        let flag = |on: bool| if on { 1.0 } else { 0.0 };
        out[0] = f64::from(self.master_meters[0]);
        out[1] = f64::from(self.master_meters[1]);
        out[2] = self.sync_master.map_or(-1.0, |m| m as f64);
        out[3] = self.master_bpm();
        out[4] = self.recorded_frames as f64 / f64::from(self.sample_rate);
        out[5] = flag(self.recording);
        out[6] = f64::from(self.beat_fx.kind);
        out[7] = flag(self.beat_fx.on);
        for (index, deck) in self.decks.iter().enumerate() {
            let at = GLOBAL_FIELDS + index * DECK_FIELDS;
            let fields = &mut out[at..at + DECK_FIELDS];
            let (bpm, first_beat) = deck.grid();
            let (loop_start, loop_end) = deck.loop_seconds().unwrap_or((-1.0, -1.0));
            fields.copy_from_slice(&[
                flag(deck.is_loaded()),
                flag(deck.is_playing()),
                deck.seconds(),
                deck.duration(),
                bpm,
                deck.effective_bpm(),
                deck.rate(),
                flag(deck.loop_seconds().is_some()),
                loop_start,
                loop_end,
                deck.cue_seconds(),
                deck.slip_seconds().unwrap_or(-1.0),
                flag(deck.reverse),
                flag(deck.slip),
                flag(deck.master_tempo),
                deck.key_shift,
                flag(self.synced[index]),
                first_beat,
                f64::from(self.channel_meters[index]),
                deck.speed(),
                flag(deck.previewing()),
                flag(deck.quantize),
                f64::from(self.channels[index].gain_reduction_db()),
                deck.tempo,
            ]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::measure::{peak, sine};

    const RATE: f32 = 48_000.0;

    fn tone_track(bpm: f64, seconds: f32) -> DjTrack {
        let tone = sine(440.0, 0.5, RATE, (seconds * RATE) as usize);
        DjTrack {
            file: PreparedAudioFile::from_file(AudioFile::from_samples(tone.clone(), tone)),
            bpm,
            first_beat: 0.0,
        }
    }

    fn set(mixer: &mut DjMixer, kind: &str, index: usize, name: &str, value: f64) {
        mixer.apply(DjControl::parse(kind, index, name).unwrap(), value);
    }

    fn report(mixer: &DjMixer) -> Vec<f64> {
        let mut out = vec![0.0; DJ_REPORT_LEN];
        mixer.report(&mut out);
        out
    }

    fn deck_field(report: &[f64], deck: usize, field: usize) -> f64 {
        report[GLOBAL_FIELDS + deck * DECK_FIELDS + field]
    }

    #[test]
    fn controls_parse_by_name_and_refuse_what_there_isnt() {
        assert_eq!(
            DjControl::parse("deck", 1, "play"),
            Some(DjControl::Deck(1, DeckControl::Play))
        );
        assert_eq!(
            DjControl::parse("channel", 0, "eqHigh"),
            Some(DjControl::Channel(0, ChannelControl::Eq(3)))
        );
        assert_eq!(DjControl::parse("deck", 4, "play"), None);
        assert_eq!(DjControl::parse("mixer", 0, "volume"), None);
    }

    #[test]
    fn crossfader_curves() {
        assert_eq!(crossfade(-1.0, 0), (1.0, 0.0));
        assert_eq!(crossfade(0.0, 0), (1.0, 1.0));
        let (a, b) = crossfade(0.0, 1);
        assert!((a * a + b * b - 1.0).abs() < 1e-6, "constant power");
        assert_eq!(crossfade(0.8, 2), (1.0, 1.0));
        assert_eq!(crossfade(1.0, 2), (0.0, 1.0));
    }

    #[test]
    fn a_playing_deck_is_heard_through_its_side_of_the_crossfader() {
        let mut mixer = DjMixer::new(RATE);
        mixer.load(0, Some(tone_track(120.0, 2.0)));
        set(&mut mixer, "deck", 0, "play", 1.0);
        set(&mut mixer, "channel", 0, "assign", 0.0);
        mixer.render(4_800);
        assert!(peak(&mixer.output().0[..4_800]) > 0.45);
        set(&mut mixer, "mixer", 0, "crossfader", 1.0);
        mixer.render(4_800);
        assert_eq!(peak(&mixer.output().0[..4_800]), 0.0, "cut off on side B");
        set(&mut mixer, "mixer", 0, "crossfaderReverse", 1.0);
        mixer.render(4_800);
        assert!(peak(&mixer.output().0[..4_800]) > 0.45, "reversed");
    }

    #[test]
    fn the_channel_fader_and_master_scale_the_mix() {
        let mut mixer = DjMixer::new(RATE);
        mixer.load(0, Some(tone_track(120.0, 2.0)));
        set(&mut mixer, "deck", 0, "play", 1.0);
        set(&mut mixer, "channel", 0, "fader", 0.5);
        set(&mut mixer, "channel", 0, "curve", 1.0);
        set(&mut mixer, "mixer", 0, "master", 0.5);
        mixer.render(4_800);
        let level = peak(&mixer.output().0[..4_800]);
        assert!((level - 0.125).abs() < 0.01, "{level}");
        // The channel meter reads before the fader.
        assert!((deck_field(&report(&mixer), 0, 18) - 0.5).abs() < 0.02);
    }

    #[test]
    fn sync_matches_the_masters_tempo_and_lines_up_the_beats() {
        let mut mixer = DjMixer::new(RATE);
        mixer.load(0, Some(tone_track(128.0, 20.0)));
        mixer.load(1, Some(tone_track(120.0, 20.0)));
        set(&mut mixer, "deck", 0, "play", 1.0);
        set(&mut mixer, "deck", 0, "tempo", 0.02);
        mixer.render(4_800);
        set(&mut mixer, "deck", 1, "seek", 0.1);
        set(&mut mixer, "deck", 1, "play", 1.0);
        set(&mut mixer, "deck", 1, "sync", 1.0);
        for _ in 0..40 {
            mixer.render(1_200);
        }
        let out = report(&mixer);
        assert_eq!(out[2], 0.0, "Deck 1 leads");
        let leader = deck_field(&out, 0, 5);
        let follower = deck_field(&out, 1, 5);
        assert!((leader - 128.0 * 1.02).abs() < 1e-9);
        assert!((follower - leader).abs() < 1e-9, "{follower} vs {leader}");
        let phase = |deck: usize| mixer.decks[deck].beat_position().unwrap().fract();
        let error = (phase(0) - phase(1) + 1.5).rem_euclid(1.0) - 0.5;
        assert!(error.abs() < 0.01, "beats {error} apart");

        // Off again, it keeps the tempo it was synced to.
        set(&mut mixer, "deck", 1, "sync", 0.0);
        assert!((mixer.decks[1].effective_bpm() - leader).abs() < 1e-9);
    }

    #[test]
    fn cued_channels_reach_the_headphones_whatever_the_fader() {
        let mut mixer = DjMixer::new(RATE);
        mixer.load(0, Some(tone_track(120.0, 2.0)));
        set(&mut mixer, "deck", 0, "play", 1.0);
        set(&mut mixer, "channel", 0, "fader", 0.0);
        set(&mut mixer, "channel", 0, "cue", 1.0);
        set(&mut mixer, "mixer", 0, "headphoneLevel", 1.0);
        mixer.render(4_800);
        assert_eq!(peak(&mixer.output().0[..4_800]), 0.0);
        assert!(peak(&mixer.headphones().0[..4_800]) > 0.45);
    }

    #[test]
    fn recording_captures_the_mix() {
        let mut mixer = DjMixer::new(RATE);
        mixer.load(0, Some(tone_track(120.0, 2.0)));
        set(&mut mixer, "deck", 0, "play", 1.0);
        set(&mut mixer, "mixer", 0, "record", 1.0);
        mixer.render(480);
        assert_eq!(mixer.recorded().len(), 960);
        assert_eq!(
            mixer.recorded()[..2],
            [mixer.output().0[0], mixer.output().1[0]]
        );
        mixer.clear_recorded();
        assert!(mixer.recorded().is_empty());
        assert!((report(&mixer)[4] - 0.01).abs() < 1e-9);
    }

    #[test]
    fn the_beat_fx_follows_the_master_bpm_or_a_tapped_one() {
        let mut mixer = DjMixer::new(RATE);
        assert_eq!(mixer.master_bpm(), 120.0);
        mixer.load(0, Some(tone_track(126.0, 2.0)));
        set(&mut mixer, "deck", 0, "syncMaster", 1.0);
        assert_eq!(mixer.master_bpm(), 126.0);
        set(&mut mixer, "mixer", 0, "bpm", 100.0);
        assert_eq!(mixer.master_bpm(), 100.0);
    }

    #[test]
    fn a_track_decodes_and_analyses_for_a_deck() {
        let bytes = crate::audio_file::tests::TONE_WAV;
        let prepared = PreparedDjTrack::decode(bytes, RATE).unwrap();
        assert!((prepared.analysis.seconds - 0.25).abs() < 1e-3);
        assert_eq!(prepared.track.file.left().len(), 12_000);
    }

    #[test]
    fn the_engine_adds_the_mix_after_the_songs_master_is_metered() {
        let mut engine = crate::Engine::new(RATE);
        engine.prepare(1_024);
        assert!(engine.install_dj(Box::new(DjMixer::new(RATE))).is_none());
        assert!(
            engine
                .swap_dj_track(0, Some(tone_track(120.0, 2.0)))
                .is_none()
        );
        engine.dj_apply(DjControl::parse("deck", 0, "play").unwrap(), 1.0);
        engine.render(1_024);
        assert!(peak(&engine.left()[..1_024]) > 0.45, "heard");
        assert_eq!(engine.master_peak(), 0.0, "but not on the song's meter");
        let mut out = vec![0.0; DJ_REPORT_LEN];
        engine.dj_report_into(&mut out);
        assert_eq!(deck_field(&out, 0, 1), 1.0);
    }
}

//! One **Deck**: a file played at a speed of its own, as a CDJ plays it.
//!
//! The Deck reads its file at a fractional position that moves by its
//! speed each frame: forwards, backwards (Reverse, a spin-back) or by the
//! jog wheel's hand while it scratches. Played plainly, the pitch follows
//! the speed, as a record's does. With **Master Tempo** on, or a **Key
//! Shift**, the position still moves at the speed but the sound is read by
//! the `Stretcher` at a pitch of its own.
//!
//! A loop wraps the position between two points. **Slip** keeps a second
//! position moving at the speed the Deck would have had, and the Deck goes
//! back to it when the loop, scratch, reverse or held jump ends.
//!
//! A Deck is played in one of three control modes, as DVS software's
//! are. **INT**, its own: as above. **REL**, relative: the timecode
//! vinyl's decoded speed and direction move it, its own tempo fader set
//! aside, so a needle dropped elsewhere carries on from where the Deck is.
//! **ABS**, absolute: it goes where the vinyl's position is, a needle drop
//! jumping it there. Either way, a lifted needle stops it.
//!
//! Nothing here allocates: the file is decoded and analysed off the audio
//! thread and moved in whole.

use super::stretch::Stretcher;
use super::timecode::VinylFrame;
use crate::engine::PreparedAudioFile;

/// How fast the platter follows the hand while scratching: a time constant
/// in seconds, short enough to feel direct and long enough not to crackle.
const SCRATCH_SMOOTHING_SECONDS: f64 = 0.004;
/// How far a spin-back throws the record backwards at first, as a speed.
const SPINBACK_SPEED: f64 = -4.0;
/// In ABS, how far behind or ahead of the vinyl the Deck may be before it
/// jumps there rather than catching up, in seconds, and how quickly it
/// catches up, as a time constant.
const ABS_JUMP_SECONDS: f64 = 0.05;
const ABS_PULL_SECONDS: f64 = 0.005;

/// Who moves the Deck: itself, or the timecode vinyl.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DeckMode {
    /// The Deck plays the file itself (INT), ignoring any vinyl.
    #[default]
    Internal,
    /// The vinyl's speed and direction move it (REL).
    Relative,
    /// The vinyl's position places it, and its speed moves it (ABS).
    Absolute,
}

impl DeckMode {
    pub fn from_value(value: f64) -> Self {
        match value.round() as i64 {
            1 => Self::Relative,
            2 => Self::Absolute,
            _ => Self::Internal,
        }
    }

    pub fn value(self) -> f64 {
        match self {
            Self::Internal => 0.0,
            Self::Relative => 1.0,
            Self::Absolute => 2.0,
        }
    }
}

/// A file ready for a Deck: decoded at the engine's rate, with the **Beat
/// Grid** the analysis found for it.
#[derive(Clone, Debug)]
pub struct DjTrack {
    pub file: PreparedAudioFile,
    /// Beats per minute at the file's own speed; 0 when none was found.
    pub bpm: f64,
    /// Seconds into the file of the first beat.
    pub first_beat: f64,
}

/// What stops or starts a Deck the way a turntable does.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Motor {
    /// The Deck plays at its speed, or is still.
    Steady,
    /// Slowing from `from` to a stop over `frames`, `done` of them so far.
    Brake { from: f64, frames: f64, done: f64 },
    /// Thrown backwards, then slowing to a stop over `frames`.
    Spinback { frames: f64, done: f64 },
}

#[derive(Debug)]
pub struct Deck {
    sample_rate: f64,
    track: Option<DjTrack>,
    /// Where it reads, in frames of the file.
    position: f64,
    playing: bool,
    /// The tempo fader: 0.05 plays 5% faster.
    pub tempo: f64,
    /// A nudge on top of the tempo while the jog's edge is turned or a bend
    /// button held: 0.04 is 4% faster.
    pub bend: f64,
    /// The speed **Sync** gives it, in place of `1 + tempo`, while synced.
    pub sync_rate: Option<f64>,
    /// A small correction Sync makes to hold the beats together.
    pub phase_trim: f64,
    pub reverse: bool,
    pub slip: bool,
    pub master_tempo: bool,
    /// **Key Shift**, in semitones.
    pub key_shift: f64,
    pub quantize: bool,
    /// The cue point, in frames.
    cue: f64,
    /// Playing only while Cue is held, from the cue point.
    previewing: bool,
    loop_range: Option<(f64, f64)>,
    /// The loop last exited, for Reloop.
    last_loop: Option<(f64, f64)>,
    /// Where the Deck would be without the loop, scratch or reverse, while
    /// Slip is on.
    slip_position: f64,
    /// A jump held down, which Slip returns from on release.
    holding_jump: bool,
    /// The platter's speed while the hand is on it, and where the hand is
    /// taking it.
    scratch: Option<(f64, f64)>,
    motor: Motor,
    /// The speed the last frame played at, signed.
    speed: f64,
    stretcher: Stretcher,
    /// The loudest sample of the last block, for the channel's BPM counter
    /// and the platter's animation to know it is sounding.
    pub peak: f32,
    /// A Beat Grid the DJ set by hand, over the analysis's.
    grid: Option<(f64, f64)>,
    /// **Silent Cue**: the Deck plays on, muted, until it is turned off or
    /// a Hot Cue is called.
    pub silent: bool,
    /// A Slip Reverse held: whether Slip was on before it, and how many
    /// frames of the file it has left to play backwards.
    slip_reverse: Option<(bool, f64)>,
    /// INT, REL or ABS. In REL and ABS, `playing` is whether the Deck
    /// follows the vinyl: pausing it holds it still while the record turns.
    mode: DeckMode,
    /// The speed the vinyl gave the last frame, unsigned, for Slip and the
    /// BPM counter.
    vinyl_rate: f64,
}

impl Deck {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate: f64::from(sample_rate),
            track: None,
            position: 0.0,
            playing: false,
            tempo: 0.0,
            bend: 0.0,
            sync_rate: None,
            phase_trim: 0.0,
            reverse: false,
            slip: false,
            master_tempo: false,
            key_shift: 0.0,
            quantize: true,
            cue: 0.0,
            previewing: false,
            loop_range: None,
            last_loop: None,
            slip_position: 0.0,
            holding_jump: false,
            scratch: None,
            motor: Motor::Steady,
            speed: 0.0,
            stretcher: Stretcher::new(sample_rate),
            peak: 0.0,
            grid: None,
            silent: false,
            slip_reverse: None,
            mode: DeckMode::Internal,
            vinyl_rate: 0.0,
        }
    }

    pub fn mode(&self) -> DeckMode {
        self.mode
    }

    /// Switch between INT, REL and ABS. To the vinyl, the Deck follows it
    /// from where it is; back to INT, it plays on by itself if the record
    /// was turning forwards, as DVS software does.
    pub fn set_mode(&mut self, mode: DeckMode) {
        if mode == self.mode {
            return;
        }
        let was = self.mode;
        self.mode = mode;
        self.motor = Motor::Steady;
        self.previewing = false;
        self.stretcher.reset();
        if mode == DeckMode::Internal {
            self.playing = self.is_loaded() && self.playing && self.speed > 0.0;
            self.vinyl_rate = 0.0;
        } else if was == DeckMode::Internal {
            self.scratch = None;
            self.playing = self.is_loaded();
        }
    }

    /// Needle Search, a Hot Cue, a loop or a Beat Jump can't move the
    /// needle, so in ABS they turn the Deck to REL, as rekordbox does.
    fn leave_absolute(&mut self) {
        if self.mode == DeckMode::Absolute {
            self.mode = DeckMode::Relative;
        }
    }

    /// Put `track` on the Deck, paused at its start with the cue there,
    /// handing back the one it replaces to be dropped off the audio thread.
    pub fn load(&mut self, track: Option<DjTrack>) -> Option<DjTrack> {
        self.position = 0.0;
        self.slip_position = 0.0;
        self.cue = 0.0;
        self.playing = false;
        self.previewing = false;
        self.loop_range = None;
        self.last_loop = None;
        self.scratch = None;
        self.motor = Motor::Steady;
        self.grid = None;
        self.slip_reverse = None;
        self.stretcher.reset();
        // On the vinyl, a Deck follows the record as soon as there is a file.
        self.playing = self.mode != DeckMode::Internal && track.is_some();
        std::mem::replace(&mut self.track, track)
    }

    pub fn is_loaded(&self) -> bool {
        self.track.is_some()
    }

    /// Playing: by itself in INT; on the vinyl, following a record that is
    /// turning, so a Deck whose needle is lifted can be loaded or ejected.
    pub fn is_playing(&self) -> bool {
        self.playing && (self.mode == DeckMode::Internal || self.vinyl_rate > 0.0)
    }

    fn frames(&self) -> f64 {
        self.track
            .as_ref()
            .map_or(0.0, |t| t.file.left().len() as f64)
    }

    pub fn duration(&self) -> f64 {
        self.frames() / self.sample_rate
    }

    pub fn seconds(&self) -> f64 {
        self.position / self.sample_rate
    }

    pub fn cue_seconds(&self) -> f64 {
        self.cue / self.sample_rate
    }

    pub fn slip_seconds(&self) -> Option<f64> {
        self.slipping()
            .then(|| self.slip_position / self.sample_rate)
    }

    pub fn loop_seconds(&self) -> Option<(f64, f64)> {
        self.loop_range
            .map(|(start, end)| (start / self.sample_rate, end / self.sample_rate))
    }

    pub fn previewing(&self) -> bool {
        self.previewing
    }

    pub fn speed(&self) -> f64 {
        self.speed
    }

    /// The Beat Grid: beats per minute at the file's speed, and the first
    /// beat in seconds. A hand-set one wins over the analysis's.
    pub fn grid(&self) -> (f64, f64) {
        self.grid
            .or_else(|| self.track.as_ref().map(|t| (t.bpm, t.first_beat)))
            .unwrap_or((0.0, 0.0))
    }

    pub fn set_grid(&mut self, bpm: f64, first_beat: f64) {
        if bpm.is_finite() && bpm > 0.0 && first_beat.is_finite() {
            self.grid = Some((bpm, first_beat));
        }
    }

    /// The speed the tempo fader, Sync and the bend give, before Reverse;
    /// on the vinyl, the speed it gave last.
    pub fn rate(&self) -> f64 {
        if self.mode != DeckMode::Internal {
            return self.vinyl_rate;
        }
        (self.sync_rate.unwrap_or(1.0 + self.tempo) * (1.0 + self.bend) * (1.0 + self.phase_trim))
            .max(0.0)
    }

    /// Beats per minute as it plays now; 0 with no Beat Grid.
    pub fn effective_bpm(&self) -> f64 {
        if self.mode != DeckMode::Internal {
            return self.grid().0 * self.vinyl_rate;
        }
        self.grid().0 * self.sync_rate.unwrap_or(1.0 + self.tempo)
    }

    /// Frames of the file in one beat, or None without a Beat Grid.
    fn beat_frames(&self) -> Option<f64> {
        let (bpm, _) = self.grid();
        (bpm > 0.0).then(|| 60.0 / bpm * self.sample_rate)
    }

    /// Where the Deck is in its beats: 2.25 is a quarter past its third
    /// beat. None without a Beat Grid.
    pub fn beat_position(&self) -> Option<f64> {
        let beat = self.beat_frames()?;
        let first = self.grid().1 * self.sample_rate;
        Some((self.position - first) / beat)
    }

    /// `frames` moved onto the nearest beat, when Quantize is on.
    fn quantized(&self, frames: f64) -> f64 {
        match (self.quantize, self.beat_frames()) {
            (true, Some(beat)) => {
                let first = self.grid().1 * self.sample_rate;
                first + ((frames - first) / beat).round() * beat
            }
            _ => frames,
        }
    }

    fn clamp(&self, frames: f64) -> f64 {
        frames.clamp(0.0, self.frames().max(0.0))
    }

    fn slipping(&self) -> bool {
        self.slip
            && (self.loop_range.is_some()
                || self.scratch.is_some()
                || self.reverse
                || self.holding_jump)
    }

    /// Leave a loop, scratch, reverse or held jump: with Slip on, the Deck
    /// goes to where it would have been.
    fn end_slip(&mut self, was_slipping: bool) {
        if was_slipping && !self.slipping() {
            self.position = self.slip_position;
            self.stretcher.reset();
        }
    }

    pub fn play(&mut self, on: bool) {
        if !self.is_loaded() {
            return;
        }
        self.previewing = false;
        self.motor = Motor::Steady;
        self.playing = on;
    }

    /// Cue pressed, as on a CDJ: playing, back to the cue point and pause;
    /// paused on the cue point, play from it while it is held; paused
    /// anywhere else, the cue point moves there.
    /// On the vinyl, Cue goes back to the cue point and plays on from it
    /// as the record turns, or, paused, sets it where the Deck is.
    pub fn cue_down(&mut self) {
        if !self.is_loaded() {
            return;
        }
        if self.mode != DeckMode::Internal {
            self.leave_absolute();
            if self.playing {
                self.seek_frames(self.cue);
            } else {
                self.cue = self.clamp(self.quantized(self.position));
            }
            return;
        }
        self.motor = Motor::Steady;
        if self.playing && !self.previewing {
            self.playing = false;
            self.seek_frames(self.cue);
        } else if (self.position - self.cue).abs() < 1.0 {
            self.previewing = true;
            self.playing = true;
        } else {
            self.cue = self.clamp(self.quantized(self.position));
            self.seek_frames(self.cue);
        }
    }

    /// Cue let go: a preview goes back to the cue point.
    pub fn cue_up(&mut self) {
        if self.previewing {
            self.previewing = false;
            self.playing = false;
            self.seek_frames(self.cue);
        }
    }

    pub fn set_cue(&mut self, seconds: f64) {
        self.cue = self.clamp(self.quantized(seconds * self.sample_rate));
    }

    fn seek_frames(&mut self, frames: f64) {
        self.position = self.clamp(frames);
        self.slip_position = self.position;
        self.stretcher.reset();
    }

    /// Needle Search, or a Hot Cue: straight to `seconds`.
    pub fn seek(&mut self, seconds: f64) {
        if seconds.is_finite() {
            self.leave_absolute();
            self.seek_frames(seconds * self.sample_rate);
        }
    }

    /// A Hot Cue held: jump there, and with Slip on, come back on release.
    /// Calling a Hot Cue ends a Silent Cue, so the Deck is heard from it.
    pub fn jump_hold(&mut self, seconds: f64) {
        if !seconds.is_finite() {
            return;
        }
        self.silent = false;
        self.leave_absolute();
        let slip_from = self.position;
        self.holding_jump = true;
        self.position = self.clamp(seconds * self.sample_rate);
        if !self.slip {
            self.slip_position = self.position;
        } else if self.slip_position == 0.0 {
            self.slip_position = slip_from;
        }
        self.stretcher.reset();
    }

    pub fn jump_release(&mut self) {
        let was = self.slipping();
        self.holding_jump = false;
        self.end_slip(was);
    }

    /// **Beat Jump**: `beats` either way, moving any loop with it.
    pub fn beat_jump(&mut self, beats: f64) {
        let Some(beat) = self.beat_frames() else {
            return;
        };
        self.leave_absolute();
        let by = beats * beat;
        if let Some((start, end)) = self.loop_range {
            self.loop_range = Some((start + by, end + by));
        }
        self.position = self.clamp(self.position + by);
        if !self.slipping() {
            self.slip_position = self.position;
        }
        self.stretcher.reset();
    }

    /// Loop in: the loop will start here (snapped, with Quantize).
    pub fn loop_in(&mut self, seconds: f64) {
        let start = self.clamp(self.quantized(seconds * self.sample_rate));
        let end = self.loop_range.map_or(start, |(_, end)| end);
        self.set_loop(start, end);
    }

    /// Loop out: the loop ends here, and plays from its start.
    pub fn loop_out(&mut self, seconds: f64) {
        let end = self.clamp(self.quantized(seconds * self.sample_rate));
        let start = self
            .loop_range
            .map_or(self.cue.min(end), |(start, _)| start);
        self.set_loop(start, end);
    }

    /// A loop of `beats` beats from the playhead (snapped with Quantize).
    pub fn auto_loop(&mut self, beats: f64) {
        let Some(beat) = self.beat_frames() else {
            return;
        };
        let start = self.quantized(self.position);
        let start = if start > self.position + 1.0 && self.quantize {
            start - beat
        } else {
            start
        };
        self.set_loop(start, start + beats * beat);
    }

    fn set_loop(&mut self, start: f64, end: f64) {
        if !(start.is_finite() && end.is_finite()) || end - start < 1.0 {
            return;
        }
        self.leave_absolute();
        let was = self.slipping();
        if !was {
            self.slip_position = self.position;
        }
        self.loop_range = Some((start.max(0.0), end.min(self.frames())));
    }

    /// Halve (0.5) or double (2) the loop, keeping its start.
    pub fn resize_loop(&mut self, factor: f64) {
        if let Some((start, end)) = self.loop_range {
            self.set_loop(start, start + (end - start) * factor);
        }
    }

    pub fn exit_loop(&mut self) {
        let was = self.slipping();
        if self.loop_range.is_some() {
            self.last_loop = self.loop_range.take();
        }
        self.end_slip(was);
    }

    /// Reloop: the last loop again, from its start.
    pub fn reloop(&mut self) {
        if let Some((start, end)) = self.last_loop.or(self.loop_range) {
            self.set_loop(start, end);
            self.position = start;
            self.stretcher.reset();
        }
    }

    /// Move the playhead by `beats` without touching a loop: Sync lining
    /// up the beats.
    pub fn shift_beats(&mut self, beats: f64) {
        if let Some(beat) = self.beat_frames() {
            self.position = self.clamp(self.position + beats * beat);
            self.slip_position += beats * beat;
            self.stretcher.reset();
        }
    }

    pub fn set_reverse(&mut self, on: bool) {
        let was = self.slipping();
        if !was && on {
            self.slip_position = self.position;
        }
        self.reverse = on;
        self.end_slip(was);
    }

    /// **Slip Reverse**, held: the Deck plays backwards with Slip on, so the
    /// track runs on underneath, and let go (or after 8 beats backwards,
    /// whichever is first) it goes back to where the track would have been,
    /// with Slip as it was.
    pub fn slip_reverse(&mut self, on: bool) {
        match (on, self.slip_reverse) {
            (true, None) => {
                let beat = self.beat_frames().unwrap_or(0.5 * self.sample_rate);
                let had_slip = self.slip;
                self.set_slip(true);
                self.set_reverse(true);
                self.slip_reverse = Some((had_slip, 8.0 * beat));
            }
            (false, Some((had_slip, _))) => {
                self.slip_reverse = None;
                self.set_reverse(false);
                self.set_slip(had_slip);
            }
            _ => {}
        }
    }

    pub fn slip_reversing(&self) -> bool {
        self.slip_reverse.is_some()
    }

    pub fn set_slip(&mut self, on: bool) {
        let was = self.slipping();
        if on && !was {
            self.slip_position = self.position;
        }
        self.slip = on;
        self.end_slip(was);
    }

    /// The hand on (true) or off the platter, in vinyl mode.
    pub fn touch(&mut self, on: bool) {
        let was = self.slipping();
        if on {
            if !was {
                self.slip_position = self.position;
            }
            self.scratch = Some((self.speed, 0.0));
        } else {
            self.scratch = None;
            self.end_slip(was);
        }
        self.stretcher.reset();
    }

    /// Where the hand is moving the platter, as a speed: 1 is the record's
    /// own, negative is backwards.
    pub fn scratch_to(&mut self, speed: f64) {
        if let Some((now, _)) = self.scratch
            && speed.is_finite()
        {
            self.scratch = Some((now, speed.clamp(-16.0, 16.0)));
        }
    }

    /// Stop as a turntable does when its motor is switched off, over
    /// `seconds`.
    pub fn brake(&mut self, seconds: f64) {
        if self.playing && self.mode == DeckMode::Internal {
            self.motor = Motor::Brake {
                from: self.speed.abs().max(self.rate()),
                frames: (seconds.max(0.01)) * self.sample_rate,
                done: 0.0,
            };
        }
    }

    /// Throw the record back and let it stop, over `seconds`.
    pub fn spinback(&mut self, seconds: f64) {
        if self.playing && self.mode == DeckMode::Internal {
            self.motor = Motor::Spinback {
                frames: (seconds.max(0.05)) * self.sample_rate,
                done: 0.0,
            };
        }
    }

    /// The speed of the next frame, signed, and whether the pitch follows
    /// it (a scratch, a brake) whatever Master Tempo says.
    fn next_speed(&mut self, vinyl: Option<&VinylFrame>) -> (f64, bool) {
        if self.mode != DeckMode::Internal {
            return self.vinyl_speed(vinyl.copied().unwrap_or_default());
        }
        if let Some((now, target)) = self.scratch {
            let smoothing = 1.0 - (-1.0 / (SCRATCH_SMOOTHING_SECONDS * self.sample_rate)).exp();
            let next = now + (target - now) * smoothing;
            self.scratch = Some((next, target));
            return (next, true);
        }
        match self.motor {
            Motor::Brake { from, frames, done } => {
                let left = 1.0 - done / frames;
                if left <= 0.0 {
                    self.motor = Motor::Steady;
                    self.playing = false;
                    return (0.0, true);
                }
                self.motor = Motor::Brake {
                    from,
                    frames,
                    done: done + 1.0,
                };
                (from * left * if self.reverse { -1.0 } else { 1.0 }, true)
            }
            Motor::Spinback { frames, done } => {
                let left = 1.0 - done / frames;
                if left <= 0.0 {
                    self.motor = Motor::Steady;
                    self.playing = false;
                    return (0.0, true);
                }
                self.motor = Motor::Spinback {
                    frames,
                    done: done + 1.0,
                };
                (SPINBACK_SPEED * left * left, true)
            }
            Motor::Steady if self.playing => {
                let rate = self.rate();
                (if self.reverse { -rate } else { rate }, false)
            }
            Motor::Steady => (0.0, false),
        }
    }

    /// The speed of the next frame on the vinyl: its own, times the tempo
    /// Sync gives in REL (the record's speed at 33⅓ plays the Master's
    /// tempo), in its direction, and none while it is lifted, paused or
    /// off the record's range. In ABS the Deck also closes on where the
    /// record is, or jumps there when it is far off. The pitch follows it
    /// unless Master Tempo holds it, which it can only near the record's
    /// own speed.
    fn vinyl_speed(&mut self, vinyl: VinylFrame) -> (f64, bool) {
        if !self.playing || !vinyl.present || !vinyl.speed.is_finite() {
            self.vinyl_rate = 0.0;
            return (0.0, true);
        }
        let mut speed = vinyl.speed;
        if self.mode == DeckMode::Absolute {
            if vinyl.off_range {
                self.vinyl_rate = 0.0;
                return (0.0, true);
            }
            if vinyl.position.is_finite() {
                let target = vinyl.position * self.sample_rate;
                let error = target - self.position;
                if error.abs() > ABS_JUMP_SECONDS * self.sample_rate {
                    self.position = self.clamp(target);
                    self.slip_position = self.position;
                    self.stretcher.reset();
                } else {
                    speed += error / (ABS_PULL_SECONDS * self.sample_rate);
                }
            }
        } else {
            speed *= self.sync_rate.unwrap_or(1.0);
        }
        if self.reverse {
            speed = -speed;
        }
        self.vinyl_rate = speed.abs();
        let keeps_key = self.master_tempo && (0.5..=1.6).contains(&speed.abs());
        (speed, !keeps_key)
    }

    /// The pitch the sound is read at, for a Deck moving at `speed`: the
    /// speed itself, unless Master Tempo holds it at the file's own, and
    /// moved by the Key Shift.
    fn pitch(&self, speed: f64, follows: bool) -> f64 {
        let shift = 2f64.powf(self.key_shift / 12.0);
        if follows || !self.master_tempo {
            speed.abs() * shift
        } else {
            shift
        }
    }

    /// Add the next `left.len()` frames of the Deck to `left` and `right`.
    /// Allocates nothing.
    #[cfg(test)]
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.render_vinyl(left, right, &[]);
    }

    /// `render`, with the vinyl's reading for each frame, which moves the
    /// Deck in REL and ABS. A frame past the end of `vinyl` has no signal.
    pub fn render_vinyl(&mut self, left: &mut [f32], right: &mut [f32], vinyl: &[VinylFrame]) {
        let mut peak = 0.0f32;
        let Some(track) = self.track.clone() else {
            self.peak = 0.0;
            left.fill(0.0);
            right.fill(0.0);
            return;
        };
        let (source_l, source_r) = (track.file.left(), track.file.right());
        let frames = source_l.len() as f64;
        let internal = self.mode == DeckMode::Internal;
        let rate = self.rate();
        for (frame, (l, r)) in left.iter_mut().zip(right.iter_mut()).enumerate() {
            let (speed, follows) = self.next_speed(vinyl.get(frame));
            self.speed = speed;
            let rate = if internal { rate } else { self.vinyl_rate };
            // Still on the vinyl is silent, as a record is.
            if speed == 0.0 && (!internal || (!self.playing && self.scratch.is_none())) {
                *l = 0.0;
                *r = 0.0;
                continue;
            }
            let pitch = self.pitch(speed, follows);
            let stretched = !follows && (pitch - speed.abs()).abs() > 1e-6;
            let (sl, sr) = if stretched {
                self.stretcher
                    .next(source_l, source_r, self.position, speed.signum(), pitch)
            } else {
                (read(source_l, self.position), read(source_r, self.position))
            };
            // Silent Cue plays on, unheard.
            let (sl, sr) = if self.silent { (0.0, 0.0) } else { (sl, sr) };
            *l = sl;
            *r = sr;
            peak = peak.max(sl.abs()).max(sr.abs());

            self.position += speed;
            if let Some((had_slip, left)) = self.slip_reverse {
                let left = left - speed.abs();
                if left <= 0.0 {
                    self.slip_reverse = Some((had_slip, 0.0));
                    self.slip_reverse(false);
                    continue;
                }
                self.slip_reverse = Some((had_slip, left));
            }
            if self.slip {
                self.slip_position += if self.playing { rate } else { 0.0 };
            }
            if let Some((start, end)) = self.loop_range {
                let length = end - start;
                if speed > 0.0 && self.position >= end {
                    self.position -= length;
                } else if speed < 0.0 && self.position < start {
                    self.position += length;
                }
            }
            if !self.slipping() {
                self.slip_position = self.position;
            }
            if self.position >= frames {
                self.position = frames;
                // On the vinyl the Deck keeps following: the record can
                // bring it back.
                if self.scratch.is_none() && internal {
                    self.playing = false;
                    self.previewing = false;
                }
            } else if self.position < 0.0 {
                self.position = 0.0;
            }
        }
        self.peak = peak;
    }
}

/// `data` at a fractional `position`, by cubic (Catmull-Rom) interpolation;
/// silence outside it.
pub fn read(data: &[f32], position: f64) -> f32 {
    if position.is_nan() || position < 0.0 || position >= data.len() as f64 {
        return 0.0;
    }
    let index = position.floor() as isize;
    let t = (position - position.floor()) as f32;
    let at = |i: isize| -> f32 {
        if i < 0 || i as usize >= data.len() {
            0.0
        } else {
            data[i as usize]
        }
    };
    let (y0, y1, y2, y3) = (at(index - 1), at(index), at(index + 1), at(index + 2));
    let a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    let b = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c = -0.5 * y0 + 0.5 * y2;
    ((a * t + b) * t + c) * t + y1
}

#[cfg(test)]
mod tests {
    use super::*;

    pub const RATE: f32 = 48_000.0;

    /// A Deck with `seconds` of a ramp on it: each frame's value is its
    /// index, so where the Deck read is plain from what it played.
    pub fn ramp_deck(seconds: f64, bpm: f64) -> Deck {
        let frames = (seconds * f64::from(RATE)) as usize;
        let samples: Vec<f32> = (0..frames).map(|i| i as f32).collect();
        let file = PreparedAudioFile::from_file(crate::audio_file::AudioFile::from_samples(
            samples.clone(),
            samples,
        ));
        let mut deck = Deck::new(RATE);
        deck.load(Some(DjTrack {
            file,
            bpm,
            first_beat: 0.0,
        }));
        deck
    }

    fn render(deck: &mut Deck, frames: usize) -> Vec<f32> {
        let (mut left, mut right) = (vec![0.0; frames], vec![0.0; frames]);
        deck.render(&mut left, &mut right);
        left
    }

    #[test]
    fn cubic_reading_passes_through_the_samples_and_between_them() {
        let data = [0.0, 1.0, 2.0, 3.0, 4.0];
        assert_eq!(read(&data, 2.0), 2.0);
        assert!((read(&data, 2.5) - 2.5).abs() < 1e-6);
        assert_eq!(read(&data, -1.0), 0.0);
        assert_eq!(read(&data, 9.0), 0.0);
    }

    #[test]
    fn a_paused_deck_is_silent_and_a_playing_one_moves_at_its_speed() {
        let mut deck = ramp_deck(1.0, 120.0);
        assert!(render(&mut deck, 64).iter().all(|&s| s == 0.0));
        deck.play(true);
        render(&mut deck, 480);
        assert_eq!(deck.seconds(), 0.01);
        deck.tempo = 0.5;
        render(&mut deck, 480);
        assert!((deck.seconds() - 0.025).abs() < 1e-9, "{}", deck.seconds());
    }

    #[test]
    fn reverse_plays_backwards() {
        let mut deck = ramp_deck(1.0, 120.0);
        deck.seek(0.5);
        deck.play(true);
        deck.set_reverse(true);
        let played = render(&mut deck, 100);
        assert!(played.windows(2).all(|w| w[1] < w[0]));
        assert!(deck.seconds() < 0.5);
    }

    #[test]
    fn the_cue_works_as_on_a_cdj() {
        let mut deck = ramp_deck(2.0, 120.0);
        deck.quantize = false;
        deck.seek(0.5);
        deck.cue_down();
        assert_eq!(deck.cue_seconds(), 0.5, "paused away from it, Cue sets it");
        deck.cue_down();
        assert!(
            deck.is_playing() && deck.previewing(),
            "on it, Cue plays while held"
        );
        render(&mut deck, 4_800);
        deck.cue_up();
        assert!(!deck.is_playing());
        assert_eq!(deck.seconds(), 0.5, "and let go, it goes back");
        deck.play(true);
        render(&mut deck, 4_800);
        deck.cue_down();
        assert!(!deck.is_playing());
        assert_eq!(deck.seconds(), 0.5, "playing, Cue goes back and pauses");
    }

    #[test]
    fn quantize_snaps_the_cue_and_loops_to_the_beat() {
        // 120 BPM: a beat is half a second.
        let mut deck = ramp_deck(4.0, 120.0);
        deck.seek(1.1);
        deck.cue_down();
        assert_eq!(deck.cue_seconds(), 1.0);
        deck.seek(1.3);
        deck.auto_loop(2.0);
        assert_eq!(deck.loop_seconds(), Some((1.0, 2.0)));
    }

    #[test]
    fn a_loop_wraps_the_playhead_and_halves_and_doubles() {
        let mut deck = ramp_deck(4.0, 120.0);
        deck.play(true);
        deck.auto_loop(1.0);
        render(&mut deck, 48_000);
        let (start, end) = deck.loop_seconds().unwrap();
        assert!(deck.seconds() >= start && deck.seconds() < end);
        deck.resize_loop(0.5);
        assert_eq!(deck.loop_seconds(), Some((0.0, 0.25)));
        deck.resize_loop(4.0);
        assert_eq!(deck.loop_seconds(), Some((0.0, 1.0)));
        deck.exit_loop();
        assert_eq!(deck.loop_seconds(), None);
    }

    #[test]
    fn slip_returns_to_where_the_track_would_have_been() {
        let mut deck = ramp_deck(4.0, 120.0);
        deck.set_slip(true);
        deck.play(true);
        deck.auto_loop(0.5);
        render(&mut deck, 48_000);
        assert!(deck.seconds() < 0.25);
        assert!((deck.slip_seconds().unwrap() - 1.0).abs() < 1e-6);
        deck.exit_loop();
        assert!((deck.seconds() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn beat_jump_moves_by_whole_beats() {
        let mut deck = ramp_deck(8.0, 120.0);
        deck.seek(1.0);
        deck.beat_jump(4.0);
        assert_eq!(deck.seconds(), 3.0);
        deck.beat_jump(-1.0);
        assert_eq!(deck.seconds(), 2.5);
    }

    #[test]
    fn a_brake_slows_the_deck_to_a_stop() {
        let mut deck = ramp_deck(4.0, 120.0);
        deck.play(true);
        render(&mut deck, 480);
        deck.brake(0.1);
        render(&mut deck, 2_400);
        assert!(deck.speed() < 0.6 && deck.speed() > 0.4, "{}", deck.speed());
        render(&mut deck, 4_800);
        assert!(!deck.is_playing());
    }

    #[test]
    fn a_spinback_throws_the_record_backwards() {
        let mut deck = ramp_deck(4.0, 120.0);
        deck.seek(2.0);
        deck.play(true);
        deck.spinback(0.5);
        render(&mut deck, 4_800);
        assert!(deck.seconds() < 2.0);
        render(&mut deck, 48_000);
        assert!(!deck.is_playing());
    }

    #[test]
    fn scratching_follows_the_hand() {
        let mut deck = ramp_deck(4.0, 120.0);
        deck.seek(1.0);
        deck.touch(true);
        deck.scratch_to(-1.0);
        render(&mut deck, 4_800);
        assert!(deck.seconds() < 1.0);
        assert!((deck.speed() + 1.0).abs() < 1e-3);
        deck.touch(false);
        assert!(
            deck.speed() < -0.99,
            "the last speed stays until the next frame"
        );
    }

    #[test]
    fn silent_cue_plays_on_unheard_until_a_hot_cue_is_called() {
        let mut deck = ramp_deck(4.0, 120.0);
        deck.seek(1.0);
        deck.play(true);
        deck.silent = true;
        let played = render(&mut deck, 4_800);
        assert!(played.iter().all(|&s| s == 0.0), "muted");
        assert!((deck.seconds() - 1.1).abs() < 1e-9, "but moving");
        deck.jump_hold(2.0);
        deck.jump_release();
        assert!(!deck.silent, "a Hot Cue ends it");
        let played = render(&mut deck, 480);
        assert!(
            played[10] >= 96_000.0,
            "heard from the Hot Cue: {}",
            played[10]
        );
    }

    #[test]
    fn slip_reverse_plays_backwards_and_returns_where_the_track_would_be() {
        // 120 BPM: a beat is half a second.
        let mut deck = ramp_deck(20.0, 120.0);
        deck.seek(5.0);
        deck.play(true);
        deck.slip_reverse(true);
        assert!(deck.slip && deck.reverse && deck.slip_reversing());
        let played = render(&mut deck, 4_800);
        assert!(played.windows(2).all(|w| w[1] < w[0]), "backwards");
        deck.slip_reverse(false);
        assert!(!deck.slip, "Slip goes back to off");
        assert!(!deck.reverse);
        assert!((deck.seconds() - 5.1).abs() < 1e-6, "{}", deck.seconds());
    }

    #[test]
    fn slip_reverse_ends_by_itself_after_eight_beats() {
        let mut deck = ramp_deck(20.0, 120.0);
        deck.seek(10.0);
        deck.set_slip(true);
        deck.play(true);
        deck.slip_reverse(true);
        // Eight beats is four seconds; hold it for five.
        render(&mut deck, 5 * 48_000);
        assert!(!deck.slip_reversing() && !deck.reverse);
        assert!(deck.slip, "Slip stays on, as it was");
        assert!((deck.seconds() - 15.0).abs() < 1e-3, "{}", deck.seconds());
    }

    #[test]
    fn a_hand_set_grid_wins_and_gives_the_beat_position() {
        let mut deck = ramp_deck(4.0, 120.0);
        deck.set_grid(60.0, 0.5);
        deck.seek(2.5);
        assert_eq!(deck.beat_position(), Some(2.0));
        assert_eq!(deck.effective_bpm(), 60.0);
        deck.tempo = 0.1;
        assert!((deck.effective_bpm() - 66.0).abs() < 1e-9);
    }

    fn vinyl(speed: f64, frames: usize) -> Vec<VinylFrame> {
        let frame = VinylFrame {
            present: true,
            speed,
            position: f64::NAN,
            off_range: false,
        };
        vec![frame; frames]
    }

    /// The record at `seconds`, turning at its own speed, for `frames`.
    fn record_at(seconds: f64, frames: usize) -> Vec<VinylFrame> {
        (0..frames)
            .map(|i| VinylFrame {
                present: true,
                speed: 1.0,
                position: seconds + i as f64 / f64::from(RATE),
                off_range: false,
            })
            .collect()
    }

    fn render_on(deck: &mut Deck, vinyl: &[VinylFrame]) -> Vec<f32> {
        let (mut left, mut right) = (vec![0.0; vinyl.len()], vec![0.0; vinyl.len()]);
        deck.render_vinyl(&mut left, &mut right, vinyl);
        left
    }

    #[test]
    fn in_rel_the_vinyl_moves_the_deck_and_its_tempo_fader_is_set_aside() {
        let mut deck = ramp_deck(4.0, 120.0);
        deck.seek(1.0);
        deck.tempo = 0.5;
        deck.set_mode(DeckMode::Relative);
        assert!(!deck.is_playing(), "still until the record turns");
        render_on(&mut deck, &vinyl(0.5, 4_800));
        assert!(deck.is_playing(), "then it follows the record");
        assert!((deck.seconds() - 1.05).abs() < 1e-9, "{}", deck.seconds());
        assert!((deck.rate() - 0.5).abs() < 1e-9);
        assert!((deck.effective_bpm() - 60.0).abs() < 1e-9);
        let played = render_on(&mut deck, &vinyl(-1.0, 4_800));
        assert!(played.windows(2).all(|w| w[1] < w[0]), "backwards");
        assert!((deck.seconds() - 0.95).abs() < 1e-9);

        let lifted = render_on(&mut deck, &[VinylFrame::default(); 480]);
        assert!(
            lifted.iter().all(|&s| s == 0.0),
            "a lifted needle is silence"
        );
        assert!((deck.seconds() - 0.95).abs() < 1e-9, "and the Deck stops");
        assert!(!deck.is_playing(), "so a new file can be loaded");

        // Sync's tempo still applies: the record at 33 1/3 plays the Master's.
        deck.sync_rate = Some(1.2);
        render_on(&mut deck, &vinyl(1.0, 4_800));
        assert!((deck.seconds() - 1.07).abs() < 1e-9, "{}", deck.seconds());

        // Paused, it holds still while the record turns; played, it follows.
        deck.play(false);
        render_on(&mut deck, &vinyl(1.0, 4_800));
        assert!((deck.seconds() - 1.07).abs() < 1e-9);
        deck.play(true);
        render_on(&mut deck, &vinyl(1.0, 480));
        assert!(deck.seconds() > 1.07);
    }

    #[test]
    fn in_rel_cue_and_hot_cues_jump_and_it_plays_on_from_there() {
        let mut deck = ramp_deck(4.0, 120.0);
        deck.quantize = false;
        deck.set_cue(0.5);
        deck.set_mode(DeckMode::Relative);
        deck.seek(2.0);
        render_on(&mut deck, &vinyl(1.0, 480));
        deck.cue_down();
        assert_eq!(deck.seconds(), 0.5, "Cue goes back to the cue point");
        render_on(&mut deck, &vinyl(1.0, 4_800));
        assert!((deck.seconds() - 0.6).abs() < 1e-9, "and plays on from it");
        deck.jump_hold(3.0);
        deck.jump_release();
        render_on(&mut deck, &vinyl(1.0, 480));
        assert!((deck.seconds() - 3.01).abs() < 1e-9, "{}", deck.seconds());
        deck.brake(0.5);
        render_on(&mut deck, &vinyl(1.0, 480));
        assert!(
            (deck.seconds() - 3.02).abs() < 1e-9,
            "the record, not a brake, moves it"
        );
    }

    #[test]
    fn in_abs_the_deck_goes_where_the_record_is_and_a_hot_cue_turns_it_to_rel() {
        let mut deck = ramp_deck(20.0, 120.0);
        deck.set_mode(DeckMode::Absolute);
        render_on(&mut deck, &record_at(10.0, 480));
        assert!((deck.seconds() - 10.01).abs() < 1e-6, "{}", deck.seconds());
        // A little behind the record, it catches up rather than jumps.
        render_on(&mut deck, &record_at(10.02, 4_800));
        assert!((deck.seconds() - 10.12).abs() < 1e-4, "{}", deck.seconds());
        // A needle drop far off jumps there.
        render_on(&mut deck, &record_at(2.0, 480));
        assert!((deck.seconds() - 2.01).abs() < 1e-6, "{}", deck.seconds());
        // Between readings it carries on at the record's speed.
        render_on(&mut deck, &vinyl(1.0, 480));
        assert!((deck.seconds() - 2.02).abs() < 1e-6);
        // Off the record's range, it stops.
        let off = VinylFrame {
            present: true,
            speed: 1.0,
            position: f64::NAN,
            off_range: true,
        };
        render_on(&mut deck, &[off; 480]);
        assert!((deck.seconds() - 2.02).abs() < 1e-6);
        // A Hot Cue can't move the needle, so it turns the Deck to REL.
        deck.jump_hold(5.0);
        deck.jump_release();
        assert_eq!(deck.mode(), DeckMode::Relative);
        render_on(&mut deck, &record_at(12.0, 480));
        assert!((deck.seconds() - 5.01).abs() < 1e-6, "{}", deck.seconds());
    }

    #[test]
    fn back_to_int_a_deck_the_record_was_playing_plays_on_by_itself() {
        let mut deck = ramp_deck(4.0, 120.0);
        deck.set_mode(DeckMode::Relative);
        render_on(&mut deck, &vinyl(1.0, 480));
        deck.set_mode(DeckMode::Internal);
        assert!(deck.is_playing());
        render(&mut deck, 480);
        assert!((deck.seconds() - 0.02).abs() < 1e-9);
        assert_eq!(DeckMode::from_value(2.0), DeckMode::Absolute);
        assert_eq!(DeckMode::from_value(7.0), DeckMode::Internal);
    }
}

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
//! Nothing here allocates: the file is decoded and analysed off the audio
//! thread and moved in whole.

use super::stretch::Stretcher;
use crate::engine::PreparedAudioFile;

/// How fast the platter follows the hand while scratching: a time constant
/// in seconds, short enough to feel direct and long enough not to crackle.
const SCRATCH_SMOOTHING_SECONDS: f64 = 0.004;
/// How far a spin-back throws the record backwards at first, as a speed.
const SPINBACK_SPEED: f64 = -4.0;

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
        self.stretcher.reset();
        std::mem::replace(&mut self.track, track)
    }

    pub fn is_loaded(&self) -> bool {
        self.track.is_some()
    }

    pub fn is_playing(&self) -> bool {
        self.playing
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

    /// The speed the tempo fader, Sync and the bend give, before Reverse.
    pub fn rate(&self) -> f64 {
        (self.sync_rate.unwrap_or(1.0 + self.tempo) * (1.0 + self.bend) * (1.0 + self.phase_trim))
            .max(0.0)
    }

    /// Beats per minute as it plays now; 0 with no Beat Grid.
    pub fn effective_bpm(&self) -> f64 {
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
    pub fn cue_down(&mut self) {
        if !self.is_loaded() {
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
            self.seek_frames(seconds * self.sample_rate);
        }
    }

    /// A Hot Cue held: jump there, and with Slip on, come back on release.
    pub fn jump_hold(&mut self, seconds: f64) {
        if !seconds.is_finite() {
            return;
        }
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
        if self.playing {
            self.motor = Motor::Brake {
                from: self.speed.abs().max(self.rate()),
                frames: (seconds.max(0.01)) * self.sample_rate,
                done: 0.0,
            };
        }
    }

    /// Throw the record back and let it stop, over `seconds`.
    pub fn spinback(&mut self, seconds: f64) {
        if self.playing {
            self.motor = Motor::Spinback {
                frames: (seconds.max(0.05)) * self.sample_rate,
                done: 0.0,
            };
        }
    }

    /// The speed of the next frame, signed, and whether the pitch follows
    /// it (a scratch, a brake) whatever Master Tempo says.
    fn next_speed(&mut self) -> (f64, bool) {
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
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        let mut peak = 0.0f32;
        let Some(track) = self.track.clone() else {
            self.peak = 0.0;
            left.fill(0.0);
            right.fill(0.0);
            return;
        };
        let (source_l, source_r) = (track.file.left(), track.file.right());
        let frames = source_l.len() as f64;
        let rate = self.rate();
        for (l, r) in left.iter_mut().zip(right.iter_mut()) {
            let (speed, follows) = self.next_speed();
            self.speed = speed;
            if speed == 0.0 && !self.playing && self.scratch.is_none() {
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
            *l = sl;
            *r = sr;
            peak = peak.max(sl.abs()).max(sr.abs());

            self.position += speed;
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
                if self.scratch.is_none() {
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
    fn a_hand_set_grid_wins_and_gives_the_beat_position() {
        let mut deck = ramp_deck(4.0, 120.0);
        deck.set_grid(60.0, 0.5);
        deck.seek(2.5);
        assert_eq!(deck.beat_position(), Some(2.0));
        assert_eq!(deck.effective_bpm(), 60.0);
        deck.tempo = 0.1;
        assert!((deck.effective_bpm() - 66.0).abs() < 1e-9);
    }
}

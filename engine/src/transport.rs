//! The transport: where playback is, how fast it moves, and when things are
//! due.
//!
//! Musical time is counted in integer ticks, `TICKS_PER_BEAT` to a quarter
//! note. Audio time is counted in frames. The transport converts between them
//! through the tempo map, from an *anchor*: a tick and the frame it was at.
//! Every change to the map, seek and loop wrap sets a new anchor, so
//! positions never drift however long it plays, and a tick's frame is
//! computed, not accumulated.

use crate::tempo_map::{TempoChanges, TempoMap};

/// Ticks per quarter note. Divides evenly by 2, 3, 4, 5, 6, 8, 16, 32 and 64.
pub const TICKS_PER_BEAT: u64 = 960;

/// Tolerance for a tick landing on a frame boundary despite rounding.
const EPSILON: f64 = 1e-6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TimeSignature {
    pub beats_per_bar: u32,
    /// The note value of one beat: 4 for quarter notes, 8 for eighths.
    pub beat_unit: u32,
}

impl TimeSignature {
    /// Ticks in one of this time signature's beats.
    pub fn beat_ticks(&self) -> u64 {
        TICKS_PER_BEAT * 4 / u64::from(self.beat_unit.max(1))
    }

    pub fn bar_ticks(&self) -> u64 {
        self.beat_ticks() * u64::from(self.beats_per_bar.max(1))
    }
}

impl Default for TimeSignature {
    fn default() -> Self {
        Self {
            beats_per_bar: 4,
            beat_unit: 4,
        }
    }
}

/// A region that repeats: `start` inclusive, `end` exclusive, in ticks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoopRegion {
    pub start: u64,
    pub end: u64,
}

impl TimeSignature {
    /// 1 to 32 beats to the bar, of a whole, half, quarter, eighth,
    /// sixteenth or thirty-second note.
    pub fn is_valid(&self) -> bool {
        (1..=32).contains(&self.beats_per_bar) && [1, 2, 4, 8, 16, 32].contains(&self.beat_unit)
    }
}

#[derive(Clone, Debug)]
pub struct Transport {
    sample_rate: f64,
    tempo_map: TempoMap,
    loop_region: Option<LoopRegion>,
    playing: bool,
    /// Frames rendered since the engine started, playing or not.
    now: u64,
    anchor_frame: u64,
    anchor_tick: f64,
    /// Where `anchor_tick` is in the song, in seconds.
    anchor_seconds: f64,
}

impl Transport {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate: f64::from(sample_rate),
            tempo_map: TempoMap::default(),
            loop_region: None,
            playing: false,
            now: 0,
            anchor_frame: 0,
            anchor_tick: 0.0,
            anchor_seconds: 0.0,
        }
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    pub fn tempo_map(&self) -> &TempoMap {
        &self.tempo_map
    }

    /// The tempo where playback is.
    pub fn tempo(&self) -> f64 {
        self.tempo_map.tempo_at(self.position())
    }

    /// The loop region, when looping is on.
    pub fn loop_region(&self) -> Option<LoopRegion> {
        self.loop_region
    }

    /// Where playback is, in ticks. Fractional between ticks.
    pub fn position(&self) -> f64 {
        let elapsed = (self.now - self.anchor_frame) as f64 / self.sample_rate;
        if elapsed == 0.0 {
            return self.anchor_tick;
        }
        self.tempo_map.tick_at(self.anchor_seconds + elapsed)
    }

    /// Where playback will be `frames` from now: where it is, unless it is
    /// playing.
    pub fn position_after(&self, frames: u64) -> f64 {
        if !self.playing || frames == 0 {
            return self.position();
        }
        let elapsed = (self.now + frames - self.anchor_frame) as f64 / self.sample_rate;
        self.tempo_map.tick_at(self.anchor_seconds + elapsed)
    }

    /// The absolute frame `tick` falls on: the first frame at or after it.
    pub fn frame_of(&self, tick: u64) -> u64 {
        self.frame_at_seconds(self.tempo_map.seconds_at(tick as f64))
    }

    /// The absolute frame `seconds` into the song falls on: the first frame
    /// at or after it.
    pub fn frame_at_seconds(&self, seconds: f64) -> u64 {
        let frames = (seconds - self.anchor_seconds) * self.sample_rate;
        self.anchor_frame + (frames - EPSILON).ceil().max(0.0) as u64
    }

    /// The current absolute frame.
    pub fn now(&self) -> u64 {
        self.now
    }

    /// Move the clock on by `frames`. Playback position follows only while
    /// playing.
    pub fn advance(&mut self, frames: u64) {
        if !self.playing {
            self.anchor_frame += frames;
        }
        self.now += frames;
    }

    pub fn play(&mut self) {
        self.playing = true;
    }

    pub fn stop(&mut self) {
        self.playing = false;
    }

    /// Jump to `tick`, from the current frame.
    pub fn seek(&mut self, tick: u64) {
        self.anchor_frame = self.now;
        self.anchor_tick = tick as f64;
        self.anchor_seconds = self.tempo_map.seconds_at(self.anchor_tick);
    }

    /// Change the starting tempo without moving the playback position.
    pub fn set_tempo(&mut self, bpm: f64) {
        self.change_map(|map| map.set_tempo(bpm));
    }

    /// Change the starting time signature.
    pub fn set_time_signature(&mut self, time_signature: TimeSignature) {
        self.change_map(|map| map.set_time_signature(time_signature));
    }

    /// Replace the Tempo Changes without moving the playback position,
    /// handing back the old ones. Allocates nothing.
    pub fn swap_tempo_changes(&mut self, changes: TempoChanges) -> TempoChanges {
        let mut old = None;
        self.change_map(|map| old = Some(map.swap_changes(changes)));
        old.unwrap_or_default()
    }

    /// Loop `region`, or stop looping with `None`. An empty region is ignored.
    pub fn set_loop(&mut self, region: Option<LoopRegion>) {
        self.loop_region = region.filter(|r| r.end > r.start);
    }

    /// Change the tempo map, keeping playback on the tick it is at: only the
    /// speed from here on changes.
    fn change_map(&mut self, change: impl FnOnce(&mut TempoMap)) {
        self.anchor_tick = self.position();
        self.anchor_frame = self.now;
        change(&mut self.tempo_map);
        self.anchor_seconds = self.tempo_map.seconds_at(self.anchor_tick);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_120_bpm_and_48_khz_a_beat_is_24000_frames() {
        let transport = Transport::new(48_000.0);
        assert_eq!(transport.frame_of(TICKS_PER_BEAT), 24_000);
        assert_eq!(transport.frame_of(TICKS_PER_BEAT * 4 * 100), 9_600_000);
    }

    #[test]
    fn position_only_moves_while_playing() {
        let mut transport = Transport::new(48_000.0);
        transport.advance(24_000);
        assert_eq!(transport.position(), 0.0);
        transport.play();
        transport.advance(24_000);
        assert!((transport.position() - 960.0).abs() < 1e-9);
    }

    #[test]
    fn a_tempo_change_keeps_the_position() {
        let mut transport = Transport::new(48_000.0);
        transport.play();
        transport.advance(12_000);
        transport.set_tempo(60.0);
        assert!((transport.position() - 480.0).abs() < 1e-9);
        // The rest of the beat now takes twice as long.
        assert_eq!(transport.frame_of(960), 12_000 + 24_000);
    }

    #[test]
    fn after_a_tempo_change_ticks_fall_at_the_new_tempo() {
        let mut transport = Transport::new(48_000.0);
        // 120 bpm for a bar, then 60.
        transport.swap_tempo_changes(TempoChanges::from_flat(&[3_840.0, 60.0, 4.0, 4.0]));
        assert_eq!(transport.frame_of(3_840), 96_000);
        assert_eq!(transport.frame_of(3_840 + 960), 96_000 + 48_000);
        transport.play();
        transport.advance(96_000 + 24_000);
        assert!((transport.position() - (3_840.0 + 480.0)).abs() < 1e-6);
        assert_eq!(transport.tempo(), 60.0);
    }

    #[test]
    fn changing_the_tempo_map_while_playing_keeps_the_position() {
        let mut transport = Transport::new(48_000.0);
        transport.play();
        transport.advance(12_000);
        transport.swap_tempo_changes(TempoChanges::from_flat(&[240.0, 60.0, 4.0, 4.0]));
        assert!((transport.position() - 480.0).abs() < 1e-9);
        assert_eq!(transport.frame_of(960), 12_000 + 24_000);
    }

    #[test]
    fn beats_follow_the_time_signature() {
        let six_eight = TimeSignature {
            beats_per_bar: 6,
            beat_unit: 8,
        };
        assert_eq!(six_eight.beat_ticks(), 480);
        assert_eq!(six_eight.bar_ticks(), 2_880);
    }

    #[test]
    fn empty_loops_are_ignored_and_tempo_is_clamped() {
        let mut transport = Transport::new(48_000.0);
        transport.set_loop(Some(LoopRegion { start: 10, end: 10 }));
        assert_eq!(transport.loop_region(), None);
        transport.set_tempo(5.0);
        assert_eq!(transport.tempo(), crate::tempo_map::MIN_TEMPO);
    }
}

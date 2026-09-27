//! The tempo map: the song's starting tempo and time signature, and every
//! **Tempo Change** after it. It is the one place ticks become seconds.
//!
//! Tempo is in quarter notes per minute, and a tick is a fixed fraction of a
//! quarter note, so only the tempo moves ticks in time. A time signature
//! moves the grid instead: its bars and beats count from the change that set
//! it, which the UI only allows at a bar line. A change of tempo alone keeps
//! the grid it falls in. Changes are instant; there are no ramps.

use crate::transport::{TICKS_PER_BEAT, TimeSignature};

/// Enough for any song, and a bound on what a host's message can make the
/// engine allocate.
pub const MAX_TEMPO_CHANGES: usize = 4_096;

pub const MIN_TEMPO: f64 = 20.0;
pub const MAX_TEMPO: f64 = 999.0;

/// From one Tempo Change (or the song's start) to the next.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Segment {
    tick: u64,
    tempo: f64,
    time_signature: TimeSignature,
    /// Seconds from the song's start to `tick`.
    seconds: f64,
    /// Where the grid this segment is in starts: the tick of the last change
    /// of time signature, or 0.
    grid_tick: u64,
    /// Bars before `grid_tick`, counting from 0.
    grid_bar: u64,
}

impl Segment {
    fn new(tick: u64, tempo: f64, time_signature: TimeSignature) -> Self {
        Self {
            tick,
            tempo: tempo.clamp(MIN_TEMPO, MAX_TEMPO),
            time_signature,
            seconds: 0.0,
            grid_tick: 0,
            grid_bar: 0,
        }
    }

    fn seconds_per_tick(&self) -> f64 {
        60.0 / (self.tempo * TICKS_PER_BEAT as f64)
    }
}

/// The Tempo Changes after the song's start, sorted and ready to swap into a
/// `TempoMap`. Building them allocates, so a native host does it off the
/// audio thread.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TempoChanges(Vec<Segment>);

impl TempoChanges {
    /// Read flat tick, tempo, beats per bar and beat unit for each change.
    /// One at tick 0 or with a non-finite or impossible value is skipped, and
    /// of two at the same tick the later wins.
    pub fn from_flat(flat: &[f64]) -> Self {
        let mut segments: Vec<Segment> = flat
            .as_chunks::<4>()
            .0
            .iter()
            .take(MAX_TEMPO_CHANGES)
            .filter(|c| c.iter().all(|v| v.is_finite()) && c[0] >= 1.0 && c[1] > 0.0)
            .filter_map(|&[tick, tempo, beats_per_bar, beat_unit]| {
                let signature = TimeSignature {
                    beats_per_bar: beats_per_bar as u32,
                    beat_unit: beat_unit as u32,
                };
                signature
                    .is_valid()
                    .then(|| Segment::new(tick as u64, tempo, signature))
            })
            .collect();
        segments.reverse();
        segments.sort_by_key(|s| s.tick);
        segments.dedup_by_key(|s| s.tick);
        Self(segments)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TempoMap {
    start: Segment,
    changes: TempoChanges,
}

impl Default for TempoMap {
    fn default() -> Self {
        Self::new(120.0, TimeSignature::default())
    }
}

impl TempoMap {
    pub fn new(tempo: f64, time_signature: TimeSignature) -> Self {
        Self {
            start: Segment::new(0, tempo, time_signature),
            changes: TempoChanges::default(),
        }
    }

    /// The starting tempo, clamped to 20 to 999. Allocates nothing.
    pub fn set_tempo(&mut self, tempo: f64) {
        self.start.tempo = tempo.clamp(MIN_TEMPO, MAX_TEMPO);
        self.recompute();
    }

    /// The starting time signature. Allocates nothing.
    pub fn set_time_signature(&mut self, time_signature: TimeSignature) {
        self.start.time_signature = time_signature;
        self.recompute();
    }

    /// Replace the Tempo Changes, handing back the old ones. Allocates
    /// nothing.
    pub fn swap_changes(&mut self, changes: TempoChanges) -> TempoChanges {
        let old = std::mem::replace(&mut self.changes, changes);
        self.recompute();
        old
    }

    pub fn tempo_at(&self, tick: f64) -> f64 {
        self.segment_at(tick).tempo
    }

    /// Seconds from the song's start to `tick`.
    pub fn seconds_at(&self, tick: f64) -> f64 {
        let tick = tick.max(0.0);
        let segment = self.segment_at(tick);
        segment.seconds + (tick - segment.tick as f64) * segment.seconds_per_tick()
    }

    /// The tick `seconds` from the song's start falls on, fractional between
    /// ticks.
    pub fn tick_at(&self, seconds: f64) -> f64 {
        let seconds = seconds.max(0.0);
        let index = self.changes.0.partition_point(|s| s.seconds <= seconds);
        let segment = match index {
            0 => &self.start,
            i => &self.changes.0[i - 1],
        };
        segment.tick as f64 + (seconds - segment.seconds) / segment.seconds_per_tick()
    }

    /// The tick of the first Tempo Change at or after `from`.
    pub fn next_change(&self, from: u64) -> Option<u64> {
        let index = self.changes.0.partition_point(|s| s.tick < from);
        self.changes.0.get(index).map(|s| s.tick)
    }

    /// The first beat at or after `from`.
    pub fn next_beat(&self, from: u64) -> u64 {
        let segment = self.segment_at(from as f64);
        let beat = segment.time_signature.beat_ticks();
        let on_grid = segment.grid_tick + (from - segment.grid_tick).div_ceil(beat) * beat;
        // A new time signature starts a new grid, whatever the old one said.
        let next_grid = self
            .changes
            .0
            .iter()
            .skip_while(|s| s.tick <= from)
            .find(|s| s.grid_tick == s.tick)
            .map(|s| s.tick);
        next_grid.map_or(on_grid, |next| on_grid.min(next))
    }

    /// Whether a beat falls on `tick`, and if so whether it starts a bar.
    pub fn beat_at(&self, tick: u64) -> Option<bool> {
        let segment = self.segment_at(tick as f64);
        let into = tick - segment.grid_tick;
        into.is_multiple_of(segment.time_signature.beat_ticks())
            .then(|| into.is_multiple_of(segment.time_signature.bar_ticks()))
    }

    /// The bar and beat `tick` falls in, both counting from 1.
    pub fn bar_and_beat(&self, tick: f64) -> (u64, u64) {
        let tick = tick.max(0.0);
        let segment = self.segment_at(tick);
        let into = tick - segment.grid_tick as f64;
        let bar_ticks = segment.time_signature.bar_ticks() as f64;
        let beat_ticks = segment.time_signature.beat_ticks() as f64;
        (
            segment.grid_bar + (into / bar_ticks).floor() as u64 + 1,
            ((into % bar_ticks) / beat_ticks).floor() as u64 + 1,
        )
    }

    fn segment_at(&self, tick: f64) -> &Segment {
        match self.changes.0.partition_point(|s| s.tick as f64 <= tick) {
            0 => &self.start,
            i => &self.changes.0[i - 1],
        }
    }

    /// Work out where each change is in seconds and in bars, from the one
    /// before it.
    fn recompute(&mut self) {
        let mut previous = self.start;
        for segment in &mut self.changes.0 {
            segment.seconds = previous.seconds
                + (segment.tick - previous.tick) as f64 * previous.seconds_per_tick();
            if segment.time_signature == previous.time_signature {
                segment.grid_tick = previous.grid_tick;
                segment.grid_bar = previous.grid_bar;
            } else {
                // Off a bar line (which the UI doesn't allow), the part bar
                // before it still counts.
                let bars = (segment.tick - previous.grid_tick)
                    .div_ceil(previous.time_signature.bar_ticks());
                segment.grid_tick = segment.tick;
                segment.grid_bar = previous.grid_bar + bars;
            }
            previous = *segment;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BEAT: u64 = TICKS_PER_BEAT;
    const FOUR_FOUR: TimeSignature = TimeSignature {
        beats_per_bar: 4,
        beat_unit: 4,
    };
    const THREE_FOUR: TimeSignature = TimeSignature {
        beats_per_bar: 3,
        beat_unit: 4,
    };

    fn map(changes: &[f64]) -> TempoMap {
        let mut map = TempoMap::new(120.0, FOUR_FOUR);
        map.swap_changes(TempoChanges::from_flat(changes));
        map
    }

    #[test]
    fn without_changes_a_beat_at_120_is_half_a_second() {
        let map = TempoMap::default();
        assert_eq!(map.seconds_at(BEAT as f64), 0.5);
        assert_eq!(map.tick_at(2.0), 4.0 * BEAT as f64);
    }

    #[test]
    fn after_a_change_ticks_move_at_the_new_tempo() {
        // 120 for the first bar (2 s), then 60.
        let map = map(&[(4 * BEAT) as f64, 60.0, 4.0, 4.0]);
        assert_eq!(map.seconds_at((4 * BEAT) as f64), 2.0);
        assert_eq!(map.seconds_at((5 * BEAT) as f64), 3.0);
        assert_eq!(map.tick_at(3.0), (5 * BEAT) as f64);
        assert_eq!(map.tick_at(1.0), (2 * BEAT) as f64);
        assert_eq!(map.tempo_at((4 * BEAT) as f64), 60.0);
        assert_eq!(map.tempo_at((4 * BEAT - 1) as f64), 120.0);
    }

    #[test]
    fn changing_the_starting_tempo_moves_every_change_in_time() {
        let mut map = map(&[(4 * BEAT) as f64, 60.0, 4.0, 4.0]);
        map.set_tempo(60.0);
        assert_eq!(map.seconds_at((5 * BEAT) as f64), 5.0);
    }

    #[test]
    fn a_new_time_signature_starts_its_own_grid() {
        // Two bars of 4/4, then 3/4.
        let map = map(&[(8 * BEAT) as f64, 120.0, 3.0, 4.0]);
        assert_eq!(map.bar_and_beat((8 * BEAT) as f64), (3, 1));
        assert_eq!(map.bar_and_beat((11 * BEAT) as f64), (4, 1));
        assert_eq!(map.bar_and_beat((13 * BEAT) as f64), (4, 3));
        assert_eq!(map.beat_at(11 * BEAT), Some(true));
        assert_eq!(map.beat_at(12 * BEAT), Some(false));
        assert_eq!(map.beat_at(12 * BEAT + 1), None);
        assert_eq!(map.segment_at((8 * BEAT) as f64).time_signature, THREE_FOUR);
    }

    #[test]
    fn a_tempo_change_off_the_beat_keeps_the_grid() {
        let map = map(&[(BEAT + BEAT / 2) as f64, 90.0, 4.0, 4.0]);
        assert_eq!(map.next_beat(BEAT + 1), 2 * BEAT);
        assert_eq!(map.beat_at(4 * BEAT), Some(true));
        assert_eq!(map.bar_and_beat((5 * BEAT) as f64), (2, 2));
    }

    #[test]
    fn the_next_beat_stops_at_a_new_grid() {
        // 6/8 from bar 2: its beats are eighth notes.
        let map = map(&[(4 * BEAT) as f64, 120.0, 6.0, 8.0]);
        assert_eq!(map.next_beat(3 * BEAT + 1), 4 * BEAT);
        assert_eq!(map.next_beat(4 * BEAT + 1), 4 * BEAT + BEAT / 2);
    }

    #[test]
    fn the_next_change_is_found_from_any_tick() {
        let map = map(&[480.0, 90.0, 4.0, 4.0, 1_920.0, 60.0, 3.0, 4.0]);
        assert_eq!(map.next_change(0), Some(480));
        assert_eq!(map.next_change(480), Some(480));
        assert_eq!(map.next_change(481), Some(1_920));
        assert_eq!(map.next_change(1_921), None);
        assert_eq!(TempoMap::default().next_change(0), None);
    }

    #[test]
    fn bad_changes_are_skipped_and_the_later_of_two_wins() {
        let changes = TempoChanges::from_flat(&[
            0.0,
            90.0,
            4.0,
            4.0, // At the start: that is the starting tempo's.
            960.0,
            90.0,
            5.0,
            3.0, // No such beat unit.
            1_920.0,
            90.0,
            4.0,
            4.0,
            1_920.0,
            100.0,
            4.0,
            4.0,
            f64::NAN,
            1.0,
            4.0,
            4.0,
        ]);
        assert_eq!(changes.0.len(), 1);
        assert_eq!(changes.0[0].tempo, 100.0);
    }
}

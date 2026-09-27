//! The log of live notes played into the engine, for a host recording them
//! into a Pattern Clip.
//!
//! Notes are timestamped here, where they arrive, so that every host records
//! them the same way: on the desktop they come from the MIDI thread straight
//! to the audio thread and never reach the UI at all (ADR 0002).
//!
//! The log is preallocated and never grows, because it is written on the
//! audio thread. Once it is full, notes are counted rather than kept.

/// Room for a burst of live notes between drains. The desktop host drains
/// after every audio callback and the browser one with every report, so this
/// is far more than either can fill. A host's own queue is sized from it.
pub const RECORDING_CAPACITY: usize = 4_096;

/// One live note-on or note-off, as the engine timestamped it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RecordedNote {
    /// The transport position, in ticks, at the frame the note was applied:
    /// the start of the block it arrived in.
    pub tick: f64,
    /// MIDI note number.
    pub pitch: u8,
    /// 0..=1, and 0 for a note-off.
    pub velocity: f32,
    /// A note-on; a note-off otherwise.
    pub on: bool,
}

impl RecordedNote {
    /// The flat form a JS host reads: tick, pitch, velocity, and 1 for a
    /// note-on or 0 for a note-off.
    fn to_flat(self) -> [f64; 4] {
        [
            self.tick,
            f64::from(self.pitch),
            f64::from(self.velocity),
            f64::from(u8::from(self.on)),
        ]
    }
}

/// What has been played since the host last drained the log.
#[derive(Clone, Debug)]
pub struct RecordingLog {
    notes: Vec<RecordedNote>,
    dropped: u32,
    on: bool,
}

impl Default for RecordingLog {
    fn default() -> Self {
        Self {
            notes: Vec::with_capacity(RECORDING_CAPACITY),
            dropped: 0,
            on: false,
        }
    }
}

impl RecordingLog {
    /// Start or stop logging. What is already logged stays until it is
    /// drained.
    pub fn set_on(&mut self, on: bool) {
        self.on = on;
    }

    pub fn is_on(&self) -> bool {
        self.on
    }

    /// Log one note, if recording. Allocates nothing: a note that doesn't fit
    /// is counted instead.
    pub fn push(&mut self, note: RecordedNote) {
        if !self.on {
            return;
        }
        if self.notes.len() == self.notes.capacity() {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        self.notes.push(note);
    }

    /// What has been logged since the last `clear`.
    pub fn notes(&self) -> &[RecordedNote] {
        &self.notes
    }

    /// Notes there was no room for, since the engine started.
    pub fn dropped(&self) -> u32 {
        self.dropped
    }

    /// Forget the logged notes, keeping the room they were in.
    pub fn clear(&mut self) {
        self.notes.clear();
    }

    /// Drain the log into the flat form a JS host reads. Unlike `notes` this
    /// allocates, so only the browser host uses it.
    pub fn take_flat(&mut self) -> Vec<f64> {
        let flat = self.notes.iter().flat_map(|n| n.to_flat()).collect();
        self.clear();
        flat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(tick: f64) -> RecordedNote {
        RecordedNote {
            tick,
            pitch: 60,
            velocity: 1.0,
            on: true,
        }
    }

    #[test]
    fn nothing_is_logged_until_recording_starts() {
        let mut log = RecordingLog::default();
        log.push(note(0.0));
        assert!(log.notes().is_empty());
        log.set_on(true);
        log.push(note(960.0));
        assert_eq!(log.notes(), [note(960.0)]);
    }

    #[test]
    fn a_full_log_counts_what_it_drops_instead_of_growing() {
        let mut log = RecordingLog::default();
        log.set_on(true);
        let room = RECORDING_CAPACITY;
        let start = log.notes().as_ptr();
        for tick in 0..room + 100 {
            log.push(note(tick as f64));
        }
        assert_eq!(log.notes().len(), room, "full");
        assert_eq!(log.dropped(), 100);
        assert_eq!(
            log.notes().as_ptr(),
            start,
            "the log never moved: never grew"
        );

        log.clear();
        assert!(log.notes().is_empty());
        assert_eq!(log.notes().as_ptr(), start, "and kept its room");
    }

    #[test]
    fn the_flat_form_is_tick_pitch_velocity_and_whether_it_is_a_note_on() {
        let mut log = RecordingLog::default();
        log.set_on(true);
        log.push(note(480.0));
        log.push(RecordedNote {
            tick: 500.0,
            pitch: 60,
            velocity: 0.0,
            on: false,
        });
        assert_eq!(
            log.take_flat(),
            [480.0, 60.0, 1.0, 1.0, 500.0, 60.0, 0.0, 0.0]
        );
        assert!(log.notes().is_empty(), "taking drains");
    }
}

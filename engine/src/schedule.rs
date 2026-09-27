//! The notes one Track plays, and which of them are sounding.

/// A note in musical time. Ticks count from the start of the song.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Note {
    pub start: u64,
    pub length: u64,
    pub pitch: u8,
    /// 0..=1.
    pub velocity: f32,
}

impl Note {
    pub fn end(&self) -> u64 {
        self.start + self.length
    }
}

/// Notes sorted by start, with room to track every one of them sounding at
/// once. Sorting and allocating aren't safe on an audio thread, so a native
/// host builds a `NoteList` elsewhere and swaps it in; the one it replaces
/// comes back to be dropped where freeing memory is safe too.
#[derive(Clone, Debug, Default)]
pub struct NoteList {
    notes: Vec<Note>,
    sounding: Vec<Note>,
}

impl NoteList {
    /// Zero-length notes are dropped.
    pub fn new(mut notes: Vec<Note>) -> Self {
        notes.retain(|n| n.length > 0);
        notes.sort_by_key(|n| (n.start, n.pitch));
        let sounding = Vec::with_capacity(notes.len());
        Self { notes, sounding }
    }

    /// Read notes from flat start, length (ticks), MIDI pitch and velocity
    /// (0..=1) for each. Notes with a non-finite value or a negative start or
    /// length are skipped; a trailing partial note is ignored.
    pub fn from_flat(flat: &[f64]) -> Self {
        let notes = flat
            .as_chunks::<4>()
            .0
            .iter()
            .filter(|n| n.iter().all(|v| v.is_finite()) && n[0] >= 0.0 && n[1] >= 0.0)
            .map(|n| Note {
                start: n[0] as u64,
                length: n[1] as u64,
                pitch: n[2].clamp(0.0, 127.0) as u8,
                velocity: n[3].clamp(0.0, 1.0) as f32,
            })
            .collect();
        Self::new(notes)
    }

    pub fn len(&self) -> usize {
        self.notes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.notes.is_empty()
    }
}

/// A Track's notes, with a cursor for the next one due and the list of notes
/// that have started but not ended.
#[derive(Clone, Debug, Default)]
pub struct Schedule {
    list: NoteList,
    next: usize,
}

impl Schedule {
    /// Replace the notes, returning the old ones. The caller releases anything
    /// sounding first. Allocates nothing.
    pub fn set_notes(&mut self, list: NoteList, from: u64) -> NoteList {
        let mut old = std::mem::replace(&mut self.list, list);
        old.sounding.clear();
        self.list.sounding.clear();
        self.rewind(from);
        old
    }

    /// Point the cursor at the first note starting at or after `tick`.
    pub fn rewind(&mut self, tick: u64) {
        self.next = self.list.notes.partition_point(|n| n.start < tick);
    }

    /// The earliest tick at which this schedule has something to do, at or
    /// after `from`.
    pub fn next_event(&self, from: u64) -> Option<u64> {
        let next_on = self.list.notes.get(self.next).map(|n| n.start.max(from));
        let next_off = self.list.sounding.iter().map(|n| n.end().max(from)).min();
        match (next_on, next_off) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Notes ending at `tick`: removed from the sounding list and returned
    /// through `off`.
    pub fn end_notes_at(&mut self, tick: u64, mut off: impl FnMut(u8)) {
        self.list.sounding.retain(|n| {
            let ends = n.end() <= tick;
            if ends {
                off(n.pitch);
            }
            !ends
        });
    }

    /// Notes starting at `tick`: added to the sounding list and returned
    /// through `on`. The list has room for every note, so this never
    /// allocates.
    pub fn start_notes_at(&mut self, tick: u64, mut on: impl FnMut(u8, f32)) {
        while let Some(note) = self.list.notes.get(self.next).filter(|n| n.start <= tick) {
            on(note.pitch, note.velocity);
            self.list.sounding.push(*note);
            self.next += 1;
        }
    }

    /// End every sounding note, e.g. on stop, seek or a loop wrap.
    pub fn release_all(&mut self, mut off: impl FnMut(u8)) {
        for note in self.list.sounding.drain(..) {
            off(note.pitch);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(start: u64, length: u64, pitch: u8) -> Note {
        Note {
            start,
            length,
            pitch,
            velocity: 1.0,
        }
    }

    #[test]
    fn events_come_in_order_and_each_note_starts_and_ends_once() {
        let mut schedule = Schedule::default();
        schedule.set_notes(NoteList::new(vec![note(960, 480, 62), note(0, 960, 60)]), 0);

        let mut log = Vec::new();
        let mut from = 0;
        while let Some(tick) = schedule.next_event(from) {
            schedule.end_notes_at(tick, |p| log.push(format!("off {p} @{tick}")));
            schedule.start_notes_at(tick, |p, _| log.push(format!("on {p} @{tick}")));
            from = tick + 1;
        }
        assert_eq!(
            log,
            ["on 60 @0", "off 60 @960", "on 62 @960", "off 62 @1440"]
        );
    }

    #[test]
    fn rewinding_skips_notes_already_started() {
        let mut schedule = Schedule::default();
        schedule.set_notes(
            NoteList::new(vec![note(0, 960, 60), note(960, 960, 62)]),
            480,
        );
        assert_eq!(schedule.next_event(480), Some(960));
    }

    #[test]
    fn release_all_ends_whatever_is_sounding() {
        let mut schedule = Schedule::default();
        schedule.set_notes(NoteList::new(vec![note(0, 960, 60)]), 0);
        schedule.start_notes_at(0, |_, _| {});
        let mut released = Vec::new();
        schedule.release_all(|p| released.push(p));
        assert_eq!(released, [60]);
        assert_eq!(schedule.next_event(1), None);
    }

    #[test]
    fn flat_notes_are_read_and_bad_ones_skipped() {
        let list = NoteList::from_flat(&[960.0, 480.0, 62.0, 0.5, f64::NAN, 1.0, 60.0, 1.0, 0.0]);
        assert_eq!(
            list.notes,
            [note(960, 480, 62)].map(|n| Note { velocity: 0.5, ..n })
        );
        assert!(list.sounding.capacity() >= 1);
    }

    #[test]
    fn replacing_notes_hands_back_the_old_ones() {
        let mut schedule = Schedule::default();
        schedule.set_notes(NoteList::new(vec![note(0, 960, 60)]), 0);
        let old = schedule.set_notes(NoteList::default(), 0);
        assert_eq!(old.len(), 1);
        assert_eq!(schedule.next_event(0), None);
    }

    #[test]
    fn zero_length_notes_are_dropped() {
        let mut schedule = Schedule::default();
        schedule.set_notes(NoteList::new(vec![note(0, 0, 60)]), 0);
        assert_eq!(schedule.next_event(0), None);
    }
}

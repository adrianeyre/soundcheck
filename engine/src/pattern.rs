//! The notes each load-test Track loops.
//!
//! The load page's stand-in for Pattern Clips (the Song page plays real ones):
//! enough notes, overlapping enough, to keep every Track's Synth busy.

use crate::schedule::{Note, NoteList};
use crate::transport::TICKS_PER_BEAT;

/// Minor-arpeggio intervals, in semitones above the root.
const ARPEGGIO: [u8; 8] = [0, 7, 12, 15, 19, 15, 12, 7];

/// Eighth notes.
const STEP_TICKS: u64 = TICKS_PER_BEAT / 2;

/// Each note is held for two steps, so neighbouring notes overlap.
const GATE_STEPS: u64 = 2;

/// The notes the `index`th Track plays. Each Track gets its own root, a fourth
/// apart and folded into two octaves, so they aren't all playing the same
/// notes.
pub fn notes_for_track(index: usize) -> Vec<Note> {
    let root = 36 + ((index * 5) % 24) as u8;
    ARPEGGIO
        .iter()
        .enumerate()
        .map(|(step, interval)| Note {
            start: step as u64 * STEP_TICKS,
            length: GATE_STEPS * STEP_TICKS,
            pitch: root + interval,
            velocity: 0.8,
        })
        .collect()
}

impl NoteList {
    /// The load-test pattern for the `index`th Track.
    pub fn load_test_pattern(index: usize) -> Self {
        Self::new(notes_for_track(index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_bar_of_overlapping_eighth_notes() {
        let notes = notes_for_track(0);
        assert_eq!(notes.len(), 8);
        assert_eq!(notes[0].pitch, 36);
        assert_eq!(notes[1].start, 480);
        assert_eq!(notes[7].end(), 9 * STEP_TICKS, "the last runs past the bar");
    }

    #[test]
    fn tracks_get_different_roots() {
        assert_ne!(notes_for_track(0)[0].pitch, notes_for_track(1)[0].pitch);
    }
}

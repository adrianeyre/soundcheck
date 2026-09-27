//! Auditioning a file from the sample browser (#52), or the Reference Track
//! (#106): it plays once, at a level of its own, added straight to what goes
//! to the audio output.
//!
//! It is not part of the song. Nothing here touches a Track, Bus or the
//! Master, so no fader, Effect or meter sees it; a host adds it to the
//! engine's output after the engine has rendered, and a host rendering
//! offline (Audio Analysis, an export) never has one to add.

use crate::engine::PreparedAudioFile;

/// The sample browser's preview level: -6 dB, whatever the mixer is set to,
/// so a full-scale sample doesn't clip on top of the song.
pub const AUDITION_GAIN: f32 = 0.5;

/// The file being auditioned, if any, how far through it is, and how loud.
#[derive(Debug, Default)]
pub struct Audition {
    file: Option<PreparedAudioFile>,
    frame: usize,
    gain: f32,
}

impl Audition {
    /// Play `file` from its start at `gain` (linear: `AUDITION_GAIN` for a
    /// sample), replacing whatever was playing. The file it replaces is
    /// handed back to be dropped off the audio thread.
    pub fn play(&mut self, file: PreparedAudioFile, gain: f32) -> Option<PreparedAudioFile> {
        self.frame = 0;
        self.gain = gain;
        self.file.replace(file)
    }

    /// Stop, handing back the file to be dropped off the audio thread.
    pub fn stop(&mut self) -> Option<PreparedAudioFile> {
        self.frame = 0;
        self.file.take()
    }

    /// Whether there is still some of a file to play.
    pub fn is_playing(&self) -> bool {
        self.file
            .as_ref()
            .is_some_and(|file| self.frame < file.file().frames())
    }

    /// The next frame, left and right, at its gain: silence once
    /// the file has played or when there is none. Allocates nothing.
    pub fn next_frame(&mut self) -> (f32, f32) {
        let Some(file) = &self.file else {
            return (0.0, 0.0);
        };
        let file = file.file();
        if self.frame >= file.frames() {
            return (0.0, 0.0);
        }
        let at = self.frame;
        self.frame += 1;
        (file.left()[at] * self.gain, file.right()[at] * self.gain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_file::tests::{TONE_FRAMES, TONE_RATE, TONE_WAV};

    fn tone() -> PreparedAudioFile {
        PreparedAudioFile::decode(TONE_WAV, TONE_RATE as f32).unwrap()
    }

    #[test]
    fn a_file_plays_once_at_the_preview_level_then_falls_silent() {
        let file = tone();
        let expected: Vec<(f32, f32)> = file
            .file()
            .left()
            .iter()
            .zip(file.file().right())
            .map(|(l, r)| (l * AUDITION_GAIN, r * AUDITION_GAIN))
            .collect();
        let mut audition = Audition::default();
        assert!(!audition.is_playing());
        assert_eq!(audition.next_frame(), (0.0, 0.0));

        assert!(audition.play(file, AUDITION_GAIN).is_none());
        assert!(audition.is_playing());
        let played: Vec<(f32, f32)> = (0..TONE_FRAMES).map(|_| audition.next_frame()).collect();
        assert_eq!(played, expected);
        // The tone is half scale on the left, so the preview peaks at a quarter.
        let peak = played.iter().fold(0.0_f32, |max, (l, _)| max.max(l.abs()));
        assert!((peak - 0.5 * AUDITION_GAIN).abs() < 0.01, "peak {peak}");

        assert!(!audition.is_playing());
        assert_eq!(audition.next_frame(), (0.0, 0.0));
    }

    #[test]
    fn playing_another_file_starts_it_from_the_top_and_hands_back_the_old_one() {
        let mut audition = Audition::default();
        audition.play(tone(), AUDITION_GAIN);
        for _ in 0..100 {
            audition.next_frame();
        }
        assert!(audition.play(tone(), AUDITION_GAIN).is_some());
        let first = tone().file().left()[0] * AUDITION_GAIN;
        assert_eq!(audition.next_frame().0, first);
    }

    #[test]
    fn a_file_plays_at_the_gain_it_is_given() {
        // The Reference Track, turned down to the mix's loudness.
        let mut audition = Audition::default();
        audition.play(tone(), 0.1);
        let played: Vec<f32> = (0..TONE_FRAMES).map(|_| audition.next_frame().0).collect();
        let expected: Vec<f32> = tone().file().left().iter().map(|l| l * 0.1).collect();
        assert_eq!(played, expected);
        assert!(expected.iter().any(|&l| l.abs() > 0.04));
    }

    #[test]
    fn stopping_silences_it_at_once() {
        let mut audition = Audition::default();
        audition.play(tone(), AUDITION_GAIN);
        audition.next_frame();
        assert!(audition.stop().is_some());
        assert!(!audition.is_playing());
        assert_eq!(audition.next_frame(), (0.0, 0.0));
        assert!(audition.stop().is_none());
    }
}

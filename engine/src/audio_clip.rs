//! The **Audio Clips** on an Audio Track, and where each has got to.
//!
//! A Clip starts on a tick, and the engine splits its blocks there, as it
//! does at a note, so a Clip's first frame lands exactly where it should.
//! From there its file plays at the engine's rate, one frame per frame, for
//! the Clip's length in seconds: no time-stretching, so a Tempo Change moves
//! the tick a Clip ends on, not how it sounds. Where it ends is worked out
//! through the tempo map, the same way a tick's frame is, so it is exact too.

use std::sync::Arc;

use crate::audio_file::AudioFile;
use crate::transport::Transport;

#[derive(Clone, Debug)]
pub struct AudioClip {
    start: u64,
    /// How long it plays for.
    seconds: f64,
    /// Frames into the file, at the engine's rate, where the Clip starts.
    offset: usize,
    file: Arc<AudioFile>,
    /// The next frame of the file to play, and how many are left to play,
    /// while the Clip is sounding.
    cursor: Option<(usize, u64)>,
}

impl AudioClip {
    /// A Clip playing `file` from `offset` frames in, from tick `start` for
    /// `seconds`.
    pub fn new(start: u64, seconds: f64, file: Arc<AudioFile>, offset: usize) -> Self {
        Self {
            start,
            seconds,
            offset,
            file,
            cursor: None,
        }
    }

    /// The absolute frame the Clip ends on, as `transport` has the song.
    fn end_frame(&self, transport: &Transport) -> u64 {
        let start = transport.tempo_map().seconds_at(self.start as f64);
        transport.frame_at_seconds(start + self.seconds)
    }
}

#[derive(Clone, Debug, Default)]
pub struct AudioClips {
    clips: Vec<AudioClip>,
}

impl AudioClips {
    /// Clips of no length never sound, so they aren't kept.
    pub fn new(mut clips: Vec<AudioClip>) -> Self {
        clips.retain(|clip| clip.seconds > 0.0);
        Self { clips }
    }

    /// How many Clips are sounding.
    pub fn playing(&self) -> usize {
        self.clips.iter().filter(|c| c.cursor.is_some()).count()
    }

    /// The earliest tick, at or after `from`, when a Clip starts.
    pub fn next_event(&self, from: u64) -> Option<u64> {
        self.clips
            .iter()
            .map(|clip| clip.start)
            .filter(|&tick| tick >= from)
            .min()
    }

    /// Start the Clips that start at `tick`, which `transport` is at.
    pub fn play_events_at(&mut self, tick: u64, transport: &Transport) {
        for clip in &mut self.clips {
            // One already sounding joined in under the playhead, and plays on.
            if clip.start == tick && clip.cursor.is_none() {
                let left = clip.end_frame(transport).saturating_sub(transport.now());
                clip.cursor = (left > 0).then_some((clip.offset, left));
            }
        }
    }

    /// Carry on from where `transport` is, with events from `from` still to
    /// come: a Clip that has started and not yet ended picks up where the
    /// position is inside it.
    pub fn rewind(&mut self, from: u64, transport: &Transport) {
        let map = transport.tempo_map();
        let position = map.seconds_at(transport.position());
        for clip in &mut self.clips {
            let start = map.seconds_at(clip.start as f64);
            let left = clip.end_frame(transport).saturating_sub(transport.now());
            clip.cursor = (clip.start < from && left > 0).then(|| {
                let into = ((position - start) * transport.sample_rate()).round();
                (clip.offset + into.max(0.0) as usize, left)
            });
        }
    }

    /// Stop every Clip, as the transport does when it stops.
    pub fn silence(&mut self) {
        for clip in &mut self.clips {
            clip.cursor = None;
        }
    }

    /// Add the next `left.len()` frames of every sounding Clip to `left` and
    /// `right`, as far as each Clip's end. A Clip that runs past its file's
    /// end plays silence there.
    pub fn render_into(&mut self, left: &mut [f32], right: &mut [f32]) {
        for clip in &mut self.clips {
            let Some((cursor, remaining)) = clip.cursor else {
                continue;
            };
            let frames = left.len().min(remaining as usize);
            let from = cursor.min(clip.file.frames());
            let source = from..(from + frames).min(clip.file.frames());
            for (out, &sample) in left.iter_mut().zip(&clip.file.left()[source.clone()]) {
                *out += sample;
            }
            for (out, &sample) in right.iter_mut().zip(&clip.file.right()[source]) {
                *out += sample;
            }
            let remaining = remaining - frames as u64;
            clip.cursor = (remaining > 0).then_some((cursor + frames, remaining));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_file::tests::stereo_wav;

    fn ramp_file(frames: usize) -> Arc<AudioFile> {
        let left: Vec<f32> = (0..frames).map(|i| i as f32 / frames as f32).collect();
        let right: Vec<f32> = left.iter().map(|s| -s).collect();
        Arc::new(AudioFile::decode(&stereo_wav(&left, &right, 48_000), 48_000.0).unwrap())
    }

    fn render(clips: &mut AudioClips, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut left, mut right) = (vec![0.0; frames], vec![0.0; frames]);
        clips.render_into(&mut left, &mut right);
        (left, right)
    }

    /// At 48 kHz and 120 bpm, 25 frames to a tick.
    fn transport_at(tick: u64) -> Transport {
        let mut transport = Transport::new(48_000.0);
        transport.seek(tick);
        transport
    }

    /// `frames` of audio, in seconds at 48 kHz.
    fn seconds(frames: u32) -> f64 {
        f64::from(frames) / 48_000.0
    }

    #[test]
    fn a_clip_plays_its_file_from_its_offset_once_it_starts_and_stops_at_its_length() {
        let file = ramp_file(100);
        let mut clips = AudioClips::new(vec![AudioClip::new(10, seconds(6), file.clone(), 5)]);
        assert_eq!(clips.next_event(0), Some(10));
        assert_eq!(clips.next_event(11), None);
        assert_eq!(
            render(&mut clips, 4).0,
            vec![0.0; 4],
            "silent before it starts"
        );

        clips.play_events_at(10, &transport_at(10));
        let (left, right) = render(&mut clips, 4);
        assert_eq!(left, file.left()[5..9]);
        assert_eq!(right, file.right()[5..9]);
        let (left, _) = render(&mut clips, 4);
        assert_eq!(left, [file.left()[9], file.left()[10], 0.0, 0.0]);
        assert_eq!(clips.playing(), 0);
    }

    #[test]
    fn rewinding_into_a_clip_picks_up_where_the_position_is() {
        let file = ramp_file(1_000);
        let mut clips = AudioClips::new(vec![AudioClip::new(10, seconds(500), file.clone(), 5)]);
        // Four ticks in is a hundred frames in.
        clips.rewind(14, &transport_at(14));
        assert_eq!(render(&mut clips, 2).0, file.left()[105..107]);
        clips.rewind(10, &transport_at(10));
        assert_eq!(clips.playing(), 0, "the start event plays it");
        clips.rewind(40, &transport_at(40));
        assert_eq!(clips.playing(), 0, "past its end");
    }

    #[test]
    fn a_tempo_change_under_a_clip_moves_neither_its_start_nor_its_end() {
        let file = ramp_file(1_000);
        let mut clips = AudioClips::new(vec![AudioClip::new(10, seconds(500), file.clone(), 0)]);
        let mut transport = transport_at(10);
        transport.swap_tempo_changes(crate::tempo_map::TempoChanges::from_flat(&[
            12.0, 60.0, 4.0, 4.0,
        ]));
        clips.play_events_at(10, &transport);
        let (left, _) = render(&mut clips, 600);
        assert_eq!(left[..500], file.left()[..500]);
        assert!(left[500..].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn a_clip_past_its_files_end_is_silent_there() {
        let file = ramp_file(10);
        let mut clips = AudioClips::new(vec![AudioClip::new(0, seconds(100), file.clone(), 8)]);
        clips.play_events_at(0, &transport_at(0));
        let (left, _) = render(&mut clips, 4);
        assert_eq!(left, [file.left()[8], file.left()[9], 0.0, 0.0]);
    }

    #[test]
    fn a_clip_of_no_length_is_dropped() {
        let clips = AudioClips::new(vec![AudioClip::new(5, 0.0, ramp_file(10), 0)]);
        assert_eq!(clips.next_event(0), None);
    }
}

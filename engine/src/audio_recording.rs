//! Placing a recording of an audio input on the song's timeline, so that an
//! Audio Clip recorded while the song played lines up with what was playing.
//!
//! The engine never opens a device (ADR 0001). A host captures the input and
//! reports two things on one clock of its own: when the recording's first
//! frame reached the input, and when a block of the engine's output reached
//! the output, with where the transport was at that block. Both come from the
//! latencies the audio driver reports, which is the compensation: a frame
//! captured at a moment is the sound that was playing at that moment. What a
//! driver leaves out of its figures (converters, cables) is the musician's
//! offset, measured once with a loopback (see the README).

/// Where the transport was when a block of the engine's output was heard.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlaybackAnchor {
    /// When the block's first frame reached the output, in seconds on the
    /// host's clock.
    pub seconds: f64,
    /// The transport position at that frame, in ticks.
    pub tick: f64,
    /// How fast the transport moves, from the tempo.
    pub ticks_per_second: f64,
}

impl PlaybackAnchor {
    /// Where the transport was, or would have been, at `seconds`, as long as
    /// it kept playing at the same tempo.
    pub fn tick_at(&self, seconds: f64) -> f64 {
        self.tick + (seconds - self.seconds) * self.ticks_per_second
    }
}

/// A recording cut to start exactly on a tick: the Audio Clip it becomes
/// starts at `start_tick` and plays `samples` from their first frame.
#[derive(Clone, Debug, PartialEq)]
pub struct PlacedRecording {
    pub start_tick: u64,
    /// Stereo, interleaved.
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

impl PlacedRecording {
    pub fn seconds(&self) -> f64 {
        (self.samples.len() / 2) as f64 / f64::from(self.sample_rate)
    }
}

/// Place a recording on the timeline. `samples` are stereo and interleaved,
/// at `sample_rate`, and their first frame reached the input at
/// `first_frame_seconds` on the same clock as `anchor`. `offset_seconds` is
/// the latency the driver doesn't report: how much later than its figures
/// say the recording arrives.
///
/// The recording is cut at the first whole tick it covers, so its Clip
/// needs no file offset, and never before the anchor's tick: what the input
/// caught before the transport started playing is not part of the take.
/// The anchor is the first block played after recording started, so that is
/// where the transport was when Record was pressed. None when nothing is
/// left after the cut.
pub fn place_recording(
    samples: &[f32],
    sample_rate: u32,
    first_frame_seconds: f64,
    anchor: PlaybackAnchor,
    offset_seconds: f64,
) -> Option<PlacedRecording> {
    if sample_rate == 0 || anchor.ticks_per_second <= 0.0 {
        return None;
    }
    let first_tick = anchor.tick_at(first_frame_seconds - offset_seconds);
    let start_tick = first_tick.max(anchor.tick).max(0.0).ceil();
    let skip_seconds = (start_tick - first_tick) / anchor.ticks_per_second;
    let skip = (skip_seconds * f64::from(sample_rate)).round() as usize;
    let rest = samples.get(skip * 2..).filter(|rest| rest.len() >= 2)?;
    Some(PlacedRecording {
        start_tick: start_tick as u64,
        samples: rest.to_vec(),
        sample_rate,
    })
}

/// The loudest sample in `samples`, for an input's level meter.
pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0, |loudest, s| loudest.max(s.abs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;
    /// 120 bpm at 960 ticks a beat.
    const TICKS_PER_SECOND: f64 = 1_920.0;

    /// Stereo silence with a click at `frame`.
    fn click_at(frames: usize, frame: usize) -> Vec<f32> {
        let mut samples = vec![0.0; frames * 2];
        samples[frame * 2] = 1.0;
        samples[frame * 2 + 1] = 1.0;
        samples
    }

    fn first_click(samples: &[f32]) -> usize {
        samples.iter().position(|s| *s > 0.5).unwrap() / 2
    }

    #[test]
    fn a_recording_starts_at_the_tick_its_first_frame_was_captured_on() {
        // Beat 2 (tick 1920) reached the output at 10 s. The recording began
        // at 10.25 s, so on tick 1920 + 480, exactly.
        let anchor = PlaybackAnchor {
            seconds: 10.0,
            tick: 1_920.0,
            ticks_per_second: TICKS_PER_SECOND,
        };
        let samples = click_at(4_800, 10);
        let placed = place_recording(&samples, RATE, 10.25, anchor, 0.0).unwrap();
        assert_eq!(placed.start_tick, 2_400);
        assert_eq!(placed.samples, samples);
    }

    #[test]
    fn a_recording_is_cut_to_start_on_a_whole_tick() {
        let anchor = PlaybackAnchor {
            seconds: 0.0,
            tick: 0.0,
            ticks_per_second: TICKS_PER_SECOND,
        };
        // Captured a quarter of a tick after tick 100: the next whole tick is
        // three quarters of a tick (18.75 frames) later.
        let first = (100.25) / TICKS_PER_SECOND;
        let samples = click_at(4_800, 1_000);
        let placed = place_recording(&samples, RATE, first, anchor, 0.0).unwrap();
        assert_eq!(placed.start_tick, 101);
        assert_eq!(first_click(&placed.samples), 1_000 - 19);
    }

    #[test]
    fn the_offset_moves_a_recording_earlier_by_the_latency_the_driver_left_out() {
        let anchor = PlaybackAnchor {
            seconds: 0.0,
            tick: 0.0,
            ticks_per_second: TICKS_PER_SECOND,
        };
        let samples = click_at(48_000, 0);
        // Captured a second after the anchor, while the song plays.
        let late = place_recording(&samples, RATE, 1.0, anchor, 0.0).unwrap();
        let compensated = place_recording(&samples, RATE, 1.0, anchor, 0.25).unwrap();
        assert_eq!(late.start_tick, 1_920);
        assert_eq!(compensated.start_tick, 1_440);
    }

    #[test]
    fn what_was_captured_before_the_transport_started_is_cut_off() {
        // The transport starts at beat 2 at 1 s; the recording began half a
        // second before, so its first half second is dropped.
        let anchor = PlaybackAnchor {
            seconds: 1.0,
            tick: 1_920.0,
            ticks_per_second: TICKS_PER_SECOND,
        };
        let samples = click_at(48_000, 24_000);
        let placed = place_recording(&samples, RATE, 0.5, anchor, 0.0).unwrap();
        assert_eq!(placed.start_tick, 1_920);
        assert_eq!(first_click(&placed.samples), 0);
        assert_eq!(placed.seconds(), 0.5);
    }

    #[test]
    fn nothing_is_placed_when_nothing_is_left() {
        let anchor = PlaybackAnchor {
            seconds: 1.0,
            tick: 0.0,
            ticks_per_second: TICKS_PER_SECOND,
        };
        assert_eq!(place_recording(&[0.0; 200], RATE, 0.0, anchor, 0.0), None);
        assert_eq!(place_recording(&[], RATE, 1.0, anchor, 0.0), None);
    }

    #[test]
    fn a_placed_recording_saved_as_24_bit_wav_decodes_to_the_same_length() {
        let anchor = PlaybackAnchor {
            seconds: 0.0,
            tick: 0.0,
            ticks_per_second: TICKS_PER_SECOND,
        };
        let placed = place_recording(&click_at(4_800, 100), RATE, 0.0, anchor, 0.0).unwrap();
        let bytes = crate::wav_bytes(&placed.samples, RATE, crate::SampleFormat::Int24);
        let decoded = crate::audio_file::decode(&bytes).unwrap();
        assert_eq!(decoded.frames(), 4_800);
        assert_eq!(decoded.seconds(), placed.seconds());
    }

    #[test]
    fn the_meter_reads_the_loudest_sample_either_side_of_zero() {
        assert_eq!(peak(&[0.1, -0.7, 0.5]), 0.7);
        assert_eq!(peak(&[]), 0.0);
    }
}

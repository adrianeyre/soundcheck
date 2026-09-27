//! Rendering a range offline in steps, so a host exporting the mix can show
//! progress and cancel between them, and can carry on past the range's end
//! while the sound rings out: a Synth's release, a Reverb's tail. Where the
//! range ends the song does: nothing after it starts, scheduled notes are
//! released and Audio Clips stop, as they would if trimmed there.
//!
//! `render_range` is the same render in one go, with no tail, so an export
//! matches it sample for sample.

use wasm_bindgen::prelude::*;

use super::{Engine, OFFLINE_BLOCK};
use crate::transport::LoopRegion;

/// Below this a sample is silence, even in a 16-bit file: under half its
/// smallest step.
const SILENCE: f32 = 1.0 / 65_536.0;
/// The tail ends once it has been silent this long.
const QUIET_SECONDS: f32 = 0.5;
/// The most `render_next` renders in one call, whatever it is asked for.
const MAX_STEP: usize = OFFLINE_BLOCK * 64;

/// An offline render under way.
pub(super) struct Offline {
    /// Frames of the range still to render.
    range_left: usize,
    /// Frames past the range the tail may still run to.
    tail_left: usize,
    /// How many frames in a row the tail has been silent.
    quiet: usize,
    /// Whether the range's end has been reached and the song ended there.
    ended: bool,
    quiet_frames: usize,
    /// The loop, which an offline render ignores, to put back afterwards.
    saved_loop: Option<LoopRegion>,
}

#[wasm_bindgen]
impl Engine {
    /// Start rendering from `start` to `end` ticks offline, ignoring the
    /// loop, then on for up to `tail_seconds` more until the sound has died
    /// away. Returns the range's length in frames, to measure progress by.
    ///
    /// This uses the engine's own Tracks and transport, so a host that is
    /// also playing live gives offline work its own Engine.
    pub fn start_render(&mut self, start: f64, end: f64, tail_seconds: f32) -> usize {
        let saved_loop = match self.offline.take() {
            Some(offline) => offline.saved_loop,
            None => self.transport.loop_region(),
        };
        self.stop();
        self.transport.set_loop(None);
        self.seek(start);
        // A render is offline: live input is never in it.
        for track in &mut self.tracks {
            track.clear_input();
        }
        let end_tick = end.max(start).ceil() as u64;
        let range = (self.transport.frame_of(end_tick) - self.transport.now()) as usize;
        self.play();
        self.offline = Some(Offline {
            range_left: range,
            tail_left: (tail_seconds.max(0.0) * self.sample_rate) as usize,
            quiet: 0,
            ended: false,
            quiet_frames: ((QUIET_SECONDS * self.sample_rate) as usize).max(1),
            saved_loop,
        });
        range
    }

    /// The next frames of the render started by `start_render`, at most
    /// `max_frames` of them, as interleaved stereo. Empty once the render
    /// has finished, when the transport stops and the loop is put back.
    /// How many frames each call asks for makes no difference to the sound.
    pub fn render_next(&mut self, max_frames: usize) -> Vec<f32> {
        let Some(mut offline) = self.offline.take() else {
            return Vec::new();
        };
        let mut wanted = max_frames.clamp(1, MAX_STEP);
        let mut out = Vec::with_capacity(wanted * 2);
        let mut finished = false;

        while wanted > 0 && offline.range_left > 0 {
            let frames = wanted.min(offline.range_left).min(OFFLINE_BLOCK);
            self.render(frames);
            self.push_block(frames, &mut out);
            offline.range_left -= frames;
            wanted -= frames;
        }
        if offline.range_left == 0 && !offline.ended {
            self.end_range();
            offline.ended = true;
        }
        while wanted > 0 && offline.range_left == 0 && !finished {
            if offline.tail_left == 0 {
                finished = true;
                break;
            }
            let frames = wanted.min(offline.tail_left).min(OFFLINE_BLOCK);
            self.render(frames);
            for frame in 0..frames {
                let (l, r) = (self.left[frame], self.right[frame]);
                out.push(l);
                out.push(r);
                offline.tail_left -= 1;
                wanted -= 1;
                if l.abs() < SILENCE && r.abs() < SILENCE {
                    offline.quiet += 1;
                } else {
                    offline.quiet = 0;
                }
                if offline.quiet >= offline.quiet_frames || offline.tail_left == 0 {
                    finished = true;
                    break;
                }
            }
        }

        if finished || (offline.range_left == 0 && offline.tail_left == 0) {
            self.stop();
            self.transport.set_loop(offline.saved_loop);
        } else {
            self.offline = Some(offline);
        }
        out
    }
}

impl Engine {
    /// The song stops where the range does, leaving what is sounding to
    /// ring out into the tail.
    fn end_range(&mut self) {
        self.transport.stop();
        self.tracks
            .iter_mut()
            .for_each(|track| track.end_scheduled());
        self.metronome.silence();
    }

    fn push_block(&self, frames: usize, out: &mut Vec<f32>) {
        for (l, r) in self.left[..frames].iter().zip(&self.right[..frames]) {
            out.push(*l);
            out.push(*r);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::TICKS_PER_BEAT;

    const RATE: f32 = 48_000.0;
    const BEAT: f64 = TICKS_PER_BEAT as f64;

    /// One Synth Track playing one beat-long note, through the Reverb in its
    /// Insert Chain.
    fn song() -> Engine {
        let mut engine = Engine::new(RATE);
        engine.set_track_count(1);
        engine.set_track_notes(0, &[0.0, BEAT, 60.0, 1.0]);
        engine
    }

    fn render_all(engine: &mut Engine, start: f64, end: f64, tail: f32, step: usize) -> Vec<f32> {
        engine.start_render(start, end, tail);
        let mut out = Vec::new();
        loop {
            let chunk = engine.render_next(step);
            if chunk.is_empty() {
                return out;
            }
            out.extend(chunk);
        }
    }

    #[test]
    fn with_no_tail_it_is_render_range_exactly() {
        let expected = song().render_range(BEAT, 5.0 * BEAT);
        for step in [1, 100, 1_024, 5_000, usize::MAX] {
            assert_eq!(
                render_all(&mut song(), BEAT, 5.0 * BEAT, 0.0, step),
                expected
            );
        }
    }

    #[test]
    fn the_range_length_is_reported_in_frames() {
        // 120 BPM at 48 kHz: a beat is 24 000 frames.
        assert_eq!(song().start_render(0.0, 2.0 * BEAT, 0.0), 48_000);
    }

    #[test]
    fn the_tail_carries_on_past_the_range_until_the_sound_dies_away() {
        // The note ends at beat 1; the range stops half a beat into its release.
        let range_end = 1.5 * BEAT;
        let with_tail = render_all(&mut song(), 0.0, range_end, 10.0, 777);
        let range_frames = 36_000 * 2;
        assert!(with_tail.len() > range_frames, "a tail was rendered");
        assert!(
            with_tail.len() < range_frames + 10 * 48_000 * 2,
            "and it stopped early"
        );
        // What was cut off at the range's end still sounds in the tail.
        assert!(
            with_tail[range_frames..range_frames + 200]
                .iter()
                .any(|s| s.abs() > SILENCE)
        );
        // It ends on half a second of silence.
        let quiet = (QUIET_SECONDS * RATE) as usize * 2;
        assert!(
            with_tail[with_tail.len() - quiet..]
                .iter()
                .all(|s| s.abs() < SILENCE)
        );

        // Sample for sample, it is a longer offline render of the same song.
        let longer = song().render_range(0.0, 30.0 * BEAT);
        assert_eq!(with_tail[..], longer[..with_tail.len()]);
    }

    #[test]
    fn nothing_after_the_range_plays_in_the_tail() {
        // A second note half a beat after the range: the first one's release
        // has not been quiet long enough to end the tail by then.
        let mut engine = song();
        engine.set_track_notes(0, &[0.0, BEAT / 4.0, 60.0, 1.0, BEAT, BEAT, 72.0, 1.0]);
        let out = render_all(&mut engine, 0.0, BEAT / 2.0, 10.0, 1_000);
        assert!(out.len() > 12_000 * 2, "a tail was rendered");
        // The second note would start at frame 24,000.
        let from = (24_000 * 2).min(out.len());
        assert!(out[from..].iter().all(|s| s.abs() < SILENCE));
        assert!(out.len() < 24_000 * 2 + (QUIET_SECONDS * RATE) as usize * 2);
    }

    #[test]
    fn the_tail_is_limited() {
        let mut engine = song();
        engine.set_track_notes(0, &[0.0, 20.0 * BEAT, 60.0, 1.0]);
        let out = render_all(&mut engine, 0.0, BEAT, 0.25, 4_096);
        assert_eq!(out.len(), (24_000 + 12_000) * 2);
    }

    #[test]
    fn any_step_size_gives_the_same_tail() {
        let a = render_all(&mut song(), 0.0, 1.5 * BEAT, 10.0, 64);
        let b = render_all(&mut song(), 0.0, 1.5 * BEAT, 10.0, 10_000);
        assert_eq!(a, b);
    }

    #[test]
    fn the_loop_comes_back_afterwards() {
        let mut engine = song();
        engine.set_loop(0.0, BEAT, true);
        render_all(&mut engine, 0.0, 2.0 * BEAT, 1.0, 4_096);
        assert!(engine.transport.loop_region().is_some());
        assert!(!engine.is_playing());
        assert!(engine.render_next(100).is_empty(), "nothing more to render");
    }

    #[test]
    fn exporting_is_faster_than_real_time() {
        let mut engine = Engine::new(RATE);
        engine.set_track_count(8);
        for track in 0..8 {
            let notes: Vec<f64> = (0..120)
                .flat_map(|beat| {
                    [
                        beat as f64 * BEAT,
                        BEAT / 2.0,
                        48.0 + track as f64 * 3.0,
                        0.8,
                    ]
                })
                .collect();
            engine.set_track_notes(track, &notes);
        }
        let started = std::time::Instant::now();
        // 120 beats at 120 BPM: one minute, then the tail.
        let out = render_all(&mut engine, 0.0, 120.0 * BEAT, 10.0, 48_000);
        let elapsed = started.elapsed().as_secs_f64();
        let seconds = out.len() as f64 / 2.0 / f64::from(RATE);
        assert!(seconds >= 60.0);
        assert!(elapsed < seconds, "took {elapsed}s for {seconds}s of audio");
    }
}

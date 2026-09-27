//! Input Monitoring's path from the input callback to the output callback.
//!
//! The input callback pushes each armed Track's left and right (its `Tap`)
//! into a lock-free ring buffer (`MonitorWriter`); the output callback pops
//! them (`MonitorReader`) and hands each Track its block before the engine
//! renders it (`MonitorFeed`), so a monitoring Track plays it through its
//! Insert Chain. The two streams run on their own clocks, so the reader
//! keeps a small cushion of frames queued and never lets it grow:
//!
//! - **The delay** it waits for before playing, its target, is the largest
//!   output callback plus the largest input callback seen so far: just
//!   enough that one input callback arriving late still leaves a whole
//!   output callback queued. At 128-frame buffers at 48 kHz that is 256
//!   frames, 5.3 ms, on top of the driver's own input and output latency.
//! - **Bounded:** once more than twice the target is queued (the input's
//!   clock running fast, or the output stalling), the oldest frames are
//!   dropped back down to the target, so the extra latency never exceeds
//!   twice the target.
//! - **Underrun:** when a callback finds less than it needs queued (the
//!   output's clock running fast, or the input stalling), the whole callback
//!   is silent and the reader waits for the target again. It never plays a
//!   frame twice, so an underrun is a short gap, never a loop.
//!
//! Nothing here allocates or locks once built, and nothing knows about
//! audio devices, so tests drive both ends by hand.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

use rtrb::{Consumer, Producer, RingBuffer};
use soundcheck_engine::Engine;

use crate::host::MAX_BLOCK;

/// How many frames the ring buffer holds: room for the most the reader
/// keeps, twice the target of two of the largest callbacks, with some over.
const CAPACITY_FRAMES: usize = 8 * MAX_BLOCK;

#[derive(Default)]
struct Shared {
    /// The most frames one input callback has pushed.
    writer_block: AtomicUsize,
    /// Output callbacks that found too little queued and were silent.
    underruns: AtomicU32,
}

/// A ring buffer for `taps` stereo taps: the input callback's end and the
/// output callback's.
pub fn monitor(taps: usize) -> (MonitorWriter, MonitorReader) {
    let width = taps.max(1) * 2;
    let (queue, from) = RingBuffer::new(CAPACITY_FRAMES * width);
    let shared = Arc::new(Shared::default());
    (
        MonitorWriter {
            queue,
            width,
            shared: Arc::clone(&shared),
        },
        MonitorReader {
            queue: from,
            width,
            shared,
            largest_read: 0,
            primed: false,
            playing: 0,
        },
    )
}

/// The input callback's end.
pub struct MonitorWriter {
    queue: Producer<f32>,
    width: usize,
    shared: Arc<Shared>,
}

impl MonitorWriter {
    /// At the start of an input callback of `frames` frames.
    pub fn begin(&mut self, frames: usize) {
        self.shared
            .writer_block
            .fetch_max(frames, Ordering::Relaxed);
    }

    /// Whether a whole frame, every tap's left and right, fits. A frame that
    /// doesn't is dropped: the reader isn't keeping up, and drops old frames
    /// itself once it does.
    pub fn has_room(&self) -> bool {
        self.queue.slots() >= self.width
    }

    /// One tap's left and right, in the taps' order. Call `has_room` first
    /// for each frame.
    pub fn push(&mut self, left: f32, right: f32) {
        let _ = self.queue.push(left);
        let _ = self.queue.push(right);
    }
}

/// The output callback's end.
pub struct MonitorReader {
    queue: Consumer<f32>,
    width: usize,
    shared: Arc<Shared>,
    /// The most frames one output callback has asked for.
    largest_read: usize,
    /// Whether the target has been reached since the start or the last
    /// underrun.
    primed: bool,
    /// Frames of this callback still to be played; 0 when it is silent.
    playing: usize,
}

impl MonitorReader {
    /// How many frames it waits for before playing, and drops back to.
    pub fn target(&self) -> usize {
        self.largest_read + self.shared.writer_block.load(Ordering::Relaxed)
    }

    /// Whole frames queued.
    pub fn queued(&self) -> usize {
        self.queue.slots() / self.width
    }

    /// Output callbacks that were silent for want of input.
    pub fn underruns(&self) -> u32 {
        self.shared.underruns.load(Ordering::Relaxed)
    }

    /// At the start of an output callback of `frames` frames: decide
    /// whether it plays input, keeping the delay within its bounds.
    pub fn begin(&mut self, frames: usize) {
        self.largest_read = self.largest_read.max(frames);
        let target = self.target();
        let queued = self.queued();
        self.playing = 0;
        if !self.primed {
            if queued < target.max(frames) {
                return;
            }
            self.primed = true;
        }
        if queued < frames {
            // Too little: silence, and wait for the target again. What is
            // queued is dropped, so nothing is ever played out of order.
            self.shared.underruns.fetch_add(1, Ordering::Relaxed);
            self.primed = false;
            self.skip(queued);
            return;
        }
        if queued > 2 * target {
            self.skip(queued - target.max(frames));
        }
        self.playing = frames;
    }

    /// The next `out.len() / width` frames of this callback, each every
    /// tap's left and right in turn, or silence.
    pub fn read(&mut self, out: &mut [f32]) {
        let frames = out.len() / self.width;
        let playing = frames.min(self.playing);
        let samples = playing * self.width;
        match self.queue.read_chunk(samples) {
            Ok(chunk) => {
                let (first, second) = chunk.as_slices();
                out[..first.len()].copy_from_slice(first);
                out[first.len()..samples].copy_from_slice(second);
                chunk.commit_all();
            }
            // `begin` saw them queued, and only this end takes them away.
            Err(_) => out[..samples].fill(0.0),
        }
        out[samples..].fill(0.0);
        self.playing -= playing;
    }

    fn skip(&mut self, frames: usize) {
        if let Ok(chunk) = self.queue.read_chunk(frames * self.width) {
            chunk.commit_all();
        }
    }
}

/// What the output callback hands the engine each block: every tap's frames
/// to the Track it was armed for. The engine plays them only on a Track
/// whose Input Monitoring is on.
pub struct MonitorFeed {
    reader: MonitorReader,
    /// The engine Track each tap was armed for, in the taps' order.
    tracks: Box<[usize]>,
    frames: Box<[f32]>,
    left: Box<[f32]>,
    right: Box<[f32]>,
}

impl MonitorFeed {
    /// Built off the audio thread: its buffers take a whole block.
    pub fn new(reader: MonitorReader, tracks: Vec<usize>) -> Self {
        let width = reader.width;
        Self {
            reader,
            tracks: tracks.into(),
            frames: vec![0.0; MAX_BLOCK * width].into(),
            left: vec![0.0; MAX_BLOCK].into(),
            right: vec![0.0; MAX_BLOCK].into(),
        }
    }

    pub fn reader(&self) -> &MonitorReader {
        &self.reader
    }

    /// At the start of an output callback of `frames` frames.
    pub fn begin(&mut self, frames: usize) {
        self.reader.begin(frames);
    }

    /// Before the engine renders the next `block` frames of this callback,
    /// at most `MAX_BLOCK`: hand each Track its tap's frames.
    pub fn feed(&mut self, engine: &mut Engine, block: usize) {
        let block = block.min(MAX_BLOCK);
        let width = self.reader.width;
        let frames = &mut self.frames[..block * width];
        self.reader.read(frames);
        for (tap, &track) in self.tracks.iter().enumerate() {
            let (left, right) = (&mut self.left[..block], &mut self.right[..block]);
            for ((frame, l), r) in frames
                .chunks_exact(width)
                .zip(left.iter_mut())
                .zip(right.iter_mut())
            {
                (*l, *r) = (frame[tap * 2], frame[tap * 2 + 1]);
            }
            engine.set_track_input(track, left, right);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Push `frames` frames of one tap, numbered on from `from`, as one
    /// input callback: the left is the frame's number, the right its
    /// negative.
    fn write(writer: &mut MonitorWriter, from: usize, frames: usize) {
        writer.begin(frames);
        for frame in from..from + frames {
            if writer.has_room() {
                writer.push(frame as f32, -(frame as f32));
            }
        }
    }

    /// One output callback of `frames` frames, read in one go.
    fn read(reader: &mut MonitorReader, frames: usize) -> Vec<f32> {
        reader.begin(frames);
        let mut out = vec![f32::NAN; frames * 2];
        reader.read(&mut out);
        out
    }

    fn lefts(out: &[f32]) -> Vec<f32> {
        out.iter().step_by(2).copied().collect()
    }

    #[test]
    fn frames_come_out_in_order_once_the_target_is_queued() {
        let (mut writer, mut reader) = monitor(1);
        write(&mut writer, 0, 128);
        // Not yet the target (128 + 128): silent, and nothing is taken.
        assert!(read(&mut reader, 128).iter().all(|&s| s == 0.0));
        assert_eq!(reader.target(), 256);
        write(&mut writer, 128, 128);
        let mut next = 0.0;
        for callback in 0..50 {
            let out = read(&mut reader, 128);
            for frame in out.as_chunks::<2>().0 {
                assert_eq!(*frame, [next, -next], "callback {callback}");
                next += 1.0;
            }
            write(&mut writer, 256 + callback * 128, 128);
        }
        assert_eq!(reader.underruns(), 0);
    }

    #[test]
    fn the_delay_is_the_target_and_never_more_than_twice_it() {
        let (mut writer, mut reader) = monitor(1);
        // The output stalled while the input ran on: far more is queued than
        // the target.
        for callback in 0..40 {
            write(&mut writer, callback * 128, 128);
        }
        assert!(reader.queued() > 2 * 256);
        let out = read(&mut reader, 128);
        // It plays the newest frames bar the target's worth: the oldest are
        // dropped, and what it plays is still in order.
        let newest = 40 * 128 - 1;
        assert_eq!(lefts(&out)[0], (newest + 1 - 256) as f32);
        assert!(lefts(&out).windows(2).all(|pair| pair[1] == pair[0] + 1.0));
        assert_eq!(reader.queued(), 128);

        // An input running a little fast: the queue creeps up, and is cut
        // back each time it passes twice the target.
        let mut from = 40 * 128;
        for _ in 0..200 {
            write(&mut writer, from, 132);
            from += 132;
            read(&mut reader, 128);
            assert!(reader.queued() <= 2 * reader.target());
        }
        assert_eq!(reader.underruns(), 0);
    }

    #[test]
    fn an_underrun_is_silent_and_never_replays_old_frames() {
        let (mut writer, mut reader) = monitor(1);
        write(&mut writer, 0, 128);
        write(&mut writer, 128, 128);
        assert_eq!(lefts(&read(&mut reader, 128))[0..2], [0.0, 1.0]);
        assert_eq!(lefts(&read(&mut reader, 128))[127], 255.0);
        // The input stalls: nothing is queued, so the callback is silent.
        assert!(read(&mut reader, 128).iter().all(|&s| s == 0.0));
        assert_eq!(reader.underruns(), 1);
        // Half a callback arrives: still silent, since it waits for the
        // target again, rather than playing half and repeating.
        write(&mut writer, 256, 64);
        assert!(read(&mut reader, 128).iter().all(|&s| s == 0.0));
        write(&mut writer, 320, 128);
        write(&mut writer, 448, 128);
        let out = lefts(&read(&mut reader, 128));
        // It carries on with new frames only, in order.
        assert!(out[0] >= 256.0);
        assert!(out.windows(2).all(|pair| pair[1] == pair[0] + 1.0));
    }

    #[test]
    fn a_callback_read_in_blocks_plays_straight_through() {
        let (mut writer, mut reader) = monitor(1);
        for callback in 0..3 {
            write(&mut writer, callback * 256, 256);
        }
        reader.begin(300);
        let mut out = vec![0.0; 300 * 2];
        let (first, second) = out.split_at_mut(200 * 2);
        reader.read(first);
        reader.read(second);
        assert!(lefts(&out).iter().enumerate().all(|(i, &s)| s == i as f32));
        // A block past what `begin` was told of is silent.
        let mut more = vec![1.0; 20];
        reader.read(&mut more);
        assert!(more.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn a_feed_hands_each_track_its_own_tap() {
        let (mut writer, reader) = monitor(2);
        writer.begin(256);
        for frame in 0..512 {
            assert!(writer.has_room());
            writer.push(0.25, 0.25);
            writer.push(frame as f32 / 1_000.0, 0.0);
        }
        let mut engine = Engine::new(48_000.0);
        engine.prepare(MAX_BLOCK);
        engine.set_track_count(2);
        for track in 0..2 {
            engine.set_track_audio(track, true);
        }
        // Tap 0 was armed for Track 1 and tap 1 for Track 0; only Track 1
        // monitors, so only tap 0 is heard.
        engine.set_track_monitoring(1, true);
        let mut feed = MonitorFeed::new(reader, vec![1, 0]);
        feed.begin(128);
        feed.feed(&mut engine, 128);
        engine.render(128);
        let expected = 0.25 * 0.5 / 2f32.sqrt();
        assert!(
            engine.left()[..128]
                .iter()
                .all(|&s| (s - expected).abs() < 1e-6)
        );
        assert!(engine.track_peak(0) == 0.0 && engine.track_peak(1) > 0.0);
    }
}

//! Recording an audio input onto an Audio Track, between the input device's
//! callback and the output's.
//!
//! The input callback hands its frames to a `CaptureWriter`, which takes
//! each armed Track's channels out of them (its `Tap`), meters them and,
//! while recording, queues them lock-free for the `Recorder` to collect off
//! the audio threads. One input stream feeds every Track armed on its
//! device, so their takes start on the same frame. The output callback tells the Renderer
//! when each block will be heard, and the Renderer publishes one of those
//! moments, with the transport position, on the `PlaybackClock`. Both sides
//! time themselves on `host_seconds`, corrected by the latency the driver
//! reports for each stream (cpal's own instants aren't guaranteed to share a
//! clock across streams), and the engine places the take from the two
//! (`place_recording`). Nothing here knows about audio devices, so tests
//! drive it with made-up timings.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Instant;

use crate::monitor::MonitorWriter;
use rtrb::{Consumer, Producer, RingBuffer};
use serde::Deserialize;
use soundcheck_engine::{PlacedRecording, PlaybackAnchor, place_recording};

/// Seconds of input the queue holds between collections. The `Recorder` is
/// collected every few milliseconds, so this is room for a stalled thread.
const QUEUE_SECONDS: usize = 2;

/// Which of the input's channels one armed Track records, numbered from 0.
/// A take is always stereo: a mono channel is copied to both sides.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(try_from = "Option<Vec<usize>>")]
pub enum Tap {
    /// The first two channels, or the only one copied to both sides: what a
    /// Track records when its Input names no channels.
    FirstTwo,
    Mono(usize),
    /// A left and a right channel.
    Stereo(usize, usize),
}

impl Tap {
    /// The highest channel it reads, which the device must have.
    pub fn highest(self) -> usize {
        match self {
            Tap::FirstTwo => 0,
            Tap::Mono(channel) => channel,
            Tap::Stereo(left, right) => left.max(right),
        }
    }

    /// Its left and right from one interleaved frame. A channel the frame
    /// doesn't have is silent.
    fn read<T: Copy>(self, frame: &[T], convert: &impl Fn(T) -> f32) -> (f32, f32) {
        let channel = |index: usize| frame.get(index).map_or(0.0, |s| convert(*s));
        match self {
            Tap::FirstTwo => {
                let left = channel(0);
                (left, frame.get(1).map_or(left, |s| convert(*s)))
            }
            Tap::Mono(index) => {
                let sample = channel(index);
                (sample, sample)
            }
            Tap::Stereo(left, right) => (channel(left), channel(right)),
        }
    }
}

/// The UI's form: no channels for the first two, one for mono, or a pair.
impl TryFrom<Option<Vec<usize>>> for Tap {
    type Error = String;

    fn try_from(channels: Option<Vec<usize>>) -> Result<Self, Self::Error> {
        match channels.as_deref() {
            None => Ok(Tap::FirstTwo),
            Some(&[channel]) => Ok(Tap::Mono(channel)),
            Some(&[left, right]) => Ok(Tap::Stereo(left, right)),
            Some(_) => Err("A Track records one channel or a pair".into()),
        }
    }
}

/// Seconds since the app first asked: the one clock both streams' callbacks
/// time themselves on.
pub fn host_seconds() -> f64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64()
}

fn store(slot: &AtomicU64, value: f64) {
    slot.store(value.to_bits(), Ordering::Relaxed);
}

fn load(slot: &AtomicU64) -> f64 {
    f64::from_bits(slot.load(Ordering::Relaxed))
}

/// When the output was heard, and where the transport was then: written
/// once per recording by the audio thread, read by the `Recorder`.
#[derive(Default)]
pub struct PlaybackClock {
    wanted: AtomicBool,
    ready: AtomicBool,
    seconds: AtomicU64,
    tick: AtomicU64,
    ticks_per_second: AtomicU64,
}

impl PlaybackClock {
    /// Ask for the next block the transport plays.
    pub fn want(&self) {
        self.ready.store(false, Ordering::Relaxed);
        self.wanted.store(true, Ordering::Release);
    }

    /// On the audio thread: a block whose first frame is heard at `seconds`
    /// is at `tick`. Kept if one is wanted. Takes no locks.
    pub fn offer(&self, seconds: f64, tick: f64, ticks_per_second: f64) {
        if !self.wanted.load(Ordering::Acquire) {
            return;
        }
        store(&self.seconds, seconds);
        store(&self.tick, tick);
        store(&self.ticks_per_second, ticks_per_second);
        self.wanted.store(false, Ordering::Relaxed);
        self.ready.store(true, Ordering::Release);
    }

    /// The block the transport played since `want`, if it has played one.
    pub fn anchor(&self) -> Option<PlaybackAnchor> {
        self.ready.load(Ordering::Acquire).then(|| PlaybackAnchor {
            seconds: load(&self.seconds),
            tick: load(&self.tick),
            ticks_per_second: load(&self.ticks_per_second),
        })
    }
}

/// What the input callback and the `Recorder` share.
#[derive(Default)]
struct Shared {
    recording: AtomicBool,
    /// Whether `first_seconds` is this recording's yet.
    started: AtomicBool,
    first_seconds: AtomicU64,
    /// Frames that didn't fit in the queue.
    dropped: AtomicU64,
    /// Each tap's loudest sample since its meter was last read, as `f32` bits.
    peaks: Box<[AtomicU32]>,
}

/// The input callback's end: meters every frame of every tap, and queues
/// them while recording. Allocates nothing and takes no locks.
pub struct CaptureWriter {
    shared: Arc<Shared>,
    taps: Box<[Tap]>,
    /// A frame is each tap's left and right in turn.
    frames: Producer<f32>,
    /// Where every frame also goes, recording or not, for Input Monitoring.
    monitor: Option<MonitorWriter>,
}

impl CaptureWriter {
    /// Also hand every frame, recording or not, to `monitor`.
    pub fn set_monitor(&mut self, monitor: MonitorWriter) {
        self.monitor = Some(monitor);
    }

    /// Take one callback's `data`, interleaved with `channels` channels,
    /// whose first frame reached the input at `captured_at` (`host_seconds`).
    pub fn write<T: Copy>(
        &mut self,
        data: &[T],
        channels: usize,
        captured_at: f64,
        convert: impl Fn(T) -> f32,
    ) {
        let channels = channels.max(1);
        let recording = self.shared.recording.load(Ordering::Acquire);
        if recording && !self.shared.started.load(Ordering::Relaxed) {
            store(&self.shared.first_seconds, captured_at);
            self.shared.started.store(true, Ordering::Release);
        }
        let width = self.taps.len() * 2;
        let mut dropped = 0;
        if let Some(monitor) = &mut self.monitor {
            monitor.begin(data.len() / channels);
        }
        for frame in data.chunks_exact(channels) {
            let room = recording && self.frames.slots() >= width;
            let mut monitor = self.monitor.as_mut().filter(|monitor| monitor.has_room());
            if recording && !room {
                dropped += 1;
            }
            for (tap, peak) in self.taps.iter().zip(&self.shared.peaks) {
                let (left, right) = tap.read(frame, &convert);
                // Positive floats order as their bits do.
                peak.fetch_max(left.abs().max(right.abs()).to_bits(), Ordering::Relaxed);
                if room {
                    // Room was checked, so neither push fails.
                    let _ = self.frames.push(left);
                    let _ = self.frames.push(right);
                }
                // The dry input, the same as is recorded: the engine adds
                // the Track's Effects to what it hears, never to the take.
                if let Some(monitor) = &mut monitor {
                    monitor.push(left, right);
                }
            }
        }
        if dropped > 0 {
            self.shared.dropped.fetch_add(dropped, Ordering::Relaxed);
        }
    }
}

/// The frames collected so far, and the queue they come from.
struct Take {
    queue: Consumer<f32>,
    samples: Vec<f32>,
}

impl Take {
    fn collect(&mut self) {
        let waiting = self.queue.slots();
        if let Ok(chunk) = self.queue.read_chunk(waiting) {
            self.samples.extend(chunk);
        }
    }
}

/// The control side of recording: starts and stops a take on every tap,
/// collects their frames off the audio threads, and reads the meters.
pub struct Recorder {
    shared: Arc<Shared>,
    take: Mutex<Take>,
    sample_rate: u32,
    taps: usize,
}

/// A Recorder for an input at `sample_rate` with one take per tap, in
/// `taps`' order, and the writer for its callback.
pub fn recorder(sample_rate: u32, taps: &[Tap]) -> (Recorder, CaptureWriter) {
    let shared = Arc::new(Shared {
        peaks: taps.iter().map(|_| AtomicU32::new(0)).collect(),
        ..Shared::default()
    });
    let width = taps.len() * 2;
    let (frames, queue) = RingBuffer::new(sample_rate as usize * width * QUEUE_SECONDS);
    let recorder = Recorder {
        shared: Arc::clone(&shared),
        take: Mutex::new(Take {
            queue,
            samples: Vec::new(),
        }),
        sample_rate,
        taps: taps.len(),
    };
    let writer = CaptureWriter {
        shared,
        taps: taps.into(),
        frames,
        monitor: None,
    };
    (recorder, writer)
}

impl Recorder {
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn is_recording(&self) -> bool {
        self.shared.recording.load(Ordering::Acquire)
    }

    /// Start a take from the next frame captured, timed against the next
    /// block `clock` sees played.
    pub fn start(&self, clock: &PlaybackClock) {
        let mut take = self.take.lock().unwrap_or_else(PoisonError::into_inner);
        // Anything still queued is from before this take.
        take.collect();
        take.samples = Vec::new();
        self.shared.started.store(false, Ordering::Relaxed);
        self.shared.dropped.store(0, Ordering::Relaxed);
        clock.want();
        self.shared.recording.store(true, Ordering::Release);
    }

    /// Move what the input has queued into the take. Called every few
    /// milliseconds while the input is open.
    pub fn collect(&self) {
        self.take
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .collect();
    }

    /// Stop, and place each tap's take on the timeline against `clock`, in
    /// the taps' order. `offset_seconds` is the latency the driver doesn't
    /// report. Empty when nothing was recorded; an error when the takes can't
    /// be placed or have a gap. They all start on the same frame.
    pub fn stop(
        &self,
        clock: &PlaybackClock,
        offset_seconds: f64,
    ) -> Result<Vec<PlacedRecording>, String> {
        let was_recording = self.shared.recording.swap(false, Ordering::AcqRel);
        let mut take = self.take.lock().unwrap_or_else(PoisonError::into_inner);
        take.collect();
        let samples = std::mem::take(&mut take.samples);
        if !was_recording || samples.is_empty() {
            return Ok(Vec::new());
        }
        let dropped = self.shared.dropped.load(Ordering::Relaxed);
        if dropped > 0 {
            return Err(format!(
                "The recording lost {dropped} frames and was thrown away"
            ));
        }
        let anchor = clock
            .anchor()
            .ok_or("The song never played while recording, so the take has nowhere to go")?;
        let first = load(&self.shared.first_seconds);
        let width = self.taps * 2;
        // Every tap is cut on the same frame, so they are placed or not together.
        Ok((0..self.taps)
            .map(|tap| {
                let stereo: Vec<f32> = samples
                    .chunks_exact(width)
                    .flat_map(|frame| [frame[tap * 2], frame[tap * 2 + 1]])
                    .collect();
                place_recording(&stereo, self.sample_rate, first, anchor, offset_seconds)
            })
            .collect::<Option<_>>()
            .unwrap_or_default())
    }

    /// Each tap's loudest sample since the last reading, 0 to 1 (more if
    /// the input clips), for its Track's level meter.
    pub fn take_peaks(&self) -> Vec<f32> {
        self.shared
            .peaks
            .iter()
            .map(|peak| f32::from_bits(peak.swap(0, Ordering::Relaxed)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Eight channels interleaved, `frames` long, where channel `c` of frame
    /// `f` is `c + f / 100` (channels numbered from 1, as on the interface).
    fn eight_channels(frames: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|f| (1..=8).map(move |c| c as f32 + f as f32 / 100.0))
            .collect()
    }

    /// Record `data` onto `taps` from one callback and return the takes.
    fn record(taps: &[Tap], data: &[f32], channels: usize) -> Vec<PlacedRecording> {
        let clock = PlaybackClock::default();
        let (recorder, mut writer) = recorder(1_000, taps);
        recorder.start(&clock);
        clock.offer(1.0, 0.0, 1_000.0);
        writer.write(data, channels, 1.0, |s| s);
        recorder.stop(&clock, 0.0).unwrap()
    }

    #[test]
    fn the_meter_reads_the_loudest_sample_since_it_was_last_read() {
        let (recorder, mut writer) = recorder(48_000, &[Tap::FirstTwo]);
        writer.write(&[0.2_f32, -0.6, 0.1, 0.3], 2, 0.0, |s| s);
        writer.write(&[0.4_f32], 1, 0.1, |s| s);
        assert_eq!(recorder.take_peaks(), [0.6]);
        assert_eq!(recorder.take_peaks(), [0.0]);
    }

    #[test]
    fn each_tap_meters_only_its_own_channels() {
        let (recorder, mut writer) = recorder(48_000, &[Tap::Mono(0), Tap::Stereo(2, 3)]);
        writer.write(&[0.1_f32, 0.9, -0.3, 0.2], 4, 0.0, |s| s);
        assert_eq!(recorder.take_peaks(), [0.1, 0.3]);
    }

    #[test]
    fn only_what_arrives_while_recording_is_kept_and_mono_goes_to_both_sides() {
        let clock = PlaybackClock::default();
        let (recorder, mut writer) = recorder(1_000, &[Tap::FirstTwo]);
        writer.write(&[0.9_f32; 4], 1, 0.0, |s| s);

        recorder.start(&clock);
        clock.offer(1.0, 0.0, 1_000.0);
        writer.write(&[0.1_f32, 0.2, 0.3], 1, 1.0, |s| s);
        recorder.collect();
        writer.write(&[0.4_f32], 1, 1.003, |s| s);
        let takes = recorder.stop(&clock, 0.0).unwrap();
        writer.write(&[0.9_f32; 4], 1, 2.0, |s| s);

        let [take] = takes.as_slice() else {
            panic!("one take, got {takes:?}")
        };
        assert_eq!(take.start_tick, 0);
        assert_eq!(take.samples, [0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4]);
        assert!(!recorder.is_recording());
        assert_eq!(recorder.stop(&clock, 0.0), Ok(Vec::new()));
    }

    #[test]
    fn with_no_channels_chosen_the_first_two_of_many_are_kept() {
        let takes = record(&[Tap::FirstTwo], &eight_channels(2), 8);
        assert_eq!(takes[0].samples, [1.0, 2.0, 1.01, 2.01]);
    }

    #[test]
    fn channel_5_of_8_alone_is_recorded_on_both_sides() {
        let takes = record(&[Tap::Mono(4)], &eight_channels(3), 8);
        assert_eq!(takes.len(), 1);
        assert_eq!(takes[0].samples, [5.0, 5.0, 5.01, 5.01, 5.02, 5.02]);
    }

    #[test]
    fn the_pair_3_4_of_8_is_recorded_as_left_and_right() {
        let takes = record(&[Tap::Stereo(2, 3)], &eight_channels(3), 8);
        assert_eq!(takes.len(), 1);
        assert_eq!(takes[0].samples, [3.0, 4.0, 3.01, 4.01, 3.02, 4.02]);
    }

    #[test]
    fn two_tracks_on_different_channels_record_together_from_one_callback() {
        let takes = record(&[Tap::Mono(4), Tap::Stereo(2, 3)], &eight_channels(3), 8);
        assert_eq!(takes.len(), 2);
        assert_eq!(takes[0].samples, [5.0, 5.0, 5.01, 5.01, 5.02, 5.02]);
        assert_eq!(takes[1].samples, [3.0, 4.0, 3.01, 4.01, 3.02, 4.02]);
        assert_eq!(takes[0].start_tick, takes[1].start_tick);
    }

    #[test]
    fn the_ui_names_no_channels_one_or_a_pair() {
        let tap = |json: &str| serde_json::from_str::<Tap>(json);
        assert_eq!(tap("null").unwrap(), Tap::FirstTwo);
        assert_eq!(tap("[4]").unwrap(), Tap::Mono(4));
        assert_eq!(tap("[2, 3]").unwrap(), Tap::Stereo(2, 3));
        assert!(tap("[1, 2, 3]").is_err());
        assert!(tap("[]").is_err());
    }

    #[test]
    fn the_clock_keeps_the_first_block_played_after_it_is_asked() {
        let clock = PlaybackClock::default();
        clock.offer(1.0, 10.0, 1.0);
        assert_eq!(clock.anchor(), None);
        clock.want();
        clock.offer(2.0, 20.0, 1_920.0);
        clock.offer(3.0, 30.0, 1_920.0);
        assert_eq!(
            clock.anchor(),
            Some(PlaybackAnchor {
                seconds: 2.0,
                tick: 20.0,
                ticks_per_second: 1_920.0
            })
        );
    }

    #[test]
    fn a_take_with_a_gap_or_without_the_song_playing_is_refused() {
        let clock = PlaybackClock::default();
        let (recorder, mut writer) = recorder(1, &[Tap::FirstTwo]);
        recorder.start(&clock);
        writer.write(&[0.5_f32; 8], 1, 0.0, |s| s);
        assert!(
            recorder
                .stop(&clock, 0.0)
                .unwrap_err()
                .contains("lost 6 frames")
        );

        recorder.start(&clock);
        writer.write(&[0.5_f32], 1, 0.0, |s| s);
        assert!(
            recorder
                .stop(&clock, 0.0)
                .unwrap_err()
                .contains("never played")
        );
    }
}

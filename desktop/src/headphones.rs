//! The Mixing page's headphone cue on a second audio device (ADR 0013): the
//! DJ hears what is coming up in their headphones while the Master plays out
//! of the main output.
//!
//! The main output's audio thread pushes the engine's headphone mix,
//! interleaved stereo, into a lock-free ring (`rtrb`, one producer and one
//! consumer). The headphone device's own audio thread takes it out through a
//! `DriftReader`, which reads it at the ratio of the two devices' rates and
//! nudges that ratio by how full the ring is, so two clocks that never quite
//! agree neither run the ring dry nor fill it: the reader keeps it about
//! `TARGET_SECONDS` full. Neither thread locks or allocates. A device that
//! goes away is marked failed by its error callback, which the UI reads.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, FromSample, SizedSample, Stream, StreamConfig};
use rtrb::{Consumer, Producer, RingBuffer};
use serde::Serialize;

use crate::audio::{best_config, host_named, with_sample_type};

/// The ring's size: a second of stereo at the engine's rate is far more
/// than either device's buffer.
const RING_SECONDS: f64 = 1.0;
/// How full the reader keeps the ring: enough to ride out both devices'
/// callbacks landing at their worst, little enough not to be heard late.
pub const TARGET_SECONDS: f64 = 0.04;
/// The most the reader speeds up or slows down to hold the target: 0.5%,
/// far below what an ear hears as a change of pitch.
const MAX_CORRECTION: f64 = 0.005;
/// How quickly the correction follows the fill, per frame.
const SMOOTHING: f64 = 0.0005;

/// The ring's two ends, sized for `engine_rate`.
pub fn ring(engine_rate: f32) -> (Producer<f32>, Consumer<f32>) {
    RingBuffer::new((f64::from(engine_rate) * RING_SECONDS) as usize * 2)
}

/// Reads stereo frames out of the ring at the headphone device's rate.
#[derive(Debug)]
pub struct DriftReader {
    consumer: Consumer<f32>,
    /// Engine frames per device frame, before the correction.
    ratio: f64,
    /// Frames of the ring the reader aims to keep.
    target: f64,
    correction: f64,
    /// The two frames the output is between, and how far between.
    previous: (f32, f32),
    next: (f32, f32),
    phase: f64,
    /// Waiting for the ring to fill to the target before playing, as at the
    /// start and after running dry.
    priming: bool,
}

impl DriftReader {
    pub fn new(consumer: Consumer<f32>, engine_rate: f32, device_rate: u32) -> Self {
        Self {
            consumer,
            ratio: f64::from(engine_rate) / f64::from(device_rate.max(1)),
            target: TARGET_SECONDS * f64::from(engine_rate),
            correction: 0.0,
            previous: (0.0, 0.0),
            next: (0.0, 0.0),
            phase: 0.0,
            priming: true,
        }
    }

    /// Frames waiting in the ring.
    pub fn buffered(&self) -> usize {
        self.consumer.slots() / 2
    }

    /// The speed-up the reader is applying now: 0.001 reads 0.1% fast.
    pub fn correction(&self) -> f64 {
        self.correction
    }

    fn pop_frame(&mut self) -> Option<(f32, f32)> {
        if self.consumer.slots() < 2 {
            return None;
        }
        let left = self.consumer.pop().ok()?;
        let right = self.consumer.pop().ok()?;
        Some((left, right))
    }

    /// The next frame at the device's rate. Silence while the ring primes
    /// or has run dry. Allocates nothing.
    pub fn next_frame(&mut self) -> (f32, f32) {
        let buffered = self.buffered() as f64;
        if self.priming {
            if buffered < self.target {
                return (0.0, 0.0);
            }
            self.priming = false;
        }
        // Fuller than the target, read a little faster; emptier, slower.
        let error = ((buffered - self.target) / self.target).clamp(-1.0, 1.0);
        self.correction += (error * MAX_CORRECTION - self.correction) * SMOOTHING;
        self.phase += self.ratio * (1.0 + self.correction);
        while self.phase >= 1.0 {
            self.phase -= 1.0;
            match self.pop_frame() {
                Some(frame) => {
                    self.previous = self.next;
                    self.next = frame;
                }
                None => {
                    // Run dry: wait for it to fill again.
                    self.priming = true;
                    self.previous = (0.0, 0.0);
                    self.next = (0.0, 0.0);
                    self.phase = 0.0;
                    return (0.0, 0.0);
                }
            }
        }
        let t = self.phase as f32;
        (
            self.previous.0 + (self.next.0 - self.previous.0) * t,
            self.previous.1 + (self.next.1 - self.previous.1) * t,
        )
    }

    /// Fill `out`, interleaved with `channels` channels: the cue on the
    /// first two, silence on any others, both sides mixed on a mono device.
    pub fn fill<T: Copy>(&mut self, out: &mut [T], channels: usize, convert: impl Fn(f32) -> T) {
        let channels = channels.max(1);
        for frame in out.chunks_exact_mut(channels) {
            let (l, r) = self.next_frame();
            if channels == 1 {
                frame[0] = convert(0.5 * (l + r));
            } else {
                frame[0] = convert(l);
                frame[1] = convert(r);
                frame[2..].fill(convert(0.0));
            }
        }
    }
}

/// An output device headphones can be on.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HeadphoneDevice {
    /// Its name, which is how it is chosen again.
    pub id: String,
    pub label: String,
}

/// The output devices on `host`, the default first.
pub fn devices(host: Option<&str>) -> Result<Vec<HeadphoneDevice>, String> {
    let host = host_named(host)?;
    let default = host
        .default_output_device()
        .and_then(|device| device.description().ok().map(|d| d.name().to_string()));
    let mut names: Vec<String> = host
        .output_devices()
        .map_err(|e| e.to_string())?
        .filter_map(|device| device.description().ok().map(|d| d.name().to_string()))
        .collect();
    names.dedup();
    names.sort_by_key(|name| Some(name) != default.as_ref());
    Ok(names
        .into_iter()
        .map(|name| HeadphoneDevice {
            label: if Some(&name) == default.as_ref() {
                format!("{name} (default)")
            } else {
                name.clone()
            },
            id: name,
        })
        .collect())
}

/// What the headphone output is doing, as the UI shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadphoneStatus {
    pub device: Option<String>,
    pub sample_rate: Option<u32>,
    /// Why it stopped: the device went away, or failed.
    pub failed: Option<String>,
}

/// The headphone device's stream, while it plays.
pub struct HeadphoneStream {
    // Dropping the stream stops it.
    _stream: Stream,
    pub device: String,
    pub sample_rate: u32,
    failed: Arc<AtomicBool>,
}

impl HeadphoneStream {
    pub fn status(&self) -> HeadphoneStatus {
        HeadphoneStatus {
            device: Some(self.device.clone()),
            sample_rate: Some(self.sample_rate),
            failed: self
                .failed
                .load(Relaxed)
                .then(|| format!("{} stopped: it may have been unplugged", self.device)),
        }
    }
}

/// Open the output device called `device` on `host` and play what the ring
/// brings, read at the engine's `engine_rate`. The device runs at the
/// engine's rate where it can, and at its own otherwise.
pub fn open(
    host: Option<&str>,
    device: &str,
    engine_rate: f32,
    consumer: Consumer<f32>,
) -> Result<HeadphoneStream, String> {
    let cpal_host = host_named(host)?;
    let chosen = cpal_host
        .output_devices()
        .map_err(|e| e.to_string())?
        .find(|candidate| candidate.description().is_ok_and(|d| d.name() == device))
        .ok_or_else(|| format!("{device} isn't connected"))?;
    let supported = match best_config(
        chosen
            .supported_output_configs()
            .map_err(|e| e.to_string())?,
        engine_rate as u32,
    ) {
        Some(config) => config,
        None => chosen.default_output_config().map_err(|e| e.to_string())?,
    };
    let config = StreamConfig {
        channels: supported.channels(),
        sample_rate: supported.sample_rate(),
        buffer_size: BufferSize::Default,
    };
    let failed = Arc::new(AtomicBool::new(false));
    let reader = DriftReader::new(consumer, engine_rate, config.sample_rate);
    let stream = with_sample_type!(supported.sample_format(), T => build::<T>(&chosen, &config, reader, Arc::clone(&failed)))?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(HeadphoneStream {
        _stream: stream,
        device: device.to_string(),
        sample_rate: config.sample_rate,
        failed,
    })
}

fn build<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut reader: DriftReader,
    failed: Arc<AtomicBool>,
) -> Result<Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = usize::from(config.channels);
    device
        .build_output_stream(
            *config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                reader.fill(data, channels, T::from_sample)
            },
            move |error| {
                eprintln!("Headphone output error: {error}");
                failed.store(true, Relaxed);
            },
            None,
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    /// Push `frames` frames of a ramp into the ring, going on from `from`.
    fn push(producer: &mut Producer<f32>, from: usize, frames: usize) -> usize {
        for i in from..from + frames {
            let value = (i % 1_000) as f32 / 1_000.0;
            if producer.push(value).is_err() || producer.push(-value).is_err() {
                break;
            }
        }
        from + frames
    }

    #[test]
    fn it_waits_for_the_ring_to_prime_then_plays_what_came_in_order() {
        let (mut producer, consumer) = ring(RATE);
        let mut reader = DriftReader::new(consumer, RATE, 48_000);
        push(&mut producer, 0, 100);
        assert_eq!(reader.next_frame(), (0.0, 0.0), "not primed yet");
        push(&mut producer, 100, 4_000);
        let played: Vec<(f32, f32)> = (0..50).map(|_| reader.next_frame()).collect();
        assert!(
            played.iter().all(|(l, r)| (*l + *r).abs() < 1e-6),
            "right is left inverted"
        );
        assert!(played.windows(2).all(|w| w[1].0 >= w[0].0), "in order");
    }

    #[test]
    fn a_device_at_another_rate_is_read_at_the_ratio() {
        // The engine at 48 kHz, the headphones at 44.1: 48,000 frames in
        // make 44,100 out, give or take the correction.
        let (mut producer, consumer) = ring(RATE);
        let mut reader = DriftReader::new(consumer, RATE, 44_100);
        push(&mut producer, 0, 20_000);
        let before = reader.buffered();
        for _ in 0..10_000 {
            reader.next_frame();
        }
        let taken = (before - reader.buffered()) as f64;
        assert!(
            (taken / 10_000.0 - 48_000.0 / 44_100.0).abs() < 0.01,
            "{taken}"
        );
    }

    #[test]
    fn clocks_that_drift_are_held_at_the_target_fill() {
        // The main output runs 0.3% fast against the headphones: each
        // device-second the ring would gain 144 frames without correction.
        let (mut producer, consumer) = ring(RATE);
        let mut reader = DriftReader::new(consumer, RATE, 48_000);
        let mut written = 0;
        let mut carry = 0.0;
        for _ in 0..(20 * 48_000 / 480) {
            carry += 480.0 * 1.003;
            let frames = carry as usize;
            carry -= frames as f64;
            written = push(&mut producer, written, frames);
            for _ in 0..480 {
                reader.next_frame();
            }
        }
        let target = TARGET_SECONDS * f64::from(RATE);
        let fill = reader.buffered() as f64;
        assert!(
            (fill - target).abs() < target * 0.5,
            "{fill} against {target}"
        );
        assert!(
            reader.correction() > 0.001,
            "it reads faster: {}",
            reader.correction()
        );
    }

    #[test]
    fn running_dry_is_silence_until_it_primes_again() {
        let (mut producer, consumer) = ring(RATE);
        let mut reader = DriftReader::new(consumer, RATE, 48_000);
        push(&mut producer, 0, 2_000);
        for _ in 0..2_100 {
            reader.next_frame();
        }
        assert_eq!(reader.next_frame(), (0.0, 0.0));
        push(&mut producer, 2_000, 100);
        assert_eq!(reader.next_frame(), (0.0, 0.0), "priming again");
    }

    #[test]
    fn a_mono_device_hears_both_sides_and_extra_channels_are_silent() {
        let (mut producer, consumer) = ring(RATE);
        let mut reader = DriftReader::new(consumer, RATE, 48_000);
        for _ in 0..4_000 {
            producer.push(0.5).unwrap();
            producer.push(0.25).unwrap();
        }
        let mut mono = [0.0f32; 8];
        reader.fill(&mut mono, 1, |s| s);
        assert!((mono[7] - 0.375).abs() < 1e-6);
        let mut quad = [9.0f32; 8];
        reader.fill(&mut quad, 4, |s| s);
        assert_eq!(quad[4..], [0.5, 0.25, 0.0, 0.0]);
    }
}

//! The Mixer page's timecode vinyl, for a **DVS** (ADR 0013): a Deck in REL
//! or ABS reads its turntable's control record from a stereo pair of an
//! audio input, as a DJ interface's phono inputs carry it.
//!
//! The DJ picks, for each Deck, an input device and a pair of its channels
//! (inputs 1-2 for Deck 1 and 3-4 for Deck 2 on a four-input interface).
//! Decks on one device share one cpal input stream, at the engine's rate.
//! Its callback pushes each Deck's pair, frame by frame, into a lock-free
//! ring, the one Input Monitoring uses (`monitor.rs`), which keeps a small
//! cushion between the two devices' clocks. The output callback pops them
//! and hands each Deck its block before the engine renders it
//! (`TimecodeFeed`), and the engine's decoder reads it there, sample by
//! sample. Neither audio thread locks or allocates; the feed comes and goes
//! as a prepared command, and the old one is dropped off the audio thread.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample, Stream, StreamConfig};
use serde::{Deserialize, Serialize};
use soundcheck_engine::{DECKS, Engine};

use crate::audio::{best_config, host_named, with_sample_type};
use crate::host::MAX_BLOCK;
use crate::monitor::{self, MonitorReader, MonitorWriter};

/// Which input a Deck's control record comes in on. Mirrors
/// `TimecodeChoice` in `app/src/dj/timecode-input.ts`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimecodeChoice {
    /// The Deck, from 0.
    pub deck: usize,
    /// The input device, by name.
    pub device: String,
    /// The pair's left and right, as input channels counted from 0.
    pub left: u16,
    pub right: u16,
}

/// What the timecode inputs are doing, as the UI shows it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimecodeStatus {
    pub choices: Vec<TimecodeChoice>,
    /// The devices open now.
    pub running: Vec<String>,
    /// Why a device couldn't be opened, or stopped.
    pub failed: Option<String>,
}

/// One device's Decks, as the output callback reads them.
struct DeviceFeed {
    reader: MonitorReader,
    /// The Deck each of its pairs is for, in the order they are pushed.
    decks: Box<[usize]>,
}

/// What the output callback hands the engine each block: every chosen
/// Deck's pair of its device's input.
pub struct TimecodeFeed {
    devices: Box<[DeviceFeed]>,
    frames: Box<[f32]>,
    left: Box<[f32]>,
    right: Box<[f32]>,
}

impl TimecodeFeed {
    /// Built off the audio thread: its buffers take a whole block of the
    /// widest device.
    pub fn new(devices: Vec<(MonitorReader, Vec<usize>)>) -> Self {
        let widest = devices
            .iter()
            .map(|(_, decks)| decks.len() * 2)
            .max()
            .unwrap_or(2);
        Self {
            devices: devices
                .into_iter()
                .map(|(reader, decks)| DeviceFeed {
                    reader,
                    decks: decks.into(),
                })
                .collect(),
            frames: vec![0.0; MAX_BLOCK * widest].into(),
            left: vec![0.0; MAX_BLOCK].into(),
            right: vec![0.0; MAX_BLOCK].into(),
        }
    }

    /// At the start of an output callback of `frames` frames.
    pub fn begin(&mut self, frames: usize) {
        for device in &mut self.devices {
            device.reader.begin(frames);
        }
    }

    /// Before the engine renders the next `block` frames of this callback,
    /// at most `MAX_BLOCK`: hand each Deck its pair.
    pub fn feed(&mut self, engine: &mut Engine, block: usize) {
        let block = block.min(MAX_BLOCK);
        let Self {
            devices,
            frames,
            left,
            right,
        } = self;
        for device in devices.iter_mut() {
            let width = device.decks.len() * 2;
            let frames = &mut frames[..block * width];
            device.reader.read(frames);
            for (pair, &deck) in device.decks.iter().enumerate() {
                let (left, right) = (&mut left[..block], &mut right[..block]);
                for ((frame, l), r) in frames
                    .chunks_exact(width)
                    .zip(left.iter_mut())
                    .zip(right.iter_mut())
                {
                    (*l, *r) = (frame[pair * 2], frame[pair * 2 + 1]);
                }
                engine.dj_set_timecode_input(deck, left, right);
            }
        }
    }
}

/// A device's input stream while it runs.
pub struct TimecodeStream {
    // Dropping the stream stops it.
    _stream: Stream,
    pub device: String,
    failed: Arc<AtomicBool>,
}

impl TimecodeStream {
    pub fn failed(&self) -> Option<String> {
        self.failed
            .load(Relaxed)
            .then(|| format!("{} stopped: it may have been unplugged", self.device))
    }
}

/// The choices for Decks there are, one per Deck (the last wins), grouped
/// by device in the order they were first chosen.
pub fn by_device(choices: &[TimecodeChoice]) -> Vec<(String, Vec<TimecodeChoice>)> {
    let mut kept: Vec<TimecodeChoice> = Vec::new();
    for choice in choices.iter().filter(|c| c.deck < DECKS) {
        kept.retain(|c| c.deck != choice.deck);
        kept.push(choice.clone());
    }
    let mut devices: Vec<(String, Vec<TimecodeChoice>)> = Vec::new();
    for choice in kept {
        match devices.iter_mut().find(|(name, _)| *name == choice.device) {
            Some((_, list)) => list.push(choice),
            None => devices.push((choice.device.clone(), vec![choice])),
        }
    }
    devices
}

/// The writer's end for one device: every chosen pair of each frame, in
/// order, a whole frame or none of it.
pub fn push_frame<T: Copy>(
    writer: &mut MonitorWriter,
    frame: &[T],
    pairs: &[(usize, usize)],
    convert: impl Fn(T) -> f32,
) {
    if !writer.has_room() {
        return;
    }
    for &(left, right) in pairs {
        let at = |channel: usize| frame.get(channel).map_or(0.0, |&s| convert(s));
        writer.push(at(left), at(right));
    }
}

fn name_of(device: &cpal::Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "Unknown device".into())
}

/// Open every device `choices` name on `host`, at the engine's `rate`,
/// and build the feed that hands their pairs to the engine. A device that
/// can't be opened is skipped and said why; the rest run.
pub fn open(
    host: Option<&str>,
    choices: &[TimecodeChoice],
    rate: f32,
) -> (Vec<TimecodeStream>, Option<TimecodeFeed>, Option<String>) {
    let mut streams = Vec::new();
    let mut readers = Vec::new();
    let mut failed = None;
    for (device, choices) in by_device(choices) {
        match open_device(host, &device, &choices, rate) {
            Ok((stream, reader)) => {
                streams.push(stream);
                readers.push((reader, choices.iter().map(|c| c.deck).collect()));
            }
            Err(error) => failed = Some(error),
        }
    }
    let feed = (!readers.is_empty()).then(|| TimecodeFeed::new(readers));
    (streams, feed, failed)
}

fn open_device(
    host: Option<&str>,
    name: &str,
    choices: &[TimecodeChoice],
    rate: f32,
) -> Result<(TimecodeStream, MonitorReader), String> {
    let host = host_named(host)?;
    let device = host
        .input_devices()
        .map_err(|e| e.to_string())?
        .find(|candidate| name_of(candidate) == name)
        .ok_or_else(|| format!("{name} isn't connected"))?;
    // The decoder counts the record's cycles by the engine's clock, so the
    // input must run at the engine's rate.
    let supported = best_config(
        device
            .supported_input_configs()
            .map_err(|e| e.to_string())?,
        rate as u32,
    )
    .ok_or_else(|| format!("{name} can't run at {rate} Hz, the audio output's rate"))?;
    let config: StreamConfig = supported.config();
    let channels = usize::from(config.channels);
    let pairs: Vec<(usize, usize)> = choices
        .iter()
        .map(|c| (usize::from(c.left), usize::from(c.right)))
        .collect();
    if let Some(highest) = pairs.iter().map(|&(l, r)| l.max(r)).max()
        && highest >= channels
    {
        return Err(format!(
            "{name} has {channels} input channel{}, so it has no input {}",
            if channels == 1 { "" } else { "s" },
            highest + 1
        ));
    }
    let (writer, reader) = monitor::monitor(pairs.len());
    let failed = Arc::new(AtomicBool::new(false));
    let stream = with_sample_type!(supported.sample_format(), T => build::<T>(&device, &config, writer, pairs, Arc::clone(&failed)))?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((
        TimecodeStream {
            _stream: stream,
            device: name.to_string(),
            failed,
        },
        reader,
    ))
}

fn build<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut writer: MonitorWriter,
    pairs: Vec<(usize, usize)>,
    failed: Arc<AtomicBool>,
) -> Result<Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels).max(1);
    device
        .build_input_stream(
            *config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                writer.begin(data.len() / channels);
                for frame in data.chunks_exact(channels) {
                    push_frame(&mut writer, frame, &pairs, |s: T| s.to_sample::<f32>());
                }
            },
            move |error| {
                eprintln!("Timecode input error: {error}");
                failed.store(true, Relaxed);
            },
            None,
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choice(deck: usize, device: &str, left: u16) -> TimecodeChoice {
        TimecodeChoice {
            deck,
            device: device.into(),
            left,
            right: left + 1,
        }
    }

    #[test]
    fn decks_on_one_device_share_it_and_a_deck_has_one_input() {
        let grouped = by_device(&[
            choice(0, "Interface", 0),
            choice(1, "Interface", 2),
            choice(2, "USB", 0),
            choice(0, "Interface", 4),
            choice(9, "Interface", 0),
        ]);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].0, "Interface");
        let decks: Vec<(usize, u16)> = grouped[0].1.iter().map(|c| (c.deck, c.left)).collect();
        assert_eq!(decks, [(1, 2), (0, 4)], "the last choice for a Deck wins");
        assert_eq!(grouped[1].1, [choice(2, "USB", 0)]);
    }

    #[test]
    fn a_frame_pushes_each_pair_it_was_chosen_for() {
        let (mut writer, mut reader) = monitor::monitor(2);
        writer.begin(1);
        push_frame(
            &mut writer,
            &[0.1f32, 0.2, 0.3, 0.4],
            &[(2, 3), (0, 1)],
            |s| s,
        );
        // Enough for the reader to prime and play one frame.
        for _ in 0..3 {
            push_frame(&mut writer, &[0.0f32; 4], &[(2, 3), (0, 1)], |s| s);
        }
        reader.begin(1);
        let mut out = [0.0; 4];
        reader.read(&mut out);
        assert_eq!(out, [0.3, 0.4, 0.1, 0.2]);
    }
}

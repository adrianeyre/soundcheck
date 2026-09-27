//! The audio input device, through cpal: an input stream whose callback
//! hands its frames to the `Recorder` (`recorder.rs`), which takes each
//! armed Track's channels out of them, metered all the time and kept while
//! recording. It runs beside the output stream, on the same
//! audio host, and never touches the engine: the engine's part is placing
//! the take (`place_recording`), and playing the frames Input Monitoring
//! passes to the output through `monitor.rs`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    FromSample, InputCallbackInfo, SizedSample, Stream, StreamConfig, SupportedStreamConfig,
};
use serde::Serialize;

use crate::audio::{best_config, host_named, no_device, with_sample_type};
use crate::monitor::MonitorWriter;
use crate::recorder::{self, CaptureWriter, Recorder, Tap};

/// The rate the input is asked for, the output's own; the device's default
/// otherwise, since the engine resamples a take when it loads it.
const SAMPLE_RATE: u32 = 48_000;

/// How often the take is moved out of the input's queue.
const COLLECT_EVERY: Duration = Duration::from_millis(10);

/// An input device, and how many channels it would be opened with.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub name: String,
    pub channels: u16,
}

/// The input that was opened.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputInfo {
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
}

/// A running input stream, and the Recorder collecting from it.
pub struct AudioInput {
    // Dropping the stream stops it.
    _stream: Stream,
    pub recorder: Arc<Recorder>,
    pub info: InputInfo,
    collecting: Arc<AtomicBool>,
}

impl Drop for AudioInput {
    fn drop(&mut self) {
        self.collecting.store(false, Ordering::Relaxed);
    }
}

fn name_of(device: &cpal::Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "Unknown device".into())
}

/// The input devices on `host` (or the default host), the default first,
/// with their channel counts. A device whose configuration can't be read is
/// listed with none.
pub fn input_devices(host: Option<&str>) -> Result<Vec<InputDevice>, String> {
    let host = host_named(host)?;
    let mut devices: Vec<InputDevice> = host
        .input_devices()
        .map_err(|e| e.to_string())?
        .map(|device| InputDevice {
            name: name_of(&device),
            channels: config_for(&device).map_or(0, |config| config.channels()),
        })
        .collect();
    if let Some(default) = host.default_input_device().map(|d| name_of(&d))
        && let Some(index) = devices.iter().position(|device| device.name == default)
    {
        devices[..=index].rotate_right(1);
    }
    Ok(devices)
}

/// The configuration `device` is opened with: the one at `SAMPLE_RATE` in
/// the best sample format (`best_config`), or its default. Its channel count is what the device lists with.
fn config_for(device: &cpal::Device) -> Result<SupportedStreamConfig, String> {
    let supported = best_config(
        device
            .supported_input_configs()
            .map_err(|e| e.to_string())?,
        SAMPLE_RATE,
    );
    match supported {
        Some(config) => Ok(config),
        None => device.default_input_config().map_err(|e| e.to_string()),
    }
}

/// Refuse a tap that reads a channel `device` doesn't have. Channels are
/// named from 1 here, as the interface labels them.
fn check_taps(taps: &[Tap], device: &str, channels: u16) -> Result<(), String> {
    if taps.is_empty() {
        return Err("Arm a Track to record onto".into());
    }
    match taps
        .iter()
        .find(|tap| tap.highest() >= usize::from(channels))
    {
        Some(tap) => Err(format!(
            "{device} has {channels} input channel{}, so it has no input {}",
            if channels == 1 { "" } else { "s" },
            tap.highest() + 1
        )),
        None => Ok(()),
    }
}

/// Open the input `device` (or the default one) on `host` and start
/// metering it, with one take for each of `taps`, in order, handing every
/// frame of each to `monitor` as well when there is one.
pub fn open(
    host: Option<&str>,
    device: Option<&str>,
    taps: &[Tap],
    monitor: Option<MonitorWriter>,
) -> Result<AudioInput, String> {
    let host = host_named(host)?;
    let device = match device {
        Some(name) => host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|candidate| name_of(candidate) == name)
            .ok_or_else(|| format!("There is no audio input called {name}"))?,
        None => host
            .default_input_device()
            .ok_or_else(|| no_device(host.id(), "input"))?,
    };
    let supported = config_for(&device)?;
    let config: StreamConfig = supported.config();
    check_taps(taps, &name_of(&device), config.channels)?;

    let (recorder, mut writer) = recorder::recorder(config.sample_rate, taps);
    if let Some(monitor) = monitor {
        writer.set_monitor(monitor);
    }
    let stream =
        with_sample_type!(supported.sample_format(), T => build::<T>(&device, &config, writer))?;
    stream.play().map_err(|e| e.to_string())?;

    let recorder = Arc::new(recorder);
    let collecting = Arc::new(AtomicBool::new(true));
    {
        let recorder = Arc::clone(&recorder);
        let collecting = Arc::clone(&collecting);
        thread::spawn(move || {
            while collecting.load(Ordering::Relaxed) {
                recorder.collect();
                thread::sleep(COLLECT_EVERY);
            }
        });
    }

    Ok(AudioInput {
        _stream: stream,
        recorder,
        info: InputInfo {
            device: name_of(&device),
            sample_rate: config.sample_rate,
            channels: config.channels,
        },
        collecting,
    })
}

/// An input stream of samples of type `T`, converted to `f32` as they're read.
fn build<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut writer: CaptureWriter,
) -> Result<Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels);
    device
        .build_input_stream(
            *config,
            move |data: &[T], info: &InputCallbackInfo| {
                let now = recorder::host_seconds();
                let timestamp = info.timestamp();
                // The driver's input latency: how long ago the first frame
                // reached the input.
                let latency = timestamp
                    .callback
                    .checked_duration_since(timestamp.capture)
                    .map_or(0.0, |latency| latency.as_secs_f64());
                writer.write(data, channels, now - latency, |s: T| s.to_sample::<f32>());
            },
            |error| eprintln!("Audio input error: {error}"),
            None,
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tap_past_the_device_s_channels_is_refused() {
        assert_eq!(
            check_taps(&[Tap::Mono(7), Tap::FirstTwo], "Interface", 8),
            Ok(())
        );
        assert_eq!(
            check_taps(&[Tap::Stereo(2, 3)], "Mic", 2),
            Err("Mic has 2 input channels, so it has no input 4".into())
        );
        assert_eq!(
            check_taps(&[Tap::Mono(1)], "Mic", 1),
            Err("Mic has 1 input channel, so it has no input 2".into())
        );
        assert!(check_taps(&[], "Mic", 1).is_err());
    }
}

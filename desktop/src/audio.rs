//! The audio device, through cpal: the engine's `Renderer` runs inside the
//! output stream's callback.
//!
//! On Windows the default host is WASAPI, in shared mode (cpal has no
//! exclusive mode). Building with the `asio` feature adds ASIO as a second
//! host, for drivers that can go lower than Windows' shared-mode period (see
//! the README). On Linux it is ALSA, with JACK beside it, which PipeWire also
//! serves; on macOS, CoreAudio.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    BufferSize, FromSample, HostId, OutputCallbackInfo, SampleFormat, SizedSample, Stream,
    StreamConfig, SupportedBufferSize, SupportedStreamConfig, SupportedStreamConfigRange,
};
use std::time::{Duration, Instant};

use rtrb::Producer;
use serde::{Deserialize, Serialize};

use crate::command::RtCommand;
use crate::host::{self, Controller, Renderer};
use crate::recorder::{self, PlaybackClock};

/// The rate the engine asks for; the device's own rate if it can't do it.
const SAMPLE_RATE: u32 = 48_000;

/// Runs `$body` with `$T` as the sample type for `$format`, for every PCM
/// format cpal has. A device can offer any of them: WASAPI lists 8-bit ones
/// beside float. DSD is a bitstream rather than samples, so it is refused.
macro_rules! with_sample_type {
    ($format:expr, $T:ident => $body:expr) => {
        match $format {
            cpal::SampleFormat::F32 => {
                type $T = f32;
                $body
            }
            cpal::SampleFormat::F64 => {
                type $T = f64;
                $body
            }
            cpal::SampleFormat::I8 => {
                type $T = i8;
                $body
            }
            cpal::SampleFormat::I16 => {
                type $T = i16;
                $body
            }
            cpal::SampleFormat::I24 => {
                type $T = cpal::I24;
                $body
            }
            cpal::SampleFormat::I32 => {
                type $T = i32;
                $body
            }
            cpal::SampleFormat::I64 => {
                type $T = i64;
                $body
            }
            cpal::SampleFormat::U8 => {
                type $T = u8;
                $body
            }
            cpal::SampleFormat::U16 => {
                type $T = u16;
                $body
            }
            cpal::SampleFormat::U24 => {
                type $T = cpal::U24;
                $body
            }
            cpal::SampleFormat::U32 => {
                type $T = u32;
                $body
            }
            cpal::SampleFormat::U64 => {
                type $T = u64;
                $body
            }
            other => Err(format!("Unsupported sample format {other}")),
        }
    };
}
pub(crate) use with_sample_type;

/// How much a sample format is wanted, most first: the engine's own `f32`,
/// then the formats that keep the most of it. A device lists its formats in
/// its own order, and WASAPI can put 8-bit first.
fn preference(format: SampleFormat) -> u8 {
    match format {
        SampleFormat::F32 => 0,
        SampleFormat::F64 => 1,
        SampleFormat::I32 => 2,
        SampleFormat::I24 => 3,
        SampleFormat::U32 => 4,
        SampleFormat::U24 => 5,
        SampleFormat::I64 => 6,
        SampleFormat::U64 => 7,
        SampleFormat::I16 => 8,
        SampleFormat::U16 => 9,
        SampleFormat::I8 => 10,
        SampleFormat::U8 => 11,
        _ => u8::MAX,
    }
}

/// Of the configs a device offers, the one at `rate` in the best sample
/// format, keeping the device's order among equals; None if none runs at
/// `rate` in a format the stream can be built for.
pub(crate) fn best_config(
    configs: impl Iterator<Item = SupportedStreamConfigRange>,
    rate: u32,
) -> Option<SupportedStreamConfig> {
    configs
        .filter(|c| c.min_sample_rate() <= rate && rate <= c.max_sample_rate())
        .filter(|c| preference(c.sample_format()) != u8::MAX)
        .min_by_key(|c| preference(c.sample_format()))
        .map(|c| c.with_sample_rate(rate))
}

/// How the UI asks for audio to start. Mirrors `AudioOutputOptions`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOptions {
    /// Frames per callback to ask for, or the host's default.
    pub buffer_frames: Option<u32>,
    /// A name from `host_names`, or the platform's default host.
    pub host: Option<String>,
    pub track_count: usize,
}

/// What was asked for and what was granted.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInfo {
    pub host: String,
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub requested_buffer_frames: Option<u32>,
    /// The buffer size the host reports, where it reports one. The frames
    /// each callback actually asks for are in the stats.
    pub granted_buffer_frames: Option<u32>,
}

/// A running output stream and the Controller that drives its engine.
pub struct AudioOutput {
    // Dropping the stream stops it.
    _stream: Stream,
    pub controller: Controller,
    pub info: OpenInfo,
    /// When the output was heard, for lining up an audio recording.
    pub clock: std::sync::Arc<PlaybackClock>,
}

/// The audio hosts cpal can use here, e.g. `["WASAPI", "ASIO"]` on Windows
/// or `["ALSA", "JACK"]` on Linux. JACK is listed whether or not its server
/// is running: opening it says when it isn't.
pub fn host_names() -> Vec<String> {
    cpal::available_hosts()
        .into_iter()
        .map(|id| id.name().to_string())
        .collect()
}

/// The audio host called `name`, or the platform's default.
pub(crate) fn host_named(name: Option<&str>) -> Result<cpal::Host, String> {
    match name {
        Some(name) => {
            let id = cpal::available_hosts()
                .into_iter()
                .find(|id| id.name() == name)
                .ok_or_else(|| format!("No audio host called {name}"))?;
            cpal::host_from_id(id).map_err(|e| e.to_string())
        }
        None => Ok(cpal::default_host()),
    }
}

/// Open the default output device and start the engine on it. MIDI notes
/// are to be pushed into the `Producer` returned alongside.
pub fn open(options: &OpenOptions) -> Result<(AudioOutput, Producer<RtCommand>), String> {
    let host = host_named(options.host.as_deref())?;
    let device = host
        .default_output_device()
        .ok_or_else(|| no_device(host.id(), "output"))?;
    let device_name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "Unknown device".into());

    let supported = best_config(
        device
            .supported_output_configs()
            .map_err(|e| e.to_string())?,
        SAMPLE_RATE,
    );
    let supported = match supported {
        Some(config) => config,
        None => device.default_output_config().map_err(|e| e.to_string())?,
    };

    let buffer_size = match (options.buffer_frames, supported.buffer_size()) {
        (None, _) => BufferSize::Default,
        (Some(frames), SupportedBufferSize::Range { min, max }) => {
            BufferSize::Fixed(frames.clamp(*min, *max))
        }
        (Some(frames), SupportedBufferSize::Unknown) => BufferSize::Fixed(frames),
    };
    let config = StreamConfig {
        channels: supported.channels(),
        sample_rate: supported.sample_rate(),
        buffer_size,
    };

    let (controller, renderer, midi) = host::host(config.sample_rate as f32, options.track_count);
    let clock = std::sync::Arc::clone(renderer.playback_clock());
    let stream =
        with_sample_type!(supported.sample_format(), T => build::<T>(&device, &config, renderer))?;
    stream.play().map_err(|e| e.to_string())?;

    let info = OpenInfo {
        host: host_name(host.id()),
        device: device_name,
        sample_rate: config.sample_rate,
        channels: config.channels,
        requested_buffer_frames: options.buffer_frames,
        granted_buffer_frames: stream.buffer_size().ok(),
    };
    Ok((
        AudioOutput {
            _stream: stream,
            controller,
            info,
            clock,
        },
        midi,
    ))
}

fn host_name(id: HostId) -> String {
    id.name().to_string()
}

/// Why `host` has no `direction` ("output" or "input") device. JACK makes
/// its devices by connecting to its server, so it has none when no server
/// is running, or when libjack, which is loaded only then, isn't installed.
pub(crate) fn no_device(host: HostId, direction: &str) -> String {
    #[cfg(target_os = "linux")]
    if host == HostId::Jack {
        return format!(
            "JACK has no audio {direction}: no JACK server is running. Start JACK, or \
             PipeWire with its JACK layer (pipewire-jack), and check libjack is installed."
        );
    }
    let _ = host;
    format!("There is no audio {direction} device")
}

/// An output stream of samples of type `T`, which the engine's `f32` is
/// converted to as it is written.
fn build<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut renderer: Renderer,
) -> Result<Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = usize::from(config.channels);
    let sample_rate = config.sample_rate;
    let stats = std::sync::Arc::clone(renderer.stats());
    device
        .build_output_stream(
            *config,
            move |data: &mut [T], info: &OutputCallbackInfo| {
                let started = Instant::now();
                let frames = data.len() / channels.max(1);
                crate::vst3::set_block_deadline(Some(callback_deadline(
                    started,
                    frames,
                    sample_rate,
                )));
                let now = recorder::host_seconds();
                let timestamp = info.timestamp();
                if let Some(latency) = timestamp
                    .playback
                    .checked_duration_since(timestamp.callback)
                {
                    stats.record_output_latency(latency.as_secs_f64());
                    // When this callback's first frame will be heard, on the
                    // clock an audio recording is timed on.
                    renderer.set_played_at(now + latency.as_secs_f64());
                }
                renderer.process_as(data, channels, T::from_sample);
            },
            |error| eprintln!("Audio output error: {error}"),
            None,
        )
        .map_err(|e| e.to_string())
}

/// When a callback that started at `started` for `frames` frames must hand
/// its VST3 Plugins' blocks back by: three quarters of the way through the
/// time those frames last, leaving the last quarter for the rest of the
/// render (ADR 0008).
fn callback_deadline(started: Instant, frames: usize, sample_rate: u32) -> Instant {
    let lasts = frames as f64 / f64::from(sample_rate.max(1));
    started + Duration::from_secs_f64(lasts * 0.75)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_callbacks_plugins_have_three_quarters_of_its_time() {
        let started = Instant::now();
        assert_eq!(
            callback_deadline(started, 480, 48_000),
            started + Duration::from_micros(7_500)
        );
        assert_eq!(callback_deadline(started, 0, 48_000), started);
    }

    fn range(format: SampleFormat, min: u32, max: u32) -> SupportedStreamConfigRange {
        SupportedStreamConfigRange::new(2, min, max, SupportedBufferSize::Unknown, format)
    }

    #[test]
    fn a_config_in_float_is_chosen_over_an_8_bit_one_listed_first() {
        // WASAPI can list a device's u8 config before its float one, and the
        // first one used to be taken: "Unsupported sample format u8".
        let configs = [
            range(SampleFormat::U8, 8_000, 192_000),
            range(SampleFormat::I16, 8_000, 192_000),
            range(SampleFormat::F32, 8_000, 192_000),
        ];
        let chosen = best_config(configs.into_iter(), 48_000).unwrap();
        assert_eq!(chosen.sample_format(), SampleFormat::F32);
        assert_eq!(chosen.sample_rate(), 48_000);
    }

    #[test]
    fn only_a_config_at_the_rate_is_chosen_and_8_bit_when_it_is_all_there_is() {
        let configs = [
            range(SampleFormat::F32, 44_100, 44_100),
            range(SampleFormat::U8, 48_000, 48_000),
        ];
        let chosen = best_config(configs.into_iter(), 48_000).unwrap();
        assert_eq!(chosen.sample_format(), SampleFormat::U8);
        assert!(
            best_config(
                [range(SampleFormat::F32, 44_100, 44_100)].into_iter(),
                48_000
            )
            .is_none()
        );
        assert!(
            best_config(
                [range(SampleFormat::DsdU8, 48_000, 48_000)].into_iter(),
                48_000
            )
            .is_none()
        );
    }

    #[test]
    fn every_pcm_format_has_a_sample_type_and_dsd_is_refused() {
        use SampleFormat::*;
        for format in [F32, F64, I8, I16, I24, I32, I64, U8, U16, U24, U32, U64] {
            let size: Result<usize, String> =
                with_sample_type!(format, T => Ok(std::mem::size_of::<T>()));
            assert_eq!(size.unwrap(), format.sample_size(), "{format}");
            let sized: Result<SampleFormat, String> =
                with_sample_type!(format, T => Ok(<T as SizedSample>::FORMAT));
            assert_eq!(sized.unwrap(), format);
        }
        let dsd: Result<usize, String> =
            with_sample_type!(DsdU8, T => Ok(std::mem::size_of::<T>()));
        assert_eq!(dsd.unwrap_err(), "Unsupported sample format dsdu8");
    }

    #[test]
    fn the_default_host_is_one_of_the_hosts() {
        assert!(host_names().contains(&host_name(cpal::default_host().id())));
    }

    #[test]
    fn a_host_that_is_not_here_is_an_error() {
        let error = host_named(Some("Nowhere")).err();
        assert_eq!(error.as_deref(), Some("No audio host called Nowhere"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_offers_jack_beside_alsa() {
        let hosts = host_names();
        assert!(hosts.contains(&"ALSA".to_string()), "{hosts:?}");
        assert!(hosts.contains(&"JACK".to_string()), "{hosts:?}");
        // Still ALSA by default, which needs no server.
        assert_eq!(host_name(cpal::default_host().id()), "ALSA");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn no_jack_device_says_the_server_is_not_running() {
        let error = no_device(HostId::Jack, "output");
        assert!(error.contains("no JACK server is running"), "{error}");
        assert!(error.contains("pipewire-jack"), "{error}");
        assert_eq!(
            no_device(HostId::Alsa, "input"),
            "There is no audio input device"
        );
    }
}

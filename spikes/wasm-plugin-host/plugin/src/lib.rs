//! A throwaway Effect, "Tone", written against the proposed C-style Plugin
//! ABI (version 1). It does about as much work as the built-in EQ: seven
//! biquads per channel, then a soft clip, then an output gain.
//!
//! The ABI, as a Plugin exports it (no imports at all):
//!
//! | Export                                 | What it does                                   |
//! | -------------------------------------- | ---------------------------------------------- |
//! | `memory`                               | The Plugin's linear memory                     |
//! | `sc_abi_version() -> u32`              | The ABI version the Plugin was built for (1)   |
//! | `sc_manifest() -> u32`                 | Pointer to its manifest: UTF-8 JSON            |
//! | `sc_manifest_len() -> u32`             | The manifest's length in bytes                 |
//! | `sc_init(sample_rate: f32, max_frames: u32) -> u32` | Allocate everything; 0 means ready |
//! | `sc_buffer(channel: u32) -> u32`       | Pointer to channel's `max_frames` of `f32`      |
//! | `sc_set_param(index: u32, value: f32)` | Change a setting (index into the manifest)     |
//! | `sc_process(frames: u32)`              | Process the buffers in place                   |
//! | `sc_reset()`                           | Clear state (tails, filters) without realloc   |
//!
//! One WASM instance is one Plugin instance, so the Plugin keeps its state in
//! globals and never needs a handle.

use std::cell::UnsafeCell;
use std::f32::consts::PI;

pub const ABI_VERSION: u32 = 1;
const FILTERS: usize = 7;

/// The settings, declared up front: what the app draws controls from.
pub const MANIFEST: &str = r#"{"id":"dev.soundcheck.spike.tone","version":"0.1.0","kind":"effect","name":"Tone","settings":[{"name":"drive","label":"Drive","unit":"dB","min":0,"max":24,"default":6,"step":0},{"name":"tone","label":"Tone","unit":"Hz","min":200,"max":16000,"default":4000,"step":0},{"name":"output","label":"Output","unit":"dB","min":-24,"max":6,"default":-3,"step":0}]}"#;

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn peaking(&mut self, sample_rate: f32, frequency: f32, q: f32, gain_db: f32) {
        let a = 10f32.powf(gain_db / 40.0);
        let w = 2.0 * PI * frequency / sample_rate;
        let alpha = w.sin() / (2.0 * q);
        let cos = w.cos();
        let a0 = 1.0 + alpha / a;
        self.b0 = (1.0 + alpha * a) / a0;
        self.b1 = -2.0 * cos / a0;
        self.b2 = (1.0 - alpha * a) / a0;
        self.a1 = -2.0 * cos / a0;
        self.a2 = (1.0 - alpha / a) / a0;
    }

    #[inline(always)]
    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// The DSP, safe and host-free: the native baseline runs this directly.
pub struct Tone {
    sample_rate: f32,
    drive: f32,
    output: f32,
    filters: [[Biquad; FILTERS]; 2],
}

impl Tone {
    pub fn new(sample_rate: f32) -> Self {
        let mut tone = Self {
            sample_rate,
            drive: 1.0,
            output: 1.0,
            filters: [[Biquad::default(); FILTERS]; 2],
        };
        tone.set_param(0, 6.0);
        tone.set_param(1, 4000.0);
        tone.set_param(2, -3.0);
        tone
    }

    pub fn set_param(&mut self, index: u32, value: f32) {
        match index {
            0 => self.drive = 10f32.powf(value.clamp(0.0, 24.0) / 20.0),
            1 => {
                let centre = value.clamp(200.0, 16000.0);
                for channel in &mut self.filters {
                    for (i, filter) in channel.iter_mut().enumerate() {
                        let frequency = centre * 2f32.powf(i as f32 - 3.0);
                        let frequency = frequency.clamp(20.0, self.sample_rate * 0.45);
                        let gain = if i % 2 == 0 { 3.0 } else { -2.0 };
                        filter.peaking(self.sample_rate, frequency, 0.9, gain);
                    }
                }
            }
            2 => self.output = 10f32.powf(value.clamp(-24.0, 6.0) / 20.0),
            _ => {}
        }
    }

    pub fn reset(&mut self) {
        for filter in self.filters.iter_mut().flatten() {
            filter.z1 = 0.0;
            filter.z2 = 0.0;
        }
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for (channel, samples) in [left, right].into_iter().enumerate() {
            let filters = &mut self.filters[channel];
            for sample in samples.iter_mut() {
                let mut x = *sample;
                for filter in filters.iter_mut() {
                    x = filter.run(x);
                }
                let x = x * self.drive;
                *sample = x / (1.0 + x.abs()) * self.output;
            }
        }
    }
}

// ---- The ABI: a thin wrapper over one global `Tone` and its buffers. ----

struct Plugin {
    tone: Option<Tone>,
    buffers: [Vec<f32>; 2],
}

struct Global(UnsafeCell<Plugin>);

// A WASM instance is single-threaded: the host calls one export at a time.
unsafe impl Sync for Global {}

static PLUGIN: Global = Global(UnsafeCell::new(Plugin {
    tone: None,
    buffers: [Vec::new(), Vec::new()],
}));

#[allow(clippy::mut_from_ref)]
fn plugin() -> &'static mut Plugin {
    // SAFETY: see `Global`; no export holds this across another call.
    unsafe { &mut *PLUGIN.0.get() }
}

#[unsafe(no_mangle)]
pub extern "C" fn sc_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn sc_manifest() -> *const u8 {
    MANIFEST.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn sc_manifest_len() -> u32 {
    MANIFEST.len() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn sc_init(sample_rate: f32, max_frames: u32) -> u32 {
    let plugin = plugin();
    plugin.tone = Some(Tone::new(sample_rate));
    plugin.buffers = [
        vec![0.0; max_frames as usize],
        vec![0.0; max_frames as usize],
    ];
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn sc_buffer(channel: u32) -> *mut f32 {
    plugin().buffers[channel as usize & 1].as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn sc_set_param(index: u32, value: f32) {
    if let Some(tone) = &mut plugin().tone {
        tone.set_param(index, value);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn sc_process(frames: u32) {
    let plugin = plugin();
    let Some(tone) = &mut plugin.tone else { return };
    let [left, right] = &mut plugin.buffers;
    let frames = (frames as usize).min(left.len());
    tone.process(&mut left[..frames], &mut right[..frames]);
}

#[unsafe(no_mangle)]
pub extern "C" fn sc_reset() {
    if let Some(tone) = &mut plugin().tone {
        tone.reset();
    }
}

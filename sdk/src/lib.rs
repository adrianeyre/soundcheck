//! Write a Soundcheck **Plugin** in Rust.
//!
//! **Stable** from 1.0.0. The example Plugins in `examples/plugins/`, a
//! bitcrusher Effect and a wavetable Instrument, were written only against
//! this crate and its docs, and prove them. This crate follows semver, and
//! the ABI under it stays version 1 (ADR 0003): a change that would break a
//! built Plugin comes as a new ABI version, which the hosts load beside
//! version 1, never in place of it.
//!
//! A Plugin is an **Effect** or an **Instrument**, built for
//! `wasm32-unknown-unknown` as a `cdylib`. A Plugin Effect is a type that
//! implements [`Effect`], exported with [`export_effect!`]:
//!
//! ```
//! use soundcheck_sdk::{Effect, Manifest, Setting};
//!
//! pub struct Gain(f32);
//!
//! impl Effect for Gain {
//!     const MANIFEST: Manifest = Manifest {
//!         id: "com.example.gain",
//!         version: "1.0.0",
//!         name: "Gain",
//!         settings: &[Setting::number("gain", "Gain", "", 0.0, 2.0, 1.0)],
//!     };
//!
//!     fn new(_sample_rate: f32, _max_frames: usize) -> Self {
//!         Gain(1.0)
//!     }
//!
//!     fn set(&mut self, _index: usize, value: f32) {
//!         self.0 = value;
//!     }
//!
//!     fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
//!         for sample in left.iter_mut().chain(right) {
//!             *sample *= self.0;
//!         }
//!     }
//! }
//!
//! soundcheck_sdk::export_effect!(Gain);
//! ```
//!
//! A Plugin Instrument is a type that implements [`Instrument`], exported
//! with [`export_instrument!`]. It is a Track's Instrument: the host tells
//! it when each note starts and ends, and it renders what they sound like:
//!
//! ```
//! use soundcheck_sdk::{Instrument, Manifest, Setting};
//!
//! /// A square wave while any note is held.
//! pub struct Buzz {
//!     sample_rate: f32,
//!     level: f32,
//!     note: Option<(u8, f32)>,
//!     phase: f32,
//! }
//!
//! impl Instrument for Buzz {
//!     const MANIFEST: Manifest = Manifest {
//!         id: "com.example.buzz",
//!         version: "1.0.0",
//!         name: "Buzz",
//!         settings: &[Setting::number("level", "Level", "", 0.0, 1.0, 0.5)],
//!     };
//!
//!     fn new(sample_rate: f32, _max_frames: usize) -> Self {
//!         Buzz { sample_rate, level: 0.5, note: None, phase: 0.0 }
//!     }
//!
//!     fn set(&mut self, _index: usize, value: f32) {
//!         self.level = value;
//!     }
//!
//!     fn note_on(&mut self, note: u8, velocity: f32) {
//!         self.note = Some((note, velocity));
//!     }
//!
//!     fn note_off(&mut self, note: u8) {
//!         if self.note.is_some_and(|(held, _)| held == note) {
//!             self.note = None;
//!         }
//!     }
//!
//!     fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
//!         let Some((_, velocity)) = self.note else { return };
//!         let step = 220.0 / self.sample_rate;
//!         for (l, r) in left.iter_mut().zip(right) {
//!             let sample = if self.phase < 0.5 { 1.0 } else { -1.0 };
//!             *l = sample * velocity * self.level;
//!             *r = *l;
//!             self.phase = (self.phase + step) % 1.0;
//!         }
//!     }
//!
//!     fn reset(&mut self) {
//!         self.note = None;
//!     }
//! }
//!
//! soundcheck_sdk::export_instrument!(Buzz);
//! ```
//!
//! The host loads the module, reads its manifest and draws a control for
//! each [`Setting`]. It then calls `new` once, off the audio thread; that is
//! the only place to allocate. Every other method runs on the audio thread:
//! `set`, and an Instrument's `note_on` and `note_off`, between blocks;
//! `process` or `render` one block at a time. The host cuts a block where a
//! note starts or ends, so a note lands on the exact frame it is due.
//!
//! Right after `new`, and before the first block, the host sends every
//! setting to `set` at its default, so `set` is the one place that turns a
//! setting's value into the Plugin's state; what `new` starts a setting's
//! field at is never heard.
//!
//! A Plugin that traps, or runs past its time, is stopped: an Effect is
//! bypassed, and an Instrument goes silent. A panic is a trap.
//!
//! # Making a Plugin
//!
//! A Plugin is its own crate, a `cdylib` that depends on this one and
//! nothing else. Also building it as an `rlib` lets `cargo test` run it
//! natively:
//!
//! ```toml
//! [package]
//! name = "my-plugin"
//! version = "1.0.0"
//! edition = "2024"
//!
//! [lib]
//! crate-type = ["cdylib", "rlib"]
//!
//! [dependencies]
//! soundcheck-sdk = { version = "1.0.0", path = "../soundcheck/sdk" }
//! ```
//!
//! The SDK isn't on crates.io, so the dependency is a `path` to the `sdk/`
//! folder of a Soundcheck checkout (or a `git` dependency on the
//! repository). Build it for WebAssembly, in release for speed:
//!
//! ```text
//! rustup target add wasm32-unknown-unknown
//! cargo build --target wasm32-unknown-unknown --release
//! ```
//!
//! The Plugin is `target/wasm32-unknown-unknown/release/my_plugin.wasm`
//! (the crate's name, with `_` for `-`). Install it in the app from
//! **Settings**, **Plugins**, **Install a Plugin**. Installing it again, or
//! a newer build with the same `id`, replaces the one installed. An Effect
//! is then offered in every **Insert Chain**, and an Instrument as a new
//! Track's Instrument on the Song page.
//!
//! The export macros only export on `wasm32`, so on any other target the
//! crate is plain Rust: its tests make the type, send `set` every default
//! as the host does, and call it directly.
//!
//! ## What a Plugin can use
//!
//! The standard library's types, collections and maths (`sin`, `powf`, …)
//! work, and import nothing. Anything that needs the operating system
//! doesn't: there is no clock, file, thread, network, randomness from the
//! system or console, so seed any noise yourself. The host refuses a module
//! that imports anything, so a Plugin can't have dependencies that do. Keep
//! every allocation in `new`: size buffers there from `sample_rate` and
//! `max_frames`, and never grow them later, not even a `Vec`'s capacity.
//!
//! ## Keeping a Plugin compatible
//!
//! A **Project** finds a Plugin by its manifest's `id`, and keeps each
//! setting's value by its `name`, so a later version must keep both: a
//! renamed setting plays at its default in songs that set the old one, and
//! a value outside a setting's new range is clamped into it. The
//! `version` is shown to the musician and saved with the Project; whichever
//! version is installed is the one that plays.
//!
//! # The ABI
//!
//! Both macros export ABI version 1 (ADR 0003), so a Plugin needs nothing
//! else; the exports are listed here for anyone writing a host.
//!
//! | Export | Meaning |
//! | --- | --- |
//! | `memory` | The Plugin's linear memory. It imports nothing. |
//! | `sc_abi_version() -> u32` | 1. |
//! | `sc_manifest() -> u32`, `sc_manifest_len() -> u32` | Where its manifest's UTF-8 JSON is, and how long: `id`, `version`, `kind` (`"effect"` or `"instrument"`), `name` and `settings`. |
//! | `sc_init(sample_rate: f32, max_frames: u32) -> u32` | Make it, every setting at its default. 0 when it is ready. Called once, before anything below. |
//! | `sc_buffer(channel: u32) -> u32` | Where the left (0) and right (1) buffers are, each `max_frames` long. |
//! | `sc_set_param(index: u32, value: f32)` | Set a setting, by its place in the manifest. |
//! | `sc_process(frames: u32)` | An Effect processes the first `frames` of both buffers in place. An Instrument renders its next `frames` into them, replacing whatever is there. |
//! | `sc_reset()` | Forget tails and filters, and silence an Instrument's voices. |
//! | `sc_note_on(note: u32, velocity: f32)` | **Instrument only.** Start a MIDI note (0 to 127) at a velocity from 0 to 1. |
//! | `sc_note_off(note: u32)` | **Instrument only.** Release a note. |
//!
//! A host calls `sc_note_on` and `sc_note_off` between two `sc_process`
//! calls, and a note's events come in the order they are played. An Effect
//! that exports them is still an Effect: its manifest's `kind` decides.

use std::cell::UnsafeCell;
use std::fmt::Write;

/// The ABI this SDK exports.
pub const ABI_VERSION: u32 = 1;

/// Who a Plugin is and what it lets the musician set.
pub struct Manifest {
    /// Reverse-domain and unique, in lowercase letters, digits, `.`, `-`
    /// and `_`: a **Project** finds the Plugin by it.
    pub id: &'static str,
    pub version: &'static str,
    /// The name the musician sees.
    pub name: &'static str,
    /// Every setting, in the order [`Effect::set`] and [`Instrument::set`]
    /// number them. At most 64.
    pub settings: &'static [Setting],
}

/// One setting, declared up front: the app draws its control from this, and
/// the **Assistant**, **Automation** and **Presets** reach it by `name`.
#[derive(Clone, Copy)]
pub struct Setting {
    /// Up to 32 ASCII letters, digits or `_`, unique within the Plugin.
    pub name: &'static str,
    pub label: &'static str,
    /// Shown after the value, or "".
    pub unit: &'static str,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    /// The gap between values a control offers, or 0 for continuous.
    pub step: f32,
}

impl Setting {
    /// A continuous setting.
    pub const fn number(
        name: &'static str,
        label: &'static str,
        unit: &'static str,
        min: f32,
        max: f32,
        default: f32,
    ) -> Self {
        Self {
            name,
            label,
            unit,
            min,
            max,
            default,
            step: 0.0,
        }
    }

    /// The same setting, offering only multiples of `step`.
    pub const fn stepped(self, step: f32) -> Self {
        Self { step, ..self }
    }
}

impl Manifest {
    /// The manifest of an Effect as the JSON the host reads.
    pub fn to_json(&self) -> String {
        self.json("effect")
    }

    /// The manifest of an Instrument as the JSON the host reads.
    pub fn instrument_json(&self) -> String {
        self.json("instrument")
    }

    fn json(&self, kind: &str) -> String {
        let mut out = String::with_capacity(256 + 128 * self.settings.len());
        let _ = write!(
            out,
            r#"{{"id":{},"version":{},"kind":{},"name":{},"settings":["#,
            string(self.id),
            string(self.version),
            string(kind),
            string(self.name)
        );
        for (index, setting) in self.settings.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            let _ = write!(
                out,
                r#"{{"name":{},"label":{},"unit":{},"min":{},"max":{},"default":{},"step":{}}}"#,
                string(setting.name),
                string(setting.label),
                string(setting.unit),
                setting.min,
                setting.max,
                setting.default,
                setting.step
            );
        }
        out.push_str("]}");
        out
    }
}

fn string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A Plugin **Effect**: stereo in, stereo out, processed in place.
pub trait Effect: Sized + 'static {
    const MANIFEST: Manifest;

    /// Make the Effect with every setting at its default. Called off the
    /// audio thread, before any other method: allocate here, and only here.
    /// No block is longer than `max_frames`.
    fn new(sample_rate: f32, max_frames: usize) -> Self;

    /// Change setting `index` of [`Effect::MANIFEST`]. The value is already
    /// within the setting's range and on its step.
    fn set(&mut self, index: usize, value: f32);

    /// Process one block in place. Both sides are the same length.
    fn process(&mut self, left: &mut [f32], right: &mut [f32]);

    /// Forget any state (tails, filters) without allocating, as when the
    /// song stops.
    fn reset(&mut self) {}
}

/// A Plugin **Instrument**: notes in, stereo out.
pub trait Instrument: Sized + 'static {
    const MANIFEST: Manifest;

    /// Make the Instrument with every setting at its default and nothing
    /// sounding. Called off the audio thread, before any other method:
    /// allocate here, and only here. No block is longer than `max_frames`.
    fn new(sample_rate: f32, max_frames: usize) -> Self;

    /// Change setting `index` of [`Instrument::MANIFEST`]. The value is
    /// already within the setting's range and on its step.
    fn set(&mut self, index: usize, value: f32);

    /// Start MIDI note `note` (0 to 127) at `velocity` (0 to 1), from the
    /// next frame rendered. A note already sounding may start again.
    ///
    /// The built-in Instruments play in equal temperament with A4 (note 69)
    /// at 440 Hz, `440 * 2^((note - 69) / 12)`, so a Plugin in the same
    /// tuning plays in tune with them. The host may hold any number of
    /// notes at once: a Plugin makes its voices in `new` and decides what a
    /// note beyond them does (take over the oldest, say, or be dropped).
    fn note_on(&mut self, note: u8, velocity: f32);

    /// Release `note`, from the next frame rendered. It may ring on, as a
    /// release does.
    fn note_off(&mut self, note: u8);

    /// Render the next block. Both sides start silent and are the same
    /// length: write, or add, what the notes sound like.
    fn render(&mut self, left: &mut [f32], right: &mut [f32]);

    /// Silence every voice and forget any state without allocating, as
    /// when the song stops.
    fn reset(&mut self) {}
}

/// What [`Slot`] hosts: an [`Effect`] or an [`Instrument`], seen the same
/// way. Not for use outside the export macros.
#[doc(hidden)]
pub trait Hosted: Sized + 'static {
    fn manifest() -> String;
    fn settings() -> &'static [Setting];
    fn new(sample_rate: f32, max_frames: usize) -> Self;
    fn set(&mut self, index: usize, value: f32);
    fn process(&mut self, left: &mut [f32], right: &mut [f32]);
    fn reset(&mut self);
    fn note_on(&mut self, note: u8, velocity: f32);
    fn note_off(&mut self, note: u8);
}

#[doc(hidden)]
pub struct AsEffect<E>(E);

#[doc(hidden)]
pub struct AsInstrument<I>(I);

impl<E: Effect> Hosted for AsEffect<E> {
    fn manifest() -> String {
        E::MANIFEST.to_json()
    }
    fn settings() -> &'static [Setting] {
        E::MANIFEST.settings
    }
    fn new(sample_rate: f32, max_frames: usize) -> Self {
        Self(E::new(sample_rate, max_frames))
    }
    fn set(&mut self, index: usize, value: f32) {
        self.0.set(index, value);
    }
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.0.process(left, right);
    }
    fn reset(&mut self) {
        self.0.reset();
    }
    fn note_on(&mut self, _: u8, _: f32) {}
    fn note_off(&mut self, _: u8) {}
}

impl<I: Instrument> Hosted for AsInstrument<I> {
    fn manifest() -> String {
        I::MANIFEST.instrument_json()
    }
    fn settings() -> &'static [Setting] {
        I::MANIFEST.settings
    }
    fn new(sample_rate: f32, max_frames: usize) -> Self {
        Self(I::new(sample_rate, max_frames))
    }
    fn set(&mut self, index: usize, value: f32) {
        self.0.set(index, value);
    }
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        left.fill(0.0);
        right.fill(0.0);
        self.0.render(left, right);
    }
    fn reset(&mut self) {
        self.0.reset();
    }
    fn note_on(&mut self, note: u8, velocity: f32) {
        self.0.note_on(note, velocity);
    }
    fn note_off(&mut self, note: u8) {
        self.0.note_off(note);
    }
}

/// What the exports share: the one Plugin this instance is, and the buffers
/// the host writes each block into. Not for use outside the export macros.
#[doc(hidden)]
pub struct Slot<P>(UnsafeCell<State<P>>);

struct State<P> {
    manifest: String,
    plugin: Option<P>,
    buffers: [Vec<f32>; 2],
}

// A WASM instance is single-threaded, and the host calls one export at a
// time, so no two borrows of the slot overlap.
unsafe impl<E> Sync for Slot<E> {}

impl<E: Hosted> Default for Slot<E> {
    fn default() -> Self {
        Self::new()
    }
}

#[doc(hidden)]
impl<E: Hosted> Slot<E> {
    pub const fn new() -> Self {
        Self(UnsafeCell::new(State {
            manifest: String::new(),
            plugin: None,
            buffers: [Vec::new(), Vec::new()],
        }))
    }

    #[allow(clippy::mut_from_ref)]
    fn state(&self) -> &mut State<E> {
        // SAFETY: see the `Sync` impl; no export holds this across another.
        unsafe { &mut *self.0.get() }
    }

    fn manifest(&self) -> &str {
        let state = self.state();
        if state.manifest.is_empty() {
            state.manifest = E::manifest();
        }
        &state.manifest
    }

    pub fn manifest_ptr(&self) -> u32 {
        self.manifest().as_ptr() as u32
    }

    pub fn manifest_len(&self) -> u32 {
        self.manifest().len() as u32
    }

    pub fn init(&self, sample_rate: f32, max_frames: u32) -> u32 {
        if !(sample_rate.is_finite() && sample_rate > 0.0) || max_frames == 0 {
            return 1;
        }
        let state = self.state();
        let frames = max_frames as usize;
        state.buffers = [vec![0.0; frames], vec![0.0; frames]];
        let mut plugin = E::new(sample_rate, frames);
        for (index, setting) in E::settings().iter().enumerate() {
            plugin.set(index, setting.default);
        }
        state.plugin = Some(plugin);
        0
    }

    pub fn buffer(&self, channel: u32) -> u32 {
        match self.state().buffers.get_mut(channel as usize) {
            Some(buffer) => buffer.as_mut_ptr() as u32,
            None => 0,
        }
    }

    pub fn set_param(&self, index: u32, value: f32) {
        let index = index as usize;
        let (Some(plugin), Some(setting)) =
            (self.state().plugin.as_mut(), E::settings().get(index))
        else {
            return;
        };
        let value = if value.is_finite() {
            value
        } else {
            setting.default
        };
        let value = value.clamp(setting.min, setting.max);
        let value = if setting.step > 0.0 {
            (value / setting.step).round() * setting.step
        } else {
            value
        };
        plugin.set(index, value);
    }

    pub fn process(&self, frames: u32) {
        let state = self.state();
        let Some(plugin) = state.plugin.as_mut() else {
            return;
        };
        let [left, right] = &mut state.buffers;
        let frames = (frames as usize).min(left.len());
        plugin.process(&mut left[..frames], &mut right[..frames]);
    }

    pub fn reset(&self) {
        if let Some(plugin) = self.state().plugin.as_mut() {
            plugin.reset();
        }
    }

    /// A note outside MIDI's 0 to 127 is ignored, and a velocity is held to
    /// 0 to 1.
    pub fn note_on(&self, note: u32, velocity: f32) {
        let (Some(plugin), Ok(note @ 0..=127)) = (self.state().plugin.as_mut(), u8::try_from(note))
        else {
            return;
        };
        let velocity = if velocity.is_finite() {
            velocity.clamp(0.0, 1.0)
        } else {
            1.0
        };
        plugin.note_on(note, velocity);
    }

    pub fn note_off(&self, note: u32) {
        if let (Some(plugin), Ok(note @ 0..=127)) =
            (self.state().plugin.as_mut(), u8::try_from(note))
        {
            plugin.note_off(note);
        }
    }
}

/// Export an [`Effect`] as the Plugin ABI: `memory`, `sc_abi_version`,
/// `sc_manifest`, `sc_manifest_len`, `sc_init`, `sc_buffer`,
/// `sc_set_param`, `sc_process` and `sc_reset`. Use it once per crate.
#[macro_export]
macro_rules! export_effect {
    ($effect:ty) => {
        #[cfg(target_arch = "wasm32")]
        const _: () = {
            static SLOT: $crate::Slot<$crate::AsEffect<$effect>> = $crate::Slot::new();
            $crate::__export_abi!(SLOT);
        };
    };
}

/// Export an [`Instrument`] as the Plugin ABI: everything
/// [`export_effect!`] exports, and `sc_note_on` and `sc_note_off`. Use it
/// once per crate.
#[macro_export]
macro_rules! export_instrument {
    ($instrument:ty) => {
        #[cfg(target_arch = "wasm32")]
        const _: () = {
            static SLOT: $crate::Slot<$crate::AsInstrument<$instrument>> = $crate::Slot::new();
            $crate::__export_abi!(SLOT);

            #[unsafe(no_mangle)]
            pub extern "C" fn sc_note_on(note: u32, velocity: f32) {
                SLOT.note_on(note, velocity)
            }

            #[unsafe(no_mangle)]
            pub extern "C" fn sc_note_off(note: u32) {
                SLOT.note_off(note)
            }
        };
    };
}

/// The exports every Plugin has. Not for use outside the export macros.
#[doc(hidden)]
#[macro_export]
macro_rules! __export_abi {
    ($slot:ident) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn sc_abi_version() -> u32 {
            $crate::ABI_VERSION
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn sc_manifest() -> u32 {
            $slot.manifest_ptr()
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn sc_manifest_len() -> u32 {
            $slot.manifest_len()
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn sc_init(sample_rate: f32, max_frames: u32) -> u32 {
            $slot.init(sample_rate, max_frames)
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn sc_buffer(channel: u32) -> u32 {
            $slot.buffer(channel)
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn sc_set_param(index: u32, value: f32) {
            $slot.set_param(index, value)
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn sc_process(frames: u32) {
            $slot.process(frames)
        }

        #[unsafe(no_mangle)]
        pub extern "C" fn sc_reset() {
            $slot.reset()
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Doubler(f32);

    impl Effect for Doubler {
        const MANIFEST: Manifest = Manifest {
            id: "com.example.doubler",
            version: "0.1.0",
            name: "Say \"twice\"",
            settings: &[
                Setting::number("amount", "Amount", "x", 0.0, 2.0, 2.0),
                Setting::number("steps", "Steps", "", 0.0, 4.0, 1.0).stepped(1.0),
            ],
        };

        fn new(_: f32, _: usize) -> Self {
            Doubler(0.0)
        }

        fn set(&mut self, index: usize, value: f32) {
            if index == 0 {
                self.0 = value;
            }
        }

        fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
            for sample in left.iter_mut().chain(right) {
                *sample *= self.0;
            }
        }
    }

    #[test]
    fn the_manifest_is_json_the_host_reads() {
        assert_eq!(
            Doubler::MANIFEST.to_json(),
            concat!(
                r#"{"id":"com.example.doubler","version":"0.1.0","kind":"effect","name":"Say \"twice\"","settings":["#,
                r#"{"name":"amount","label":"Amount","unit":"x","min":0,"max":2,"default":2,"step":0},"#,
                r#"{"name":"steps","label":"Steps","unit":"","min":0,"max":4,"default":1,"step":1}]}"#
            )
        );
    }

    #[test]
    fn the_slot_starts_at_the_defaults_and_clamps_what_it_is_sent() {
        let slot = Slot::<AsEffect<Doubler>>::new();
        assert_eq!(slot.init(48_000.0, 4), 0);
        let state = slot.state();
        state.buffers[0].copy_from_slice(&[1.0; 4]);
        slot.process(4);
        assert_eq!(slot.state().buffers[0], [2.0; 4]);
        slot.set_param(0, 9.0);
        slot.set_param(0, f32::NAN);
        assert_eq!(slot.state().plugin.as_ref().map(|e| e.0.0), Some(2.0));
        slot.set_param(0, 0.5);
        slot.process(2);
        assert_eq!(slot.state().buffers[0], [1.0, 1.0, 2.0, 2.0]);
        assert_eq!(slot.buffer(2), 0);
        assert_eq!(slot.init(0.0, 4), 1);
    }

    /// Plays each held note's velocity, times its one setting, on both
    /// sides.
    struct Held(f32, Vec<(u8, f32)>);

    impl Instrument for Held {
        const MANIFEST: Manifest = Manifest {
            id: "com.example.held",
            version: "0.1.0",
            name: "Held",
            settings: &[Setting::number("level", "Level", "", 0.0, 1.0, 0.5)],
        };

        fn new(_: f32, _: usize) -> Self {
            Held(0.0, Vec::with_capacity(128))
        }

        fn set(&mut self, _: usize, value: f32) {
            self.0 = value;
        }

        fn note_on(&mut self, note: u8, velocity: f32) {
            self.1.push((note, velocity));
        }

        fn note_off(&mut self, note: u8) {
            self.1.retain(|(held, _)| *held != note);
        }

        fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
            let level: f32 = self.1.iter().map(|(_, velocity)| velocity * self.0).sum();
            for sample in left.iter_mut().chain(right) {
                *sample += level;
            }
        }

        fn reset(&mut self) {
            self.1.clear();
        }
    }

    #[test]
    fn an_instruments_manifest_says_it_is_one() {
        assert!(
            Held::MANIFEST
                .instrument_json()
                .starts_with(r#"{"id":"com.example.held","version":"0.1.0","kind":"instrument","#)
        );
    }

    #[test]
    fn an_instrument_renders_its_notes_over_silence() {
        let slot = Slot::<AsInstrument<Held>>::new();
        assert_eq!(slot.init(48_000.0, 4), 0);
        slot.state().buffers[0].copy_from_slice(&[9.0; 4]);
        slot.process(4);
        assert_eq!(
            slot.state().buffers[0],
            [0.0; 4],
            "what the host left is gone"
        );
        slot.note_on(60, 1.0);
        slot.note_on(64, f32::NAN);
        slot.note_on(128, 1.0);
        slot.note_on(u32::MAX, 1.0);
        slot.process(4);
        assert_eq!(slot.state().buffers[1], [1.0; 4], "two notes at 0.5");
        slot.note_off(60);
        slot.process(2);
        assert_eq!(slot.state().buffers[0], [0.5, 0.5, 1.0, 1.0]);
        slot.reset();
        slot.process(4);
        assert_eq!(slot.state().buffers[0], [0.0; 4]);
    }
}

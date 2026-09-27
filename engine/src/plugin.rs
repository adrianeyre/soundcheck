//! **WASM Plugins**, as the engine sees them (ADR 0003).
//!
//! A Plugin is a WebAssembly core module exporting ABI version 1. The engine
//! can't run one itself: wasmtime doesn't build for `wasm32`, and the engine
//! knows nothing about where it runs (ADR 0001). So it declares what a
//! runtime must do, `PluginRuntime` and `PluginInstance`, and each host
//! implements them: `desktop/` with wasmtime, the browser dev host with its
//! own `WebAssembly` in the worklet. What the engine owns is the manifest,
//! which says what settings a Plugin has, and hosting an instance in an
//! Effect slot, where its settings are clamped, automated and kept exactly
//! as a built-in's are.
//!
//! A **VST3 Plugin** comes in through the same `PluginInstance` (ADR 0008).
//! The engine knows nothing of VST3: the Desktop App runs one in a helper
//! process, makes its manifest from the settings it exposes, and says per
//! block whether it was processed, bypassed because it was late, or crashed.

#[cfg(target_arch = "wasm32")]
pub mod js;

use std::fmt::Write;

use serde::Deserialize;

use crate::automation::{MAX_PARAM_NAME, ParamName};

/// The ABI version this engine hosts. A Plugin built for any other is
/// refused.
pub const ABI_VERSION: u32 = 1;

/// The most settings a Plugin can declare.
pub const MAX_PLUGIN_SETTINGS: usize = 64;

/// The longest id a Plugin can have.
const MAX_ID: usize = 128;

/// What a Plugin is: an Effect goes in an Insert Chain and processes the
/// audio it is given; an Instrument is a Track's Instrument and turns notes
/// into audio.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Effect,
    Instrument,
}

/// One declared setting: the same fields as a built-in's table.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PluginSetting {
    pub name: String,
    pub label: String,
    #[serde(default)]
    pub unit: String,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    /// The gap between values a control should offer, or 0 for continuous.
    #[serde(default)]
    pub step: f32,
}

impl PluginSetting {
    /// `value` brought into range and onto the step, as a built-in's table
    /// does it; the default for a value that isn't a number.
    pub fn clamp(&self, value: f32) -> f32 {
        let value = if value.is_finite() {
            value
        } else {
            self.default
        };
        let value = value.clamp(self.min, self.max);
        if self.step > 0.0 {
            (value / self.step).round() * self.step
        } else {
            value
        }
    }
}

/// What a Plugin says about itself: UTF-8 JSON at `sc_manifest`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PluginManifest {
    /// Reverse-DNS style, e.g. "dev.soundcheck.test.tilt": what a Project
    /// names the Plugin by.
    pub id: String,
    pub version: String,
    pub kind: PluginKind,
    pub name: String,
    #[serde(default)]
    pub settings: Vec<PluginSetting>,
}

impl PluginManifest {
    /// Read and check a manifest. The error says what is wrong with it.
    pub fn parse(json: &str) -> Result<Self, String> {
        let manifest: Self = serde_json::from_str(json)
            .map_err(|error| format!("Its manifest isn't valid: {error}"))?;
        manifest.check()?;
        Ok(manifest)
    }

    fn check(&self) -> Result<(), String> {
        let id_ok = !self.id.is_empty()
            && self.id.len() <= MAX_ID
            && self
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b));
        if !id_ok {
            return Err(format!(
                "Its id {:?} must be 1 to {MAX_ID} lowercase letters, digits, dots, dashes or underscores",
                self.id
            ));
        }
        if self.version.trim().is_empty() {
            return Err("Its manifest has no version".to_string());
        }
        if self.name.trim().is_empty() {
            return Err("Its manifest has no name".to_string());
        }
        if self.settings.len() > MAX_PLUGIN_SETTINGS {
            return Err(format!(
                "It declares {} settings; the most a Plugin can have is {MAX_PLUGIN_SETTINGS}",
                self.settings.len()
            ));
        }
        for (index, setting) in self.settings.iter().enumerate() {
            if ParamName::new(&setting.name).is_none() {
                return Err(format!(
                    "Its setting {:?} must be named with 1 to {MAX_PARAM_NAME} letters, digits or underscores",
                    setting.name
                ));
            }
            if self.settings[..index]
                .iter()
                .any(|s| s.name == setting.name)
            {
                return Err(format!("It declares the setting {:?} twice", setting.name));
            }
            let numbers = [setting.min, setting.max, setting.default, setting.step];
            if !numbers.iter().all(|n| n.is_finite())
                || setting.min >= setting.max
                || !(setting.min..=setting.max).contains(&setting.default)
                || setting.step < 0.0
            {
                return Err(format!(
                    "Its setting {:?} needs min below max, a default between them and a step of 0 or more",
                    setting.name
                ));
            }
        }
        Ok(())
    }

    /// Where the setting called `name` is, if there is one: every Plugin
    /// setting is a number, so Automation can move any of them.
    pub fn setting_index(&self, name: &str) -> Option<usize> {
        self.settings.iter().position(|s| s.name == name)
    }

    /// Its settings as the same JSON a built-in's table is published as.
    pub fn table_json(&self) -> String {
        let mut out = String::from("[");
        for (index, s) in self.settings.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            let _ = write!(
                out,
                r#"{{"name":{},"label":{},"unit":{},"min":{},"max":{},"default":{},"step":{},"choices":[]}}"#,
                json_string(&s.name),
                json_string(&s.label),
                json_string(&s.unit),
                number_json(s.min),
                number_json(s.max),
                number_json(s.default),
                number_json(s.step),
            );
        }
        out.push(']');
        out
    }

    /// The manifest as checked, in one form whatever the Plugin wrote.
    pub fn to_json(&self) -> String {
        let kind = match self.kind {
            PluginKind::Effect => "effect",
            PluginKind::Instrument => "instrument",
        };
        format!(
            r#"{{"id":{},"version":{},"kind":"{kind}","name":{},"settings":{}}}"#,
            json_string(&self.id),
            json_string(&self.version),
            json_string(&self.name),
            self.table_json(),
        )
    }
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// As a built-in's table prints its numbers, so the UI reads the same ones.
fn number_json(value: f32) -> String {
    let rounded = (f64::from(value) * 10_000.0).round() / 10_000.0;
    format!("{rounded}")
}

/// A Plugin that broke its instance: it trapped, or ran past the host's
/// deadline. The Effect bypasses it from then on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PluginFault;

/// What became of one block a Plugin was given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginBlock {
    /// The buffers hold the Plugin's output.
    Processed,
    /// Not this block: a Plugin in another process was late for it, or said
    /// it failed. An Effect passes its input through and an Instrument is
    /// silent, for this block only.
    Bypassed,
    /// The Plugin broke its instance, and is bypassed from now on.
    Crashed,
}

/// One running instance of a Plugin, as a host's runtime made it: in
/// wasmtime its own `Store`, in the browser its own `WebAssembly.Instance`,
/// and for a **VST3 Plugin** on the Desktop App a helper process (ADR 0008).
/// Every call is made on the audio thread, so none may allocate, lock or
/// block; the runtime turned `sc_init` into this before the audio thread saw
/// it.
pub trait PluginInstance: Send {
    /// `sc_set_param`: the setting at `index` in the manifest, already
    /// clamped to its range.
    fn set_param(&mut self, index: usize, value: f32);
    /// `sc_process`: copy both sides into the Plugin's buffers, process
    /// them in place and copy them back. Never more frames than the
    /// instance was made for.
    fn process(&mut self, left: &mut [f32], right: &mut [f32]) -> Result<(), PluginFault>;
    /// `process`, saying what became of the block. What the engine calls: a
    /// runtime whose Plugin can be late for a block without having broken
    /// (one in another process) says so here; for the rest, a fault is a
    /// crash.
    fn process_block(&mut self, left: &mut [f32], right: &mut [f32]) -> PluginBlock {
        match self.process(left, right) {
            Ok(()) => PluginBlock::Processed,
            Err(PluginFault) => PluginBlock::Crashed,
        }
    }
    /// `sc_reset`: clear its tails and filters, and silence an
    /// Instrument's voices.
    fn reset(&mut self);
    /// `sc_note_on`, which only an Instrument exports: start `note` (a MIDI
    /// note number) at `velocity`, from 0 to 1. The engine calls it between
    /// two `process` calls, having cut the block where the note starts.
    fn note_on(&mut self, _note: u8, _velocity: f32) -> Result<(), PluginFault> {
        Ok(())
    }
    /// `sc_note_off`, which only an Instrument exports: release `note`.
    fn note_off(&mut self, _note: u8) -> Result<(), PluginFault> {
        Ok(())
    }
}

/// What a host implements to run Plugins: compile a module once, then make
/// as many instances of it as there are slots that use it.
pub trait PluginRuntime {
    /// A compiled Plugin, ready to instantiate.
    type Module;

    /// Compile a Plugin's `.wasm` and read its manifest, refusing one that
    /// doesn't export ABI version 1. The error says what is wrong.
    fn load(&self, wasm: &[u8]) -> Result<(Self::Module, PluginManifest), String>;

    /// A fresh instance of `module`, its `sc_init` called with
    /// `sample_rate` and `max_frames`, and every setting at its default.
    fn instantiate(
        &self,
        module: &Self::Module,
        manifest: &PluginManifest,
        sample_rate: f32,
        max_frames: usize,
    ) -> Result<Box<dyn PluginInstance>, String>;
}

/// A Plugin hosted in an Effect slot or as a Track's Instrument: its
/// instance, and its settings as it was last given them.
pub struct HostedPlugin {
    manifest: std::sync::Arc<PluginManifest>,
    instance: Box<dyn PluginInstance>,
    values: Vec<f32>,
    faulted: bool,
}

impl std::fmt::Debug for HostedPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostedPlugin")
            .field("id", &self.manifest.id)
            .field("values", &self.values)
            .field("faulted", &self.faulted)
            .finish()
    }
}

impl HostedPlugin {
    /// Host `instance`, telling it every setting's default so it and the
    /// engine agree from the start.
    pub fn new(
        manifest: std::sync::Arc<PluginManifest>,
        mut instance: Box<dyn PluginInstance>,
    ) -> Self {
        let values: Vec<f32> = manifest.settings.iter().map(|s| s.default).collect();
        for (index, value) in values.iter().enumerate() {
            instance.set_param(index, *value);
        }
        Self {
            manifest,
            instance,
            values,
            faulted: false,
        }
    }

    /// Host `instance` at `values`, the settings it already has because it
    /// was restored from its own state (a VST3 Plugin's), telling it
    /// nothing. Each is clamped as `set` would; a missing one is its default.
    pub fn with_values(
        manifest: std::sync::Arc<PluginManifest>,
        instance: Box<dyn PluginInstance>,
        values: &[f32],
    ) -> Self {
        let values = manifest
            .settings
            .iter()
            .enumerate()
            .map(|(index, s)| s.clamp(values.get(index).copied().unwrap_or(s.default)))
            .collect();
        Self {
            manifest,
            instance,
            values,
            faulted: false,
        }
    }

    pub fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    pub fn get(&self, index: usize) -> f32 {
        self.values.get(index).copied().unwrap_or_default()
    }

    /// Set a setting, clamped as its manifest says. Only a change reaches
    /// the Plugin, so a steady Automation costs nothing. Allocates nothing.
    pub fn set(&mut self, index: usize, value: f32) {
        let Some(setting) = self.manifest.settings.get(index) else {
            return;
        };
        let value = setting.clamp(value);
        if self.values[index] != value {
            self.values[index] = value;
            self.instance.set_param(index, value);
        }
    }

    /// Process in place. A block the Plugin didn't process has what came
    /// in put back; once it crashes it is bypassed for good.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], dry: (&mut [f32], &mut [f32])) {
        if self.faulted {
            return;
        }
        let (dry_left, dry_right) = (&mut dry.0[..left.len()], &mut dry.1[..right.len()]);
        dry_left.copy_from_slice(left);
        dry_right.copy_from_slice(right);
        let block = self.instance.process_block(left, right);
        if block != PluginBlock::Processed {
            self.faulted = block == PluginBlock::Crashed;
            left.copy_from_slice(dry_left);
            right.copy_from_slice(dry_right);
        }
    }

    /// Render an Instrument's next `left.len()` frames, replacing what is
    /// there: the Plugin's buffers start silent and it writes its output
    /// into them. A block it didn't process is silent; once it crashes it
    /// is silent for good.
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        left.fill(0.0);
        right.fill(0.0);
        if self.faulted {
            return;
        }
        let block = self.instance.process_block(left, right);
        if block != PluginBlock::Processed {
            self.faulted = block == PluginBlock::Crashed;
            left.fill(0.0);
            right.fill(0.0);
        }
    }

    pub fn note_on(&mut self, note: u8, velocity: f32) {
        if !self.faulted {
            self.faulted = self.instance.note_on(note, velocity).is_err();
        }
    }

    pub fn note_off(&mut self, note: u8) {
        if !self.faulted {
            self.faulted = self.instance.note_off(note).is_err();
        }
    }

    /// Whether it faulted and is bypassed, or silent where it is an
    /// Instrument.
    pub fn faulted(&self) -> bool {
        self.faulted
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const MANIFEST: &str = r#"{"id":"dev.soundcheck.test.gain","version":"1.0.0","kind":"effect","name":"Gain","settings":[{"name":"gain","label":"Gain","unit":"","min":0,"max":2,"default":1,"step":0},{"name":"steps","label":"Steps","min":0,"max":4,"default":2,"step":1}]}"#;

    /// A Plugin runtime in plain Rust for the engine's own tests: its one
    /// Plugin scales both sides by its first setting, and faults, as a
    /// trapped Plugin does, whenever its second is at 4.
    pub struct FakeRuntime;

    #[derive(Default)]
    pub struct FakeInstance {
        pub gain: f32,
        pub fault: bool,
    }

    impl PluginInstance for FakeInstance {
        fn set_param(&mut self, index: usize, value: f32) {
            match index {
                0 => self.gain = value,
                _ => self.fault = value == 4.0,
            }
        }

        fn process(&mut self, left: &mut [f32], right: &mut [f32]) -> Result<(), PluginFault> {
            if self.fault {
                left.fill(f32::NAN);
                return Err(PluginFault);
            }
            for sample in left.iter_mut().chain(right.iter_mut()) {
                *sample *= self.gain;
            }
            Ok(())
        }

        fn reset(&mut self) {}
    }

    impl PluginRuntime for FakeRuntime {
        type Module = ();

        fn load(&self, wasm: &[u8]) -> Result<((), PluginManifest), String> {
            let json = std::str::from_utf8(wasm).map_err(|e| e.to_string())?;
            Ok(((), PluginManifest::parse(json)?))
        }

        fn instantiate(
            &self,
            _: &(),
            _: &PluginManifest,
            _: f32,
            _: usize,
        ) -> Result<Box<dyn PluginInstance>, String> {
            Ok(Box::<FakeInstance>::default())
        }
    }

    pub const INSTRUMENT: &str = r#"{"id":"dev.soundcheck.test.tone","version":"1.0.0","kind":"instrument","name":"Tone","settings":[{"name":"level","label":"Level","unit":"","min":0,"max":1,"default":0.5,"step":0},{"name":"fault","label":"Fault","min":0,"max":1,"default":0,"step":1}]}"#;

    /// An Instrument Plugin in plain Rust: while notes are held it plays a
    /// steady level on both sides, the sum over them of its first setting
    /// times each note's velocity; and it faults whenever its second setting
    /// is at 1.
    #[derive(Default)]
    pub struct FakeInstrument {
        pub level: f32,
        pub fault: bool,
        pub held: Vec<(u8, f32)>,
    }

    impl PluginInstance for FakeInstrument {
        fn set_param(&mut self, index: usize, value: f32) {
            match index {
                0 => self.level = value,
                _ => self.fault = value == 1.0,
            }
        }

        fn process(&mut self, left: &mut [f32], right: &mut [f32]) -> Result<(), PluginFault> {
            if self.fault {
                left.fill(f32::NAN);
                return Err(PluginFault);
            }
            let level: f32 = self.held.iter().map(|(_, v)| self.level * v).sum();
            for sample in left.iter_mut().chain(right.iter_mut()) {
                *sample += level;
            }
            Ok(())
        }

        fn reset(&mut self) {
            self.held.clear();
        }

        fn note_on(&mut self, note: u8, velocity: f32) -> Result<(), PluginFault> {
            self.held.push((note, velocity));
            Ok(())
        }

        fn note_off(&mut self, note: u8) -> Result<(), PluginFault> {
            self.held.retain(|(held, _)| *held != note);
            Ok(())
        }
    }

    /// The fake Instrument Plugin, hosted.
    pub fn tone_plugin() -> HostedPlugin {
        let manifest = PluginManifest::parse(INSTRUMENT).unwrap();
        HostedPlugin::new(
            std::sync::Arc::new(manifest),
            Box::<FakeInstrument>::default(),
        )
    }

    /// The fake Plugin, hosted.
    pub fn gain_plugin() -> HostedPlugin {
        let runtime = FakeRuntime;
        let (module, manifest) = runtime.load(MANIFEST.as_bytes()).unwrap();
        let instance = runtime
            .instantiate(&module, &manifest, 48_000.0, 1_024)
            .unwrap();
        HostedPlugin::new(std::sync::Arc::new(manifest), instance)
    }

    #[test]
    fn a_manifest_is_read_and_published_like_a_built_ins_table() {
        let manifest = PluginManifest::parse(MANIFEST).unwrap();
        assert_eq!(manifest.id, "dev.soundcheck.test.gain");
        assert_eq!(manifest.kind, PluginKind::Effect);
        assert_eq!(manifest.settings[1].unit, "");
        assert_eq!(
            manifest.table_json(),
            r#"[{"name":"gain","label":"Gain","unit":"","min":0,"max":2,"default":1,"step":0,"choices":[]},{"name":"steps","label":"Steps","unit":"","min":0,"max":4,"default":2,"step":1,"choices":[]}]"#
        );
        assert_eq!(
            PluginManifest::parse(&manifest.to_json()).unwrap(),
            manifest
        );
    }

    #[test]
    fn a_bad_manifest_says_what_is_wrong() {
        let with = |from: &str, to: &str| PluginManifest::parse(&MANIFEST.replace(from, to));
        assert!(
            PluginManifest::parse("{")
                .unwrap_err()
                .contains("isn't valid")
        );
        assert!(
            with("dev.soundcheck.test.gain", "Has Spaces")
                .unwrap_err()
                .contains("id")
        );
        assert!(with(r#""kind":"effect""#, r#""kind":"sampler""#).is_err());
        assert!(
            with(r#""name":"steps""#, r#""name":"gain""#)
                .unwrap_err()
                .contains("twice")
        );
        assert!(with(r#""name":"steps""#, r#""name":"no spaces""#).is_err());
        assert!(
            with(r#""default":2"#, r#""default":9"#)
                .unwrap_err()
                .contains("default")
        );
        assert!(
            with(r#""version":"1.0.0""#, r#""version":"""#)
                .unwrap_err()
                .contains("version")
        );
    }

    #[test]
    fn settings_are_clamped_and_only_changes_reach_the_plugin() {
        let mut plugin = gain_plugin();
        assert_eq!((plugin.get(0), plugin.get(1)), (1.0, 2.0));
        plugin.set(0, 5.0);
        plugin.set(1, 2.6);
        assert_eq!((plugin.get(0), plugin.get(1)), (2.0, 3.0));
        plugin.set(0, f32::NAN);
        assert_eq!(plugin.get(0), 1.0);
    }

    #[test]
    fn a_plugin_that_faults_is_bypassed_from_then_on() {
        let mut plugin = gain_plugin();
        plugin.set(0, 0.5);
        let mut dry = (vec![0.0; 4], vec![0.0; 4]);
        let (mut left, mut right) = (vec![1.0; 4], vec![1.0; 4]);
        plugin.process(&mut left, &mut right, (&mut dry.0, &mut dry.1));
        assert_eq!(left, [0.5; 4]);
        plugin.set(1, 4.0);
        let (mut left, mut right) = (vec![1.0; 4], vec![1.0; 4]);
        plugin.process(&mut left, &mut right, (&mut dry.0, &mut dry.1));
        assert_eq!((left, right), (vec![1.0; 4], vec![1.0; 4]));
        assert!(plugin.faulted());
        plugin.set(1, 0.0);
        let (mut left, mut right) = (vec![1.0; 4], vec![1.0; 4]);
        plugin.process(&mut left, &mut right, (&mut dry.0, &mut dry.1));
        assert_eq!(left, [1.0; 4]);
    }

    /// A Plugin in another process, as a host sees it: each block it was
    /// on time for is its own, it is late for the ones in `late`, and it is
    /// gone from `crashes_at` on. It halves what it is given, and remembers
    /// the settings it was told.
    struct Remote {
        block: usize,
        late: Vec<usize>,
        crashes_at: usize,
        told: std::sync::Arc<std::sync::Mutex<Vec<(usize, f32)>>>,
    }

    impl PluginInstance for Remote {
        fn set_param(&mut self, index: usize, value: f32) {
            self.told.lock().unwrap().push((index, value));
        }

        fn process(&mut self, _: &mut [f32], _: &mut [f32]) -> Result<(), PluginFault> {
            unreachable!("the host calls process_block")
        }

        fn process_block(&mut self, left: &mut [f32], right: &mut [f32]) -> PluginBlock {
            let block = self.block;
            self.block += 1;
            if block >= self.crashes_at {
                left.fill(f32::NAN);
                return PluginBlock::Crashed;
            }
            if self.late.contains(&block) {
                left.fill(f32::NAN);
                return PluginBlock::Bypassed;
            }
            for sample in left.iter_mut().chain(right.iter_mut()) {
                *sample *= 0.5;
            }
            PluginBlock::Processed
        }

        fn reset(&mut self) {}
    }

    fn remote(late: &[usize], crashes_at: usize) -> Box<Remote> {
        Box::new(Remote {
            block: 0,
            late: late.to_vec(),
            crashes_at,
            told: Default::default(),
        })
    }

    #[test]
    fn a_late_block_is_bypassed_but_only_a_crash_bypasses_it_for_good() {
        let manifest = std::sync::Arc::new(PluginManifest::parse(MANIFEST).unwrap());
        let mut plugin = HostedPlugin::new(manifest, remote(&[1], 3));
        let mut dry = (vec![0.0; 4], vec![0.0; 4]);
        let mut outputs = Vec::new();
        for _ in 0..5 {
            let (mut left, mut right) = (vec![1.0; 4], vec![1.0; 4]);
            plugin.process(&mut left, &mut right, (&mut dry.0, &mut dry.1));
            assert_eq!(left, right);
            outputs.push((left[0], plugin.faulted()));
        }
        assert_eq!(
            outputs,
            [
                (0.5, false),
                (1.0, false),
                (0.5, false),
                (1.0, true),
                (1.0, true)
            ]
        );
    }

    #[test]
    fn an_instrument_late_for_a_block_is_silent_for_that_block() {
        let manifest = std::sync::Arc::new(PluginManifest::parse(INSTRUMENT).unwrap());
        let mut plugin = HostedPlugin::new(manifest, remote(&[0], 2));
        let (mut left, mut right) = (vec![9.0; 4], vec![9.0; 4]);
        plugin.render(&mut left, &mut right);
        assert_eq!((&left, plugin.faulted()), (&vec![0.0; 4], false));
        plugin.render(&mut left, &mut right);
        plugin.render(&mut left, &mut right);
        assert_eq!((&left, plugin.faulted()), (&vec![0.0; 4], true));
    }

    #[test]
    fn a_plugin_restored_from_its_own_state_starts_at_its_own_values() {
        let manifest = std::sync::Arc::new(PluginManifest::parse(MANIFEST).unwrap());
        let instance = remote(&[], usize::MAX);
        let told = std::sync::Arc::clone(&instance.told);
        let mut plugin = HostedPlugin::with_values(manifest, instance, &[0.25, 9.0]);
        // Clamped as any value is, and not sent: the Plugin already has them.
        assert_eq!((plugin.get(0), plugin.get(1)), (0.25, 4.0));
        plugin.set(0, 0.25);
        plugin.set(0, 0.75);
        assert_eq!(*told.lock().unwrap(), [(0, 0.75)]);
    }

    #[test]
    fn an_instrument_renders_from_silence_and_is_silent_once_it_faults() {
        let mut plugin = tone_plugin();
        assert_eq!(plugin.manifest().kind, PluginKind::Instrument);
        plugin.note_on(60, 1.0);
        let (mut left, mut right) = (vec![9.0; 4], vec![9.0; 4]);
        plugin.render(&mut left, &mut right);
        assert_eq!((left, right), (vec![0.5; 4], vec![0.5; 4]));
        plugin.note_off(60);
        let (mut left, mut right) = (vec![9.0; 4], vec![9.0; 4]);
        plugin.render(&mut left, &mut right);
        assert_eq!(left, [0.0; 4]);

        plugin.note_on(60, 1.0);
        plugin.set(1, 1.0);
        let (mut left, mut right) = (vec![9.0; 4], vec![9.0; 4]);
        plugin.render(&mut left, &mut right);
        assert_eq!((left, right), (vec![0.0; 4], vec![0.0; 4]));
        assert!(plugin.faulted());
    }
}

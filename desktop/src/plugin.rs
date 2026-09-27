//! **WASM Plugins** on desktop: the engine's `PluginRuntime` in wasmtime
//! (ADR 0003), and the app-level Plugins folder they are installed into.
//!
//! Each instance has its own `Store`, so instances share nothing. Epoch
//! interruption is on: a ticker thread advances the epoch every `TICK`,
//! about one block at 48 kHz, and each call into a Plugin may run for
//! `DEADLINE_TICKS` of them. One that runs past that (a runaway loop) is
//! trapped, and the engine bypasses it from then on instead of stalling the
//! audio thread. The ticker has to be its own thread: a runaway Plugin holds
//! the audio thread, which then can't tick anything.

use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use soundcheck_engine::{
    ABI_VERSION, PluginFault, PluginInstance, PluginKind, PluginManifest, PluginRuntime,
};
use wasmtime::{Config, Engine, Instance, Memory, Module, Store, TypedFunc};

use crate::project_files;

/// How often the epoch advances: about one 128-frame block at 48 kHz.
const TICK: Duration = Duration::from_micros(2_500);

/// How many ticks one call into a Plugin may run before it is stopped:
/// ~50 ms, far past any block's budget, so only a Plugin that has run away
/// (or a machine too loaded to play at all) reaches it.
const DEADLINE_TICKS: u64 = 20;

/// The most frames an instance takes at once. The engine renders at most
/// `host::MAX_BLOCK`; a longer block would be passed in pieces.
const MAX_FRAMES: usize = crate::host::MAX_BLOCK;

/// wasmtime, set up for Plugins, with its epoch ticking. One per process:
/// compiled Plugins can be shared by every host (live, export, analysis).
pub struct Wasmtime {
    engine: Engine,
}

/// The process's runtime, started the first time a Plugin is loaded.
pub fn runtime() -> &'static Wasmtime {
    static RUNTIME: OnceLock<Wasmtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        let mut config = Config::new();
        config.epoch_interruption(true);
        let engine = Engine::new(&config).expect("wasmtime's default config builds");
        let ticking = engine.weak();
        thread::Builder::new()
            .name("plugin-epoch".into())
            .spawn(move || {
                while let Some(engine) = ticking.upgrade() {
                    engine.increment_epoch();
                    drop(engine);
                    thread::sleep(TICK);
                }
            })
            .expect("the epoch thread starts");
        Wasmtime { engine }
    })
}

/// A compiled Plugin: cheap to clone, and shared by every instance of it.
#[derive(Clone)]
pub struct Compiled(Module);

impl PluginRuntime for Wasmtime {
    type Module = Compiled;

    fn load(&self, wasm: &[u8]) -> Result<(Compiled, PluginManifest), String> {
        let module = Module::new(&self.engine, wasm)
            .map_err(|error| format!("This isn't a WebAssembly module: {error}"))?;
        if module.imports().len() > 0 {
            return Err("A Plugin can't import anything, and this one does.".into());
        }
        let mut store = self.store();
        let instance = Instance::new(&mut store, &module, &[])
            .map_err(|error| format!("The Plugin couldn't start: {error}"))?;
        let version = call::<(), u32>(&instance, &mut store, "sc_abi_version", ())?;
        if version != ABI_VERSION {
            return Err(format!(
                "The Plugin is built for ABI version {version}; this app hosts version {ABI_VERSION}."
            ));
        }
        let pointer = call::<(), u32>(&instance, &mut store, "sc_manifest", ())? as usize;
        let length = call::<(), u32>(&instance, &mut store, "sc_manifest_len", ())? as usize;
        let memory = memory(&instance, &mut store)?;
        let bytes = memory
            .data(&store)
            .get(pointer..pointer + length)
            .ok_or("The Plugin's manifest is outside its memory.")?;
        let json = std::str::from_utf8(bytes).map_err(|_| "The Plugin's manifest isn't UTF-8.")?;
        let manifest = PluginManifest::parse(json)?;
        if manifest.kind == PluginKind::Instrument {
            // An Instrument hears its notes through two more exports.
            Notes::of(&instance, &mut store)?;
        }
        Ok((Compiled(module), manifest))
    }

    fn instantiate(
        &self,
        module: &Compiled,
        manifest: &PluginManifest,
        sample_rate: f32,
        max_frames: usize,
    ) -> Result<Box<dyn PluginInstance>, String> {
        let frames = max_frames.clamp(1, MAX_FRAMES);
        let mut store = self.store();
        let instance = Instance::new(&mut store, &module.0, &[])
            .map_err(|error| format!("The Plugin couldn't start: {error}"))?;
        let ready = call::<(f32, u32), u32>(
            &instance,
            &mut store,
            "sc_init",
            (sample_rate, frames as u32),
        )?;
        if ready != 0 {
            return Err(format!(
                "The Plugin refused to start (sc_init said {ready})."
            ));
        }
        let memory = memory(&instance, &mut store)?;
        let mut buffers = [0; 2];
        for (channel, buffer) in buffers.iter_mut().enumerate() {
            *buffer =
                call::<u32, u32>(&instance, &mut store, "sc_buffer", channel as u32)? as usize;
            if *buffer + frames * 4 > memory.data_size(&store) {
                return Err("The Plugin's buffers are outside its memory.".into());
            }
        }
        let instrument = manifest.kind == PluginKind::Instrument;
        let mut hosted = Wasmtime::hosted(instance, store, memory, buffers, frames, instrument)?;
        for (index, setting) in manifest.settings.iter().enumerate() {
            hosted.set_param(index, setting.default);
        }
        Ok(Box::new(hosted))
    }
}

impl Wasmtime {
    fn store(&self) -> Store<()> {
        let mut store = Store::new(&self.engine, ());
        store.set_epoch_deadline(DEADLINE_TICKS);
        store
    }

    fn hosted(
        instance: Instance,
        mut store: Store<()>,
        memory: Memory,
        buffers: [usize; 2],
        frames: usize,
        instrument: bool,
    ) -> Result<Hosted, String> {
        let set_param = func(&instance, &mut store, "sc_set_param")?;
        let process = func(&instance, &mut store, "sc_process")?;
        let reset = func(&instance, &mut store, "sc_reset")?;
        let notes = match instrument {
            true => Some(Notes::of(&instance, &mut store)?),
            false => None,
        };
        Ok(Hosted {
            store,
            memory,
            buffers,
            frames,
            set_param,
            process,
            reset,
            notes,
        })
    }
}

/// What only an Instrument exports: `sc_note_on` and `sc_note_off`.
struct Notes {
    on: TypedFunc<(u32, f32), ()>,
    off: TypedFunc<u32, ()>,
}

impl Notes {
    fn of(instance: &Instance, store: &mut Store<()>) -> Result<Self, String> {
        Ok(Self {
            on: func(instance, store, "sc_note_on")?,
            off: func(instance, store, "sc_note_off")?,
        })
    }
}

/// One instance of a Plugin, in its own `Store`.
struct Hosted {
    store: Store<()>,
    memory: Memory,
    /// Where each side's buffer starts in the Plugin's memory.
    buffers: [usize; 2],
    frames: usize,
    set_param: TypedFunc<(u32, f32), ()>,
    process: TypedFunc<u32, ()>,
    reset: TypedFunc<(), ()>,
    /// An Instrument's; an Effect has none.
    notes: Option<Notes>,
}

impl Hosted {
    /// Copy a block in, run `sc_process` on it, and copy it back.
    fn process_block(&mut self, left: &mut [f32], right: &mut [f32]) -> Result<(), PluginFault> {
        let frames = left.len();
        for (side, &start) in [&*left, &*right].into_iter().zip(&self.buffers) {
            let data = self.memory.data_mut(&mut self.store);
            let bytes = data.get_mut(start..start + frames * 4).ok_or(PluginFault)?;
            for (bytes, sample) in bytes.as_chunks_mut::<4>().0.iter_mut().zip(side) {
                bytes.copy_from_slice(&sample.to_le_bytes());
            }
        }
        self.store.set_epoch_deadline(DEADLINE_TICKS);
        self.process
            .call(&mut self.store, frames as u32)
            .map_err(|_| PluginFault)?;
        for (side, &start) in [left, right].into_iter().zip(&self.buffers) {
            let data = self.memory.data(&self.store);
            let bytes = data.get(start..start + frames * 4).ok_or(PluginFault)?;
            for (bytes, sample) in bytes.as_chunks::<4>().0.iter().zip(side.iter_mut()) {
                *sample = f32::from_le_bytes(*bytes);
            }
        }
        Ok(())
    }
}

impl PluginInstance for Hosted {
    fn set_param(&mut self, index: usize, value: f32) {
        self.store.set_epoch_deadline(DEADLINE_TICKS);
        // A Plugin that traps here traps again in `process`, which is where
        // the engine hears of it.
        let _ = self.set_param.call(&mut self.store, (index as u32, value));
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32]) -> Result<(), PluginFault> {
        let frames = self.frames;
        for (left, right) in left.chunks_mut(frames).zip(right.chunks_mut(frames)) {
            self.process_block(left, right)?;
        }
        Ok(())
    }

    fn reset(&mut self) {
        self.store.set_epoch_deadline(DEADLINE_TICKS);
        let _ = self.reset.call(&mut self.store, ());
    }

    fn note_on(&mut self, note: u8, velocity: f32) -> Result<(), PluginFault> {
        let Some(notes) = &self.notes else {
            return Ok(());
        };
        self.store.set_epoch_deadline(DEADLINE_TICKS);
        notes
            .on
            .call(&mut self.store, (note.into(), velocity))
            .map_err(|_| PluginFault)
    }

    fn note_off(&mut self, note: u8) -> Result<(), PluginFault> {
        let Some(notes) = &self.notes else {
            return Ok(());
        };
        self.store.set_epoch_deadline(DEADLINE_TICKS);
        notes
            .off
            .call(&mut self.store, note.into())
            .map_err(|_| PluginFault)
    }
}

fn func<P: wasmtime::WasmParams, R: wasmtime::WasmResults>(
    instance: &Instance,
    store: &mut Store<()>,
    name: &str,
) -> Result<TypedFunc<P, R>, String> {
    instance
        .get_typed_func(&mut *store, name)
        .map_err(|_| format!("The Plugin doesn't export `{name}` as ABI version 1 has it."))
}

fn call<P: wasmtime::WasmParams, R: wasmtime::WasmResults>(
    instance: &Instance,
    store: &mut Store<()>,
    name: &str,
    params: P,
) -> Result<R, String> {
    func::<P, R>(instance, store, name)?
        .call(&mut *store, params)
        .map_err(|error| format!("The Plugin failed in `{name}`: {error}"))
}

fn memory(instance: &Instance, store: &mut Store<()>) -> Result<Memory, String> {
    instance
        .get_memory(&mut *store, "memory")
        .ok_or_else(|| "The Plugin doesn't export its `memory`.".into())
}

/// A Plugin the Controller has compiled, by id, ready to instantiate for
/// each slot it goes in.
#[derive(Clone)]
pub struct LoadedPlugin {
    pub module: Compiled,
    pub manifest: Arc<PluginManifest>,
}

/// Compile a Plugin's `.wasm` for the engine, or say what is wrong with it.
pub fn load(wasm: &[u8]) -> Result<LoadedPlugin, String> {
    let (module, manifest) = runtime().load(wasm)?;
    Ok(LoadedPlugin {
        module,
        manifest: Arc::new(manifest),
    })
}

/// A Plugin installed in the Plugins folder, as the UI lists it.
#[derive(Debug, Serialize, PartialEq)]
pub struct Installed {
    /// The manifest as the engine reads it.
    pub manifest: String,
}

/// The Plugins folder inside the app's own data folder: each Plugin as
/// `<id>.wasm`, with its manifest beside it as `<id>.json` so listing them
/// doesn't compile each one.
pub fn folder(app_data: &Path) -> String {
    app_data.join("plugins").to_string_lossy().into_owned()
}

/// Install a Plugin: check that it loads, then keep it under its id,
/// replacing any version already installed.
pub fn install(folder: &str, wasm: &[u8]) -> Result<Installed, String> {
    let (_, manifest) = runtime().load(wasm)?;
    let id = &manifest.id;
    project_files::write_bytes(folder, &format!("{id}.wasm"), wasm)?;
    let manifest = manifest.to_json();
    project_files::write_text(folder, &format!("{id}.json"), &manifest)?;
    Ok(Installed { manifest })
}

/// Every installed Plugin, by id.
pub fn list(folder: &str) -> Result<Vec<Installed>, String> {
    let mut installed = Vec::new();
    for path in project_files::list_files(folder, "")? {
        if !path.ends_with(".json") {
            continue;
        }
        let text = project_files::read_text(folder, &path)?;
        // A manifest this app can't read is left out rather than failing
        // the whole list.
        if let Ok(manifest) = PluginManifest::parse(&text) {
            installed.push(Installed {
                manifest: manifest.to_json(),
            });
        }
    }
    Ok(installed)
}

/// An installed Plugin's `.wasm`, for the engine to load.
pub fn read(folder: &str, id: &str) -> Result<Vec<u8>, String> {
    let manifest =
        PluginManifest::parse(&project_files::read_text(folder, &format!("{id}.json"))?)?;
    project_files::read_bytes(folder, &format!("{}.wasm", manifest.id))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::OnceLock;
    use std::time::Instant;

    /// The test Plugins and the example Plugins, built for
    /// `wasm32-unknown-unknown` once per run: the test Effect's `.wasm`, the
    /// test Instrument's, the example bitcrusher's and the example
    /// wavetable's.
    ///
    /// They get their own target directory, named here, so the path they are
    /// read from holds whatever `CARGO_TARGET_DIR` says, and the nested build
    /// never waits on the lock of the `cargo test` running it.
    fn test_plugins() -> &'static [Vec<u8>; 4] {
        static WASM: OnceLock<[Vec<u8>; 4]> = OnceLock::new();
        WASM.get_or_init(|| {
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
            let target_dir = root.join("target/test-plugin");
            let status = Command::new(env!("CARGO"))
                .current_dir(&root)
                .args([
                    "build",
                    "-p",
                    "soundcheck-test-effect",
                    "-p",
                    "soundcheck-test-instrument",
                    "-p",
                    "soundcheck-example-bitcrusher",
                    "-p",
                    "soundcheck-example-wavetable",
                    "--target",
                    "wasm32-unknown-unknown",
                    "--release",
                    "--target-dir",
                ])
                .arg(&target_dir)
                .status()
                .expect("cargo runs");
            assert!(status.success(), "the test Plugins build");
            [
                "soundcheck_test_effect",
                "soundcheck_test_instrument",
                "soundcheck_example_bitcrusher",
                "soundcheck_example_wavetable",
            ]
            .map(|name| {
                std::fs::read(
                    target_dir.join(format!("wasm32-unknown-unknown/release/{name}.wasm")),
                )
                .expect("the test Plugin was built")
            })
        })
    }

    pub fn test_effect() -> &'static [u8] {
        &test_plugins()[0]
    }

    pub fn test_instrument() -> &'static [u8] {
        &test_plugins()[1]
    }

    /// `examples/plugins/bitcrusher`, built only against the SDK.
    fn example_bitcrusher() -> &'static [u8] {
        &test_plugins()[2]
    }

    /// `examples/plugins/wavetable`, built only against the SDK.
    fn example_wavetable() -> &'static [u8] {
        &test_plugins()[3]
    }

    /// An engine at 48 kHz and 120 BPM, whose one Instrument Track plays
    /// `note` for the first second on the example wavetable, a sine with no
    /// attack, at unity and centred. `master` is inserted on the Master.
    fn play_example_wavetable(note: f64, master: Option<(&[u8], &[f32])>) -> Vec<f32> {
        let sample_rate = 48_000.0;
        let plugin = load(example_wavetable()).unwrap();
        assert_eq!(plugin.manifest.id, "dev.soundcheck.example.wavetable");
        assert_eq!(plugin.manifest.kind, PluginKind::Instrument);
        let instance = runtime()
            .instantiate(&plugin.module, &plugin.manifest, sample_rate, MAX_FRAMES)
            .unwrap();
        let mut engine = soundcheck_engine::Engine::new(sample_rate);
        engine.set_tempo(120.0);
        engine.set_track_count(1);
        engine.set_track_notes(0, &[0.0, 1920.0, note, 1.0]);
        let instrument = soundcheck_engine::PreparedInstrument::plugin(plugin.manifest, instance);
        engine.swap_track_instrument(0, instrument);
        // shape, attack (ms), release (ms), level.
        engine.set_track_instrument_settings(0, &[0.0, 0.0, 200.0, 0.5]);
        if let Some((wasm, settings)) = master {
            let plugin = load(wasm).unwrap();
            assert_eq!(plugin.manifest.kind, PluginKind::Effect);
            let instance = runtime()
                .instantiate(&plugin.module, &plugin.manifest, sample_rate, MAX_FRAMES)
                .unwrap();
            let effect = soundcheck_engine::PreparedEffect::plugin(plugin.manifest, instance);
            assert!(engine.insert_prepared_effect(-1, 0, effect).is_ok());
            engine.set_effect_settings(-1, 0, settings);
        }
        let played = engine.render_range(0.0, 1920.0);
        played.iter().step_by(2).copied().collect()
    }

    /// The pitch of a sine at 48 kHz, from how often it rises through zero.
    fn pitch(samples: &[f32]) -> f64 {
        let rises = samples
            .windows(2)
            .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0);
        rises.count() as f64 * 48_000.0 / samples.len() as f64
    }

    #[test]
    fn the_example_wavetable_plays_the_notes_pitch_through_wasmtime() {
        for (note, hz) in [(69.0, 440.0), (57.0, 220.0), (72.0, 523.25)] {
            let played = play_example_wavetable(note, None);
            assert!(played.iter().any(|sample| sample.abs() > 0.1));
            let pitch = pitch(&played);
            assert!((pitch - hz).abs() < 1.5, "note {note} plays at {pitch} Hz");
        }
    }

    #[test]
    fn the_example_bitcrusher_quantises_the_master_through_wasmtime() {
        let on_a_level = |sample: &f32| (sample * 4.0).fract() == 0.0;
        let dry = play_example_wavetable(69.0, None);
        assert!(!dry.iter().all(on_a_level));
        // bits, hold (frames), mix: 3 bits is a multiple of 1/4.
        let crushed = play_example_wavetable(69.0, Some((example_bitcrusher(), &[3.0, 1.0, 1.0])));
        assert!(crushed.iter().all(on_a_level), "every sample is on a level");
        assert!(crushed.iter().any(|sample| sample.abs() >= 0.25));
        assert_ne!(crushed, dry);
    }

    fn expected() -> serde_json::Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/test-effect/expected-output.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// The test Plugin's expected output, rendered through wasmtime by the
    /// recipe beside it: the browser dev host's test renders it through
    /// `WebAssembly` against the same file.
    #[test]
    fn the_test_plugin_renders_its_expected_output_through_wasmtime() {
        let expected = expected();
        let number = |key: &str| expected[key].as_u64().unwrap() as usize;
        let block = number("blockFrames");
        let blocks = number("blocks");
        let [mut left, mut right] =
            soundcheck_test_effect::input(block * blocks, number("seed") as u32);

        let plugin = load(test_effect()).unwrap();
        assert_eq!(plugin.manifest.id, soundcheck_test_effect::ID);
        let mut instance = runtime()
            .instantiate(
                &plugin.module,
                &plugin.manifest,
                number("sampleRate") as f32,
                block,
            )
            .unwrap();
        let chunks = left.chunks_mut(block).zip(right.chunks_mut(block));
        for (index, (left, right)) in chunks.enumerate() {
            for change in expected["changes"].as_array().unwrap() {
                if change["block"].as_u64() == Some(index as u64) {
                    let setting = change["index"].as_u64().unwrap() as usize;
                    instance.set_param(setting, change["value"].as_f64().unwrap() as f32);
                }
            }
            instance.process(left, right).unwrap();
        }
        let side = |name: &str| -> Vec<u32> {
            let samples = expected[name].as_array().unwrap();
            samples
                .iter()
                .map(|s| (s.as_f64().unwrap() as f32).to_bits())
                .collect()
        };
        let bits = |side: &[f32]| side.iter().map(|s| s.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&left), side("left"), "sample for sample");
        assert_eq!(bits(&right), side("right"), "sample for sample");
    }

    /// The test Instrument's expected output: what the engine's Master plays
    /// when an Instrument Track plays its Pattern Clip, here with the
    /// Instrument running in wasmtime. The browser dev host's test plays it
    /// through `WebAssembly` against the same file.
    #[test]
    fn the_test_instrument_plays_its_expected_output_through_wasmtime() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/test-instrument/expected-output.json"
        );
        let expected: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let [left, right] = play_test_instrument(&expected);
        let side = |name: &str| -> Vec<u32> {
            let samples = expected[name].as_array().unwrap();
            samples
                .iter()
                .map(|s| (s.as_f64().unwrap() as f32).to_bits())
                .collect()
        };
        let bits = |side: &[f32]| side.iter().map(|s| s.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&left), side("left"), "sample for sample");
        assert_eq!(bits(&right), side("right"), "sample for sample");
    }

    /// Play the test Instrument's recipe, as its own test does natively: an
    /// Instrument Track, at unity and centred, playing the Pattern Clip
    /// from the top.
    fn play_test_instrument(recipe: &serde_json::Value) -> [Vec<f32>; 2] {
        let plugin = load(test_instrument()).unwrap();
        assert_eq!(plugin.manifest.id, soundcheck_test_instrument::ID);
        assert_eq!(plugin.manifest.kind, PluginKind::Instrument);
        let sample_rate = recipe["sampleRate"].as_f64().unwrap() as f32;
        let instance = runtime()
            .instantiate(&plugin.module, &plugin.manifest, sample_rate, MAX_FRAMES)
            .unwrap();
        let mut engine = soundcheck_engine::Engine::new(sample_rate);
        engine.set_tempo(recipe["tempo"].as_f64().unwrap());
        engine.set_track_count(1);
        let clip = &recipe["clip"];
        let number = |value: &serde_json::Value| value.as_f64().unwrap();
        let (start, length) = (number(&clip["start"]), number(&clip["length"]));
        let notes: Vec<f64> = clip["notes"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|note| {
                let at = number(&note["start"]);
                let long = number(&note["length"]).min(length - at);
                [
                    start + at,
                    long,
                    number(&note["pitch"]),
                    number(&note["velocity"]),
                ]
            })
            .collect();
        engine.set_track_notes(0, &notes);
        let settings: Vec<f32> = plugin
            .manifest
            .settings
            .iter()
            .map(|setting| number(&recipe["settings"][&setting.name]) as f32)
            .collect();
        let instrument = soundcheck_engine::PreparedInstrument::plugin(plugin.manifest, instance);
        engine.swap_track_instrument(0, instrument);
        engine.set_track_instrument_settings(0, &settings);
        let played = engine.render_range(0.0, number(&recipe["ticks"]));
        let left = played.iter().step_by(2).copied().collect();
        let right = played.iter().skip(1).step_by(2).copied().collect();
        [left, right]
    }

    #[test]
    fn an_instrument_without_its_note_exports_is_refused_with_why() {
        let instrument = RUNAWAY
            .replace(r#"\"kind\":\"effect\""#, r#"\"kind\":\"instrument\""#)
            .replace("i32.const 86", "i32.const 90");
        let wasm = wat::parse_str(&instrument).unwrap();
        let error = load(&wasm).err().unwrap();
        assert!(error.contains("sc_note_on"), "{error}");
        let with_notes = instrument.replace(
            "(func (export \"sc_reset\"))",
            "(func (export \"sc_reset\")) (func (export \"sc_note_on\") (param i32 f32)) (func (export \"sc_note_off\") (param i32))",
        );
        let plugin = load(&wat::parse_str(with_notes).unwrap()).unwrap();
        assert_eq!(plugin.manifest.kind, PluginKind::Instrument);
    }

    /// A Plugin whose `sc_process` never returns.
    const RUNAWAY: &str = r#"(module
        (memory (export "memory") 1)
        (data (i32.const 0) "{\"id\":\"dev.test.runaway\",\"version\":\"1\",\"kind\":\"effect\",\"name\":\"Runaway\",\"settings\":[]}")
        (func (export "sc_abi_version") (result i32) i32.const 1)
        (func (export "sc_manifest") (result i32) i32.const 0)
        (func (export "sc_manifest_len") (result i32) i32.const 86)
        (func (export "sc_init") (param f32 i32) (result i32) i32.const 0)
        (func (export "sc_buffer") (param i32) (result i32)
            local.get 0 i32.const 16384 i32.mul i32.const 1024 i32.add)
        (func (export "sc_set_param") (param i32 f32))
        (func (export "sc_process") (param i32) (loop $forever br $forever))
        (func (export "sc_reset")))"#;

    #[test]
    fn a_runaway_plugin_is_stopped_instead_of_stalling_the_audio() {
        let wasm = wat::parse_str(RUNAWAY).unwrap();
        let plugin = load(&wasm).unwrap();
        let mut instance = runtime()
            .instantiate(&plugin.module, &plugin.manifest, 48_000.0, 128)
            .unwrap();
        let (mut left, mut right) = (vec![0.5; 128], vec![0.5; 128]);
        let started = Instant::now();
        assert_eq!(instance.process(&mut left, &mut right), Err(PluginFault));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_module_that_isnt_a_plugin_is_refused_with_why() {
        assert!(load(b"not wasm").err().unwrap().contains("WebAssembly"));
        let wrong_version = RUNAWAY.replace(
            "(func (export \"sc_abi_version\") (result i32) i32.const 1)",
            "(func (export \"sc_abi_version\") (result i32) i32.const 2)",
        );
        let error = load(&wat::parse_str(wrong_version).unwrap()).err().unwrap();
        assert!(error.contains("ABI version 2"), "{error}");
        let imports = wat::parse_str(r#"(module (import "env" "clock" (func)))"#).unwrap();
        assert!(load(&imports).err().unwrap().contains("import"));
    }

    #[test]
    fn a_plugin_is_installed_listed_and_read_back() {
        let app_data = tempfile::TempDir::new().unwrap();
        let plugins = folder(app_data.path());
        assert_eq!(list(&plugins).unwrap(), []);
        let installed = install(&plugins, test_effect()).unwrap();
        assert!(
            installed
                .manifest
                .contains(r#""id":"dev.soundcheck.test.effect""#)
        );
        assert_eq!(list(&plugins).unwrap(), [installed]);
        assert_eq!(
            read(&plugins, soundcheck_test_effect::ID).unwrap(),
            test_effect()
        );
        assert!(install(&plugins, b"not wasm").is_err());
        assert_eq!(list(&plugins).unwrap().len(), 1);
        assert!(read(&plugins, "../elsewhere").is_err());
    }
}

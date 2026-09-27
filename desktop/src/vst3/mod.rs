//! Hosting **VST3 Plugins** (ADR 0008): each one runs in a helper process of
//! its own, `soundcheck-vst3-host`, built from `desktop/vst3-host` against
//! Steinberg's VST3 SDK and shipped beside the app. A Plugin that crashes or
//! hangs takes only its helper down; the song plays on without it.
//!
//! The registry here holds the live instances, one helper each, by a key the
//! UI chooses (the Effect's id, or the Track's for an Instrument). The
//! engine's slots reach them through `EngineCommand::InsertVst3` and
//! `SetTrackVst3`; an export or Audio Analysis gets copies of its own, in
//! helpers started for it in offline mode from the live instance's state.
//!
//! VST is a registered trademark of Steinberg Media Technologies GmbH.

pub mod commands;
pub mod instance;
pub mod moduleinfo;
pub mod process;
pub mod protocol;
pub mod scan;
pub mod shared;

use std::cell::Cell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use soundcheck_engine::{
    MAX_PLUGIN_SETTINGS, PluginInstance, PluginKind, PluginManifest, PluginSetting,
};

use self::instance::Vst3Instance;
use self::process::{Audio, Control, Deadlines, Editor, Kind, Mode, Param, State};
use crate::host::MAX_BLOCK;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// --- The audio callback's deadline -------------------------------------------

thread_local! {
    static DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// When the audio callback now running must have its output ready by, set
/// on the audio thread at the start of each callback. Every VST3 Plugin's
/// blocks in it wait for their helpers until then at the latest, one after
/// another, so however many are late the callback never is. Per thread: an
/// export's renders never see the audio device's.
pub fn set_block_deadline(deadline: Option<Instant>) {
    DEADLINE.with(|cell| cell.set(deadline));
}

fn block_deadline() -> Option<Instant> {
    DEADLINE.with(Cell::get)
}

// --- The helper --------------------------------------------------------------

/// The helper's file name on this platform.
pub const HELPER: &str = if cfg!(windows) {
    "soundcheck-vst3-host.exe"
} else {
    "soundcheck-vst3-host"
};

static HELPER_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Says where the helper is, for good: the app's setup does, from where
/// Tauri put its sidecar.
pub fn set_helper(path: PathBuf) {
    let _ = HELPER_PATH.set(path);
}

/// Where the helper is: where `set_helper` said; `SOUNDCHECK_VST3_HELPER` if
/// set; beside the app, where the installer puts it; or, in a development
/// build, where `pnpm vst3:build` does.
pub fn helper() -> Result<PathBuf, String> {
    if let Some(path) = HELPER_PATH.get() {
        return Ok(path.clone());
    }
    if let Some(path) = std::env::var_os("SOUNDCHECK_VST3_HELPER") {
        return Ok(PathBuf::from(path));
    }
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|folder| folder.join(HELPER)));
    let built = cfg!(debug_assertions).then(|| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("vst3-host/build/bin")
            .join(HELPER)
    });
    [beside, built]
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "The VST3 helper isn't installed beside the app: reinstall Soundcheck, or in a \
             development build run pnpm vst3:build"
                .to_string()
        })
}

// --- What the UI hears -------------------------------------------------------

/// Something that happened in a Plugin's own window, as its helper told it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Notice {
    /// The musician took hold of setting `id`.
    Begin { id: u32 },
    /// And moved it to `value`, normalised.
    Edit { id: u32, value: f64 },
    /// And let it go.
    End { id: u32 },
    /// The Plugin changed its settings' values or titles all at once, as
    /// loading one of its own presets does.
    Restart { flags: i32 },
    /// The musician closed the window, which was at `x`, `y` on screen.
    Closed { x: i32, y: i32 },
}

fn parse_notice(fields: &[String]) -> Option<Notice> {
    let number = |i: usize| fields.get(i)?.parse().ok();
    Some(match fields.first()?.as_str() {
        "begin" => Notice::Begin { id: number(1)? },
        "edit" => Notice::Edit {
            id: number(1)?,
            value: fields.get(2)?.parse().ok()?,
        },
        "end" => Notice::End { id: number(1)? },
        "restart" => Notice::Restart {
            flags: fields.get(1)?.parse().ok()?,
        },
        "closed" => Notice::Closed {
            x: fields.get(1)?.parse().ok()?,
            y: fields.get(2)?.parse().ok()?,
        },
        _ => return None,
    })
}

/// The most notices kept for the UI between two polls, per instance: a
/// window left open with the UI not polling can't grow them for ever.
const MAX_NOTICES: usize = 4_096;

/// One setting the Plugin exposes, as the UI and the Assistant see it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    /// The Plugin's ParamID.
    pub id: u32,
    /// The engine's name for it, and the Project's: `p<id>`.
    pub name: String,
    /// The Plugin's own title for it.
    pub label: String,
    pub unit: String,
    /// Normalised, 0 to 1, as are the rest.
    pub default: f64,
    /// 0 for continuous; otherwise how many steps it has, less one.
    pub steps: i32,
    pub value: f64,
}

/// A loaded instance, as `vst3_load` tells the UI of it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub key: String,
    /// Which load of `key` this is: each load's is new, so the UI can tell
    /// the engine's slot to take this one.
    pub generation: u32,
    pub kind: Kind,
    /// Its automatable settings, the first `MAX_PLUGIN_SETTINGS` of them:
    /// all that Automation and the Assistant can reach.
    pub settings: Vec<Setting>,
    /// Its own window, if it has one.
    pub editor: Option<Editor>,
}

/// What the UI asks to load.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadRequest {
    pub key: String,
    pub bundle: PathBuf,
    /// Its class id, 32 hex digits.
    pub cid: String,
    pub name: String,
    pub version: String,
    pub sample_rate: f64,
    /// The state the Project saved, to restore; none for a new instance.
    pub state: Option<State>,
}

/// What a poll finds: each instance's window notices since the last poll,
/// and the instances whose helper has gone.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Polled {
    pub notices: Vec<(String, Notice)>,
    pub gone: Vec<String>,
}

// --- The registry ------------------------------------------------------------

/// One live instance: its helper and what the engine needs to host it.
struct Instance {
    request: LoadRequest,
    generation: u32,
    sample_rate: f64,
    kind: Kind,
    control: Mutex<Control>,
    audio: Audio,
    manifest: Arc<PluginManifest>,
    ids: Vec<u32>,
    notices: Arc<Mutex<Vec<Notice>>>,
}

/// What a slot needs to host an instance.
pub struct Hosted {
    pub manifest: Arc<PluginManifest>,
    pub instance: Box<dyn PluginInstance>,
    /// Where each setting in the manifest is now.
    pub values: Vec<f32>,
}

/// The live instances, by key.
#[derive(Default)]
pub struct Registry {
    instances: Mutex<HashMap<String, Arc<Instance>>>,
    generations: AtomicU32,
}

static REGISTRY: LazyLock<Registry> = LazyLock::new(Registry::default);

/// The app's registry.
pub fn registry() -> &'static Registry {
    &REGISTRY
}

/// The engine's manifest for a Plugin with `params`: its automatable
/// settings, the first `MAX_PLUGIN_SETTINGS` of them, each normalised.
fn manifest(request: &LoadRequest, kind: Kind, params: &[Param]) -> (PluginManifest, Vec<Setting>) {
    let settings: Vec<Setting> = params
        .iter()
        .filter(|param| param.can_automate())
        .take(MAX_PLUGIN_SETTINGS)
        .map(|param| Setting {
            id: param.id,
            name: format!("p{}", param.id),
            label: param.title.clone(),
            unit: param.units.clone(),
            default: param.default,
            steps: param.steps,
            value: param.value,
        })
        .collect();
    let manifest = PluginManifest {
        id: format!("vst3.{}", request.cid.to_ascii_lowercase()),
        version: request.version.clone(),
        kind: match kind {
            Kind::Effect => PluginKind::Effect,
            Kind::Instrument => PluginKind::Instrument,
        },
        name: request.name.clone(),
        settings: settings
            .iter()
            .map(|setting| PluginSetting {
                name: setting.name.clone(),
                label: setting.label.clone(),
                unit: setting.unit.clone(),
                min: 0.0,
                max: 1.0,
                default: setting.default as f32,
                step: if setting.steps > 0 {
                    1.0 / setting.steps as f32
                } else {
                    0.0
                },
            })
            .collect(),
    };
    (manifest, settings)
}

/// A helper with `request`'s Plugin loaded in `mode` at `sample_rate`, its
/// state restored if there is one. Its notices go to `notices`.
fn start(
    request: &LoadRequest,
    sample_rate: f64,
    mode: Mode,
    notices: Option<Arc<Mutex<Vec<Notice>>>>,
) -> Result<(Control, Kind, Vec<Param>), String> {
    let helper = helper()?;
    let mut control = Control::spawn(&helper, Deadlines::default(), move |fields| {
        if let (Some(notices), Some(notice)) = (&notices, parse_notice(&fields)) {
            let mut notices = lock(notices);
            if notices.len() < MAX_NOTICES {
                notices.push(notice);
            }
        }
    })
    .map_err(|why| why.to_string())?;
    let name = &request.name;
    let loaded = control
        .load(&request.bundle, &request.cid, sample_rate, MAX_BLOCK, mode)
        .map_err(|why| format!("{name} wouldn't load: {why}"))?;
    if let Some(state) = &request.state {
        control
            .set_state(state)
            .map_err(|why| format!("{name} wouldn't take its saved state: {why}"))?;
    }
    let params = control
        .params()
        .map_err(|why| format!("{name} wouldn't list its settings: {why}"))?;
    Ok((control, loaded.kind, params))
}

impl Registry {
    /// Loads `request`'s Plugin into a new helper, replacing any instance
    /// already under its key. Blocks for as long as the Plugin takes to load,
    /// up to a minute: call it off the UI's thread.
    pub fn load(&self, request: LoadRequest) -> Result<Summary, String> {
        let generation = self.generations.fetch_add(1, Ordering::Relaxed) + 1;
        let (summary, instance) = self.start_instance(request, generation, None)?;
        let old = lock(&self.instances).insert(summary.key.clone(), Arc::new(instance));
        drop(old);
        Ok(summary)
    }

    fn start_instance(
        &self,
        request: LoadRequest,
        generation: u32,
        sample_rate: Option<f64>,
    ) -> Result<(Summary, Instance), String> {
        let rate = sample_rate.unwrap_or(request.sample_rate);
        let notices = Arc::new(Mutex::new(Vec::new()));
        let (mut control, kind, params) =
            start(&request, rate, Mode::Realtime, Some(Arc::clone(&notices)))?;
        let (manifest, settings) = manifest(&request, kind, &params);
        let editor = control.editor().ok();
        let audio = control.audio(Mode::Realtime);
        let summary = Summary {
            key: request.key.clone(),
            generation,
            kind,
            settings: settings.clone(),
            editor,
        };
        let instance = Instance {
            request,
            generation,
            sample_rate: rate,
            kind,
            control: Mutex::new(control),
            audio,
            manifest: Arc::new(manifest),
            ids: settings.iter().map(|setting| setting.id).collect(),
            notices,
        };
        Ok((summary, instance))
    }

    fn get(&self, key: &str) -> Option<Arc<Instance>> {
        lock(&self.instances).get(key).cloned()
    }

    fn with_control<T>(
        &self,
        key: &str,
        run: impl FnOnce(&mut Control) -> Result<T, protocol::Failure>,
    ) -> Result<T, String> {
        let instance = self
            .get(key)
            .ok_or_else(|| format!("No VST3 Plugin is loaded as {key}"))?;
        let mut control = lock(&instance.control);
        run(&mut control).map_err(|why| format!("{}: {why}", instance.request.name))
    }

    /// Stops `key`'s helper and forgets it.
    pub fn unload(&self, key: &str) {
        let old = lock(&self.instances).remove(key);
        drop(old);
    }

    /// The keys of every instance, for the UI to match against its Project.
    pub fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = lock(&self.instances).keys().cloned().collect();
        keys.sort();
        keys
    }

    /// The Plugin's state now, for the Project.
    pub fn state(&self, key: &str) -> Result<State, String> {
        self.with_control(key, Control::get_state)
    }

    /// Every setting the Plugin exposes and where it is now, as `Summary`
    /// has them, after the Plugin has changed them all at once.
    pub fn settings(&self, key: &str) -> Result<Vec<Setting>, String> {
        let instance = self
            .get(key)
            .ok_or_else(|| format!("No VST3 Plugin is loaded as {key}"))?;
        let params = lock(&instance.control)
            .params()
            .map_err(|why| why.to_string())?;
        let (_, settings) = manifest(&instance.request, instance.kind, &params);
        Ok(settings)
    }

    /// The Plugin's own words for setting `id` at `value`.
    pub fn text(&self, key: &str, id: u32, value: f64) -> Result<String, String> {
        self.with_control(key, |control| control.text(id, value))
    }

    pub fn open_editor(
        &self,
        key: &str,
        title: &str,
        owner: u64,
        at: Option<(i32, i32)>,
    ) -> Result<(), String> {
        self.with_control(key, |control| control.open_editor(title, owner, at))
    }

    pub fn close_editor(&self, key: &str) -> Result<(i32, i32), String> {
        self.with_control(key, Control::close_editor)
    }

    /// Every instance's notices since the last poll, and which have gone.
    /// A helper that has gone is reaped here.
    pub fn poll(&self) -> Polled {
        let instances: Vec<Arc<Instance>> = lock(&self.instances).values().cloned().collect();
        let mut polled = Polled::default();
        for instance in instances {
            let key = &instance.request.key;
            polled.notices.extend(
                std::mem::take(&mut *lock(&instance.notices))
                    .into_iter()
                    .map(|notice| (key.clone(), notice)),
            );
            if instance.audio.has_gone() {
                polled.gone.push(key.clone());
                if let Ok(mut control) = instance.control.try_lock() {
                    control.kill();
                }
            }
        }
        polled.gone.sort();
        polled
    }

    /// What an engine slot needs to host `key`'s instance, if it is loaded
    /// as `generation` and is a `kind`. A live slot gets the live instance,
    /// loaded again first if the audio device now runs at another rate; an
    /// offline one gets a copy of its own, in a helper started for it.
    pub fn hosted(
        &self,
        key: &str,
        generation: u32,
        kind: PluginKind,
        sample_rate: f32,
        mode: Mode,
    ) -> Option<Hosted> {
        let mut instance = self.get(key).filter(|i| i.generation == generation)?;
        if instance.manifest.kind != kind {
            return None;
        }
        let rate = f64::from(sample_rate);
        if mode == Mode::Offline {
            return offline_copy(&instance, rate);
        }
        if (instance.sample_rate - rate).abs() > 0.5 {
            instance = self.reload_at(&instance, rate)?;
        }
        let params = lock(&instance.control).params().ok()?;
        Some(Hosted {
            manifest: Arc::clone(&instance.manifest),
            instance: Box::new(Vst3Instance::new(
                instance.audio.clone(),
                instance.ids.clone(),
                rate,
                None,
            )),
            values: values(&instance.ids, &params),
        })
    }

    /// `instance` in a new helper at `rate`, from its state now.
    fn reload_at(&self, instance: &Instance, rate: f64) -> Option<Arc<Instance>> {
        let state = lock(&instance.control).get_state().ok();
        let mut request = instance.request.clone();
        request.state = state.or(request.state);
        let (_, fresh) = self
            .start_instance(request, instance.generation, Some(rate))
            .ok()?;
        let fresh = Arc::new(fresh);
        let mut instances = lock(&self.instances);
        let key = &instance.request.key;
        // Unless it was loaded afresh meanwhile.
        if instances
            .get(key)
            .is_some_and(|i| i.generation == instance.generation)
        {
            instances.insert(key.clone(), Arc::clone(&fresh));
        }
        Some(fresh)
    }
}

/// Where each of `ids` is in `params`, normalised.
fn values(ids: &[u32], params: &[Param]) -> Vec<f32> {
    ids.iter()
        .map(|id| {
            params
                .iter()
                .find(|param| param.id == *id)
                .map_or(0.0, |param| param.value as f32)
        })
        .collect()
}

/// A copy of `instance` for an offline render at `rate`, in a helper of its
/// own that goes when the copy does.
fn offline_copy(instance: &Instance, rate: f64) -> Option<Hosted> {
    let mut request = instance.request.clone();
    request.state = lock(&instance.control).get_state().ok().or(request.state);
    let (control, _, params) = start(&request, rate, Mode::Offline, None).ok()?;
    let audio = control.audio(Mode::Offline);
    Some(Hosted {
        manifest: Arc::clone(&instance.manifest),
        values: values(&instance.ids, &params),
        instance: Box::new(Vst3Instance::new(
            audio,
            instance.ids.clone(),
            rate,
            Some(control),
        )),
    })
}

#[cfg(test)]
pub(crate) mod hosted;

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(text: &str) -> Vec<String> {
        protocol::fields(text)
    }

    #[test]
    fn a_notice_is_what_happened_in_the_window() {
        assert_eq!(
            parse_notice(&fields("begin\t3")),
            Some(Notice::Begin { id: 3 })
        );
        assert_eq!(
            parse_notice(&fields("edit\t3\t0.25")),
            Some(Notice::Edit { id: 3, value: 0.25 })
        );
        assert_eq!(parse_notice(&fields("end\t3")), Some(Notice::End { id: 3 }));
        assert_eq!(
            parse_notice(&fields("restart\t1")),
            Some(Notice::Restart { flags: 1 })
        );
        assert_eq!(
            parse_notice(&fields("closed\t-10\t20")),
            Some(Notice::Closed { x: -10, y: 20 })
        );
        assert_eq!(parse_notice(&fields("edit\t3")), None);
        assert_eq!(parse_notice(&fields("wave")), None);
    }

    #[test]
    fn the_manifest_is_the_first_64_automatable_settings_normalised() {
        let param = |id, flags, steps| Param {
            id,
            title: format!("Knob {id}"),
            units: "dB".into(),
            default: 0.5,
            steps,
            flags,
            value: 0.25,
        };
        let mut params = vec![
            param(7, 1, 0),
            param(8, 0, 0),
            param(9, 1 | 16, 0),
            param(10, 1, 4),
        ];
        params.extend((100..200).map(|id| param(id, 1, 0)));
        let request = LoadRequest {
            key: "fx1".into(),
            bundle: "/x.vst3".into(),
            cid: "ABCDEF".into(),
            name: "Tilt".into(),
            version: "1.2".into(),
            sample_rate: 48_000.0,
            state: None,
        };
        let (manifest, settings) = manifest(&request, Kind::Instrument, &params);
        assert_eq!(manifest.id, "vst3.abcdef");
        assert_eq!(manifest.kind, PluginKind::Instrument);
        assert_eq!(manifest.name, "Tilt");
        assert_eq!(manifest.settings.len(), MAX_PLUGIN_SETTINGS);
        assert_eq!(settings.len(), MAX_PLUGIN_SETTINGS);
        assert_eq!(settings[0].name, "p7");
        assert_eq!(settings[1].name, "p10", "not the fixed or hidden ones");
        let stepped = &manifest.settings[1];
        assert_eq!((stepped.min, stepped.max, stepped.step), (0.0, 1.0, 0.25));
        assert_eq!(stepped.label, "Knob 10");
        assert_eq!(manifest.settings[0].step, 0.0);
        assert_eq!(values(&[10, 7, 99], &params), [0.25, 0.25, 0.0]);
    }

    #[test]
    fn the_block_deadline_is_what_the_callback_set() {
        let at = Instant::now() + std::time::Duration::from_millis(3);
        set_block_deadline(Some(at));
        assert_eq!(block_deadline(), Some(at));
        std::thread::spawn(|| assert_eq!(block_deadline(), None))
            .join()
            .unwrap();
        set_block_deadline(None);
        assert_eq!(block_deadline(), None);
    }
}

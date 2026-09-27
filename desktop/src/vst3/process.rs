//! One VST3 Plugin, running in a helper process of its own (ADR 0008).
//!
//! A helper has two halves here. `Control` is the slow one: it loads the
//! Plugin, lists its settings, fetches and restores its state and opens its
//! window, one command at a time, each with a deadline. `Audio` is the audio
//! thread's: it runs one block at a time through the shared memory and never
//! waits past the block's deadline. A Plugin that is late for a block has it
//! bypassed; one that stays late is taken as hung and killed; one that has
//! crashed is known at once. None of them can stall or take down the song.

use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use soundcheck_engine::PluginBlock;

use super::moduleinfo::Class;
use super::protocol::{self, Failure, Lines, Reply};
use super::shared::{self, Event, MAX_EVENTS, MAX_FRAMES, MAX_PARAM_CHANGES, ParamChange, Shared};

/// How long each kind of wait may take. A block's own deadline is its
/// caller's.
#[derive(Clone, Copy, Debug)]
pub struct Deadlines {
    /// How long a Plugin may stay late before it is taken as hung and
    /// killed.
    pub hang: Duration,
    /// Settings, state and the window.
    pub command: Duration,
    /// Loading, which is where copy protection runs, and may show a dialog.
    pub load: Duration,
}

impl Default for Deadlines {
    fn default() -> Self {
        Self {
            hang: Duration::from_millis(500),
            command: Duration::from_secs(5),
            load: Duration::from_secs(60),
        }
    }
}

/// Whether the helper runs blocks against the audio device's clock, or as
/// fast as it can for an export or Audio Analysis, where no block is ever
/// late and a Plugin is told it is rendering offline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Realtime,
    Offline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Effect,
    Instrument,
}

/// What `load` found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Loaded {
    pub kind: Kind,
    /// Channels on its main input, 0 for most Instruments.
    pub inputs: u32,
    pub outputs: u32,
}

/// One setting the Plugin exposes: all the Assistant can ever reach of it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    pub id: u32,
    pub title: String,
    pub units: String,
    /// Normalised, 0 to 1.
    pub default: f64,
    /// 0 for continuous; otherwise how many steps it has, less one.
    pub steps: i32,
    pub flags: i32,
    /// Where it is now, normalised.
    pub value: f64,
}

impl Param {
    const CAN_AUTOMATE: i32 = 1;
    const READ_ONLY: i32 = 1 << 1;
    const HIDDEN: i32 = 1 << 4;

    /// A setting that can be automated, and so changed by Automation or the
    /// Assistant.
    pub fn can_automate(&self) -> bool {
        self.flags & Self::CAN_AUTOMATE != 0 && self.flags & (Self::READ_ONLY | Self::HIDDEN) == 0
    }
}

/// A Plugin's state, as the Plugin gives it: two opaque blobs, one for its
/// processor and one for its controller. The Project keeps each as base64.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    #[serde(with = "base64_bytes")]
    pub component: Vec<u8>,
    #[serde(with = "base64_bytes")]
    pub controller: Vec<u8>,
}

mod base64_bytes {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        STANDARD.decode(text).map_err(serde::de::Error::custom)
    }
}

/// What the Plugin's own window needs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    pub width: u32,
    pub height: u32,
    pub resizable: bool,
    /// The kinds of native window it can be attached to: `HWND`, `NSView`,
    /// `X11EmbedWindowID`.
    pub platforms: Vec<String>,
}

/// Starts a helper process with nothing loaded yet. Its stderr, where the
/// Plugin's own printing goes too, is kept only with
/// `SOUNDCHECK_VST3_VERBOSE` set.
fn start(helper: &Path, shm: Option<&str>) -> std::io::Result<Child> {
    let mut command = Command::new(helper);
    if let Some(name) = shm {
        command.arg("--shm").arg(name);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A console program, started by a windowed one: no console flashes.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let verbose = std::env::var_os("SOUNDCHECK_VST3_VERBOSE").is_some();
    let child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if verbose {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .spawn()?;
    // A licence or activation dialog the Plugin opens as it loads may come
    // to the front, as the Desktop App's own windows may.
    #[cfg(windows)]
    // SAFETY: a plain call with the id of a process we just started.
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(child.id());
    }
    Ok(child)
}

/// The helper's first line: `ok soundcheck-vst3-host <version> <size>`.
fn greeting(lines: &Lines, timeout: Duration) -> Result<(u32, usize), Failure> {
    let reply = lines.reply(timeout)?;
    match reply.ok.as_slice() {
        [name, version, size] if name == "soundcheck-vst3-host" => {
            Ok((version.parse().unwrap_or(0), size.parse().unwrap_or(0)))
        }
        _ => Err(Failure::Refused("that isn't soundcheck-vst3-host".into())),
    }
}

/// What both halves share.
struct Process {
    child: Mutex<Child>,
    shared: Shared,
    gone: AtomicBool,
}

impl Process {
    fn has_gone(&self) -> bool {
        self.gone.load(Ordering::Acquire)
    }

    /// Stops the helper at once, whatever it is doing, without waiting for
    /// it to end: safe on the audio thread, which never waits for the lock
    /// either. Should the lock be held, the helper is marked gone anyway,
    /// and `Control` kills it.
    fn stop(&self) {
        self.gone.store(true, Ordering::Release);
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.kill();
        }
    }

    /// Stops the helper and waits until it has ended.
    fn kill(&self) {
        self.gone.store(true, Ordering::Release);
        let mut child = self.child.lock().unwrap_or_else(PoisonError::into_inner);
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The helper's control half: one command at a time, never from the audio
/// thread.
pub struct Control {
    process: Arc<Process>,
    stdin: ChildStdin,
    lines: Lines,
    deadlines: Deadlines,
    pid: u32,
}

impl Control {
    /// A new helper process, ready to `load` a Plugin. `on_notice` hears
    /// what happens in the Plugin's own window, on the helper's pipe thread.
    pub fn spawn(
        helper: &Path,
        deadlines: Deadlines,
        on_notice: impl FnMut(Vec<String>) + Send + 'static,
    ) -> Result<Self, Failure> {
        let shared = Shared::create().map_err(|e| Failure::Refused(e.to_string()))?;
        let mut child = start(helper, Some(shared.name())).map_err(|e| {
            Failure::Refused(format!(
                "the VST3 helper {} wouldn't start: {e}",
                helper.display()
            ))
        })?;
        let pid = child.id();
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let process = Arc::new(Process {
            child: Mutex::new(child),
            shared,
            gone: AtomicBool::new(false),
        });
        let lines = {
            let process = Arc::clone(&process);
            Lines::spawn(stdout, on_notice, move || {
                process.gone.store(true, Ordering::Release);
                // Wake the audio thread now, rather than at its deadline.
                process.shared.post_done();
            })
        };
        let control = Self {
            process,
            stdin,
            lines,
            deadlines,
            pid,
        };
        let (version, size) = greeting(&control.lines, deadlines.command)?;
        if version != shared::VERSION || size != shared::SIZE {
            return Err(Failure::Refused(format!(
                "the VST3 helper's shared memory is version {version}, {size} bytes; the app's is version {}, {} bytes",
                shared::VERSION,
                shared::SIZE
            )));
        }
        // The helper has it mapped, so its name can go.
        control.process.shared.unlink();
        Ok(control)
    }

    /// The helper's process id.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Whether the helper has gone, for any reason: crashed, killed for
    /// hanging, or quit.
    pub fn has_gone(&self) -> bool {
        self.process.has_gone()
    }

    fn call(&mut self, fields: &[&str], timeout: Duration) -> Result<Reply, Failure> {
        if self.has_gone() {
            // The audio thread may have marked it without getting the lock
            // to kill it.
            self.process.kill();
            return Err(Failure::Gone);
        }
        protocol::send(&mut self.stdin, fields)?;
        match self.lines.reply(timeout) {
            // A helper that doesn't answer is hung; it has to go, or its
            // late answer would be taken for the next command's.
            Err(Failure::TimedOut) => {
                self.process.kill();
                Err(Failure::TimedOut)
            }
            other => other,
        }
    }

    /// Loads class `cid` of `bundle` and starts it processing.
    pub fn load(
        &mut self,
        bundle: &Path,
        cid: &str,
        sample_rate: f64,
        max_frames: usize,
        mode: Mode,
    ) -> Result<Loaded, Failure> {
        let bundle = bundle.to_string_lossy();
        let rate = sample_rate.to_string();
        let frames = max_frames.min(MAX_FRAMES).to_string();
        let mode = match mode {
            Mode::Realtime => "realtime",
            Mode::Offline => "offline",
        };
        let reply = self.call(
            &["load", &bundle, cid, &rate, &frames, mode],
            self.deadlines.load,
        )?;
        match reply.ok.as_slice() {
            [kind, inputs, outputs] => Ok(Loaded {
                kind: if kind == "instrument" {
                    Kind::Instrument
                } else {
                    Kind::Effect
                },
                inputs: inputs.parse().unwrap_or(0),
                outputs: outputs.parse().unwrap_or(0),
            }),
            _ => Err(Failure::Refused(
                "load gave an answer the app can't read".into(),
            )),
        }
    }

    /// Every setting the Plugin exposes, and where each is now.
    pub fn params(&mut self) -> Result<Vec<Param>, Failure> {
        let reply = self.call(&["params"], self.deadlines.command)?;
        Ok(reply
            .lines
            .iter()
            .filter_map(|line| parse_param(line))
            .collect())
    }

    /// The Plugin's own words for setting `id` at `value`, such as "-6.0 dB".
    pub fn text(&mut self, id: u32, value: f64) -> Result<String, Failure> {
        let reply = self.call(
            &["text", &id.to_string(), &value.to_string()],
            self.deadlines.command,
        )?;
        Ok(reply.ok.join(" "))
    }

    /// Tells the Plugin's controller, the side its window reads, a setting's
    /// new value. Its processor hears of it in the next block's changes.
    pub fn set_on_controller(&mut self, id: u32, value: f64) -> Result<(), Failure> {
        self.call(
            &["set", &id.to_string(), &value.to_string()],
            self.deadlines.command,
        )
        .map(drop)
    }

    pub fn get_state(&mut self) -> Result<State, Failure> {
        let reply = self.call(&["get-state"], self.deadlines.command)?;
        let bad = || Failure::Refused("the state isn't hex".into());
        match reply.ok.as_slice() {
            [component, controller] => Ok(State {
                component: protocol::from_hex(component).ok_or_else(bad)?,
                controller: protocol::from_hex(controller).ok_or_else(bad)?,
            }),
            [component] => Ok(State {
                component: protocol::from_hex(component).ok_or_else(bad)?,
                controller: Vec::new(),
            }),
            _ => Err(bad()),
        }
    }

    pub fn set_state(&mut self, state: &State) -> Result<(), Failure> {
        let component = protocol::to_hex(&state.component);
        let controller = protocol::to_hex(&state.controller);
        self.call(
            &["set-state", &component, &controller],
            self.deadlines.command,
        )
        .map(drop)
    }

    /// What the Plugin's own window would need, or why it has none.
    pub fn editor(&mut self) -> Result<Editor, Failure> {
        let reply = self.call(&["editor"], self.deadlines.command)?;
        match reply.ok.as_slice() {
            [width, height, resizable, platforms] => Ok(Editor {
                width: width.parse().unwrap_or(0),
                height: height.parse().unwrap_or(0),
                resizable: resizable == "resizable",
                platforms: platforms
                    .split(',')
                    .filter(|p| !p.is_empty())
                    .map(str::to_string)
                    .collect(),
            }),
            _ => Err(Failure::Refused(
                "editor gave an answer the app can't read".into(),
            )),
        }
    }

    /// Opens the Plugin's own window, titled `title`, owned by the native
    /// window `owner` (an `HWND`, as a number) and at `at` on screen if it
    /// has been open before. Windows only so far: elsewhere the helper
    /// refuses.
    pub fn open_editor(
        &mut self,
        title: &str,
        owner: u64,
        at: Option<(i32, i32)>,
    ) -> Result<(), Failure> {
        let title: String = title
            .chars()
            .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
            .collect();
        let owner = owner.to_string();
        let (x, y) = at.map_or((String::new(), String::new()), |(x, y)| {
            (x.to_string(), y.to_string())
        });
        let mut fields = vec!["open-editor", &title, &owner];
        if at.is_some() {
            fields.extend([x.as_str(), y.as_str()]);
        }
        self.call(&fields, self.deadlines.command).map(drop)
    }

    /// Closes the Plugin's window, saying where it was.
    pub fn close_editor(&mut self) -> Result<(i32, i32), Failure> {
        let reply = self.call(&["close-editor"], self.deadlines.command)?;
        match reply.ok.as_slice() {
            [x, y] => Ok((x.parse().unwrap_or(0), y.parse().unwrap_or(0))),
            _ => Ok((0, 0)),
        }
    }

    /// The audio half, for the thread that runs blocks, once the Plugin is
    /// loaded. Made once per helper: clone it for another slot.
    pub fn audio(&self, mode: Mode) -> Audio {
        Audio {
            process: Arc::clone(&self.process),
            blocks: Arc::new(Mutex::new(Blocks::default())),
            hang: self.deadlines.hang,
            patience: self.deadlines.command,
            mode,
        }
    }

    /// Stops the helper at once and waits until it has ended.
    pub fn kill(&mut self) {
        self.process.kill();
    }

    /// Asks the helper to stop, and kills it if it doesn't.
    pub fn quit(mut self) {
        let command = self.deadlines.command;
        let _ = self.call(&["quit"], command);
        self.kill();
    }
}

impl Drop for Control {
    fn drop(&mut self) {
        self.kill();
    }
}

/// One `param` line: `param <id> <title> <units> <default> <steps> <flags>
/// <value>`.
fn parse_param(line: &[String]) -> Option<Param> {
    match line {
        [tag, id, title, units, default, steps, flags, value] if tag == "param" => Some(Param {
            id: id.parse().ok()?,
            title: title.clone(),
            units: units.clone(),
            default: default.parse().ok()?,
            steps: steps.parse().ok()?,
            flags: flags.parse().ok()?,
            value: value.parse().ok()?,
        }),
        _ => None,
    }
}

/// Where the audio half is between blocks.
#[derive(Default)]
struct Blocks {
    seq: u32,
    /// When the helper was sent a block it hasn't finished yet.
    late_since: Option<Instant>,
    /// Settings that changed in blocks that were bypassed, sent with the
    /// next block that goes through, so the Plugin never misses a value.
    unsent: Vec<ParamChange>,
    /// Notes released in blocks that were bypassed, likewise, so none is
    /// left sounding.
    unsent_releases: Vec<Event>,
}

/// The helper's audio half: one block at a time, from the thread that runs
/// blocks, taking no lock it would wait for and allocating nothing once
/// warmed up. Clones share where the helper is, so a slot that is briefly
/// in two places as a chain is rebuilt never writes a block the helper is
/// still reading.
#[derive(Clone)]
pub struct Audio {
    process: Arc<Process>,
    blocks: Arc<Mutex<Blocks>>,
    hang: Duration,
    /// How long an offline block may take before its Plugin is taken as
    /// hung.
    patience: Duration,
    mode: Mode,
}

impl Audio {
    /// Whether the helper has gone, for any reason.
    pub fn has_gone(&self) -> bool {
        self.process.has_gone()
    }

    /// One block, in place: `left` and `right` go in, and hold the Plugin's
    /// output if it was `Processed`. `changes` are settings as they change
    /// in this block, normalised; `events` are its notes. A realtime block
    /// never waits past `deadline`; an offline one waits as long as a
    /// command may.
    pub fn process(
        &self,
        left: &mut [f32],
        right: &mut [f32],
        changes: &[ParamChange],
        events: &[Event],
        deadline: Instant,
    ) -> PluginBlock {
        // Only the one thread runs blocks, so this is never held; were it
        // ever, the block would be bypassed rather than waited for.
        let Ok(mut blocks) = self.blocks.try_lock() else {
            return PluginBlock::Bypassed;
        };
        let deadline = match self.mode {
            Mode::Realtime => deadline,
            Mode::Offline => Instant::now() + self.patience,
        };
        if let Some(block) = self.begin(&mut blocks, left, right, changes, events) {
            return block;
        }
        let block = self.finish(&mut blocks, left, right, deadline);
        if self.mode == Mode::Offline && blocks.late_since.is_some() {
            // Offline, nothing is late but a hung Plugin.
            self.process.stop();
            return PluginBlock::Crashed;
        }
        block
    }

    /// Hands the block to the helper, unless it is settled without it:
    /// `Some` for a block the helper is gone for, or still busy with the
    /// last one.
    fn begin(
        &self,
        blocks: &mut Blocks,
        left: &[f32],
        right: &[f32],
        changes: &[ParamChange],
        events: &[Event],
    ) -> Option<PluginBlock> {
        let shared = &self.process.shared;
        if self.has_gone() {
            return Some(PluginBlock::Crashed);
        }
        if let Some(since) = blocks.late_since {
            // The helper is still on an earlier block. Its input must not be
            // touched until it has finished.
            if shared.try_done() {
                blocks.late_since = None;
                if self.has_gone() || self.helper_is_dying() {
                    return Some(PluginBlock::Crashed);
                }
            } else if since.elapsed() >= self.hang {
                self.process.stop();
                return Some(PluginBlock::Crashed);
            } else {
                keep_unsent(blocks, changes, events);
                return Some(PluginBlock::Bypassed);
            }
        }

        let frames = left.len().min(right.len()).min(MAX_FRAMES);
        // SAFETY: the helper is between blocks (no *go* is outstanding), so
        // nothing else is touching the layout.
        let layout = unsafe { shared.layout() };
        layout.frames = frames as u32;
        layout.input[0][..frames].copy_from_slice(&left[..frames]);
        layout.input[1][..frames].copy_from_slice(&right[..frames]);
        let mut count = 0;
        for change in blocks
            .unsent
            .drain(..)
            .chain(changes.iter().copied())
            .take(MAX_PARAM_CHANGES)
        {
            layout.param_changes[count] = change;
            count += 1;
        }
        layout.param_change_count = count as u32;
        let mut count = 0;
        for event in blocks
            .unsent_releases
            .drain(..)
            .chain(events.iter().copied())
            .take(MAX_EVENTS)
        {
            layout.events[count] = event;
            count += 1;
        }
        layout.event_count = count as u32;
        blocks.seq = blocks.seq.wrapping_add(1);
        layout.seq = blocks.seq;
        shared.post_go();
        None
    }

    /// Waits for the block `begin` sent until `deadline` at the latest.
    fn finish(
        &self,
        blocks: &mut Blocks,
        left: &mut [f32],
        right: &mut [f32],
        deadline: Instant,
    ) -> PluginBlock {
        let shared = &self.process.shared;
        let frames = left.len().min(right.len()).min(MAX_FRAMES);
        let wait = deadline.saturating_duration_since(Instant::now());
        if !shared.wait_done(wait) {
            if self.has_gone() {
                return PluginBlock::Crashed;
            }
            blocks.late_since = Some(Instant::now());
            // What was sent reaches the Plugin anyway, once it catches up.
            return PluginBlock::Bypassed;
        }
        if shared.done_seq() != blocks.seq {
            // Woken by the pipe closing, not by the block finishing.
            return PluginBlock::Crashed;
        }
        if self.helper_is_dying() {
            return PluginBlock::Crashed;
        }
        // SAFETY: the helper has answered this block and waits for the next.
        let layout = unsafe { shared.layout() };
        if layout.status != shared::STATUS_OK {
            return PluginBlock::Bypassed;
        }
        left[..frames].copy_from_slice(&layout.output[0][..frames]);
        right[..frames].copy_from_slice(&layout.output[1][..frames]);
        PluginBlock::Processed
    }

    /// Whether the helper's crash handler has said the Plugin crashed. It
    /// says so before the process has ended, which can take the system a
    /// while; the helper is stopped now rather than waited for.
    fn helper_is_dying(&self) -> bool {
        // SAFETY: *done* has been taken, so the helper is not in a block.
        let dying = unsafe { self.process.shared.layout() }.status == shared::STATUS_CRASHED;
        if dying {
            self.process.stop();
        }
        dying
    }
}

/// Keeps the latest value of each setting that changed in a bypassed block,
/// and each note it released, to send at the start of the next one. A note
/// started in a bypassed block is dropped: played late, it would be wrong.
fn keep_unsent(blocks: &mut Blocks, changes: &[ParamChange], events: &[Event]) {
    for change in changes {
        let latest = ParamChange {
            offset: 0,
            ..*change
        };
        if let Some(kept) = blocks.unsent.iter_mut().find(|c| c.id == change.id) {
            *kept = latest;
        } else if blocks.unsent.len() < MAX_PARAM_CHANGES {
            blocks.unsent.push(latest);
        }
    }
    for event in events {
        if event.kind == shared::EVENT_NOTE_OFF && blocks.unsent_releases.len() < MAX_EVENTS {
            blocks.unsent_releases.push(Event {
                offset: 0,
                ..*event
            });
        }
    }
}

/// Scans `bundle` in a helper process of its own, for a bundle with no
/// moduleinfo: this runs the Plugin's code, and whatever it does (crash,
/// hang, show a copy-protection dialog) happens to that process only.
pub fn scan_in_helper(
    helper: &Path,
    bundle: &Path,
    timeout: Duration,
) -> Result<Vec<Class>, String> {
    let mut child = start(helper, None).map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let lines = Lines::spawn(child.stdout.take().expect("stdout is piped"), |_| {}, || {});
    let result = greeting(&lines, timeout)
        .and_then(|_| protocol::send(&mut stdin, &["scan", &bundle.to_string_lossy()]))
        .and_then(|()| lines.reply(timeout));
    let _ = child.kill();
    let _ = child.wait();
    match result {
        Ok(reply) => Ok(reply
            .lines
            .iter()
            .filter_map(|line| match line.as_slice() {
                [tag, cid, category, name, vendor, version, subs] if tag == "class" => {
                    Some(Class {
                        cid: cid.to_ascii_uppercase(),
                        category: category.clone(),
                        name: name.clone(),
                        vendor: vendor.clone(),
                        version: version.clone(),
                        sub_categories: subs
                            .split('|')
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                            .collect(),
                    })
                }
                _ => None,
            })
            .collect()),
        Err(Failure::Gone) => Err("it crashed while it was being scanned".into()),
        Err(Failure::TimedOut) => Err("it didn't answer while it was being scanned".into()),
        Err(Failure::Refused(why)) => Err(why),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str) -> Vec<String> {
        protocol::fields(text)
    }

    #[test]
    fn a_state_is_base64_in_json() {
        let state = State {
            component: vec![0, 1, 2, 255],
            controller: Vec::new(),
        };
        let json = serde_json::to_string(&state).unwrap();
        assert_eq!(json, r#"{"component":"AAEC/w==","controller":""}"#);
        assert_eq!(serde_json::from_str::<State>(&json).unwrap(), state);
        assert!(serde_json::from_str::<State>(r#"{"component":"!","controller":""}"#).is_err());
    }

    #[test]
    fn a_param_line_is_a_setting_and_where_it_is() {
        let param = parse_param(&line("param\t0\tGain\tdB\t0.5\t0\t1\t0.25")).unwrap();
        assert_eq!(param.id, 0);
        assert_eq!(param.title, "Gain");
        assert_eq!(param.units, "dB");
        assert_eq!(param.default, 0.5);
        assert_eq!(param.value, 0.25);
        assert!(param.can_automate());
        assert_eq!(parse_param(&line("param\t0\tGain")), None);
        assert_eq!(parse_param(&line("class\t0\t1\t2\t3\t4\t5\t6")), None);
    }

    #[test]
    fn only_an_automatable_setting_that_is_neither_read_only_nor_hidden_can_be_reached() {
        let param = |flags| Param {
            id: 0,
            title: String::new(),
            units: String::new(),
            default: 0.0,
            steps: 0,
            flags,
            value: 0.0,
        };
        assert!(param(1).can_automate());
        assert!(!param(0).can_automate());
        assert!(!param(1 | 2).can_automate());
        assert!(!param(1 | 16).can_automate());
    }

    #[test]
    fn a_bypassed_block_keeps_each_settings_latest_value_and_every_release() {
        let mut blocks = Blocks::default();
        let change = |id, offset, value| ParamChange { id, offset, value };
        let note = |kind, pitch| Event {
            kind,
            offset: 7,
            pitch,
            velocity: 0.5,
        };
        keep_unsent(
            &mut blocks,
            &[change(3, 10, 0.1), change(4, 0, 0.2)],
            &[
                note(shared::EVENT_NOTE_ON, 60),
                note(shared::EVENT_NOTE_OFF, 62),
            ],
        );
        keep_unsent(&mut blocks, &[change(3, 20, 0.9)], &[]);
        assert_eq!(blocks.unsent, [change(3, 0, 0.9), change(4, 0, 0.2)]);
        assert_eq!(blocks.unsent_releases.len(), 1);
        assert_eq!(blocks.unsent_releases[0].pitch, 62);
        assert_eq!(blocks.unsent_releases[0].offset, 0);
    }
}

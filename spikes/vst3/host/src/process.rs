//! One VST3 Plugin, running in a helper process of its own.
//!
//! The Desktop App would own one of these per VST3 Plugin in the song. Its
//! `process` is what the audio thread calls each block, and it never waits
//! longer than the block's deadline: a Plugin that is slow gets its block
//! bypassed, one that stays hung is killed, and one that has crashed is
//! reported at once. None of them can stall or take down the song.

use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::protocol::{self, Failure, Lines, Reply};
use crate::shared::{
    self, Event, Layout, MAX_EVENTS, MAX_FRAMES, MAX_PARAM_CHANGES, ParamChange, Shared,
};

/// How long each kind of wait may take.
#[derive(Clone, Copy, Debug)]
pub struct Deadlines {
    /// How long the audio thread waits for one block before bypassing it.
    pub block: Duration,
    /// How long a Plugin may stay late before it is taken for hung and
    /// killed.
    pub hang: Duration,
    /// Settings, state and the window.
    pub command: Duration,
    /// Loading, which is where copy protection runs, and may show a dialog.
    pub load: Duration,
}

impl Deadlines {
    /// The deadlines for blocks of `frames` at `sample_rate`: a block may take
    /// as long as it lasts.
    pub fn for_block(frames: usize, sample_rate: f64) -> Self {
        Self {
            block: Duration::from_secs_f64(frames as f64 / sample_rate),
            hang: Duration::from_millis(500),
            command: Duration::from_secs(5),
            load: Duration::from_secs(60),
        }
    }
}

/// What happened to one block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Block {
    /// The Plugin processed it: the buffers hold its output.
    Processed,
    /// The Plugin was late, or refused the block. The buffers still hold
    /// what went in, so an Effect is bypassed for this block (an Instrument's
    /// host would play silence instead).
    Bypassed,
    /// The Plugin's process has gone: it crashed, or was killed for hanging.
    /// Every block from now on is this, until the Plugin is loaded again.
    Crashed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
#[derive(Clone, Debug, PartialEq)]
pub struct Param {
    pub id: u32,
    pub title: String,
    pub units: String,
    /// Normalised, 0 to 1.
    pub default: f64,
    /// 0 for continuous; otherwise how many steps it has, less one.
    pub steps: i32,
    pub flags: i32,
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
/// processor and one for its controller.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct State {
    pub component: Vec<u8>,
    pub controller: Vec<u8>,
}

/// What the Plugin's own window needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Editor {
    pub width: u32,
    pub height: u32,
    pub resizable: bool,
    /// The kinds of native window it can be attached to: `HWND`, `NSView`,
    /// `X11EmbedWindowID`.
    pub platforms: Vec<String>,
}

pub struct PluginProcess {
    child: Child,
    stdin: ChildStdin,
    lines: Lines,
    shared: Arc<Shared>,
    gone: Arc<AtomicBool>,
    deadlines: Deadlines,
    seq: u32,
    late_since: Option<Instant>,
    /// Settings that changed in blocks that were bypassed, sent with the next
    /// block that goes through, so the Plugin never misses a value.
    unsent: Vec<ParamChange>,
}

/// Starts a helper process with nothing loaded yet.
fn start(helper: &Path, shm: Option<&str>) -> std::io::Result<Child> {
    let mut command = Command::new(helper);
    if let Some(name) = shm {
        command.arg("--shm").arg(name);
    }
    let quiet = std::env::var_os("SPIKE_VST3_VERBOSE").is_none();
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if quiet {
            Stdio::null()
        } else {
            Stdio::inherit()
        })
        .spawn()
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

impl PluginProcess {
    /// A new helper process, ready to `load` a Plugin.
    pub fn spawn(helper: &Path, deadlines: Deadlines) -> Result<Self, Failure> {
        let shared = Arc::new(Shared::create().map_err(|e| Failure::Refused(e.to_string()))?);
        let mut child =
            start(helper, Some(shared.name())).map_err(|e| Failure::Refused(e.to_string()))?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let gone = Arc::new(AtomicBool::new(false));
        let lines = {
            let gone = Arc::clone(&gone);
            let shared = Arc::clone(&shared);
            Lines::spawn(stdout, move || {
                gone.store(true, Ordering::Release);
                // Wake the audio thread now, rather than at its deadline.
                shared.post_done();
            })
        };
        let process = Self {
            child,
            stdin,
            lines,
            shared,
            gone,
            deadlines,
            seq: 0,
            late_since: None,
            unsent: Vec::new(),
        };
        let (version, size) = greeting(&process.lines, deadlines.command)?;
        if version != shared::VERSION || size != std::mem::size_of::<Layout>() {
            return Err(Failure::Refused(format!(
                "the helper's shared memory is version {version}, {size} bytes; this host's is version {}, {} bytes",
                shared::VERSION,
                std::mem::size_of::<Layout>()
            )));
        }
        // The helper has it mapped, so its name can go.
        process.shared.unlink();
        Ok(process)
    }

    /// The helper's process id.
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Whether the helper has gone, for any reason.
    pub fn has_crashed(&self) -> bool {
        self.gone.load(Ordering::Acquire)
    }

    fn call(&mut self, fields: &[&str], timeout: Duration) -> Result<Reply, Failure> {
        if self.has_crashed() {
            return Err(Failure::Gone);
        }
        protocol::send(&mut self.stdin, fields)?;
        match self.lines.reply(timeout) {
            // A helper that doesn't answer is hung; it has to go, or its
            // late answer would be taken for the next command's.
            Err(Failure::TimedOut) => {
                self.kill();
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
    ) -> Result<Loaded, Failure> {
        let bundle = bundle.to_string_lossy();
        let rate = sample_rate.to_string();
        let frames = max_frames.min(MAX_FRAMES).to_string();
        let reply = self.call(&["load", &bundle, cid, &rate, &frames], self.deadlines.load)?;
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
                "load gave an answer this host can't read".into(),
            )),
        }
    }

    /// Every setting the Plugin exposes.
    pub fn params(&mut self) -> Result<Vec<Param>, Failure> {
        let reply = self.call(&["params"], self.deadlines.command)?;
        Ok(reply
            .lines
            .iter()
            .filter_map(|line| match line.as_slice() {
                [tag, id, title, units, default, steps, flags] if tag == "param" => Some(Param {
                    id: id.parse().ok()?,
                    title: title.clone(),
                    units: units.clone(),
                    default: default.parse().ok()?,
                    steps: steps.parse().ok()?,
                    flags: flags.parse().ok()?,
                }),
                _ => None,
            })
            .collect())
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
                "editor gave an answer this host can't read".into(),
            )),
        }
    }

    /// One block, in place: `left` and `right` go in, and hold the Plugin's
    /// output if it was `Processed`. `changes` are settings as they change
    /// in this block, normalised; `events` are its notes. Never waits past
    /// the block's deadline.
    pub fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        changes: &[ParamChange],
        events: &[Event],
    ) -> Block {
        let deadline = Instant::now() + self.deadlines.block;
        match self.begin(left, right, changes, events) {
            Some(block) => block,
            None => self.finish(left, right, deadline),
        }
    }

    /// The first half of `process`: hands the block to the helper and
    /// returns without waiting, so that a callback can start every Plugin
    /// that doesn't depend on another before it waits for any of them.
    /// `Some` if the block was settled without being sent; `None` if it was
    /// sent, and `finish` must be called for it.
    pub fn begin(
        &mut self,
        left: &[f32],
        right: &[f32],
        changes: &[ParamChange],
        events: &[Event],
    ) -> Option<Block> {
        if self.has_crashed() {
            return Some(Block::Crashed);
        }
        if let Some(since) = self.late_since {
            // The helper is still on an earlier block. Its input must not be
            // touched until it has finished.
            if self.shared.try_done() {
                self.late_since = None;
                if self.has_crashed() || self.helper_is_dying() {
                    return Some(Block::Crashed);
                }
            } else if since.elapsed() >= self.deadlines.hang {
                self.stop();
                return Some(Block::Crashed);
            } else {
                self.keep_unsent(changes);
                return Some(Block::Bypassed);
            }
        }

        let frames = left.len().min(right.len()).min(MAX_FRAMES);
        // SAFETY: the helper is between blocks (no `go` is outstanding), so
        // nothing else is touching the layout.
        let layout = unsafe { self.shared.layout() };
        layout.frames = frames as u32;
        layout.input[0][..frames].copy_from_slice(&left[..frames]);
        layout.input[1][..frames].copy_from_slice(&right[..frames]);
        let mut count = 0;
        for change in self
            .unsent
            .drain(..)
            .chain(changes.iter().copied())
            .take(MAX_PARAM_CHANGES)
        {
            layout.param_changes[count] = change;
            count += 1;
        }
        layout.param_change_count = count as u32;
        let events = &events[..events.len().min(MAX_EVENTS)];
        layout.events[..events.len()].copy_from_slice(events);
        layout.event_count = events.len() as u32;
        self.seq = self.seq.wrapping_add(1);
        layout.seq = self.seq;
        self.shared.post_go();
        None
    }

    /// The second half of `process`, for a block `begin` sent: waits for it
    /// until `deadline` at the latest.
    pub fn finish(&mut self, left: &mut [f32], right: &mut [f32], deadline: Instant) -> Block {
        let frames = left.len().min(right.len()).min(MAX_FRAMES);
        let wait = deadline.saturating_duration_since(Instant::now());
        if !self.shared.wait_done(wait) {
            if self.has_crashed() {
                return Block::Crashed;
            }
            self.late_since = Some(Instant::now());
            // What was sent reaches the Plugin anyway, once it catches up.
            return Block::Bypassed;
        }
        if self.shared.done_seq() != self.seq {
            // Woken by the pipe closing, not by the block finishing.
            return Block::Crashed;
        }
        if self.helper_is_dying() {
            return Block::Crashed;
        }
        // SAFETY: the helper has answered this block and waits for the next.
        let layout = unsafe { self.shared.layout() };
        if layout.status != shared::STATUS_OK {
            return Block::Bypassed;
        }
        left[..frames].copy_from_slice(&layout.output[0][..frames]);
        right[..frames].copy_from_slice(&layout.output[1][..frames]);
        Block::Processed
    }

    /// Keeps the latest value of each setting that changed in a bypassed
    /// block, to send at the start of the next one.
    fn keep_unsent(&mut self, changes: &[ParamChange]) {
        for change in changes {
            let latest = ParamChange {
                offset: 0,
                ..*change
            };
            match self.unsent.iter_mut().find(|c| c.id == change.id) {
                Some(kept) => *kept = latest,
                None => self.unsent.push(latest),
            }
        }
    }

    /// Whether the helper's crash handler has said the Plugin crashed. It
    /// says so before the process has ended, which can take the system a
    /// while; the helper is stopped now rather than waited for.
    fn helper_is_dying(&mut self) -> bool {
        // SAFETY: `done` has been taken, so the helper is not in a block.
        let dying = unsafe { self.shared.layout() }.status == shared::STATUS_CRASHED;
        if dying {
            self.stop();
        }
        dying
    }

    /// Stops the helper at once, whatever it is doing, without waiting for
    /// it to end: safe on the audio thread. Drop reaps it.
    fn stop(&mut self) {
        let _ = self.child.kill();
        self.gone.store(true, Ordering::Release);
    }

    /// Stops the helper at once and waits until it has ended.
    pub fn kill(&mut self) {
        self.stop();
        let _ = self.child.wait();
    }

    /// Asks the helper to stop, and kills it if it doesn't.
    pub fn quit(mut self) {
        let command = self.deadlines.command;
        let _ = self.call(&["quit"], command);
        self.kill();
    }
}

impl Drop for PluginProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Scans `bundle` in a helper process of its own, for a bundle with no
/// moduleinfo: this runs the Plugin's code, and whatever it does (crash,
/// hang, show a copy-protection dialog) happens to that process only.
pub fn scan_in_helper(
    helper: &Path,
    bundle: &Path,
    timeout: Duration,
) -> Result<Vec<crate::moduleinfo::Class>, String> {
    let mut child = start(helper, None).map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let lines = Lines::spawn(child.stdout.take().expect("stdout is piped"), || {});
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
                    Some(crate::moduleinfo::Class {
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

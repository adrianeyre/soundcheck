//! What running each VST3 Plugin in a process of its own costs: how long a
//! block's round trip through shared memory takes for 1 and 16 Plugins, how
//! long starting one takes, and how soon a crash is noticed.
//!
//! `cargo run --release --bin bench`, after building the helper and Plugins
//! (see the README). Spike Faulty does next to nothing with a block, so what
//! is measured is the crossing between processes, not the Plugin.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use spike_vst3_host::moduleinfo;
use spike_vst3_host::process::{Block, Deadlines, PluginProcess};
use spike_vst3_host::shared::ParamChange;

const RATE: f64 = 48_000.0;
const FRAMES: usize = 128;
const BLOCKS: usize = 20_000;

fn build() -> PathBuf {
    std::env::var_os("SPIKE_VST3_BUILD")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../build"))
}

struct Faulty {
    helper: PathBuf,
    bundle: PathBuf,
    cid: String,
}

impl Faulty {
    fn find() -> Self {
        let bundle = build().join("VST3/Release/spike-faulty.vst3");
        let cid = moduleinfo::read(&bundle)
            .expect("build the helper and Plugins first: see the README")
            .into_iter()
            .find(|c| c.name == "Spike Faulty")
            .expect("Spike Faulty is in its bundle")
            .cid;
        Self {
            helper: build().join("bin/soundcheck-vst3-host"),
            bundle,
            cid,
        }
    }

    fn load(&self) -> PluginProcess {
        let mut process = PluginProcess::spawn(&self.helper, Deadlines::for_block(FRAMES, RATE))
            .expect("the helper starts");
        process
            .load(&self.bundle, &self.cid, RATE, FRAMES)
            .expect("Spike Faulty loads");
        process
    }
}

struct Summary {
    mean: Duration,
    p99: Duration,
    max: Duration,
}

fn summarise(mut times: Vec<Duration>) -> Summary {
    times.sort();
    Summary {
        mean: times.iter().sum::<Duration>() / times.len() as u32,
        p99: times[times.len() * 99 / 100],
        max: *times.last().unwrap(),
    }
}

fn micros(d: Duration) -> String {
    format!("{:.0} µs", d.as_secs_f64() * 1e6)
}

/// How a callback runs its Plugins' blocks.
#[derive(Clone, Copy)]
enum Order {
    /// One Plugin after another, as a track's chain of Effects must.
    OneByOne,
    /// Every Plugin started, then every one waited for, as independent
    /// tracks can be, each Plugin on a core of its own.
    AllAtOnce,
}

fn round_trips(faulty: &Faulty, plugins: usize, order: Order, paced: bool) {
    let mut processes: Vec<_> = (0..plugins).map(|_| faulty.load()).collect();
    let period = Duration::from_secs_f64(FRAMES as f64 / RATE);
    let mut buffers = vec![([0.1; FRAMES], [0.1; FRAMES]); plugins];
    let mut times = Vec::with_capacity(BLOCKS);
    let mut bypassed = 0;
    let mut next = Instant::now();
    for _ in 0..BLOCKS {
        let started = Instant::now();
        let mut blocks = Vec::with_capacity(plugins);
        match order {
            Order::OneByOne => {
                for (process, (left, right)) in processes.iter_mut().zip(&mut buffers) {
                    blocks.push(process.process(left, right, &[], &[]));
                }
            }
            Order::AllAtOnce => {
                // One deadline for the whole callback, not one per Plugin.
                let deadline = started + period;
                let begun: Vec<_> = processes
                    .iter_mut()
                    .zip(&buffers)
                    .map(|(process, (left, right))| process.begin(left, right, &[], &[]))
                    .collect();
                for ((process, (left, right)), begun) in
                    processes.iter_mut().zip(&mut buffers).zip(begun)
                {
                    blocks.push(begun.unwrap_or_else(|| process.finish(left, right, deadline)));
                }
            }
        }
        times.push(started.elapsed());
        bypassed += blocks.iter().filter(|b| **b != Block::Processed).count();
        if paced {
            // As an audio callback comes round: once a block, not flat out.
            next += period;
            if let Some(wait) = next.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
        }
    }
    let s = summarise(times);
    println!(
        "| {plugins} | {} | {} | {} | {} | {} | {bypassed} of {} |",
        match order {
            Order::OneByOne => "one by one",
            Order::AllAtOnce => "all at once",
        },
        if paced { "paced" } else { "flat out" },
        micros(s.mean),
        micros(s.p99),
        micros(s.max),
        BLOCKS * plugins,
    );
}

fn starting(faulty: &Faulty) {
    let times = (0..20)
        .map(|_| {
            let started = Instant::now();
            let process = faulty.load();
            let took = started.elapsed();
            process.quit();
            took
        })
        .collect();
    let s = summarise(times);
    println!(
        "Starting a helper and loading a Plugin: mean {}, max {}",
        micros(s.mean),
        micros(s.max)
    );
}

fn noticing_a_crash(faulty: &Faulty) {
    let crash = [ParamChange {
        id: 1,
        offset: 0,
        value: 1.0,
    }];
    let times = (0..20)
        .map(|_| {
            let mut process = faulty.load();
            let (mut left, mut right) = ([0.1; FRAMES], [0.1; FRAMES]);
            let started = Instant::now();
            let mut block = process.process(&mut left, &mut right, &crash, &[]);
            while block != Block::Crashed {
                std::thread::sleep(Duration::from_micros(100));
                block = process.process(&mut left, &mut right, &[], &[]);
            }
            started.elapsed()
        })
        .collect();
    let s = summarise(times);
    println!(
        "From a crash to Block::Crashed: mean {}, max {}",
        micros(s.mean),
        micros(s.max)
    );
}

fn main() {
    let faulty = Faulty::find();
    println!(
        "{} cores, {FRAMES} frames at {RATE} Hz ({} a block), {BLOCKS} blocks\n",
        std::thread::available_parallelism().map_or(0, |n| n.get()),
        micros(Duration::from_secs_f64(FRAMES as f64 / RATE)),
    );
    println!("| Plugins | Order | Callback | Mean | p99 | Max | Plugin blocks bypassed |");
    println!("|---|---|---|---|---|---|---|");
    for plugins in [1, 16] {
        for order in [Order::OneByOne, Order::AllAtOnce] {
            for paced in [false, true] {
                if plugins == 1 && matches!(order, Order::AllAtOnce) {
                    continue;
                }
                round_trips(&faulty, plugins, order, paced);
            }
        }
    }
    println!();
    starting(&faulty);
    noticing_a_crash(&faulty);
}

//! Runs 16 instances of the spike Plugin in wasmtime, the way a desktop
//! Audio Engine would, and measures what a block costs. The same DSP run
//! natively is the baseline.
//!
//! Usage: `spike-host <plugin.wasm> [blocks] [component.wasm]`

mod component;

use std::time::{Duration, Instant};
use wasmtime::{Config, Engine, Instance, Memory, Module, Store, TypedFunc};

pub const SAMPLE_RATE: f32 = 48_000.0;
pub const FRAMES: usize = 128;
pub const INSTANCES: usize = 16;

/// One Plugin instance: its own Store, so instances share nothing and could
/// be moved to different threads.
struct Hosted {
    store: Store<()>,
    memory: Memory,
    left: usize,
    right: usize,
    set_param: TypedFunc<(u32, f32), ()>,
    process: TypedFunc<u32, ()>,
}

impl Hosted {
    fn new(engine: &Engine, module: &Module, epoch: bool) -> Self {
        let mut store = Store::new(engine, ());
        if epoch {
            // A runaway Plugin is stopped at the next epoch tick; the host
            // bumps the epoch once per block, so this deadline is generous.
            store.set_epoch_deadline(1_000);
        }
        let instance = Instance::new(&mut store, module, &[]).expect("instantiate");
        let abi: u32 = instance
            .get_typed_func::<(), u32>(&mut store, "sc_abi_version")
            .unwrap()
            .call(&mut store, ())
            .unwrap();
        assert_eq!(abi, spike_plugin::ABI_VERSION);
        let memory = instance.get_memory(&mut store, "memory").unwrap();
        let manifest = {
            let ptr = call0(&instance, &mut store, "sc_manifest") as usize;
            let len = call0(&instance, &mut store, "sc_manifest_len") as usize;
            String::from_utf8(memory.data(&store)[ptr..ptr + len].to_vec()).unwrap()
        };
        assert!(manifest.contains(r#""kind":"effect""#));
        let init = instance
            .get_typed_func::<(f32, u32), u32>(&mut store, "sc_init")
            .unwrap();
        assert_eq!(
            init.call(&mut store, (SAMPLE_RATE, FRAMES as u32)).unwrap(),
            0
        );
        let buffer = instance
            .get_typed_func::<u32, u32>(&mut store, "sc_buffer")
            .unwrap();
        let left = buffer.call(&mut store, 0).unwrap() as usize;
        let right = buffer.call(&mut store, 1).unwrap() as usize;
        Self {
            set_param: instance.get_typed_func(&mut store, "sc_set_param").unwrap(),
            process: instance.get_typed_func(&mut store, "sc_process").unwrap(),
            store,
            memory,
            left,
            right,
        }
    }

    /// One block, as the engine would run it: copy the channel in, move a
    /// setting (as Automation would), process, copy the channel out.
    fn block(&mut self, left: &mut [f32], right: &mut [f32], tone: f32) {
        let data = self.memory.data_mut(&mut self.store);
        write(data, self.left, left);
        write(data, self.right, right);
        self.set_param.call(&mut self.store, (1, tone)).unwrap();
        self.process.call(&mut self.store, FRAMES as u32).unwrap();
        let data = self.memory.data(&self.store);
        read(data, self.left, left);
        read(data, self.right, right);
    }
}

fn call0(instance: &Instance, store: &mut Store<()>, name: &str) -> u32 {
    instance
        .get_typed_func::<(), u32>(&mut *store, name)
        .unwrap()
        .call(store, ())
        .unwrap()
}

fn write(data: &mut [u8], at: usize, samples: &[f32]) {
    for (i, s) in samples.iter().enumerate() {
        data[at + i * 4..at + i * 4 + 4].copy_from_slice(&s.to_le_bytes());
    }
}

fn read(data: &[u8], at: usize, samples: &mut [f32]) {
    for (i, s) in samples.iter_mut().enumerate() {
        *s = f32::from_le_bytes(data[at + i * 4..at + i * 4 + 4].try_into().unwrap());
    }
}

/// A test signal: a saw with a little noise, different per instance.
fn input(block: usize, instance: usize, left: &mut [f32], right: &mut [f32]) {
    let mut seed = (block * 31 + instance * 7 + 1) as u32;
    for i in 0..FRAMES {
        let t = (block * FRAMES + i) as f32;
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let noise = (seed >> 9) as f32 / (1 << 23) as f32 - 0.5;
        let saw = (t * (110.0 + instance as f32 * 20.0) / SAMPLE_RATE).fract() * 2.0 - 1.0;
        left[i] = 0.5 * saw + 0.05 * noise;
        right[i] = 0.5 * saw - 0.05 * noise;
    }
}

fn tone_at(block: usize) -> f32 {
    // Swept across its range, so coefficients are recomputed every block.
    1000.0 + 3000.0 * ((block as f32) * 0.01).sin()
}

struct Stats {
    /// Nanoseconds each 16-instance block took, sorted.
    blocks: Vec<u64>,
}

impl Stats {
    fn report(&self, name: &str) {
        let n = self.blocks.len();
        let mean = self.blocks.iter().sum::<u64>() as f64 / n as f64;
        let at = |q: f64| self.blocks[((n as f64 * q) as usize).min(n - 1)] as f64;
        let budget = FRAMES as f64 / SAMPLE_RATE as f64 * 1e9;
        println!(
            "{name:<28} 16 instances/block: mean {:>7.1} µs  p99 {:>7.1} µs  max {:>7.1} µs  \
             | per instance mean {:>5.2} µs | {:>5.2}% of the {:.0} µs block",
            mean / 1e3,
            at(0.99) / 1e3,
            at(1.0) / 1e3,
            mean / 1e3 / INSTANCES as f64,
            mean / budget * 100.0,
            budget / 1e3,
        );
    }
}

fn run(blocks: usize, mut each: impl FnMut(usize, &mut [f32], &mut [f32], usize)) -> (Stats, f32) {
    let mut left = [0.0f32; FRAMES];
    let mut right = [0.0f32; FRAMES];
    let mut times = Vec::with_capacity(blocks);
    let mut checksum = 0.0f32;
    for block in 0..blocks + blocks / 10 {
        let mut spent = Duration::ZERO;
        for instance in 0..INSTANCES {
            input(block, instance, &mut left, &mut right);
            let start = Instant::now();
            each(instance, &mut left, &mut right, block);
            spent += start.elapsed();
            checksum += left[FRAMES - 1] + right[0];
        }
        // The first tenth warms caches and the JIT's code up; not counted.
        if block >= blocks / 10 {
            times.push(spent.as_nanos() as u64);
        }
    }
    times.sort_unstable();
    (Stats { blocks: times }, checksum)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .expect("usage: spike-host <plugin.wasm> [blocks]");
    let blocks: usize = args.next().map_or(20_000, |b| b.parse().unwrap());
    let component = args.next();
    println!(
        "{blocks} blocks of {FRAMES} frames at {SAMPLE_RATE} Hz ({:.1} s of audio), {INSTANCES} instances\n",
        blocks as f64 * FRAMES as f64 / SAMPLE_RATE as f64
    );

    let mut native: Vec<_> = (0..INSTANCES)
        .map(|_| spike_plugin::Tone::new(SAMPLE_RATE))
        .collect();
    let (stats, native_sum) = run(blocks, |i, l, r, b| {
        native[i].set_param(1, tone_at(b));
        native[i].process(l, r);
    });
    stats.report("native (baseline)");
    println!("{:<28} checksum {native_sum:.3}", "");

    for epoch in [false, true] {
        let mut config = Config::new();
        config.epoch_interruption(epoch);
        let engine = Engine::new(&config).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let compile = Instant::now();
        let module = Module::new(&engine, &bytes).unwrap();
        let compiled = compile.elapsed();
        let start = Instant::now();
        let mut hosted: Vec<_> = (0..INSTANCES)
            .map(|_| Hosted::new(&engine, &module, epoch))
            .collect();
        let instantiated = start.elapsed();
        let (stats, sum) = run(blocks, |i, l, r, b| hosted[i].block(l, r, tone_at(b)));
        let name = if epoch {
            "wasmtime + epoch interrupt"
        } else {
            "wasmtime"
        };
        stats.report(name);
        println!(
            "{:<28} compile {:.1} ms, 16 instantiations {:.2} ms, output matches native: {}",
            "",
            compiled.as_secs_f64() * 1e3,
            instantiated.as_secs_f64() * 1e3,
            (sum - native_sum).abs() <= native_sum.abs() * 1e-4 + 1e-3,
        );
    }
    if let Some(path) = component {
        component::bench(&path, blocks, native_sum);
    }
}

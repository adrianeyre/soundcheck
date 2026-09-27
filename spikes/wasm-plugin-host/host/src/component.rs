//! The same Effect as a WASM Component, measured the same way, to see what
//! the Component Model's canonical ABI costs per block.

use crate::{FRAMES, INSTANCES, SAMPLE_RATE, Stats, run, tone_at};
use std::time::Instant;
use wasmtime::component::{Component, Linker, ResourceAny, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

wasmtime::component::bindgen!({ world: "plugin", path: "../component/wit" });

struct State {
    ctx: WasiCtx,
    table: ResourceTable,
}

impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.ctx,
            table: &mut self.table,
        }
    }
}

struct Hosted {
    store: Store<State>,
    plugin: Plugin,
    tone: ResourceAny,
}

pub fn bench(path: &str, blocks: usize, native_sum: f32) {
    let engine = Engine::new(&Config::new()).unwrap();
    let compile = Instant::now();
    let component = Component::from_file(&engine, path).unwrap();
    let compiled = compile.elapsed();
    let mut linker = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker).unwrap();
    let start = Instant::now();
    let mut hosted: Vec<_> = (0..INSTANCES)
        .map(|_| {
            let mut store = Store::new(
                &engine,
                State {
                    ctx: WasiCtx::builder().build(),
                    table: ResourceTable::new(),
                },
            );
            let plugin = Plugin::instantiate(&mut store, &component, &linker).unwrap();
            let tone = plugin
                .soundcheck_spike_effect()
                .tone()
                .call_constructor(&mut store, SAMPLE_RATE)
                .unwrap();
            Hosted {
                store,
                plugin,
                tone,
            }
        })
        .collect();
    let instantiated = start.elapsed();
    let (stats, sum): (Stats, f32) = run(blocks, |i, l, r, b| {
        let h = &mut hosted[i];
        let tone = h.plugin.soundcheck_spike_effect().tone();
        tone.call_set_param(&mut h.store, h.tone, 1, tone_at(b))
            .unwrap();
        let (left, right) = tone.call_process(&mut h.store, h.tone, l, r).unwrap();
        l.copy_from_slice(&left[..FRAMES]);
        r.copy_from_slice(&right[..FRAMES]);
    });
    stats.report("wasmtime component model");
    println!(
        "{:<28} compile {:.1} ms, 16 instantiations {:.2} ms, output matches native: {}",
        "",
        compiled.as_secs_f64() * 1e3,
        instantiated.as_secs_f64() * 1e3,
        (sum - native_sum).abs() <= native_sum.abs() * 1e-4 + 1e-3,
    );
}

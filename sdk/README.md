# soundcheck-sdk

Write a Soundcheck **Plugin** (an **Effect** or an **Instrument**) in Rust, as a WebAssembly module the app runs on desktop and in the browser dev host.

**Stable** from 1.0.0: the ABI under it is version 1 ([ADR 0003](../docs/architectural-decision-record/0003-wasm-plugin-hosting.md)).

The crate's docs are the guide: what to implement, how to build and install a Plugin, what it can use, and the ABI for anyone writing a host. Read them with

```sh
cargo doc -p soundcheck-sdk --open
```

or in [`src/lib.rs`](src/lib.rs). Two complete Plugins, written only from those docs, are in [`examples/plugins/`](../examples/plugins/):

- [`bitcrusher`](../examples/plugins/bitcrusher/src/lib.rs), an Effect.
- [`wavetable`](../examples/plugins/wavetable/src/lib.rs), an Instrument.

`test-effect/` and `test-instrument/` are the Plugins the hosts are tested against, not examples.

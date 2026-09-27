# Spike: how the Audio Engine hosts WASM Plugins (#53)

Throwaway code behind [ADR 0003](../../docs/architectural-decision-record/0003-wasm-plugin-hosting.md). It is its own Cargo workspace, so the app's `pnpm lint`, `test` and `build` never build it. Keep it only as the record of how the numbers were measured.

| Path | What it is |
| --- | --- |
| `plugin/` | "Tone", a throwaway Effect: the proposed C-style ABI (its doc comment is the ABI) over DSP that also builds natively as the baseline |
| `component/` | The same Effect behind a WIT interface, as a WASM Component, for comparison |
| `host/` | The desktop side: runs 16 instances natively, in wasmtime through the ABI (with and without epoch interruption), and as a Component |
| `browser/` | The browser side: runs the same `.wasm` in Node's and a Chromium page's `WebAssembly` |

## Running it

```bash
cd spikes/wasm-plugin-host
cargo build -p spike-plugin --target wasm32-unknown-unknown --release
cargo build -p spike-component --target wasm32-wasip2 --release   # rustup target add wasm32-wasip2
cargo run -p spike-host --release -- \
  target/wasm32-unknown-unknown/release/spike_plugin.wasm 20000 \
  target/wasm32-wasip2/release/spike_component.wasm

cd browser
pnpm install --ignore-workspace
# The last argument is optional: any Chromium or Chrome executable.
node run.mjs ../target/wasm32-unknown-unknown/release/spike_plugin.wasm 20000 \
  ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
```

Each run prints the mean, p99 and worst time for a block of all 16 instances, the mean per instance, and the share of the 128-frame block (2 667 µs at 48 kHz) it uses.

// Runs 16 instances of the spike Plugin in the host's own WebAssembly, the
// way the browser dev host's AudioWorklet would, and measures a block. The
// same file runs in Node (V8) and in a Chromium page (V8 plus the page's
// timer), so the two can be compared.

const SAMPLE_RATE = 48000;
const FRAMES = 128;
const INSTANCES = 16;

async function hosted(module) {
  const { exports } = await WebAssembly.instantiate(module, {});
  if (exports.sc_abi_version() !== 1) throw new Error("ABI version");
  const bytes = new Uint8Array(exports.memory.buffer, exports.sc_manifest(), exports.sc_manifest_len());
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  if (manifest.kind !== "effect") throw new Error("not an Effect");
  if (exports.sc_init(SAMPLE_RATE, FRAMES) !== 0) throw new Error("init");
  // The views stay valid because the Plugin allocates only in sc_init.
  const left = new Float32Array(exports.memory.buffer, exports.sc_buffer(0), FRAMES);
  const right = new Float32Array(exports.memory.buffer, exports.sc_buffer(1), FRAMES);
  return { exports, left, right };
}

function input(block, instance, left, right) {
  let seed = (block * 31 + instance * 7 + 1) >>> 0;
  for (let i = 0; i < FRAMES; i++) {
    const t = block * FRAMES + i;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed >>> 9) / (1 << 23) - 0.5;
    const phase = (t * (110 + instance * 20)) / SAMPLE_RATE;
    const saw = (phase - Math.floor(phase)) * 2 - 1;
    left[i] = 0.5 * saw + 0.05 * noise;
    right[i] = 0.5 * saw - 0.05 * noise;
  }
}

export async function bench(wasmBytes, blocks = 20000, now = () => performance.now()) {
  const compileStart = now();
  const module = await WebAssembly.compile(wasmBytes);
  const compiled = now() - compileStart;
  const plugins = [];
  for (let i = 0; i < INSTANCES; i++) plugins.push(await hosted(module));

  const left = new Float32Array(FRAMES);
  const right = new Float32Array(FRAMES);
  const times = [];
  let checksum = 0;
  for (let block = 0; block < blocks + blocks / 10; block++) {
    let spent = 0;
    const tone = 1000 + 3000 * Math.sin(block * 0.01);
    for (let i = 0; i < INSTANCES; i++) {
      input(block, i, left, right);
      const p = plugins[i];
      const start = now();
      p.left.set(left);
      p.right.set(right);
      p.exports.sc_set_param(1, tone);
      p.exports.sc_process(FRAMES);
      left.set(p.left);
      right.set(p.right);
      spent += now() - start;
      checksum += left[FRAMES - 1] + right[0];
    }
    if (block >= blocks / 10) times.push(spent * 1000);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const at = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))];
  const budget = (FRAMES / SAMPLE_RATE) * 1e6;
  return {
    meanUs: mean,
    p99Us: at(0.99),
    maxUs: at(1),
    perInstanceUs: mean / INSTANCES,
    budgetPercent: (mean / budget) * 100,
    compileMs: compiled,
    checksum,
  };
}

// node run.mjs <plugin.wasm> [blocks] [chromium-executable]
// Runs bench.js in Node, then in headless Chromium if an executable is given.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { bench } from "./bench.js";

const [path, blocksArg, chromium] = process.argv.slice(2);
const blocks = Number(blocksArg ?? 20000);
const wasm = await readFile(path);
const bench_js = await readFile(new URL("./bench.js", import.meta.url));

const show = (name, r) =>
  console.log(
    `${name.padEnd(28)} 16 instances/block: mean ${r.meanUs.toFixed(1).padStart(7)} µs  p99 ${r.p99Us.toFixed(1).padStart(7)} µs  ` +
      `max ${r.maxUs.toFixed(1).padStart(7)} µs  | per instance mean ${r.perInstanceUs.toFixed(2)} µs | ` +
      `${r.budgetPercent.toFixed(2)}% of the 2667 µs block | compile ${r.compileMs.toFixed(1)} ms | checksum ${r.checksum.toFixed(3)}`,
  );

// Node's timer is finer than a page's, so Node gives the cleaner number.
show(`node ${process.version}`, await bench(wasm, blocks, () => Number(process.hrtime.bigint()) / 1e6));

if (chromium) {
  const { chromium: launcher } = await import("playwright-core");
  // Served over http with cross-origin isolation, which is what gives a
  // page's performance.now() its finest (5 µs) resolution.
  const server = createServer((req, res) => {
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
    if (req.url === "/bench.js") res.writeHead(200, { ...headers, "Content-Type": "text/javascript" }).end(bench_js);
    else if (req.url === "/plugin.wasm") res.writeHead(200, { ...headers, "Content-Type": "application/wasm" }).end(wasm);
    else res.writeHead(200, { ...headers, "Content-Type": "text/html" }).end("<!doctype html><title>bench</title>");
  }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await launcher.launch({ executablePath: chromium });
  const page = await browser.newPage();
  await page.goto(url);
  const version = browser.version();
  const result = await page.evaluate(async (count) => {
    const { bench: run } = await import("/bench.js");
    const bytes = await (await fetch("/plugin.wasm")).arrayBuffer();
    return { isolated: crossOriginIsolated, ...(await run(bytes, count)) };
  }, blocks);
  show(`chromium ${version}${result.isolated ? "" : " (not isolated)"}`, result);
  await browser.close();
  server.close();
}

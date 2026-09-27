import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { serveModel } from "./served-model";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

/** A server answering with `serveModel(file)`, and 404 for whatever it passes on. */
async function serving(file: string): Promise<string> {
  const handle = serveModel(file);
  const server: Server = createServer((request, response) =>
    handle(request, response, () => {
      response.statusCode = 404;
      response.end();
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}/`;
}

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "served-model-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the repo's model is served to GET and HEAD, as bytes, uncached", async () => {
  const file = join(folder(), "htdemucs.onnx");
  writeFileSync(file, new Uint8Array([1, 2, 3]));
  const url = await serving(file);

  const head = await fetch(url, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe("application/octet-stream");
  expect(head.headers.get("content-length")).toBe("3");
  expect(head.headers.get("cache-control")).toBe("no-store");

  const got = await fetch(url);
  expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([1, 2, 3]);
});

test("without an exported model, the request is passed on", async () => {
  const url = await serving(join(folder(), "htdemucs.onnx"));
  expect((await fetch(url)).status).toBe(404);
  // Nor is a folder of that name a model.
  expect((await fetch(await serving(folder()))).status).toBe(404);
});

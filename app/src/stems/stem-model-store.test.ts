import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
import { indexedDbModelStore, opfsModelStore, type OpfsRoot, type StemModelStore } from "./stem-model-store";

function notFound(): DOMException {
  return new DOMException("Not there", "NotFoundError");
}

/**
 * An Origin Private File System in memory. As the real one does, a writable
 * stream's writes only reach the file when it is closed.
 */
function memoryOpfs(): { root: OpfsRoot; files: Map<string, Blob>; failWrites: (fail: boolean) => void } {
  let failing = false;
  const folders = new Map<string, Map<string, Blob>>();
  const files = new Map<string, Blob>();
  const root: OpfsRoot = {
    async getDirectoryHandle(name, { create = false } = {}) {
      if (!folders.has(name)) {
        if (!create) throw notFound();
        folders.set(name, new Map());
      }
      const folder = folders.get(name)!;
      return {
        async getFileHandle(file, { create: making = false } = {}) {
          if (!folder.has(file)) {
            if (!making) throw notFound();
            folder.set(file, new Blob([]));
          }
          return {
            getFile: async () => new File([folder.get(file)!], file),
            async createWritable() {
              let written: Blob | null = null;
              return {
                async write(data) {
                  if (failing) throw new DOMException("Full", "QuotaExceededError");
                  written = data;
                },
                async close() {
                  folder.set(file, written ?? new Blob([]));
                  files.set(`${name}/${file}`, folder.get(file)!);
                },
                async abort() {},
              };
            },
          };
        },
        async removeEntry(file) {
          if (!folder.delete(file)) throw notFound();
          files.delete(`${name}/${file}`);
        },
      };
    },
  };
  return { root, files, failWrites: (fail) => (failing = fail) };
}

async function text(blob: Blob | null): Promise<string | null> {
  return blob ? blob.text() : null;
}

describe.each<[string, () => StemModelStore]>([
  [
    "the Origin Private File System",
    () => {
      const { root } = memoryOpfs();
      return opfsModelStore(async () => root);
    },
  ],
  ["IndexedDB", () => indexedDbModelStore(new IDBFactory())],
])("the model kept in %s", (_where, made) => {
  test("there is none until one is written", async () => {
    expect(await made().read()).toBeNull();
  });

  test("reads back what was written, replacing what was there", async () => {
    const store = made();
    await store.write(new Blob(["first model"]));
    await store.write(new Blob(["second model"]));
    expect(await text(await store.read())).toBe("second model");
  });

  test("is gone once removed, and removing none is fine", async () => {
    const store = made();
    await store.remove();
    await store.write(new Blob(["model"]));
    await store.remove();
    expect(await store.read()).toBeNull();
  });
});

test("the Origin Private File System keeps the model as models/htdemucs.onnx", async () => {
  const opfs = memoryOpfs();
  await opfsModelStore(async () => opfs.root).write(new Blob(["model"]));
  expect([...opfs.files.keys()]).toEqual(["models/htdemucs.onnx"]);
});

test("a write that fails leaves the model that was there", async () => {
  const opfs = memoryOpfs();
  const store = opfsModelStore(async () => opfs.root);
  await store.write(new Blob(["good model"]));
  opfs.failWrites(true);
  await expect(store.write(new Blob(["half a model"]))).rejects.toMatchObject({ name: "QuotaExceededError" });
  expect(await text(await store.read())).toBe("good model");
});

test("IndexedDB stores are kept apart by their database's name", async () => {
  const factory = new IDBFactory();
  await indexedDbModelStore(factory, "one").write(new Blob(["model"]));
  expect(await indexedDbModelStore(factory, "two").read()).toBeNull();
  expect(await text(await indexedDbModelStore(factory, "one").read())).toBe("model");
});

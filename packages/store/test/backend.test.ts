import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Link, linkOf } from "@estoc/object";
import { describe, expect, it, onTestFinished } from "vitest";
import { type Backend, MemoryBackend } from "../src/index.ts";
import { SqliteBackend } from "../src/sqlite.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);
const blobsOf = (...texts: string[]) => new Map(texts.map((text) => [linkOf(utf8(text)), utf8(text)]));

async function openInTemporaryFolder(): Promise<Backend> {
  const folder = await mkdtemp(join(tmpdir(), "store-"));
  const backend = new SqliteBackend(join(folder, "store.db"));
  onTestFinished(async () => {
    backend.close();
    await rm(folder, { recursive: true });
  });
  return backend;
}

async function listed(backend: Backend, start?: number): Promise<Link<never>[]> {
  const links: Link<never>[] = [];
  for await (const link of backend.records(start)) links.push(link);
  return links;
}

describe.each([
  { name: "a MemoryBackend", open: async (): Promise<Backend> => new MemoryBackend() },
  { name: "a SqliteBackend", open: openInTemporaryFolder },
])("$name", ({ open }) => {
  it("gives back the bytes put under a link, and nothing for a link it was not given", async () => {
    const backend = await open();
    const blobs = blobsOf("one", "two");
    await backend.put(blobs, []);
    for (const [link, bytes] of blobs) {
      expect(await backend.get(link)).toEqual(bytes);
      expect(await backend.has(link)).toBe(true);
    }
    const missing = linkOf(utf8("three"));
    expect(await backend.get(missing)).toBeUndefined();
    expect(await backend.has(missing)).toBe(false);
  });

  it("keeps what was put when the array it gave back is changed", async () => {
    const backend = await open();
    const link = linkOf(utf8("one"));
    await backend.put(blobsOf("one"), []);
    (await backend.get(link))?.fill(0);
    expect(await backend.get(link)).toEqual(utf8("one"));
  });

  it("lists records in the order they were put, each once", async () => {
    const backend = await open();
    const a = linkOf(utf8("a"));
    const b = linkOf(utf8("b"));
    const c = linkOf(utf8("c"));
    await backend.put(blobsOf("a", "b"), [a, b]);
    await backend.put(blobsOf("c"), [c, a]);
    expect(await listed(backend)).toEqual([a, b, c]);
  });

  it("lists the records after the first `start`, in the order they were first put", async () => {
    const backend = await open();
    const a = linkOf(utf8("a"));
    const b = linkOf(utf8("b"));
    const c = linkOf(utf8("c"));
    await backend.put(blobsOf("a", "b"), [a, b]);
    await backend.put(blobsOf("c"), [c, a]);
    expect(await listed(backend, 1)).toEqual([b, c]);
    expect(await listed(backend, 3)).toEqual([]);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeObject, type Link, LinkValue, linkOf } from "@estoc/object";
import { type DataOf, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it, onTestFinished } from "vitest";
import { Store } from "../src/index.ts";
import { SqliteBackend } from "../src/sqlite.ts";

const anything = schema("Anything", { text: string(), to: optional(link()) });
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: DataOf<typeof anything>) => encodeObject(anything, data);
const blobsOf = (...texts: string[]) => new Map(texts.map((text) => [linkOf(utf8(text)), utf8(text)]));

async function makeTemporaryPath(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "store-"));
  onTestFinished(() => rm(folder, { recursive: true }));
  return join(folder, "store.db");
}

function open(path: string): SqliteBackend {
  const backend = new SqliteBackend(path);
  onTestFinished(() => backend.close());
  return backend;
}

async function listOf(links: AsyncIterable<Link<unknown>>): Promise<Link<unknown>[]> {
  const list: Link<unknown>[] = [];
  for await (const link of links) list.push(link);
  return list;
}

describe("a SqliteBackend", () => {
  it("reads what was put before, when the file is opened again", async () => {
    const path = await makeTemporaryPath();
    const blobs = blobsOf("one", "two");
    const listedLinks = [...blobs.keys()];
    const writer = new SqliteBackend(path);
    await writer.put(blobs, listedLinks);
    writer.close();
    const reader = open(path);
    for (const [link, bytes] of blobs) expect(await reader.get(link)).toEqual(bytes);
    expect(await listOf(reader.listedLinks())).toEqual(listedLinks);
  });

  it("reads what another backend open on the same file puts", async () => {
    const path = await makeTemporaryPath();
    const [writer, reader] = [open(path), open(path)];
    const one = utf8("one");
    await writer.put(new Map([[linkOf(one), one]]), [linkOf(one)]);
    expect(await reader.get(linkOf(one))).toEqual(one);
    expect(await listOf(reader.listedLinks())).toEqual([linkOf(one)]);
  });

  it("leaves nothing of a put that fails partway", async () => {
    const backend = open(await makeTemporaryPath());
    const blobs = blobsOf("one", "two");
    const failure = new Error("cut short");
    function* listedLinks() {
      yield linkOf(utf8("one"));
      throw failure;
    }
    await expect(backend.put(blobs, listedLinks())).rejects.toBe(failure);
    for (const link of blobs.keys()) expect(await backend.has(link)).toBe(false);
    expect(await listOf(backend.listedLinks())).toEqual([]);
  });

  it("lists a blob put after a put that fails partway right after those put before", async () => {
    const backend = open(await makeTemporaryPath());
    await backend.put(blobsOf("zero"), []);
    const failure = new Error("cut short");
    const listedLinks = {
      [Symbol.iterator](): Iterator<Link<never>> {
        throw failure;
      },
    };
    await expect(backend.put(blobsOf("one", "two"), listedLinks)).rejects.toBe(failure);
    await backend.put(blobsOf("three"), []);
    expect(await listOf(backend.blobs(1))).toEqual([linkOf(utf8("three"))]);
  });

  it("rejects every call once it is closed", async () => {
    const backend = new SqliteBackend(await makeTemporaryPath());
    backend.close();
    const link = linkOf(utf8("one"));
    await expect(backend.get(link)).rejects.toThrow();
    await expect(backend.has(link)).rejects.toThrow();
    await expect(backend.put(blobsOf("one"), [])).rejects.toThrow();
    await expect(listOf(backend.listedLinks())).rejects.toThrow();
  });
});

describe("a store in a SqliteBackend", () => {
  it("reads the same from another store opened on the file", async () => {
    const path = await makeTemporaryPath();
    const note = object({ text: "hello" });
    const reply = object({ text: "hi", to: new LinkValue(note.link) });
    const writer = new Store(open(path));
    await writer.write({ roots: [reply.link], blobs: [note.bytes, reply.bytes, ...anything.blobs] });
    const reader = new Store(open(path));
    expect(await listOf(reader.blobs())).toEqual(await listOf(writer.blobs()));
    expect(await reader.closure(reply.link)).toEqual(await writer.closure(reply.link));
  });

  it("refuses to give a blob whose bytes were changed in the file", async () => {
    const path = await makeTemporaryPath();
    const store = new Store(open(path));
    const note = object({ text: "hello" });
    await store.write({ roots: [note.link], blobs: [note.bytes, ...anything.blobs] });
    const database = new DatabaseSync(path);
    database.prepare("UPDATE blobs SET bytes = ? WHERE link = ?").run(utf8("changed"), note.link);
    database.close();
    await expect(store.get(note.link)).rejects.toThrow(`another blob under ${note.link}`);
  });
});

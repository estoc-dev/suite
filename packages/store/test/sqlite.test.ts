import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EstLink, encodeObject, est, type Link, linkOf } from "@estoc/object";
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

async function recordsOf(source: { records(): AsyncIterable<Link<never>> }): Promise<Link<never>[]> {
  const links: Link<never>[] = [];
  for await (const link of source.records()) links.push(link);
  return links;
}

describe("a SqliteBackend", () => {
  it("reads what was put before, when the file is opened again", async () => {
    const path = await makeTemporaryPath();
    const blobs = blobsOf("one", "two");
    const records = [...blobs.keys()];
    const writer = new SqliteBackend(path);
    await writer.put(blobs, records);
    writer.close();
    const reader = open(path);
    for (const [link, bytes] of blobs) expect(await reader.get(link)).toEqual(bytes);
    expect(await recordsOf(reader)).toEqual(records);
  });

  it("reads what another backend open on the same file puts", async () => {
    const path = await makeTemporaryPath();
    const [writer, reader] = [open(path), open(path)];
    const one = utf8("one");
    await writer.put(new Map([[linkOf(one), one]]), [linkOf(one)]);
    expect(await reader.get(linkOf(one))).toEqual(one);
    expect(await recordsOf(reader)).toEqual([linkOf(one)]);
  });

  it("leaves nothing of a put that fails partway", async () => {
    const backend = open(await makeTemporaryPath());
    const blobs = blobsOf("one", "two");
    const failure = new Error("cut short");
    function* records() {
      yield linkOf(utf8("one"));
      throw failure;
    }
    await expect(backend.put(blobs, records())).rejects.toBe(failure);
    for (const link of blobs.keys()) expect(await backend.has(link)).toBe(false);
    expect(await recordsOf(backend)).toEqual([]);
  });

  it("gives a blob put after a put that fails partway the position after those put before", async () => {
    const backend = open(await makeTemporaryPath());
    await backend.put(blobsOf("zero"), []);
    const failure = new Error("cut short");
    const records = {
      [Symbol.iterator](): Iterator<Link<never>> {
        throw failure;
      },
    };
    await expect(backend.put(blobsOf("one", "two"), records)).rejects.toBe(failure);
    await backend.put(blobsOf("three"), []);
    expect(await backend.positionOf(linkOf(utf8("three")))).toBe(1);
  });

  it("rejects every call once it is closed", async () => {
    const backend = new SqliteBackend(await makeTemporaryPath());
    backend.close();
    const link = linkOf(utf8("one"));
    await expect(backend.get(link)).rejects.toThrow();
    await expect(backend.has(link)).rejects.toThrow();
    await expect(backend.put(blobsOf("one"), [])).rejects.toThrow();
    await expect(recordsOf(backend)).rejects.toThrow();
  });
});

describe("a store in a SqliteBackend", () => {
  it("reads the same from another store opened on the file", async () => {
    const path = await makeTemporaryPath();
    const note = object({ text: "hello" });
    const reply = object({ text: "hi", to: new EstLink(note.link) });
    const writer = new Store(est, open(path));
    await writer.write({ records: [note, reply], blobs: [...anything.blobs] });
    const reader = new Store(est, open(path));
    expect(await recordsOf(reader)).toEqual(await recordsOf(writer));
    expect(await reader.closure(reply.link)).toEqual(await writer.closure(reply.link));
  });

  it("refuses to give a blob whose bytes were changed in the file", async () => {
    const path = await makeTemporaryPath();
    const store = new Store(est, open(path));
    const note = object({ text: "hello" });
    await store.write({ records: [note], blobs: [...anything.blobs] });
    const database = new DatabaseSync(path);
    database.prepare("UPDATE blobs SET bytes = ? WHERE link = ?").run(utf8("changed"), note.link);
    database.close();
    await expect(store.get(note.link)).rejects.toThrow(`another blob under ${note.link}`);
  });
});

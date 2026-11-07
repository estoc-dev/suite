import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeObject, encodeSchema, type JsonObject, json, type Link, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it, onTestFinished } from "vitest";
import { Store } from "../src/index.ts";
import { SqliteBackend } from "../src/sqlite.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const anything = await encodeSchema({ $schema: DRAFT }, defaultValidator);
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: JsonObject) => encodeObject(anything, data);
const blobs = (...texts: string[]) => new Map(texts.map((text) => [linkOf(utf8(text)), utf8(text)]));

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

async function listed(source: { records(): AsyncIterable<Link<never>> }): Promise<Link<never>[]> {
  const links: Link<never>[] = [];
  for await (const link of source.records()) links.push(link);
  return links;
}

describe("a SqliteBackend", () => {
  it("reads what was put before, when the file is opened again", async () => {
    const path = await makeTemporaryPath();
    const put = blobs("one", "two");
    const records = [...put.keys()];
    const first = new SqliteBackend(path);
    await first.put(put, records);
    first.close();
    const again = open(path);
    for (const [link, bytes] of put) expect(await again.get(link)).toEqual(bytes);
    expect(await listed(again)).toEqual(records);
  });

  it("reads what another backend open on the same file puts", async () => {
    const path = await makeTemporaryPath();
    const [writer, reader] = [open(path), open(path)];
    const one = utf8("one");
    await writer.put(new Map([[linkOf(one), one]]), [linkOf(one)]);
    expect(await reader.get(linkOf(one))).toEqual(one);
    expect(await listed(reader)).toEqual([linkOf(one)]);
  });

  it("leaves nothing of a put that fails partway", async () => {
    const backend = open(await makeTemporaryPath());
    const put = blobs("one", "two");
    const failure = new Error("cut short");
    function* records() {
      yield linkOf(utf8("one"));
      throw failure;
    }
    await expect(backend.put(put, records())).rejects.toBe(failure);
    for (const link of put.keys()) expect(await backend.has(link)).toBe(false);
    expect(await listed(backend)).toEqual([]);
  });

  it("rejects every call once it is closed", async () => {
    const backend = new SqliteBackend(await makeTemporaryPath());
    backend.close();
    const link = linkOf(utf8("one"));
    await expect(backend.get(link)).rejects.toThrow();
    await expect(backend.has(link)).rejects.toThrow();
    await expect(backend.put(blobs("one"), [])).rejects.toThrow();
    await expect(listed(backend)).rejects.toThrow();
  });
});

describe("a store in a SqliteBackend", () => {
  it("reads the same from another store opened on the file", async () => {
    const path = await makeTemporaryPath();
    const note = object({ text: "hello" });
    const reply = object({ text: "hi", to: { $link: note.link } });
    const written = new Store(json, open(path));
    await written.write({ records: [note, reply], blobs: anything.blobs });
    const opened = new Store(json, open(path));
    expect(await listed(opened)).toEqual(await listed(written));
    expect(await opened.closure(reply.link)).toEqual(await written.closure(reply.link));
  });

  it("refuses to give a blob whose bytes were changed in the file", async () => {
    const path = await makeTemporaryPath();
    const store = new Store(json, open(path));
    const note = object({ text: "hello" });
    await store.write({ records: [note], blobs: anything.blobs });
    const database = new DatabaseSync(path);
    database.prepare("UPDATE blobs SET bytes = ? WHERE link = ?").run(utf8("changed"), note.link);
    database.close();
    await expect(store.get(note.link)).rejects.toThrow(`another blob under ${note.link}`);
  });
});

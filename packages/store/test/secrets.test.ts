import { decodeBundle, encodeBundle } from "@estoc/bundle";
import { encodeObject, type Link, LinkValue, linkOf, objectsOf, readObject } from "@estoc/object";
import { link, schema, secretSchema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { Intake, indexOver, MemoryBackend, Store, selectedRecords, sendableBlobs } from "../src/index.ts";

// What names a Secret without being one, as a key that links to its secret bytes.
const keySchema = schema("Key", { name: string(), secret: link() });
const secretOf = (...bytes: number[]) => encodeObject(secretSchema, { bytes: Uint8Array.from(bytes) });
const keyTo = (secret: { readonly link: Link<unknown> }, name: string) =>
  encodeObject(keySchema, { name, secret: new LinkValue(secret.link) });
const recordedKeys = () => indexOver(selectedRecords(objectsOf(keySchema)), keySchema, ({ data }) => [data]);

async function listOf<T>(links: AsyncIterable<T>): Promise<T[]> {
  const listed: T[] = [];
  for await (const link of links) listed.push(link);
  return listed;
}

describe("a store", () => {
  it("keeps a Secret as any blob: reads it, lists it among its blobs, and gives it in a closure", async () => {
    const store = new Store(new MemoryBackend());
    const secret = secretOf(7);
    const key = keyTo(secret, "a");
    await store.write({
      roots: [key.link],
      blobs: [key.bytes, secret.bytes, ...keySchema.blobs, ...secretSchema.blobs],
    });
    expect((await readObject(store, secret.link, secretSchema)).data.bytes).toEqual(Uint8Array.of(7));
    expect(await listOf(store.blobs())).toContain(secret.link);
    expect([...(await store.closure(key.link)).keys()]).toContain(secret.link);
  });

  it("records a statement with the Secret it links to, and gives an index over records the link of the Secret", async () => {
    const store = new Store(new MemoryBackend());
    const secret = secretOf(7);
    const key = keyTo(secret, "a");
    await store.record({
      statements: [key.link],
      blobs: [key.bytes, secret.bytes, ...keySchema.blobs, ...secretSchema.blobs],
    });
    const [row] = await listOf((await store.scan(recordedKeys())).orderedBy("name").range(["a"]));
    expect(row?.data.secret.link).toBe(secret.link);
    expect(await listOf(store.records())).toEqual([key.link]);
  });
});

describe("an intake", () => {
  it("keeps a bundle that holds a Secret and what links to it, which records no key", async () => {
    const store = new Store(new MemoryBackend());
    const secret = secretOf(7);
    const key = keyTo(secret, "a");
    const bundle = decodeBundle(
      encodeBundle(key.link, [key.bytes, secret.bytes, ...keySchema.blobs, ...secretSchema.blobs]),
    );
    await new Intake(store).receive(bundle);
    expect(await store.get(secret.link)).toEqual(secret.bytes);
    expect(await listOf(await store.scan(recordedKeys()))).toEqual([]);
  });
});

describe("sendableBlobs", () => {
  it("throws at a Secret among the blobs, and names it", () => {
    const secret = secretOf(7);
    const key = keyTo(secret, "a");
    expect(() => [...sendableBlobs([key.bytes, secret.bytes, ...keySchema.blobs])]).toThrow(
      `${secret.link} is a Secret, which is not sent`,
    );
  });

  it("gives an object that links to a Secret, the schema of Secrets, and what is no object", () => {
    const key = keyTo(secretOf(7), "a");
    const image = new TextEncoder().encode("an image");
    const blobs = [key.bytes, ...keySchema.blobs, ...secretSchema.blobs, image];
    expect([...sendableBlobs(blobs)]).toEqual(blobs);
    expect(linkOf(image)).not.toBe(secretSchema.link);
  });
});

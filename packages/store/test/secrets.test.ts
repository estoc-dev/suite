import { decodeBundle, encodeBundle } from "@estoc/bundle";
import { encodeObject, type Link, LinkValue, linkOf, objectsOf, readObject } from "@estoc/object";
import { link, schema, secretSchema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  type Backend,
  Intake,
  indexOver,
  Marks,
  MemoryBackend,
  RefusedBatch,
  Secrets,
  Store,
  scan,
  selectedBlobs,
  selectedMarks,
} from "../src/index.ts";

// What names a Secret without being one, as a key that links to its secret bytes.
const keySchema = schema("Key", { name: string(), secret: link() });
const secretOf = (...bytes: number[]) => encodeObject(secretSchema, { bytes: Uint8Array.from(bytes) });
const keyTo = (secret: { readonly link: Link<unknown> }, name: string) =>
  encodeObject(keySchema, { name, secret: new LinkValue(secret.link) });

function sides(backend: Backend = new MemoryBackend()) {
  return { backend, store: new Store(backend), marks: new Marks(backend), secrets: new Secrets(backend) };
}
type Sides = ReturnType<typeof sides>;

async function listOf<T>(links: AsyncIterable<T>): Promise<T[]> {
  const listed: T[] = [];
  for await (const link of links) listed.push(link);
  return listed;
}

async function writeSecret({ secrets }: Sides, ...bytes: number[]) {
  const secret = secretOf(...bytes);
  await secrets.write({ roots: [secret.link], blobs: [secret.bytes, ...secretSchema.blobs] });
  return secret;
}

describe("secrets", () => {
  it("write a Secret, and give it and what the store holds", async () => {
    const stores = sides();
    const secret = await writeSecret(stores, 7);
    const key = keyTo(secret, "a");
    await stores.store.write({ roots: [key.link], blobs: [key.bytes, ...keySchema.blobs] });
    expect(await stores.secrets.get(secret.link)).toEqual(secret.bytes);
    expect((await readObject(stores.secrets, secret.link, secretSchema)).data.bytes).toEqual(Uint8Array.of(7));
    expect(await stores.secrets.get(key.link)).toEqual(key.bytes);
    expect(await stores.secrets.get(linkOf(Uint8Array.of(0)))).toBeUndefined();
  });

  it("list nothing as a mark", async () => {
    const stores = sides();
    await writeSecret(stores, 7);
    expect(await listOf(stores.store.marks())).toEqual([]);
  });

  it("refuse a batch with a blob in a root's closure that neither the batch nor the store holds", async () => {
    const { secrets } = sides();
    const key = keyTo(secretOf(7), "a");
    await expect(secrets.write({ roots: [key.link], blobs: [key.bytes, ...keySchema.blobs] })).rejects.toThrow(
      RefusedBatch,
    );
  });

  it("refuse to give a blob when the backend gives other bytes under the link", async () => {
    const backend = new MemoryBackend();
    const [secret, other] = [await writeSecret(sides(backend), 7), await writeSecret(sides(backend), 8)];
    const { secrets } = sides({
      get: (link) => backend.get(link === secret.link ? other.link : link),
      has: (link) => backend.has(link),
      put: (blobs, listedLinks) => backend.put(blobs, listedLinks),
      listedLinks: (start) => backend.listedLinks(start),
      blobs: (start) => backend.blobs(start),
    });
    await expect(secrets.get(secret.link)).rejects.toThrow(`another blob under ${secret.link}`);
  });

  it("cannot be given as a store, nor a store as them", () => {
    const { store, secrets } = sides();
    // @ts-expect-error: what reads Secrets gathers no closure to send on
    const asStore: Store = secrets;
    // @ts-expect-error: a store reads no Secret
    const asSecrets: Secrets = store;
    expect([asStore, asSecrets]).toEqual([secrets, store]);
  });
});

describe("a store whose backend holds a Secret", () => {
  it("refuses to give the Secret, and leaves it out of its blobs", async () => {
    const stores = sides();
    const secret = await writeSecret(stores, 7);
    await expect(stores.store.get(secret.link)).rejects.toThrow(
      `${secret.link} is a Secret, which the store does not read`,
    );
    const blobs = await listOf(stores.store.blobs());
    expect(blobs).not.toContain(secret.link);
    expect(blobs).toContain(secretSchema.link);
  });

  it("refuses a batch that would keep a Secret, whether or not the backend holds it", async () => {
    const stores = sides();
    const secret = secretOf(7);
    const batch = { roots: [secret.link], blobs: [secret.bytes, ...secretSchema.blobs] };
    await expect(stores.store.write(batch)).rejects.toThrow(RefusedBatch);
    await expect(stores.store.stage(batch)).rejects.toThrow(`${secret.link} is a Secret`);
    expect(await stores.backend.has(secret.link)).toBe(false);
    await stores.secrets.write(batch);
    await expect(stores.store.write(batch)).rejects.toThrow(RefusedBatch);
  });

  it("drops a Secret that no root of the batch reaches", async () => {
    const stores = sides();
    const [secret, key] = [secretOf(7), encodeObject(schema("Name", { name: string() }), { name: "a" })];
    await stores.store.write({ roots: [key.link], blobs: [key.bytes, ...key.schema.blobs, secret.bytes] });
    expect(await stores.backend.has(secret.link)).toBe(false);
  });

  it("writes an object that links to the Secret, and refuses the closure of it", async () => {
    const stores = sides();
    const secret = await writeSecret(stores, 7);
    const key = keyTo(secret, "a");
    await stores.store.write({ roots: [key.link], blobs: [key.bytes, ...keySchema.blobs] });
    expect(await stores.store.get(key.link)).toEqual(key.bytes);
    await expect(stores.store.closure(key.link)).rejects.toThrow(`${secret.link} is a Secret`);
    await expect(stores.store.closure(secret.link)).rejects.toThrow(`${secret.link} is a Secret`);
  });
});

describe("an intake", () => {
  it("refuses a bundle that holds a Secret, and writes no mark of it", async () => {
    const stores = sides();
    const secret = secretOf(7);
    const key = keyTo(secret, "a");
    const bundle = decodeBundle(
      encodeBundle(key.link, [key.bytes, secret.bytes, ...keySchema.blobs, ...secretSchema.blobs]),
    );
    await expect(new Intake(stores.store, stores.marks).receive(bundle)).rejects.toThrow(RefusedBatch);
    expect(await stores.backend.has(key.link)).toBe(false);
    expect(await listOf(stores.store.marks())).toEqual([]);
  });
});

describe("an index over blobs", () => {
  const named = schema("Named", { name: string() });
  const keyNames = () =>
    indexOver(selectedBlobs(objectsOf(keySchema)), named, ({ data }) => [{ name: data.name }]).orderedBy("name");
  const namesIn = async (store: Store, index: ReturnType<typeof keyNames>) =>
    (await listOf((await scan(store, index)).range([]))).map(({ data }) => data.name);

  it("goes on past a Secret, and reads on a later scan only the blobs put since", async () => {
    const stores = sides();
    const readNames: string[] = [];
    const index = indexOver(selectedBlobs(objectsOf(keySchema)), named, ({ data }) => {
      readNames.push(data.name);
      return [{ name: data.name }];
    }).orderedBy("name");
    const first = keyTo(await writeSecret(stores, 1), "a");
    await stores.store.write({ roots: [first.link], blobs: [first.bytes, ...keySchema.blobs] });
    const rows = await scan(stores.store, index);
    expect(rows.failures).toEqual([]);
    const second = keyTo(await writeSecret(stores, 2), "b");
    await stores.store.write({ roots: [second.link], blobs: [second.bytes] });
    expect(await namesIn(stores.store, index)).toEqual(["a", "b"]);
    expect(readNames).toEqual(["a", "b"]);
  });

  it("reads no object of the Secret schema", async () => {
    const stores = sides();
    await writeSecret(stores, 7);
    const index = indexOver(selectedBlobs(objectsOf(secretSchema)), named, () => [{ name: "read" }]).orderedBy("name");
    expect(await namesIn(stores.store, index)).toEqual([]);
  });

  it("fails the scan where its rows read a Secret", async () => {
    const stores = sides();
    const secret = await writeSecret(stores, 7);
    const key = keyTo(secret, "a");
    await stores.store.write({ roots: [key.link], blobs: [key.bytes, ...keySchema.blobs] });
    const index = indexOver(selectedBlobs(objectsOf(keySchema)), named, async function* ({ data }, reader) {
      await reader.get(data.secret.link);
      yield { name: data.name };
    }).orderedBy("name");
    await expect(scan(stores.store, index)).rejects.toThrow(`${secret.link} is a Secret`);
    expect(await namesIn(stores.store, keyNames())).toEqual(["a"]);
  });
});

describe("an index over marks", () => {
  it("gives the link of a Secret that a mark names, which the secrets then give", async () => {
    const stores = sides();
    const secret = await writeSecret(stores, 7);
    const key = keyTo(secret, "a");
    await stores.marks.write({ marks: [key.link], blobs: [key.bytes, ...keySchema.blobs] });
    const index = indexOver(selectedMarks(objectsOf(keySchema)), keySchema, ({ data }) => [data]).orderedBy("name");
    const [row] = await listOf((await scan(stores.store, index)).range(["a"]));
    const held = await readObject(stores.secrets, row?.data.secret.link as Link<unknown>, secretSchema);
    expect(held.data.bytes).toEqual(Uint8Array.of(7));
  });
});

import { type EncodedObject, encodeObject, type Link, LinkValue, linkOf, objectsOf, readObject } from "@estoc/object";
import { bytes, type DataOf, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  type Backend,
  indexOver,
  MemoryBackend,
  PrivateStore,
  RefusedBatch,
  SecretStore,
  Store,
  scan,
  selectedMarks,
  selectedSecrets,
} from "../src/index.ts";

// Every field these tests write, each optional, so that one schema takes all their objects.
const anything = schema("Anything", {
  name: optional(string()),
  card: optional(link()),
  image: optional(link()),
  secret: optional(bytes()),
  leak: optional(link()),
});
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: DataOf<typeof anything>) => encodeObject(anything, data);
// The batch that writes `secrets`, each with its bytes, and `blobs` with them.
const batchOf = (secrets: readonly EncodedObject[], blobs: readonly Uint8Array[] = []) => ({
  secrets: secrets.map(({ link }) => link),
  blobs: [...secrets.map(({ bytes }) => bytes), ...blobs],
});

function sides(sharedBackend: Backend = new MemoryBackend(), secretBackend: Backend = new MemoryBackend()) {
  const store = new Store(sharedBackend);
  return { store, secretStore: new SecretStore(store, secretBackend) };
}

async function listOf<T>(links: AsyncIterable<T>): Promise<T[]> {
  const listed: T[] = [];
  for await (const link of links) listed.push(link);
  return listed;
}

/** Writes a card to `store`, for a secret to link to. */
async function writeCard(store: Store) {
  const card = object({ name: "Alice" });
  await store.write({ roots: [card.link], blobs: [card.bytes, ...anything.blobs] });
  return card;
}

describe("a secret store", () => {
  it("gives what is kept in it and what the store beside it holds, and lists the secrets in the order they were written", async () => {
    const { store, secretStore } = sides();
    const card = await writeCard(store);
    const [first, second] = [
      object({ card: new LinkValue(card.link), secret: Uint8Array.of(0) }),
      object({ secret: Uint8Array.of(1) }),
    ];
    await secretStore.write(batchOf([first]));
    await secretStore.write(batchOf([second, first]));
    expect(await secretStore.get(first.link)).toEqual(first.bytes);
    expect(await secretStore.get(card.link)).toEqual(card.bytes);
    expect(await listOf(secretStore.secrets())).toEqual([first.link, second.link]);
  });

  it("lists the blobs kept in it, and none that only the store beside it holds", async () => {
    const { store, secretStore } = sides();
    const card = await writeCard(store);
    const image = utf8("an image");
    const secret = object({ card: new LinkValue(card.link), image: new LinkValue(linkOf(image)) });
    await secretStore.write(batchOf([secret], [image]));
    expect(await listOf(secretStore.blobs())).toEqual([linkOf(image), secret.link]);
  });

  it("keeps in its backend nothing that the store beside it holds already", async () => {
    const backend = new MemoryBackend();
    const { store, secretStore } = sides(new MemoryBackend(), backend);
    const card = await writeCard(store);
    const image = utf8("an image");
    const secret = object({ card: new LinkValue(card.link), image: new LinkValue(linkOf(image)) });
    await secretStore.write(batchOf([secret], [card.bytes, image, ...anything.blobs]));
    expect(await backend.has(secret.link)).toBe(true);
    expect(await backend.has(linkOf(image))).toBe(true);
    expect(await backend.has(card.link)).toBe(false);
    expect(await backend.has(anything.link)).toBe(false);
  });

  it("lists a secret that the store beside it holds as well, and does not keep its blob again", async () => {
    const backend = new MemoryBackend();
    const { store, secretStore } = sides(new MemoryBackend(), backend);
    const card = await writeCard(store);
    await secretStore.write(batchOf([card]));
    expect(await listOf(secretStore.secrets())).toEqual([card.link]);
    expect(await backend.has(card.link)).toBe(false);
  });

  it("refuses a batch with a blob in a secret's closure that neither the batch, it nor the store beside it holds", async () => {
    const { secretStore } = sides();
    const absent = object({ name: "absent" });
    const secret = object({ card: new LinkValue(absent.link) });
    await expect(secretStore.write(batchOf([secret], [...anything.blobs]))).rejects.toThrow(
      `${secret.link} links to ${absent.link}, which neither the batch nor the store holds`,
    );
    expect(await listOf(secretStore.secrets())).toEqual([]);
  });

  it("refuses a secret that is not an object", async () => {
    const { secretStore } = sides();
    const image = utf8("an image");
    const refusal = secretStore.write({ secrets: [linkOf(image)], blobs: [image] });
    await expect(refusal).rejects.toThrow(RefusedBatch);
    await expect(refusal).rejects.toThrow(`${linkOf(image)} is written as a secret but is not an object`);
  });

  it("refuses a secret whose blob the batch does not give, though the store beside it holds it", async () => {
    const { store, secretStore } = sides();
    const card = await writeCard(store);
    const refusal = secretStore.write({ secrets: [card.link], blobs: [] });
    await expect(refusal).rejects.toThrow(RefusedBatch);
    await expect(refusal).rejects.toThrow(
      `${card.link} is written as a secret but is not among the blobs of the batch`,
    );
    expect(await listOf(secretStore.secrets())).toEqual([]);
  });

  it("refuses to give a blob when the backend of the store beside it gives other bytes under the link", async () => {
    const backend = new MemoryBackend();
    const [card, other] = [object({ name: "Alice" }), object({ name: "Bob" })];
    await new Store(backend).write({
      roots: [card.link, other.link],
      blobs: [card.bytes, other.bytes, ...anything.blobs],
    });
    const { secretStore } = sides({
      get: (link) => backend.get(link === card.link ? other.link : link),
      has: (link) => backend.has(link),
      put: (blobs, listedLinks) => backend.put(blobs, listedLinks),
      listedLinks: (start) => backend.listedLinks(start),
      blobs: (start) => backend.blobs(start),
    });
    await expect(secretStore.get(card.link)).rejects.toThrow(`another blob under ${card.link}`);
  });

  it("is refused beside a store not made by `new Store`", () => {
    const store = new Store(new MemoryBackend());
    const lookalike: Store = {
      get: <T>(link: Link<T>) => store.get(link),
      write: (batch) => store.write(batch),
      stage: (batch) => store.stage(batch),
      blobs: () => store.blobs(),
      closure: (link) => store.closure(link),
    };
    expect(() => new SecretStore(lookalike, new MemoryBackend())).toThrow(TypeError);
  });

  it("cannot be given as a store, nor a store as it", () => {
    const { store, secretStore } = sides();
    // @ts-expect-error: a secret store has no closure to bundle what it keeps
    const asStore: Store = secretStore;
    // @ts-expect-error: a store would carry in bundles what is written to it
    const asSecret: SecretStore = store;
    expect(asStore).toBe(secretStore);
    expect(asSecret).toBe(store);
  });
});

describe("the store beside a secret store", () => {
  it("does not give, gather or list what is kept in the secret store", async () => {
    const { store, secretStore } = sides();
    const card = await writeCard(store);
    const secret = object({ card: new LinkValue(card.link) });
    await secretStore.write(batchOf([secret]));
    expect(await store.get(secret.link)).toBeUndefined();
    await expect(store.closure(secret.link)).rejects.toThrow(`the store does not hold ${secret.link}`);
    expect(await listOf(store.blobs())).not.toContain(secret.link);
  });

  it("refuses to write anything with a blob kept in the secret store in its closure", async () => {
    const { store, secretStore } = sides();
    const secret = object({ secret: Uint8Array.of(0) });
    await secretStore.write(batchOf([secret], [...anything.blobs]));
    const leak = object({ leak: new LinkValue(secret.link) });
    await expect(store.write({ roots: [leak.link], blobs: [leak.bytes, ...anything.blobs] })).rejects.toThrow(
      `${leak.link} links to ${secret.link}, which neither the batch nor the store holds`,
    );
    expect(await listOf(store.blobs())).toEqual([]);
  });
});

describe("an index over secrets", () => {
  const named = schema("Named", { name: string() });
  const cardNames = (source: typeof selectedSecrets) =>
    indexOver(source(objectsOf(anything)), named, async function* ({ data }, reader) {
      if (data.card === undefined) return;
      const { name } = (await readObject(reader, data.card.link, anything)).data;
      if (name !== undefined) yield { name };
    }).orderedBy("name");
  const namesIn = async (store: Parameters<typeof scan>[0], index: ReturnType<typeof cardNames>) =>
    (await listOf((await scan(store, index)).range([]))).map(({ data }) => data.name);

  it("reads the secrets that its selection takes, and through them what the store beside holds", async () => {
    const { store, secretStore } = sides();
    const card = await writeCard(store);
    await secretStore.write(batchOf([object({ card: new LinkValue(card.link) }), object({ name: "no card" })]));
    expect(await namesIn(secretStore, cardNames(selectedSecrets))).toEqual(["Alice"]);
  });

  it("reads nothing from a store or a private store, nor does an index over marks read a secret", async () => {
    const { store, secretStore } = sides();
    const privateStore = new PrivateStore(store, new MemoryBackend());
    const card = await writeCard(store);
    const linking = object({ card: new LinkValue(card.link) });
    await store.write({ roots: [linking.link], blobs: [linking.bytes] });
    await privateStore.write({ marks: [linking.link], blobs: [linking.bytes] });
    await secretStore.write(batchOf([linking]));
    expect(await namesIn(store, cardNames(selectedSecrets))).toEqual([]);
    expect(await namesIn(privateStore, cardNames(selectedSecrets))).toEqual([]);
    expect(await namesIn(secretStore, cardNames(selectedMarks))).toEqual([]);
  });

  it("reads on a later scan only the secrets written since", async () => {
    const { secretStore } = sides();
    const readNames: (string | undefined)[] = [];
    const index = indexOver(selectedSecrets(objectsOf(anything)), named, ({ data }) => {
      readNames.push(data.name);
      return data.name === undefined ? [] : [{ name: data.name }];
    }).orderedBy("name");
    await secretStore.write(batchOf([object({ name: "b" })], [...anything.blobs]));
    await scan(secretStore, index);
    await secretStore.write(batchOf([object({ name: "a" })]));
    expect((await listOf((await scan(secretStore, index)).range([]))).map(({ data }) => data.name)).toEqual(["a", "b"]);
    expect(readNames).toEqual(["b", "a"]);
  });

  it("fails the scan on a secret that its rows throw on", async () => {
    const { secretStore } = sides();
    await secretStore.write(batchOf([object({ name: "a" })], [...anything.blobs]));
    const index = indexOver(selectedSecrets(objectsOf(anything)), named, () => {
      throw new Error("not read");
    }).orderedBy("name");
    await expect(scan(secretStore, index)).rejects.toThrow("not read");
  });
});

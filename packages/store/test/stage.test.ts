import {
  ed25519,
  type IdentityVersionData,
  type IdentityVersionOrder,
  loadIdentity,
  noIdentityVersions,
  type People,
  SoftwareSigner,
} from "@estoc/identity";
import { type Est, EstLink, encodeObject, est, type Link, linkOf, objectsOf, readObject } from "@estoc/object";
import { array, type DataOf, integer, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  indexOver,
  MemoryBackend,
  type OrderedIndex,
  Store,
  selectedBlobs,
  selectedRecords,
  type View,
  view,
} from "../src/index.ts";

// Every field these tests write, each optional, so that one schema takes all their objects.
const anything = schema("Anything", {
  text: optional(string()),
  image: optional(link()),
  held: optional(link()),
});
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: DataOf<typeof anything>) => encodeObject(anything, data);

const newStore = () => new Store(est, new MemoryBackend());

async function recordsOf(store: { records(): AsyncIterable<Link<never>> }): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.records()) links.push(link);
  return links;
}

describe("a staged batch", () => {
  it("gives the blobs of the batch in its records' closures, and those the store holds", async () => {
    const store = newStore();
    const heldObject = object({ text: "held" });
    await store.write({ records: [heldObject], blobs: [...anything.blobs] });
    const image = utf8("an image");
    const note = object({ image: new EstLink(linkOf(image)), held: new EstLink(heldObject.link) });
    const stagedStore = await store.stage({ records: [note], blobs: [image] });
    expect(await stagedStore.get(note.link)).toEqual(note.bytes);
    expect(await stagedStore.get(linkOf(image))).toEqual(image);
    expect(await stagedStore.get(heldObject.link)).toEqual(heldObject.bytes);
    expect(await stagedStore.get(anything.link)).toEqual(anything.bytes);
  });

  it("gives none of the blobs of the batch outside its records' closures", async () => {
    const store = newStore();
    const stray = utf8("led to by nothing written");
    const carriedObject = object({ text: "carried" });
    const stagedStore = await store.stage({
      records: [object({ text: "hello" })],
      blobs: [stray, carriedObject.bytes, ...anything.blobs],
    });
    expect(await stagedStore.get(linkOf(stray))).toBeUndefined();
    expect(await stagedStore.get(carriedObject.link)).toBeUndefined();
  });

  it("gives where the store took in a blob it holds, and nothing for one that only the batch holds", async () => {
    const store = newStore();
    const held = object({ text: "held" });
    await store.write({ records: [held], blobs: [...anything.blobs] });
    const note = object({ held: new EstLink(held.link) });
    const stagedStore = await store.stage({ records: [note, held] });
    expect(await stagedStore.positionOf(held.link)).toBe(2);
    expect(await stagedStore.positionOf(note.link)).toBeUndefined();
    await stagedStore.commit();
    expect(await stagedStore.positionOf(note.link)).toBe(3);
  });

  it("lists the records of the store and of the batch, each once", async () => {
    const store = newStore();
    const [first, second, third] = [object({ text: "first" }), object({ text: "second" }), object({ text: "third" })];
    await store.write({ records: [first], blobs: [...anything.blobs] });
    const stagedStore = await store.stage({ records: [first, second, second, third] });
    expect((await recordsOf(stagedStore)).sort()).toEqual([first.link, second.link, third.link].sort());
  });

  it("is refused as a write of the batch is refused, and leaves the store as it was", async () => {
    const store = newStore();
    const carriedObject = object({ text: "carried" });
    await expect(
      store.stage({
        records: [{ bytes: Uint8Array.of(0x82, 1, 2) }],
        blobs: [carriedObject.bytes, ...anything.blobs],
      }),
    ).rejects.toThrow(/is not an object/);
    const image = utf8("an image");
    const note = object({ image: new EstLink(linkOf(image)) });
    await expect(store.stage({ records: [note], blobs: [carriedObject.bytes, ...anything.blobs] })).rejects.toThrow(
      `${note.link} links to ${linkOf(image)}, which neither the batch nor the store holds`,
    );
    expect(await store.get(carriedObject.link)).toBeUndefined();
    expect(await recordsOf(store)).toEqual([]);
  });

  it("leaves the store as it was until it is committed", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const stagedStore = await store.stage({ records: [note], blobs: [...anything.blobs] });
    expect(await recordsOf(stagedStore)).toEqual([note.link]);
    expect(await store.get(note.link)).toBeUndefined();
    expect(await store.get(anything.link)).toBeUndefined();
    expect(await recordsOf(store)).toEqual([]);
  });

  it("writes, once committed, what a write of the batch writes", async () => {
    const image = utf8("an image");
    const stray = utf8("led to by nothing written");
    const note = object({ text: "hello", image: new EstLink(linkOf(image)) });
    const batch = { records: [note], blobs: [image, stray, ...anything.blobs] };
    const [writtenStore, committedStore] = [newStore(), newStore()];
    await writtenStore.write(batch);
    const stagedStore = await committedStore.stage(batch);
    await stagedStore.commit();
    await stagedStore.commit();
    expect(await recordsOf(committedStore)).toEqual(await recordsOf(writtenStore));
    for (const link of [note.link, linkOf(image), linkOf(stray), anything.link])
      expect(await committedStore.get(link)).toEqual(await writtenStore.get(link));
  });

  it("can still be committed after other writes to the store", async () => {
    const store = newStore();
    const heldObject = object({ text: "held" });
    await store.write({ records: [heldObject], blobs: [...anything.blobs] });
    const note = object({ held: new EstLink(heldObject.link) });
    const stagedStore = await store.stage({ records: [note] });
    const other = object({ text: "other" });
    await store.write({ records: [other, note] });
    await stagedStore.commit();
    expect((await recordsOf(store)).sort()).toEqual([heldObject.link, other.link, note.link].sort());
    expect(await store.get(note.link)).toEqual(note.bytes);
  });

  it("keeps what it will write, whatever happens to the arrays it was given or gave out", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ image: new EstLink(linkOf(image)) });
    const [givenNote, givenImage] = [new Uint8Array(note.bytes), new Uint8Array(image)];
    const stagedStore = await store.stage({
      records: [{ bytes: givenNote }],
      blobs: [givenImage, ...anything.blobs],
    });
    givenNote.fill(0);
    givenImage.fill(0);
    (await stagedStore.get(note.link))?.fill(0);
    (await stagedStore.get(linkOf(image)))?.fill(0);
    expect(await stagedStore.get(note.link)).toEqual(note.bytes);
    await stagedStore.commit();
    expect(await store.get(note.link)).toEqual(note.bytes);
    expect(await store.get(linkOf(image))).toEqual(image);
  });
});

const noteSchema = schema("Note", { text: string(), tags: array(string()), at: integer() });
type Note = DataOf<typeof noteSchema>;
const note = (data: Note) => encodeObject(noteSchema, data);

const taggedSchema = schema("Tagged", { tag: string(), at: integer(), note: link() });
type Tagged = DataOf<typeof taggedSchema>;
type TaggedOrder = readonly ["tag", "at"];

const byTag: OrderedIndex<Est, Tagged, TaggedOrder> = indexOver(
  selectedRecords(objectsOf(noteSchema)),
  taggedSchema,
  ({ link, data }) => data.tags.map((tag) => ({ tag, at: data.at, note: new EstLink(link) })),
).orderedBy("tag", "at");

const texts: View<Est, Tagged, TaggedOrder, Promise<[tag: string, text: string][]>> = {
  index: byTag,
  async read(rows, reader) {
    const texts: [tag: string, text: string][] = [];
    for await (const { data } of rows.range([]))
      texts.push([data.tag, (await readObject(reader, data.note.link, noteSchema)).data.text]);
    return texts;
  },
};

const { signatures, identityVersions, publish } = loadIdentity([ed25519]);
const root = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const agent = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));

const people: View<Est, IdentityVersionData, IdentityVersionOrder, People> = {
  index: indexOver(selectedBlobs(identityVersions.selection), identityVersions.schema, (identityVersion) => [
    identityVersion,
  ]).orderedBy(...identityVersions.order),
  read: (rows, reader) => identityVersions.people(rows, reader),
};

describe("a view of a staged batch", () => {
  it("is the view of the store once the batch is committed, when nothing else is written in between", async () => {
    const store = newStore();
    await store.write({
      records: [note({ text: "soup", tags: ["lunch"], at: 1 })],
      blobs: [...noteSchema.blobs],
    });
    const stagedStore = await store.stage({
      records: [note({ text: "salad", tags: ["lunch", "dinner"], at: 2 })],
      blobs: [note({ text: "stew", tags: ["dinner"], at: 3 }).bytes],
    });
    const before = await view(stagedStore, texts);
    await stagedStore.commit();
    expect(before).toEqual(await view(store, texts));
    expect(before).toEqual([
      ["dinner", "salad"],
      ["lunch", "soup"],
      ["lunch", "salad"],
    ]);
  });

  it("takes in, when viewed again, what is written to the store after the batch was staged, and the batch is still committed", async () => {
    const store = newStore();
    const hello = object({ text: "hello" });
    const listing = await publish(root, { agents: [agent.key], at: 1_000 });
    const byAgent = await signatures.actor(agent, listing).sign(hello);
    const stagedStore = await store.stage({
      records: [byAgent],
      blobs: [hello.bytes, ...anything.blobs, ...signatures.schema.blobs, ...byAgent.signedIdentity.blobs],
    });
    const before = await view(stagedStore, people);
    expect((await signatures.read(byAgent.link, stagedStore, before)).object).toBe(hello.link);

    const agentsOut = object({ text: "agents out" });
    const byRoot = await signatures.actor(root, await publish(root, { prior: listing, at: 2_000 })).sign(agentsOut);
    await store.write({
      records: [byRoot],
      blobs: [agentsOut.bytes, ...anything.blobs, ...signatures.schema.blobs, ...byRoot.signedIdentity.blobs],
    });
    await expect(signatures.read(byAgent.link, stagedStore, await view(stagedStore, people))).rejects.toThrow(
      "is not honored",
    );
    expect((await signatures.read(byAgent.link, stagedStore, before)).object).toBe(hello.link);

    await stagedStore.commit();
    expect(await store.get(byAgent.link)).toEqual(byAgent.bytes);
    expect(await store.get(hello.link)).toEqual(hello.bytes);
  });

  it("takes in the batch after what the store holds, so a signature the store holds is honored as it took it in", async () => {
    const store = newStore();
    const hello = object({ text: "hello" });
    const listing = await publish(root, { agents: [agent.key], at: 1_000 });
    const byAgent = await signatures.actor(agent, listing).sign(hello);
    await store.write({
      records: [byAgent],
      blobs: [hello.bytes, ...anything.blobs, ...signatures.schema.blobs, ...listing.blobs],
    });
    const agentsOut = await publish(root, { prior: listing, at: 2_000 });
    const stagedStore = await store.stage({ records: [agentsOut], blobs: agentsOut.blobs });
    const stagedPeople = await view(stagedStore, people);
    const signature = await signatures.read(byAgent.link, stagedStore, noIdentityVersions);
    expect(await stagedPeople.asTakenIn.honors(signature)).toBe(true);
    expect(await stagedPeople.honors(signature)).toBe(false);
  });

  it("takes a signature that only the batch holds as coming in now, and as the store took it in once committed", async () => {
    const store = newStore();
    const hello = object({ text: "hello" });
    const listing = await publish(root, { agents: [agent.key], at: 1_000 });
    const byAgent = await signatures.actor(agent, listing).sign(hello);
    const agentsOut = await publish(root, { prior: listing, at: 2_000 });
    const stagedStore = await store.stage({
      records: [byAgent, agentsOut],
      blobs: [hello.bytes, ...anything.blobs, ...signatures.schema.blobs, ...agentsOut.blobs],
    });
    const stagedPeople = await view(stagedStore, people);
    const signature = await signatures.read(byAgent.link, stagedStore, noIdentityVersions);
    expect(await stagedPeople.asTakenIn.honors(signature)).toBe(false);

    await stagedStore.commit();
    expect(await stagedPeople.asTakenIn.honors(signature)).toBe(true);
    expect(await (await view(store, people)).asTakenIn.honors(signature)).toBe(true);
  });
});

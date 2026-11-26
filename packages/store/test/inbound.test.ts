import { decodeBundle, encodeBundle } from "@estoc/bundle";
import {
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  linkOf,
  objectsOf,
  readObject,
  type ValueMap,
} from "@estoc/object";
import { type DataOf, integer, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  arrivalsView,
  type InboundObject,
  Intake,
  inboundSchema,
  indexOver,
  MemoryBackend,
  RefusedBatch,
  Store,
  selectedBlobs,
  selectedRecords,
  view,
} from "../src/index.ts";

// Every field these tests write, each optional, so that one schema takes all their objects.
const anything = schema("Anything", {
  text: optional(string()),
  name: optional(string()),
  image: optional(link()),
  icon: optional(link()),
  to: optional(link()),
});
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: DataOf<typeof anything>) => encodeObject(anything, data);
const bundleOf = (root: EncodedObject, blobs: Iterable<Uint8Array> = [...anything.blobs]) =>
  decodeBundle(encodeBundle(root.link, [root.bytes, ...blobs]));

const ticking = (start = 1000) => {
  let at = start;
  return () => at++;
};

function sides(clock = ticking()) {
  const store = new Store(new MemoryBackend());
  return { store, intake: new Intake(store, clock) };
}

async function listOf<T>(links: AsyncIterable<T>): Promise<T[]> {
  const listed: T[] = [];
  for await (const link of links) listed.push(link);
  return listed;
}

describe("inboundSchema", () => {
  const blob = new LinkValue(linkOf(utf8("a blob")));

  it.each<[string, ValueMap]>([
    ["without via", { bundle: blob, at: 0 }],
    ["with via", { bundle: blob, at: 0, via: blob }],
  ])("takes an object %s", (_, data) => {
    expect(() => inboundSchema.validate(data)).not.toThrow();
  });

  it.each<[string, ValueMap]>([
    ["without a bundle", { at: 0 }],
    ["without at", { bundle: blob }],
    ["whose bundle is not a link", { bundle: "a blob", at: 0 }],
    ["whose via is not a link", { bundle: blob, at: 0, via: "a mailbox" }],
    ["whose at is not whole milliseconds", { bundle: blob, at: 0.5 }],
    ["with a field it does not name", { bundle: blob, at: 0, mailbox: blob }],
  ])("refuses an object %s", (_, data) => {
    expect(() => inboundSchema.validate(data)).toThrow();
  });
});

describe("an intake", () => {
  it("keeps a bundle in the store, and records that it came in, by its clock", async () => {
    const { store, intake } = sides();
    const image = utf8("an image");
    const note = object({ image: new LinkValue(linkOf(image)) });
    const inbound = await intake.receive(bundleOf(note, [image, ...anything.blobs]));
    expect(inbound.data).toEqual({ bundle: new LinkValue(note.link), at: 1000 });
    expect(await store.get(note.link)).toEqual(note.bytes);
    expect(await store.get(linkOf(image))).toEqual(image);
    expect(await listOf(store.records())).toEqual([inbound.link]);
    expect(await store.get(inbound.link)).toEqual(inbound.bytes);
  });

  it("drops the blobs of a bundle outside its root's closure, whatever they link to", async () => {
    const { store, intake } = sides();
    const stray = object({ image: new LinkValue(linkOf(utf8("not in the bundle"))) });
    const note = object({ text: "hello" });
    await intake.receive(bundleOf(note, [stray.bytes, ...anything.blobs]));
    expect(await store.get(note.link)).toEqual(note.bytes);
    expect(await store.get(stray.link)).toBeUndefined();
  });

  it("keeps the channel a bundle came in by with the record, and gives it as via", async () => {
    const { store, intake } = sides();
    const channel = schema("Channel", { name: string() });
    const mailbox = encodeObject(channel, { name: "a mailbox" });
    const note = object({ text: "hello" });
    const inbound = await intake.receive(bundleOf(note), mailbox);
    expect(inbound.data).toEqual({ bundle: new LinkValue(note.link), at: 1000, via: new LinkValue(mailbox.link) });
    expect(await listOf(store.records())).toEqual([inbound.link]);
    expect(await store.get(mailbox.link)).toEqual(mailbox.bytes);
    expect(await store.get(channel.link)).toEqual(channel.bytes);
  });

  it("takes the time from Date.now unless given a clock", async () => {
    const before = Date.now();
    const intake = new Intake(new Store(new MemoryBackend()));
    const { data } = await intake.receive(bundleOf(object({ text: "hello" })));
    expect(data.at).toBeGreaterThanOrEqual(before);
    expect(data.at).toBeLessThanOrEqual(Date.now());
  });

  it("records a bundle once for each time it comes in", async () => {
    const { store, intake } = sides();
    const bundle = bundleOf(object({ text: "hello" }));
    const first = await intake.receive(bundle);
    const second = await intake.receive(bundle);
    expect(second.data.at).toBeGreaterThan(first.data.at);
    expect(await listOf(store.records())).toEqual([first.link, second.link]);
  });

  it("records a bundle once when it comes in twice at the same time by its clock", async () => {
    const { store, intake } = sides(() => 1000);
    const bundle = bundleOf(object({ text: "hello" }));
    const first = await intake.receive(bundle);
    const second = await intake.receive(bundle);
    expect(second.link).toBe(first.link);
    expect(await listOf(store.records())).toEqual([first.link]);
  });

  it("takes a bundle that leaves out blobs the store holds", async () => {
    const { store, intake } = sides();
    const heldNote = object({ text: "held" });
    await store.write({ roots: [heldNote.link], blobs: [heldNote.bytes, ...anything.blobs] });
    const reply = object({ to: new LinkValue(heldNote.link) });
    await intake.receive(bundleOf(reply, []));
    expect(await store.get(reply.link)).toEqual(reply.bytes);
  });

  it("refuses a bundle that leaves out a blob of its root's closure that the store does not hold", async () => {
    const { store, intake } = sides();
    const missing = utf8("not in the bundle");
    const note = object({ image: new LinkValue(linkOf(missing)) });
    await expect(intake.receive(bundleOf(note))).rejects.toThrow(RefusedBatch);
    expect(await listOf(store.records())).toEqual([]);
    expect(await store.get(note.link)).toBeUndefined();
  });

  it("stages a bundle, and neither keeps it nor records that it came in until that is committed", async () => {
    const { store, intake } = sides();
    const channel = schema("Channel", { name: string() });
    const mailbox = encodeObject(channel, { name: "a mailbox" });
    const note = object({ text: "hello" });
    const stagedStore = await intake.stage(bundleOf(note), mailbox);
    expect(await stagedStore.get(note.link)).toEqual(note.bytes);
    expect(await store.get(note.link)).toBeUndefined();
    expect(await listOf(store.records())).toEqual([]);
    await stagedStore.commit();
    expect(await store.get(note.link)).toEqual(note.bytes);
    const [inbound, ...others] = (await listOf(store.records())) as Link<InboundObject>[];
    expect(others).toEqual([]);
    expect((await readObject(store, inbound as Link<InboundObject>, inboundSchema)).data).toEqual({
      bundle: new LinkValue(note.link),
      at: 1000,
      via: new LinkValue(mailbox.link),
    });
  });

  it("gives a view of the arrivals, on a staged bundle, no arrival of the bundle until that is committed", async () => {
    const { store, intake } = sides();
    const note = object({ text: "hello" });
    const arrivals = arrivalsView(anything);
    const stagedStore = await intake.stage(bundleOf(note));
    expect(await (await view(stagedStore, arrivals)).atOf(note.link)).toBeUndefined();
    await stagedStore.commit();
    expect(await (await view(store, arrivals)).atOf(note.link)).toBe(1000);
  });

  it("gives an index over blobs, on a staged bundle, the blobs of the bundle", async () => {
    const { intake } = sides();
    const textSchema = schema("Text", { text: string() });
    const texts = indexOver(selectedBlobs(objectsOf(anything)), textSchema, ({ data }) =>
      data.text === undefined ? [] : [{ text: data.text }],
    );
    const stagedStore = await intake.stage(bundleOf(object({ text: "hello" })));
    expect(
      (await listOf((await stagedStore.scan(texts)).orderedBy("text").range([]))).map(({ data }) => data.text),
    ).toEqual(["hello"]);
  });

  it("refuses to stage a bundle that it refuses to receive", async () => {
    const { intake } = sides();
    const note = object({ image: new LinkValue(linkOf(utf8("not in the bundle"))) });
    await expect(intake.stage(bundleOf(note))).rejects.toThrow(RefusedBatch);
  });

  it("keeps a bundle with no record of it when the channel links to a blob that nothing holds", async () => {
    const { store, intake } = sides();
    const mailbox = object({ name: "a mailbox", icon: new LinkValue(linkOf(utf8("not held"))) });
    const note = object({ text: "hello" });
    await expect(intake.receive(bundleOf(note), mailbox)).rejects.toThrow(RefusedBatch);
    expect(await store.get(note.link)).toEqual(note.bytes);
    expect(await listOf(store.records())).toEqual([]);
  });
});

describe("what an intake records", () => {
  const arrivalSchema = schema("Arrival", { bundle: link<never>(), at: integer() });
  const cameIn = indexOver(selectedRecords(objectsOf(inboundSchema)), arrivalSchema, ({ data }) => [
    { bundle: data.bundle, at: data.at },
  ]);

  it("gives an index when each bundle came in, the earliest first", async () => {
    const { store, intake } = sides();
    const bundle = bundleOf(object({ text: "hello" }));
    await intake.receive(bundle);
    await intake.receive(bundle);
    const rows = await listOf((await store.scan(cameIn)).orderedBy("bundle", "at").range([new LinkValue(bundle.link)]));
    expect(rows.map(({ data }) => data.at)).toEqual([1000, 1001]);
  });

  it("are the only Inbound an index reads: one that someone sends is a blob of the store", async () => {
    const { store, intake } = sides();
    const note = object({ text: "hello" });
    const sentInbound = encodeObject(inboundSchema, { bundle: new LinkValue(note.link as Link<never>), at: 0 });
    await intake.receive(bundleOf(sentInbound, [note.bytes, ...anything.blobs, ...inboundSchema.blobs]));
    expect(await store.get(sentInbound.link)).toEqual(sentInbound.bytes);
    const rows = await listOf((await store.scan(cameIn)).orderedBy("bundle", "at").range([]));
    expect(rows.map(({ data }) => data)).toEqual([{ bundle: new LinkValue(sentInbound.link), at: 1000 }]);
  });
});

import { decodeBundle, encodeBundle } from "@estoc/bundle";
import { encodeObject, type Link, LinkValue, linkOf, objectsOf, readObject, type ValueMap } from "@estoc/object";
import { type DataOf, integer, link, optional, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  type InboundObject,
  Intake,
  inboundSchema,
  indexOver,
  MemoryBackend,
  RefusedBatch,
  recordSchema,
  Store,
  scan,
  selectedRecords,
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
const bundleOf = (root: { readonly bytes: Uint8Array }, blobs: Iterable<Uint8Array> = [...anything.blobs]) =>
  decodeBundle(encodeBundle(root, blobs));

const newStore = () => new Store(new MemoryBackend());
const ticking = (start = 1000) => {
  let at = start;
  return () => at++;
};
const intakeOf = (store: Store, clock = ticking()) => new Intake(store, clock);

async function recordedObjectsOf(store: Pick<Store, "get" | "records">): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const record of store.records())
    links.push((await readObject(store, record, recordSchema)).data.object.link);
  return links;
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
  it("keeps a bundle and records an Inbound that says it came in, by its clock, and nothing else", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ image: new LinkValue(linkOf(image)) });
    const inbound = await intakeOf(store).receive(bundleOf(note, [image, ...anything.blobs]));
    expect(inbound.data).toEqual({ bundle: new LinkValue(note.link), at: 1000 });
    expect(await recordedObjectsOf(store)).toEqual([inbound.link]);
    expect(await store.get(note.link)).toEqual(note.bytes);
    expect(await store.get(linkOf(image))).toEqual(image);
    expect(await store.get(inboundSchema.link)).toEqual(inboundSchema.bytes);
  });

  it("keeps the channel a bundle came in by with its schema, and gives it as via", async () => {
    const store = newStore();
    const channel = schema("Channel", { name: string() });
    const mailbox = encodeObject(channel, { name: "a mailbox" });
    const note = object({ text: "hello" });
    const inbound = await intakeOf(store).receive(bundleOf(note), mailbox);
    expect(inbound.data).toEqual({ bundle: new LinkValue(note.link), at: 1000, via: new LinkValue(mailbox.link) });
    expect(await recordedObjectsOf(store)).toEqual([inbound.link]);
    expect(await store.get(mailbox.link)).toEqual(mailbox.bytes);
    expect(await store.get(channel.link)).toEqual(channel.bytes);
  });

  it("takes the time from Date.now unless given a clock", async () => {
    const before = Date.now();
    const intake = new Intake(newStore());
    const { data } = await intake.receive(bundleOf(object({ text: "hello" })));
    expect(data.at).toBeGreaterThanOrEqual(before);
    expect(data.at).toBeLessThanOrEqual(Date.now());
  });

  it("records a bundle once for each time it comes in", async () => {
    const store = newStore();
    const intake = intakeOf(store);
    const bundle = bundleOf(object({ text: "hello" }));
    const first = await intake.receive(bundle);
    const second = await intake.receive(bundle);
    expect(second.data.at).toBeGreaterThan(first.data.at);
    expect((await recordedObjectsOf(store)).sort()).toEqual([first.link, second.link].sort());
  });

  it("records a bundle once when it comes in twice at the same time by its clock", async () => {
    const store = newStore();
    const intake = intakeOf(store, () => 1000);
    const bundle = bundleOf(object({ text: "hello" }));
    const first = await intake.receive(bundle);
    const second = await intake.receive(bundle);
    expect(second.link).toBe(first.link);
    expect(await recordedObjectsOf(store)).toEqual([first.link]);
  });

  it("takes a bundle that leaves out blobs the store holds", async () => {
    const store = newStore();
    const heldNote = object({ text: "held" });
    await store.write({ records: [heldNote], blobs: [...anything.blobs] });
    const reply = object({ to: new LinkValue(heldNote.link) });
    await intakeOf(store).receive(bundleOf(reply, []));
    expect(await store.get(reply.link)).toEqual(reply.bytes);
  });

  it("refuses a bundle that leaves out a blob of its root's closure that the store does not hold", async () => {
    const store = newStore();
    const missing = utf8("not in the bundle");
    const note = object({ image: new LinkValue(linkOf(missing)) });
    const intake = intakeOf(store);
    await expect(intake.receive(bundleOf(note))).rejects.toThrow(RefusedBatch);
    expect(await recordedObjectsOf(store)).toEqual([]);
    expect(await store.get(note.link)).toBeUndefined();
  });

  it("stages a bundle with the Inbound that says it came in, and keeps neither until that is committed", async () => {
    const store = newStore();
    const channel = schema("Channel", { name: string() });
    const mailbox = encodeObject(channel, { name: "a mailbox" });
    const note = object({ text: "hello" });
    const stagedStore = await intakeOf(store).stage(bundleOf(note), mailbox);
    const stagedObjects = await recordedObjectsOf(stagedStore);
    expect(stagedObjects).toHaveLength(1);
    const inbound = stagedObjects[0] as Link<InboundObject>;
    expect((await readObject(stagedStore, inbound, inboundSchema)).data).toEqual({
      bundle: new LinkValue(note.link),
      at: 1000,
      via: new LinkValue(mailbox.link),
    });
    expect(await stagedStore.get(note.link)).toEqual(note.bytes);
    expect(await recordedObjectsOf(store)).toEqual([]);
    expect(await store.get(note.link)).toBeUndefined();
    await stagedStore.commit();
    expect(await recordedObjectsOf(store)).toEqual([inbound]);
    expect(await store.get(note.link)).toEqual(note.bytes);
    expect(await store.get(mailbox.link)).toEqual(mailbox.bytes);
  });

  it("refuses to stage a bundle that it refuses to receive", async () => {
    const store = newStore();
    const note = object({ image: new LinkValue(linkOf(utf8("not in the bundle"))) });
    await expect(intakeOf(store).stage(bundleOf(note))).rejects.toThrow(RefusedBatch);
  });

  it("refuses a channel that links to a blob neither the bundle nor the store holds, and keeps nothing", async () => {
    const store = newStore();
    const mailbox = object({ name: "a mailbox", icon: new LinkValue(linkOf(utf8("not in the bundle"))) });
    const note = object({ text: "hello" });
    const intake = intakeOf(store);
    await expect(intake.receive(bundleOf(note), mailbox)).rejects.toThrow(RefusedBatch);
    expect(await recordedObjectsOf(store)).toEqual([]);
    expect(await store.get(note.link)).toBeUndefined();
    expect(await store.get(mailbox.link)).toBeUndefined();
  });
});

describe("what an intake records", () => {
  const arrivalSchema = schema("Arrival", { bundle: link<never>(), at: integer() });
  const cameIn = indexOver(selectedRecords(objectsOf(inboundSchema)), arrivalSchema, ({ data }) => [
    { bundle: data.bundle, at: data.at },
  ]).orderedBy("bundle", "at");

  it("gives an index when each bundle came in, the earliest first", async () => {
    const store = newStore();
    const intake = intakeOf(store);
    const bundle = bundleOf(object({ text: "hello" }));
    await intake.receive(bundle);
    await intake.receive(bundle);
    const times: number[] = [];
    for await (const { data } of (await scan(store, cameIn)).range([new LinkValue(bundle.link)])) times.push(data.at);
    expect(times).toEqual([1000, 1001]);
  });

  it("are the only Inbound an index reads: one that someone sends stays in the closure of what came in", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const sentInbound = encodeObject(inboundSchema, { bundle: new LinkValue(note.link as Link<never>), at: 0 });
    await intakeOf(store).receive(bundleOf(sentInbound, [note.bytes, ...anything.blobs, ...inboundSchema.blobs]));
    const rows: DataOf<typeof arrivalSchema>[] = [];
    for await (const { data } of (await scan(store, cameIn)).range([])) rows.push(data);
    expect(rows).toEqual([{ bundle: new LinkValue(sentInbound.link), at: 1000 }]);
  });
});

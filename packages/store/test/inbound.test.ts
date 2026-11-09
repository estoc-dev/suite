import { readBundle, writeBundle } from "@estoc/bundle";
import {
  encodeObject,
  encodeSchema,
  type Json,
  type JsonObject,
  json,
  type Link,
  linkOf,
  objectsOf,
  type Schema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import {
  type InboundData,
  type Index,
  inboundSchema,
  indexOver,
  loadIntake,
  MemoryBackend,
  RefusedBatch,
  Store,
  scan,
} from "../src/index.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const anything = await encodeSchema({ $schema: DRAFT }, defaultValidator);
const inbound: Schema<Json, InboundData> = await encodeSchema(inboundSchema, defaultValidator);
const utf8 = (text: string) => new TextEncoder().encode(text);
const object = (data: JsonObject) => encodeObject(anything, data);
const bundleOf = (root: { readonly bytes: Uint8Array }, blobs: Iterable<Uint8Array> = anything.blobs) =>
  readBundle(writeBundle(root, blobs));

const newStore = () => new Store(json, new MemoryBackend());
const ticking = (start = 1000) => {
  let at = start;
  return () => at++;
};
const intakeOf = (store: Store, clock = ticking()) => loadIntake(store, { validator: defaultValidator, clock });

async function recordsOf(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.records()) links.push(link);
  return links;
}

describe("inboundSchema", () => {
  const link = { $link: linkOf(utf8("a blob")) };

  it.each<[string, JsonObject]>([
    ["without via", { bundle: link, at: 0 }],
    ["with via", { bundle: link, at: 0, via: link }],
  ])("takes a record %s", (_, data) => {
    expect(() => inbound.validate(data)).not.toThrow();
  });

  it.each<[string, JsonObject]>([
    ["without a bundle", { at: 0 }],
    ["without at", { bundle: link }],
    ["whose bundle is not a link", { bundle: "a blob", at: 0 }],
    ["whose via is not a link", { bundle: link, at: 0, via: "a mailbox" }],
    ["whose at is before the epoch", { bundle: link, at: -1 }],
    ["whose at is not whole milliseconds", { bundle: link, at: 0.5 }],
    ["with a field it does not name", { bundle: link, at: 0, mailbox: link }],
  ])("refuses a record %s", (_, data) => {
    expect(() => inbound.validate(data)).toThrow();
  });
});

describe("an intake", () => {
  it("keeps a bundle with a record that it came in, by its clock, and lists only the record", async () => {
    const store = newStore();
    const image = utf8("an image");
    const note = object({ image: { $link: linkOf(image) } });
    const record = await (await intakeOf(store)).receive(bundleOf(note, [image, ...anything.blobs]));
    expect(record.data).toEqual({ bundle: { $link: note.link }, at: 1000 });
    expect(await recordsOf(store)).toEqual([record.link]);
    expect(await store.get(note.link)).toEqual(note.bytes);
    expect(await store.get(linkOf(image))).toEqual(image);
    expect(await store.get(inbound.link)).toEqual(inbound.bytes);
  });

  it("gives the channel a bundle came in by as via", async () => {
    const store = newStore();
    const mailbox = object({ name: "a mailbox" });
    await store.write({ records: [mailbox], blobs: anything.blobs });
    const note = object({ text: "hello" });
    const record = await (await intakeOf(store)).receive(bundleOf(note), mailbox.link);
    expect(record.data).toEqual({ bundle: { $link: note.link }, at: 1000, via: { $link: mailbox.link } });
  });

  it("takes the time from Date.now unless given a clock", async () => {
    const before = Date.now();
    const intake = await loadIntake(newStore(), { validator: defaultValidator });
    const { data } = await intake.receive(bundleOf(object({ text: "hello" })));
    expect(data.at).toBeGreaterThanOrEqual(before);
    expect(data.at).toBeLessThanOrEqual(Date.now());
  });

  it("records a bundle once for each time it comes in", async () => {
    const store = newStore();
    const intake = await intakeOf(store);
    const bundle = bundleOf(object({ text: "hello" }));
    const first = await intake.receive(bundle);
    const second = await intake.receive(bundle);
    expect(second.data.at).toBeGreaterThan(first.data.at);
    expect((await recordsOf(store)).sort()).toEqual([first.link, second.link].sort());
  });

  it("takes a bundle that leaves out blobs the store holds", async () => {
    const store = newStore();
    const held = object({ text: "held" });
    await store.write({ records: [held], blobs: anything.blobs });
    const reply = object({ to: { $link: held.link } });
    await (await intakeOf(store)).receive(bundleOf(reply, []));
    expect(await store.get(reply.link)).toEqual(reply.bytes);
  });

  it("refuses a bundle that leaves out a blob of its root's closure that the store does not hold", async () => {
    const store = newStore();
    const missing = utf8("not in the bundle");
    const note = object({ image: { $link: linkOf(missing) } });
    const intake = await intakeOf(store);
    await expect(intake.receive(bundleOf(note))).rejects.toThrow(RefusedBatch);
    expect(await recordsOf(store)).toEqual([]);
    expect(await store.get(note.link)).toBeUndefined();
  });

  it("takes a via that the bundle carries", async () => {
    const store = newStore();
    const mailbox = object({ name: "a mailbox" });
    const bundle = bundleOf(object({ text: "hello" }), [mailbox.bytes, ...anything.blobs]);
    const record = await (await intakeOf(store)).receive(bundle, mailbox.link);
    expect(record.data.via).toEqual({ $link: mailbox.link });
    expect(await store.get(mailbox.link)).toEqual(mailbox.bytes);
  });

  it("refuses a via that neither the bundle nor the store holds", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const intake = await intakeOf(store);
    await expect(intake.receive(bundleOf(note), object({ name: "a mailbox" }).link)).rejects.toThrow(RefusedBatch);
    expect(await recordsOf(store)).toEqual([]);
    expect(await store.get(note.link)).toBeUndefined();
  });
});

describe("the records of an intake", () => {
  const cameIn: Index<readonly [bundle: Link<never>, at: number]> = indexOver(objectsOf(inbound), ({ data }) => [
    [data.bundle.$link, data.at],
  ]);

  it("give an index when each bundle came in, the earliest first", async () => {
    const store = newStore();
    const intake = await intakeOf(store);
    const bundle = bundleOf(object({ text: "hello" }));
    await intake.receive(bundle);
    await intake.receive(bundle);
    const rows: (readonly [Link<never>, number])[] = [];
    for await (const row of (await scan(store, cameIn)).range([bundle.link])) rows.push(row);
    expect(rows).toEqual([
      [bundle.link, 1000],
      [bundle.link, 1001],
    ]);
  });

  it("are the only Inbound an index reads: one that someone sends stays in the closure of what came in", async () => {
    const store = newStore();
    const note = object({ text: "hello" });
    const sent = encodeObject(inbound, { bundle: { $link: note.link as Link<never> }, at: 0 });
    await (await intakeOf(store)).receive(bundleOf(sent, [note.bytes, ...anything.blobs, ...inbound.blobs]));
    const rows: (readonly [Link<never>, number])[] = [];
    for await (const row of (await scan(store, cameIn)).range([])) rows.push(row);
    expect(rows).toEqual([[sent.link as Link<never>, 1000]]);
  });
});

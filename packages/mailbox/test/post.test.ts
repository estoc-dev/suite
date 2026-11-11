import { readBundle, writeBundle } from "@estoc/bundle";
import { ed25519, loadIdentity, noIdentityVersions, SoftwareSigner } from "@estoc/identity";
import {
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  json,
  type Link,
  objectsOf,
  readObject,
  type Schema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import {
  type InboundData,
  type Index,
  inboundSchema,
  indexOver,
  loadIntake,
  MemoryBackend,
  PrivateStore,
  Store,
  scan,
} from "@estoc/store";
import { hex } from "@scure/base";
import { assert, describe, expect, it } from "vitest";
import {
  loadPost,
  MailboxKey,
  type MailboxKeyData,
  mailboxFrom,
  mailboxKeySchema,
  outboundSchema,
  UndeliveredMessage,
} from "../src/index.ts";
import { MemoryNetwork } from "./memory-network.ts";

const { signatures, publish } = await loadIdentity([ed25519]);
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const note = await encodeSchema(
  { $schema: DRAFT, title: "Note", type: "object", properties: { text: { type: "string" } } },
  defaultValidator,
);
const inbound: Schema<Json, InboundData> = await encodeSchema(inboundSchema, defaultValidator);
const outbound = await encodeSchema(outboundSchema, defaultValidator);
const keys: Schema<Json, MailboxKeyData> = await encodeSchema(mailboxKeySchema, defaultValidator);
const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const hello = encodeObject(note, { text: "hello, Bob" });
const signature = await signatures.actor(alice, await publish(alice, { at: 0 })).sign(hello);
const schemas = [note, signatures.schema].flatMap(({ blobs }) => blobs);
const signatureBlobs = [hello.bytes, ...signature.signedIdentity.blobs, ...schemas];
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));

async function listed(store: { records(): AsyncIterable<Link<never>> }): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.records()) links.push(link);
  return links;
}

// A post on `network` at a store and a private store beside it, new ones
// unless given. Its clock starts at 1000 and moves on a millisecond each
// time it is read.
async function postAt(
  network: MemoryNetwork,
  store = new Store(json, new MemoryBackend()),
  privateStore = new PrivateStore(store, new MemoryBackend()),
) {
  let now = 1000;
  const options = { transports: [network.transport], validator: defaultValidator, clock: () => now++ };
  return { store, privateStore, post: await loadPost(store, privateStore, options) };
}

// `store` keeps a mailbox that was handed over out of band, with a record that it came in.
async function handOver(network: MemoryNetwork, store: Store, mailbox: EncodedObject<Json>) {
  const intake = await loadIntake(store, { validator: defaultValidator });
  await intake.receive(readBundle(writeBundle(mailbox, network.transport.schema.blobs)));
}

// A post whose store holds the mailbox of a new queue sealed to Bob, handed over.
async function prepareSender(network: MemoryNetwork, store?: Store) {
  const at = await postAt(network, store);
  const queue = network.queue();
  const mailbox = queue.mailbox(bob.publicKey);
  await handOver(network, at.store, mailbox);
  return { ...at, queue, mailbox };
}

async function openReceiver(network: MemoryNetwork, store?: Store) {
  const at = await postAt(network, store);
  const queue = network.queue();
  const inbox = await at.post.openInbox(queue.mailbox);
  return { ...at, queue, inbox, pickup: queue.pickup(inbox.mailbox) };
}

async function sendTo(network: MemoryNetwork, store: Store, mailbox: Link<EncodedObject<Json>>, blobs: Uint8Array[]) {
  const bytes = await store.get(mailbox);
  assert.exists(bytes);
  await (await mailboxFrom(bytes, { transports: [network.transport] })).send(signature, blobs);
}

describe("an outbox", () => {
  it("sends the closure of a root the store holds, and records that it went out once the transport takes it", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, post, queue, mailbox } = await prepareSender(network);
    await store.write({ records: [signature], blobs: signatureBlobs });

    const delivery = await (await post.outbox(mailbox.link)).send(signature.link);
    expect(delivery).toEqual({
      direction: "outbound",
      bundle: signature.link,
      mailbox: mailbox.link,
      at: 1000,
      link: delivery.link,
    });
    expect(await listed(store)).toContain(delivery.link);
    expect((await readObject(store, delivery.link, outbound)).data).toEqual({
      bundle: { $link: signature.link },
      mailbox: { $link: mailbox.link },
      at: 1000,
    });

    const bundle = await bob.open(queue.takeOne());
    expect(bundle.link).toBe(signature.link);
    expect(new Set(bundle.blobs())).toEqual(new Set((await store.closure(signature.link)).values()));
  });

  it("sends a bundle that came in at another mailbox as it came, though someone else wrote it", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const atBob = await openReceiver(network);
    await sendTo(network, atBob.store, atBob.inbox.mailbox, signatureBlobs);
    await atBob.inbox.receive(atBob.queue.takeOne());

    const carol = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(3));
    const queue = network.queue();
    const atCarol = queue.mailbox(carol.publicKey);
    await handOver(network, atBob.store, atCarol);
    await (await atBob.post.outbox(atCarol.link)).send(signature.link);
    const bundle = await carol.open(queue.takeOne());
    expect(bundle.link).toBe(signature.link);
    expect((await signatures.read(bundle.link, bundle, noIdentityVersions)).object).toBe(hello.link);
  });

  it("records nothing when the transport cannot hand on what it sends, and rejects as the transport does", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, post } = await prepareSender(network);
    await store.write({ records: [signature], blobs: signatureBlobs });
    const elsewhere = (await MemoryNetwork.create(defaultValidator)).queue().mailbox(bob.publicKey);
    await handOver(network, store, elsewhere);
    const before = await listed(store);

    const sending = (await post.outbox(elsewhere.link)).send(signature.link);
    await expect(sending).rejects.toThrow(UndeliveredMessage);
    await expect(sending).rejects.toMatchObject({ kind: "gone" });
    expect(await listed(store)).toEqual(before);
  });

  it("refuses a root that the store does not hold, and sends nothing", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { post, queue, mailbox } = await prepareSender(network);
    await expect((await post.outbox(mailbox.link)).send(signature.link)).rejects.toThrow(
      `the store does not hold ${signature.link}`,
    );
    expect(queue.take()).toEqual([]);
  });

  it("refuses a root when the store no longer gives a blob of its closure, and sends and records nothing", async () => {
    let lostLink: Link<unknown> | undefined;
    const backend = new (class extends MemoryBackend {
      override get(link: Link<unknown>): Promise<Uint8Array | undefined> {
        return link === lostLink ? Promise.resolve(undefined) : super.get(link);
      }
    })();
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, post, queue, mailbox } = await prepareSender(network, new Store(json, backend));
    await store.write({ records: [signature], blobs: signatureBlobs });
    const outbox = await post.outbox(mailbox.link);
    const before = await listed(store);

    lostLink = hello.link;
    await expect(outbox.send(signature.link)).rejects.toThrow(`the store does not hold ${hello.link}`);
    expect(queue.take()).toEqual([]);
    expect(await listed(store)).toEqual(before);
  });

  it("is not made for a mailbox that the store does not hold", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { post } = await prepareSender(network);
    const unheldMailbox = network.queue().mailbox(bob.publicKey);
    await expect(post.outbox(unheldMailbox.link)).rejects.toThrow(`the store does not hold ${unheldMailbox.link}`);
  });
});

describe("an inbox", () => {
  it("is opened at a mailbox that the store holds, with its key kept in the private store alone", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, privateStore, inbox } = await openReceiver(network);
    expect(await listed(store)).toEqual([inbox.mailbox]);
    expect(await listed(privateStore)).toEqual([inbox.key]);
    expect(await store.get(inbox.key)).toBeUndefined();

    const { data } = await readObject(privateStore, inbox.key, keys);
    expect(data.mailbox.$link).toBe(inbox.mailbox);
    const mailbox = await readObject(store, inbox.mailbox, network.transport.schema);
    const key = await MailboxKey.fromSecretKey(hex.decode(data.secret));
    expect(mailbox.data.key).toBe(hex.encode(key.publicKey));
  });

  it("is made again from its key, found by an index of the keys that the private store keeps", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, privateStore, queue, inbox } = await openReceiver(network);
    const byMailbox: Index<[mailbox: Link<unknown>, key: Link<unknown>]> = indexOver(
      objectsOf(keys),
      ({ link, data }) => [[data.mailbox.$link, link]],
    );
    const rows = [];
    for await (const row of (await scan(privateStore, byMailbox)).range([inbox.mailbox])) rows.push(row);
    expect(rows).toEqual([[inbox.mailbox, inbox.key]]);

    const again = await (await postAt(network, store, privateStore)).post.inbox(inbox.key);
    await sendTo(network, store, again.mailbox, signatureBlobs);
    expect(await again.receive(queue.takeOne())).toMatchObject({ bundle: signature.link, mailbox: inbox.mailbox });
  });

  it("collects what waits at its mailbox, done with each once it is kept with a record that it came in", async () => {
    const network = await MemoryNetwork.create(defaultValidator, { twice: true });
    const { store, queue, inbox, pickup } = await openReceiver(network);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    const deliveries = await inbox.collect(pickup);
    expect(deliveries.map(({ link, ...delivery }) => delivery)).toEqual([
      { direction: "inbound", bundle: signature.link, mailbox: inbox.mailbox, at: 1000 },
      { direction: "inbound", bundle: signature.link, mailbox: inbox.mailbox, at: 1001 },
    ]);
    expect(await listed(store)).toEqual([inbox.mailbox, ...deliveries.map(({ link }) => link)]);
    expect((await signatures.read(signature.link, store, noIdentityVersions)).object).toBe(hello.link);
    expect(queue.take()).toEqual([]);
  });

  it("records what it keeps as an Inbound whose via is its mailbox", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, queue, inbox } = await openReceiver(network);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    const delivery = await inbox.receive(queue.takeOne());
    expect((await readObject(store, delivery.link, inbound)).data).toEqual({
      bundle: { $link: signature.link },
      at: 1000,
      via: { $link: inbox.mailbox },
    });
  });

  it("is done with what it collects and refuses, which leaves no record", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, queue, inbox, pickup } = await openReceiver(network);
    const sealedToBob = queue.mailbox(bob.publicKey);
    await (await mailboxFrom(sealedToBob.bytes, { transports: [network.transport] })).send(signature, signatureBlobs);
    await sendTo(network, store, inbox.mailbox, [...signature.signedIdentity.blobs, ...schemas]);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    const deliveries = await inbox.collect(pickup);
    expect(deliveries.map(({ bundle }) => bundle)).toEqual([signature.link]);
    expect(await listed(store)).toEqual([inbox.mailbox, ...deliveries.map(({ link }) => link)]);
    expect(queue.take()).toEqual([]);
  });

  it("stops collecting when the store fails to write, and leaves what it was keeping to collect again", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    let isDiskFull = false;
    const backend = new (class extends MemoryBackend {
      override put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, records: Iterable<Link<never>>): Promise<void> {
        return isDiskFull ? Promise.reject(new Error("the disk is full")) : super.put(blobs, records);
      }
    })();
    const { store, inbox, pickup } = await openReceiver(network, new Store(json, backend));
    await sendTo(network, store, inbox.mailbox, signatureBlobs);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    isDiskFull = true;
    await expect(inbox.collect(pickup)).rejects.toThrow("the disk is full");
    isDiskFull = false;
    expect(await inbox.collect(pickup)).toHaveLength(2);
  });

  it("collects nothing once its signal has aborted, and leaves what waits", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, inbox, pickup } = await openReceiver(network);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    expect(await inbox.collect(pickup, AbortSignal.abort())).toEqual([]);
    expect(await inbox.collect(pickup)).toHaveLength(1);
  });

  it("refuses a pickup of another mailbox, and is done with nothing", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { inbox } = await openReceiver(network);
    const other = await openReceiver(network);
    await sendTo(network, other.store, other.inbox.mailbox, signatureBlobs);

    await expect(inbox.collect(other.pickup)).rejects.toThrow(
      `a pickup of ${other.inbox.mailbox} is not collected at ${inbox.mailbox}`,
    );
    expect(await other.inbox.collect(other.pickup)).toHaveLength(1);
  });

  it("keeps nothing of a bundle that leaves out a blob in its root's closure", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, queue, inbox } = await openReceiver(network);
    await sendTo(network, store, inbox.mailbox, [...signature.signedIdentity.blobs, ...schemas]);

    await expect(inbox.receive(queue.takeOne())).rejects.toThrow(`links to ${hello.link}`);
    expect(await listed(store)).toEqual([inbox.mailbox]);
    expect(await store.get(signature.link)).toBeUndefined();
  });

  it("keeps nothing of what does not open with its key", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, inbox } = await openReceiver(network);
    const other = await openReceiver(network);
    await sendTo(network, other.store, other.inbox.mailbox, signatureBlobs);

    await expect(inbox.receive(other.queue.takeOne())).rejects.toThrow(/does not open/);
    expect(await listed(store)).toEqual([inbox.mailbox]);
  });

  it("is not opened at a mailbox that names another key than the one given, and writes nothing", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, privateStore, post } = await postAt(network);
    const queue = network.queue();
    await expect(post.openInbox(() => queue.mailbox(bob.publicKey))).rejects.toThrow(/names another key/);
    expect(await listed(store)).toEqual([]);
    expect(await listed(privateStore)).toEqual([]);
  });

  it("is not made from a key whose secret is not of the key its mailbox names", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { privateStore, post, inbox } = await openReceiver(network);
    const wrong = encodeObject(keys, { mailbox: { $link: inbox.mailbox }, secret: hex.encode(new Uint8Array(32)) });
    await privateStore.write({ records: [wrong] });
    await expect(post.inbox(wrong.link)).rejects.toThrow(`${inbox.mailbox} names another key than ${wrong.link} holds`);
  });

  it("is not made from a key that the private store does not keep", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { post, inbox } = await openReceiver(network);
    const unkeptKey = encodeObject(keys, { mailbox: { $link: inbox.mailbox }, secret: hex.encode(new Uint8Array(32)) });
    await expect(post.inbox(unkeptKey.link)).rejects.toThrow(`no blob is given for ${unkeptKey.link}`);
  });
});

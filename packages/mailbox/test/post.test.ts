import { ed25519, loadIdentity, noVersions, SoftwareSigner } from "@estoc/identity";
import {
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  json,
  type Link,
  readObject,
  type Schema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { type Index, MemoryBackend, PrivateStore, Store, scan } from "@estoc/store";
import { hex } from "@scure/base";
import { assert, describe, expect, it } from "vitest";
import {
  loadPost,
  MailboxKey,
  type MailboxKeyData,
  mailboxFrom,
  mailboxKeySchema,
  outboundSchema,
  Undelivered,
} from "../src/index.ts";
import { MemoryNetwork } from "./memory-network.ts";

const { signatures, publish } = await loadIdentity(defaultValidator);
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const note = await encodeSchema(
  { $schema: DRAFT, title: "Note", type: "object", properties: { text: { type: "string" } } },
  defaultValidator,
);
const outbound = await encodeSchema(outboundSchema, defaultValidator);
const keys: Schema<Json, MailboxKeyData> = await encodeSchema(mailboxKeySchema, defaultValidator);
const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const hello = encodeObject(note, { text: "hello, Bob" });
const signature = await signatures.actor(alice, await publish(alice, 0)).sign(hello);
const schemas = [note, signatures.schema].map(({ bytes }) => bytes);
const signed = [hello.bytes, ...signature.signedIdentity.blobs, ...schemas];
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));

async function listed(store: { mine(): AsyncIterable<Link<never>> }): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.mine()) links.push(link);
  return links;
}

// A post on `network` at a store and a private store beside it, new ones
// unless given. Its clock starts at 1000 and moves on a millisecond each
// time it is read.
async function postAt(
  network: MemoryNetwork,
  store = new Store(json, new MemoryBackend()),
  kept = new PrivateStore(store, new MemoryBackend()),
) {
  let now = 1000;
  const options = { transports: [network.transport], validator: defaultValidator, clock: () => now++ };
  return { store, kept, post: await loadPost(store, kept, options) };
}

// A post whose store holds the mailbox of a new queue sealed to Bob, as when
// it was handed over.
async function sendingTo(network: MemoryNetwork) {
  const at = await postAt(network);
  const queue = network.queue();
  const mailbox = queue.mailbox(bob.publicKey);
  await at.store.write({ mine: [mailbox], blobs: [network.transport.schema.bytes] });
  return { ...at, queue, mailbox };
}

async function receivingAt(network: MemoryNetwork, store?: Store) {
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
    const { store, post, queue, mailbox } = await sendingTo(network);
    await store.write({ mine: [signature], blobs: signed });

    const sent = await (await post.outbox(mailbox.link)).send(signature.link);
    expect(sent).toEqual({
      direction: "outbound",
      bundle: signature.link,
      mailbox: mailbox.link,
      at: 1000,
      link: sent.link,
    });
    expect(await listed(store)).toContain(sent.link);
    expect((await readObject(store, sent.link, outbound)).data).toEqual({
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
    const atBob = await receivingAt(network);
    await sendTo(network, atBob.store, atBob.inbox.mailbox, signed);
    await atBob.inbox.receive(atBob.queue.takeOne());

    const carol = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(3));
    const queue = network.queue();
    const atCarol = queue.mailbox(carol.publicKey);
    await atBob.store.write({ mine: [atCarol], blobs: [network.transport.schema.bytes] });
    await (await atBob.post.outbox(atCarol.link)).send(signature.link);
    const bundle = await carol.open(queue.takeOne());
    expect(bundle.link).toBe(signature.link);
    expect((await signatures.read(bundle.link, bundle, noVersions)).object).toBe(hello.link);
  });

  it("records nothing when the transport cannot hand on what it sends, and rejects as the transport does", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, post } = await sendingTo(network);
    await store.write({ mine: [signature], blobs: signed });
    const elsewhere = (await MemoryNetwork.create(defaultValidator)).queue().mailbox(bob.publicKey);
    await store.write({ mine: [elsewhere], blobs: [network.transport.schema.bytes] });
    const before = await listed(store);

    const sending = (await post.outbox(elsewhere.link)).send(signature.link);
    await expect(sending).rejects.toThrow(Undelivered);
    await expect(sending).rejects.toMatchObject({ kind: "gone" });
    expect(await listed(store)).toEqual(before);
  });

  it("refuses a root that the store does not hold, and sends nothing", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { post, queue, mailbox } = await sendingTo(network);
    await expect((await post.outbox(mailbox.link)).send(signature.link)).rejects.toThrow(
      `the store does not hold ${signature.link}`,
    );
    expect(queue.take()).toEqual([]);
  });

  it("is not made for a mailbox that the store does not hold", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { post } = await sendingTo(network);
    const unheld = network.queue().mailbox(bob.publicKey);
    await expect(post.outbox(unheld.link)).rejects.toThrow(`the store does not hold ${unheld.link}`);
  });
});

describe("an inbox", () => {
  it("is opened at a mailbox that the store holds, with its key kept in the private store alone", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, kept, inbox } = await receivingAt(network);
    expect(await listed(store)).toEqual([inbox.mailbox]);
    expect(await listed(kept)).toEqual([inbox.key]);
    expect(await store.get(inbox.key)).toBeUndefined();

    const { data } = await readObject(kept, inbox.key, keys);
    expect(data.mailbox.$link).toBe(inbox.mailbox);
    const mailbox = await readObject(store, inbox.mailbox, network.transport.schema);
    const key = await MailboxKey.fromSecretKey(hex.decode(data.secret));
    expect(mailbox.data.key).toBe(hex.encode(key.publicKey));
  });

  it("is made again from its key, found by an index of the keys that the private store keeps", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, kept, queue, inbox } = await receivingAt(network);
    const byMailbox: Index<Json, [mailbox: Link<unknown>, key: Link<unknown>], MailboxKeyData> = {
      reads: [keys],
      rows: ({ link, data }) => [[data.mailbox.$link, link]],
    };
    const rows = [];
    for await (const row of (await scan(kept, byMailbox)).range([inbox.mailbox])) rows.push(row);
    expect(rows).toEqual([[inbox.mailbox, inbox.key]]);

    const again = await (await postAt(network, store, kept)).post.inbox(inbox.key);
    await sendTo(network, store, again.mailbox, signed);
    expect(await again.receive(queue.takeOne())).toMatchObject({ bundle: signature.link, mailbox: inbox.mailbox });
  });

  it("collects what waits at its mailbox, done with each once it is kept with a record that it came in", async () => {
    const network = await MemoryNetwork.create(defaultValidator, { twice: true });
    const { store, queue, inbox, pickup } = await receivingAt(network);
    await sendTo(network, store, inbox.mailbox, signed);

    const collected = await inbox.collect(pickup);
    expect(collected.map(({ link, ...delivery }) => delivery)).toEqual([
      { direction: "inbound", bundle: signature.link, mailbox: inbox.mailbox, at: 1000 },
      { direction: "inbound", bundle: signature.link, mailbox: inbox.mailbox, at: 1001 },
    ]);
    expect(await listed(store)).toEqual([inbox.mailbox, ...collected.map(({ link }) => link)]);
    expect((await signatures.read(signature.link, store, noVersions)).object).toBe(hello.link);
    expect(queue.take()).toEqual([]);
  });

  it("is done with what it collects and refuses, which leaves no record", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, queue, inbox, pickup } = await receivingAt(network);
    const sealedToBob = queue.mailbox(bob.publicKey);
    await (await mailboxFrom(sealedToBob.bytes, { transports: [network.transport] })).send(signature, signed);
    await sendTo(network, store, inbox.mailbox, [...signature.signedIdentity.blobs, ...schemas]);
    await sendTo(network, store, inbox.mailbox, signed);

    const collected = await inbox.collect(pickup);
    expect(collected.map(({ bundle }) => bundle)).toEqual([signature.link]);
    expect(await listed(store)).toEqual([inbox.mailbox, ...collected.map(({ link }) => link)]);
    expect(queue.take()).toEqual([]);
  });

  it("stops collecting when the store fails to write, and leaves what it was keeping to collect again", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    let full = false;
    const backend = new (class extends MemoryBackend {
      override put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, mine: Iterable<Link<never>>): Promise<void> {
        return full ? Promise.reject(new Error("the disk is full")) : super.put(blobs, mine);
      }
    })();
    const { store, inbox, pickup } = await receivingAt(network, new Store(json, backend));
    await sendTo(network, store, inbox.mailbox, signed);
    await sendTo(network, store, inbox.mailbox, signed);

    full = true;
    await expect(inbox.collect(pickup)).rejects.toThrow("the disk is full");
    full = false;
    expect(await inbox.collect(pickup)).toHaveLength(2);
  });

  it("collects nothing once its signal has aborted, and leaves what waits", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, inbox, pickup } = await receivingAt(network);
    await sendTo(network, store, inbox.mailbox, signed);

    expect(await inbox.collect(pickup, AbortSignal.abort())).toEqual([]);
    expect(await inbox.collect(pickup)).toHaveLength(1);
  });

  it("refuses a pickup of another mailbox, and is done with nothing", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { inbox } = await receivingAt(network);
    const other = await receivingAt(network);
    await sendTo(network, other.store, other.inbox.mailbox, signed);

    await expect(inbox.collect(other.pickup)).rejects.toThrow(
      `a pickup of ${other.inbox.mailbox} is not collected at ${inbox.mailbox}`,
    );
    expect(await other.inbox.collect(other.pickup)).toHaveLength(1);
  });

  it("keeps nothing of a bundle that leaves out a blob its root leads to", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, queue, inbox } = await receivingAt(network);
    await sendTo(network, store, inbox.mailbox, [...signature.signedIdentity.blobs, ...schemas]);

    await expect(inbox.receive(queue.takeOne())).rejects.toThrow(`leads to ${hello.link}`);
    expect(await listed(store)).toEqual([inbox.mailbox]);
    expect(await store.get(signature.link)).toBeUndefined();
  });

  it("keeps nothing of what does not open with its key", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, inbox } = await receivingAt(network);
    const other = await receivingAt(network);
    await sendTo(network, other.store, other.inbox.mailbox, signed);

    await expect(inbox.receive(other.queue.takeOne())).rejects.toThrow(/do not open/);
    expect(await listed(store)).toEqual([inbox.mailbox]);
  });

  it("is not opened at a mailbox that names another key than the one given, and writes nothing", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, kept, post } = await postAt(network);
    const queue = network.queue();
    await expect(post.openInbox(() => queue.mailbox(bob.publicKey))).rejects.toThrow(/names another key/);
    expect(await listed(store)).toEqual([]);
    expect(await listed(kept)).toEqual([]);
  });

  it("is not made from a key whose secret is not of the key its mailbox names", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { kept, post, inbox } = await receivingAt(network);
    const wrong = encodeObject(keys, { mailbox: { $link: inbox.mailbox }, secret: hex.encode(new Uint8Array(32)) });
    await kept.write({ mine: [wrong] });
    await expect(post.inbox(wrong.link)).rejects.toThrow(`${inbox.mailbox} names another key than ${wrong.link} holds`);
  });

  it("is not made from a key that the private store does not keep", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { post, inbox } = await receivingAt(network);
    const unkept = encodeObject(keys, { mailbox: { $link: inbox.mailbox }, secret: hex.encode(new Uint8Array(32)) });
    await expect(post.inbox(unkept.link)).rejects.toThrow(`no blob is given for ${unkept.link}`);
  });
});

import type { Bundle } from "@estoc/bundle";
import { ed25519, identityKit, loadIdentity, SoftwareSigner } from "@estoc/identity";
import { type EncodedObject, encodeObject, type Link, LinkValue, objectsOf, readObject } from "@estoc/object";
import { link, schema, secretSchema, string } from "@estoc/schema";
import { Intake, inboundSchema, indexOver, MemoryBackend, recordSchema, Store, selectedRecords } from "@estoc/store";
import { describe, expect, it } from "vitest";
import {
  type MailboxData,
  MailboxKey,
  mailboxAt,
  mailboxKeySchema,
  mailboxSchema,
  outboundSchema,
  Post,
  UndeliveredMessage,
} from "../src/index.ts";
import { MemoryNetwork } from "./memory-network.ts";
import { recordedIn } from "./recorded.ts";

const { signatures, publish } = identityKit;
// Of a kit that has verified nothing, as whoever a bundle comes to has: who signed is read from the
// blobs that came.
const receiverSignatures = () => loadIdentity([ed25519]).signatures;
const identityVersionInHand = async <T>(inHand: T) => inHand;
const note = schema("Note", { text: string() });
const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const hello = encodeObject(note, { text: "hello, Bob" });
const signature = await signatures.actor(alice, await publish(alice, { at: 0 }), identityVersionInHand).sign(hello);
const signatureBlobs = [...signature.blobs, hello.bytes, ...note.blobs];
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));

// A post on `network` at a store, over a new backend unless given. Its clock starts at 1000 and
// moves on a millisecond each time it is read.
async function postAt(network: MemoryNetwork, store = new Store(new MemoryBackend())) {
  let now = 1000;
  return { store, post: new Post(store, { transports: [network.transport], clock: () => now++ }) };
}

// The store keeps a mailbox that was handed over out of band, with a record that it came in.
async function handOver({ store }: { readonly store: Store }, mailbox: Bundle) {
  await new Intake(store).receive(mailbox);
}

// A post whose store holds the mailbox of a new queue for Bob's key, handed over.
async function prepareSender(network: MemoryNetwork, backend = new MemoryBackend()) {
  const at = await postAt(network, new Store(backend));
  const queue = network.queue();
  const mailbox = queue.mailbox(bob.publicKey);
  await handOver(at, mailbox);
  return { ...at, queue, mailbox };
}

// A post with an inbox at a new queue. The record of its mailbox is at 1000, so the clock reads 1001 next.
async function openReceiver(network: MemoryNetwork, backend = new MemoryBackend()) {
  const at = await postAt(network, new Store(backend));
  const queue = network.queue();
  const inbox = await at.post.openInbox(() => queue.transport);
  return { ...at, queue, inbox, pickup: queue.pickup(inbox.mailbox) };
}

async function sendTo(
  network: MemoryNetwork,
  store: Store,
  mailbox: Link<EncodedObject<MailboxData>>,
  blobs: Uint8Array[],
) {
  await (await mailboxAt(mailbox, store, { transports: [network.transport] })).send(signature.link, blobs);
}

describe("an outbox", () => {
  it("sends the closure of a root the store holds, and records that it went out once the transport takes it", async () => {
    const network = new MemoryNetwork();
    const { store, post, queue, mailbox } = await prepareSender(network);
    await store.write({ roots: [signature.link], blobs: signatureBlobs });

    const outbox = await post.outbox(mailbox.link);
    expect(outbox.mailbox).toBe(mailbox.link);
    const delivery = await outbox.send(signature.link);
    expect(delivery).toEqual({
      direction: "outbound",
      bundle: signature.link,
      mailbox: mailbox.link,
      at: 1000,
      link: delivery.link,
    });
    expect(await recordedIn(store)).toContain(delivery.link);
    expect((await readObject(store, delivery.link, outboundSchema)).data).toEqual({
      bundle: new LinkValue(signature.link),
      mailbox: new LinkValue(mailbox.link),
      at: 1000,
    });

    const bundle = await bob.open(queue.takeOne());
    expect(bundle.link).toBe(signature.link);
    expect(new Set(bundle.blobs())).toEqual(new Set((await store.closure(signature.link)).values()));
  });

  it("sends a bundle that came in at another mailbox as it came, though someone else wrote it", async () => {
    const network = new MemoryNetwork();
    const atBob = await openReceiver(network);
    await sendTo(network, atBob.store, atBob.inbox.mailbox, signatureBlobs);
    await atBob.inbox.receive(atBob.queue.takeOne());

    const carol = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(3));
    const queue = network.queue();
    const atCarol = queue.mailbox(carol.publicKey);
    await handOver(atBob, atCarol);
    await (await atBob.post.outbox(atCarol.link)).send(signature.link);
    const bundle = await carol.open(queue.takeOne());
    expect(bundle.link).toBe(signature.link);
    expect((await receiverSignatures().read(bundle.link, bundle)).object).toBe(hello.link);
  });

  it("records nothing when the transport cannot hand on what it sends, and rejects as the transport does", async () => {
    const network = new MemoryNetwork();
    const { store, post, queue, mailbox } = await prepareSender(network);
    await store.write({ roots: [signature.link], blobs: signatureBlobs });
    queue.turnBack("gone");
    const before = await recordedIn(store);

    const sending = (await post.outbox(mailbox.link)).send(signature.link);
    await expect(sending).rejects.toThrow(UndeliveredMessage);
    await expect(sending).rejects.toMatchObject({ kind: "gone" });
    expect(await recordedIn(store)).toEqual(before);
  });

  it("is not made for a mailbox that the transport has no route to, and rejects as the transport does", async () => {
    const network = new MemoryNetwork();
    const sender = await prepareSender(network);
    const elsewhere = new MemoryNetwork().queue().mailbox(bob.publicKey);
    await handOver(sender, elsewhere);

    const making = sender.post.outbox(elsewhere.link);
    await expect(making).rejects.toThrow(UndeliveredMessage);
    await expect(making).rejects.toMatchObject({ kind: "gone" });
  });

  it("refuses a root that the store does not hold, and sends nothing", async () => {
    const network = new MemoryNetwork();
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
    const network = new MemoryNetwork();
    const { store, post, queue, mailbox } = await prepareSender(network, backend);
    await store.write({ roots: [signature.link], blobs: signatureBlobs });
    const outbox = await post.outbox(mailbox.link);
    const before = await recordedIn(store);

    lostLink = hello.link;
    await expect(outbox.send(signature.link)).rejects.toThrow(`the store does not hold ${hello.link}`);
    expect(queue.take()).toEqual([]);
    expect(await recordedIn(store)).toEqual(before);
  });

  it("refuses a root whose closure holds a Secret, and sends and records nothing", async () => {
    const network = new MemoryNetwork();
    const { store, post, queue, mailbox } = await prepareSender(network);
    const keySchema = schema("Key", { secret: link() });
    const secret = encodeObject(secretSchema, { bytes: new Uint8Array(32) });
    const key = encodeObject(keySchema, { secret: new LinkValue(secret.link) });
    await store.write({
      roots: [key.link],
      blobs: [key.bytes, secret.bytes, ...keySchema.blobs, ...secretSchema.blobs],
    });
    const outbox = await post.outbox(mailbox.link);
    const before = await recordedIn(store);

    await expect(outbox.send(key.link)).rejects.toThrow(`${secret.link} is a Secret, which is not sent`);
    expect(queue.take()).toEqual([]);
    expect(await recordedIn(store)).toEqual(before);
  });

  it("refuses a root that is a Record, and sends and records nothing", async () => {
    const network = new MemoryNetwork();
    const { store, post, queue, mailbox } = await prepareSender(network);
    await store.write({ roots: [signature.link], blobs: signatureBlobs });
    const outbox = await post.outbox(mailbox.link);
    const { link: outbound } = await outbox.send(signature.link);
    queue.take();
    const record = encodeObject(recordSchema, { object: new LinkValue(outbound) });
    const before = await recordedIn(store);

    await expect(outbox.send(record.link)).rejects.toThrow(`${record.link} is a Record, which is not sent`);
    expect(queue.take()).toEqual([]);
    expect(await recordedIn(store)).toEqual(before);
  });

  it("is not made for a mailbox that the store does not hold", async () => {
    const network = new MemoryNetwork();
    const { post } = await prepareSender(network);
    const unheldMailbox = network.queue().mailbox(bob.publicKey);
    await expect(post.outbox(unheldMailbox.link)).rejects.toThrow(`no blob is given for ${unheldMailbox.link}`);
  });
});

describe("an inbox", () => {
  it("is opened at a mailbox of its key and the transport object given, which the store holds and records, with a record of its Mailbox Key and the Secret that links to", async () => {
    const network = new MemoryNetwork();
    const { store, queue, inbox } = await openReceiver(network);
    expect(await recordedIn(store)).toEqual([inbox.key, inbox.mailbox]);

    const { data } = await readObject(store, inbox.key, mailboxKeySchema);
    expect(data.mailbox.link).toBe(inbox.mailbox);
    const mailbox = await readObject(store, inbox.mailbox, mailboxSchema);
    const key = await MailboxKey.fromSecretKey((await readObject(store, data.secret.link, secretSchema)).data.bytes);
    expect(mailbox.data).toEqual({ key: key.publicKey, transport: new LinkValue(queue.transport.link) });
    expect(await store.get(queue.transport.link)).toEqual(queue.transport.bytes);
  });

  it("leaves a record of its Mailbox Key and none of its mailbox when the store fails to record the mailbox", async () => {
    const network = new MemoryNetwork();
    let writesLeft = 1;
    const backend = new (class extends MemoryBackend {
      override put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>): Promise<void> {
        return writesLeft-- > 0 ? super.put(blobs) : Promise.reject(new Error("the disk is full"));
      }
    })();
    const { store, post } = await postAt(network, new Store(backend));

    await expect(post.openInbox(() => network.queue().transport)).rejects.toThrow("the disk is full");
    const [key, ...others] = await recordedIn(store);
    expect(others).toEqual([]);
    await readObject(store, key as Link<never>, mailboxKeySchema);
  });

  it("is made again from its key, found by an index of the Mailbox Keys that are recorded", async () => {
    const network = new MemoryNetwork();
    const receiver = await openReceiver(network);
    const { store, queue, inbox } = receiver;
    const keyOfMailbox = schema("Key of mailbox", { mailbox: link(), key: link() });
    const byMailbox = indexOver(selectedRecords(objectsOf(mailboxKeySchema)), keyOfMailbox, ({ link, data }) => [
      { mailbox: data.mailbox, key: new LinkValue(link) },
    ]).orderedBy("mailbox");
    const keys = [];
    for await (const { data } of (await store.scan(byMailbox)).range([new LinkValue(inbox.mailbox)]))
      keys.push(data.key.link);
    expect(keys).toEqual([inbox.key]);

    const again = await (await postAt(network, store)).post.inbox(inbox.key);
    await sendTo(network, store, again.mailbox, signatureBlobs);
    expect(await again.receive(queue.takeOne())).toMatchObject({ bundle: signature.link, mailbox: inbox.mailbox });
  });

  it("collects what waits at its mailbox, done with each once it is kept with a record that it came in", async () => {
    const network = new MemoryNetwork({ twice: true });
    const { store, queue, inbox, pickup } = await openReceiver(network);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    const deliveries = await inbox.collect(pickup);
    expect(deliveries.map(({ link, ...delivery }) => delivery)).toEqual([
      { direction: "inbound", bundle: signature.link, mailbox: inbox.mailbox, at: 1001 },
      { direction: "inbound", bundle: signature.link, mailbox: inbox.mailbox, at: 1002 },
    ]);
    expect(await recordedIn(store)).toEqual([inbox.key, inbox.mailbox, ...deliveries.map(({ link }) => link)]);
    expect((await receiverSignatures().read(signature.link, store)).object).toBe(hello.link);
    expect(queue.take()).toEqual([]);
  });

  it("records what it keeps with an Inbound whose via is its mailbox", async () => {
    const network = new MemoryNetwork();
    const { store, queue, inbox } = await openReceiver(network);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    const delivery = await inbox.receive(queue.takeOne());
    expect((await readObject(store, delivery.link, inboundSchema)).data).toEqual({
      bundle: new LinkValue(signature.link),
      at: 1001,
      via: new LinkValue(inbox.mailbox),
    });
  });

  it("is done with what it collects and refuses, which leaves no record", async () => {
    const network = new MemoryNetwork();
    const { store, queue, inbox, pickup } = await openReceiver(network);
    const sealedToBob = queue.mailbox(bob.publicKey);
    await (await mailboxAt(sealedToBob.link, sealedToBob, { transports: [network.transport] })).send(
      signature.link,
      signatureBlobs,
    );
    await sendTo(network, store, inbox.mailbox, [...signature.blobs, ...note.blobs]);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    const deliveries = await inbox.collect(pickup);
    expect(deliveries.map(({ bundle }) => bundle)).toEqual([signature.link]);
    expect(await recordedIn(store)).toEqual([inbox.key, inbox.mailbox, ...deliveries.map(({ link }) => link)]);
    expect(queue.take()).toEqual([]);
  });

  it("stops collecting when the store fails to write, and leaves what it was keeping to collect again", async () => {
    const network = new MemoryNetwork();
    let isDiskFull = false;
    const backend = new (class extends MemoryBackend {
      override put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>): Promise<void> {
        return isDiskFull ? Promise.reject(new Error("the disk is full")) : super.put(blobs);
      }
    })();
    const { store, inbox, pickup } = await openReceiver(network, backend);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    isDiskFull = true;
    await expect(inbox.collect(pickup)).rejects.toThrow("the disk is full");
    isDiskFull = false;
    expect(await inbox.collect(pickup)).toHaveLength(2);
  });

  it("stops collecting when the store reads another blob under a link that a bundle leaves to it, and leaves the bundle to collect again", async () => {
    const network = new MemoryNetwork();
    let misplacedLink: Link<unknown> | undefined;
    const backend = new (class extends MemoryBackend {
      override get(link: Link<unknown>): Promise<Uint8Array | undefined> {
        return super.get(link === hello.link && misplacedLink !== undefined ? misplacedLink : link);
      }
    })();
    const { store, inbox, pickup } = await openReceiver(network, backend);
    await store.write({ roots: [hello.link], blobs: [hello.bytes, ...note.blobs] });
    await sendTo(network, store, inbox.mailbox, [...signature.blobs, ...note.blobs]);

    misplacedLink = encodeObject(recordSchema, { object: new LinkValue(inbox.key) }).link;
    await expect(inbox.collect(pickup)).rejects.toThrow(`another blob under ${hello.link}`);
    misplacedLink = undefined;
    expect(await inbox.collect(pickup)).toHaveLength(1);
  });

  it("collects nothing once its signal has aborted, and leaves what waits", async () => {
    const network = new MemoryNetwork();
    const { store, inbox, pickup } = await openReceiver(network);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    expect(await inbox.collect(pickup, AbortSignal.abort())).toEqual([]);
    expect(await inbox.collect(pickup)).toHaveLength(1);
  });

  it("refuses a pickup of another mailbox at its transport object, and is done with nothing", async () => {
    const network = new MemoryNetwork();
    const { post, store, queue, inbox, pickup } = await openReceiver(network);
    const other = await post.openInbox(() => queue.transport);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    await expect(other.collect(pickup)).rejects.toThrow(
      `a pickup of ${inbox.mailbox} is not collected at ${other.mailbox}`,
    );
    expect(await inbox.collect(pickup)).toHaveLength(1);
  });

  it("keeps nothing of a bundle that leaves out a blob in its root's closure", async () => {
    const network = new MemoryNetwork();
    const { store, queue, inbox } = await openReceiver(network);
    await sendTo(network, store, inbox.mailbox, [...signature.blobs, ...note.blobs]);

    await expect(inbox.receive(queue.takeOne())).rejects.toThrow(`links to ${hello.link}`);
    expect(await recordedIn(store)).toEqual([inbox.key, inbox.mailbox]);
    expect(await store.get(signature.link)).toBeUndefined();
  });

  it("keeps nothing of what does not open with its key", async () => {
    const network = new MemoryNetwork();
    const { store, inbox } = await openReceiver(network);
    const other = await openReceiver(network);
    await sendTo(network, other.store, other.inbox.mailbox, signatureBlobs);

    await expect(inbox.receive(other.queue.takeOne())).rejects.toThrow(/does not open/);
    expect(await recordedIn(store)).toEqual([inbox.key, inbox.mailbox]);
  });

  it("is not opened at a transport object that no transport given takes, and writes nothing", async () => {
    const network = new MemoryNetwork();
    const { store, post } = await postAt(network);
    const placeSchema = schema("Other transport", { place: string() });
    const transport = encodeObject(placeSchema, { place: "elsewhere" });
    await expect(post.openInbox(() => transport)).rejects.toThrow(`no transport takes ${placeSchema.link}`);
    expect(await store.get(transport.link)).toBeUndefined();
    expect(await recordedIn(store)).toEqual([]);
  });

  it("is not made from a key whose secret is not of the key its mailbox names", async () => {
    const network = new MemoryNetwork();
    const { store, post, inbox } = await openReceiver(network);
    const secret = encodeObject(secretSchema, { bytes: new Uint8Array(32) });
    const wrong = encodeObject(mailboxKeySchema, {
      mailbox: new LinkValue(inbox.mailbox),
      secret: new LinkValue(secret.link),
    });
    await store.record({ statements: [wrong.link], blobs: [wrong.bytes, secret.bytes] });
    await expect(post.inbox(wrong.link)).rejects.toThrow(`${inbox.mailbox} names another key than ${wrong.link} holds`);
  });

  it("is not made from a Mailbox Key that only came to the store, with its Secret", async () => {
    const network = new MemoryNetwork();
    const { store, post, queue } = await openReceiver(network);
    const secret = encodeObject(secretSchema, { bytes: new Uint8Array(32).fill(2) });
    const mailbox = queue.mailbox(bob.publicKey);
    const sentKey = encodeObject(mailboxKeySchema, {
      mailbox: new LinkValue(mailbox.link),
      secret: new LinkValue(secret.link),
    });
    await handOver({ store }, mailbox);
    await store.write({ roots: [sentKey.link], blobs: [sentKey.bytes, secret.bytes, ...mailboxKeySchema.blobs] });
    await expect(post.inbox(sentKey.link)).rejects.toThrow(
      `${sentKey.link} is not a Mailbox Key among the records of the store`,
    );
  });
});

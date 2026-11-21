import type { Bundle } from "@estoc/bundle";
import { ed25519, loadIdentity, SoftwareSigner } from "@estoc/identity";
import { type EncodedObject, encodeObject, type Link, LinkValue, objectsOf, readObject } from "@estoc/object";
import { link, schema, secretSchema, string } from "@estoc/schema";
import {
  Intake,
  inboundSchema,
  indexOver,
  Marks,
  MemoryBackend,
  Secrets,
  Store,
  scan,
  selectedMarks,
} from "@estoc/store";
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
import { listedIn } from "./listed.ts";
import { MemoryNetwork } from "./memory-network.ts";

const { signatures, publish } = loadIdentity([ed25519]);
const identityVersionInHand = async <T>(inHand: T) => inHand;
const note = schema("Note", { text: string() });
const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const hello = encodeObject(note, { text: "hello, Bob" });
const signature = await signatures.actor(alice, await publish(alice, { at: 0 }), identityVersionInHand).sign(hello);
const signatureBlobs = [...signature.blobs, hello.bytes, ...note.blobs];
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));

interface Stores {
  readonly store: Store;
  readonly marks: Marks;
  readonly secrets: Secrets;
}

function storesOver(backend = new MemoryBackend()): Stores {
  return { store: new Store(backend), marks: new Marks(backend), secrets: new Secrets(backend) };
}

// A post on `network` at a store, with what writes its marks and Secrets, over a new backend
// unless given. Its clock starts at 1000 and moves on a millisecond each time it is read.
async function postAt(network: MemoryNetwork, stores = storesOver()) {
  let now = 1000;
  const options = { transports: [network.transport], clock: () => now++ };
  return { ...stores, post: new Post(stores.store, stores.marks, stores.secrets, options) };
}

// The store keeps a mailbox that was handed over out of band, with a mark that it came in.
async function handOver({ store, marks }: Stores, mailbox: Bundle) {
  await new Intake(store, marks).receive(mailbox);
}

// A post whose store holds the mailbox of a new queue for Bob's key, handed over.
async function prepareSender(network: MemoryNetwork, backend?: MemoryBackend) {
  const at = await postAt(network, storesOver(backend));
  const queue = network.queue();
  const mailbox = queue.mailbox(bob.publicKey);
  await handOver(at, mailbox);
  return { ...at, queue, mailbox };
}

// A post with an inbox at a new queue. The record of its mailbox is at 1000, so the clock reads 1001 next.
async function openReceiver(network: MemoryNetwork, backend?: MemoryBackend) {
  const at = await postAt(network, storesOver(backend));
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
  it("sends the closure of a root the store holds, and marks that it went out once the transport takes it", async () => {
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
    expect(await listedIn(store)).toContain(delivery.link);
    await expect(store.closure(delivery.link)).rejects.toThrow("a mark, which stays in the store");
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
    expect((await signatures.read(bundle.link, bundle)).object).toBe(hello.link);
  });

  it("marks nothing when the transport cannot hand on what it sends, and rejects as the transport does", async () => {
    const network = new MemoryNetwork();
    const { store, post, queue, mailbox } = await prepareSender(network);
    await store.write({ roots: [signature.link], blobs: signatureBlobs });
    queue.turnBack("gone");
    const before = await listedIn(store);

    const sending = (await post.outbox(mailbox.link)).send(signature.link);
    await expect(sending).rejects.toThrow(UndeliveredMessage);
    await expect(sending).rejects.toMatchObject({ kind: "gone" });
    expect(await listedIn(store)).toEqual(before);
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

  it("refuses a root when the store no longer gives a blob of its closure, and sends and marks nothing", async () => {
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
    const before = await listedIn(store);

    lostLink = hello.link;
    await expect(outbox.send(signature.link)).rejects.toThrow(`the store does not hold ${hello.link}`);
    expect(queue.take()).toEqual([]);
    expect(await listedIn(store)).toEqual(before);
  });

  it("is not made for a mailbox that the store does not hold", async () => {
    const network = new MemoryNetwork();
    const { post } = await prepareSender(network);
    const unheldMailbox = network.queue().mailbox(bob.publicKey);
    await expect(post.outbox(unheldMailbox.link)).rejects.toThrow(`no blob is given for ${unheldMailbox.link}`);
  });
});

describe("an inbox", () => {
  it("is opened at a mailbox of its key and the transport object given, which the store holds and records, with a mark of its Mailbox Key, whose Secret the store does not read", async () => {
    const network = new MemoryNetwork();
    const { store, secrets, queue, inbox } = await openReceiver(network);
    expect(await listedIn(store)).toEqual([inbox.mailbox, inbox.key]);

    const { data } = await readObject(store, inbox.key, mailboxKeySchema);
    expect(data.mailbox.link).toBe(inbox.mailbox);
    await expect(store.get(data.secret.link)).rejects.toThrow("is a Secret");
    const mailbox = await readObject(store, inbox.mailbox, mailboxSchema);
    const key = await MailboxKey.fromSecretKey((await readObject(secrets, data.secret.link, secretSchema)).data.bytes);
    expect(mailbox.data).toEqual({ key: key.publicKey, transport: new LinkValue(queue.transport.link) });
    expect(await store.get(queue.transport.link)).toEqual(queue.transport.bytes);
  });

  it("is made again from its key, found by an index of the Mailbox Keys that are marked", async () => {
    const network = new MemoryNetwork();
    const receiver = await openReceiver(network);
    const { store, queue, inbox } = receiver;
    const keyOfMailbox = schema("Key of mailbox", { mailbox: link(), key: link() });
    const byMailbox = indexOver(selectedMarks(objectsOf(mailboxKeySchema)), keyOfMailbox, ({ link, data }) => [
      { mailbox: data.mailbox, key: new LinkValue(link) },
    ]).orderedBy("mailbox");
    const keys = [];
    for await (const { data } of (await scan(store, byMailbox)).range([new LinkValue(inbox.mailbox)]))
      keys.push(data.key.link);
    expect(keys).toEqual([inbox.key]);

    const again = await (await postAt(network, receiver)).post.inbox(inbox.key);
    await sendTo(network, store, again.mailbox, signatureBlobs);
    expect(await again.receive(queue.takeOne())).toMatchObject({ bundle: signature.link, mailbox: inbox.mailbox });
  });

  it("collects what waits at its mailbox, done with each once it is kept with a mark that it came in", async () => {
    const network = new MemoryNetwork({ twice: true });
    const { store, queue, inbox, pickup } = await openReceiver(network);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    const deliveries = await inbox.collect(pickup);
    expect(deliveries.map(({ link, ...delivery }) => delivery)).toEqual([
      { direction: "inbound", bundle: signature.link, mailbox: inbox.mailbox, at: 1001 },
      { direction: "inbound", bundle: signature.link, mailbox: inbox.mailbox, at: 1002 },
    ]);
    expect(await listedIn(store)).toEqual([inbox.mailbox, inbox.key, ...deliveries.map(({ link }) => link)]);
    expect((await signatures.read(signature.link, store)).object).toBe(hello.link);
    expect(queue.take()).toEqual([]);
  });

  it("marks what it keeps with an Inbound whose via is its mailbox", async () => {
    const network = new MemoryNetwork();
    const { store, queue, inbox } = await openReceiver(network);
    await sendTo(network, store, inbox.mailbox, signatureBlobs);

    const delivery = await inbox.receive(queue.takeOne());
    await expect(store.closure(delivery.link)).rejects.toThrow("a mark, which stays in the store");
    expect((await readObject(store, delivery.link, inboundSchema)).data).toEqual({
      bundle: new LinkValue(signature.link),
      at: 1001,
      via: new LinkValue(inbox.mailbox),
    });
  });

  it("is done with what it collects and refuses, which leaves no mark", async () => {
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
    expect(await listedIn(store)).toEqual([inbox.mailbox, inbox.key, ...deliveries.map(({ link }) => link)]);
    expect(queue.take()).toEqual([]);
  });

  it("stops collecting when the store fails to write, and leaves what it was keeping to collect again", async () => {
    const network = new MemoryNetwork();
    let isDiskFull = false;
    const backend = new (class extends MemoryBackend {
      override put(blobs: ReadonlyMap<Link<unknown>, Uint8Array>, listedLinks: Iterable<Link<never>>): Promise<void> {
        return isDiskFull ? Promise.reject(new Error("the disk is full")) : super.put(blobs, listedLinks);
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
    expect(await listedIn(store)).toEqual([inbox.mailbox, inbox.key]);
    expect(await store.get(signature.link)).toBeUndefined();
  });

  it("keeps nothing of what does not open with its key", async () => {
    const network = new MemoryNetwork();
    const { store, inbox } = await openReceiver(network);
    const other = await openReceiver(network);
    await sendTo(network, other.store, other.inbox.mailbox, signatureBlobs);

    await expect(inbox.receive(other.queue.takeOne())).rejects.toThrow(/does not open/);
    expect(await listedIn(store)).toEqual([inbox.mailbox, inbox.key]);
  });

  it("is not opened at a transport object that no transport given takes, and writes nothing", async () => {
    const network = new MemoryNetwork();
    const { store, post } = await postAt(network);
    const placeSchema = schema("Other transport", { place: string() });
    const transport = encodeObject(placeSchema, { place: "elsewhere" });
    await expect(post.openInbox(() => transport)).rejects.toThrow(`no transport takes ${placeSchema.link}`);
    expect(await store.get(transport.link)).toBeUndefined();
    expect(await listedIn(store)).toEqual([]);
  });

  it("is not made from a key whose secret is not of the key its mailbox names", async () => {
    const network = new MemoryNetwork();
    const { marks, secrets, post, inbox } = await openReceiver(network);
    const secret = encodeObject(secretSchema, { bytes: new Uint8Array(32) });
    await secrets.write({ roots: [secret.link], blobs: [secret.bytes] });
    const wrong = encodeObject(mailboxKeySchema, {
      mailbox: new LinkValue(inbox.mailbox),
      secret: new LinkValue(secret.link),
    });
    await marks.write({ marks: [wrong.link], blobs: [wrong.bytes] });
    await expect(post.inbox(wrong.link)).rejects.toThrow(`${inbox.mailbox} names another key than ${wrong.link} holds`);
  });

  it("is not made from a key that the store does not hold", async () => {
    const network = new MemoryNetwork();
    const { post, inbox } = await openReceiver(network);
    const unkeptKey = encodeObject(mailboxKeySchema, {
      mailbox: new LinkValue(inbox.mailbox),
      secret: new LinkValue(encodeObject(secretSchema, { bytes: new Uint8Array(32) }).link),
    });
    await expect(post.inbox(unkeptKey.link)).rejects.toThrow(`no blob is given for ${unkeptKey.link}`);
  });
});

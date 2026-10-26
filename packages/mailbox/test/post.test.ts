import { SoftwareSigner } from "@estoc/identity";
import { decodeObject, encodeObject, encodeSchema, identitySchema, json, type Link, loadSignatures, signatureSchema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { MemoryBackend, Store } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { loadPost, MailboxKey, mailboxFrom, outboundSchema } from "../src/index.ts";
import { MemoryNetwork } from "./memory-network.ts";

const signatures = await loadSignatures(defaultValidator);
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const note = await encodeSchema(
  { $schema: DRAFT, title: "Note", type: "object", properties: { text: { type: "string" } } },
  defaultValidator,
);
const schemas = [
  note,
  ...(await Promise.all([identitySchema, signatureSchema].map((schema) => encodeSchema(schema, defaultValidator)))),
].map(({ bytes }) => bytes);
const outbound = await encodeSchema(outboundSchema, defaultValidator);
const alice = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const hello = encodeObject(note, { text: "hello, Bob" });
const signature = await signatures.sign(hello, alice);
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));

async function listed(store: Store): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.mine()) links.push(link);
  return links;
}

// A store and a post at it on `network`, holding the mailbox of a new queue
// sealed to `key`, as when it was handed over or made here. Its clock starts
// at 1000 and moves on a millisecond each time it is read.
async function postWith(network: MemoryNetwork, key: MailboxKey = bob) {
  const store = new Store(json, new MemoryBackend());
  let now = 1000;
  const post = await loadPost(store, { transports: [network.transport], validator: defaultValidator, clock: () => now++ });
  const queue = network.queue();
  const mailbox = queue.mailbox(key.publicKey);
  await store.write({ mine: [mailbox], blobs: [network.transport.schema.bytes] });
  return { store, post, queue, mailbox };
}

describe("an outbox", () => {
  it("sends the closure of a root the store holds, and records that it went out once the transport takes it", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, post, queue, mailbox } = await postWith(network);
    await store.write({ mine: [signature], blobs: [hello.bytes, signature.identity.bytes, ...schemas] });

    const sent = await (await post.outbox(mailbox.link)).send(signature.link);
    expect(sent).toEqual({ direction: "outbound", bundle: signature.link, mailbox: mailbox.link, at: 1000, link: sent.link });
    expect(await listed(store)).toContain(sent.link);
    expect(decodeObject((await store.get(sent.link))!, outbound).data).toEqual({
      bundle: { $link: signature.link },
      mailbox: { $link: mailbox.link },
      at: 1000,
    });

    const [sealed] = queue.take();
    const bundle = await bob.open(sealed!);
    expect(bundle.link).toBe(signature.link);
    expect(new Set(bundle.blobs())).toEqual(new Set((await store.closure(signature.link)).values()));
  });

  it("sends a bundle that came in at another mailbox as it came, though someone else wrote it", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const atBob = await postWith(network);
    await (await mailboxFrom(atBob.mailbox.bytes, { transports: [network.transport] })).send(signature, [
      hello.bytes,
      signature.identity.bytes,
      ...schemas,
    ]);
    await (await atBob.post.inbox(atBob.mailbox.link, bob)).receive(atBob.queue.take()[0]!);

    const carol = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(3));
    const queue = network.queue();
    const atCarol = queue.mailbox(carol.publicKey);
    await atBob.store.write({ mine: [atCarol], blobs: [network.transport.schema.bytes] });
    await (await atBob.post.outbox(atCarol.link)).send(signature.link);
    const bundle = await carol.open(queue.take()[0]!);
    expect(bundle.link).toBe(signature.link);
    expect((await signatures.read(bundle.link, bundle)).object).toBe(hello.link);
  });

  it("records nothing when the transport refuses what it sends", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, post } = await postWith(network);
    await store.write({ mine: [signature], blobs: [hello.bytes, signature.identity.bytes, ...schemas] });
    const elsewhere = (await MemoryNetwork.create(defaultValidator)).queue().mailbox(bob.publicKey);
    await store.write({ mine: [elsewhere], blobs: [network.transport.schema.bytes] });
    const before = await listed(store);

    await expect((await post.outbox(elsewhere.link)).send(signature.link)).rejects.toThrow(/no queue is named/);
    expect(await listed(store)).toEqual(before);
  });

  it("refuses a root that the store does not hold, and sends nothing", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { post, queue, mailbox } = await postWith(network);
    await expect((await post.outbox(mailbox.link)).send(signature.link)).rejects.toThrow(`the store does not hold ${signature.link}`);
    expect(queue.take()).toEqual([]);
  });

  it("is not made for a mailbox that the store does not hold", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { post } = await postWith(network);
    const unheld = network.queue().mailbox(bob.publicKey);
    await expect(post.outbox(unheld.link)).rejects.toThrow(`the store does not hold ${unheld.link}`);
  });
});

describe("an inbox", () => {
  const sendTo = async (network: MemoryNetwork, mailbox: Uint8Array, blobs: Uint8Array[]) =>
    (await mailboxFrom(mailbox, { transports: [network.transport] })).send(signature, blobs);

  it("keeps what arrives with a record that it came in, once for each time it came", async () => {
    const network = await MemoryNetwork.create(defaultValidator, { twice: true });
    const { store, post, queue, mailbox } = await postWith(network);
    await sendTo(network, mailbox.bytes, [hello.bytes, signature.identity.bytes, ...schemas]);
    const inbox = await post.inbox(mailbox.link, bob);

    const received = [];
    for (const sealed of queue.take()) received.push(await inbox.receive(sealed));
    expect(received.map(({ link, ...delivery }) => delivery)).toEqual([
      { direction: "inbound", bundle: signature.link, mailbox: mailbox.link, at: 1000 },
      { direction: "inbound", bundle: signature.link, mailbox: mailbox.link, at: 1001 },
    ]);
    expect(await listed(store)).toEqual([mailbox.link, ...received.map(({ link }) => link)]);
    expect((await signatures.read(signature.link, store)).object).toBe(hello.link);
  });

  it("keeps nothing of a bundle that leaves out a blob its root leads to", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, post, queue, mailbox } = await postWith(network);
    await sendTo(network, mailbox.bytes, [signature.identity.bytes, ...schemas]);
    const inbox = await post.inbox(mailbox.link, bob);

    await expect(inbox.receive(queue.take()[0]!)).rejects.toThrow(`leads to ${hello.link}`);
    expect(await listed(store)).toEqual([mailbox.link]);
    expect(await store.get(signature.link)).toBeUndefined();
  });

  it("keeps nothing of what does not open with its key", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { store, post, mailbox } = await postWith(network);
    const other = await postWith(network, await MailboxKey.fromSecretKey(new Uint8Array(32).fill(3)));
    await sendTo(network, other.mailbox.bytes, [hello.bytes, signature.identity.bytes, ...schemas]);
    const inbox = await post.inbox(mailbox.link, bob);

    await expect(inbox.receive(other.queue.take()[0]!)).rejects.toThrow(/do not open/);
    expect(await listed(store)).toEqual([mailbox.link]);
  });

  it("is not made with a key other than the one its mailbox names", async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const { post, mailbox } = await postWith(network);
    const other = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(3));
    await expect(post.inbox(mailbox.link, other)).rejects.toThrow(/names another key/);
  });
});

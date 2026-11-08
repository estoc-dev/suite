import { type Actor, ed25519, type KeyObject, loadIdentity, type Signature, SoftwareSigner } from "@estoc/identity";
import { type EncodedObject, encodeObject, type Json, json, type Link } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { MemoryBackend, PrivateStore, Store, view } from "@estoc/store";
import { assert, describe, expect, it, test } from "vitest";
import { type Inbox, loadMailboxGrants, loadPost, type Post } from "../src/index.ts";
import { MemoryNetwork } from "./memory-network.ts";

// People who each keep a store and receive at a mailbox of their own. Whoever
// takes someone's messages at some mailboxes signs a grant of them to that
// someone, writes the signature as a record and sends it to them, and each
// reads the latest grant of a series from their own store.

const identity = await loadIdentity(defaultValidator, [ed25519]);
const { signatures, publish } = identity;
const grants = await loadMailboxGrants(defaultValidator, identity);
const network = await MemoryNetwork.create(defaultValidator);

interface Person {
  readonly actor: Actor;
  readonly root: Link<KeyObject>;
  readonly store: Store;
  readonly post: Post;
  readonly inbox: Inbox;
  collect(): Promise<unknown>;
}

async function person(fill: number, backend = new MemoryBackend()): Promise<Person> {
  const signer = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(fill));
  const actor = signatures.actor(signer, await publish(signer, 0));
  const store = new Store(json, backend);
  const privateStore = new PrivateStore(store, new MemoryBackend());
  const post = await loadPost(store, privateStore, { transports: [network.transport], validator: defaultValidator });
  const queue = network.queue();
  const inbox = await post.openInbox(queue.mailbox);
  const collect = () => inbox.collect(queue.pickup(inbox.mailbox));
  return { actor, root: actor.signedIdentity.identity.root.link, store, post, inbox, collect };
}

// A mailbox at a queue of its own, which no one receives at, in `person`'s store.
async function mailboxIn({ store }: Person): Promise<Link<EncodedObject<Json>>> {
  const mailbox = network.queue().mailbox(new Uint8Array(32).fill(7));
  await store.write({ records: [mailbox], blobs: network.transport.schema.blobs });
  return mailbox.link;
}

// The blobs a store that holds the mailboxes of `grant` takes to write `signature` over it, to `to`, as a record.
const blobsOf = (grant: EncodedObject<Json>, signature: Signature, to: Person) => [
  grant.bytes,
  ...grants.schema.blobs,
  ...signatures.schema.blobs,
  ...signature.signedIdentity.blobs,
  ...to.actor.signedIdentity.blobs,
];

async function give(from: Person, to: Person, mailboxes: Link<EncodedObject<Json>>[], at: number) {
  const grant = grants.encode(to.actor.signedIdentity, mailboxes, at);
  const signature = await from.actor.sign(grant);
  await from.store.write({ records: [signature], blobs: blobsOf(grant, signature, to) });
  return signature;
}

// `from` sends what its store holds under `root` to the mailbox `to` receives at, and `to` collects it.
async function send(from: Person, to: Person, root: Link<unknown>) {
  const bytes = await to.store.get(to.inbox.mailbox);
  assert.exists(bytes);
  await from.store.write({ records: [{ bytes }], blobs: network.transport.schema.blobs });
  await (await from.post.outbox(to.inbox.mailbox)).send(root);
  await to.collect();
}

const grantFrom = async ({ store }: Person, from: Person, to: Person) =>
  (await view(store, grants.latest)).grantFrom(from.root, to.root);

describe("the latest grant of one person to another", () => {
  it("is the one with the greatest at, whatever order they were written in", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const [first, second, third] = [await mailboxIn(alice), await mailboxIn(alice), await mailboxIn(alice)];
    const latest = await give(alice, bob, [second, third], 2_000);
    await give(alice, bob, [first], 1_000);
    await give(alice, bob, [third], 1_500);

    const grant = await grantFrom(alice, alice, bob);
    assert.exists(grant);
    expect(grant.signature.link).toBe(latest.link);
    expect(grant.object.data.mailboxes).toEqual([{ $link: second }, { $link: third }]);
    expect(grant.to.link).toBe(bob.actor.signedIdentity.link);
  });

  it("is, of two at one at, the one whose signature has the greater link", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const givenSignatures = [
      await give(alice, bob, [await mailboxIn(alice)], 1_000),
      await give(alice, bob, [], 1_000),
    ];
    const greaterLink = givenSignatures.map(({ link }) => link).sort()[1];
    expect((await grantFrom(alice, alice, bob))?.signature.link).toBe(greaterLink);
  });

  it("names no mailboxes once the signer no longer takes their messages", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    await give(alice, bob, [alice.inbox.mailbox], 1_000);
    await give(alice, bob, [], 2_000);
    expect((await grantFrom(alice, alice, bob))?.object.data.mailboxes).toEqual([]);
  });

  it("reads the same from the bundle it came in as from the record its signer wrote", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const signature = await give(alice, bob, [alice.inbox.mailbox], 1_000);
    expect(await grantFrom(bob, alice, bob)).toBeUndefined();
    await send(alice, bob, signature.link);

    const [givenGrant, receivedGrant] = [await grantFrom(alice, alice, bob), await grantFrom(bob, alice, bob)];
    assert.exists(receivedGrant);
    expect(receivedGrant.signature.link).toBe(signature.link);
    expect(receivedGrant.object.link).toBe(givenGrant?.object.link);
    expect(receivedGrant.object.data.mailboxes).toEqual([{ $link: alice.inbox.mailbox }]);
  });

  it("is not one that the signer gave someone else, which was passed on", async () => {
    const [alice, bob, carol] = await Promise.all([person(1), person(2), person(3)]);
    const toBob = await give(alice, bob, [alice.inbox.mailbox], 1_000);
    const toCarol = await give(alice, carol, [alice.inbox.mailbox], 2_000);
    await send(alice, bob, toBob.link);
    await send(alice, carol, toCarol.link);
    await send(carol, bob, toCarol.link);

    expect((await grantFrom(bob, alice, bob))?.signature.link).toBe(toBob.link);
    expect((await grantFrom(bob, alice, carol))?.signature.link).toBe(toCarol.link);
  });

  it("is not one that came in with a signature that does not verify", async () => {
    const [alice, bob, mallory] = await Promise.all([person(1), person(2), person(4)]);
    const signature = await give(alice, bob, [alice.inbox.mailbox], 1_000);
    await send(alice, bob, signature.link);

    // Mallory has seen Alice's signed identity and a signature of hers, and
    // puts them over a later grant of a mailbox Mallory receives at.
    const grant = grants.encode(bob.actor.signedIdentity, [mallory.inbox.mailbox], 2_000);
    const forgedSignature = encodeObject(signatures.schema, { ...signature.data, object: { $link: grant.link } });
    await mallory.store.write({ records: [forgedSignature], blobs: blobsOf(grant, signature, bob) });
    await send(mallory, bob, forgedSignature.link);

    expect((await grantFrom(bob, alice, bob))?.signature.link).toBe(signature.link);
  });
});

test("a view whose store fails to give a grant that came in fails, and a later one reads the grant", async () => {
  let failingLink: Link<unknown> | undefined;
  const backend = new (class extends MemoryBackend {
    override get(link: Link<unknown>): Promise<Uint8Array | undefined> {
      return link === failingLink ? Promise.reject(new Error("the disk fails to read")) : super.get(link);
    }
  })();
  const [alice, bob] = await Promise.all([person(1), person(2, backend)]);
  const first = await give(alice, bob, [alice.inbox.mailbox], 1_000);
  await send(alice, bob, first.link);
  expect((await grantFrom(bob, alice, bob))?.signature.link).toBe(first.link);
  const withdrawal = await give(alice, bob, [], 2_000);
  await send(alice, bob, withdrawal.link);

  failingLink = withdrawal.link;
  await expect(grantFrom(bob, alice, bob)).rejects.toThrow(`the store fails to give ${withdrawal.link}`);
  failingLink = undefined;
  expect((await grantFrom(bob, alice, bob))?.signature.link).toBe(withdrawal.link);
});

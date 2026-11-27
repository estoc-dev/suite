import { decodeBundle, encodeBundle } from "@estoc/bundle";
import {
  type Actor,
  ed25519,
  identityKit,
  type Signature,
  type SignedIdentityObject,
  type Signer,
  SoftwareSigner,
} from "@estoc/identity";
import {
  digestOf,
  type EncodedObject,
  encodeObject,
  type Link,
  LinkValue,
  linkOf,
  ObjectValue,
  objectFormat,
} from "@estoc/object";
import { peopleView } from "@estoc/people";
import { Intake, MemoryBackend, Store, view } from "@estoc/store";
import { assert, describe, expect, it, test } from "vitest";
import {
  grantSeriesView,
  type Inbox,
  type MailboxData,
  mailboxGrantSchema,
  mailboxGrants,
  mailboxGrantTo,
  Post,
} from "../src/index.ts";
import { signedIdentityArrivalsView } from "../src/signed-identity-arrivals.ts";
import { MemoryNetwork } from "./memory-network.ts";

// People who each keep a store and receive at a mailbox of their own. Whoever
// takes someone's messages at some mailboxes signs a grant of them to that
// someone, writes the signature to their own store and sends it to them or hands
// it over out of band, and each reads the latest grant of a series from their own
// store.

const { signatures, signedIdentities, publish } = identityKit;
const identityVersionInHand = async <T>(inHand: T) => inHand;
const network = new MemoryNetwork();

// One clock for everyone, so that what comes in later is recorded with the greater `at`.
let now = 0;
const clock = () => ++now;

interface Person {
  readonly actor: Actor;
  readonly signedIdentity: SignedIdentityObject;
  readonly identifier: Link<unknown>;
  readonly store: Store;
  readonly post: Post;
  readonly intake: Intake;
  readonly inbox: Inbox;
  collect(): Promise<unknown>;
}

const signerOf = (fill: number) => SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(fill));

async function person(fill: number, backend = new MemoryBackend()): Promise<Person> {
  const signer = signerOf(fill);
  const signedIdentity = await publish(signer, { at: 0 });
  const store = new Store(backend);
  const actor = signatures.actor(signer, signedIdentity, async (inHand) =>
    (await view(store, peopleView)).current(inHand),
  );
  const post = new Post(store, { transports: [network.transport], clock });
  const intake = new Intake(store, clock);
  const queue = network.queue();
  const inbox = await post.openInbox(() => queue.transport);
  const collect = () => inbox.collect(queue.pickup(inbox.mailbox));
  const { identifier } = actor;
  return { actor, signedIdentity, identifier, store, post, intake, inbox, collect };
}

// The agent signs by `identityVersion` whatever the store holds, as a device its root removed still can.
const personSigningAs = (someone: Person, agent: Signer, identityVersion: SignedIdentityObject): Person => ({
  ...someone,
  actor: signatures.actor(agent, identityVersion, identityVersionInHand),
  signedIdentity: identityVersion,
  identifier: identityVersion.identity.identifier,
});

// A mailbox at a queue of its own, which no one receives at, in `person`'s store.
async function writeMailboxIn({ store }: Person): Promise<Link<EncodedObject<MailboxData>>> {
  const mailbox = network.queue().mailbox(new Uint8Array(32).fill(7));
  await store.write({ roots: [mailbox.link], blobs: [...mailbox.blobs()] });
  return mailbox.link;
}

// The blobs a store that holds the mailboxes of `grant` takes to write it, to `to`, beside those of a signature over it.
const blobsOf = (grant: EncodedObject, to: Person) => [
  grant.bytes,
  ...mailboxGrantSchema.blobs,
  ...to.signedIdentity.blobs,
];

async function give(from: Person, to: Person, mailboxes: Link<EncodedObject<MailboxData>>[], at: number) {
  const grant = mailboxGrantTo(to.signedIdentity, mailboxes, at);
  const signature = await from.actor.sign(grant);
  await from.store.write({ roots: [signature.link], blobs: [...signature.blobs, ...blobsOf(grant, to)] });
  return signature;
}

// `from` hands what its store holds under `root` to `to` out of band, and `to` keeps it.
async function handOver(from: Person, to: Person, root: Link<unknown>) {
  await to.intake.receive(decodeBundle(encodeBundle(root, (await from.store.closure(root)).values())));
}

const seeIdentityVersion = (someone: Person, identityVersion: SignedIdentityObject) =>
  someone.intake.receive(decodeBundle(encodeBundle(identityVersion.link, identityVersion.blobs)));

// `from` is handed the mailbox `to` receives at, sends what its store holds under `root` there, and `to` collects it.
async function send(from: Person, to: Person, root: Link<unknown>) {
  await handOver(to, from, to.inbox.mailbox);
  await (await from.post.outbox(to.inbox.mailbox)).send(root);
  await to.collect();
}

const grantFrom = async ({ store }: Person, from: Person, to: Person) =>
  (await view(store, grantSeriesView)).grantFrom(
    from.identifier,
    to.identifier,
    (await view(store, peopleView)).asOfArrival(await view(store, signedIdentityArrivalsView)),
  );

describe("the index of mailbox grants", () => {
  const scanIn = async (store: Store) => {
    const rows = await store.scan(mailboxGrants);
    const data = [];
    for await (const row of rows) data.push(row.data);
    return { data, failedItems: rows.failures.map(({ item }) => item) };
  };

  it("gives the row of each grant of one person, with whom it is to and its at", async () => {
    const [alice, bob, carol] = [await person(1), await person(2), await person(3)];
    const second = await give(alice, bob, [], 3_000);
    const toCarol = await give(alice, carol, [alice.inbox.mailbox], 1_000);
    const first = await give(alice, bob, [alice.inbox.mailbox], 2_000);

    const rowOf = (to: Person, at: number, signature: Signature) => ({
      from: new LinkValue(alice.identifier),
      to: new LinkValue(to.identifier),
      at,
      signature: new LinkValue(signature.link),
    });
    const { data, failedItems } = await scanIn(alice.store);
    expect(data).toHaveLength(3);
    expect(data).toEqual(
      expect.arrayContaining([rowOf(bob, 2_000, first), rowOf(bob, 3_000, second), rowOf(carol, 1_000, toCarol)]),
    );
    expect(failedItems).toEqual([]);
  });

  it("fails on an object signed that names the schema of a grant and does not fit it, and not on the Signature over it", async () => {
    const [alice, bob, mallory] = await Promise.all([person(1), person(2), person(4)]);
    const signature = await give(alice, bob, [alice.inbox.mailbox], 1_000);
    await send(alice, bob, signature.link);

    const misfit = objectFormat.encode(
      new ObjectValue(mailboxGrantSchema.link, { to: new LinkValue(bob.signedIdentity.link), at: 2_000 }),
    );
    const misfitSignature = await mallory.actor.sign({ link: linkOf(misfit) });
    const blobs = [...misfitSignature.blobs, misfit, ...mailboxGrantSchema.blobs, ...bob.signedIdentity.blobs];
    await bob.intake.receive(decodeBundle(encodeBundle(misfitSignature.link, blobs)));

    const { data, failedItems } = await scanIn(bob.store);
    expect(data.map((row) => row.signature.link)).toEqual([signature.link]);
    expect(failedItems).toEqual([linkOf(misfit)]);
  });

  it("gives no row of a grant to what is not a Signed Identity, and that is no failure", async () => {
    const alice = await person(1);
    const grant = encodeObject(mailboxGrantSchema, {
      to: new LinkValue(alice.inbox.mailbox),
      mailboxes: [],
      at: 1_000,
    });
    const signature = await alice.actor.sign(grant);
    const blobs = [...signature.blobs, grant.bytes, ...mailboxGrantSchema.blobs];
    await alice.store.write({ roots: [signature.link], blobs });

    expect(await scanIn(alice.store)).toEqual({ data: [], failedItems: [] });
  });

  it("fails on the Signed Identity that a grant is to where another key signed it", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const { identity } = bob.signedIdentity;
    const forged = objectFormat.encode(
      new ObjectValue(signedIdentities.schema.link, {
        identity: new LinkValue(identity.link),
        signature: await signerOf(9).sign(digestOf(identity.link)),
      }),
    );
    const grant = encodeObject(mailboxGrantSchema, { to: new LinkValue(linkOf(forged)), mailboxes: [], at: 1_000 });
    const signature = await alice.actor.sign(grant);
    const blobs = [...signature.blobs, grant.bytes, ...mailboxGrantSchema.blobs, forged, ...bob.signedIdentity.blobs];
    await alice.store.write({ roots: [signature.link], blobs });

    expect(await scanIn(alice.store)).toEqual({ data: [], failedItems: [linkOf(forged)] });
  });
});

describe("the latest grant of one person to another", () => {
  it("is the one with the greatest at, whatever order they were written in", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const [first, second, third] = [
      await writeMailboxIn(alice),
      await writeMailboxIn(alice),
      await writeMailboxIn(alice),
    ];
    const latest = await give(alice, bob, [second, third], 2_000);
    await give(alice, bob, [first], 1_000);
    await give(alice, bob, [third], 1_500);

    const grant = await grantFrom(alice, alice, bob);
    assert.exists(grant);
    expect(grant.signature.link).toBe(latest.link);
    expect(grant.object.data.mailboxes).toEqual([new LinkValue(second), new LinkValue(third)]);
    expect(grant.to.link).toBe(bob.signedIdentity.link);
  });

  it("is, of two at one at, the one whose signature has the greater link", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const givenSignatures = [
      await give(alice, bob, [await writeMailboxIn(alice)], 1_000),
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

  it("reads the same from the bundle it came in as from what its signer wrote", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const signature = await give(alice, bob, [alice.inbox.mailbox], 1_000);
    expect(await grantFrom(bob, alice, bob)).toBeUndefined();
    await send(alice, bob, signature.link);

    const [givenGrant, receivedGrant] = [await grantFrom(alice, alice, bob), await grantFrom(bob, alice, bob)];
    assert.exists(receivedGrant);
    expect(receivedGrant.signature.link).toBe(signature.link);
    expect(receivedGrant.object.link).toBe(givenGrant?.object.link);
    expect(receivedGrant.object.data.mailboxes).toEqual([new LinkValue(alice.inbox.mailbox)]);
  });

  it("reads the same from what was handed over out of band as from what its signer wrote", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const signature = await give(alice, bob, [alice.inbox.mailbox], 1_000);
    await handOver(alice, bob, signature.link);

    const [givenGrant, receivedGrant] = [await grantFrom(alice, alice, bob), await grantFrom(bob, alice, bob)];
    assert.exists(receivedGrant);
    expect(receivedGrant.signature.link).toBe(signature.link);
    expect(receivedGrant.object.link).toBe(givenGrant?.object.link);
    expect(receivedGrant.object.data.mailboxes).toEqual([new LinkValue(alice.inbox.mailbox)]);
  });

  it("reads the same from below the root of what came in as from what its signer wrote", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const signature = await give(alice, bob, [alice.inbox.mailbox], 1_000);
    const countersignature = await alice.actor.sign(signature);
    await alice.store.write({ roots: [countersignature.link], blobs: countersignature.blobs });
    await handOver(alice, bob, countersignature.link);

    expect((await grantFrom(bob, alice, bob))?.signature.link).toBe(signature.link);
  });

  it("is the one with the greatest at, whichever way each came in", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const mailedGrant = await give(alice, bob, [alice.inbox.mailbox], 1_000);
    const handedGrant = await give(alice, bob, [], 2_000);
    await handOver(alice, bob, handedGrant.link);
    await send(alice, bob, mailedGrant.link);
    expect((await grantFrom(bob, alice, bob))?.signature.link).toBe(handedGrant.link);

    const laterGrant = await give(alice, bob, [alice.inbox.mailbox], 3_000);
    await send(alice, bob, laterGrant.link);
    expect((await grantFrom(bob, alice, bob))?.signature.link).toBe(laterGrant.link);
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
    const grant = mailboxGrantTo(bob.signedIdentity, [mallory.inbox.mailbox], 2_000);
    const forgedSignature = encodeObject(signatures.schema, {
      signedIdentity: new LinkValue(signature.signedIdentity.link),
      object: new LinkValue(grant.link as Link<never>),
      signature: signature.signature,
    });
    await mallory.store.write({
      roots: [forgedSignature.link],
      blobs: [
        forgedSignature.bytes,
        ...signatures.schema.blobs,
        ...signature.signedIdentity.blobs,
        ...blobsOf(grant, bob),
      ],
    });
    await send(mallory, bob, forgedSignature.link);

    expect((await grantFrom(bob, alice, bob))?.signature.link).toBe(signature.link);
  });
});

// A wallet lists one agent at 1_000, and at 5_000 lists another in its place.
const wallet = signerOf(11);
const [formerAgent, currentAgent] = [signerOf(12), signerOf(13)];
const listingIdentityVersion = await publish(wallet, { agents: [formerAgent.key], at: 1_000 });
const removalIdentityVersion = await publish(wallet, {
  prior: listingIdentityVersion,
  agents: [currentAgent.key],
  at: 5_000,
});

describe("a grant by an agent that a later identity version does not list", () => {
  const twoPeople = async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    return {
      former: personSigningAs(alice, formerAgent, listingIdentityVersion),
      current: personSigningAs(alice, currentAgent, removalIdentityVersion),
      bob,
    };
  };

  it("is still honored once the reader sees that identity version, as it came in before", async () => {
    const { former, bob } = await twoPeople();
    const signature = await give(former, bob, [former.inbox.mailbox], 2_000);
    await handOver(former, bob, signature.link);
    expect((await grantFrom(bob, former, bob))?.signature.link).toBe(signature.link);

    await seeIdentityVersion(bob, removalIdentityVersion);
    expect((await grantFrom(bob, former, bob))?.signature.link).toBe(signature.link);
  });

  it("is not honored when it comes in after the reader saw that identity version", async () => {
    const { former, bob } = await twoPeople();
    await seeIdentityVersion(bob, removalIdentityVersion);
    const signature = await give(former, bob, [former.inbox.mailbox], 2_000);
    await handOver(former, bob, signature.link);

    expect(await grantFrom(bob, former, bob)).toBeUndefined();
  });

  it("is not honored when it comes in after that identity version came in below the root of a bundle", async () => {
    const { former, current, bob } = await twoPeople();
    const carol = await person(3);
    // Carol's grant is to that identity version, and only her signature is at the root.
    const toWallet = await give(carol, current, [carol.inbox.mailbox], 6_000);
    await handOver(carol, bob, toWallet.link);

    const signature = await give(former, bob, [former.inbox.mailbox], 2_000);
    await handOver(former, bob, signature.link);
    expect(await grantFrom(bob, former, bob)).toBeUndefined();
  });

  it("is honored when that identity version came in before it without the signature of its root", async () => {
    const { former, bob } = await twoPeople();
    const forgedIdentityVersion = encodeObject(signedIdentities.schema, {
      identity: new LinkValue(removalIdentityVersion.identity.link),
      signature: new Uint8Array(64),
    });
    const blobs = removalIdentityVersion.blobs.filter((blob) => linkOf(blob) !== removalIdentityVersion.link);
    await bob.intake.receive(
      decodeBundle(encodeBundle(forgedIdentityVersion.link, [forgedIdentityVersion.bytes, ...blobs])),
    );
    expect(await bob.store.get(forgedIdentityVersion.link)).toEqual(forgedIdentityVersion.bytes);

    const signature = await give(former, bob, [former.inbox.mailbox], 2_000);
    await handOver(former, bob, signature.link);
    expect((await grantFrom(bob, former, bob))?.signature.link).toBe(signature.link);
  });

  it("gives way, when it came in after that identity version, to one by a key that the current identity version lists, whatever its at", async () => {
    const { former, current, bob } = await twoPeople();
    const newGrant = await give(current, bob, [current.inbox.mailbox], 6_000);
    await handOver(current, bob, newGrant.link);
    const oldGrant = await give(former, bob, [former.inbox.mailbox], 9_000_000);
    await handOver(former, bob, oldGrant.link);
    expect((await grantFrom(bob, former, bob))?.signature.link).toBe(newGrant.link);
  });

  it("stays the latest once that identity version comes in, over an older one by a key that it still lists", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const identityVersion = await publish(wallet, {
      prior: listingIdentityVersion,
      agents: [formerAgent.key, currentAgent.key],
      at: 3_000,
    });
    const [former, current] = [
      personSigningAs(alice, formerAgent, identityVersion),
      personSigningAs(alice, currentAgent, identityVersion),
    ];
    const older = await give(current, bob, [current.inbox.mailbox], 3_000);
    const newer = await give(former, bob, [], 4_000);
    await handOver(alice, bob, older.link);
    await handOver(alice, bob, newer.link);
    expect((await grantFrom(bob, former, bob))?.signature.link).toBe(newer.link);

    await seeIdentityVersion(bob, removalIdentityVersion);
    expect((await grantFrom(bob, former, bob))?.signature.link).toBe(newer.link);
  });

  it("is not honored when it came in after that identity version, even once a later one lists its agent again", async () => {
    const { former, bob } = await twoPeople();
    await seeIdentityVersion(bob, removalIdentityVersion);
    const signature = await give(former, bob, [former.inbox.mailbox], 6_000);
    await handOver(former, bob, signature.link);
    expect(await grantFrom(bob, former, bob)).toBeUndefined();

    await seeIdentityVersion(
      bob,
      await publish(wallet, { prior: removalIdentityVersion, agents: [formerAgent.key], at: 9_000 }),
    );
    expect(await grantFrom(bob, former, bob)).toBeUndefined();
  });

  it("is not honored once the reader sees a crisis that does not follow the identity version it carries", async () => {
    const { former, bob } = await twoPeople();
    const signature = await give(former, bob, [former.inbox.mailbox], 2_000);
    await handOver(former, bob, signature.link);

    await seeIdentityVersion(
      bob,
      await publish(wallet, { prior: listingIdentityVersion, agents: [formerAgent.key], isCrisis: true, at: 3_000 }),
    );
    expect(await grantFrom(bob, former, bob)).toBeUndefined();
  });

  it("reads alike from a store made again on the same backend", async () => {
    const backend = new MemoryBackend();
    const [alice, bob] = await Promise.all([person(1), person(2, backend)]);
    const [former, current] = [
      personSigningAs(alice, formerAgent, listingIdentityVersion),
      personSigningAs(alice, currentAgent, removalIdentityVersion),
    ];
    const before = await give(former, bob, [former.inbox.mailbox], 2_000);
    await handOver(former, bob, before.link);
    await seeIdentityVersion(bob, removalIdentityVersion);
    await handOver(former, bob, (await give(former, bob, [], 9_000)).link);
    const latest = await grantFrom(bob, current, bob);

    const again = { ...bob, store: new Store(backend) };
    expect(latest?.signature.link).toBe(before.link);
    expect((await grantFrom(again, current, bob))?.signature.link).toBe(before.link);
  });
});

test("a view whose store fails to give a grant that came in fails, and a later one reads the grant", async () => {
  let failingLink: Link<unknown> | undefined;
  const diskError = new Error("the disk fails to read");
  const backend = new (class extends MemoryBackend {
    override get(link: Link<unknown>): Promise<Uint8Array | undefined> {
      return link === failingLink ? Promise.reject(diskError) : super.get(link);
    }
  })();
  const [alice, bob] = await Promise.all([person(1), person(2, backend)]);
  const first = await give(alice, bob, [alice.inbox.mailbox], 1_000);
  await send(alice, bob, first.link);
  expect((await grantFrom(bob, alice, bob))?.signature.link).toBe(first.link);
  const withdrawal = await give(alice, bob, [], 2_000);
  await send(alice, bob, withdrawal.link);

  failingLink = withdrawal.link;
  await expect(grantFrom(bob, alice, bob)).rejects.toBe(diskError);
  failingLink = undefined;
  expect((await grantFrom(bob, alice, bob))?.signature.link).toBe(withdrawal.link);
});

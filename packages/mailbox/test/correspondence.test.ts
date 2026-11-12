import { decodeBundle, encodeBundle } from "@estoc/bundle";
import {
  type Actor,
  ed25519,
  loadIdentity,
  noIdentityVersions,
  type SignedIdentityObject,
  SoftwareSigner,
} from "@estoc/identity";
import { encodeObject, type Link, LinkValue, objectFormat, readObject } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { Intake, MemoryBackend, PrivateStore, RefusedBatch, Store } from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import {
  type Correspondence,
  type Inbox,
  MailboxGrants,
  mailboxSchema,
  type Pickup,
  Post,
  type Transport,
  UndeliveredMessage,
} from "../src/index.ts";
import { MemoryNetwork } from "./memory-network.ts";

// People who each keep a store and correspond as one actor: each gives the
// other a grant of a mailbox, sends by the grant they were given, and reads
// what came in by the grants they gave.

const identity = loadIdentity([ed25519]);
const { signatures, publish } = identity;
const grants = new MailboxGrants(identity);
const note = schema("Note", { text: string() });
const network = new MemoryNetwork();

// The kinds that the mailboxes at some queues turn a message back with.
const undeliveredKindByQueue = new Map<unknown, UndeliveredMessage["kind"]>();
const transport: Transport = {
  schema: network.transport.schema,
  deliver: async (mailbox, ciphertext) => {
    const kind = undeliveredKindByQueue.get(mailbox.name);
    if (kind !== undefined) throw new UndeliveredMessage(kind, "this queue turns it back");
    await network.transport.deliver(mailbox, ciphertext);
  },
};

// One clock for everyone, so that what is done later has the greater `at`.
let now = 0;
const clock = () => ++now;

interface Person {
  readonly actor: Actor;
  readonly signedIdentity: SignedIdentityObject;
  readonly store: Store;
  readonly post: Post;
  readonly intake: Intake;
  readonly correspondence: Correspondence;
}

const signerOf = (fill: number) => SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(fill));

async function personActingAs(actor: Actor, store = new Store(objectFormat, new MemoryBackend())): Promise<Person> {
  const privateStore = new PrivateStore(store, new MemoryBackend());
  const post = new Post(store, privateStore, { transports: [transport], clock });
  const intake = new Intake(store, clock);
  const correspondence = post.correspondenceAs(actor, identity);
  return { actor, signedIdentity: actor.signedIdentity, store, post, intake, correspondence };
}

async function person(fill: number): Promise<Person> {
  const signer = signerOf(fill);
  return personActingAs(signatures.actor(signer, await publish(signer, { at: 0 })));
}

interface OpenedInbox {
  readonly name: string;
  readonly inbox: Inbox;
  readonly pickup: Pickup;
}

async function openInbox({ post }: Person): Promise<OpenedInbox> {
  const queue = network.queue();
  const inbox = await post.openInbox(queue.mailbox);
  return { name: queue.name, inbox, pickup: queue.pickup(inbox.mailbox) };
}

// `from` hands what its store holds under `root` to `to` out of band, and `to` keeps it.
async function handOver(from: Person, to: Person, root: Link<unknown>) {
  const closure = await from.store.closure(root);
  const bytes = closure.get(root);
  assert.exists(bytes);
  await to.intake.receive(decodeBundle(encodeBundle({ bytes }, closure.values())));
}

const seeIdentityVersion = ({ intake }: Person, identityVersion: SignedIdentityObject) =>
  intake.receive(decodeBundle(encodeBundle({ bytes: identityVersion.bytes }, identityVersion.blobs)));

// `from` gives `to` a grant of `mailboxes` and hands it over out of band.
async function grantMailboxes(from: Person, to: Person, mailboxes: readonly OpenedInbox[]) {
  const signature = await from.correspondence.grant(
    to.signedIdentity,
    mailboxes.map(({ inbox }) => inbox.mailbox),
  );
  await handOver(from, to, signature.link);
}

async function grantInbox(from: Person, to: Person): Promise<OpenedInbox> {
  const openedInbox = await openInbox(from);
  await grantMailboxes(from, to, [openedInbox]);
  return openedInbox;
}

// A signed note in the store of whoever acts, to send.
async function writeNote({ actor, store }: Person, text: string) {
  const object = encodeObject(note, { text });
  const signature = await actor.sign(object);
  await store.write({
    records: [signature],
    blobs: [object.bytes, ...signature.signedIdentity.blobs, ...note.blobs, ...signatures.schema.blobs],
  });
  return signature;
}

async function listed({ store }: Person): Promise<Link<unknown>[]> {
  const links: Link<unknown>[] = [];
  for await (const link of store.records()) links.push(link);
  return links;
}

// A wallet lists one agent at 1_000, and at 2_000 lists another in its place.
const wallet = signerOf(11);
const [formerAgent, currentAgent] = [signerOf(12), signerOf(13)];
const listingIdentityVersion = await publish(wallet, { agents: [formerAgent.key], at: 1_000 });
const removalIdentityVersion = await publish(wallet, {
  prior: listingIdentityVersion,
  agents: [currentAgent.key],
  at: 2_000,
});

describe("a grant", () => {
  it("is written as a record, signed by the actor, of the mailboxes, at the post's clock", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const { inbox } = await openInbox(alice);
    const before = now;
    const signature = await alice.correspondence.grant(bob.signedIdentity, [inbox.mailbox]);

    expect(await listed(alice)).toContain(signature.link);
    const readSignature = await signatures.read(signature.link, alice.store, noIdentityVersions);
    expect(readSignature.signedIdentity.link).toBe(alice.signedIdentity.link);
    const { data } = await readObject(alice.store, readSignature.object, grants.schema);
    expect(data).toEqual({
      to: new LinkValue(bob.signedIdentity.link),
      mailboxes: [new LinkValue(inbox.mailbox)],
      at: before + 1,
    });
  });

  it("is to the current identity version that the store holds of whoever it is given", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const { inbox } = await openInbox(alice);
    await seeIdentityVersion(alice, removalIdentityVersion);
    const signature = await alice.correspondence.grant(listingIdentityVersion, [inbox.mailbox]);
    const { data } = await readObject(alice.store, signature.object, grants.schema);
    expect(data.to.link).toBe(removalIdentityVersion.link);

    const toBob = await alice.correspondence.grant(bob.signedIdentity, [inbox.mailbox]);
    const { data: dataToBob } = await readObject(alice.store, toBob.object, grants.schema);
    expect(dataToBob.to.link).toBe(bob.signedIdentity.link);
  });

  it("is refused when the store does not hold a mailbox it names, and nothing is written", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const elsewhere = network.queue().mailbox(new Uint8Array(32).fill(7));
    const before = await listed(alice);
    await expect(alice.correspondence.grant(bob.signedIdentity, [elsewhere.link])).rejects.toThrow(RefusedBatch);
    expect(await listed(alice)).toEqual(before);
  });
});

describe("sending to someone", () => {
  it("goes to each mailbox of their latest grant, with a record for each", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const [first, second] = [await openInbox(bob), await openInbox(bob)];
    await grantMailboxes(bob, alice, [first, second]);

    const signature = await writeNote(alice, "hi Bob");
    const deliveries = await alice.correspondence.send(bob.signedIdentity, signature.link);
    expect(deliveries.map(({ mailbox }) => mailbox)).toEqual([first.inbox.mailbox, second.inbox.mailbox]);
    expect(await listed(alice)).toEqual(expect.arrayContaining(deliveries.map(({ link }) => link)));
    expect(await first.inbox.collect(first.pickup)).toHaveLength(1);
    expect(await second.inbox.collect(second.pickup)).toHaveLength(1);
  });

  it("goes by their latest grant and not an earlier one", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const earlier = await grantInbox(bob, alice);
    const later = await grantInbox(bob, alice);

    const signature = await writeNote(alice, "hi Bob");
    await alice.correspondence.send(bob.signedIdentity, signature.link);
    expect(await earlier.inbox.collect(earlier.pickup)).toEqual([]);
    expect(await later.inbox.collect(later.pickup)).toHaveLength(1);
  });

  it("is turned back as gone when they have given no grant", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const signature = await writeNote(alice, "hi Bob");
    const sending = alice.correspondence.send(bob.signedIdentity, signature.link);
    await expect(sending).rejects.toThrow(UndeliveredMessage);
    await expect(sending).rejects.toMatchObject({ kind: "gone" });
  });

  it("is turned back as gone when their latest grant names no mailbox", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const { inbox, pickup } = await grantInbox(bob, alice);
    await grantMailboxes(bob, alice, []);

    const signature = await writeNote(alice, "hi Bob");
    await expect(alice.correspondence.send(bob.signedIdentity, signature.link)).rejects.toMatchObject({ kind: "gone" });
    expect(await inbox.collect(pickup)).toEqual([]);
  });

  it("goes by a grant that the store took in before their root removed the key that signed it", async () => {
    const [alice, bob] = await Promise.all([
      person(1),
      personActingAs(signatures.actor(formerAgent, listingIdentityVersion)),
    ]);
    const { inbox, pickup } = await grantInbox(bob, alice);
    await seeIdentityVersion(alice, removalIdentityVersion);

    const signature = await writeNote(alice, "hi Bob");
    await alice.correspondence.send(bob.signedIdentity, signature.link);
    expect(await inbox.collect(pickup)).toHaveLength(1);
  });

  it("is turned back as gone when the store took their only grant in after their root removed the key that signed it", async () => {
    const [alice, bob] = await Promise.all([
      person(1),
      personActingAs(signatures.actor(formerAgent, listingIdentityVersion)),
    ]);
    await seeIdentityVersion(alice, removalIdentityVersion);
    await grantInbox(bob, alice);

    const signature = await writeNote(alice, "hi Bob");
    await expect(alice.correspondence.send(bob.signedIdentity, signature.link)).rejects.toMatchObject({ kind: "gone" });
  });

  it("has gone once one mailbox takes it, though another turned it back", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const [turningBackInbox, takingInbox] = [await openInbox(bob), await openInbox(bob)];
    undeliveredKindByQueue.set(turningBackInbox.name, "gone");
    await grantMailboxes(bob, alice, [turningBackInbox, takingInbox]);

    const signature = await writeNote(alice, "hi Bob");
    const deliveries = await alice.correspondence.send(bob.signedIdentity, signature.link);
    expect(deliveries.map(({ mailbox }) => mailbox)).toEqual([takingInbox.inbox.mailbox]);
    expect(await takingInbox.inbox.collect(takingInbox.pickup)).toHaveLength(1);
  });

  it("is turned back as later when every mailbox turned it back and one can take it later", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const [gone, busy] = [await openInbox(bob), await openInbox(bob)];
    undeliveredKindByQueue.set(gone.name, "gone");
    undeliveredKindByQueue.set(busy.name, "later");
    await grantMailboxes(bob, alice, [gone, busy]);

    const signature = await writeNote(alice, "hi Bob");
    const before = await listed(alice);
    await expect(alice.correspondence.send(bob.signedIdentity, signature.link)).rejects.toMatchObject({
      kind: "later",
    });
    expect(await listed(alice)).toEqual(before);
  });

  it("sends nothing when the post has no transport for a mailbox of the grant", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const { inbox, pickup } = await openInbox(bob);
    const otherSchema = mailboxSchema("Other mailbox", { place: string() });
    const other = encodeObject(otherSchema, { key: new Uint8Array(32), place: "elsewhere" });
    await bob.store.write({ records: [other], blobs: [...otherSchema.blobs] });
    const givenGrant = await bob.correspondence.grant(alice.signedIdentity, [inbox.mailbox, other.link]);
    await handOver(bob, alice, givenGrant.link);

    const signature = await writeNote(alice, "hi Bob");
    await expect(alice.correspondence.send(bob.signedIdentity, signature.link)).rejects.toThrow(/no transport/);
    expect(await inbox.collect(pickup)).toEqual([]);
  });
});

describe("what came in at a mailbox", () => {
  const twoPeople = async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const openedInbox = await grantInbox(bob, alice);
    const receive = async () => {
      const [delivery] = await openedInbox.inbox.collect(openedInbox.pickup);
      assert.exists(delivery);
      return delivery;
    };
    return { alice, bob, ...openedInbox, receive };
  };

  it("is a message from whoever signed it, at a mailbox of a grant to them", async () => {
    const { alice, bob, inbox, receive } = await twoPeople();
    const signature = await writeNote(alice, "hi Bob");
    await alice.correspondence.send(bob.signedIdentity, signature.link);
    const { bundle } = await receive();

    const message = await bob.correspondence.messageAt(inbox.mailbox, bundle);
    expect(message?.link).toBe(signature.link);
    expect(message?.signedIdentity.link).toBe(alice.signedIdentity.link);
  });

  it("is no message when someone with no grant signed it, who was passed the mailbox", async () => {
    const { alice, bob, inbox, receive } = await twoPeople();
    const mallory = await person(4);
    await handOver(alice, mallory, inbox.mailbox);
    const signature = await writeNote(mallory, "hi Bob");
    await (await mallory.post.outbox(inbox.mailbox)).send(signature.link);
    const { bundle } = await receive();

    expect(await bob.correspondence.messageAt(inbox.mailbox, bundle)).toBeUndefined();
  });

  it("is a message only at a mailbox that was granted to whoever signed it", async () => {
    const { alice, bob, inbox, receive } = await twoPeople();
    const carol = await person(3);
    const toCarol = await grantInbox(bob, carol);
    await handOver(alice, carol, inbox.mailbox);

    const signature = await writeNote(carol, "hi Bob");
    await (await carol.post.outbox(inbox.mailbox)).send(signature.link);
    const { bundle } = await receive();

    expect(await bob.correspondence.messageAt(inbox.mailbox, bundle)).toBeUndefined();
    expect((await bob.correspondence.messageAt(toCarol.inbox.mailbox, bundle))?.link).toBe(signature.link);
  });

  it("is no message when its root is not a signature", async () => {
    const { alice, bob, inbox, receive } = await twoPeople();
    const object = encodeObject(note, { text: "no one signed this" });
    await alice.store.write({ records: [object], blobs: [...note.blobs] });
    await (await alice.post.outbox(inbox.mailbox)).send(object.link);
    const { bundle } = await receive();

    expect(await bob.correspondence.messageAt(inbox.mailbox, bundle)).toBeUndefined();
  });

  it("is no message when its signature does not verify", async () => {
    const { alice, bob, inbox, receive } = await twoPeople();
    const signature = await writeNote(alice, "hi Bob");
    const other = encodeObject(note, { text: "not what was signed" });
    const forged = encodeObject(signatures.schema, { ...signature.data, object: new LinkValue(other.link) });
    await alice.store.write({ records: [forged], blobs: [other.bytes] });
    await (await alice.post.outbox(inbox.mailbox)).send(forged.link);
    const { bundle } = await receive();

    expect(await bob.correspondence.messageAt(inbox.mailbox, bundle)).toBeUndefined();
  });

  describe("signed by a key that its signer's root removes", () => {
    const formerAlice = async () => {
      const [alice, bob] = await Promise.all([
        personActingAs(signatures.actor(formerAgent, listingIdentityVersion)),
        person(2),
      ]);
      const { inbox, pickup } = await grantInbox(bob, alice);
      const receive = async () => {
        const signature = await writeNote(alice, "hi Bob");
        await alice.correspondence.send(bob.signedIdentity, signature.link);
        const [delivery] = await inbox.collect(pickup);
        assert.exists(delivery);
        return { signature, bundle: delivery.bundle };
      };
      return { bob, inbox, receive };
    };

    it("is still a message once the store holds the removal, as it took the message in before", async () => {
      const { bob, inbox, receive } = await formerAlice();
      const { signature, bundle } = await receive();
      await seeIdentityVersion(bob, removalIdentityVersion);
      expect((await bob.correspondence.messageAt(inbox.mailbox, bundle))?.link).toBe(signature.link);
    });

    it("is no message when the store took it in after the removal, though it carries an identity version that lists the key", async () => {
      const { bob, inbox, receive } = await formerAlice();
      await seeIdentityVersion(bob, removalIdentityVersion);
      const { bundle } = await receive();
      expect(await bob.correspondence.messageAt(inbox.mailbox, bundle)).toBeUndefined();
    });

    it("is no message once the store holds a crisis that the identity version it carries does not follow", async () => {
      const { bob, inbox, receive } = await formerAlice();
      const { bundle } = await receive();
      const crisis = await publish(wallet, {
        prior: listingIdentityVersion,
        agents: [formerAgent.key],
        isCrisis: true,
        at: 3_000,
      });
      await seeIdentityVersion(bob, crisis);
      expect(await bob.correspondence.messageAt(inbox.mailbox, bundle)).toBeUndefined();
    });
  });

  it("is still a message once the mailbox has left the latest grant", async () => {
    const { alice, bob, inbox, receive } = await twoPeople();
    const signature = await writeNote(alice, "hi Bob");
    await alice.correspondence.send(bob.signedIdentity, signature.link);
    const { bundle } = await receive();

    await grantInbox(bob, alice);
    expect((await bob.correspondence.messageAt(inbox.mailbox, bundle))?.link).toBe(signature.link);
  });

  it("is still a message once the receiver's root has removed the key that signed its grant, as the store took the grant in before", async () => {
    const backend = new MemoryBackend();
    const store = new Store(objectFormat, backend);
    const [formerBob, currentBob, alice] = await Promise.all([
      personActingAs(signatures.actor(formerAgent, listingIdentityVersion), store),
      personActingAs(signatures.actor(currentAgent, removalIdentityVersion), store),
      person(1),
    ]);
    const { inbox, pickup } = await grantInbox(formerBob, alice);
    const signature = await writeNote(alice, "hi Bob");
    await alice.correspondence.send(formerBob.signedIdentity, signature.link);
    const [delivery] = await inbox.collect(pickup);
    assert.exists(delivery);

    await seeIdentityVersion(currentBob, removalIdentityVersion);
    expect((await currentBob.correspondence.messageAt(inbox.mailbox, delivery.bundle))?.link).toBe(signature.link);
    const again = await personActingAs(currentBob.actor, new Store(objectFormat, backend));
    expect((await again.correspondence.messageAt(inbox.mailbox, delivery.bundle))?.link).toBe(signature.link);
  });

  it("is no message by a grant that the store took in after the receiver's root removed the key that signed it, until a listed key signs one", async () => {
    const store = new Store(objectFormat, new MemoryBackend());
    const [formerBob, currentBob, alice] = await Promise.all([
      personActingAs(signatures.actor(formerAgent, listingIdentityVersion), store),
      personActingAs(signatures.actor(currentAgent, removalIdentityVersion), store),
      person(1),
    ]);
    await seeIdentityVersion(currentBob, removalIdentityVersion);
    const { inbox, pickup } = await openInbox(formerBob);
    await handOver(
      formerBob,
      alice,
      (await formerBob.correspondence.grant(alice.signedIdentity, [inbox.mailbox])).link,
    );
    const signature = await writeNote(alice, "hi Bob");
    await alice.correspondence.send(formerBob.signedIdentity, signature.link);
    const [delivery] = await inbox.collect(pickup);
    assert.exists(delivery);
    expect(await currentBob.correspondence.messageAt(inbox.mailbox, delivery.bundle)).toBeUndefined();

    await currentBob.correspondence.grant(alice.signedIdentity, [inbox.mailbox]);
    expect((await currentBob.correspondence.messageAt(inbox.mailbox, delivery.bundle))?.link).toBe(signature.link);
  });

  it("fails while the store fails to give a blob of it or no longer holds one, and reads once the store gives it", async () => {
    let failingLink: Link<unknown> | undefined;
    let lostLink: Link<unknown> | undefined;
    const diskError = new Error("the disk fails to read");
    const backend = new (class extends MemoryBackend {
      override get(link: Link<unknown>): Promise<Uint8Array | undefined> {
        if (link === lostLink) return Promise.resolve(undefined);
        return link === failingLink ? Promise.reject(diskError) : super.get(link);
      }
    })();
    const signer = signerOf(2);
    const [alice, bob] = await Promise.all([
      person(1),
      personActingAs(signatures.actor(signer, await publish(signer, { at: 0 })), new Store(objectFormat, backend)),
    ]);
    const { inbox, pickup } = await grantInbox(bob, alice);
    const signature = await writeNote(alice, "hi Bob");
    await alice.correspondence.send(bob.signedIdentity, signature.link);
    const [delivery] = await inbox.collect(pickup);
    assert.exists(delivery);
    expect((await bob.correspondence.messageAt(inbox.mailbox, delivery.bundle))?.link).toBe(signature.link);

    failingLink = signature.link;
    await expect(bob.correspondence.messageAt(inbox.mailbox, delivery.bundle)).rejects.toBe(diskError);
    failingLink = undefined;
    for (const link of [signature.link, signature.signedIdentity.link]) {
      lostLink = link;
      await expect(bob.correspondence.messageAt(inbox.mailbox, delivery.bundle)).rejects.toThrow(
        `the store does not hold ${link}`,
      );
    }
    lostLink = undefined;
    expect((await bob.correspondence.messageAt(inbox.mailbox, delivery.bundle))?.link).toBe(signature.link);
  });
});

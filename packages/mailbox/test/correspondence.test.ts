import { decodeBundle, encodeBundle } from "@estoc/bundle";
import {
  type Actor,
  ed25519,
  identityKit,
  type SignedIdentityObject,
  type Signer,
  SoftwareSigner,
} from "@estoc/identity";
import { encodeObject, type Link, LinkValue, readObject } from "@estoc/object";
import { peopleView } from "@estoc/people";
import { link, schema, string } from "@estoc/schema";
import { Intake, MemoryBackend, RefusedBatch, Store, view, writtenObjectSchema, writtenObjectsOf } from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import { type Correspondence, type Inbox, MailboxGrants, type Pickup, Post, UndeliveredMessage } from "../src/index.ts";
import { mailboxBundle } from "./mailbox-bundle.ts";
import { MemoryNetwork, type Queue } from "./memory-network.ts";
import { recordedIn } from "./recorded.ts";

// People who each keep a store and correspond as one actor: each gives the
// other a grant of a mailbox, sends by the grant they were given, and reads
// what came in by the grants they gave.

const identity = identityKit;
const { signatures, publish } = identity;
const identityVersionInHand = async <T>(inHand: T) => inHand;
const grants = new MailboxGrants(identity);
const note = schema("Note", { text: string() });
const network = new MemoryNetwork();

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

async function personActingAs(
  signer: Signer,
  signedIdentity: SignedIdentityObject,
  // Those given the same backend are one person's devices as one: they share the blobs and the records.
  backend = new MemoryBackend(),
  actorOver = (store: Store) =>
    signatures.actor(signer, signedIdentity, async (inHand) => (await view(store, peopleView)).current(inHand)),
): Promise<Person> {
  const store = new Store(backend);
  const post = new Post(store, { transports: [network.transport], clock });
  const intake = new Intake(store, clock);
  const actor = actorOver(store);
  const correspondence = post.correspondenceAs(actor, identity);
  return { actor, signedIdentity, store, post, intake, correspondence };
}

async function person(fill: number): Promise<Person> {
  const signer = signerOf(fill);
  return personActingAs(signer, await publish(signer, { at: 0 }));
}

interface OpenedInbox {
  readonly queue: Queue;
  readonly inbox: Inbox;
  readonly pickup: Pickup;
}

async function openInbox({ post }: Person, on = network): Promise<OpenedInbox> {
  const queue = on.queue();
  const inbox = await post.openInbox(() => queue.transport);
  return { queue, inbox, pickup: queue.pickup(inbox.mailbox) };
}

// `from` hands what its store holds under `root` to `to` out of band, and `to` keeps it.
async function handOver(from: Person, to: Person, root: Link<unknown>) {
  await to.intake.receive(decodeBundle(encodeBundle(root, (await from.store.closure(root)).values())));
}

const seeIdentityVersion = ({ intake }: Person, identityVersion: SignedIdentityObject) =>
  intake.receive(decodeBundle(encodeBundle(identityVersion.link, identityVersion.blobs)));

// A person keeps an identity version that their own root signed, as one they wrote.
async function recordIdentityVersion({ store }: Person, identityVersion: SignedIdentityObject) {
  await store.write({ roots: [identityVersion.link], blobs: identityVersion.blobs });
  await store.record(writtenObjectsOf([identityVersion.link], clock()));
}

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
    roots: [signature.link],
    blobs: [...signature.blobs, object.bytes, ...note.blobs],
  });
  return signature;
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
  it("is a signature by the actor, of the mailboxes, at the post's clock, which the store records", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const { inbox } = await openInbox(alice);
    const before = now;
    const signature = await alice.correspondence.grant(bob.signedIdentity, [inbox.mailbox]);

    expect(await recordedIn(alice.store)).toContain(signature.link);
    const readSignature = await signatures.read(signature.link, alice.store);
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
    const before = await recordedIn(alice.store);
    await expect(alice.correspondence.grant(bob.signedIdentity, [elsewhere.link])).rejects.toThrow(RefusedBatch);
    expect(await recordedIn(alice.store)).toEqual(before);
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
    expect(await recordedIn(alice.store)).toEqual(expect.arrayContaining(deliveries.map(({ link }) => link)));
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

  it("goes by a grant that came in before the identity version in which their root removed the key that signed it", async () => {
    const [alice, bob] = await Promise.all([person(1), personActingAs(formerAgent, listingIdentityVersion)]);
    const { inbox, pickup } = await grantInbox(bob, alice);
    await seeIdentityVersion(alice, removalIdentityVersion);

    const signature = await writeNote(alice, "hi Bob");
    await alice.correspondence.send(bob.signedIdentity, signature.link);
    expect(await inbox.collect(pickup)).toHaveLength(1);
  });

  it("is turned back as gone when their only grant came in after the identity version in which their root removed the key that signed it", async () => {
    const [alice, bob] = await Promise.all([person(1), personActingAs(formerAgent, listingIdentityVersion)]);
    await seeIdentityVersion(alice, removalIdentityVersion);
    await grantInbox(bob, alice);

    const signature = await writeNote(alice, "hi Bob");
    await expect(alice.correspondence.send(bob.signedIdentity, signature.link)).rejects.toMatchObject({ kind: "gone" });
  });

  it("has gone once one mailbox takes it, though another turned it back", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const [turningBackInbox, takingInbox] = [await openInbox(bob), await openInbox(bob)];
    turningBackInbox.queue.turnBack("gone");
    await grantMailboxes(bob, alice, [turningBackInbox, takingInbox]);

    const signature = await writeNote(alice, "hi Bob");
    const deliveries = await alice.correspondence.send(bob.signedIdentity, signature.link);
    expect(deliveries.map(({ mailbox }) => mailbox)).toEqual([takingInbox.inbox.mailbox]);
    expect(await takingInbox.inbox.collect(takingInbox.pickup)).toHaveLength(1);
  });

  it("has gone once one mailbox takes it, though the transport has no route to another", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const [unreachedInbox, takingInbox] = [await openInbox(bob, new MemoryNetwork()), await openInbox(bob)];
    await grantMailboxes(bob, alice, [unreachedInbox, takingInbox]);

    const signature = await writeNote(alice, "hi Bob");
    const deliveries = await alice.correspondence.send(bob.signedIdentity, signature.link);
    expect(deliveries.map(({ mailbox }) => mailbox)).toEqual([takingInbox.inbox.mailbox]);
    expect(await takingInbox.inbox.collect(takingInbox.pickup)).toHaveLength(1);
  });

  it("is turned back as later when every mailbox turned it back and one can take it later", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const [gone, busy] = [await openInbox(bob), await openInbox(bob)];
    gone.queue.turnBack("gone");
    busy.queue.turnBack("later");
    await grantMailboxes(bob, alice, [gone, busy]);

    const signature = await writeNote(alice, "hi Bob");
    const before = await recordedIn(alice.store);
    await expect(alice.correspondence.send(bob.signedIdentity, signature.link)).rejects.toMatchObject({
      kind: "later",
    });
    expect(await recordedIn(alice.store)).toEqual(before);
  });

  it("has gone once one mailbox takes it, though no transport given takes the transport object of another", async () => {
    const [alice, bob] = await Promise.all([person(1), person(2)]);
    const placeSchema = schema("Other transport", { place: string() });
    const other = mailboxBundle(new Uint8Array(32), encodeObject(placeSchema, { place: "elsewhere" }));
    await bob.intake.receive(other);
    const { inbox, pickup } = await openInbox(bob);
    const givenGrant = await bob.correspondence.grant(alice.signedIdentity, [other.link, inbox.mailbox]);
    await handOver(bob, alice, givenGrant.link);

    const signature = await writeNote(alice, "hi Bob");
    const deliveries = await alice.correspondence.send(bob.signedIdentity, signature.link);
    expect(deliveries.map(({ mailbox }) => mailbox)).toEqual([inbox.mailbox]);
    expect(await inbox.collect(pickup)).toHaveLength(1);
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
    await alice.store.write({ roots: [object.link], blobs: [object.bytes, ...note.blobs] });
    await (await alice.post.outbox(inbox.mailbox)).send(object.link);
    const { bundle } = await receive();

    expect(await bob.correspondence.messageAt(inbox.mailbox, bundle)).toBeUndefined();
  });

  it("is no message when its signature does not verify", async () => {
    const { alice, bob, inbox, receive } = await twoPeople();
    const signature = await writeNote(alice, "hi Bob");
    const other = encodeObject(note, { text: "not what was signed" });
    const forged = encodeObject(signatures.schema, {
      signedIdentity: new LinkValue(signature.signedIdentity.link),
      object: new LinkValue(other.link),
      signature: signature.signature,
    });
    await alice.store.write({ roots: [forged.link], blobs: [forged.bytes, other.bytes] });
    await (await alice.post.outbox(inbox.mailbox)).send(forged.link);
    const { bundle } = await receive();

    expect(await bob.correspondence.messageAt(inbox.mailbox, bundle)).toBeUndefined();
  });

  describe("signed by a key that its signer's root removes", () => {
    const formerAlice = async () => {
      const [alice, bob] = await Promise.all([personActingAs(formerAgent, listingIdentityVersion), person(2)]);
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

    it("is still a message once the removal comes in, as the message came in before", async () => {
      const { bob, inbox, receive } = await formerAlice();
      const { signature, bundle } = await receive();
      await seeIdentityVersion(bob, removalIdentityVersion);
      expect((await bob.correspondence.messageAt(inbox.mailbox, bundle))?.link).toBe(signature.link);
    });

    it("is no message when it came in after the removal, though it carries an identity version that lists the key", async () => {
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

  it("is still a message once the receiver records an object that links to the Mailbox Key of an inbox", async () => {
    const { alice, bob, inbox, receive } = await twoPeople();
    const signature = await writeNote(alice, "hi Bob");
    await alice.correspondence.send(bob.signedIdentity, signature.link);
    const { bundle } = await receive();

    const settingSchema = schema("Default inbox", { key: link() });
    const setting = encodeObject(settingSchema, { key: new LinkValue(inbox.key) });
    await bob.store.write({ roots: [setting.link], blobs: [setting.bytes, ...settingSchema.blobs] });
    await bob.store.record(writtenObjectsOf([setting.link], clock()));
    expect((await bob.correspondence.messageAt(inbox.mailbox, bundle))?.link).toBe(signature.link);
  });

  it("is still a message once the receiver records the Written Object it signs as their own", async () => {
    const { alice, bob, inbox, receive } = await twoPeople();
    const object = encodeObject(note, { text: "hi Bob" });
    const writtenObject = encodeObject(writtenObjectSchema, { object: new LinkValue(object.link), at: 5 });
    const signature = await alice.actor.sign(writtenObject);
    await alice.store.write({
      roots: [signature.link],
      blobs: [...signature.blobs, writtenObject.bytes, ...writtenObjectSchema.blobs, object.bytes, ...note.blobs],
    });
    await alice.correspondence.send(bob.signedIdentity, signature.link);
    const { bundle } = await receive();

    await bob.store.record(writtenObjectsOf([object.link], 5));
    expect(await recordedIn(bob.store)).toContain(object.link);
    expect((await bob.correspondence.messageAt(inbox.mailbox, bundle))?.link).toBe(signature.link);
  });

  it("is still a message once the receiver's root has removed the key that signed its grant, as the grant was recorded before the removal was", async () => {
    const backend = new MemoryBackend();
    const [formerBob, currentBob, alice] = await Promise.all([
      personActingAs(formerAgent, listingIdentityVersion, backend),
      personActingAs(currentAgent, removalIdentityVersion, backend),
      person(1),
    ]);
    const { inbox, pickup } = await grantInbox(formerBob, alice);
    const signature = await writeNote(alice, "hi Bob");
    await alice.correspondence.send(formerBob.signedIdentity, signature.link);
    const [delivery] = await inbox.collect(pickup);
    assert.exists(delivery);

    await recordIdentityVersion(currentBob, removalIdentityVersion);
    expect((await currentBob.correspondence.messageAt(inbox.mailbox, delivery.bundle))?.link).toBe(signature.link);
    const again = await personActingAs(currentAgent, removalIdentityVersion, backend);
    expect((await again.correspondence.messageAt(inbox.mailbox, delivery.bundle))?.link).toBe(signature.link);
  });

  it("is no message by a grant recorded after the removal of the key that signed it was, until a listed key signs one", async () => {
    const backend = new MemoryBackend();
    const [formerBob, currentBob, alice] = await Promise.all([
      // A device that takes in no identity version signs by the one it has, whatever the store it shares holds.
      personActingAs(formerAgent, listingIdentityVersion, backend, () =>
        signatures.actor(formerAgent, listingIdentityVersion, identityVersionInHand),
      ),
      personActingAs(currentAgent, removalIdentityVersion, backend),
      person(1),
    ]);
    await recordIdentityVersion(currentBob, removalIdentityVersion);
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
      personActingAs(signer, await publish(signer, { at: 0 }), backend),
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

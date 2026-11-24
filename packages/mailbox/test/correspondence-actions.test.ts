import { decodeBundle, encodeBundle } from "@estoc/bundle";
import { ed25519, identityKit, type SignedIdentityObject, signedIdentitySchema } from "@estoc/identity";
import { Keyring } from "@estoc/keyring";
import { encodeObject, type Link, LinkValue, readObject } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { Intake, MemoryBackend, perform, Store, writtenObjectSchema } from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import {
  grant,
  mailboxGrantSchema,
  mailboxSchema,
  outboundSchema,
  Post,
  type PostOptions,
  sendTo,
  UndeliveredMessage,
} from "../src/index.ts";
import { MemoryNetwork } from "./memory-network.ts";
import { recordedIn } from "./recorded.ts";

const { publish, secretKeys, signatures } = identityKit;
const note = schema("Note", { text: string() });
const hello = encodeObject(note, { text: "hello, Bob" });
const network = new MemoryNetwork();
const clock = () => 1000;

interface Person {
  readonly store: Store;
  readonly signedIdentity: SignedIdentityObject;
  readonly environment: PostOptions;
}

// Someone whose store records the Secret Key of their root and holds their identity.
async function person(): Promise<Person> {
  const store = new Store(new MemoryBackend());
  const keyring = new Keyring(store, secretKeys);
  const root = await keyring.signerFor((await keyring.generate(ed25519)).link);
  if (root === undefined) throw new Error("a keyring signs with a key it generated");
  const signedIdentity = await publish(root, { at: 0 });
  await store.write({ roots: [signedIdentity.link], blobs: signedIdentity.blobs });
  return { store, signedIdentity, environment: { transports: [network.transport], clock } };
}

// `from` hands what its store holds under `root` to `to` out of band, and `to` keeps it.
async function handOver(from: Person, to: Person, root: Link<unknown>) {
  const bundle = decodeBundle(encodeBundle(root, (await from.store.closure(root)).values()));
  await new Intake(to.store, to.environment.clock).receive(bundle);
}

// Two people who each hold the identity of the other.
async function acquaintances(): Promise<[Person, Person]> {
  const [alice, bob] = await Promise.all([person(), person()]);
  await handOver(alice, bob, alice.signedIdentity.link);
  await handOver(bob, alice, bob.signedIdentity.link);
  return [alice, bob];
}

async function openInbox({ store, environment }: Person) {
  const queue = network.queue();
  const inbox = await new Post(store, environment).openInbox(() => queue.transport);
  return { queue, inbox, pickup: queue.pickup(inbox.mailbox) };
}

// `from` opens an inbox and grants it to `to`, who is handed the grant.
async function grantInbox(from: Person, to: Person) {
  const openedInbox = await openInbox(from);
  const request = {
    actor: new LinkValue(from.signedIdentity.link),
    to: new LinkValue(to.signedIdentity.link),
    mailboxes: [new LinkValue(openedInbox.inbox.mailbox)],
  };
  const { result } = await perform(from.store, grant, request, { clock });
  await handOver(from, to, result.data.signature.link);
  return openedInbox;
}

describe("Grant", () => {
  it("gives a signature by the actor over a grant of the mailboxes to the identity, at the time of the clock given", async () => {
    const [alice, bob] = await acquaintances();
    const { inbox } = await openInbox(alice);
    const request = {
      actor: new LinkValue(alice.signedIdentity.link),
      to: new LinkValue(bob.signedIdentity.link),
      mailboxes: [new LinkValue(inbox.mailbox)],
    };

    const { result } = await perform(alice.store, grant, request, { clock });
    const signature = await signatures.read(result.data.signature.link, alice.store);
    expect(signature.signedIdentity.link).toBe(alice.signedIdentity.link);
    expect((await readObject(alice.store, signature.object, mailboxGrantSchema)).data).toEqual({
      to: new LinkValue(bob.signedIdentity.link),
      mailboxes: [new LinkValue(inbox.mailbox)],
      at: 1000,
    });
  });

  it("commits the signature it gives and the Written Object of it, and nothing else", async () => {
    const [alice, bob] = await acquaintances();
    const { inbox } = await openInbox(alice);
    const recordedBefore = await recordedIn(alice.store);

    const { result, commits } = await perform(
      alice.store,
      grant,
      {
        actor: new LinkValue(alice.signedIdentity.link),
        to: new LinkValue(bob.signedIdentity.link),
        mailboxes: [new LinkValue(inbox.mailbox)],
      },
      { clock },
    );
    const signature = result.data.signature.link;
    expect(commits).toHaveLength(2);
    expect(commits[0]).toBe(signature);
    const writtenObject = await readObject(alice.store, commits[1] as Link<unknown>, writtenObjectSchema);
    expect(writtenObject.data.object.link).toBe(signature);
    expect(await recordedIn(alice.store)).toEqual([...recordedBefore, signature]);
  });

  it("says that its actor and whom it is to take a Signed Identity, and its mailboxes a Mailbox", () => {
    expect(grant.targetSchemas).toEqual({
      actor: signedIdentitySchema,
      to: signedIdentitySchema,
      mailboxes: mailboxSchema,
    });
  });

  it("fails for an actor whose keys the store records no Secret Key of, and records nothing", async () => {
    const [alice, bob] = await acquaintances();
    const { inbox } = await openInbox(alice);
    const recordedBefore = await recordedIn(alice.store);

    const request = {
      actor: new LinkValue(bob.signedIdentity.link),
      to: new LinkValue(alice.signedIdentity.link),
      mailboxes: [new LinkValue(inbox.mailbox)],
    };
    await expect(perform(alice.store, grant, request, { clock })).rejects.toThrow(/no Secret Key/);
    expect(await recordedIn(alice.store)).toEqual(recordedBefore);
  });

  it("fails for a mailbox that is not a Mailbox, though the store holds it, and records nothing", async () => {
    const [alice, bob] = await acquaintances();
    await alice.store.write({ roots: [hello.link], blobs: [hello.bytes, ...note.blobs] });
    const recordedBefore = await recordedIn(alice.store);

    const request = grant.requestSchema.validate({
      actor: new LinkValue(alice.signedIdentity.link),
      to: new LinkValue(bob.signedIdentity.link),
      mailboxes: [new LinkValue(hello.link)],
    });
    await expect(perform(alice.store, grant, request, { clock })).rejects.toThrow(mailboxSchema.link);
    expect(await recordedIn(alice.store)).toEqual(recordedBefore);
  });
});

describe("Send To", () => {
  async function prepareSender() {
    const [alice, bob] = await acquaintances();
    await alice.store.write({ roots: [hello.link], blobs: [hello.bytes, ...note.blobs] });
    const request = {
      actor: new LinkValue(alice.signedIdentity.link),
      to: new LinkValue(bob.signedIdentity.link),
      root: new LinkValue(hello.link),
    };
    return { alice, bob, request };
  }

  it("sends the closure of the root to each mailbox the identity grants the actor, and gives the Outbound of each", async () => {
    const { alice, bob, request } = await prepareSender();
    const { inbox, pickup } = await grantInbox(bob, alice);

    const { result } = await perform(alice.store, sendTo, request, alice.environment);
    expect(result.data.outbounds).toHaveLength(1);
    const [outbound] = result.data.outbounds;
    assert.exists(outbound);
    expect((await readObject(alice.store, outbound.link, outboundSchema)).data).toEqual({
      bundle: new LinkValue(hello.link),
      mailbox: new LinkValue(inbox.mailbox),
      at: 1000,
    });
    const [delivery] = await inbox.collect(pickup);
    expect(delivery?.bundle).toBe(hello.link);
    expect(await bob.store.get(hello.link)).toEqual(hello.bytes);
  });

  it("commits the Outbounds it gives, and nothing else", async () => {
    const { alice, bob, request } = await prepareSender();
    await grantInbox(bob, alice);
    const recordedBefore = await recordedIn(alice.store);

    const { result, commits } = await perform(alice.store, sendTo, request, alice.environment);
    expect(commits).toEqual(result.data.outbounds.map(({ link }) => link));
    expect(await recordedIn(alice.store)).toEqual([...recordedBefore, ...commits]);
  });

  it("fails as gone when the identity grants the actor no mailbox, and records nothing", async () => {
    const { alice, request } = await prepareSender();
    const recordedBefore = await recordedIn(alice.store);

    const sending = perform(alice.store, sendTo, request, alice.environment);
    await expect(sending).rejects.toThrow(UndeliveredMessage);
    await expect(sending).rejects.toMatchObject({ kind: "gone" });
    expect(await recordedIn(alice.store)).toEqual(recordedBefore);
  });

  it("fails for an actor whose keys the store records no Secret Key of, and sends nothing", async () => {
    const { alice, bob, request } = await prepareSender();
    const { queue } = await grantInbox(bob, alice);
    const carol = await person();
    await handOver(carol, alice, carol.signedIdentity.link);

    const asCarol = { ...request, actor: new LinkValue(carol.signedIdentity.link) };
    await expect(perform(alice.store, sendTo, asCarol, alice.environment)).rejects.toThrow(/no Secret Key/);
    expect(queue.take()).toEqual([]);
  });

  it("says that its actor and whom it is to take a Signed Identity, and says no schema for its root", () => {
    expect(sendTo.targetSchemas).toEqual({ actor: signedIdentitySchema, to: signedIdentitySchema });
  });
});

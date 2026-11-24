import { ed25519, identityKit, type SignedIdentityObject, signedIdentitySchema } from "@estoc/identity";
import { Keyring } from "@estoc/keyring";
import { type MailboxData, mailboxKeySchema, mailboxSchema, Post } from "@estoc/mailbox";
import { httpTransport } from "@estoc/mailbox/http";
import { type EncodedObject, encodeObject, type Link, LinkValue, readObject, schemaOf } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { inboundSchema, perform, type Store, writtenObjectSchema } from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import {
  acceptAccountOffer,
  accountOfferSchema,
  acknowledgementSchema,
  collect,
  fetchService,
  mailboxOfferSchema,
  openedMailboxSchema,
  openInbox,
  serviceSchema,
} from "../src/index.ts";
import { memoryStore, serviceRoot, startService, terms } from "./fixtures.ts";

const { publish, secretKeys, signatures } = identityKit;
const accountOffer = new LinkValue(
  encodeObject(accountOfferSchema, { identity: new LinkValue(serviceRoot.link) }).link,
);
const mailboxOffer = new LinkValue(
  encodeObject(mailboxOfferSchema, { identity: new LinkValue(serviceRoot.link), ...terms }).link,
);
const noteSchema = schema("Note", { text: string() });
const note = encodeObject(noteSchema, { text: "hello, Alice" });
const laterNote = encodeObject(noteSchema, { text: "hello again, Alice" });
const clock = () => 9_000;

// Someone whose store records the Secret Key of their root and holds their identity.
async function person(): Promise<{ readonly store: Store; readonly signedIdentity: SignedIdentityObject }> {
  const store = memoryStore();
  const keyring = new Keyring(store, secretKeys);
  const root = await keyring.signerFor((await keyring.generate(ed25519)).link);
  if (root === undefined) throw new Error("a keyring signs with a key it generated");
  const signedIdentity = await publish(root, { at: 0 });
  await store.write({ roots: [signedIdentity.link], blobs: signedIdentity.blobs });
  return { store, signedIdentity };
}

/**
 * A service running, and someone whose store holds its Service. `service` is the Signed Identity of
 * the service, which the store holds and records no Secret Key of.
 */
async function clientAtService() {
  let postCount = 0;
  const run = await startService({}, (service, request) => {
    postCount += 1;
    return service.fetch(request);
  });
  const { store, signedIdentity } = await person();
  const { result } = await perform(store, fetchService, { origin: run.origin });
  const service = (await signatures.read(result.data.service.link, store)).signedIdentity;
  return {
    origin: run.origin,
    store,
    signedIdentity,
    actor: new LinkValue(signedIdentity.link),
    service: new LinkValue(service.link),
    postCount: () => postCount,
  };
}

async function clientWithAccount() {
  const client = await clientAtService();
  await perform(client.store, acceptAccountOffer, { actor: client.actor, offer: accountOffer });
  return client;
}

async function clientWithInbox() {
  const client = await clientWithAccount();
  const { result } = await perform(client.store, openInbox, { actor: client.actor, offer: mailboxOffer });
  return { ...client, mailbox: result.data.mailbox, mailboxKey: result.data.mailboxKey };
}

/** Sends `sentNote` to `mailbox`, which `store` holds, from a store of the sender's own. */
async function sendNote(store: Store, mailbox: Link<EncodedObject<MailboxData>>, sentNote = note) {
  const sender = memoryStore();
  await sender.write({
    roots: [mailbox, sentNote.link],
    blobs: [...(await store.closure(mailbox)).values(), sentNote.bytes, ...noteSchema.blobs],
  });
  await (await new Post(sender, { transports: [httpTransport] }).outbox(mailbox)).send(sentNote.link);
}

async function statementsIn(store: Store) {
  const statements: Link<unknown>[] = [];
  for await (const statement of store.records()) statements.push(statement);
  return statements;
}

function schemasAt(store: Store, links: readonly Link<unknown>[]) {
  return Promise.all(
    links.map(async (link) => {
      const bytes = await store.get(link);
      assert.exists(bytes);
      return schemaOf(bytes);
    }),
  );
}

async function inboundAt(store: Store, link: Link<unknown> | undefined) {
  assert.exists(link);
  return (await readObject(store, link, inboundSchema)).data;
}

describe("Fetch Service", () => {
  it("gives the signature over the Service at the origin", async () => {
    const { origin } = await startService();
    const { store } = await person();

    const { result } = await perform(store, fetchService, { origin });
    const signature = await signatures.read(result.data.service.link, store);
    expect(signature.signedIdentity.identity.identifier).toBe(serviceRoot.link);
    expect((await readObject(store, signature.object, serviceSchema)).data.origin).toBe(origin);
  });

  it("commits the bundle it took and the Inbound of it at the time of the clock given, and nothing else", async () => {
    const { origin } = await startService();
    const { store } = await person();
    const recordedBefore = await statementsIn(store);

    const { result, commits } = await perform(store, fetchService, { origin }, { clock });
    expect(commits).toHaveLength(2);
    const [bundle, inbound] = commits;
    expect(bundle).toBe(result.data.service.link);
    expect(await inboundAt(store, inbound)).toMatchObject({ bundle: { link: bundle }, at: 9_000 });
    expect(await statementsIn(store)).toEqual([...recordedBefore, inbound]);
  });
});

describe("Accept Account Offer", () => {
  it("gives the service's signature over an acknowledgement of the actor's acceptance of the offer", async () => {
    const { store, signedIdentity, actor } = await clientAtService();

    const { result } = await perform(store, acceptAccountOffer, { actor, offer: accountOffer });
    const acknowledgement = await signatures.read(result.data.acknowledgement.link, store);
    expect(acknowledgement.signedIdentity.identity.identifier).toBe(serviceRoot.link);
    const { acceptance } = (await readObject(store, acknowledgement.object, acknowledgementSchema)).data;
    const acceptanceSignature = await signatures.read(acceptance.link, store);
    expect(acceptanceSignature.object).toBe(accountOffer.link);
    expect(acceptanceSignature.signedIdentity.link).toBe(signedIdentity.link);
  });

  it("commits the acknowledgement it took and the Inbound of it at the time of the clock given, and nothing else", async () => {
    const { store, actor } = await clientAtService();
    const recordedBefore = await statementsIn(store);

    const { result, commits } = await perform(store, acceptAccountOffer, { actor, offer: accountOffer }, { clock });
    expect(commits).toHaveLength(2);
    const [bundle, inbound] = commits;
    expect(bundle).toBe(result.data.acknowledgement.link);
    expect(await inboundAt(store, inbound)).toMatchObject({ bundle: { link: bundle }, at: 9_000 });
    expect(await statementsIn(store)).toEqual([...recordedBefore, inbound]);
  });

  it("says that its actor takes a Signed Identity, and its offer an Account offer", () => {
    expect(acceptAccountOffer.targetSchemas).toEqual({ actor: signedIdentitySchema, offer: accountOfferSchema });
  });

  it("fails for an actor whose keys the store records no Secret Key of, and posts nothing to the service", async () => {
    const { store, service, postCount } = await clientAtService();
    const recordedBefore = await statementsIn(store);

    const request = { actor: service, offer: accountOffer };
    await expect(perform(store, acceptAccountOffer, request)).rejects.toThrow(/no Secret Key/);
    expect(postCount()).toBe(0);
    expect(await statementsIn(store)).toEqual(recordedBefore);
  });
});

describe("Open Inbox", () => {
  it("gives a mailbox at the service, and the Mailbox Key of it that the store records", async () => {
    const { origin, store, actor } = await clientWithAccount();

    const { result } = await perform(store, openInbox, { actor, offer: mailboxOffer });
    const { mailbox, mailboxKey } = result.data;
    const { transport } = (await readObject(store, mailbox.link, mailboxSchema)).data;
    const { url } = (await readObject(store, transport.link, httpTransport.schema)).data;
    expect(new URL(url).origin).toBe(origin);
    expect((await new Post(store, { transports: [] }).inbox(mailboxKey.link)).mailbox).toBe(mailbox.link);
  });

  it("commits the acknowledgement it took, the Inbound of it, the Opened mailbox, the Mailbox Key and the Written Object of the mailbox, and nothing else", async () => {
    const { store, actor } = await clientWithAccount();
    const recordedBefore = await statementsIn(store);

    const { result, commits } = await perform(store, openInbox, { actor, offer: mailboxOffer }, { clock });
    expect(await schemasAt(store, commits)).toEqual([
      signatures.schema.link,
      inboundSchema.link,
      openedMailboxSchema.link,
      mailboxKeySchema.link,
      writtenObjectSchema.link,
    ]);
    const [acknowledgement, inbound, , mailboxKey, writtenObject] = commits;
    expect(await inboundAt(store, inbound)).toMatchObject({ bundle: { link: acknowledgement }, at: 9_000 });
    expect(mailboxKey).toBe(result.data.mailboxKey.link);
    assert.exists(writtenObject);
    expect((await readObject(store, writtenObject, writtenObjectSchema)).data).toMatchObject({
      object: { link: result.data.mailbox.link },
      at: 9_000,
    });
    expect(await statementsIn(store)).toEqual([...recordedBefore, ...commits.slice(1)]);
  });

  it("says that its actor takes a Signed Identity, and its offer a Mailbox offer", () => {
    expect(openInbox.targetSchemas).toEqual({ actor: signedIdentitySchema, offer: mailboxOfferSchema });
  });

  it("fails for an actor whose keys the store records no Secret Key of, and posts nothing to the service", async () => {
    const { store, service, postCount } = await clientWithAccount();
    const postCountBefore = postCount();
    const recordedBefore = await statementsIn(store);

    const request = { actor: service, offer: mailboxOffer };
    await expect(perform(store, openInbox, request)).rejects.toThrow(/no Secret Key/);
    expect(postCount()).toBe(postCountBefore);
    expect(await statementsIn(store)).toEqual(recordedBefore);
  });
});

describe("Collect", () => {
  it("gives the Inbound of each bundle that waits at the mailbox, in the order they came, and none once they are collected", async () => {
    const { store, actor, mailbox, mailboxKey } = await clientWithInbox();
    const notes = [note, laterNote];
    for (const sentNote of notes) await sendNote(store, mailbox.link, sentNote);

    const { result } = await perform(store, collect, { actor, mailboxKey });
    const inbounds = await Promise.all(result.data.inbounds.map(({ link }) => inboundAt(store, link)));
    expect(inbounds.map(({ bundle, via }) => [bundle.link, via?.link])).toEqual(
      notes.map(({ link }) => [link, mailbox.link]),
    );
    for (const { link, bytes } of notes) expect(await store.get(link)).toEqual(bytes);

    const again = await perform(store, collect, { actor, mailboxKey });
    expect(again.result.data.inbounds).toEqual([]);
    expect(again.commits).toEqual([]);
  });

  it("commits each bundle it took and the Inbound of it at the time of the clock given, and nothing else", async () => {
    const { store, actor, mailbox, mailboxKey } = await clientWithInbox();
    await sendNote(store, mailbox.link);
    const recordedBefore = await statementsIn(store);

    const { result, commits } = await perform(store, collect, { actor, mailboxKey }, { clock });
    expect(commits).toEqual([note.link, result.data.inbounds[0]?.link]);
    expect((await inboundAt(store, commits[1])).at).toBe(9_000);
    expect(await statementsIn(store)).toEqual([...recordedBefore, commits[1]]);
  });

  it("says that its actor takes a Signed Identity, and its mailbox key a Mailbox Key", () => {
    expect(collect.targetSchemas).toEqual({ actor: signedIdentitySchema, mailboxKey: mailboxKeySchema });
  });

  it("fails for an actor whose keys the store records no Secret Key of, and posts nothing to the service", async () => {
    const { store, service, mailbox, mailboxKey, postCount } = await clientWithInbox();
    await sendNote(store, mailbox.link);
    const postCountBefore = postCount();

    await expect(perform(store, collect, { actor: service, mailboxKey })).rejects.toThrow(/no Secret Key/);
    expect(postCount()).toBe(postCountBefore);
  });
});

import {
  ed25519,
  eip191,
  loadIdentity,
  noVersions,
  type Scheme,
  type Signature,
  SoftwareSigner,
} from "@estoc/identity";
import {
  decodeObject,
  encodeObject,
  encodeSchema,
  type Fields,
  type Json,
  type JsonLink,
  type JsonObject,
  json,
  type Link,
  linkSchema,
  readObject,
  type Schema,
  schemaOf,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { type Bundle, readBundle, writeBundle } from "../src/index.ts";

// Applications that hand each other bundles. Each pins the schema of its
// root and walks from it by link; the package only checks that the blobs are
// the ones their names say, and the signatures are verified where they are read.

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const schemaFor = <F extends Fields<Json> = Fields<Json>>(
  title: string,
  properties: JsonObject,
): Promise<Schema<Json, F>> =>
  encodeSchema(
    {
      $schema: DRAFT,
      title,
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
    defaultValidator,
  );
const handOver = (root: { readonly bytes: Uint8Array }, blobs: Uint8Array[]) => readBundle(writeBundle(root, blobs));
const { keys, identities, signatures, publish, delegate } = await loadIdentity(defaultValidator);
const actorOf = async (by: SoftwareSigner) => signatures.actor(by, await publish(by));
const sign = async (object: { readonly link: Link<unknown> }, by: SoftwareSigner) => (await actorOf(by)).sign(object);

const card = await schemaFor<{ readonly mailbox: JsonLink<Signature>; readonly name: JsonLink<Signature> }>("Card", {
  mailbox: linkSchema,
  name: linkSchema,
});
const contact = await schemaFor<{ readonly displayName: JsonLink<Signature>; readonly inbox: JsonLink<Signature> }>(
  "Contact",
  {
    displayName: linkSchema,
    inbox: linkSchema,
  },
);
const mailbox = await schemaFor<{ readonly url: string }>("Mailbox", { url: { type: "string", format: "uri" } });
const name = await schemaFor<{ readonly name: string }>("Name", { name: { type: "string" } });

// A card lists the signatures of the one identity it is for: over a mailbox
// that reaches it, and over the name it goes by. Another application writes
// the same to a schema of its own, a contact, which reads as a card too.
type Card = { readonly mailbox: Link<Signature>; readonly name: Link<Signature> };

function cardOf(root: Uint8Array): Card {
  switch (schemaOf(root, json)) {
    case card.link: {
      const { data } = decodeObject(root, card);
      return { mailbox: data.mailbox.$link, name: data.name.$link };
    }
    case contact.link: {
      const { data } = decodeObject(root, contact);
      return { mailbox: data.inbox.$link, name: data.displayName.$link };
    }
    default:
      throw new Error("the root is not a card");
  }
}

async function readCard(bundle: Bundle) {
  const listed = cardOf(bundle.root);
  const reachedAt = await signatures.read(listed.mailbox, bundle, noVersions);
  const goesBy = await signatures.read(listed.name, bundle, noVersions);
  if (reachedAt.signedIdentity.identity.root.link !== goesBy.signedIdentity.identity.root.link)
    throw new Error("a card is signed by the one identity it is for");
  return {
    identity: reachedAt.signedIdentity.identity,
    mailbox: (await readObject(bundle, reachedAt.object, mailbox)).data,
    name: (await readObject(bundle, goesBy.object, name)).data.name,
  };
}

describe("a card", () => {
  const alice = signer(ed25519, 1);
  const inbox = encodeObject(mailbox, { url: "https://mail.example/alice" });
  const called = encodeObject(name, { name: "Alice" });
  const signed = Promise.all([sign(inbox, alice), sign(called, alice)]);

  it("reads as the mailbox and the name that its identity signed", async () => {
    const [byMailbox, byName] = await signed;
    const root = encodeObject(card, { mailbox: { $link: byMailbox.link }, name: { $link: byName.link } });
    const bundle = handOver(root, [
      byMailbox.bytes,
      inbox.bytes,
      byName.bytes,
      called.bytes,
      ...byName.signedIdentity.blobs,
    ]);
    expect(await readCard(bundle)).toEqual({
      identity: identities.encode(alice.key),
      mailbox: { url: "https://mail.example/alice" },
      name: "Alice",
    });
  });

  it("written by another application to its own schema reads as the same card", async () => {
    const [byMailbox, byName] = await signed;
    const root = encodeObject(contact, { displayName: { $link: byName.link }, inbox: { $link: byMailbox.link } });
    const bundle = handOver(root, [
      byMailbox.bytes,
      inbox.bytes,
      byName.bytes,
      called.bytes,
      ...byName.signedIdentity.blobs,
    ]);
    expect(await readCard(bundle)).toEqual({
      identity: identities.encode(alice.key),
      mailbox: { url: "https://mail.example/alice" },
      name: "Alice",
    });
  });

  it("with its name signed by someone else reads as no one's card", async () => {
    const [byMailbox] = await signed;
    const byOther = await sign(called, signer(eip191, 2));
    const root = encodeObject(card, { mailbox: { $link: byMailbox.link }, name: { $link: byOther.link } });
    const bundle = handOver(root, [
      byMailbox.bytes,
      inbox.bytes,
      byOther.bytes,
      called.bytes,
      ...byMailbox.signedIdentity.blobs,
      ...byOther.signedIdentity.blobs,
    ]);
    await expect(readCard(bundle)).rejects.toThrow(/signed by the one identity/);
  });
});

const chat = await schemaFor<{ readonly text: string }>("Chat message", { text: { type: "string" } });

async function readMessage(bundle: Bundle) {
  const read = await signatures.read(bundle.link, bundle, noVersions);
  return { from: read.signedIdentity.identity, message: (await readObject(bundle, read.object, chat)).data };
}

describe("a chat message", () => {
  it("reads through the signature at its root as the message from its signer", async () => {
    const alice = signer(ed25519, 1);
    const message = encodeObject(chat, { text: "See you at noon." });
    const signature = await sign(message, alice);
    const bundle = handOver(signature, [message.bytes, ...signature.signedIdentity.blobs]);
    expect(await readMessage(bundle)).toEqual({
      from: identities.encode(alice.key),
      message: { text: "See you at noon." },
    });
  });

  it("signed by a key that a wallet lists as an agent reads as the message from the wallet", async () => {
    const wallet = signer(eip191, 1);
    const device = signer(ed25519, 2);
    const message = encodeObject(chat, { text: "See you at noon." });
    const signature = await signatures.actor(device, await delegate(wallet, [device.key])).sign(message);
    const bundle = handOver(signature, [message.bytes, ...signature.signedIdentity.blobs]);
    expect(await readMessage(bundle)).toEqual({
      from: signature.signedIdentity.identity,
      message: { text: "See you at noon." },
    });
    expect(signature.signedIdentity.identity.root.link).toBe(keys.encode(wallet.key).link);
  });
});

import { loadAuthorizations } from "@estoc/authorization";
import { sameIdentity, SoftwareSigner, type Scheme } from "@estoc/identity";
import {
  decodeObject,
  encodeObject,
  encodeSchema,
  json,
  linkSchema,
  loadSignatures,
  readObject,
  schemaOf,
  type EncodedObject,
  type Fields,
  type Json,
  type JsonLink,
  type JsonObject,
  type Link,
  type Schema,
  type Signature,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { readBundle, writeBundle, type Bundle } from "../src/index.ts";

// Applications that hand each other bundles. Each pins the schema of its
// root and walks from it by link; the package only checks that the blobs are
// the ones their names say, and the signatures are verified where they are read.

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const schemaFor = <F extends Fields<Json> = Fields<Json>>(title: string, properties: JsonObject): Promise<Schema<Json, F>> =>
  encodeSchema(
    { $schema: DRAFT, title, type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    defaultValidator,
  );
const handOver = (root: { readonly bytes: Uint8Array }, blobs: Uint8Array[]) => readBundle(writeBundle(root, blobs));
const signatures = await loadSignatures(defaultValidator);
const { identities } = signatures;

const card = await schemaFor<{ readonly mailbox: JsonLink<Signature>; readonly name: JsonLink<Signature> }>("Card", {
  mailbox: linkSchema,
  name: linkSchema,
});
const contact = await schemaFor<{ readonly displayName: JsonLink<Signature>; readonly inbox: JsonLink<Signature> }>("Contact", {
  displayName: linkSchema,
  inbox: linkSchema,
});
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
  const reachedAt = await signatures.read(listed.mailbox, bundle);
  const goesBy = await signatures.read(listed.name, bundle);
  if (!sameIdentity(reachedAt.identity, goesBy.identity)) throw new Error("a card is signed by the one identity it is for");
  return {
    identity: reachedAt.identity,
    mailbox: (await readObject(bundle, reachedAt.object, mailbox)).data,
    name: (await readObject(bundle, goesBy.object, name)).data.name,
  };
}

describe("a card", () => {
  const alice = signer("ed25519", 1);
  const inbox = encodeObject(mailbox, { url: "https://mail.example/alice" });
  const called = encodeObject(name, { name: "Alice" });
  const signed = Promise.all([signatures.sign(inbox, alice), signatures.sign(called, alice)]);

  it("reads as the mailbox and the name that its identity signed", async () => {
    const [byMailbox, byName] = await signed;
    const root = encodeObject(card, { mailbox: { $link: byMailbox.link }, name: { $link: byName.link } });
    const bundle = handOver(root, [byMailbox.bytes, inbox.bytes, byName.bytes, called.bytes, byName.identity.bytes]);
    expect(await readCard(bundle)).toEqual({ identity: identities.encode(alice.identity), mailbox: { url: "https://mail.example/alice" }, name: "Alice" });
  });

  it("written by another application to its own schema reads as the same card", async () => {
    const [byMailbox, byName] = await signed;
    const root = encodeObject(contact, { displayName: { $link: byName.link }, inbox: { $link: byMailbox.link } });
    const bundle = handOver(root, [byMailbox.bytes, inbox.bytes, byName.bytes, called.bytes, byName.identity.bytes]);
    expect(await readCard(bundle)).toEqual({ identity: identities.encode(alice.identity), mailbox: { url: "https://mail.example/alice" }, name: "Alice" });
  });

  it("with its name signed by someone else reads as no one's card", async () => {
    const [byMailbox] = await signed;
    const byOther = await signatures.sign(called, signer("eip191", 2));
    const root = encodeObject(card, { mailbox: { $link: byMailbox.link }, name: { $link: byOther.link } });
    const bundle = handOver(root, [byMailbox.bytes, inbox.bytes, byOther.bytes, called.bytes, byMailbox.identity.bytes, byOther.identity.bytes]);
    await expect(readCard(bundle)).rejects.toThrow(/signed by the one identity/);
  });
});

const chat = await schemaFor<{ readonly text: string }>("Chat message", { text: { type: "string" } });

async function readMessage(bundle: Bundle) {
  const read = await signatures.read(bundle.link, bundle);
  return { from: read.identity, message: (await readObject(bundle, read.object, chat)).data };
}

describe("a chat message", () => {
  it("reads through the signature at its root as the message from its signer", async () => {
    const alice = signer("ed25519", 1);
    const message = encodeObject(chat, { text: "See you at noon." });
    const signature = await signatures.sign(message, alice);
    const bundle = handOver(signature, [message.bytes, signature.identity.bytes]);
    expect(await readMessage(bundle)).toEqual({ from: identities.encode(alice.identity), message: { text: "See you at noon." } });
  });
});

const authorizations = await loadAuthorizations(defaultValidator);
const standingEnvelope = await schemaFor<{ readonly message: JsonLink<EncodedObject<Json>>; readonly signature: JsonLink<Signature> }>(
  "Stood behind",
  { message: linkSchema, signature: linkSchema },
);

// A chat message sent from a device travels as an envelope naming the message
// and the signature by which someone stands behind it, directly or through
// agents. Reading the standing takes the message as well as the signature, so
// the envelope names both. The bundle is the blobs that the reading follows
// that signature into.
async function readSent(bundle: Bundle, now: Date) {
  const { message, signature } = decodeObject(bundle.root, standingEnvelope).data;
  const { principal, agents } = await authorizations.readStanding(message.$link, signature.$link, bundle, now);
  return { from: principal, through: agents, message: (await readObject(bundle, message.$link, chat)).data };
}

describe("a chat message sent through a device key", () => {
  it("reads as the message from the wallet that authorized the key", async () => {
    const wallet = signer("eip191", 1);
    const deviceKey = signer("ed25519", 2);
    const message = encodeObject(chat, { text: "See you at noon." });
    const grant = await authorizations.authorize(deviceKey.identity, wallet);
    const { signature, blobs } = await authorizations.createActor(deviceKey, [grant]).sign(message.link);
    const root = encodeObject(standingEnvelope, { message: { $link: message.link }, signature: { $link: signature.link } });
    expect(await readSent(handOver(root, [message.bytes, signature.bytes, ...blobs]), new Date())).toEqual({
      from: identities.encode(wallet.identity),
      through: [identities.encode(deviceKey.identity)],
      message: { text: "See you at noon." },
    });
  });
});

import { loadAuthorizations } from "@estoc/authorization";
import { sameIdentity, SoftwareSigner, type Scheme } from "@estoc/identity";
import {
  decodeObject,
  encodeIdentity,
  encodeObject,
  encodeSchema,
  reading,
  sign,
  signatures,
  View,
  type EncodedObject,
  type JsonObject,
  type Link,
  type Signature,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { readBundle, writeBundle, type Bundle } from "../src/index.ts";

// Applications that hand each other bundles. Each pins the schema of its
// root and walks from it by link; the package only checks that the blobs are
// the ones their names say, and the signatures are verified where they are read.

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const LINK = { $ref: "https://estoc.dev/schema/link" };
const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const schemaFor = (title: string, properties: JsonObject) =>
  encodeSchema(
    { $schema: DRAFT, title, type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    defaultValidator,
  );
const handOver = (root: { readonly bytes: Uint8Array }, blobs: Uint8Array[]) => readBundle(writeBundle(root, blobs));

function blobAt(bundle: Bundle, link: Link<unknown>): Uint8Array {
  const bytes = bundle.get(link);
  if (bytes === undefined) throw new Error(`the bundle does not carry ${link}`);
  return bytes;
}

const card = await schemaFor("Card", { mailbox: LINK, name: LINK });
const contact = await schemaFor("Contact", { displayName: LINK, inbox: LINK });
const mailbox = await schemaFor("Mailbox", { url: { type: "string", format: "uri" } });
const name = await encodeSchema({ $schema: DRAFT, title: "Name", type: "string" }, defaultValidator);

// A card lists the signatures of the one identity it is for: over a mailbox
// that reaches it, and over the name it goes by. Another application writes
// the same to a schema of its own, a contact, which reads as a card too.
type Card = { readonly mailbox: Link<Signature>; readonly name: Link<Signature> };

const cards = new View<Card>([
  reading(card, (data) => data as Card),
  reading(contact, (data) => {
    const { displayName, inbox } = data as { displayName: Link<Signature>; inbox: Link<Signature> };
    return { mailbox: inbox, name: displayName };
  }),
]);

function readCard(bundle: Bundle) {
  const listed = cards.decode(bundle.root);
  const reachedAt = signatures.decode(blobAt(bundle, listed.mailbox), bundle);
  const goesBy = signatures.decode(blobAt(bundle, listed.name), bundle);
  if (!sameIdentity(reachedAt.identity, goesBy.identity)) throw new Error("a card is signed by the one identity it is for");
  return {
    identity: reachedAt.identity,
    mailbox: decodeObject(blobAt(bundle, reachedAt.object), mailbox).data,
    name: decodeObject(blobAt(bundle, goesBy.object), name).data,
  };
}

describe("a card", () => {
  const alice = signer("ed25519", 1);
  const inbox = encodeObject(mailbox, { url: "https://mail.example/alice" });
  const called = encodeObject(name, "Alice");
  const signed = Promise.all([sign(inbox, alice), sign(called, alice)]);

  it("reads as the mailbox and the name that its identity signed", async () => {
    const [byMailbox, byName] = await signed;
    const root = encodeObject(card, { mailbox: byMailbox.link, name: byName.link });
    const bundle = handOver(root, [byMailbox.bytes, inbox.bytes, byName.bytes, called.bytes, byName.identity.bytes]);
    expect(readCard(bundle)).toEqual({ identity: encodeIdentity(alice.identity), mailbox: { url: "https://mail.example/alice" }, name: "Alice" });
  });

  it("written by another application to its own schema reads as the same card", async () => {
    const [byMailbox, byName] = await signed;
    const root = encodeObject(contact, { displayName: byName.link, inbox: byMailbox.link });
    const bundle = handOver(root, [byMailbox.bytes, inbox.bytes, byName.bytes, called.bytes, byName.identity.bytes]);
    expect(readCard(bundle)).toEqual({ identity: encodeIdentity(alice.identity), mailbox: { url: "https://mail.example/alice" }, name: "Alice" });
  });

  it("with its name signed by someone else reads as no one's card", async () => {
    const [byMailbox] = await signed;
    const byOther = await sign(called, signer("eip191", 2));
    const root = encodeObject(card, { mailbox: byMailbox.link, name: byOther.link });
    const bundle = handOver(root, [byMailbox.bytes, inbox.bytes, byOther.bytes, called.bytes, byMailbox.identity.bytes, byOther.identity.bytes]);
    expect(() => readCard(bundle)).toThrow(/signed by the one identity/);
  });
});

const chat = await schemaFor("Chat message", { text: { type: "string" } });

function readMessage(bundle: Bundle) {
  const read = signatures.decode(bundle.root, bundle);
  return { from: read.identity, message: decodeObject(blobAt(bundle, read.object), chat).data };
}

describe("a chat message", () => {
  it("reads through the signature at its root as the message from its signer", async () => {
    const alice = signer("ed25519", 1);
    const message = encodeObject(chat, { text: "See you at noon." });
    const signature = await sign(message, alice);
    const bundle = handOver(signature, [message.bytes, signature.identity.bytes]);
    expect(readMessage(bundle)).toEqual({ from: encodeIdentity(alice.identity), message: { text: "See you at noon." } });
  });
});

const authorizations = await loadAuthorizations(defaultValidator);
const standingEnvelope = await schemaFor("Stood behind", { message: LINK, signature: LINK });

// A chat message sent from a device travels as an envelope naming the message
// and the signature by which someone stands behind it, directly or through
// agents. Reading the standing takes the message as well as the signature, so
// the envelope names both. The bundle is the blobs that the reading follows
// that signature into.
function readSent(bundle: Bundle, now: Date) {
  const named = decodeObject(bundle.root, standingEnvelope).data as { message: Link<EncodedObject>; signature: Link<Signature> };
  const { identity, agents } = authorizations.readStanding(named.message, blobAt(bundle, named.signature), bundle, now);
  return { from: identity, through: agents, message: decodeObject(blobAt(bundle, named.message), chat).data };
}

describe("a chat message sent through a device key", () => {
  it("reads as the message from the wallet that authorized the key", async () => {
    const wallet = signer("eip191", 1);
    const deviceKey = signer("ed25519", 2);
    const message = encodeObject(chat, { text: "See you at noon." });
    const grant = await authorizations.authorize(deviceKey.identity, wallet);
    const proxy = await authorizations.proxy(message.link, [grant], deviceKey);
    const root = encodeObject(standingEnvelope, { message: message.link, signature: proxy.signature.link });
    const identities = [grant.signature.identity.bytes, grant.object.agent.bytes];
    const blobs = [message.bytes, proxy.object.bytes, proxy.signature.bytes, grant.object.bytes, grant.signature.bytes, ...identities];
    expect(readSent(handOver(root, blobs), new Date())).toEqual({
      from: encodeIdentity(wallet.identity),
      through: [encodeIdentity(deviceKey.identity)],
      message: { text: "See you at noon." },
    });
  });
});

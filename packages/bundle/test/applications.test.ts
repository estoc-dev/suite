import {
  type CurveScheme,
  ed25519,
  eip191,
  loadIdentity,
  noIdentityVersions,
  type Signature,
  SoftwareSigner,
} from "@estoc/identity";
import { decodeObject, encodeObject, type Link, LinkValue, readObject, schemaOf } from "@estoc/object";
import { link, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { type Bundle, decodeBundle, encodeBundle } from "../src/index.ts";

// Applications that hand each other bundles. Each pins the schema of its
// root and walks from it by link; the package only checks that the file is
// a root and its blobs, and the signatures are verified where they are read.

const signer = (scheme: CurveScheme, fill: number) =>
  SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const handOver = (root: { readonly bytes: Uint8Array }, blobs: Uint8Array[]) => decodeBundle(encodeBundle(root, blobs));
const { keys, identities, signatures, publish } = loadIdentity([ed25519, eip191]);
const actorOf = async (by: SoftwareSigner) => signatures.actor(by, await publish(by, { at: 0 }));
const sign = async (object: { readonly link: Link<unknown> }, by: SoftwareSigner) => (await actorOf(by)).sign(object);

const card = schema("Card", { mailbox: link<Signature>(), name: link<Signature>() });
const contact = schema("Contact", { displayName: link<Signature>(), inbox: link<Signature>() });
const mailbox = schema("Mailbox", { url: string() });
const name = schema("Name", { name: string() });

// A card lists the signatures of the one identity it is for: over a mailbox
// that reaches it, and over the name it goes by. Another application writes
// the same to a schema of its own, a contact, which reads as a card too.
type Card = { readonly mailbox: Link<Signature>; readonly name: Link<Signature> };

function cardOf(root: Uint8Array): Card {
  switch (schemaOf(root)) {
    case card.link: {
      const { data } = decodeObject(root, card);
      return { mailbox: data.mailbox.link, name: data.name.link };
    }
    case contact.link: {
      const { data } = decodeObject(root, contact);
      return { mailbox: data.inbox.link, name: data.displayName.link };
    }
    default:
      throw new Error("the root is not a card");
  }
}

async function readCard(bundle: Bundle) {
  const cardLinks = cardOf(bundle.root);
  const mailboxSignature = await signatures.read(cardLinks.mailbox, bundle, noIdentityVersions);
  const nameSignature = await signatures.read(cardLinks.name, bundle, noIdentityVersions);
  if (mailboxSignature.signedIdentity.identity.identifier !== nameSignature.signedIdentity.identity.identifier)
    throw new Error("a card is signed by the one identity it is for");
  return {
    identity: mailboxSignature.signedIdentity.identity,
    mailbox: (await readObject(bundle, mailboxSignature.object, mailbox)).data,
    name: (await readObject(bundle, nameSignature.object, name)).data.name,
  };
}

describe("a card", () => {
  const alice = signer(ed25519, 1);
  const inbox = encodeObject(mailbox, { url: "https://mail.example/alice" });
  const nameObject = encodeObject(name, { name: "Alice" });
  const cardSignatures = Promise.all([sign(inbox, alice), sign(nameObject, alice)]);

  it("reads as the mailbox and the name that its identity signed", async () => {
    const [byMailbox, byName] = await cardSignatures;
    const root = encodeObject(card, { mailbox: new LinkValue(byMailbox.link), name: new LinkValue(byName.link) });
    const bundle = handOver(root, [
      byMailbox.bytes,
      inbox.bytes,
      byName.bytes,
      nameObject.bytes,
      ...byName.signedIdentity.blobs,
    ]);
    expect(await readCard(bundle)).toEqual({
      identity: identities.encode(alice.key, { at: 0 }),
      mailbox: { url: "https://mail.example/alice" },
      name: "Alice",
    });
  });

  it("written by another application to its own schema reads as the same card", async () => {
    const [byMailbox, byName] = await cardSignatures;
    const root = encodeObject(contact, {
      displayName: new LinkValue(byName.link),
      inbox: new LinkValue(byMailbox.link),
    });
    const bundle = handOver(root, [
      byMailbox.bytes,
      inbox.bytes,
      byName.bytes,
      nameObject.bytes,
      ...byName.signedIdentity.blobs,
    ]);
    expect(await readCard(bundle)).toEqual({
      identity: identities.encode(alice.key, { at: 0 }),
      mailbox: { url: "https://mail.example/alice" },
      name: "Alice",
    });
  });

  it("with its name signed by someone else reads as no one's card", async () => {
    const [byMailbox] = await cardSignatures;
    const byOther = await sign(nameObject, signer(eip191, 2));
    const root = encodeObject(card, { mailbox: new LinkValue(byMailbox.link), name: new LinkValue(byOther.link) });
    const bundle = handOver(root, [
      byMailbox.bytes,
      inbox.bytes,
      byOther.bytes,
      nameObject.bytes,
      ...byMailbox.signedIdentity.blobs,
      ...byOther.signedIdentity.blobs,
    ]);
    await expect(readCard(bundle)).rejects.toThrow(/signed by the one identity/);
  });
});

const chat = schema("Chat message", { text: string() });

async function readMessage(bundle: Bundle) {
  const signature = await signatures.read(bundle.link, bundle, noIdentityVersions);
  return { from: signature.signedIdentity.identity, message: (await readObject(bundle, signature.object, chat)).data };
}

describe("a chat message", () => {
  it("reads through the signature at its root as the message from its signer", async () => {
    const alice = signer(ed25519, 1);
    const message = encodeObject(chat, { text: "See you at noon." });
    const signature = await sign(message, alice);
    const bundle = handOver(signature, [message.bytes, ...signature.signedIdentity.blobs]);
    expect(await readMessage(bundle)).toEqual({
      from: identities.encode(alice.key, { at: 0 }),
      message: { text: "See you at noon." },
    });
  });

  it("signed by a key that a wallet lists as an agent reads as the message from the wallet", async () => {
    const wallet = signer(eip191, 1);
    const device = signer(ed25519, 2);
    const message = encodeObject(chat, { text: "See you at noon." });
    const signature = await signatures.actor(device, await publish(wallet, { agents: [device.key] })).sign(message);
    const bundle = handOver(signature, [message.bytes, ...signature.signedIdentity.blobs]);
    expect(await readMessage(bundle)).toEqual({
      from: signature.signedIdentity.identity,
      message: { text: "See you at noon." },
    });
    expect(signature.signedIdentity.identity.root.link).toBe(keys.encode(wallet.key).link);
  });
});

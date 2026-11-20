import { decodeObject, encodeObject, type Link, LinkValue, readObject, schemaOf } from "@estoc/object";
import { link, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { type Bundle, decodeBundle, encodeBundle } from "../src/index.ts";

// Applications that hand each other bundles. Each pins the schema of its
// root and walks from it by link; the package only checks that the file is
// a root and its blobs.

const handOver = (root: Link<unknown>, blobs: Uint8Array[]) => decodeBundle(encodeBundle(root, blobs));

const card = schema("Card", { mailbox: link(), name: link() });
const contact = schema("Contact", { displayName: link(), inbox: link() });
const mailbox = schema("Mailbox", { url: string() });
const name = schema("Name", { name: string() });

// A card links to a mailbox that reaches someone and to the name they go by.
// Another application writes the same to a schema of its own, a contact,
// which reads as a card too.
type Card = { readonly mailbox: Link<unknown>; readonly name: Link<unknown> };

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
  return {
    mailbox: (await readObject(bundle, cardLinks.mailbox, mailbox)).data,
    name: (await readObject(bundle, cardLinks.name, name)).data.name,
  };
}

describe("a card", () => {
  const inbox = encodeObject(mailbox, { url: "https://mail.example/alice" });
  const nameObject = encodeObject(name, { name: "Alice" });
  const alicesCard = { mailbox: { url: "https://mail.example/alice" }, name: "Alice" };

  it("reads as the mailbox and the name it links to", async () => {
    const root = encodeObject(card, { mailbox: new LinkValue(inbox.link), name: new LinkValue(nameObject.link) });
    expect(await readCard(handOver(root.link, [root.bytes, inbox.bytes, nameObject.bytes]))).toEqual(alicesCard);
  });

  it("written by another application to its own schema reads as the same card", async () => {
    const root = encodeObject(contact, {
      displayName: new LinkValue(nameObject.link),
      inbox: new LinkValue(inbox.link),
    });
    expect(await readCard(handOver(root.link, [root.bytes, inbox.bytes, nameObject.bytes]))).toEqual(alicesCard);
  });

  it("is not read from a bundle whose root is of another schema", async () => {
    await expect(readCard(handOver(inbox.link, [inbox.bytes]))).rejects.toThrow(/not a card/);
  });
});

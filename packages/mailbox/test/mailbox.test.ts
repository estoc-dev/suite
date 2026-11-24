import type { Bundle } from "@estoc/bundle";
import { ed25519, identityKit, loadIdentity, SoftwareSigner } from "@estoc/identity";
import { encodeObject, type Link, LinkValue, linkOf } from "@estoc/object";
import { link, schema, secretSchema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { MailboxKey, mailboxAt, mailboxSchema, UndeliveredMessage } from "../src/index.ts";
import { mailboxBundle } from "./mailbox-bundle.ts";
import { MemoryNetwork } from "./memory-network.ts";

const { identities, signatures, publish } = identityKit;
const identityVersionInHand = async <T>(inHand: T) => inHand;

const network = new MemoryNetwork();
const options = { transports: [network.transport] };
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));
const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const note = schema("Note", { text: string() });
const otherTransportSchema = schema("Other transport", { place: string() });
const otherTransport = encodeObject(otherTransportSchema, { place: "elsewhere" });
const hello = encodeObject(note, { text: "hello, Bob" });
const signature = await signatures.actor(alice, await publish(alice, { at: 0 }), identityVersionInHand).sign(hello);
const mailboxIn = (bundle: Bundle) => mailboxAt(bundle.link, bundle, options);

describe("a mailbox", () => {
  it("carries a bundle to the queue it names, sealed so that its key opens it", async () => {
    const queue = network.queue();
    // Bob hands the mailbox out on its own, in a QR code say.
    await (await mailboxIn(queue.mailbox(bob.publicKey))).send(signature.link, [...signature.blobs, hello.bytes]);
    const bundle = await bob.open(queue.takeOne());
    expect(bundle.link).toBe(signature.link);
    expect(bundle.get(hello.link)).toEqual(hello.bytes);
    // Bob reads with a kit of his own, which has verified nothing that Alice signed, so who signed
    // is read from the blobs that the mailbox carried.
    const bobsSignatures = loadIdentity([ed25519]).signatures;
    expect((await bobsSignatures.read(bundle.link, bundle)).signedIdentity.identity).toEqual(
      identities.encode(alice.key, { at: 0 }),
    );
  });

  it("seals bundles whose files have the same sizes to the same length, whatever the files hold", async () => {
    const queue = network.queue();
    const mailbox = await mailboxIn(queue.mailbox(bob.publicKey));
    await mailbox.send(hello.link, [hello.bytes, new Uint8Array(4096)]);
    const repeating = queue.takeOne();
    await mailbox.send(hello.link, [hello.bytes, crypto.getRandomValues(new Uint8Array(4096))]);
    const random = queue.takeOne();
    expect(repeating.length).toBe(random.length);
  });

  it("refuses to send a root that is not an object, and sends nothing", async () => {
    const queue = network.queue();
    const mailbox = await mailboxIn(queue.mailbox(bob.publicKey));
    const text = new TextEncoder().encode("hello, Bob");
    await expect(mailbox.send(linkOf(text), [text])).rejects.toThrow(/the root of a bundle is an object/);
    expect(queue.take()).toEqual([]);
  });

  it("refuses to send blobs that hold a Secret, and sends nothing", async () => {
    const queue = network.queue();
    const mailbox = await mailboxIn(queue.mailbox(bob.publicKey));
    const keySchema = schema("Key", { secret: link() });
    const secret = encodeObject(secretSchema, { bytes: new Uint8Array(32) });
    const key = encodeObject(keySchema, { secret: new LinkValue(secret.link) });
    await expect(mailbox.send(key.link, [key.bytes, secret.bytes])).rejects.toThrow(
      `${secret.link} is a Secret, which is not sent`,
    );
    expect(queue.take()).toEqual([]);
  });

  it("carries each blob as it was when given, where a `Buffer` gives them all in turn", async () => {
    const queue = network.queue();
    const [first, second] = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6)];
    const attachments = schema("Attachments", { first: link(), second: link() });
    const root = encodeObject(attachments, {
      first: new LinkValue(linkOf(first)),
      second: new LinkValue(linkOf(second)),
    });
    function* blobsInOneBuffer() {
      const buffer = Buffer.alloc(root.bytes.length);
      for (const blob of [root.bytes, first, second]) {
        buffer.set(blob);
        yield buffer.subarray(0, blob.length);
      }
    }
    await (await mailboxIn(queue.mailbox(bob.publicKey))).send(root.link, blobsInOneBuffer());
    const bundle = await bob.open(queue.takeOne());
    expect(bundle.get(linkOf(first))).toEqual(first);
    expect(bundle.get(linkOf(second))).toEqual(second);
  });
});

const readerOf = (...blobs: Uint8Array[]) => {
  const byLink = new Map<Link<unknown>, Uint8Array>(blobs.map((blob) => [linkOf(blob), blob]));
  return { get: (link: Link<unknown>) => byLink.get(link) };
};

describe("a mailbox at a link", () => {
  const transport = network.queue().transport;

  it("is refused when the reader does not hold it", async () => {
    const { link } = mailboxBundle(bob.publicKey, transport);
    await expect(mailboxAt(link, readerOf(), options)).rejects.toThrow(`no blob is given for ${link}`);
  });

  it("is refused when it is not a Mailbox", async () => {
    await expect(mailboxAt(hello.link as Link<never>, readerOf(hello.bytes), options)).rejects.toThrow(/is written to/);
  });

  it.each([31, 33])("is refused when its key is %i bytes", async (length) => {
    const mailbox = encodeObject(mailboxSchema, {
      key: new Uint8Array(length),
      transport: new LinkValue(transport.link),
    });
    await expect(mailboxAt(mailbox.link, readerOf(mailbox.bytes, transport.bytes), options)).rejects.toThrow(
      /a mailbox's key is an x25519 public key/,
    );
  });

  it("is refused when the reader does not hold its transport object", async () => {
    const mailbox = encodeObject(mailboxSchema, { key: bob.publicKey, transport: new LinkValue(transport.link) });
    await expect(mailboxAt(mailbox.link, readerOf(mailbox.bytes), options)).rejects.toThrow(
      `no blob is given for ${transport.link}`,
    );
  });

  it.each<[string, () => Bundle]>([
    ["no transport given takes its transport object", () => mailboxBundle(bob.publicKey, otherTransport)],
    ["its transport has no route to it", () => new MemoryNetwork().queue().mailbox(bob.publicKey)],
  ])("is refused as undelivered to a mailbox that is gone when %s", async (_, mailbox) => {
    const making = mailboxIn(mailbox());
    await expect(making).rejects.toThrow(UndeliveredMessage);
    await expect(making).rejects.toMatchObject({ kind: "gone" });
  });
});

import { ed25519, loadIdentity, noIdentityVersions, SoftwareSigner } from "@estoc/identity";
import { encodeObject, objectFormat, type Schema, type Value, type ValueMap } from "@estoc/object";
import { bytes, integer, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import { MailboxKey, mailboxFrom, type Transport, UndeliveredMessage } from "../src/index.ts";
import { MemoryNetwork } from "./memory-network.ts";

const { identities, signatures, publish } = loadIdentity([ed25519]);

const network = new MemoryNetwork();
const options = { transports: [network.transport] };
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));
const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const note = schema("Note", { text: string() });
const hello = encodeObject(note, { text: "hello, Bob" });
const signature = await signatures.actor(alice, await publish(alice, { at: 0 })).sign(hello);

describe("a mailbox", () => {
  it("carries a bundle to the queue it names, sealed so that its key opens it", async () => {
    const queue = network.queue();
    // Bob hands the mailbox out as bytes, in a QR code say.
    const mailboxBytes = queue.mailbox(bob.publicKey).bytes;
    await (await mailboxFrom(mailboxBytes, options)).send(signature, [hello.bytes, ...signature.signedIdentity.blobs]);
    const bundle = await bob.open(queue.takeOne());
    expect(bundle.link).toBe(signature.link);
    expect(bundle.get(hello.link)).toEqual(hello.bytes);
    expect((await signatures.read(bundle.link, bundle, noIdentityVersions)).signedIdentity.identity).toEqual(
      identities.encode(alice.key, { at: 0 }),
    );
  });

  it("seals bundles whose files have the same sizes to the same length, whatever the files hold", async () => {
    const queue = network.queue();
    const mailbox = await mailboxFrom(queue.mailbox(bob.publicKey).bytes, options);
    await mailbox.send(hello, [new Uint8Array(4096)]);
    const repeating = queue.takeOne();
    await mailbox.send(hello, [crypto.getRandomValues(new Uint8Array(4096))]);
    const random = queue.takeOne();
    expect(repeating.length).toBe(random.length);
  });

  it("refuses to send a root that is not an object, and sends nothing", async () => {
    const queue = network.queue();
    const mailbox = await mailboxFrom(queue.mailbox(bob.publicKey).bytes, options);
    await expect(mailbox.send({ bytes: new TextEncoder().encode("hello, Bob") }, [])).rejects.toThrow(
      /the root of a bundle is an object/,
    );
    expect(queue.take()).toEqual([]);
  });

  it("rejects a send to a queue that its network does not have, as undelivered to a mailbox that is gone", async () => {
    const elsewhere = new MemoryNetwork();
    const mailbox = await mailboxFrom(elsewhere.queue().mailbox(bob.publicKey).bytes, options);
    const sending = mailbox.send(hello, []);
    await expect(sending).rejects.toThrow(UndeliveredMessage);
    await expect(sending).rejects.toMatchObject({ kind: "gone" });
  });
});

// Mailboxes of transports that wrote their schemas by hand, each with a key that is not one.
const looseMailboxes: [string, Schema<Value>, ValueMap][] = [
  ["has no key", schema("Loose mailbox", { name: string() }), { name: "q" }],
  ["has a key in hex", schema("Loose mailbox", { key: string() }), { key: "ab".repeat(32) }],
  ["has a key of 31 bytes", schema("Loose mailbox", { key: bytes() }), { key: new Uint8Array(31) }],
  ["has a key of 33 bytes", schema("Loose mailbox", { key: bytes() }), { key: new Uint8Array(33) }],
  ["has a key that is a number", schema("Loose mailbox", { key: integer() }), { key: 1 }],
];

describe("a mailbox from bytes", () => {
  it("is refused when the bytes are not an object", async () => {
    await expect(mailboxFrom(Uint8Array.of(0xa0), options)).rejects.toThrow(/is an object/);
  });

  it("is refused when the bytes are a schema, which no transport's mailboxes are written to", async () => {
    // @ts-expect-error: refused at compile time too
    await expect(mailboxFrom(note.bytes, options)).rejects.toThrow(/no transport takes/);
  });

  it("is refused when no transport given takes its schema", async () => {
    await expect(mailboxFrom(hello.bytes, options)).rejects.toThrow(/no transport takes/);
    const mailbox = network.queue().mailbox(bob.publicKey).bytes;
    await expect(mailboxFrom(mailbox, { transports: [] })).rejects.toThrow(/no transport takes/);
  });

  it.each(looseMailboxes)(
    "is refused when it %s, where its transport's schema let it through",
    async (_, loose, data) => {
      const transport: Transport = { schema: loose, deliver: async () => undefined };
      const mailbox = objectFormat.encode(objectFormat.object(loose.validate(data), loose.link));
      await expect(mailboxFrom(mailbox, { transports: [transport] })).rejects.toThrow(/a mailbox/);
    },
  );
});

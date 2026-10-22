import { SoftwareSigner } from "@estoc/identity";
import { encodeObject, encodeSchema, loadSignatures, type Json } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { MailboxKey, mailboxFrom, type Transport } from "../src/index.ts";
import { MemoryNetwork } from "./memory-network.ts";

const signatures = await loadSignatures(defaultValidator);
const { identities } = signatures;

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

const network = await MemoryNetwork.create(defaultValidator);
const options = { transports: [network.transport] };
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));
const alice = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const note = await encodeSchema({ $schema: DRAFT, type: "string" }, defaultValidator);
const hello = encodeObject(note, "hello, Bob");
const signature = await signatures.sign(hello, alice);

describe("a mailbox", () => {
  it("carries a bundle to the queue it names, sealed so that its key opens it", async () => {
    const queue = network.queue();
    // Bob hands the mailbox out as bytes, in a QR code say.
    const handed = queue.mailbox(bob.publicKey).bytes;
    await (await mailboxFrom(handed, options)).send(signature, [hello.bytes, signature.identity.bytes]);
    const [sealed, ...more] = queue.take();
    expect(more).toEqual([]);
    const bundle = await bob.open(sealed!);
    expect(bundle.link).toBe(signature.link);
    expect(bundle.get(hello.link)).toEqual(hello.bytes);
    expect(signatures.decode(bundle.root, bundle).identity).toEqual(identities.encode(alice.identity));
  });

  it("seals bundles whose files have the same sizes to the same length, whatever the files hold", async () => {
    const queue = network.queue();
    const mailbox = await mailboxFrom(queue.mailbox(bob.publicKey).bytes, options);
    await mailbox.send(hello, [new Uint8Array(4096)]);
    await mailbox.send(hello, [crypto.getRandomValues(new Uint8Array(4096))]);
    const [repeating, random] = queue.take();
    expect(repeating!.length).toBe(random!.length);
  });

  it("refuses to send a root that is not an object, and sends nothing", async () => {
    const queue = network.queue();
    const mailbox = await mailboxFrom(queue.mailbox(bob.publicKey).bytes, options);
    await expect(mailbox.send({ bytes: new TextEncoder().encode("hello, Bob") }, [])).rejects.toThrow(/not an object/);
    expect(queue.take()).toEqual([]);
  });

  it("rejects a send to a queue that its network does not have", async () => {
    const elsewhere = await MemoryNetwork.create(defaultValidator);
    const mailbox = await mailboxFrom(elsewhere.queue().mailbox(bob.publicKey).bytes, options);
    await expect(mailbox.send(hello, [])).rejects.toThrow(/no queue is named/);
  });
});

describe("a mailbox from bytes", () => {
  it("is refused when the bytes are not an object", async () => {
    // @ts-expect-error: refused at compile time too
    await expect(mailboxFrom(note.bytes, options)).rejects.toThrow(/fields data and schema/);
  });

  it("is refused when no transport given takes its schema", async () => {
    await expect(mailboxFrom(hello.bytes, options)).rejects.toThrow(/no transport takes/);
    const mailbox = network.queue().mailbox(bob.publicKey).bytes;
    await expect(mailboxFrom(mailbox, { transports: [] })).rejects.toThrow(/no transport takes/);
  });

  it.each<[string, Json]>([
    ["is not a JSON object", "a mailbox"],
    ["has no key", { name: "q" }],
    ["has a key in uppercase hex", { key: "AB".repeat(32) }],
    ["has a key of 31 bytes", { key: "ab".repeat(31) }],
    ["has a key that is a number", { key: 1 }],
  ])("is refused when it %s, where its transport's schema let it through", async (_, data) => {
    const loose = await encodeSchema({ $schema: DRAFT, title: "Loose mailbox" }, defaultValidator);
    const transport: Transport = { schema: loose, deliver: async () => undefined };
    await expect(mailboxFrom(encodeObject(loose, data).bytes, { transports: [transport] })).rejects.toThrow(/a mailbox/);
  });
});

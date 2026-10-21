import { SoftwareSigner } from "@estoc/identity";
import { encodeObject, encodeSchema, sign, signatures, type Json } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { MailboxKey, mailboxFrom, type Transport } from "../src/index.ts";
import { formatBlind } from "./format-blind.ts";
import { MemoryNetwork } from "./memory-network.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const now = new Date("2026-10-20T12:00:00Z");

const network = await MemoryNetwork.create(defaultValidator);
const options = { transports: [network.transport], clock: () => now };
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));
const alice = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const note = await encodeSchema({ $schema: DRAFT, type: "string" }, defaultValidator);
const hello = encodeObject(note, "hello, Bob");
const message = { entry: (await sign(hello, alice)).bytes, blobs: [hello.bytes] };

describe("a mailbox", () => {
  it("carries a message to the queue it names, sealed so that its key opens it", async () => {
    const queue = network.queue();
    // Bob hands the mailbox out as bytes, in a QR code say.
    const handed = queue.mailbox(bob.publicKey).bytes;
    await (await mailboxFrom(handed, options)).send(message);
    const [sealed, ...more] = queue.take();
    expect(more).toEqual([]);
    const opened = await bob.open(sealed!);
    expect(opened).toEqual(message);
    expect(signatures.decode(opened.entry).identity).toEqual(alice.identity);
  });

  it("sends while the clock at each send is before its end", async () => {
    let at = now;
    const queue = network.queue();
    const mailbox = await mailboxFrom(queue.mailbox(bob.publicKey, "2026-10-20T12:00:01Z").bytes, {
      transports: [network.transport],
      clock: () => at,
    });
    await mailbox.send(message);
    at = new Date("2026-10-20T12:00:00.999Z");
    await mailbox.send(message);
    at = new Date("2026-10-20T12:00:01Z");
    await expect(mailbox.send(message)).rejects.toThrow(/ended at 2026-10-20T12:00:01Z/);
    expect(queue.take()).toHaveLength(2);
  });

  it("rejects a send to a queue that its network does not have", async () => {
    const elsewhere = await MemoryNetwork.create(defaultValidator);
    const mailbox = await mailboxFrom(elsewhere.queue().mailbox(bob.publicKey).bytes, options);
    await expect(mailbox.send(message)).rejects.toThrow(/no queue is named/);
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
    await expect(mailboxFrom(mailbox, { transports: [], clock: () => now })).rejects.toThrow(/no transport takes/);
  });

  it("is refused once it has ended by the sender's clock, comparing instants and not text", async () => {
    const at = (until: string) => mailboxFrom(network.queue().mailbox(bob.publicKey, until).bytes, options);
    await expect(at("2026-10-20T12:00:00.001Z")).resolves.toBeDefined();
    await expect(at("2026-10-20T20:00:01+08:00")).resolves.toBeDefined();
    await expect(at("2026-10-20T12:00:00Z")).rejects.toThrow(/ended at/);
    await expect(at("2026-10-20T19:59:59+08:00")).rejects.toThrow(/ended at/);
  });

  it("is refused when its end does not read as an instant, where the validator let it through", async () => {
    const blind = await MemoryNetwork.create(formatBlind);
    const at = (until: string) =>
      mailboxFrom(blind.queue().mailbox(bob.publicKey, until).bytes, { transports: [blind.transport], clock: () => now });
    await expect(at("2027-01-01T00:00:00Z")).resolves.toBeDefined();
    await expect(at("2027-01-01")).rejects.toThrow(RangeError);
  });

  it.each<[string, Json]>([
    ["is not a JSON object", "a mailbox"],
    ["has no key", { name: "q" }],
    ["has a key in uppercase hex", { key: "AB".repeat(32) }],
    ["has a key of 31 bytes", { key: "ab".repeat(31) }],
    ["has a key that is a number", { key: 1 }],
    ["has an end that is a number", { key: "ab".repeat(32), until: 1 }],
  ])("is refused when it %s, where its transport's schema let it through", async (_, data) => {
    const loose = await encodeSchema({ $schema: DRAFT, title: "Loose mailbox" }, defaultValidator);
    const transport: Transport = { schema: loose, deliver: async () => undefined };
    await expect(mailboxFrom(encodeObject(loose, data).bytes, { transports: [transport] })).rejects.toThrow(/a mailbox/);
  });
});

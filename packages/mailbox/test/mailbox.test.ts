import { SoftwareSigner } from "@estoc/identity";
import { decodeSignature, encodeObject, encodeSchema, sign, type EncodedObject, type Json } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, MailboxKey, readMailbox, type Message, type Transport } from "../src/index.ts";
import { formatBlind } from "./format-blind.ts";
import { MemoryNetwork } from "./memory-network.ts";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const now = new Date("2026-10-20T12:00:00Z");
const handOut = (mailbox: EncodedObject): Message => ({ entry: mailbox.bytes, blobs: [] });

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
    const handed = encodeMessage(handOut(queue.mailbox(bob.publicKey)));
    await (await readMailbox(decodeMessage(handed), options)).send(message);
    const [sealed, ...more] = queue.take();
    expect(more).toEqual([]);
    const opened = await bob.open(sealed!);
    expect(opened).toEqual(message);
    expect(decodeSignature(opened.entry).identity).toEqual(alice.identity);
  });

  it("sends while the clock at each send is before its end", async () => {
    let at = now;
    const queue = network.queue();
    const mailbox = await readMailbox(handOut(queue.mailbox(bob.publicKey, "2026-10-20T12:00:01Z")), {
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
    const mailbox = await readMailbox(handOut(elsewhere.queue().mailbox(bob.publicKey)), options);
    await expect(mailbox.send(message)).rejects.toThrow(/no queue is named/);
  });
});

describe("reading a mailbox", () => {
  it("refuses an entry that is not an object", async () => {
    await expect(readMailbox(message, options)).rejects.toThrow(/fields data and schema/);
  });

  it("refuses an object of a schema that no transport given takes", async () => {
    await expect(readMailbox(handOut(hello), options)).rejects.toThrow(/no transport takes/);
    const mailbox = handOut(network.queue().mailbox(bob.publicKey));
    await expect(readMailbox(mailbox, { transports: [], clock: () => now })).rejects.toThrow(/no transport takes/);
  });

  it("refuses a mailbox that has ended by the reader's clock, comparing instants and not text", async () => {
    const at = (until: string) => readMailbox(handOut(network.queue().mailbox(bob.publicKey, until)), options);
    await expect(at("2026-10-20T12:00:00.001Z")).resolves.toBeDefined();
    await expect(at("2026-10-20T20:00:01+08:00")).resolves.toBeDefined();
    await expect(at("2026-10-20T12:00:00Z")).rejects.toThrow(/ended at/);
    await expect(at("2026-10-20T19:59:59+08:00")).rejects.toThrow(/ended at/);
  });

  it("refuses an end that does not read as an instant, where the validator let it through", async () => {
    const blind = await MemoryNetwork.create(formatBlind);
    const at = (until: string) =>
      readMailbox(handOut(blind.queue().mailbox(bob.publicKey, until)), { transports: [blind.transport], clock: () => now });
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
  ])("refuses a mailbox that %s, where its transport's schema let it through", async (_, data) => {
    const loose = await encodeSchema({ $schema: DRAFT, title: "Loose mailbox" }, defaultValidator);
    const transport: Transport = { schema: loose, deliver: async () => undefined };
    await expect(readMailbox(handOut(encodeObject(loose, data)), { transports: [transport] })).rejects.toThrow(/a mailbox/);
  });
});

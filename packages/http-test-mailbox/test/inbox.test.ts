import type { Bundle } from "@estoc/bundle";
import { SoftwareSigner } from "@estoc/identity";
import { MailboxKey, mailboxFrom } from "@estoc/mailbox";
import { loadHttpTransport } from "@estoc/mailbox/http";
import { encodeObject, encodeSchema, loadSignatures } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { hex } from "@scure/base";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TestInbox, TestMailboxServer } from "../src/index.ts";

const signatures = await loadSignatures(defaultValidator);
const http = await loadHttpTransport(defaultValidator);

const dir = await mkdtemp(join(tmpdir(), "http-test-mailbox-"));
const server = await TestMailboxServer.listen({ dir });
afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true });
});

const alice = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(1));
const note = await encodeSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }, defaultValidator);
const hello = encodeObject(note, "hello, Bob");
const signature = await signatures.sign(hello, alice);
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));
const carol = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(3));

let queues = 0;
const newMailbox = (key: MailboxKey, url = `${server.url}/bob-${++queues}`) =>
  encodeObject(http.schema, { key: hex.encode(key.publicKey), url });
const sendTo = async (mailbox: { readonly bytes: Uint8Array }) => mailboxFrom(mailbox.bytes, { transports: [http] });
const keepNothing = async () => undefined;

describe("a test inbox", () => {
  it("takes a message sent to its mailbox, opened, and deletes it once kept", async () => {
    const mailbox = newMailbox(bob);
    await (await sendTo(mailbox)).send(signature, [hello.bytes, signature.identity.bytes]);
    const inbox = TestInbox.from(mailbox.bytes, bob, http);
    const kept: Bundle[] = [];
    const taken = await inbox.take(async (bundle) => void kept.push(bundle));
    expect(kept.map(({ link }) => link)).toEqual([signature.link]);
    expect(taken).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{64}$/), bundle: kept[0] }]);
    expect(signatures.decode(kept[0]!.root, kept[0]!).object).toBe(hello.link);
    expect(await inbox.take(keepNothing)).toEqual([]);
  });

  it("leaves a message waiting when keeping it fails, and takes it the next time", async () => {
    const mailbox = newMailbox(bob);
    await (await sendTo(mailbox)).send(hello, []);
    const inbox = TestInbox.from(mailbox.bytes, bob, http);
    const full = async () => Promise.reject(new Error("the disk is full"));
    await expect(inbox.take(full)).rejects.toThrow(/the disk is full/);
    const [taken, ...more] = await inbox.take(keepNothing);
    expect(more).toEqual([]);
    expect(taken !== undefined && "bundle" in taken && taken.bundle.link).toBe(hello.link);
  });

  it("deletes a message that does not open with its key, and gives it back as refused", async () => {
    const mailbox = newMailbox(bob);
    const url = (mailbox.data as { readonly url: string }).url;
    await (await sendTo(newMailbox(carol, url))).send(hello, []);
    const inbox = TestInbox.from(mailbox.bytes, bob, http);
    const kept: Bundle[] = [];
    const taken = await inbox.take(async (bundle) => void kept.push(bundle));
    expect(kept).toEqual([]);
    expect(taken).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{64}$/), refused: expect.any(Error) }]);
    expect(await inbox.take(keepNothing)).toEqual([]);
  });

  it("is refused for a mailbox whose key is another's", () => {
    expect(() => TestInbox.from(newMailbox(bob).bytes, carol, http)).toThrow(/another key/);
  });
});

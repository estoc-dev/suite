import { encodeObject, type Link, LinkValue, readObject } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { Intake, MemoryBackend, perform, Store } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { MailboxKey, mailboxSchema, outboundSchema, send, UndeliveredMessage } from "../src/index.ts";
import { MemoryNetwork } from "./memory-network.ts";
import { recordedIn } from "./recorded.ts";

const note = schema("Note", { text: string() });
const hello = encodeObject(note, { text: "hello, Bob" });
const bob = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(2));

// A store that holds `hello` and the mailbox of a new queue for Bob's key, handed over out of band.
async function prepareSender() {
  const network = new MemoryNetwork();
  const store = new Store(new MemoryBackend());
  const queue = network.queue();
  const mailbox = queue.mailbox(bob.publicKey);
  await new Intake(store).receive(mailbox);
  await store.write({ roots: [hello.link], blobs: [hello.bytes, ...note.blobs] });
  const environment = { transports: [network.transport], clock: () => 1000 };
  return { store, queue, mailbox, environment };
}

describe("Send", () => {
  it("sends the closure of the root to the mailbox, and gives the Outbound of it at the time of the clock given", async () => {
    const { store, queue, mailbox, environment } = await prepareSender();
    const request = { root: new LinkValue(hello.link), mailbox: new LinkValue(mailbox.link) };

    const { result } = await perform(store, send, request, environment);
    expect((await readObject(store, result.data.outbound.link, outboundSchema)).data).toEqual({
      bundle: new LinkValue(hello.link),
      mailbox: new LinkValue(mailbox.link),
      at: 1000,
    });
    const bundle = await bob.open(queue.takeOne());
    expect(bundle.link).toBe(hello.link);
    expect(new Set(bundle.blobs())).toEqual(new Set((await store.closure(hello.link)).values()));
  });

  it("commits the Outbound it gives, and nothing else", async () => {
    const { store, mailbox, environment } = await prepareSender();
    const recordedBefore = await recordedIn(store);

    const { result, commits } = await perform(
      store,
      send,
      { root: new LinkValue(hello.link), mailbox: new LinkValue(mailbox.link) },
      environment,
    );
    expect(commits).toEqual([result.data.outbound.link]);
    expect(await recordedIn(store)).toEqual([...recordedBefore, ...commits]);
  });

  it("fails as the transport does when the mailbox turns back what it sends, and records nothing", async () => {
    const { store, queue, mailbox, environment } = await prepareSender();
    queue.turnBack("gone");
    const recordedBefore = await recordedIn(store);

    const sending = perform(
      store,
      send,
      { root: new LinkValue(hello.link), mailbox: new LinkValue(mailbox.link) },
      environment,
    );
    await expect(sending).rejects.toThrow(UndeliveredMessage);
    await expect(sending).rejects.toMatchObject({ kind: "gone" });
    expect(await recordedIn(store)).toEqual(recordedBefore);
  });

  it("fails for a mailbox link to what is not a Mailbox, and sends and records nothing", async () => {
    const { store, queue, environment } = await prepareSender();
    const recordedBefore = await recordedIn(store);

    // A request that code did not write, such as one typed in a form, comes with this link whatever
    // the type says.
    const request = { root: new LinkValue(hello.link), mailbox: new LinkValue(hello.link as Link<never>) };
    await expect(perform(store, send, request, environment)).rejects.toThrow(
      `the object is written to ${note.link}, not to ${mailboxSchema.link}`,
    );
    expect(queue.take()).toEqual([]);
    expect(await recordedIn(store)).toEqual(recordedBefore);
  });
});

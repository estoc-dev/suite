import { type Link, linkOf } from "@estoc/object";
import { describe, expect, it, onTestFinished } from "vitest";
import { type Mailboxes, MemoryMailboxes, type OpenMailbox } from "../src/mailboxes.ts";
import { SqliteMailboxes } from "../src/sqlite.ts";
import { makeTemporaryPath, terms } from "./fixtures.ts";

const linkNamed = (name: string) => linkOf(new TextEncoder().encode(name)) as Link<never>;
const ciphertextOf = (fill: number, length = 4) => new Uint8Array(length).fill(fill);
const limits = { at: 1, since: 0, quota: 100 };

const mailboxRequested = (name: string): OpenMailbox => ({
  request: linkNamed(`request ${name}`),
  acknowledgement: linkNamed(`acknowledgement ${name}`),
  root: linkNamed("alice"),
  sendId: `send ${name}`,
  pickupId: `pickup ${name}`,
  terms,
});

async function openInTemporaryFolder(): Promise<Mailboxes> {
  const mailboxes = new SqliteMailboxes(await makeTemporaryPath());
  onTestFinished(() => mailboxes.close());
  return mailboxes;
}

async function readQueue(mailboxes: Mailboxes, sendId: string, since = 0): Promise<Uint8Array[]> {
  const ciphertexts: Uint8Array[] = [];
  for await (const ciphertext of mailboxes.queue(sendId, since)) ciphertexts.push(ciphertext);
  return ciphertexts;
}

describe.each([
  { name: "a MemoryMailboxes", open: async (): Promise<Mailboxes> => new MemoryMailboxes() },
  { name: "a SqliteMailboxes", open: openInTemporaryFolder },
])("$name", ({ open }) => {
  it("keeps the mailbox opened first for a request, and finds it by the request and by either of its ids", async () => {
    const mailboxes = await open();
    const first = mailboxRequested("one");
    const again = { ...mailboxRequested("two"), request: first.request };
    expect(await Promise.all([mailboxes.open(first), mailboxes.open(again)])).toEqual([first, first]);
    expect(await mailboxes.mailboxOpenedBy(first.request)).toEqual(first);
    expect(await mailboxes.mailboxNamed(first.sendId)).toEqual(first);
    expect(await mailboxes.mailboxNamed(first.pickupId)).toEqual(first);
    expect(await mailboxes.mailboxNamed(again.sendId)).toBeUndefined();
    expect(await mailboxes.mailboxOpenedBy(mailboxRequested("three").request)).toBeUndefined();
  });

  it("keeps a ciphertext that waits already once, and takes none that would bring what waits over the quota", async () => {
    const mailboxes = await open();
    const { sendId } = await mailboxes.open(mailboxRequested("one"));
    const limitsOfEightBytes = { ...limits, quota: 8 };
    const [a, b] = [ciphertextOf(1), ciphertextOf(2)];
    for (const ciphertext of [a, a, b]) expect(await mailboxes.put(sendId, ciphertext, limitsOfEightBytes)).toBe(true);
    expect(await mailboxes.put(sendId, ciphertextOf(3, 1), limitsOfEightBytes)).toBe(false);
    expect(await mailboxes.put(sendId, a, limitsOfEightBytes)).toBe(true);
    expect(await readQueue(mailboxes, sendId)).toEqual([a, b]);
  });

  it("gives what waits the earliest first, and lets what was received before since wait no more", async () => {
    const mailboxes = await open();
    const { sendId } = await mailboxes.open(mailboxRequested("one"));
    const ciphertexts = [5, 3, 1, 4, 2].map((fill) => ciphertextOf(fill));
    for (const [at, ciphertext] of ciphertexts.entries()) await mailboxes.put(sendId, ciphertext, { ...limits, at });
    expect(await readQueue(mailboxes, sendId, 2)).toEqual(ciphertexts.slice(2));
    expect(await readQueue(mailboxes, sendId, 0)).toEqual(ciphertexts.slice(2));
  });

  it("does not count what was received before since toward the quota", async () => {
    const mailboxes = await open();
    const { sendId } = await mailboxes.open(mailboxRequested("one"));
    const [a, b] = [ciphertextOf(1, 8), ciphertextOf(2, 8)];
    expect(await mailboxes.put(sendId, a, { at: 1, since: 0, quota: 8 })).toBe(true);
    expect(await mailboxes.put(sendId, b, { at: 2, since: 1, quota: 8 })).toBe(false);
    expect(await mailboxes.put(sendId, b, { at: 2, since: 2, quota: 8 })).toBe(true);
    expect(await readQueue(mailboxes, sendId)).toEqual([b]);
  });

  it("lets what drop names wait no more at that mailbox alone, until it is put again, as the latest", async () => {
    const mailboxes = await open();
    const one = await mailboxes.open(mailboxRequested("one"));
    const two = await mailboxes.open(mailboxRequested("two"));
    const [a, b] = [ciphertextOf(1), ciphertextOf(2)];
    for (const { sendId } of [one, two])
      for (const ciphertext of [a, b]) await mailboxes.put(sendId, ciphertext, limits);
    await mailboxes.drop(one.sendId, [linkOf(a)]);
    expect(await readQueue(mailboxes, one.sendId)).toEqual([b]);
    expect(await readQueue(mailboxes, two.sendId)).toEqual([a, b]);
    await mailboxes.put(one.sendId, a, limits);
    expect(await readQueue(mailboxes, one.sendId)).toEqual([b, a]);
  });
});

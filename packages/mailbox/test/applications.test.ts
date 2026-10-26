import type { Bundle } from "@estoc/bundle";
import { type Scheme, SoftwareSigner } from "@estoc/identity";
import {
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Fields,
  type IdentityObject,
  type Json,
  type JsonLink,
  linkOf,
  linkSchema,
  loadSignatures,
  readObject,
  type Schema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { type Mailbox, MailboxKey, mailboxFrom } from "../src/index.ts";
import { type Faults, MemoryNetwork } from "./memory-network.ts";

// Applications that send signed objects through mailboxes, each as a bundle
// whose root is the signature over it. A message names no sender, and
// anyone can pass on what someone else signed: a receiver reads who stands
// behind what it holds, not who sent it. An application that needs to know
// whom a message was meant for writes that into the object it signs.

const signatures = await loadSignatures(defaultValidator);
const { identities } = signatures;

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const sendSigned = async (mailbox: Mailbox, object: EncodedObject<Json>, by: SoftwareSigner) => {
  const signature = await signatures.sign(object, by);
  await mailbox.send(signature, [object.bytes, signature.identity.bytes]);
  return signature;
};

async function readSigned<F extends Fields<Json>>(bundle: Bundle, schema: Schema<Json, F>) {
  const signature = await signatures.read(bundle.link, bundle);
  return { signature, identity: signature.identity, object: await readObject(bundle, signature.object, schema) };
}

async function receiver(network: MemoryNetwork, fill: number) {
  const key = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(fill));
  const queue = network.queue();
  return { mailbox: queue.mailbox(key.publicKey).bytes, take: () => Promise.all(queue.take().map((sealed) => key.open(sealed))) };
}

const chat: Schema<Json, { readonly text: string; readonly to?: JsonLink<IdentityObject> }> = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Chat",
    type: "object",
    properties: { to: linkSchema, text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  defaultValidator,
);

// What a chat shows of a line: who wrote it and, when the line names whom it
// is for by the link of an identity object, whether that is the reader.
async function readChat(bundle: Bundle, reader: IdentityObject) {
  const { identity, object } = await readSigned(bundle, chat);
  const { text, to } = object.data;
  return { author: identity, text, forReader: to === undefined ? undefined : to.$link === reader.link };
}

describe("a chat line", () => {
  const alice = signer("ed25519", 1);
  const bob = signer("ed25519", 2);
  const carol = signer("ed25519", 3);

  const passOn = async (line: EncodedObject<Json>) => {
    const network = await MemoryNetwork.create(defaultValidator);
    const [atBob, atCarol] = await Promise.all([receiver(network, 12), receiver(network, 13)]);
    const sent = await sendSigned(await mailboxFrom(atBob.mailbox, { transports: [network.transport] }), line, alice);
    const [received] = await atBob.take();
    // Bob passes on what he read: the signature, with the line and the identity it names.
    const read = await readSigned(received!, chat);
    await (await mailboxFrom(atCarol.mailbox, { transports: [network.transport] })).send(read.signature, [
      read.object.bytes,
      read.identity.bytes,
    ]);
    const [passed] = await atCarol.take();
    return { sent, received: received!, passed: passed! };
  };

  it("that Bob passes on reads at Carol's as Alice's, and nothing in it shows that Bob sent it", async () => {
    const { sent, passed } = await passOn(encodeObject(chat, { text: "lunch at noon?" }));
    expect(passed.link).toBe(sent.link);
    expect(await readChat(passed, identities.encode(carol.identity))).toEqual({
      author: identities.encode(alice.identity),
      text: "lunch at noon?",
      forReader: undefined,
    });
  });

  it("written to Bob shows at Carol's that it is not for her", async () => {
    const line = encodeObject(chat, { to: { $link: identities.encode(bob.identity).link }, text: "lunch at noon?" });
    const { received, passed } = await passOn(line);
    expect((await readChat(received, identities.encode(bob.identity))).forReader).toBe(true);
    expect((await readChat(passed, identities.encode(carol.identity))).forReader).toBe(false);
  });
});

const join: Schema<Json, { readonly invitation: JsonLink<never> }> = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Join",
    type: "object",
    properties: { invitation: linkSchema },
    required: ["invitation"],
    additionalProperties: false,
  },
  defaultValidator,
);

// Nobody signs the mailbox of a one-time invitation: it is handed out on its
// own. Answering it once is the inviter's own record, so the inviter lets in
// the first who answers and no one after.
describe("a one-time invitation", () => {
  const dave = signer("ed25519", 4);
  const erin = signer("solana-offchain", 5);

  const invite = async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const inviter = await receiver(network, 14);
    const link = linkOf(inviter.mailbox);
    const answer = async (guest: SoftwareSigner) => {
      const mailbox = await mailboxFrom(inviter.mailbox, { transports: [network.transport] });
      await sendSigned(mailbox, encodeObject(join, { invitation: { $link: link } }), guest);
    };
    let used = false;
    const letIn = async () => {
      const admitted: IdentityObject[] = [];
      for (const bundle of await inviter.take()) {
        const { identity, object } = await readSigned(bundle, join);
        if (used || object.data.invitation.$link !== link) continue;
        used = true;
        admitted.push(identity);
      }
      return admitted;
    };
    return { answer, letIn };
  };

  it("lets in the first who answers at its mailbox and no one after", async () => {
    const { answer, letIn } = await invite();
    await answer(dave);
    await answer(erin);
    expect(await letIn()).toEqual([identities.encode(dave.identity)]);
    await answer(erin);
    expect(await letIn()).toEqual([]);
  });
});

type Sale = {
  readonly buyer: JsonLink<IdentityObject>;
  readonly seller: JsonLink<IdentityObject>;
  readonly goods: string;
  readonly price: string;
};

const sale: Schema<Json, Sale> = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Sale",
    type: "object",
    properties: {
      buyer: linkSchema,
      seller: linkSchema,
      goods: { type: "string" },
      price: { type: "string", pattern: "^[0-9]+\\.[0-9]{2} [A-Z]{3}$" },
    },
    required: ["buyer", "seller", "goods", "price"],
    additionalProperties: false,
  },
  defaultValidator,
);

// A registry records a sale once its buyer and its seller have both signed
// it. Each party sends its own signature with the terms to the registry's
// mailbox, and the registry reads all it has received, in whatever order
// and as many times as it arrived.
async function salesInForce(received: readonly Bundle[]): Promise<Sale[]> {
  const signers = new Map<string, { terms: Sale; identities: IdentityObject[] }>();
  for (const bundle of received) {
    const { identity, object } = await readSigned(bundle, sale);
    const record = signers.get(object.link) ?? { terms: object.data, identities: [] };
    record.identities.push(identity);
    signers.set(object.link, record);
  }
  const signedBy = (identities: IdentityObject[]) => (party: JsonLink<IdentityObject>) =>
    identities.some((identity) => identity.link === party.$link);
  return [...signers.values()]
    .filter(({ terms, identities }) => [terms.buyer, terms.seller].every(signedBy(identities)))
    .map(({ terms }) => terms);
}

describe("a sale sent to a registry", () => {
  const buyer = signer("eip191", 6);
  const seller = signer("solana-offchain", 7);
  const terms = encodeObject(sale, {
    buyer: { $link: identities.encode(buyer.identity).link },
    seller: { $link: identities.encode(seller.identity).link },
    goods: "one bicycle",
    price: "120.00 CAD",
  });

  const withRegistry = async (faults: Faults) => {
    const network = await MemoryNetwork.create(defaultValidator, faults);
    const registry = await receiver(network, 15);
    const mailbox = await mailboxFrom(registry.mailbox, { transports: [network.transport] });
    return { send: (party: SoftwareSigner) => sendSigned(mailbox, terms, party), take: registry.take };
  };

  it("is in force when every message arrives twice, the latest first", async () => {
    const { send, take } = await withRegistry({ twice: true, reversed: true });
    await send(buyer);
    await send(seller);
    const received = await take();
    expect(received).toHaveLength(4);
    expect(await salesInForce(received)).toEqual([terms.data]);
  });

  it("is not in force while the buyer's signature is lost, and is once the buyer sends it again", async () => {
    const { send, take } = await withRegistry({ lost: (n) => n === 0 });
    await send(buyer);
    await send(seller);
    const received = await take();
    expect(await salesInForce(received)).toEqual([]);
    await send(buyer);
    expect(await salesInForce([...received, ...(await take())])).toEqual([terms.data]);
  });
});

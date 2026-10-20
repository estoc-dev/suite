import { identityFromJson, identityToJson, sameIdentity, SoftwareSigner, type Identity, type IdentityJson, type Scheme } from "@estoc/identity";
import { decodeObject, decodeSignature, encodeObject, encodeSchema, linkOf, sign, type EncodedObject, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { MailboxKey, readMailbox, type Message } from "../src/index.ts";
import { MemoryNetwork, type Faults } from "./memory-network.ts";

// Applications that send signed objects through mailboxes. A message names
// no sender, and anyone can pass on what someone else signed: a receiver
// reads who stands behind what it holds, not who sent it. An application
// that needs to know whom a message was meant for writes that into the
// object it signs.

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const now = new Date("2026-10-20T12:00:00Z");
const signed = async (object: EncodedObject, by: SoftwareSigner): Promise<Message> => ({
  entry: (await sign(object, by)).bytes,
  blobs: [object.bytes],
});

// The entry's signature and the object it signs, found among the blobs.
function readSigned({ entry, blobs }: Message, schema: Schema): { identity: Identity; object: EncodedObject } {
  const signature = decodeSignature(entry);
  const object = blobs.find((bytes) => linkOf(bytes) === signature.object);
  if (object === undefined) throw new Error(`no blob is given for ${signature.object}`);
  return { identity: signature.identity, object: decodeObject(object, schema) };
}

// Someone who receives at a mailbox on a network and hands it out.
async function receiver(network: MemoryNetwork, fill: number, until?: string) {
  const key = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(fill));
  const queue = network.queue();
  const mailbox: Message = { entry: queue.mailbox(key.publicKey, until).bytes, blobs: [] };
  return { mailbox, take: () => Promise.all(queue.take().map((sealed) => key.open(sealed))) };
}

const chat = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Chat",
    type: "object",
    properties: { to: { $ref: "https://estoc.dev/schema/identity" }, text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  defaultValidator,
);

// What a chat shows of a line: who wrote it and, when the line says whom it
// is for, whether that is the reader.
function readChat(message: Message, reader: Identity) {
  const { identity, object } = readSigned(message, chat);
  const { text, to } = object.data as { text: string; to?: IdentityJson };
  return { author: identity, text, forReader: to === undefined ? undefined : sameIdentity(identityFromJson(to), reader) };
}

describe("a chat line", () => {
  const alice = signer("ed25519", 1);
  const bob = signer("ed25519", 2);
  const carol = signer("ed25519", 3);

  const passOn = async (line: EncodedObject) => {
    const network = await MemoryNetwork.create(defaultValidator);
    const [atBob, atCarol] = await Promise.all([receiver(network, 12), receiver(network, 13)]);
    const sent = await signed(line, alice);
    await (await readMailbox(atBob.mailbox, { transports: [network.transport] })).send(sent);
    const [received] = await atBob.take();
    await (await readMailbox(atCarol.mailbox, { transports: [network.transport] })).send(received!);
    const [passed] = await atCarol.take();
    return { sent, received: received!, passed: passed! };
  };

  it("that Bob passes on reads at Carol's as Alice's, and nothing in it shows that Bob sent it", async () => {
    const { sent, passed } = await passOn(encodeObject(chat, { text: "lunch at noon?" }));
    expect(passed).toEqual(sent);
    expect(readChat(passed, carol.identity)).toEqual({ author: alice.identity, text: "lunch at noon?", forReader: undefined });
  });

  it("written to Bob shows at Carol's that it is not for her", async () => {
    const { received, passed } = await passOn(encodeObject(chat, { to: identityToJson(bob.identity), text: "lunch at noon?" }));
    expect(readChat(received, bob.identity).forReader).toBe(true);
    expect(readChat(passed, carol.identity).forReader).toBe(false);
  });
});

const join = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Join",
    type: "object",
    properties: { invitation: { $ref: "https://estoc.dev/schema/link" } },
    required: ["invitation"],
    additionalProperties: false,
  },
  defaultValidator,
);

// Nobody signs the mailbox of a one-time invitation: it is handed out on its
// own, and has a short end. Answering it once is the inviter's own record,
// so the inviter lets in the first who answers and no one after.
describe("a one-time invitation", () => {
  const dave = signer("ed25519", 4);
  const erin = signer("solana-offchain", 5);

  const invite = async () => {
    const network = await MemoryNetwork.create(defaultValidator);
    const inviter = await receiver(network, 14, "2026-10-20T13:00:00Z");
    const link = linkOf(inviter.mailbox.entry);
    const answer = async (guest: SoftwareSigner, at: Date) => {
      const mailbox = await readMailbox(inviter.mailbox, { transports: [network.transport], clock: () => at });
      await mailbox.send(await signed(encodeObject(join, { invitation: link }), guest));
    };
    let used = false;
    const letIn = async () => {
      const admitted: Identity[] = [];
      for (const message of await inviter.take()) {
        const { identity, object } = readSigned(message, join);
        if (used || (object.data as { invitation: string }).invitation !== link) continue;
        used = true;
        admitted.push(identity);
      }
      return admitted;
    };
    return { answer, letIn };
  };

  it("lets in the first who answers at its mailbox and no one after", async () => {
    const { answer, letIn } = await invite();
    await answer(dave, now);
    await answer(erin, now);
    expect(await letIn()).toEqual([dave.identity]);
    await answer(erin, now);
    expect(await letIn()).toEqual([]);
  });

  it("takes no answer from its end on", async () => {
    const { answer, letIn } = await invite();
    await expect(answer(dave, new Date("2026-10-20T13:00:00Z"))).rejects.toThrow(/ended at/);
    expect(await letIn()).toEqual([]);
  });
});

type Sale = {
  readonly buyer: IdentityJson;
  readonly seller: IdentityJson;
  readonly goods: string;
  readonly price: string;
};

const sale = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Sale",
    type: "object",
    properties: {
      buyer: { $ref: "https://estoc.dev/schema/identity" },
      seller: { $ref: "https://estoc.dev/schema/identity" },
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
function salesInForce(received: readonly Message[]): Sale[] {
  const signers = new Map<string, { terms: Sale; identities: Identity[] }>();
  for (const message of received) {
    const { identity, object } = readSigned(message, sale);
    const record = signers.get(object.link) ?? { terms: object.data as Sale, identities: [] };
    record.identities.push(identity);
    signers.set(object.link, record);
  }
  const signedBy = (identities: Identity[]) => (party: IdentityJson) =>
    identities.some((identity) => sameIdentity(identity, identityFromJson(party)));
  return [...signers.values()]
    .filter(({ terms, identities }) => [terms.buyer, terms.seller].every(signedBy(identities)))
    .map(({ terms }) => terms);
}

describe("a sale sent to a registry", () => {
  const buyer = signer("eip191", 6);
  const seller = signer("solana-offchain", 7);
  const terms = encodeObject(sale, {
    buyer: identityToJson(buyer.identity),
    seller: identityToJson(seller.identity),
    goods: "one bicycle",
    price: "120.00 CAD",
  });

  const withRegistry = async (faults: Faults) => {
    const network = await MemoryNetwork.create(defaultValidator, faults);
    const registry = await receiver(network, 15);
    const mailbox = await readMailbox(registry.mailbox, { transports: [network.transport] });
    return { send: async (party: SoftwareSigner) => mailbox.send(await signed(terms, party)), take: registry.take };
  };

  it("is in force when every message arrives twice, the latest first", async () => {
    const { send, take } = await withRegistry({ twice: true, reversed: true });
    await send(buyer);
    await send(seller);
    const received = await take();
    expect(received).toHaveLength(4);
    expect(salesInForce(received)).toEqual([terms.data]);
  });

  it("is not in force while the buyer's signature is lost, and is once the buyer sends it again", async () => {
    const { send, take } = await withRegistry({ lost: (n) => n === 0 });
    await send(buyer);
    await send(seller);
    const received = await take();
    expect(salesInForce(received)).toEqual([]);
    await send(buyer);
    expect(salesInForce([...received, ...(await take())])).toEqual([terms.data]);
  });
});

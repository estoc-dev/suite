import { type Bundle, decodeBundle, encodeBundle } from "@estoc/bundle";
import {
  type CurveScheme,
  ed25519,
  eip191,
  type Identifier,
  type IdentityObject,
  type KeyObject,
  loadIdentity,
  noIdentityVersions,
  type SignedIdentityObject,
  SoftwareSigner,
  solanaOffchain,
} from "@estoc/identity";
import {
  type EncodedObject,
  type Est,
  EstLink,
  encodeObject,
  est,
  type Fields,
  type Link,
  linkOf,
  readObject,
  type Schema,
} from "@estoc/object";
import { link, optional, schema, string } from "@estoc/schema";
import { Intake, MemoryBackend, PrivateStore, Store } from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import { type Delivery, type Mailbox, MailboxKey, mailboxFrom, Post } from "../src/index.ts";
import { type Faults, MemoryNetwork } from "./memory-network.ts";

// Applications that send signed objects through mailboxes, each as a bundle
// whose root is the signature over it. A message names no sender, and
// anyone can pass on what someone else signed: a receiver reads who stands
// behind what it holds, not who sent it. An application that needs to know
// whom a message was meant for writes that into the object it signs.

const identity = loadIdentity([ed25519, eip191, solanaOffchain]);
const { keys, identities, signatures, signedIdentities, publish } = identity;

const signer = (scheme: CurveScheme, fill: number) =>
  SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const sendSigned = async (mailbox: Mailbox, object: EncodedObject<Est>, by: SoftwareSigner) => {
  const signature = await signatures.actor(by, await publish(by, { at: 0 })).sign(object);
  await mailbox.send(signature, [object.bytes, ...signature.signedIdentity.blobs]);
  return signature;
};

async function readSigned<F extends Fields<Est>>(bundle: Bundle, schema: Schema<Est, F>) {
  const signature = await signatures.read(bundle.link, bundle, noIdentityVersions);
  return {
    signature,
    identity: signature.signedIdentity.identity,
    object: await readObject(bundle, signature.object, schema),
  };
}

async function receiver(network: MemoryNetwork, fill: number) {
  const key = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(fill));
  const queue = network.queue();
  return {
    mailbox: queue.mailbox(key.publicKey).bytes,
    take: () => Promise.all(queue.take().map((ciphertext) => key.open(ciphertext))),
  };
}

const chat = schema("Chat", { to: optional(link<KeyObject>()), text: string() });

// What a chat shows of a line: who wrote it and, when the line names whom it
// is for by their identifier, whether that is the reader.
async function readChat(bundle: Bundle, reader: IdentityObject) {
  const { identity, object } = await readSigned(bundle, chat);
  const { text, to } = object.data;
  return { author: identity, text, forReader: to === undefined ? undefined : to.link === reader.identifier };
}

describe("a chat line", () => {
  const alice = signer(ed25519, 1);
  const bob = signer(ed25519, 2);
  const carol = signer(ed25519, 3);

  const passOn = async (line: EncodedObject<Est>) => {
    const network = new MemoryNetwork();
    const [atBob, atCarol] = await Promise.all([receiver(network, 12), receiver(network, 13)]);
    const sentSignature = await sendSigned(
      await mailboxFrom(atBob.mailbox, { transports: [network.transport] }),
      line,
      alice,
    );
    const [receivedBundle] = await atBob.take();
    assert.exists(receivedBundle);
    // Bob passes on what he read: the signature, with the line and the signed identity it names.
    const signedLine = await readSigned(receivedBundle, chat);
    await (await mailboxFrom(atCarol.mailbox, { transports: [network.transport] })).send(signedLine.signature, [
      signedLine.object.bytes,
      ...signedLine.signature.signedIdentity.blobs,
    ]);
    const [passedBundle] = await atCarol.take();
    assert.exists(passedBundle);
    return { sentSignature, receivedBundle, passedBundle };
  };

  it("that Bob passes on reads at Carol's as Alice's, and nothing in it shows that Bob sent it", async () => {
    const { sentSignature, passedBundle } = await passOn(encodeObject(chat, { text: "lunch at noon?" }));
    expect(passedBundle.link).toBe(sentSignature.link);
    expect(await readChat(passedBundle, identities.encode(carol.key, { at: 0 }))).toEqual({
      author: identities.encode(alice.key, { at: 0 }),
      text: "lunch at noon?",
      forReader: undefined,
    });
  });

  it("written to Bob shows at Carol's that it is not for her", async () => {
    const line = encodeObject(chat, { to: new EstLink(keys.encode(bob.key).link), text: "lunch at noon?" });
    const { receivedBundle, passedBundle } = await passOn(line);
    expect((await readChat(receivedBundle, identities.encode(bob.key, { at: 0 }))).forReader).toBe(true);
    expect((await readChat(passedBundle, identities.encode(carol.key, { at: 0 }))).forReader).toBe(false);
  });
});

const join = schema("Join", { invitation: link<never>() });

// Nobody signs the mailbox of a one-time invitation: it is handed out on its
// own. Answering it once is the inviter's own record, so the inviter lets in
// the first who answers and no one after.
describe("a one-time invitation", () => {
  const dave = signer(ed25519, 4);
  const erin = signer(solanaOffchain, 5);

  const invite = async () => {
    const network = new MemoryNetwork();
    const inviter = await receiver(network, 14);
    const link = linkOf(inviter.mailbox);
    const answer = async (guest: SoftwareSigner) => {
      const mailbox = await mailboxFrom(inviter.mailbox, { transports: [network.transport] });
      await sendSigned(mailbox, encodeObject(join, { invitation: new EstLink(link) }), guest);
    };
    let isUsed = false;
    const letIn = async () => {
      const admitted: IdentityObject[] = [];
      for (const bundle of await inviter.take()) {
        const { identity, object } = await readSigned(bundle, join);
        if (isUsed || object.data.invitation.link !== link) continue;
        isUsed = true;
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
    expect(await letIn()).toEqual([identities.encode(dave.key, { at: 0 })]);
    await answer(erin);
    expect(await letIn()).toEqual([]);
  });
});

type Sale = {
  readonly buyer: EstLink<KeyObject>;
  readonly seller: EstLink<KeyObject>;
  readonly goods: string;
  readonly price: string;
};

const sale = schema("Sale", {
  buyer: link<KeyObject>(),
  seller: link<KeyObject>(),
  goods: string(),
  price: string(),
});

// A registry records a sale once its buyer and its seller have both signed
// it. Each party sends its own signature with the terms to the registry's
// mailbox, and the registry reads all it has received, in whatever order
// and as many times as it arrived.
async function salesInForce(receivedBundles: readonly Bundle[]): Promise<Sale[]> {
  const signers = new Map<string, { terms: Sale; identities: IdentityObject[] }>();
  for (const bundle of receivedBundles) {
    const { identity, object } = await readSigned(bundle, sale);
    const record = signers.get(object.link) ?? { terms: object.data, identities: [] };
    record.identities.push(identity);
    signers.set(object.link, record);
  }
  const signedBy = (identities: IdentityObject[]) => (party: EstLink<KeyObject>) =>
    identities.some((identity) => identity.identifier === party.link);
  return [...signers.values()]
    .filter(({ terms, identities }) => [terms.buyer, terms.seller].every(signedBy(identities)))
    .map(({ terms }) => terms);
}

describe("a sale sent to a registry", () => {
  const buyer = signer(eip191, 6);
  const seller = signer(solanaOffchain, 7);
  const terms = encodeObject(sale, {
    buyer: new EstLink(keys.encode(buyer.key).link),
    seller: new EstLink(keys.encode(seller.key).link),
    goods: "one bicycle",
    price: "120.00 CAD",
  });

  const withRegistry = async (faults: Faults) => {
    const network = new MemoryNetwork(faults);
    const registry = await receiver(network, 15);
    const mailbox = await mailboxFrom(registry.mailbox, { transports: [network.transport] });
    return { send: (party: SoftwareSigner) => sendSigned(mailbox, terms, party), take: registry.take };
  };

  it("is in force when every message arrives twice, the latest first", async () => {
    const { send, take } = await withRegistry({ twice: true, reversed: true });
    await send(buyer);
    await send(seller);
    const receivedBundles = await take();
    expect(receivedBundles).toHaveLength(4);
    expect(await salesInForce(receivedBundles)).toEqual([terms.data]);
  });

  it("is not in force while the buyer's signature is lost, and is once the buyer sends it again", async () => {
    const { send, take } = await withRegistry({ lost: (n) => n === 0 });
    await send(buyer);
    await send(seller);
    const receivedBundles = await take();
    expect(await salesInForce(receivedBundles)).toEqual([]);
    await send(buyer);
    expect(await salesInForce([...receivedBundles, ...(await take())])).toEqual([terms.data]);
  });
});

// Two people who meet hand over what it takes once, out of band: first the
// signed identity of the one, and then a grant to them from the other, which
// says who the other is and where to send. From then on all goes through
// their mailboxes. Whoever receives reads what came in by the grants they gave,
// so a grant that came in reads as a message, and the application shows the
// lines among those.
describe("two people who meet", () => {
  const lines = signatures.selectionOver(chat);

  const twoPeople = async () => {
    const network = new MemoryNetwork();
    // One clock for both, so that what one does reads as before what the other does next.
    let now = 0;
    const clock = () => ++now;
    const person = async (fill: number) => {
      const by = signer(ed25519, fill);
      const actor = signatures.actor(by, await publish(by, { at: 0 }));
      const store = new Store(est, new MemoryBackend());
      const privateStore = new PrivateStore(store, new MemoryBackend());
      const options = { transports: [network.transport], clock };
      const post = new Post(store, privateStore, options);
      const intake = new Intake(store, clock);
      const correspondence = post.correspondenceAs(actor, identity);
      const openInbox = async () => {
        const queue = network.queue();
        const inbox = await post.openInbox(queue.mailbox);
        const pickup = queue.pickup(inbox.mailbox);
        return { mailbox: inbox.mailbox, collect: () => inbox.collect(pickup) };
      };
      const say = async (to: SignedIdentityObject, text: string) => {
        const object = encodeObject(chat, { text });
        const signature = await actor.sign(object);
        await store.write({
          records: [signature],
          blobs: [object.bytes, ...signature.signedIdentity.blobs, ...chat.blobs, ...signatures.schema.blobs],
        });
        return correspondence.send(to, signature.link);
      };
      // Who wrote each line among `deliveries`, and its text, leaving out what is no message and what is no line.
      const read = async (deliveries: readonly Delivery[]) => {
        const shownLines: [Identifier, string][] = [];
        for (const { mailbox, bundle } of deliveries) {
          const message = await correspondence.messageAt(mailbox, bundle);
          const line = await lines.read(bundle, store);
          if (message !== undefined && line !== undefined) {
            shownLines.push([message.signedIdentity.identity.identifier, line.object.data.text]);
          }
        }
        return shownLines;
      };
      const { signedIdentity } = actor;
      const { identifier } = signedIdentity.identity;
      return { identifier, signedIdentity, store, intake, correspondence, openInbox, say, read };
    };
    return { grace: await person(8), heidi: await person(9) };
  };
  type Correspondent = Awaited<ReturnType<typeof twoPeople>>["grace"];

  // What the store holds under `root`, as a bundle to hand over out of band.
  const bundleIn = async ({ store }: Correspondent, root: Link<unknown>) => {
    const closure = await store.closure(root);
    const bytes = closure.get(root);
    assert.exists(bytes);
    return decodeBundle(encodeBundle({ bytes }, closure.values()));
  };

  it("first hand over a signed identity and a grant, and from then on write through their mailboxes", async () => {
    const { grace, heidi } = await twoPeople();

    // Heidi hands over a signed identity, and Grace hands back a grant of a mailbox.
    const handedIdentity = decodeBundle(encodeBundle(heidi.signedIdentity, heidi.signedIdentity.blobs));
    await grace.intake.receive(handedIdentity);
    const heidiAsSeen = await signedIdentities.read(heidi.signedIdentity.link, handedIdentity);
    const atGrace = await grace.openInbox();
    const handedGrant = await bundleIn(grace, (await grace.correspondence.grant(heidiAsSeen, [atGrace.mailbox])).link);
    await heidi.intake.receive(handedGrant);

    // That grant says who Grace is, and Heidi's own grant goes to the mailbox it names.
    const graceAsSeen = (await signatures.read(handedGrant.link, handedGrant, noIdentityVersions)).signedIdentity;
    expect(graceAsSeen.link).toBe(grace.signedIdentity.link);
    const atHeidi = await heidi.openInbox();
    const heidisGrant = await heidi.correspondence.grant(graceAsSeen, [atHeidi.mailbox]);
    expect(await heidi.correspondence.send(graceAsSeen, heidisGrant.link)).toMatchObject([
      { mailbox: atGrace.mailbox },
    ]);
    expect(await grace.read(await atGrace.collect())).toEqual([]);

    await grace.say(heidiAsSeen, "hi Heidi");
    expect(await heidi.read(await atHeidi.collect())).toEqual([[grace.identifier, "hi Heidi"]]);
    await heidi.say(graceAsSeen, "hi Grace");
    expect(await grace.read(await atGrace.collect())).toEqual([[heidi.identifier, "hi Grace"]]);
  });

  it("move a mailbox with nothing lost, and what came in at the old one still reads as a message", async () => {
    const { grace, heidi } = await twoPeople();
    const give = async (mailboxes: readonly Link<EncodedObject<Est>>[]) =>
      grace.correspondence.grant(heidi.signedIdentity, mailboxes);

    const oldInbox = await grace.openInbox();
    await heidi.intake.receive(await bundleIn(grace, (await give([oldInbox.mailbox])).link));
    const atHeidi = await heidi.openInbox();
    const heidisGrant = await heidi.correspondence.grant(grace.signedIdentity, [atHeidi.mailbox]);
    await grace.intake.receive(await bundleIn(heidi, heidisGrant.link));
    await heidi.say(grace.signedIdentity, "before the move");
    const beforeMove = await oldInbox.collect();

    // Grace lists the new mailbox beside the old, and goes on receiving at both.
    const newInbox = await grace.openInbox();
    await grace.correspondence.send(heidi.signedIdentity, (await give([oldInbox.mailbox, newInbox.mailbox])).link);
    await atHeidi.collect();
    await heidi.say(grace.signedIdentity, "during the move");
    const duringMove = await oldInbox.collect();
    const atNew = await newInbox.collect();

    // Grace signs a grant without the old mailbox, and stops receiving there.
    expect(await grace.read(atNew)).toEqual([[heidi.identifier, "during the move"]]);
    await grace.correspondence.send(heidi.signedIdentity, (await give([newInbox.mailbox])).link);
    await atHeidi.collect();
    await heidi.say(grace.signedIdentity, "after the move");
    expect(await oldInbox.collect()).toEqual([]);

    expect(await grace.read([...beforeMove, ...duringMove, ...(await newInbox.collect())])).toEqual([
      [heidi.identifier, "before the move"],
      [heidi.identifier, "during the move"],
      [heidi.identifier, "after the move"],
    ]);
  });
});

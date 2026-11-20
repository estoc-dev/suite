import { decodeBundle, encodeBundle } from "@estoc/bundle";
import {
  type Actor,
  ed25519,
  loadIdentity,
  type Signature,
  type SignedIdentityObject,
  SoftwareSigner,
} from "@estoc/identity";
import { type EncodedObject, encodeObject, type Link, LinkValue, objectsOf, readObject } from "@estoc/object";
import { peopleView } from "@estoc/people";
import { type DataOf, integer, link, schema, string } from "@estoc/schema";
import {
  Intake,
  inboundSchema,
  indexOver,
  MemoryBackend,
  type OrderedIndex,
  PrivateStore,
  type Rows,
  recordSchema,
  SecretStore,
  Store,
  scan,
  selectedMarks,
  view,
} from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import { type Correspondence, type Inbox, outboundSchema, type Pickup, Post } from "../src/index.ts";
import { type Faults, MemoryNetwork } from "./memory-network.ts";

// A chat between two people, each with a mailbox for the other and a grant of
// that mailbox from the other, handed over out of band. The application reads
// a conversation out of the marks of its private store alone, and shows a
// line as a message from whoever signed it where the reader gave them that
// mailbox.

const identity = loadIdentity([ed25519]);
const { signatures, publish } = identity;
const seenPeople = peopleView(identity);
const line = schema("Line", { text: string() });
const schemas = [line, signatures.schema].flatMap(({ blobs }) => blobs);

type Direction = "inbound" | "outbound";
type Mailbox = Link<EncodedObject>;
const delivery = schema("Delivery", {
  direction: string(),
  mailbox: link<EncodedObject>(),
  at: integer(),
  bundle: link<never>(),
});
type Delivery = DataOf<typeof delivery>;
type DeliveryOrder = readonly ["direction", "mailbox", "at", "bundle"];

// The application's index of the deliveries its user's private store marks: a
// row for each, by which way it went, the mailbox, when, and the bundle. What
// was handed over out of band came in at no mailbox, and gives no row.
const deliveries: OrderedIndex<Delivery, DeliveryOrder> = indexOver(
  selectedMarks(objectsOf(inboundSchema)),
  delivery,
  ({ data: { via, at, bundle } }) => (via === undefined ? [] : [{ direction: "inbound", mailbox: via, at, bundle }]),
)
  .union(
    indexOver(selectedMarks(objectsOf(outboundSchema)), delivery, ({ data: { mailbox, at, bundle } }) => [
      { direction: "outbound", mailbox, at, bundle },
    ]),
  )
  .orderedBy("direction", "mailbox", "at", "bundle");

async function all<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}

// What came in at `mine` and went out to `theirs`, in the order of when. A
// bundle that came in, or went out, more than once is there once, at the
// first time: a range gives its rows in the order of when.
async function conversation(rows: Rows<Delivery, DeliveryOrder>, mine: Mailbox, theirs: Mailbox): Promise<Delivery[]> {
  const first = async (range: AsyncIterable<{ readonly data: Delivery }>) => {
    const seenBundles = new Set<Link<never>>();
    return (await all(range))
      .map(({ data }) => data)
      .filter(({ bundle }) => {
        const isFirst = !seenBundles.has(bundle.link);
        seenBundles.add(bundle.link);
        return isFirst;
      });
  };
  const ways = await Promise.all([
    first(rows.range(["inbound", new LinkValue(mine)])),
    first(rows.range(["outbound", new LinkValue(theirs)])),
  ]);
  return ways.flat().sort((a, b) => a.at - b.at);
}

interface Person {
  readonly name: string;
  readonly actor: Actor;
  readonly signedIdentity: SignedIdentityObject;
  readonly store: Store;
  readonly privateStore: PrivateStore;
  readonly post: Post;
  readonly intake: Intake;
  readonly correspondence: Correspondence;
}

// `from` hands what its store holds under `root` to `to` out of band, and `to` keeps it.
async function handOver(from: Person, to: Person, root: Link<unknown>) {
  await to.intake.receive(decodeBundle(encodeBundle(root, (await from.store.closure(root)).values())));
}

async function chat(faults: Faults = {}) {
  const network = new MemoryNetwork(faults);
  const transports = [network.transport];
  // One clock for both, so that what one does reads as before what the other does next.
  let now = 0;
  const clock = () => ++now;
  const person = async (name: string, fill: number): Promise<Person> => {
    const signer = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(fill));
    const signedIdentity = await publish(signer, { at: 0 });
    const store = new Store(new MemoryBackend());
    const actor = signatures.actor(signer, signedIdentity, async (inHand) =>
      (await view(store, seenPeople)).current(inHand),
    );
    const privateStore = new PrivateStore(store, new MemoryBackend());
    const secretStore = new SecretStore(store, new MemoryBackend());
    const post = new Post(store, privateStore, secretStore, { transports, clock });
    const intake = new Intake(store, privateStore, clock);
    const correspondence = post.correspondenceAs(actor, identity);
    return { name, actor, signedIdentity, store, privateStore, post, intake, correspondence };
  };
  const alice = await person("Alice", 1);
  const bob = await person("Bob", 2);
  const names = new Map([alice, bob].map(({ name, actor }) => [actor.identifier, name]));

  // `owner` opens a mailbox for `peer`, signs a grant of it and hands it over
  // out of band, and the peer keeps it in their store with a mark that it
  // came in, to send to it.
  const mailboxFor = async (owner: Person, peer: Person) => {
    const queue = network.queue();
    const inbox = await owner.post.openInbox(() => queue.transport);
    const grant = await owner.correspondence.grant(peer.signedIdentity, [inbox.mailbox]);
    await handOver(owner, peer, grant.link);
    return { mailbox: inbox.mailbox, inbox, pickup: queue.pickup() };
  };
  const atAlice = await mailboxFor(alice, bob);
  const atBob = await mailboxFor(bob, alice);

  const writeLine = async ({ actor, store }: Person, text: string) => {
    const object = encodeObject(line, { text });
    const signature = await actor.sign(object);
    await store.write({
      roots: [signature.link],
      blobs: [...signature.blobs, object.bytes, ...schemas],
    });
    return signature;
  };
  const say = async (from: Person, to: SignedIdentityObject, text: string) => {
    const signature = await writeLine(from, text);
    await from.correspondence.send(to, signature.link);
    return signature;
  };
  const collect = ({ inbox, pickup }: { inbox: Inbox; pickup: Pickup }) => inbox.collect(pickup);

  // What the person sees of their conversation with the other: each line,
  // which way it went and who wrote it. What came in and is no message from
  // anyone the person gave that mailbox is left out.
  const show = async (person: Person, mine: Mailbox, theirs: Mailbox) => {
    const rows = await conversation(await scan(person.privateStore, deliveries), mine, theirs);
    const lines = await Promise.all(
      rows.map(async ({ direction, mailbox, bundle }) => {
        const signature: Signature | undefined =
          direction === "inbound"
            ? await person.correspondence.messageAt(mailbox.link, bundle.link)
            : await signatures.read(bundle.link, person.store);
        if (signature === undefined) return undefined;
        const { data } = await readObject(person.store, signature.object, line);
        return [direction, names.get(signature.signedIdentity.identity.identifier), data.text];
      }),
    );
    return lines.filter((shown) => shown !== undefined);
  };
  // What the person's private store marks as having come in, or gone out, at any mailbox.
  const marked = async ({ privateStore }: Person, direction: Direction) =>
    all((await scan(privateStore, deliveries)).range([direction]));

  // Someone who was given no grant, and was passed the mailbox that Alice gave
  // Bob, sends a line of their own there.
  const carol = await person("Carol", 3);
  await handOver(bob, carol, atAlice.mailbox);

  return {
    alice: {
      say: (text: string) => say(alice, bob.signedIdentity, text),
      collect: () => collect(atAlice),
      show: () => show(alice, atAlice.mailbox, atBob.mailbox),
      marked: (direction: Direction) => marked(alice, direction),
      resend: (root: Link<unknown>) => alice.correspondence.send(bob.signedIdentity, root),
      store: alice.store,
      privateStore: alice.privateStore,
      conversation: async (privateStore: PrivateStore) =>
        conversation(await scan(privateStore, deliveries), atAlice.mailbox, atBob.mailbox),
    },
    bob: {
      say: (text: string) => say(bob, alice.signedIdentity, text),
      collect: () => collect(atBob),
      show: () => show(bob, atBob.mailbox, atAlice.mailbox),
      marked: (direction: Direction) => marked(bob, direction),
    },
    carol: {
      sayToAlice: async (text: string) =>
        (await carol.post.outbox(atAlice.mailbox)).send((await writeLine(carol, text)).link),
    },
  };
}

describe("a conversation", () => {
  it("reads at each side in the order things happened there, from the marks of what came in and went out", async () => {
    const { alice, bob } = await chat();
    await alice.say("hi Bob");
    await bob.collect();
    await bob.say("hi Alice");
    await alice.collect();
    await alice.say("lunch at noon?");
    await bob.collect();

    expect(await alice.show()).toEqual([
      ["outbound", "Alice", "hi Bob"],
      ["inbound", "Bob", "hi Alice"],
      ["outbound", "Alice", "lunch at noon?"],
    ]);
    expect(await bob.show()).toEqual([
      ["inbound", "Alice", "hi Bob"],
      ["outbound", "Bob", "hi Alice"],
      ["inbound", "Alice", "lunch at noon?"],
    ]);
  });

  it("shows a line that arrived twice once, though each arrival is marked", async () => {
    const { alice, bob } = await chat({ twice: true });
    await alice.say("hi Bob");
    await alice.say("lunch at noon?");
    await bob.collect();

    expect(await bob.marked("inbound")).toHaveLength(4);
    expect(await bob.show()).toEqual([
      ["inbound", "Alice", "hi Bob"],
      ["inbound", "Alice", "lunch at noon?"],
    ]);
  });

  it("shows a line once that was collected again because the network was cut before it was done, though each time is marked", async () => {
    const { alice, bob } = await chat({ cut: (n) => n === 0 });
    await alice.say("hi Bob");
    await expect(bob.collect()).rejects.toThrow(/cut/);
    expect(await bob.show()).toEqual([["inbound", "Alice", "hi Bob"]]);

    await bob.collect();
    expect(await bob.marked("inbound")).toHaveLength(2);
    expect(await bob.show()).toEqual([["inbound", "Alice", "hi Bob"]]);
  });

  it("shows a line that was lost and sent again once, when it first went out and when it came in", async () => {
    const { alice, bob } = await chat({ lost: (n) => n === 0 });
    const lostSignature = await alice.say("hi Bob");
    await alice.say("lunch at noon?");
    await bob.collect();
    expect(await bob.show()).toEqual([["inbound", "Alice", "lunch at noon?"]]);

    await alice.resend(lostSignature.link);
    await bob.collect();
    expect(await alice.marked("outbound")).toHaveLength(3);
    expect(await alice.show()).toEqual([
      ["outbound", "Alice", "hi Bob"],
      ["outbound", "Alice", "lunch at noon?"],
    ]);
    expect(await bob.show()).toEqual([
      ["inbound", "Alice", "lunch at noon?"],
      ["inbound", "Alice", "hi Bob"],
    ]);
  });

  it("leaves out a line by someone who was given no grant, though its arrival is marked", async () => {
    const { alice, bob, carol } = await chat();
    await bob.say("hi Alice");
    await carol.sayToAlice("hi Alice, I am Bob");
    await alice.collect();

    expect(await alice.marked("inbound")).toHaveLength(2);
    expect(await alice.show()).toEqual([["inbound", "Bob", "hi Alice"]]);
  });

  it("reads the same when the marks are added in another order and more than once", async () => {
    const { alice, bob } = await chat({ twice: true, reversed: true });
    await alice.say("hi Bob");
    await bob.collect();
    await bob.say("hi Alice");
    await alice.collect();

    // What Alice's private store marks, written again beside a copy of her store, last first and twice.
    const copy = new Store(new MemoryBackend());
    const heldLinks = await all(alice.store.blobs());
    const heldBlobs = await Promise.all(heldLinks.map((link) => alice.store.get(link)));
    await copy.write({ roots: heldLinks, blobs: heldBlobs.filter((bytes) => bytes !== undefined) });
    const privateCopy = new PrivateStore(copy, new MemoryBackend());
    const markSchemas = [inboundSchema, outboundSchema, recordSchema].flatMap(({ blobs }) => blobs);
    const marks = await all(alice.privateStore.marks());
    for (const mark of [...marks, ...marks].reverse()) {
      const bytes = await alice.privateStore.get(mark);
      assert.exists(bytes);
      await privateCopy.write({ marks: [mark], blobs: [bytes, ...markSchemas] });
    }
    expect(await alice.conversation(privateCopy)).toEqual(await alice.conversation(alice.privateStore));
  });
});

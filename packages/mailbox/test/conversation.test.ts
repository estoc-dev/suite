import { readBundle, writeBundle } from "@estoc/bundle";
import {
  type Actor,
  ed25519,
  loadIdentity,
  noIdentityVersions,
  type Signature,
  type SignedIdentityObject,
  SoftwareSigner,
} from "@estoc/identity";
import {
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  json,
  type Link,
  objectsOf,
  readObject,
  type Schema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import {
  type InboundData,
  type Index,
  type Intake,
  inboundSchema,
  indexOver,
  loadIntake,
  MemoryBackend,
  PrivateStore,
  type Rows,
  Store,
  scan,
} from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import {
  type Correspondence,
  type Inbox,
  loadPost,
  type OutboundData,
  outboundSchema,
  type Pickup,
  type Post,
} from "../src/index.ts";
import { type Faults, MemoryNetwork } from "./memory-network.ts";

// A chat between two people, each with a store and a mailbox for the other,
// whose key they keep in a private store beside it, and each with a grant of
// that mailbox from the other, handed over out of band. What one sends is a
// signed line from their store, recorded there as gone out; what arrives is
// kept with a record that it came in. The application reads a conversation
// out of those records alone, through an index of all that its user wrote,
// and reads each line from its bundle when it shows it, as a message from
// whoever signed it where the reader gave them that mailbox.

const identity = await loadIdentity(defaultValidator, [ed25519]);
const { signatures, publish } = identity;
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const line: Schema<Json, { readonly text: string }> = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Line",
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  defaultValidator,
);
const schemas = [line, signatures.schema].flatMap(({ blobs }) => blobs);
const inbound: Schema<Json, InboundData> = await encodeSchema(inboundSchema, defaultValidator);
const outbound: Schema<Json, OutboundData> = await encodeSchema(outboundSchema, defaultValidator);

type Direction = "inbound" | "outbound";
type Mailbox = Link<EncodedObject<Json>>;
type DeliveryRow = [direction: Direction, mailbox: Mailbox, at: number, bundle: Link<never>];

// The application's index of the deliveries its user wrote: a row for each,
// by which way it went, the mailbox, when, and the bundle. What was handed
// over out of band came in at no mailbox, and gives no row.
const deliveries: Index<DeliveryRow> = indexOver(objectsOf(inbound), ({ data: { via, at, bundle } }): DeliveryRow[] =>
  via === undefined ? [] : [["inbound", via.$link, at, bundle.$link]],
).union(
  indexOver(objectsOf(outbound), ({ data: { mailbox, at, bundle } }): DeliveryRow[] => [
    ["outbound", mailbox.$link, at, bundle.$link],
  ]),
);

async function all<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}

// What came in at `mine` and went out to `theirs`, in the order of when. A
// bundle that came in, or went out, more than once is there once, at the
// first time: a range gives its rows in the order of when.
async function conversation(rows: Rows<DeliveryRow>, mine: Mailbox, theirs: Mailbox): Promise<DeliveryRow[]> {
  const first = async (range: AsyncIterable<DeliveryRow>) => {
    const seenBundles = new Set<Link<never>>();
    return (await all(range)).filter(([, , , bundle]) => {
      const isFirst = !seenBundles.has(bundle);
      seenBundles.add(bundle);
      return isFirst;
    });
  };
  const ways = await Promise.all([first(rows.range(["inbound", mine])), first(rows.range(["outbound", theirs]))]);
  return ways.flat().sort((a, b) => a[2] - b[2]);
}

interface Person {
  readonly name: string;
  readonly actor: Actor;
  readonly store: Store;
  readonly post: Post;
  readonly intake: Intake;
  readonly correspondence: Correspondence;
}

// `from` hands what its store holds under `root` to `to` out of band, and `to` keeps it.
async function handOver(from: Person, to: Person, root: Link<unknown>) {
  const closure = await from.store.closure(root);
  const bytes = closure.get(root);
  assert.exists(bytes);
  await to.intake.receive(readBundle(writeBundle({ bytes }, closure.values())));
}

async function chat(faults: Faults = {}) {
  const network = await MemoryNetwork.create(defaultValidator, faults);
  const transports = [network.transport];
  // One clock for both, so that what one does reads as before what the other does next.
  let now = 0;
  const clock = () => ++now;
  const person = async (name: string, fill: number): Promise<Person> => {
    const signer = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(fill));
    const actor = signatures.actor(signer, await publish(signer, { at: 0 }));
    const store = new Store(json, new MemoryBackend());
    const privateStore = new PrivateStore(store, new MemoryBackend());
    const post = await loadPost(store, privateStore, { transports, validator: defaultValidator, clock });
    const intake = await loadIntake(store, { validator: defaultValidator, clock });
    const correspondence = await post.correspondenceAs(actor, identity);
    return { name, actor, store, post, intake, correspondence };
  };
  const alice = await person("Alice", 1);
  const bob = await person("Bob", 2);
  const names = new Map([alice, bob].map(({ name, actor }) => [actor.signedIdentity.identity.identifier, name]));

  // `owner` opens a mailbox for `peer`, signs a grant of it and hands it over
  // out of band, and the peer keeps it in their store with a record that it
  // came in, to send to it.
  const mailboxFor = async (owner: Person, peer: Person) => {
    const queue = network.queue();
    const inbox = await owner.post.openInbox(queue.mailbox);
    const grant = await owner.correspondence.grant(peer.actor.signedIdentity, [inbox.mailbox]);
    await handOver(owner, peer, grant.link);
    return { mailbox: inbox.mailbox, inbox, pickup: queue.pickup(inbox.mailbox) };
  };
  const atAlice = await mailboxFor(alice, bob);
  const atBob = await mailboxFor(bob, alice);

  const writeLine = async ({ actor, store }: Person, text: string) => {
    const object = encodeObject(line, { text });
    const signature = await actor.sign(object);
    await store.write({
      records: [signature],
      blobs: [object.bytes, ...signature.signedIdentity.blobs, ...schemas],
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
    const rows = await conversation(await scan(person.store, deliveries), mine, theirs);
    const lines = await Promise.all(
      rows.map(async ([direction, mailbox, , bundle]) => {
        const signature: Signature | undefined =
          direction === "inbound"
            ? await person.correspondence.messageAt(mailbox, bundle)
            : await signatures.read(bundle, person.store, noIdentityVersions);
        if (signature === undefined) return undefined;
        const { data } = await readObject(person.store, signature.object, line);
        return [direction, names.get(signature.signedIdentity.identity.identifier), data.text];
      }),
    );
    return lines.filter((shown) => shown !== undefined);
  };
  // What the person's store records as having come in, or gone out, at any mailbox.
  const recorded = async ({ store }: Person, direction: Direction) =>
    all((await scan(store, deliveries)).range([direction]));

  // Someone who was given no grant, and was passed the mailbox that Alice gave
  // Bob, sends a line of their own there.
  const carol = await person("Carol", 3);
  await handOver(bob, carol, atAlice.mailbox);

  return {
    alice: {
      say: (text: string) => say(alice, bob.actor.signedIdentity, text),
      collect: () => collect(atAlice),
      show: () => show(alice, atAlice.mailbox, atBob.mailbox),
      recorded: (direction: Direction) => recorded(alice, direction),
      resend: (root: Link<unknown>) => alice.correspondence.send(bob.actor.signedIdentity, root),
      store: alice.store,
      conversation: async (store: Store) => conversation(await scan(store, deliveries), atAlice.mailbox, atBob.mailbox),
    },
    bob: {
      say: (text: string) => say(bob, alice.actor.signedIdentity, text),
      collect: () => collect(atBob),
      show: () => show(bob, atBob.mailbox, atAlice.mailbox),
      recorded: (direction: Direction) => recorded(bob, direction),
    },
    carol: {
      sayToAlice: async (text: string) =>
        (await carol.post.outbox(atAlice.mailbox)).send((await writeLine(carol, text)).link),
    },
  };
}

describe("a conversation", () => {
  it("reads at each side in the order things happened there, from the records of what came in and went out", async () => {
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

  it("shows a line that arrived twice once, though each arrival is recorded", async () => {
    const { alice, bob } = await chat({ twice: true });
    await alice.say("hi Bob");
    await alice.say("lunch at noon?");
    await bob.collect();

    expect(await bob.recorded("inbound")).toHaveLength(4);
    expect(await bob.show()).toEqual([
      ["inbound", "Alice", "hi Bob"],
      ["inbound", "Alice", "lunch at noon?"],
    ]);
  });

  it("shows a line once that was collected again because the network was cut before it was done, though each time is recorded", async () => {
    const { alice, bob } = await chat({ cut: (n) => n === 0 });
    await alice.say("hi Bob");
    await expect(bob.collect()).rejects.toThrow(/cut/);
    expect(await bob.show()).toEqual([["inbound", "Alice", "hi Bob"]]);

    await bob.collect();
    expect(await bob.recorded("inbound")).toHaveLength(2);
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
    expect(await alice.recorded("outbound")).toHaveLength(3);
    expect(await alice.show()).toEqual([
      ["outbound", "Alice", "hi Bob"],
      ["outbound", "Alice", "lunch at noon?"],
    ]);
    expect(await bob.show()).toEqual([
      ["inbound", "Alice", "lunch at noon?"],
      ["inbound", "Alice", "hi Bob"],
    ]);
  });

  it("leaves out a line by someone who was given no grant, though it is recorded", async () => {
    const { alice, bob, carol } = await chat();
    await bob.say("hi Alice");
    await carol.sayToAlice("hi Alice, I am Bob");
    await alice.collect();

    expect(await alice.recorded("inbound")).toHaveLength(2);
    expect(await alice.show()).toEqual([["inbound", "Bob", "hi Alice"]]);
  });

  it("reads the same when the records are added in another order and more than once", async () => {
    const { alice, bob } = await chat({ twice: true, reversed: true });
    await alice.say("hi Bob");
    await bob.collect();
    await bob.say("hi Alice");
    await alice.collect();

    // What Alice wrote, written again to another store, last first and twice.
    const copy = new Store(json, new MemoryBackend());
    const recordLinks = await all(alice.store.records());
    for (const link of [...recordLinks, ...recordLinks].reverse()) {
      const closure = await alice.store.closure(link);
      const bytes = closure.get(link);
      assert.exists(bytes);
      await copy.write({ records: [{ bytes }], blobs: closure.values() });
    }
    expect(await alice.conversation(copy)).toEqual(await alice.conversation(alice.store));
  });
});

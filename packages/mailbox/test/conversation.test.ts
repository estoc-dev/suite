import { type Actor, ed25519, loadSignatures, noVersions, SoftwareSigner } from "@estoc/identity";
import {
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonSchema,
  json,
  type Link,
  readObject,
  type Schema,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { type Index, MemoryBackend, type Rows, Store, scan } from "@estoc/store";
import { assert, describe, expect, it } from "vitest";
import {
  type DeliveryData,
  type Inbox,
  inboundSchema,
  loadPost,
  MailboxKey,
  type Outbox,
  outboundSchema,
  type Post,
} from "../src/index.ts";
import { type Faults, MemoryNetwork } from "./memory-network.ts";

// A chat between two people, each with a store and a mailbox for the other.
// What one sends is a signed line from their store, recorded there as gone
// out; what arrives is kept with a record that it came in. The application
// reads a conversation out of those records alone, through an index of all
// that its user wrote, and reads each line from its bundle when it shows it.

const signatures = await loadSignatures(defaultValidator);
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
const schemas = [line, signatures.schema].map(({ bytes }) => bytes);
const delivery = (schema: JsonSchema): Promise<Schema<Json, DeliveryData>> => encodeSchema(schema, defaultValidator);
const [inbound, outbound] = await Promise.all([delivery(inboundSchema), delivery(outboundSchema)]);

type Direction = "inbound" | "outbound";
type Mailbox = Link<EncodedObject<Json>>;
type Delivered = [direction: Direction, mailbox: Mailbox, at: number, bundle: Link<never>];

// The application's index of the deliveries its user wrote: a row for each,
// by which way it went, the mailbox, when, and the bundle.
const deliveries: Index<Json, Delivered, DeliveryData> = {
  reads: [inbound, outbound],
  rows: ({ schema, data: { mailbox, at, bundle } }) => [
    [schema.link === inbound.link ? "inbound" : "outbound", mailbox.$link, at, bundle.$link],
  ],
};

async function all<T>(items: AsyncIterable<T>): Promise<T[]> {
  const gathered: T[] = [];
  for await (const item of items) gathered.push(item);
  return gathered;
}

// What came in at `mine` and went out to `theirs`, in the order of when. A
// bundle that came in, or went out, more than once is there once, at the
// first time: a range gives its rows in the order of when.
async function conversation(rows: Rows<Delivered>, mine: Mailbox, theirs: Mailbox): Promise<Delivered[]> {
  const first = async (range: AsyncIterable<Delivered>) => {
    const seen = new Set<Link<never>>();
    return (await all(range)).filter(([, , , bundle]) => {
      const fresh = !seen.has(bundle);
      seen.add(bundle);
      return fresh;
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
}

async function chat(faults: Faults = {}) {
  const network = await MemoryNetwork.create(defaultValidator, faults);
  const transports = [network.transport];
  // One clock for both, so that what one does reads as before what the other does next.
  let now = 0;
  const clock = () => ++now;
  const person = async (name: string, fill: number): Promise<Person> => {
    const signer = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(fill));
    const actor = signatures.actor(signer, await signatures.identities.publish(signer));
    const store = new Store(json, new MemoryBackend());
    return { name, actor, store, post: await loadPost(store, { transports, validator: defaultValidator, clock }) };
  };
  const alice = await person("Alice", 1);
  const bob = await person("Bob", 2);
  const names = new Map([alice, bob].map(({ name, actor }) => [actor.signedIdentity.identity.root.link, name]));

  // `owner` makes a mailbox for `peer` and hands it over. Each keeps it in
  // their store: the owner to receive at it, the peer to send to it.
  const mailboxFor = async (owner: Person, peer: Person, fill: number) => {
    const key = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(fill));
    const queue = network.queue();
    const mailbox = queue.mailbox(key.publicKey);
    for (const { store } of [owner, peer])
      await store.write({ mine: [mailbox], blobs: [network.transport.schema.bytes] });
    const inbox = await owner.post.inbox(mailbox.link, key);
    const outbox = await peer.post.outbox(mailbox.link);
    return { mailbox, inbox, outbox, take: queue.take };
  };
  const atAlice = await mailboxFor(alice, bob, 11);
  const atBob = await mailboxFor(bob, alice, 12);

  const say = async (from: Person, outbox: Outbox, text: string) => {
    const object = encodeObject(line, { text });
    const signature = await from.actor.sign(object);
    await from.store.write({
      mine: [signature],
      blobs: [object.bytes, ...signature.signedIdentity.blobs, ...schemas],
    });
    await outbox.send(signature.link);
    return signature;
  };
  const collect = async ({ inbox, take }: { inbox: Inbox; take: () => Uint8Array[] }) => {
    for (const sealed of take()) await inbox.receive(sealed);
  };

  // What the person sees of their conversation with the other: each line,
  // which way it went and who wrote it.
  const show = async (person: Person, mine: EncodedObject<Json>, theirs: EncodedObject<Json>) =>
    Promise.all(
      (await conversation(await scan(person.store, deliveries), mine.link, theirs.link)).map(
        async ([direction, , , bundle]) => {
          const signed = await signatures.read(bundle, person.store, noVersions);
          const { data } = await readObject(person.store, signed.object, line);
          return [direction, names.get(signed.signedIdentity.identity.root.link), data.text];
        },
      ),
    );
  // What the person's store records as having come in, or gone out, at any mailbox.
  const recorded = async ({ store }: Person, direction: Direction) =>
    all((await scan(store, deliveries)).range([direction]));

  return {
    alice: {
      say: (text: string) => say(alice, atBob.outbox, text),
      collect: () => collect(atAlice),
      show: () => show(alice, atAlice.mailbox, atBob.mailbox),
      recorded: (direction: Direction) => recorded(alice, direction),
      resend: (root: Link<unknown>) => atBob.outbox.send(root),
      store: alice.store,
      conversation: async (store: Store) =>
        conversation(await scan(store, deliveries), atAlice.mailbox.link, atBob.mailbox.link),
    },
    bob: {
      say: (text: string) => say(bob, atAlice.outbox, text),
      collect: () => collect(atBob),
      show: () => show(bob, atBob.mailbox, atAlice.mailbox),
      recorded: (direction: Direction) => recorded(bob, direction),
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

  it("shows a line that was lost and sent again once, when it first went out and when it came in", async () => {
    const { alice, bob } = await chat({ lost: (n) => n === 0 });
    const lost = await alice.say("hi Bob");
    await alice.say("lunch at noon?");
    await bob.collect();
    expect(await bob.show()).toEqual([["inbound", "Alice", "lunch at noon?"]]);

    await alice.resend(lost.link);
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

  it("reads the same when the records are added in another order and more than once", async () => {
    const { alice, bob } = await chat({ twice: true, reversed: true });
    await alice.say("hi Bob");
    await bob.collect();
    await bob.say("hi Alice");
    await alice.collect();

    // What Alice wrote, written again to another store, last first and twice.
    const copy = new Store(json, new MemoryBackend());
    const written = await all(alice.store.mine());
    for (const link of [...written, ...written].reverse()) {
      const closure = await alice.store.closure(link);
      const bytes = closure.get(link);
      assert.exists(bytes);
      await copy.write({ mine: [{ bytes }], blobs: closure.values() });
    }
    expect(await alice.conversation(copy)).toEqual(await alice.conversation(alice.store));
  });
});

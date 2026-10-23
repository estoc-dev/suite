import { SoftwareSigner } from "@estoc/identity";
import {
  decodeObject,
  encodeObject,
  encodeSchema,
  identitySchema,
  json,
  loadSignatures,
  signatureSchema,
  type EncodedObject,
  type Json,
  type Link,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { MemoryBackend, Store } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { loadPost, MailboxKey, type Delivery, type Inbox, type Outbox, type Post } from "../src/index.ts";
import { MemoryNetwork, type Faults } from "./memory-network.ts";

// A chat between two people, each with a store and a mailbox for the other.
// What one sends is a signed line from their store, recorded there as gone
// out; what arrives is kept with a record that it came in. The application
// reads a conversation out of those records alone, going through all that
// its user wrote, and reads each line from its bundle when it shows it.

const signatures = await loadSignatures(defaultValidator);
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const line = await encodeSchema(
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
const schemas = [line, ...(await Promise.all([identitySchema, signatureSchema].map((schema) => encodeSchema(schema, defaultValidator))))].map(
  ({ bytes }) => bytes,
);

type Entry = Omit<Delivery, "link">;

// What the application keeps of the deliveries it has read: when each bundle
// first came in at, or went out to, each mailbox. Deliveries can be added in
// any order and more than once, so going through all that is listed and
// adding each one as it is written come to the same.
class Correspondence {
  readonly #first = new Map<string, Entry>();

  add({ direction, mailbox, bundle, at }: Delivery): void {
    const key = `${direction} ${mailbox} ${bundle}`;
    const known = this.#first.get(key);
    if (known === undefined || at < known.at) this.#first.set(key, { direction, mailbox, bundle, at });
  }

  /** What came in at `mine` and went out to `theirs`, in the order of when. */
  conversation(mine: Link<unknown>, theirs: Link<unknown>): Entry[] {
    return [...this.#first.values()]
      .filter(({ direction, mailbox }) => mailbox === (direction === "inbound" ? mine : theirs))
      .sort((a, b) => a.at - b.at);
  }
}

interface Person {
  readonly name: string;
  readonly signer: SoftwareSigner;
  readonly store: Store;
  readonly post: Post;
}

async function deliveries({ store, post }: Person): Promise<Delivery[]> {
  const read: Delivery[] = [];
  for await (const link of store.mine()) {
    const delivery = await post.read(link);
    if (delivery !== undefined) read.push(delivery);
  }
  return read;
}

function correspondence(read: Iterable<Delivery>): Correspondence {
  const kept = new Correspondence();
  for (const delivery of read) kept.add(delivery);
  return kept;
}

async function chat(faults: Faults = {}) {
  const network = await MemoryNetwork.create(defaultValidator, faults);
  const transports = [network.transport];
  // One clock for both, so that what one does reads as before what the other does next.
  let now = 0;
  const clock = () => ++now;
  const person = async (name: string, fill: number): Promise<Person> => {
    const signer = SoftwareSigner.fromSecretKey("ed25519", new Uint8Array(32).fill(fill));
    const store = new Store(json, new MemoryBackend());
    return { name, signer, store, post: await loadPost(store, { transports, validator: defaultValidator, clock }) };
  };
  const alice = await person("Alice", 1);
  const bob = await person("Bob", 2);
  const names = new Map([alice, bob].map(({ name, signer }) => [signatures.identities.encode(signer.identity).link, name]));

  // `owner` makes a mailbox for `peer` and hands it over. Each keeps it in
  // their store: the owner to receive at it, the peer to send to it.
  const mailboxFor = async (owner: Person, peer: Person, fill: number) => {
    const key = await MailboxKey.fromSecretKey(new Uint8Array(32).fill(fill));
    const queue = network.queue();
    const mailbox = queue.mailbox(key.publicKey);
    for (const { store } of [owner, peer]) await store.write({ mine: [mailbox], blobs: [network.transport.schema.bytes] });
    const inbox = await owner.post.inbox(mailbox.link, key);
    const outbox = await peer.post.outbox(mailbox.link);
    return { mailbox, inbox, outbox, take: queue.take };
  };
  const atAlice = await mailboxFor(alice, bob, 11);
  const atBob = await mailboxFor(bob, alice, 12);

  const say = async (from: Person, outbox: Outbox, text: string) => {
    const object = encodeObject(line, { text });
    const signature = await signatures.sign(object, from.signer);
    await from.store.write({ mine: [signature], blobs: [object.bytes, signature.identity.bytes, ...schemas] });
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
      correspondence(await deliveries(person))
        .conversation(mine.link, theirs.link)
        .map(async ({ direction, bundle }) => {
          const signed = await person.store.read(signatures, bundle);
          const { data } = decodeObject((await person.store.get(signed.object))!, line);
          return [direction, names.get(signed.identity.link), (data as { text: string }).text];
        }),
    );

  return {
    alice: {
      say: (text: string) => say(alice, atBob.outbox, text),
      collect: () => collect(atAlice),
      show: () => show(alice, atAlice.mailbox, atBob.mailbox),
      deliveries: () => deliveries(alice),
      resend: (root: Link<unknown>) => atBob.outbox.send(root),
    },
    bob: {
      say: (text: string) => say(bob, atAlice.outbox, text),
      collect: () => collect(atBob),
      show: () => show(bob, atBob.mailbox, atAlice.mailbox),
      deliveries: () => deliveries(bob),
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

    expect((await bob.deliveries()).filter(({ direction }) => direction === "inbound")).toHaveLength(4);
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
    expect((await alice.deliveries()).filter(({ direction }) => direction === "outbound")).toHaveLength(3);
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

    const read = await alice.deliveries();
    const at = (direction: Delivery["direction"]) => read.find((delivery) => delivery.direction === direction)!.mailbox;
    const [mine, theirs] = [at("inbound"), at("outbound")];
    expect(correspondence([...read, ...read].reverse()).conversation(mine, theirs)).toEqual(
      correspondence(read).conversation(mine, theirs),
    );
  });
});

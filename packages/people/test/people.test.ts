import { ed25519, loadIdentity, SoftwareSigner } from "@estoc/identity";
import { encodeObject, LinkValue } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { MemoryBackend, Store, scan, view } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { checkHonors, peopleView } from "../src/index.ts";
import { identityVersionInHand } from "./fixtures.ts";

const { signatures, signedIdentities, publish } = loadIdentity([ed25519]);
const note = schema("Note", { text: string() });

describe("the index of the people of a store", () => {
  it("gives no row of a signed identity that its root did not sign, and lists it among the failures", async () => {
    const alice = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
    const first = await publish(alice, { at: 1_000 });
    const second = await publish(alice, { prior: first, at: 2_000 });
    const forged = encodeObject(signedIdentities.schema, {
      identity: new LinkValue(second.identity.link),
      signature: new Uint8Array(64),
    });
    const store = new Store(new MemoryBackend());
    await store.write({ roots: [second.link, forged.link], blobs: [...second.blobs, forged.bytes] });

    const people = peopleView({ signedIdentities });
    const rows = await scan(store, people.index);
    const signedIdentitiesOfRows = [];
    for await (const { data } of rows.range([])) signedIdentitiesOfRows.push(data.signedIdentity.link);
    expect(signedIdentitiesOfRows).toEqual([first.link, second.link]);
    expect(rows.failures.map(({ item }) => item)).toEqual([forged.link]);
    expect((await (await view(store, people)).current(first)).link).toBe(second.link);
  });
});

describe("a person of a store, found by their identifier", () => {
  const root = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));

  it("has as current the latest identity version the store holds", async () => {
    const published = await publish(root, { at: 1_000 });
    const later = await publish(root, { prior: published, at: 2_000 });
    const store = new Store(new MemoryBackend());
    await store.write({ roots: [later.link], blobs: [...later.blobs] });

    const people = await view(store, peopleView({ signedIdentities }));
    const person = await people.personIdentifiedBy(published.identity.identifier);
    expect(person?.identifier).toBe(published.identity.identifier);
    expect((await person?.identityVersions())?.map(({ link }) => link)).toEqual([published.link, later.link]);
    expect((await person?.current())?.link).toBe(later.link);
  });

  it("has as current the crisis among the identity versions the store holds", async () => {
    const published = await publish(root, { at: 1_000 });
    const crisis = await publish(root, { prior: published, isCrisis: true, at: 2_000 });
    const store = new Store(new MemoryBackend());
    await store.write({ roots: [crisis.link], blobs: [...crisis.blobs] });

    const people = await view(store, peopleView({ signedIdentities }));
    expect((await (await people.personIdentifiedBy(published.identity.identifier))?.current())?.link).toBe(crisis.link);
  });

  it("is not found when the store holds none of their identity versions", async () => {
    const other = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(9));
    const published = await publish(root, { at: 1_000 });
    const ofOther = await publish(other, { at: 2_000 });
    const store = new Store(new MemoryBackend());
    await store.write({ roots: [ofOther.link], blobs: [...ofOther.blobs] });

    const people = await view(store, peopleView({ signedIdentities }));
    expect(await people.personIdentifiedBy(published.identity.identifier)).toBeUndefined();
  });
});

describe("a signature by an agent, checked against the people of a store", () => {
  const root = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
  const agent = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));

  it("is honored when the current identity version the store holds lists the agent", async () => {
    const listing = await publish(root, { agents: [agent.key], at: 1_000 });
    const byAgent = await signatures
      .actor(agent, listing, identityVersionInHand)
      .sign(encodeObject(note, { text: "hello" }));
    const store = new Store(new MemoryBackend());
    await store.write({ roots: [listing.link], blobs: [...listing.blobs] });

    await expect(checkHonors(await view(store, peopleView({ signedIdentities })), byAgent)).resolves.toBeUndefined();
  });

  it("is refused, with its key and the identifier named, when the current identity version the store holds does not list the agent", async () => {
    const listing = await publish(root, { agents: [agent.key], at: 1_000 });
    const byAgent = await signatures
      .actor(agent, listing, identityVersionInHand)
      .sign(encodeObject(note, { text: "hello" }));
    const withoutAgent = await publish(root, { prior: listing, at: 2_000 });
    const store = new Store(new MemoryBackend());
    await store.write({ roots: [withoutAgent.link], blobs: [...withoutAgent.blobs] });

    await expect(checkHonors(await view(store, peopleView({ signedIdentities })), byAgent)).rejects.toThrow(
      `the signature by ${byAgent.key.link} is not honored by the identity versions of ${listing.identity.identifier}`,
    );
  });
});

describe("an actor that asks the people of a store", () => {
  const root = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
  const agent = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2));
  const hello = encodeObject(note, { text: "hello" });

  it("signs by an identity version the store takes in after the actor is made", async () => {
    const listing = await publish(root, { agents: [agent.key], at: 1_000 });
    const store = new Store(new MemoryBackend());
    const seenPeople = peopleView({ signedIdentities });
    const actor = signatures.actor(agent, listing, async (inHand) => (await view(store, seenPeople)).current(inHand));
    expect((await actor.sign(hello)).signedIdentity.link).toBe(listing.link);

    const later = await publish(root, { prior: listing, agents: [agent.key], at: 2_000 });
    await store.write({ roots: [later.link], blobs: [...later.blobs] });
    const signature = await actor.sign(hello);
    expect(signature.signedIdentity.link).toBe(later.link);
    expect(await (await view(store, seenPeople)).honors(signature)).toBe(true);
  });

  it("signs nothing once the store takes in an identity version that does not list its key", async () => {
    const listing = await publish(root, { agents: [agent.key], at: 1_000 });
    const store = new Store(new MemoryBackend());
    const seenPeople = peopleView({ signedIdentities });
    const actor = signatures.actor(agent, listing, async (inHand) => (await view(store, seenPeople)).current(inHand));
    const withoutAgent = await publish(root, { prior: listing, at: 2_000 });
    await store.write({ roots: [withoutAgent.link], blobs: [...withoutAgent.blobs] });

    await expect(actor.sign(hello)).rejects.toThrow(`the signer's key does not sign for ${withoutAgent.identity.link}`);
  });
});

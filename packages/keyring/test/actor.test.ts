import { ed25519, identityKit, isSameKey, type SignedIdentityObject, SoftwareSigner } from "@estoc/identity";
import { encodeObject } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { MemoryBackend, Store } from "@estoc/store";
import { describe, expect, it } from "vitest";
import { actorFor, Keyring } from "../src/index.ts";

const { publish, secretKeys } = identityKit;
const note = encodeObject(schema("Note", { text: string() }), { text: "hello" });

// A root that no store holds, as a wallet is.
const wallet = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(1));
const keyOutside = SoftwareSigner.fromSecretKey(ed25519, new Uint8Array(32).fill(2)).key;

const newStore = () => new Store(new MemoryBackend());

const hold = (store: Store, { link, blobs }: SignedIdentityObject) => store.write({ roots: [link], blobs });

const generateKey = (store: Store) => new Keyring(store, secretKeys).generate(ed25519);

// A signer for a key whose Secret Key `store` records.
async function generateSigner(store: Store) {
  const keyring = new Keyring(store, secretKeys);
  const signer = await keyring.signerFor((await keyring.generate(ed25519)).link);
  if (signer === undefined) throw new Error("a keyring signs with a key it generated");
  return signer;
}

describe("the actor for a signed identity", () => {
  it("signs as that identity, by its root when the store records the Secret Key of it", async () => {
    const store = newStore();
    const root = await generateSigner(store);
    const agent = await generateKey(store);
    const signedIdentity = await publish(root, { agents: [agent], at: 0 });
    await hold(store, signedIdentity);

    const actor = await actorFor(signedIdentity.link, store);
    expect(actor.identifier).toBe(signedIdentity.identity.identifier);
    const signature = await actor.sign(note);
    expect(signature.signedIdentity.link).toBe(signedIdentity.link);
    expect(signature.key.link).toBe(signedIdentity.identity.root.link);
    expect(signature.object).toBe(note.link);
  });

  it("signs by the first agent listed whose Secret Key the store records, when it records none of the root", async () => {
    const store = newStore();
    const [first, second] = [await generateKey(store), await generateKey(store)];
    const signedIdentity = await publish(wallet, { agents: [keyOutside, first, second], at: 0 });
    await hold(store, signedIdentity);

    const signature = await (await actorFor(signedIdentity.link, store)).sign(note);
    expect(isSameKey(signature.key, first)).toBe(true);
  });

  it("signs by a key of the identity version that is current, where the one given is one that it follows", async () => {
    const store = newStore();
    const [former, current] = [await generateKey(store), await generateKey(store)];
    const listing = await publish(wallet, { agents: [former], at: 1_000 });
    const removal = await publish(wallet, { prior: listing, agents: [current], at: 2_000 });
    await hold(store, removal);

    const signature = await (await actorFor(listing.link, store)).sign(note);
    expect(signature.signedIdentity.link).toBe(removal.link);
    expect(isSameKey(signature.key, current)).toBe(true);
  });

  it("is not made when the store records the Secret Key of no key that the current identity version lists", async () => {
    const store = newStore();
    const former = await generateKey(store);
    const listing = await publish(wallet, { agents: [former], at: 1_000 });
    const removal = await publish(wallet, { prior: listing, agents: [keyOutside], at: 2_000 });
    await hold(store, removal);

    await expect(actorFor(listing.link, store)).rejects.toThrow(removal.link);
  });

  it("does not sign once the store holds an identity version that leaves out the key it was made with", async () => {
    const store = newStore();
    const former = await generateKey(store);
    const listing = await publish(wallet, { agents: [former], at: 1_000 });
    await hold(store, listing);
    const actor = await actorFor(listing.link, store);
    await actor.sign(note);

    const removal = await publish(wallet, { prior: listing, agents: [keyOutside], at: 2_000 });
    await hold(store, removal);
    await expect(actor.sign(note)).rejects.toThrow(removal.identity.link);
  });
});

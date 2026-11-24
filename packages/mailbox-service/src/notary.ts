import { type Actor, identityKit, type Signature, type SignedIdentityObject, type Signer } from "@estoc/identity";
import type { Keyring } from "@estoc/keyring";
import { type Bytes, type EncodedObject, type Link, LinkValue } from "@estoc/object";
import { type People, peopleView } from "@estoc/people";
import type { DataOf } from "@estoc/schema";
import { type Store, type View, view, writtenObjectsOf } from "@estoc/store";
import { recordedIdentityVersions } from "./recorded-identity-versions.ts";
import { recordedSignatures } from "./recorded-signatures.ts";

const { publish, signatures, signedIdentities } = identityKit;

/**
 * It records what it signs, which is how a service tells its own signatures from ones that only
 * came to its store.
 */
class Notary {
  readonly #actor: Actor;
  readonly #store: Store;
  readonly #clock: () => number;

  constructor(actor: Actor, store: Store, clock: () => number) {
    this.#actor = actor;
    this.#store = store;
    this.#clock = clock;
  }

  get identifier(): Link<unknown> {
    return this.#actor.identifier;
  }

  /** `blobs` hold what the closure of `object` takes besides the object and its schema. */
  async sign(object: EncodedObject, blobs: readonly Bytes<unknown>[] = []): Promise<Signature> {
    const signature = await this.#actor.sign(object);
    await this.#write(signature, [object.bytes, ...object.schema.blobs, ...blobs]);
    return signature;
  }

  async renew(link: Link<unknown>, people: People): Promise<Link<unknown>> {
    const signature = await signatures.read(link, this.#store);
    if (await people.honors(signature)) return link;
    const recordedLinks = await (await view(this.#store, recordedSignaturesView)).signaturesOver(signature.object);
    for (const recordedLink of recordedLinks) {
      if (recordedLink === link) continue;
      const recordedSignature = await signatures.read(recordedLink, this.#store);
      if (await people.honors(recordedSignature)) return recordedLink;
    }
    const renewedSignature = await this.#actor.sign({ link: signature.object });
    await this.#write(renewedSignature);
    return renewedSignature.link;
  }

  async #write(signature: Signature, blobs: readonly Bytes<unknown>[] = []): Promise<void> {
    await this.#store.write({ roots: [signature.link], blobs: [...signature.blobs, ...blobs] });
    await this.#store.record(writtenObjectsOf([signature.link], this.#clock()));
  }
}

export type { Notary };

/**
 * Signs the first identity version of `root` unless the store holds one, and records the current
 * one, so that a notary loaded over that store signs as that identity.
 */
export async function setUpNotary(
  keyring: Pick<Keyring, "signerFor">,
  root: Link<unknown>,
  { store, at }: { readonly store: Store; readonly at: number },
): Promise<SignedIdentityObject> {
  const person = await (await view(store, peopleView)).personIdentifiedBy(root);
  const signedIdentity = (await person?.current()) ?? (await publish(await rootSigner(keyring, root), { at }));
  await store.write({ roots: [signedIdentity.link], blobs: signedIdentity.blobs });
  await store.record(writtenObjectsOf([signedIdentity.link], at));
  return signedIdentity;
}

export async function loadNotary(
  keyring: Pick<Keyring, "signerFor">,
  { store, clock }: { readonly store: Store; readonly clock: () => number },
): Promise<Notary> {
  const recorded = await (await view(store, recordedIdentityView)).signedIdentity();
  const currentOf = async (inHand: SignedIdentityObject) => (await view(store, peopleView)).current(inHand);
  const signer = await rootSigner(keyring, recorded.identity.root.link);
  return new Notary(signatures.actor(signer, recorded, currentOf), store, clock);
}

/**
 * The root is the one key that each identity version lists, so a version that the store takes in
 * while the service runs still lists the key that a notary signs by.
 */
async function rootSigner(keyring: Pick<Keyring, "signerFor">, root: Link<unknown>): Promise<Signer> {
  const signer = await keyring.signerFor(root);
  if (signer === undefined) throw new Error(`the keyring does not hold the Secret Key of ${root}`);
  return signer;
}

const recordedIdentityView: View<
  DataOf<typeof recordedIdentityVersions.rowSchema>,
  typeof recordedIdentityVersions.order,
  { signedIdentity(): Promise<SignedIdentityObject> }
> = {
  index: recordedIdentityVersions,
  read: (rows, reader) => ({
    async signedIdentity() {
      const identifiers = new Set<Link<unknown>>();
      let recorded: Link<unknown> | undefined;
      for await (const { data } of rows.range([])) {
        identifiers.add(data.identifier.link);
        recorded = data.signedIdentity.link;
      }
      if (recorded === undefined || identifiers.size > 1)
        throw new Error(
          `the store records identity versions of ${identifiers.size} identities, where a service takes one`,
        );
      return signedIdentities.read(recorded, reader);
    },
  }),
};

const recordedSignaturesView: View<
  DataOf<typeof recordedSignatures.rowSchema>,
  typeof recordedSignatures.order,
  { signaturesOver(object: Link<unknown>): Promise<Link<unknown>[]> }
> = {
  index: recordedSignatures,
  read: (rows) => ({
    async signaturesOver(object) {
      const links: Link<unknown>[] = [];
      for await (const { data } of rows.range([new LinkValue(object)])) links.push(data.signature.link);
      return links;
    },
  }),
};

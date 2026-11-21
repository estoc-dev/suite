import type {
  Actor,
  IdentityKit,
  Signature,
  Signatures,
  SignedIdentities,
  SignedIdentityObject,
  Signer,
} from "@estoc/identity";
import type { Keyring } from "@estoc/keyring";
import { type Bytes, type EncodedObject, type Link, LinkValue, objectsOf } from "@estoc/object";
import { type People, type PeopleView, peopleView } from "@estoc/people";
import { type DataOf, link, schema } from "@estoc/schema";
import { indexOver, type Store, selectedWrittenObjects, type View, view, writtenObjectsOf } from "@estoc/store";

type NotaryOptions = { readonly kit: IdentityKit; readonly store: Store };

/**
 * It records what it signs, which is how a service tells its own signatures from ones that only
 * came to its store.
 */
class Notary {
  readonly #actor: Actor;
  readonly #signatures: Signatures;
  readonly #recordedSignatures: RecordedSignaturesView;
  readonly #store: Store;
  readonly #clock: () => number;

  constructor(actor: Actor, { kit, store, clock }: NotaryOptions & { readonly clock: () => number }) {
    this.#actor = actor;
    this.#signatures = kit.signatures;
    this.#recordedSignatures = recordedSignaturesView(kit.signatures);
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
    const signature = await this.#signatures.read(link, this.#store);
    if (await people.honors(signature)) return link;
    const recordedSignatures = await view(this.#store, this.#recordedSignatures);
    for (const recordedLink of await recordedSignatures.signaturesOver(signature.object)) {
      if (recordedLink === link) continue;
      const recordedSignature = await this.#signatures.read(recordedLink, this.#store);
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
  { kit, store, at }: NotaryOptions & { readonly at: number },
): Promise<SignedIdentityObject> {
  const person = await (await view(store, peopleView(kit))).personIdentifiedBy(root);
  const signedIdentity = (await person?.current()) ?? (await kit.publish(await rootSigner(keyring, root), { at }));
  await store.write({ roots: [signedIdentity.link], blobs: signedIdentity.blobs });
  await store.record(writtenObjectsOf([signedIdentity.link], at));
  return signedIdentity;
}

export async function loadNotary(
  keyring: Pick<Keyring, "signerFor">,
  { people, clock, ...options }: NotaryOptions & { readonly people: PeopleView; readonly clock: () => number },
): Promise<Notary> {
  const { kit, store } = options;
  const recorded = await (await view(store, recordedIdentityView(kit.signedIdentities))).signedIdentity();
  const currentOf = async (inHand: SignedIdentityObject) => (await view(store, people)).current(inHand);
  const signer = await rootSigner(keyring, recorded.identity.root.link);
  return new Notary(kit.signatures.actor(signer, recorded, currentOf), { ...options, clock });
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

const recordedIdentitySchema = schema("Recorded identity version", { identifier: link(), signedIdentity: link() });

type RecordedIdentityView = View<
  DataOf<typeof recordedIdentitySchema>,
  readonly ["identifier", "signedIdentity"],
  { signedIdentity(): Promise<SignedIdentityObject> }
>;

function recordedIdentityView(signedIdentities: SignedIdentities): RecordedIdentityView {
  return {
    index: indexOver(
      selectedWrittenObjects(objectsOf(signedIdentities.schema)),
      recordedIdentitySchema,
      async function* (object, reader) {
        const { identifier } = (await signedIdentities.verify(object, reader)).identity;
        yield { identifier: new LinkValue(identifier), signedIdentity: new LinkValue(object.link) };
      },
    ).orderedBy("identifier", "signedIdentity"),
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
}

const recordedSignatureSchema = schema("Recorded signature", { object: link(), signature: link() });

type RecordedSignaturesView = View<
  DataOf<typeof recordedSignatureSchema>,
  readonly ["object", "signature"],
  { signaturesOver(object: Link<unknown>): Promise<Link<unknown>[]> }
>;

/** A signature that the store holds may have no record, as when a write stopped between the two. */
function recordedSignaturesView(signatures: Signatures): RecordedSignaturesView {
  return {
    index: indexOver(
      selectedWrittenObjects(objectsOf(signatures.schema)),
      recordedSignatureSchema,
      ({ link, data }) => [{ object: new LinkValue(data.object.link), signature: new LinkValue(link) }],
    ).orderedBy("object", "signature"),
    read: (rows) => ({
      async signaturesOver(object) {
        const links: Link<unknown>[] = [];
        for await (const { data } of rows.range([new LinkValue(object)])) links.push(data.signature.link);
        return links;
      },
    }),
  };
}

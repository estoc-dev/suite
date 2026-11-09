import {
  hasSigner,
  type IdentityKit,
  type IdentityVersion,
  type KeyObject,
  noVersions,
  type People,
  type Signature,
  type SignatureOver,
  type SignedIdentityObject,
} from "@estoc/identity";
import {
  type EncodedObject,
  encodeObject,
  encodeSchema,
  type Json,
  type JsonSchemaValidator,
  type Link,
  objectsOf,
  type Reader,
  readObject,
  type Schema,
} from "@estoc/object";
import { type InboundData, inboundSchema, indexOver, type Rows, type View } from "@estoc/store";
import { type MailboxGrantData, mailboxGrantSchema } from "./schema.ts";

/**
 * A Mailbox Grant as a row: the root of whoever signed it, the root of the signed identity it is
 * to, its `at`, the link of the signature, and since when the store holds it.
 *
 * - The grants of one root to another are a series, and its rows, in the order of their keys, end
 *   with the latest.
 * - Two grants of a series at one `at` are told apart by the links of their signatures, as two
 *   versions of an identity are.
 * - A grant that came in is held since the `at` of its `Inbound`, by the clock of the device that
 *   wrote that record, which the signer cannot change. A grant written as a record is held since
 *   its own `at`, as only the user writes records.
 */
export type MailboxGrantRow = readonly [
  from: Link<KeyObject>,
  to: Link<KeyObject>,
  at: number,
  signature: Link<Signature>,
  heldSince: number,
];

/** A Mailbox Grant read from a store, with the signature over it, verified, and the signed identity it is to. */
export interface MailboxGrant {
  readonly object: EncodedObject<Json, MailboxGrantData>;
  readonly signature: Signature;
  readonly to: SignedIdentityObject;
}

/** The latest Mailbox Grant of each series that a store holds. */
export interface LatestGrants {
  /**
   * The latest grant that `from` signed to `to`, by the links of their roots, of those that count
   * by the versions `people` has seen, or `undefined` when none does.
   *
   * - A grant signed by a key that the current version lists counts, and comes before any signed
   *   by a key that it does not list, whatever their `at`s.
   * - A grant signed by a key that the current version does not list counts when the store held it
   *   before the `at` of the version that removed the key.
   */
  grantFrom(from: Link<KeyObject>, to: Link<KeyObject>, people: People): Promise<MailboxGrant | undefined>;
}

type SignatureReading = Pick<IdentityKit, "signatures" | "signedIdentities" | "versions">;

/**
 * Mailbox Grants: writing one for a signer to sign, and reading the latest of each series from a
 * store.
 *
 * - A grant reaches `latest` as a signature over it, either written as a record or as the root of
 *   a bundle that an `Inbound` record says came in.
 * - Each signature is verified by the signed identity it carries, as by `noVersions`, and whether
 *   its key still counts is worked out by `grantFrom`.
 * - A bundle that came in and does not read as a grant gives no row, since anyone can send a
 *   bundle to a mailbox.
 * - The scan still fails when the store fails to give a blob of that bundle, so a later scan of
 *   the index reads it again.
 */
export class MailboxGrants {
  readonly schema: Schema<Json, MailboxGrantData>;
  /** The latest grant of each series. Its index is made once, with the grants, so a store keeps its rows between scans. */
  readonly latest: View<MailboxGrantRow, LatestGrants>;
  /**
   * The people of the versions that a store has seen in its grants and in what came in: the
   * version a signature carries, for a signature over a grant written as a record or at the root
   * of a bundle, and a signed identity at the root of a bundle.
   */
  readonly people: View<IdentityVersion, People>;
  readonly #identity: SignatureReading;

  constructor(schema: Schema<Json, MailboxGrantData>, inbound: Schema<Json, InboundData>, identity: SignatureReading) {
    this.schema = schema;
    this.#identity = identity;
    const { signatures, signedIdentities, versions } = identity;
    const grants = signatures.selectionOver(schema);
    const rowOf = (grant: SignatureOver<MailboxGrantData>, heldSince: number, reader: Reader) =>
      this.#rowOf(grant, heldSince, reader);
    const recordedGrants = indexOver(grants, async function* (grant, reader) {
      yield await rowOf(grant, grant.object.data.at, reader);
    });
    const receivedGrants = indexOver(objectsOf(inbound), async function* ({ data }, reader) {
      let row: MailboxGrantRow | undefined;
      try {
        const grant = await grants.read(data.bundle.$link, reader);
        row = grant === undefined ? undefined : await rowOf(grant, data.at, reader);
      } catch {
        return;
      }
      if (row !== undefined) yield row;
    });
    this.latest = { index: recordedGrants.union(receivedGrants), read: (rows, reader) => this.#latestOf(rows, reader) };

    const versionOf = async (link: Link<SignedIdentityObject>, reader: Reader) =>
      versions.versionOf(await signedIdentities.read(link, reader));
    const signatureObjects = objectsOf(signatures.schema);
    const recordedVersions = indexOver(grants, async function* ({ signature }, reader) {
      yield await versionOf(signature.data.signedIdentity.$link, reader);
    });
    const receivedVersions = indexOver(objectsOf(inbound), async function* ({ data }, reader) {
      let version: IdentityVersion;
      try {
        const signature = await signatureObjects.read(data.bundle.$link, reader);
        version = await versionOf(signature?.data.signedIdentity.$link ?? data.bundle.$link, reader);
      } catch {
        return;
      }
      yield version;
    });
    this.people = {
      index: recordedVersions.union(receivedVersions),
      read: (rows, reader) => versions.people(rows, reader),
    };
  }

  /** The grant of `mailboxes` to `to`, at `at`, for whoever gives it to sign. */
  encode(
    to: SignedIdentityObject,
    mailboxes: readonly Link<EncodedObject<Json>>[],
    at: number,
  ): EncodedObject<Json, MailboxGrantData> {
    return encodeObject(this.schema, { to: { $link: to.link }, mailboxes: mailboxes.map(($link) => ({ $link })), at });
  }

  async #rowOf(
    { signature, object }: SignatureOver<MailboxGrantData>,
    heldSince: number,
    reader: Reader,
  ): Promise<MailboxGrantRow> {
    const { signatures, signedIdentities } = this.#identity;
    const { signedIdentity, link } = await signatures.verify(signature, reader, noVersions);
    const to = await signedIdentities.read(object.data.to.$link, reader);
    return [signedIdentity.identity.root.link, to.identity.root.link, object.data.at, link, heldSince];
  }

  #latestOf(rows: Rows<MailboxGrantRow>, reader: Reader): LatestGrants {
    return {
      grantFrom: async (from, to, people) => {
        let byListedKey: Link<Signature> | undefined;
        let byRemovedKey: Link<Signature> | undefined;
        for await (const [, , , link, heldSince] of rows.range([from, to])) {
          const { signedIdentity, key } = await this.#identity.signatures.read(link, reader, noVersions);
          const removal = removalOf(key, await people.personOf(signedIdentity).versions());
          if (removal === undefined) byListedKey = link;
          else if (heldSince < removal.identity.data.at) byRemovedKey = link;
        }
        const link = byListedKey ?? byRemovedKey;
        return link === undefined ? undefined : this.#read(link, reader);
      },
    };
  }

  async #read(link: Link<Signature>, reader: Reader): Promise<MailboxGrant> {
    const { signatures, signedIdentities } = this.#identity;
    const signature = await signatures.read(link, reader, noVersions);
    const object = await readObject(reader, signature.object, this.schema);
    return { object, signature, to: await signedIdentities.read(object.data.to.$link, reader) };
  }
}

/**
 * The version that removed `key`, of `versions` in their order: the first after the last that lists
 * it, or `undefined` when the last lists it.
 */
function removalOf(key: KeyObject, versions: readonly SignedIdentityObject[]): SignedIdentityObject | undefined {
  let removal: SignedIdentityObject | undefined;
  for (const version of versions) {
    if (hasSigner(version.identity, key)) removal = undefined;
    else removal ??= version;
  }
  return removal;
}

/**
 * Mailbox Grants with their schema compiled by `validator`, whose signatures and signed identities
 * are read with `identity`.
 */
export async function loadMailboxGrants(
  validator: JsonSchemaValidator,
  identity: SignatureReading,
): Promise<MailboxGrants> {
  const schema: Schema<Json, MailboxGrantData> = await encodeSchema(mailboxGrantSchema, validator);
  const inbound: Schema<Json, InboundData> = await encodeSchema(inboundSchema, validator);
  return new MailboxGrants(schema, inbound, identity);
}

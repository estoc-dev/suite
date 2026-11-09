import {
  hasSigner,
  type IdentityKit,
  type KeyObject,
  noIdentityVersions,
  type SeenIdentityVersions,
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
 * to, its `at`, and the link of the signature.
 *
 * - The grants of one root to another are a series, whose rows are in the order of their `at`.
 * - Two grants of a series at one `at` are told apart by the links of their signatures, as two
 *   identity versions are.
 */
export type MailboxGrantRow = readonly [
  from: Link<KeyObject>,
  to: Link<KeyObject>,
  at: number,
  signature: Link<Signature>,
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
   * The latest grant that `from` signed to `to`, by the links of their roots, whose key signs for
   * the current identity version that `seenIdentityVersions` gives, or `undefined` when there is
   * none.
   */
  grantFrom(
    from: Link<KeyObject>,
    to: Link<KeyObject>,
    seenIdentityVersions: SeenIdentityVersions,
  ): Promise<MailboxGrant | undefined>;
}

type SignatureReading = Pick<IdentityKit, "signatures" | "signedIdentities">;

/**
 * Mailbox Grants: writing one for a signer to sign, and reading the latest of each series from a
 * store.
 *
 * - A grant reaches `latest` as a signature over it, either written as a record or as the root of
 *   a bundle that an `Inbound` record says came in.
 * - Each signature is verified by the signed identity it carries, as by `noIdentityVersions`, and
 *   `grantFrom` says whether that identity version still counts.
 * - A bundle that came in and does not read as a grant gives no row, since anyone can send a
 *   bundle to a mailbox.
 * - The scan still fails when the store fails to give a blob of that bundle, so a later scan of
 *   the index reads it again.
 */
export class MailboxGrants {
  readonly schema: Schema<Json, MailboxGrantData>;
  /** The latest grant of each series. Its index is made once, with the grants, so a store keeps its rows between scans. */
  readonly latest: View<MailboxGrantRow, LatestGrants>;
  readonly #identity: SignatureReading;

  constructor(schema: Schema<Json, MailboxGrantData>, inbound: Schema<Json, InboundData>, identity: SignatureReading) {
    this.schema = schema;
    this.#identity = identity;
    const grants = identity.signatures.selectionOver(schema);
    const rowOf = (grant: SignatureOver<MailboxGrantData>, reader: Reader) => this.#rowOf(grant, reader);
    const recordedGrants = indexOver(grants, async function* (grant, reader) {
      yield await rowOf(grant, reader);
    });
    const receivedGrants = indexOver(objectsOf(inbound), async function* ({ data }, reader) {
      let row: MailboxGrantRow | undefined;
      try {
        const grant = await grants.read(data.bundle.$link, reader);
        row = grant === undefined ? undefined : await rowOf(grant, reader);
      } catch {
        return;
      }
      if (row !== undefined) yield row;
    });
    this.latest = { index: recordedGrants.union(receivedGrants), read: (rows, reader) => this.#latestOf(rows, reader) };
  }

  /** The grant of `mailboxes` to `to`, at `at`, for whoever gives it to sign. */
  encode(
    to: SignedIdentityObject,
    mailboxes: readonly Link<EncodedObject<Json>>[],
    at: number,
  ): EncodedObject<Json, MailboxGrantData> {
    return encodeObject(this.schema, { to: { $link: to.link }, mailboxes: mailboxes.map(($link) => ({ $link })), at });
  }

  async #rowOf({ signature, object }: SignatureOver<MailboxGrantData>, reader: Reader): Promise<MailboxGrantRow> {
    const { signatures, signedIdentities } = this.#identity;
    const { signedIdentity, link } = await signatures.verify(signature, reader, noIdentityVersions);
    const to = await signedIdentities.read(object.data.to.$link, reader);
    return [signedIdentity.identity.root.link, to.identity.root.link, object.data.at, link];
  }

  #latestOf(rows: Rows<MailboxGrantRow>, reader: Reader): LatestGrants {
    return {
      grantFrom: async (from, to, seenIdentityVersions) => {
        let latest: Signature | undefined;
        for await (const [, , , link] of rows.range([from, to])) {
          const signature = await this.#identity.signatures.read(link, reader, noIdentityVersions);
          const current = await seenIdentityVersions.current(signature.signedIdentity);
          if (hasSigner(current.identity, signature.key)) latest = signature;
        }
        return latest === undefined ? undefined : this.#grantOf(latest, reader);
      },
    };
  }

  async #grantOf(signature: Signature, reader: Reader): Promise<MailboxGrant> {
    const object = await readObject(reader, signature.object, this.schema);
    return { object, signature, to: await this.#identity.signedIdentities.read(object.data.to.$link, reader) };
  }
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

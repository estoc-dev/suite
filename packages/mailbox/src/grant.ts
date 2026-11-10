import {
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
  type Reader,
  readObject,
  type Schema,
} from "@estoc/object";
import { indexOverBlobs, type Rows, type View } from "@estoc/store";
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

/** The Mailbox Grants of each series that a store holds. */
export interface GrantSeries {
  /**
   * The grants that `from` signed to `to`, by the links of their roots, that count by
   * `seenIdentityVersions`, in the order of the series.
   */
  grantsFrom(
    from: Link<KeyObject>,
    to: Link<KeyObject>,
    seenIdentityVersions: SeenIdentityVersions,
  ): AsyncIterable<MailboxGrant>;
  /** The last of `grantsFrom`, which is the latest grant, or `undefined` when there is none. */
  grantFrom(
    from: Link<KeyObject>,
    to: Link<KeyObject>,
    seenIdentityVersions: SeenIdentityVersions,
  ): Promise<MailboxGrant | undefined>;
}

type SignatureReading = Pick<IdentityKit, "signatures" | "signedIdentities">;

/**
 * Mailbox Grants: writing one for a signer to sign, and reading each series from a store.
 *
 * - A grant reaches `series` as a signature over it that the store holds, whichever way it came and
 *   wherever it sits in a closure, as a signature carries its authority in itself.
 * - Each signature is verified by the signed identity it carries, as by `noIdentityVersions`, and
 *   `grantFrom` says whether that identity version still counts.
 * - A signature that does not verify, or that is over an object that does not read as a grant,
 *   gives no row, since anyone can send a bundle to a mailbox.
 * - The scan still fails when the store fails to give a blob, so a later scan of the index reads it
 *   again.
 */
export class MailboxGrants {
  readonly schema: Schema<Json, MailboxGrantData>;
  /** The grants of each series. Its index is made once, with the grants, so a store keeps its rows between scans. */
  readonly series: View<MailboxGrantRow, GrantSeries>;
  readonly #identity: SignatureReading;

  constructor(schema: Schema<Json, MailboxGrantData>, identity: SignatureReading) {
    this.schema = schema;
    this.#identity = identity;
    this.series = {
      index: indexOverBlobs(identity.signatures.selectionOver(schema), (grant, reader) => this.#rowsOf(grant, reader)),
      read: (rows, reader) => this.#seriesOf(rows, reader),
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

  async *#rowsOf(
    { signature, object }: SignatureOver<MailboxGrantData>,
    reader: Reader,
  ): AsyncIterable<MailboxGrantRow> {
    const { signatures, signedIdentities } = this.#identity;
    const { signedIdentity, link } = await signatures.verify(signature, reader, noIdentityVersions);
    const to = await signedIdentities.read(object.data.to.$link, reader);
    yield [signedIdentity.identity.root.link, to.identity.root.link, object.data.at, link];
  }

  #seriesOf(rows: Rows<MailboxGrantRow>, reader: Reader): GrantSeries {
    const { signatures } = this.#identity;
    const grantOf = (signature: Signature) => this.#grantOf(signature, reader);
    const countedSignatures = async function* (
      from: Link<KeyObject>,
      to: Link<KeyObject>,
      seenIdentityVersions: SeenIdentityVersions,
    ) {
      for await (const [, , , link] of rows.range([from, to])) {
        const signature = await signatures.read(link, reader, noIdentityVersions);
        if (await seenIdentityVersions.counts(signature)) yield signature;
      }
    };
    return {
      grantsFrom: async function* (from, to, seenIdentityVersions) {
        for await (const signature of countedSignatures(from, to, seenIdentityVersions)) yield grantOf(signature);
      },
      grantFrom: async (from, to, seenIdentityVersions) => {
        let latest: Signature | undefined;
        for await (const signature of countedSignatures(from, to, seenIdentityVersions)) latest = signature;
        return latest === undefined ? undefined : grantOf(latest);
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
  return new MailboxGrants(schema, identity);
}

import type { IdentityKit, People, SignatureData, Version } from "@estoc/identity";
import { type EncodedObject, type Json, type Reader, readObject, type Schema } from "@estoc/object";
import type { View } from "@estoc/store";
import type { AcknowledgementData, MailboxAcknowledgementData, ServiceData } from "./schemas.ts";
import { objectOf } from "./signatures.ts";

export type PeopleView = View<Json, Version, People, SignatureData>;

/**
 * The people of a service's store, or of a client's of it, by the versions
 * the store has seen in what the service gave out among its records.
 *
 * - The versions are those that signed the Services and the acknowledgements,
 *   of accounts and of mailboxes, and those that the acknowledged acceptances
 *   and requests carry.
 * - The service and its client keep the same records, so they have seen the
 *   same versions of one another.
 * - Each version's root signature is verified; the signatures that carry it
 *   are not checked here against the versions seen.
 */
export function peopleView(
  { signatures, signedIdentities, versions }: IdentityKit,
  schemas: {
    readonly service: Schema<Json, ServiceData>;
    readonly acknowledgement: Schema<Json, AcknowledgementData>;
    readonly mailboxAcknowledgement: Schema<Json, MailboxAcknowledgementData>;
  },
): PeopleView {
  const versionOf = async ({ data }: EncodedObject<Json, SignatureData>, reader: Reader) =>
    versions.versionOf(await signedIdentities.read(data.signedIdentity.$link, reader));
  return {
    index: {
      reads: [signatures.schema],
      async *rows(signature, reader) {
        const acknowledgedSignature =
          (await objectOf(signature, reader, schemas.acknowledgement))?.data.acceptance ??
          (await objectOf(signature, reader, schemas.mailboxAcknowledgement))?.data.request;
        if (acknowledgedSignature === undefined && (await objectOf(signature, reader, schemas.service)) === undefined)
          return;
        yield await versionOf(signature, reader);
        if (acknowledgedSignature === undefined) return;
        yield await versionOf(await readObject(reader, acknowledgedSignature.$link, signatures.schema), reader);
      },
    },
    read: (rows, reader) => versions.people(rows, reader),
  };
}

import type { IdentityKit, IdentityVersion, People, SignatureData } from "@estoc/identity";
import { type EncodedObject, type Json, type Reader, readObject, type Schema } from "@estoc/object";
import { indexOver, type View } from "@estoc/store";
import type { AcknowledgementData, MailboxAcknowledgementData, ServiceData } from "./schemas.ts";

export type PeopleView = View<IdentityVersion, People>;

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
    index: indexOver(signatures.selectionOver(schemas.service), async function* ({ signature }, reader) {
      yield await versionOf(signature, reader);
    }).union(
      indexOver(signatures.selectionOver(schemas.acknowledgement), async function* ({ signature, object }, reader) {
        yield await versionOf(signature, reader);
        yield await versionOf(await readObject(reader, object.data.acceptance.$link, signatures.schema), reader);
      }),
      indexOver(
        signatures.selectionOver(schemas.mailboxAcknowledgement),
        async function* ({ signature, object }, reader) {
          yield await versionOf(signature, reader);
          yield await versionOf(await readObject(reader, object.data.request.$link, signatures.schema), reader);
        },
      ),
    ),
    read: (rows, reader) => versions.people(rows, reader),
  };
}

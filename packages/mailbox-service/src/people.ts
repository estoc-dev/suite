import type { IdentityKit, People, Signature, SignatureData, Version } from "@estoc/identity";
import {
  decodeObject,
  type EncodedObject,
  type Json,
  type JsonLink,
  json,
  objectsOf,
  type Reader,
  readObject,
  type Schema,
  schemaOf,
} from "@estoc/object";
import { indexOver, type View } from "@estoc/store";
import type { AcknowledgementData, MailboxAcknowledgementData, ServiceData } from "./schemas.ts";

export type PeopleView = View<Json, Version, People>;

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
    index: indexOver(objectsOf(signatures.schema), async function* (signature, reader) {
      const bytes = await reader.get(signature.data.object.$link);
      if (bytes === undefined) return;
      const schema = schemaOf(bytes, json);
      let acknowledgedSignature: JsonLink<Signature> | undefined;
      if (schema === schemas.acknowledgement.link)
        acknowledgedSignature = decodeObject(bytes, schemas.acknowledgement).data.acceptance;
      else if (schema === schemas.mailboxAcknowledgement.link)
        acknowledgedSignature = decodeObject(bytes, schemas.mailboxAcknowledgement).data.request;
      else if (schema !== schemas.service.link) return;
      yield await versionOf(signature, reader);
      if (acknowledgedSignature === undefined) return;
      yield await versionOf(await readObject(reader, acknowledgedSignature.$link, signatures.schema), reader);
    }),
    read: (rows, reader) => versions.people(rows, reader),
  };
}

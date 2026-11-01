import type { IdentityKit, People, SignatureData, Version } from "@estoc/identity";
import {
  decodeObject,
  type EncodedObject,
  type Json,
  json,
  type Reader,
  readObject,
  type Schema,
  schemaOf,
} from "@estoc/object";
import type { View } from "@estoc/store";
import type { AcknowledgementData, ServiceData } from "./schemas.ts";

export type KnownPeople = View<Json, Version, People, SignatureData>;

/**
 * The people that a store of a service's, or of a client's of it, knows,
 * from what the service gave out that the store holds as mine: the versions
 * that signed the Services and the acknowledgements, and those that the
 * acknowledged acceptances carry. The service and its client keep the same
 * records, so they know the people of one another alike. A version stands on
 * its root's signature alone, so none is judged here.
 */
export function knownPeople(
  { signatures, signedIdentities, versions }: IdentityKit,
  schemas: {
    readonly service: Schema<Json, ServiceData>;
    readonly acknowledgement: Schema<Json, AcknowledgementData>;
  },
): KnownPeople {
  const versionOf = async ({ data }: EncodedObject<Json, SignatureData>, reader: Reader) =>
    versions.of(await signedIdentities.read(data.signedIdentity.$link, reader));
  return {
    index: {
      reads: [signatures.schema],
      async *rows(signature, reader) {
        const bytes = await reader.get(signature.data.object.$link);
        if (bytes === undefined) return;
        const schema = schemaOf(bytes, json);
        if (schema !== schemas.service.link && schema !== schemas.acknowledgement.link) return;
        yield await versionOf(signature, reader);
        if (schema !== schemas.acknowledgement.link) return;
        const { accepted } = decodeObject(bytes, schemas.acknowledgement).data;
        yield await versionOf(await readObject(reader, accepted.$link, signatures.schema), reader);
      },
    },
    read: (rows, reader) => versions.known(rows, reader),
  };
}

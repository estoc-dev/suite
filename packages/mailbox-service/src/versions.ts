import type { IdentityKit, SignatureData, Version } from "@estoc/identity";
import { decodeObject, type Json, json, readObject, type Schema, schemaOf } from "@estoc/object";
import type { Index, Rows } from "@estoc/store";
import type { AcknowledgementData } from "./schemas.ts";

export type KnownVersions = Index<Json, Version, SignatureData>;

/**
 * The versions of identities that the acceptances the service
 * acknowledged carry, from its signatures over the acknowledgements written
 * as mine. A version stands on its root's signature alone, and each
 * acceptance was judged when it was acknowledged, so it is not judged again.
 */
export function knownVersions(
  { signatures, signedIdentities, versions }: IdentityKit,
  acknowledgement: Schema<Json, AcknowledgementData>,
): KnownVersions {
  return {
    reads: [signatures.schema],
    async *rows(signature, reader) {
      const bytes = await reader.get(signature.data.object.$link);
      if (bytes === undefined || schemaOf(bytes, json) !== acknowledgement.link) return;
      const acceptance = await readObject(
        reader,
        decodeObject(bytes, acknowledgement).data.accepted.$link,
        signatures.schema,
      );
      yield versions.of(await signedIdentities.read(acceptance.data.signedIdentity.$link, reader));
    },
  };
}

/** Whether `rows` of the versions the service knows hold `version`. */
export async function knows(rows: Rows<Version>, version: Version): Promise<boolean> {
  for await (const _ of rows.range(version)) return true;
  return false;
}

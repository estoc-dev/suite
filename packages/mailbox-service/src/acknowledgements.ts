import type { Signature, SignatureData, Signatures } from "@estoc/identity";
import { decodeObject, type Json, json, type Link, type Schema, schemaOf } from "@estoc/object";
import type { Index, View } from "@estoc/store";
import type { AcknowledgementData } from "./schemas.ts";

type Acknowledged = readonly [accepted: Link<Signature>, acknowledgement: Link<Signature>];

export type Acknowledgements = Index<Json, Acknowledged, SignatureData>;

/** The acknowledgements that the signatures written as mine sign, by the acceptance each acknowledges. */
export function acknowledgements(
  signatures: Signatures,
  acknowledgement: Schema<Json, AcknowledgementData>,
): Acknowledgements {
  return {
    reads: [signatures.schema],
    async *rows(signature, reader) {
      const bytes = await reader.get(signature.data.object.$link);
      if (bytes === undefined || schemaOf(bytes, json) !== acknowledgement.link) return;
      yield [decodeObject(bytes, acknowledgement).data.accepted.$link, signature.link as Link<Signature>];
    },
  };
}

/**
 * The link of a signature that a store holds as mine over an
 * acknowledgement of `accepted`, or `undefined` when it holds none.
 */
export function acknowledgementOf(
  acknowledgements: Acknowledgements,
  accepted: Link<Signature>,
): View<Json, Acknowledged, Promise<Link<Signature> | undefined>, SignatureData> {
  return {
    index: acknowledgements,
    async read(rows) {
      for await (const [, link] of rows.range([accepted])) return link;
      return undefined;
    },
  };
}

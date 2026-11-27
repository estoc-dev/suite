import { signatureSchema } from "@estoc/identity";
import { link, schema } from "@estoc/schema";
import { indexOfRows, memberOf, recordedStatements, writtenObjectSchema } from "@estoc/store";

const recordedSignatureSchema = schema("Recorded signature", { object: link(), signature: link() });

const signature = memberOf(writtenObjectSchema).field("object").objectOf(signatureSchema);

/** A signature that the store holds may have no record, as when a write stopped between the two. */
export const recordedSignatures = indexOfRows(recordedSignatureSchema, {
  object: signature.field("object"),
  signature: signature.link,
}).reading(recordedStatements);

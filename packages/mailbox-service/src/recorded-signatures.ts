import { signatureSchema } from "@estoc/identity";
import { link, schema } from "@estoc/schema";
import { memberObjectOf, recordedWrittenObjects } from "@estoc/store";

const recordedSignatureSchema = schema("Recorded signature", { object: link(), signature: link() });

const signature = memberObjectOf(signatureSchema);

/** A signature that the store holds may have no record, as when a write stopped between the two. */
export const recordedSignatures = recordedWrittenObjects.linksAt("object").rowsTaking(recordedSignatureSchema, {
  object: signature.field("object"),
  signature: signature.link,
});

import { signatureSchema } from "@estoc/identity";
import { LinkValue, objectsOf } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { indexOver, selectedRecords, writtenObjectsOver } from "@estoc/store";

const recordedSignatureSchema = schema("Recorded signature", { object: link(), signature: link() });

/** A signature that the store holds may have no record, as when a write stopped between the two. */
export const recordedSignatures = indexOver(
  selectedRecords(writtenObjectsOver(objectsOf(signatureSchema))),
  recordedSignatureSchema,
  ({ link, data }) => [{ object: new LinkValue(data.object.link), signature: new LinkValue(link) }],
)
  .orderedBy("object", "signature")
  .named("Recorded Signatures");

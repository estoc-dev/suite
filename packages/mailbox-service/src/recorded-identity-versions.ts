import { identityKit } from "@estoc/identity";
import { LinkValue, objectsOf } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { indexOver, selectedRecords, writtenObjectsOver } from "@estoc/store";

const { signedIdentities } = identityKit;

const recordedIdentityVersionSchema = schema("Recorded identity version", {
  identifier: link(),
  signedIdentity: link(),
});

export const recordedIdentityVersions = indexOver(
  selectedRecords(writtenObjectsOver(objectsOf(signedIdentities.schema))),
  recordedIdentityVersionSchema,
  async function* (object, reader) {
    const { identifier } = (await signedIdentities.verify(object, reader)).identity;
    yield { identifier: new LinkValue(identifier), signedIdentity: new LinkValue(object.link) };
  },
).orderedBy("identifier", "signedIdentity");

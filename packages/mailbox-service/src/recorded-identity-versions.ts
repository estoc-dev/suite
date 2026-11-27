import { identityVersionsOver } from "@estoc/people";
import { link, schema } from "@estoc/schema";
import { memberObjectOf, recordedWrittenObjects } from "@estoc/store";

const recordedIdentityVersionSchema = schema("Recorded identity version", {
  identifier: link(),
  signedIdentity: link(),
});

const recordedVersions = identityVersionsOver(recordedWrittenObjects.linksAt("object"));

const recordedVersion = memberObjectOf(recordedVersions.rowSchema);

export const recordedIdentityVersions = recordedVersions.rowsTaking(recordedIdentityVersionSchema, {
  identifier: recordedVersion.field("identifier"),
  signedIdentity: recordedVersion.field("signedIdentity"),
});

import { secretKeySchema } from "@estoc/identity";
import { link, schema } from "@estoc/schema";
import { memberObjectOf, recordedStatements } from "@estoc/store";

const heldKeySchema = schema("Held Key", { key: link(), secretKey: link() });

const secretKey = memberObjectOf(secretKeySchema);

export const heldKeys = recordedStatements.rowsTaking(heldKeySchema, {
  key: secretKey.field("key"),
  secretKey: secretKey.link,
});
